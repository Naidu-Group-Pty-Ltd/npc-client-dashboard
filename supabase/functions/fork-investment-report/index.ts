/**
 * fork-investment-report
 * ----------------------
 * Takes a completed Compass-base Investment Report and deterministically produces
 * two derived client-facing reports:
 *
 *   - 'financial'      → Client Investment Feasibility & Financial Performance
 *   - 'strategic'      → Property & Location strategic assessment
 *
 * The forks are real `investment_reports` rows linked back to the composite
 * via `derived_from_report_id`. No new LLM calls are made; routing is
 * data-driven via reportSplitRegistry. Idempotent — re-running refreshes
 * existing child rows instead of duplicating them.
 *
 * Request:
 *   { composite_report_id: string; variants?: ('financial' | 'strategic')[] }
 *
 * Response:
 *   { ok: true, financial?: { id, ... }, strategic?: { id, ... } }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyAuth, createCorsHeaders, createForbiddenResponse, createUnauthorizedResponse } from '../_shared/auth.ts';
import { actorIsSuperadmin, requireModulePermission } from '../_shared/authz.ts';
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import {
  normaliseStructuralHeading,
  loadSplitRegistry,
  type LoadedSplitRegistry,
  type ForkVariant,
  type SplitRoute,
} from '../_shared/reportSplitRegistry.ts';
import { scoreFinancial, scorePropertyFundamentals } from '../_shared/investmentScoreEngine.ts';
import { internalError } from '../_shared/errorResponse.ts';

interface ParsedSection {
  rawHeading: string;
  normalisedHeading: string;
  body: string;
}

/** Split markdown into H2-anchored sections, preserving anything before the first H2 as a preamble. */
function splitIntoSections(markdown: string): { preamble: string; sections: ParsedSection[] } {
  const lines = (markdown || '').split('\n');
  const sections: ParsedSection[] = [];
  let preambleLines: string[] = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (current) sections.push(current);
      current = {
        rawHeading: h2[1],
        normalisedHeading: normaliseStructuralHeading(h2[1]),
        body: '',
      };
    } else if (current) {
      current.body += line + '\n';
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble: preambleLines.join('\n').trim(), sections };
}

function buildLensIntro(registry: LoadedSplitRegistry, variant: ForkVariant, rule: SplitRoute['rule']): string {
  if (rule === 'verbatim') return '';
  if (variant === 'financial' && rule === 'financial_lens') return registry.finLensPreamble + '\n\n';
  if (variant === 'due_diligence' && rule === 'property_lens') return registry.plddLensPreamble + '\n\n';
  return '';
}

function summariseBody(body: string, maxWords = 200): string {
  const words = body.trim().split(/\s+/);
  if (words.length <= maxWords) return body;
  return words.slice(0, maxWords).join(' ') + '\n\n_…full detail in the companion report._';
}

interface AssembledSection {
  ordinal: number;
  heading: string;
  body: string;
}

function assembleForVariant(
  registry: LoadedSplitRegistry,
  variant: ForkVariant,
  parsed: ParsedSection[],
): AssembledSection[] {
  const buckets: AssembledSection[] = [];
  const usedOrdinals = new Set<number>();
  let fallbackOrdinal = 100;

  for (const section of parsed) {
    const { route } = registry.routeCompositeSection(section.normalisedHeading);
    if (!route) continue;

    const isTargeted =
      route.target === 'both' ||
      route.target === variant;
    if (!isTargeted) continue;
    if (route.rule === 'drop') continue;

    const newHeading =
      variant === 'financial'
        ? route.newHeadingFinancial || section.normalisedHeading
        : route.newHeadingDueDiligence || section.normalisedHeading;

    let ordinal =
      variant === 'financial'
        ? route.ordinalFinancial
        : route.ordinalDueDiligence;
    if (!ordinal || usedOrdinals.has(ordinal)) {
      ordinal = ordinal && !usedOrdinals.has(ordinal) ? ordinal : fallbackOrdinal++;
    }
    usedOrdinals.add(ordinal);

    const lensIntro = buildLensIntro(registry, variant, route.rule);
    const body = route.rule === 'summarise_only'
      ? summariseBody(section.body)
      : section.body;

    buckets.push({ ordinal, heading: newHeading, body: lensIntro + body.trim() + '\n' });
  }

  // De-duplicate consecutive identical headings, keeping the richer body
  const dedupedMap = new Map<string, AssembledSection>();
  for (const s of buckets) {
    const existing = dedupedMap.get(s.heading);
    if (!existing) dedupedMap.set(s.heading, s);
    else if (s.body.length > existing.body.length) dedupedMap.set(s.heading, s);
  }
  return Array.from(dedupedMap.values()).sort((a, b) => a.ordinal - b.ordinal);
}

function renderVariantMarkdown(
  registry: LoadedSplitRegistry,
  variant: ForkVariant,
  propertyAddress: string,
  sections: AssembledSection[],
): string {
  const title = variant === 'financial' ? registry.finTitle : registry.plddTitle;
  const subtitle = variant === 'financial' ? registry.finSubtitle : registry.plddSubtitle;
  const footer = variant === 'financial' ? registry.finFooter : registry.plddFooter;

  const cover = `# ${title}\n\n_${subtitle}_\n\n**Property:** ${propertyAddress}\n\n**Generated:** ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}\n\n---\n\n`;

  const body = sections
    .map((s) => `## ${s.heading}\n\n${s.body.trim()}\n`)
    .join('\n');

  const disclaimer = `\n\n---\n\n## Disclaimer\n\n${footer}\n`;

  return cover + body + disclaimer;
}

async function loadComposite(supabase: any, id: string) {
  const { data, error } = await supabase
    .from('investment_reports')
    .select('id, property_address, property_listing_id, client_property_id, canonical_property_key, generated_by, report_content, financial_calculations, demographics_data, economic_data, location_intelligence, property_specs, manual_overrides, status, report_variant, report_tier, sources_content')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load composite: ${error.message}`);
  if (!data) throw new Error(`Composite report ${id} not found`);
  // `composite` is a legacy storage value for the Compass base engine. New
  // records persist `compass`; accept both so historical reports remain usable.
  if (data.report_variant !== 'composite' && data.report_variant !== 'compass') {
    throw new Error(`Report ${id} is not a Compass base report (variant=${data.report_variant})`);
  }
  if (data.status !== 'completed') {
    throw new Error(`Composite report ${id} is not yet completed (status=${data.status})`);
  }
  return data;
}

/**
 * The service-role client bypasses RLS, so a caller-selected report must be
 * scoped explicitly before any report content is loaded or changed.
 */
async function canForkComposite(
  supabase: any,
  id: string,
  userId: string,
  authMethod?: string,
): Promise<boolean> {
  if (authMethod === 'service_role' || userId === 'service_role') return true;
  if (await actorIsSuperadmin(supabase, userId)) return true;

  const { data: report, error } = await supabase
    .from('investment_reports')
    .select('generated_by, client_property_id')
    .eq('id', id)
    .maybeSingle();
  if (error || !report) return false;
  if (report.generated_by === userId) return true;
  if (!report.client_property_id) return false;

  const { data: clientProperty } = await supabase
    .from('client_properties')
    .select('client_id')
    .eq('id', report.client_property_id)
    .maybeSingle();
  if (!clientProperty?.client_id) return false;

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientProperty.client_id)
    .or(`created_by.eq.${userId},assigned_team_user_id.eq.${userId}`)
    .maybeSingle();
  return !!client;
}

type PersistedVariant = 'financial' | 'strategic';

async function findExistingFork(supabase: any, parentId: string, variant: PersistedVariant) {
  const { data, error } = await supabase
    .from('investment_reports')
    .select('id')
    .eq('derived_from_report_id', parentId)
    .eq('report_variant', variant)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to locate existing ${variant} report: ${error.message}`);
  return data?.id || null;
}

async function upsertFork(
  supabase: any,
  parent: any,
  variant: ForkVariant,
  persistedVariant: PersistedVariant,
  reportContent: string,
  scoreInputRaw: any,
) {
  const score = variant === 'financial'
    ? scoreFinancial(scoreInputRaw)
    : scorePropertyFundamentals(scoreInputRaw);

  const existingId = await findExistingFork(supabase, parent.id, persistedVariant);
  const sourcesContent = parent.sources_content || null;

  const sharedFields = {
    report_content: reportContent,
    sources_content: sourcesContent,
    investment_score: score,
    financial_calculations: parent.financial_calculations,
    demographics_data: parent.demographics_data,
    economic_data: parent.economic_data,
    location_intelligence: parent.location_intelligence,
    property_specs: parent.property_specs,
    manual_overrides: parent.manual_overrides,
    variant_generated_at: new Date().toISOString(),
    report_tier: persistedVariant,
    status: 'completed',
  };

  if (existingId) {
    const { data, error } = await supabase
      .from('investment_reports')
      .update(sharedFields)
      .eq('id', existingId)
      .select('id, report_variant, derived_from_report_id, variant_generated_at')
      .maybeSingle();
    if (error) throw new Error(`Failed to refresh ${variant} fork: ${error.message}`);
    return { ...data, refreshed: true };
  }

  const { data, error } = await supabase
    .from('investment_reports')
    .insert({
      property_address: parent.property_address,
      property_listing_id: parent.property_listing_id,
      client_property_id: parent.client_property_id,
      canonical_property_key: parent.canonical_property_key,
      generated_by: parent.generated_by,
      report_variant: persistedVariant,
      derived_from_report_id: parent.id,
      // Both linkage columns — history split the family across
      // derived_from_report_id (fork) and parent_report_id (condense), so
      // the two engines could not see each other's children. New rows carry
      // both; readers resolve the union either way (subReportFamily.pure.ts).
      parent_report_id: parent.id,
      ...sharedFields,
    })
    .select('id, report_variant, derived_from_report_id, variant_generated_at')
    .maybeSingle();
  if (error) throw new Error(`Failed to insert ${variant} fork: ${error.message}`);
  return { ...data, created: true };
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));

    const { error: authError, userId, authMethod } = await verifyAuth(supabase, req.headers, body);
    if (authError) {
      console.log('[fork-investment-report] Auth failed:', authError);
      return createUnauthorizedResponse(authError, corsHeaders);
    }

    const compositeId = body.composite_report_id || body.compositeReportId || body.reportId;
    const requestedVariants = Array.isArray(body.variants) && body.variants.length > 0 ? body.variants : ['financial', 'strategic'];
    const variants = [...new Set(requestedVariants.filter(
      (variant: unknown): variant is PersistedVariant => variant === 'financial' || variant === 'strategic',
    ))];
    if (!variants.length) throw new Error('At least one valid client report pathway is required');
    if (!compositeId) {
      return new Response(JSON.stringify({ error: 'composite_report_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const permission = await requireModulePermission(
      supabase,
      { userId, authMethod },
      'generated_reports',
      'can_edit',
    );
    if (!permission.ok) {
      return createForbiddenResponse('Generated reports edit permission required', corsHeaders);
    }

    if (!await canForkComposite(supabase, compositeId, userId!, authMethod)) {
      return createForbiddenResponse('You are not authorised to fork this report', corsHeaders);
    }

    console.log('[fork-investment-report] Authenticated fork request', {
      userId: userId?.substring?.(0, 8) || userId,
      authMethod,
      compositeId,
    });

    const parent = await loadComposite(supabase, compositeId);

    const { sections } = splitIntoSections(parent.report_content || '');
    if (sections.length === 0) {
      return new Response(JSON.stringify({ error: 'Composite has no H2 sections to fork' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load DB-overlaid split registry (falls back to in-code defaults)
    const registry = await loadSplitRegistry(supabase);
    console.log('[fork-investment-report] Split registry source:', registry.source);

    // Build deterministic per-variant markdown
    const financialSections = assembleForVariant(registry, 'financial', sections);
    const dueDiligenceSections = assembleForVariant(registry, 'due_diligence', sections);

    const financialMd = renderVariantMarkdown(registry, 'financial', parent.property_address, financialSections);
    const dueDiligenceMd = renderVariantMarkdown(registry, 'due_diligence', parent.property_address, dueDiligenceSections);

    // Build the scoring input raw from parent's stored JSON. The price and
    // rent live where the calculator writes them — initialCosts.propertyValue
    // and income.weeklyRent — with the operator's override winning; the old
    // top-level reads (`financial_calculations.purchasePrice`) named paths
    // the record never had, so every fork was scored against $0.
    const fin = parent.financial_calculations || {};
    const overrides = parent.manual_overrides || {};
    const scoreInputRaw = {
      property: {
        price: Number(overrides.purchasePrice)
          || Number(fin.initialCosts?.propertyValue)
          || Number(fin.purchasePrice)
          || Number(parent.property_specs?.price)
          || 0,
        weeklyRent: Number(overrides.weeklyRent)
          || Number(fin.income?.weeklyRent)
          || Number(fin.weeklyRent)
          || Number(parent.property_specs?.weeklyRent)
          || 0,
        propertyType: parent.property_specs?.propertyType || parent.property_specs?.property_type || 'house',
      },
      demographics: parent.demographics_data || {},
      locationIntelligence: parent.location_intelligence || {},
      financials: fin,
      state: parent.property_specs?.state || parent.demographics_data?.state,
    };

    const generated = await Promise.all(variants.map(async (variant) => {
      if (variant === 'financial') return ['financial', await upsertFork(supabase, parent, 'financial', 'financial', financialMd, scoreInputRaw)] as const;
      return ['strategic', await upsertFork(supabase, parent, 'due_diligence', 'strategic', dueDiligenceMd, scoreInputRaw)] as const;
    }));
    const result = Object.fromEntries(generated);

    return new Response(
      JSON.stringify({
        ok: true,
        composite_report_id: parent.id,
        ...result,
        section_counts: {
          composite: sections.length,
          financial: variants.includes('financial') ? financialSections.length : 0,
          strategic: variants.includes('strategic') ? dueDiligenceSections.length : 0,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('[fork-investment-report]', err);
    return new Response(JSON.stringify(internalError(err, 'fork-investment-report')), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
