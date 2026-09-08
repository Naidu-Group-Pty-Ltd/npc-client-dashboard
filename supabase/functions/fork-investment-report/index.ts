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
import {
  composeFinancialChapters,
  type ComposedChapter,
} from '../_shared/reports/investment/financialChapters.pure.ts';
import { stripPlaceholderRows } from '../_shared/reports/investment/derivedHygiene.pure.ts';
import { readPropertyFacts } from '../_shared/reports/investment/propertyRecord.pure.ts';
import { scrubBlocks } from '../_shared/reports/investment/blockHygiene.pure.ts';
import { stripEditorialLabelsFromMarkdown } from '../_shared/compassPostProcessor.ts';

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

const normHeading = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Fold the record-composed FIN chapters into the routed prose. A composed
 * chapter REPLACES a routed section holding its ordinal or its heading: the
 * routed version is the parent's prose about the same money, and where the two
 * could disagree the recorded calculation wins — that is framework law I
 * (every figure is typed from the record). From a Compass-40 parent nothing
 * collides, because the parent has no financial sections to route; from a
 * legacy parent the stale prose tables give way to the record's own.
 */
function mergeComposedChapters(
  routed: AssembledSection[],
  composed: ComposedChapter[],
): { sections: AssembledSection[]; replaced: string[] } {
  const composedHeadings = new Set(composed.map((c) => normHeading(c.heading)));
  const composedOrdinals = new Set(composed.map((c) => c.ordinal));
  const replaced: string[] = [];
  const kept = routed.filter((s) => {
    if (composedHeadings.has(normHeading(s.heading)) || composedOrdinals.has(s.ordinal)) {
      replaced.push(s.heading);
      return false;
    }
    return true;
  });
  const composedAsSections: AssembledSection[] = composed.map((c) => ({
    ordinal: c.ordinal,
    heading: c.heading,
    // The chapter's markdown carries its own `## heading` line; the renderer
    // writes headings itself, so the body starts after it.
    body: c.markdown.replace(/^##[^\n]*\n/, '').trim() + '\n',
  }));
  return {
    sections: [...kept, ...composedAsSections].sort((a, b) => a.ordinal - b.ordinal),
    replaced,
  };
}

/**
 * Hygiene every fork document goes through before it is stored: editorial
 * labels stripped (a legacy parent carries "What This Means" blocks by the
 * dozen and slicing preserves them), then placeholder table rows dropped —
 * a labelled row is a promise that a figure follows it.
 */
function finaliseVariantMarkdown(md: string): {
  markdown: string;
  editorialBlocksRemoved: number;
  placeholderRowsRemoved: number;
  emptyStatCardsRemoved: number;
  duplicateDirectivesRemoved: number;
} {
  const stripped = stripEditorialLabelsFromMarkdown(md);
  const scrubbed = stripPlaceholderRows(stripped.markdown);
  // The two block types the row scrubber cannot see. A fork routes the
  // parent's own prose, so a card the parent left empty and a chart the parent
  // drew twice both arrive here intact.
  const blocks = scrubBlocks(scrubbed.markdown);
  return {
    markdown: blocks.markdown,
    editorialBlocksRemoved: stripped.removedBlocks,
    placeholderRowsRemoved: scrubbed.removedRows,
    emptyStatCardsRemoved: blocks.emptyStatCards,
    duplicateDirectivesRemoved: blocks.duplicateDirectives,
  };
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
    .select('id, property_address, property_listing_id, client_property_id, canonical_property_key, generated_by, report_content, financial_calculations, demographics_data, economic_data, location_intelligence, property_specs, manual_overrides, status, report_variant, report_tier, sources_content, investment_score, generation_engine, report_scope')
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

/**
 * The child's score: the variant scorer's answer when it can compute, carrying
 * the parent's four qualitative lists (the engine leaves them empty and they
 * are facts about the property, not about the weighting) — and the parent's
 * own composite score when the variant scorer cannot. The verdict, the grade
 * and the score are spine-mandatory in every tier, and writing null here is
 * what put "Graded  at  out of 100" on every Due Diligence report ever
 * produced. A refresh must never overwrite a good score with nothing.
 */
function resolveVariantScore(variant: ForkVariant, scoreInputRaw: any, parent: any) {
  const variantScore = variant === 'financial'
    ? scoreFinancial(scoreInputRaw)
    : scorePropertyFundamentals(scoreInputRaw);
  const parentScore = parent.investment_score && typeof parent.investment_score === 'object'
    ? parent.investment_score
    : null;
  if (!variantScore) return parentScore;
  if (!parentScore) return variantScore;
  const carry = (own: unknown, parents: unknown) =>
    (Array.isArray(own) && own.length ? own : (Array.isArray(parents) ? parents : []));
  return {
    ...variantScore,
    strengths: carry(variantScore.strengths, parentScore.strengths),
    weaknesses: carry(variantScore.weaknesses, parentScore.weaknesses),
    opportunities: carry(variantScore.opportunities, parentScore.opportunities),
    risks: carry(variantScore.risks, parentScore.risks),
  };
}

async function upsertFork(
  supabase: any,
  parent: any,
  variant: ForkVariant,
  persistedVariant: PersistedVariant,
  reportContent: string,
  score: any,
) {
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
    // The engine that produced the substance is the parent's — this function
    // slices and composes, it does not generate. Left unwritten, the column
    // defaulted to 'legacy' on every child, including the four forked from a
    // compass-40 parent on 2026-09-04, so nothing reading engine truth off a
    // child row could ever see the truth.
    generation_engine: parent.generation_engine ?? 'legacy',
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
      report_scope: parent.report_scope,
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
    const routedFinancialSections = assembleForVariant(registry, 'financial', sections);
    const dueDiligenceSections = assembleForVariant(registry, 'due_diligence', sections);

    // Build the scoring input raw from parent's stored JSON. The price and
    // rent live where the calculator writes them — initialCosts.propertyValue
    // and income.weeklyRent — with the operator's override winning; the old
    // top-level reads (`financial_calculations.purchasePrice`) named paths
    // the record never had, so every fork was scored against $0.
    const fin = parent.financial_calculations || {};
    const overrides = parent.manual_overrides || {};
    const scoreInputRaw = {
      property: {
        // `property_specs.price` and `.weeklyRent` were read here and have
        // NEVER been written by any writer — the spec block has only ever held
        // `land_size_sqm`, `building_size_sqm`, `bedrooms`, `bathrooms`,
        // `parking`, `year_built`, `property_type`, `zoning`, `council_area`.
        // JSONB does not error on a key that is not there, so the read yielded
        // `undefined`, `Number(undefined)` yielded `NaN`, and the `||` chain
        // silently took the next rung. Same class as the `aml.cases.tenant_id`
        // sweep, with nothing to report it.
        price: Number(overrides.purchasePrice)
          || Number(fin.initialCosts?.propertyValue)
          || Number(fin.purchasePrice)
          || 0,
        weeklyRent: Number(overrides.weeklyRent)
          || Number(fin.income?.weeklyRent)
          || Number(fin.weeklyRent)
          || 0,
        // The record's own answer, healed on read. This read
        // `property_specs?.propertyType` — a key the writer spells
        // `property_type` — then fell through to that key, which is the
        // literal `'Residential Property'` on every report since June 2026,
        // while the operator's own `propertyType` sat in `overrides`,
        // destructured two lines above. `dRisk` is the only consumer
        // (`unit|apartment` −10, `townhouse` −5, `house` +3) and it is
        // weighted 15% on the financial fork: measured, a unit graded B at 60
        // where the record says C+ at 57. No strata property has been forked
        // yet, so the exposure is latent — and armed.
        // Only the strata case changes. `normalisedType` is undefined for an
        // unclassified record, and `investmentScoreEngine` line 68 is
        // `property.propertyType || 'house'` — so passing undefined would
        // DEFAULT to a house and award `dRisk`'s +3, where the old expression
        // passed the truthy `'Residential Property'` placeholder and got a
        // neutral. That would be a score change in the inflating direction,
        // and scoring is a separate decision the author has open. So the two
        // rungs below preserve the previous behaviour exactly: an
        // unclassifiable-but-present type stays neutral, an empty record still
        // resolves to 'house'.
        //
        // The engine's own `|| 'house'` is the real defect — it turns
        // "unclassified" into a house bonus, and `property_specs` is empty on
        // 100% of current reports — but it belongs to the scoring work, not
        // here.
        propertyType: readPropertyFacts(parent.property_specs, overrides).normalisedType
          ?? parent.property_specs?.property_type
          ?? 'house',
      },
      demographics: parent.demographics_data || {},
      locationIntelligence: parent.location_intelligence || {},
      financials: fin,
      // `property_specs.state` is a third key no writer emits.
      state: parent.demographics_data?.state,
    };

    const financialScore = resolveVariantScore('financial', scoreInputRaw, parent);
    const strategicScore = resolveVariantScore('due_diligence', scoreInputRaw, parent);

    // The Financial variant's chapters are COMPOSED from the recorded
    // calculation, not sliced from prose: a Compass-40 parent carries no
    // financial sections to route, which is how the "Financial Performance
    // Report" came to hold one dollar sign while its own row held the whole
    // model. Composed chapters replace any routed prose about the same money.
    const composedChapters = variants.includes('financial')
      ? composeFinancialChapters(
        { financialCalculations: parent.financial_calculations, investmentScore: financialScore },
        { scenarios: 'all' },
      )
      : [];
    const mergedFinancial = mergeComposedChapters(routedFinancialSections, composedChapters);
    const financialSections = mergedFinancial.sections;

    const financialOut = finaliseVariantMarkdown(
      renderVariantMarkdown(registry, 'financial', parent.property_address, financialSections),
    );
    const dueDiligenceOut = finaliseVariantMarkdown(
      renderVariantMarkdown(registry, 'due_diligence', parent.property_address, dueDiligenceSections),
    );

    const generated = await Promise.all(variants.map(async (variant) => {
      if (variant === 'financial') return ['financial', await upsertFork(supabase, parent, 'financial', 'financial', financialOut.markdown, financialScore)] as const;
      return ['strategic', await upsertFork(supabase, parent, 'due_diligence', 'strategic', dueDiligenceOut.markdown, strategicScore)] as const;
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
        composed_financial_chapters: composedChapters.map((c) => c.heading),
        routed_sections_replaced_by_record: mergedFinancial.replaced,
        hygiene: {
          financial: variants.includes('financial')
            ? { editorial_blocks_removed: financialOut.editorialBlocksRemoved, placeholder_rows_removed: financialOut.placeholderRowsRemoved }
            : null,
          strategic: variants.includes('strategic')
            ? { editorial_blocks_removed: dueDiligenceOut.editorialBlocksRemoved, placeholder_rows_removed: dueDiligenceOut.placeholderRowsRemoved }
            : null,
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
