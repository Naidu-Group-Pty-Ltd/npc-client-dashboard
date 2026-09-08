import { buildRecordedFactsBlock } from '../_shared/reports/investment/condenseFacts.pure.ts';
import { composeFinancialChapters, composeFinancialSnapshotSection } from '../_shared/reports/investment/financialChapters.pure.ts';
import {
  composeScoreBreakdownSection,
  composeScoreDimensionsSection,
  composeSwotSection,
  composeVerdictSection,
} from '../_shared/reports/investment/scoreSections.pure.ts';
import { stripPlaceholderRows, trimToDeclaredSections } from '../_shared/reports/investment/derivedHygiene.pure.ts';
import { scrubBlocks } from '../_shared/reports/investment/blockHygiene.pure.ts';
import { authoredHeadingsForTier, markdownHeadingsForTier } from '../_shared/reports/investment/sectionRegistry.pure.ts';
import { assembleInDeclaredOrder, type ComposedPlacement } from '../_shared/reports/investment/tierAssembly.pure.ts';
import { stripEditorialLabelsFromMarkdown } from '../_shared/compassPostProcessor.ts';
import { projectInvestmentReport, type InvestmentReportRowLike } from '../_shared/reportBindingProjection.pure.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { getBrandConfig } from '../_shared/brand-config.ts';
import { internalError } from '../_shared/errorResponse.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
  'Access-Control-Expose-Headers': 'x-correlation-id, x-tokens-used, x-tokens-reserved, x-tokens-estimated, x-duration-ms',
};

// Report tier configurations based on NPC report templates.
//
// The Briefing guide is cut against the parent that EXISTS. Its previous
// version was written for the 17-section legacy Compass, which carried
// financial modelling and market-performance tables inline — and it kept
// demanding eight financial tables and a "Current Market Performance" grid
// from a Compass-40 parent that is forbidden to contain any of it. The model,
// forced to fill tables from a document that never states the numbers, wrote
// N/A: 33 occurrences per briefing before August 2026, 87 on the newest
// (row 89b451f6). The financial tables, the score breakdown and the SWOT are
// now COMPOSED from the row's own record after the model call
// (financialChapters / scoreSections), so the model is asked only for what
// the parent's prose can actually give: the condensed location case.
//
// Each tier used to carry a `sections` array and a `contentRatio` here. Both
// were read by NOTHING — only `name`, `targetPages` and `structureGuide` are —
// and the snapshot's copy was wrong, naming `Top Opportunities & Risks` and
// `Recommendation` where the guide below it asks for `Top 3 Opportunities`,
// `Top 3 Risks` and `Quick Recommendation`, and omitting two headings the guide
// does ask for. Six declared entries against nine real ones, in one object
// literal, with nothing to notice. A structure a reader trusts and no code
// consults is worse than none, so the list now comes from
// `sectionRegistry.pure.ts` — where it is read, and where a spec resolves every
// entry against the thing that produces it.
const TIER_CONFIG = {
  briefing: {
    name: 'Executive Briefing',
    targetPages: 12,
    structureGuide: `
EXECUTIVE BRIEFING STRUCTURE (~7 pages of prose — financial tables, the
score breakdown and the SWOT are attached programmatically from the recorded
calculation AFTER your output; do NOT write them yourself):

## Executive Summary
- The verdict and the case for it in 4-6 sentences, condensed from the
  parent's Executive Verdict.

## Location & Demand
- Why this location matters and who wants to live here: growth corridor,
  infrastructure pipeline, population and employment drivers, tenant/buyer
  profile. Condense the parent's location and demand sections.

## Amenity & Access
- What is nearby and how long it takes to reach: schools, healthcare,
  shopping, transport and real commutes. Keep the parent's amenity matrix
  rows that carry values.

## Market Position
- Where the property sits in its local market, condensed from the parent.
  Qualitative only — NO invented medians, sales volumes or days-on-market.

## Property Fit
- How this dwelling aligns with local demand: position, layout, land/build
  balance, tenant appeal, limitations.

## Risk Overview
- The parent's consolidated risk table, kept as a table. Preserve the
  Risk / Level / Why It Matters / Required Check columns and every row that
  carries values.

## Top 3 Opportunities
- Brief bullet points (1-2 sentences each)

## Top 3 Risks
- Brief bullet points (1-2 sentences each)

## Recommendation
- The parent's final recommendation condensed to its verdict line and
  150 words of rationale, then the immediate actions as a short list.

## Market Data Sources
- The sources the parent actually cites, with the date each was read.
- Never invent a source, and never write "N/A" for one you do not have. If
  the parent cites none, say so in one line — a client is entitled to know
  what the document rests on, which is why this section is never omitted.

HARD RULES:
- Do NOT write any financial table (costs, yield, loan, cashflow,
  sensitivity, projections, LVR) — they are attached from the recorded
  calculation after your output and anything you write would duplicate or
  contradict them.
- Do NOT write an Investment Score Breakdown or SWOT section — same reason.
- Include a metric ONLY when its value is stated in the report or the
  recorded figures; NEVER write "N/A", "TBD" or a placeholder — omit the
  row, or the table, entirely.

WRITE ONLY THE SECTIONS ABOVE. Do NOT copy the original report's own section
headings after them — anything outside this structure is discarded.
`
  },
  snapshot: {
    name: 'Snapshot',
    targetPages: 5,
    structureGuide: `
REPORT STRUCTURE (~5 PAGES):

## Property Summary
- Address, Property Type, Bedrooms/Bathrooms
- Estimated Value, Location highlights (3 sentences max)

## Key Market Stats
| Metric | Value |
- Choose from: Median Price, Rental Yield, Vacancy Rate, Capital Growth, Days on Market, Walk Score
- Include ONLY metrics whose value is stated in the report or the recorded figures; omit the rest — never write N/A

DO NOT WRITE: Investment Score, Score Breakdown, or Financial Snapshot. Those
three sections are composed from the stored record after you finish and are
inserted in their proper place. Anything you write under those headings is
discarded. Do not restate the grade, the score out of 100, the recommendation
or the score components anywhere else either.

## Top 3 Opportunities
- Brief bullet points (1-2 sentences each)

## Top 3 Risks
- Brief bullet points (1-2 sentences each)

## Quick Recommendation
- 2-3 sentences summarizing the investment thesis

## Market Data Sources
- Only sources actually cited in the report or the recorded figures; omit
  the section entirely rather than writing "N/A" for a source you do not have

WRITE ONLY THE SECTIONS ABOVE. Do NOT copy the original report's own section
headings after them — anything outside this structure is discarded.
`
  },
  financial: {
    name: 'Financial Analysis Report',
    targetPages: 20,
    structureGuide: `
FINANCIAL ANALYSIS REPORT STRUCTURE (~20 PAGES):
This report contains ONLY financial / numerical analysis. Do NOT include
suburb narrative, infrastructure, demographics, planning, education,
amenity, transport, crime or climate sections — those live in the
Investor Compass Report.

## Property & Purchase Snapshot
- Address, property type, bed/bath/parking, year built
- Purchase price, settlement date, deposit, loan structure (single line each)

## Purchase & Acquisition Costs
| Cost item | Amount | Source / formula |
- Stamp duty, legal/conveyancing, building & pest, LMI, lender fees,
  buyers agent, other. Show TOTAL UPFRONT separately.

## Annual Holding Costs
| Cost item | Annual | Monthly | Notes |
- Council, water, strata, landlord insurance, property management,
  letting fees, repairs/maintenance, land tax. TOTAL line at bottom.

## Rental Income & Yield Analysis
| Metric | Calculation | Value |
- Weekly rent, annual rent, gross yield, net yield, vacancy assumption.

## Loan Structure & Serviceability
- LVR, loan amount, LMI (with formula), interest rate
- P&I vs Interest-Only comparison table (monthly + annual)
- Serviceability summary (DTI / coverage if available)

## Year-1 Cashflow Summary
| Item | Annual | Monthly | Weekly |
- Income, costs, interest, principal, pre-tax cashflow, after-tax cashflow.

## Sensitivity Analysis
| Scenario | Interest rate | Rent change | Annual cashflow | Δ vs base |
- At minimum: base, +1%, +2% rates; -10% rent; 6-week vacancy.

## 10-Year Projections
| Year | Property value | Weekly rent | Annual cashflow | Equity | LVR |
- Years 1, 3, 5, 7, 10. Show conservative + base columns.

## Tax Position & Depreciation
- Depreciation (capital works + plant & equipment) if available
- Negative gearing add-back, marginal tax rate assumption
- After-tax position summary

## Equity & Exit Scenarios
- Equity growth schedule, refinance window, CGT exposure on hypothetical sale

## Financial Assumptions & Data Sources
- Bullet list of every assumption (rate, growth, CPI, vacancy, MTR)
- Source attribution for each data point
`
  }
};

/**
 * The service-role client bypasses RLS, so report access must be checked here
 * before a caller-controlled report ID is read or changed. This mirrors the
 * investment_reports policy: the report generator and the owning client user
 * may access a report. Internal service calls retain their existing access.
 */
async function canAccessInvestmentReport(supabase: any, report: any, userId: string) {
  if (userId === 'service_role' || report.generated_by === userId) return true;
  if (!report.client_property_id) return false;

  const { data: clientProperty, error: clientPropertyError } = await supabase
    .from('client_properties')
    .select('client_id')
    .eq('id', report.client_property_id)
    .maybeSingle();

  if (clientPropertyError || !clientProperty?.client_id) return false;

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientProperty.client_id)
    .eq('created_by', userId)
    .maybeSingle();

  return !clientError && !!client;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  console.log('=== Condense Investment Report Function Started ===');
  let targetReportId: string | null = null;

  try {
    // SECURITY: Verify authentication
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const requestBody = await req.json();
    const { parentReportId, targetTier, reportId, tier } = requestBody;
    
    const { error: authError, userId } = await verifyAuth(supabase, req.headers, requestBody);
    if (authError) {
      console.log('[condense-investment-report] Auth failed:', authError);
      return createUnauthorizedResponse(authError, corsHeaders);
    }
    console.log(`[condense-investment-report] Authenticated user: ${userId}`);

    console.log('Request params:', { parentReportId, targetTier, reportId, tier });

    // In-place canonical post-processing path used after chunked regeneration.
    // This does NOT create a child report; it trims/QA-checks the regenerated
    // Compass-40 or Financial Analysis content already saved on the same row.
    if (reportId && tier && ['compass-40', 'financial-analysis'].includes(tier)) {
      const { data: report, error: reportError } = await supabase
        .from('investment_reports')
        .select('id, generated_by, client_property_id, report_content')
        .eq('id', reportId)
        .single();

      if (reportError || !report?.report_content || !await canAccessInvestmentReport(supabase, report, userId!)) {
        return new Response(JSON.stringify({
          error: 'Report content not found for post-processing',
          success: false,
        }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { postProcessReportMarkdown } = await import('../_shared/compassPostProcessor.ts');
      const { runQAValidation } = await import('../_shared/compassQAValidator.ts');
      const result = postProcessReportMarkdown(report.report_content, tier);
      const qaReport = runQAValidation(result.markdown, tier);

      const { error: updateError } = await supabase
        .from('investment_reports')
        .update({
          report_content: result.markdown,
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', reportId);

      if (updateError) {
        throw new Error(`Failed to save post-processed report: ${updateError.message}`);
      }

      return new Response(JSON.stringify({
        success: true,
        reportId,
        tier,
        postProcessReport: result.report,
        qaReport,
        message: 'Canonical report post-processing complete',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate inputs
    if (!parentReportId) {
      return new Response(JSON.stringify({ 
        error: 'Parent report ID is required',
        success: false 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // One engine per variant name (audit F9). "Financial" is a DETERMINISTIC
    // split of the parent produced by fork-investment-report; this function
    // summarises with a model. Both used to answer to "financial" — under
    // different linkage columns, so neither saw the other's child and one
    // parent could hold two contradictory Financial documents. The server
    // refuses now, whatever a caller routes.
    if (!targetTier || !['briefing', 'snapshot'].includes(targetTier)) {
      return new Response(JSON.stringify({
        error: targetTier === 'financial'
          ? 'The Financial report is produced deterministically by fork-investment-report, not by condensation.'
          : 'Target tier must be "briefing" or "snapshot"',
        success: false
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // The client-facing variant is required at creation time. Never rely on
    // the database default here: that would mislabel a Briefing/Snapshot as a
    // Compass base report in the generated report library.
    const reportVariant = targetTier as 'briefing' | 'snapshot';

    // Supabase client already initialized above for auth verification

    // Fetch the parent (Compass) report
    const { data: parentReport, error: fetchError } = await supabase
      .from('investment_reports')
      .select('*')
      .eq('id', parentReportId)
      .eq('report_tier', 'compass')
      .single();

    if (fetchError || !parentReport) {
      console.error('Failed to fetch parent report:', fetchError);
      return new Response(JSON.stringify({ 
        error: 'Parent Compass report not found',
        success: false 
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!await canAccessInvestmentReport(supabase, parentReport, userId!)) {
      return new Response(JSON.stringify({
        error: 'Parent Compass report not found',
        success: false,
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Parent report found:', parentReport.property_address);

    // Resolve the exact child in this Compass package before generating. A
    // missing row is created below; an existing row is regenerated in place so
    // retries never create an uncontrolled duplicate or silently no-op.
    const { data: existingTier, error: existingTierError } = await supabase
      .from('investment_reports')
      .select('id, generated_by, client_property_id')
      .eq('parent_report_id', parentReportId)
      .eq('report_tier', targetTier)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingTierError) {
      throw new Error(`Failed to resolve existing ${TIER_CONFIG[targetTier].name}: ${existingTierError.message}`);
    }

    if (existingTier && !await canAccessInvestmentReport(supabase, existingTier, userId!)) {
      return new Response(JSON.stringify({
        error: 'Parent Compass report not found',
        success: false,
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let condensedReport: { id: string } | null = existingTier;
    if (existingTier) {
      const { data, error } = await supabase
        .from('investment_reports')
        .update({
          report_content: `Generating ${TIER_CONFIG[targetTier].name}...`,
          report_variant: reportVariant,
          status: 'processing',
          error_message: null,
          updated_at: new Date().toISOString(),
          // A refreshed child carries the parent's CURRENT record, not the
          // copy taken when the child was first created. Regeneration used to
          // rewrite the prose and leave these columns as they were — fresh
          // words over years-old figures, which is the staleness this phase
          // exists to end (audit F10).
          property_specs: parentReport.property_specs,
          demographics_data: parentReport.demographics_data,
          economic_data: parentReport.economic_data,
          financial_calculations: parentReport.financial_calculations,
          investment_score: parentReport.investment_score,
          location_intelligence: parentReport.location_intelligence,
          data_sources: parentReport.data_sources,
          // The substance is the parent's, whatever engine produced it —
          // unwritten, this column defaulted every child to 'legacy'.
          generation_engine: parentReport.generation_engine ?? 'legacy',
        })
        .eq('id', existingTier.id)
        .select('id')
        .maybeSingle();
      if (error || !data) throw new Error(`Failed to prepare ${TIER_CONFIG[targetTier].name} regeneration: ${error?.message || 'report not found'}`);
      condensedReport = data;
    } else {
      // Create the target before calling the generator. This makes a missing
      // requested type a valid create path rather than a zero-row update.
      const { data, error: insertError } = await supabase
        .from('investment_reports')
        .insert({
        property_address: parentReport.property_address,
        property_listing_id: parentReport.property_listing_id,
        client_property_id: parentReport.client_property_id,
        canonical_property_key: parentReport.canonical_property_key,
        report_content: `Generating ${TIER_CONFIG[targetTier].name}...`,
        status: 'pending',
        report_tier: targetTier,
        report_variant: reportVariant,
        parent_report_id: parentReportId,
        // Both linkage columns, so the family is one lookup for every reader.
        // History split them: fork children carried derived_from_report_id,
        // condense children carried parent_report_id, and the two engines
        // could not see each other's rows.
        derived_from_report_id: parentReportId,
        report_scope: parentReport.report_scope,
        property_specs: parentReport.property_specs,
        // Copy structured data from parent
        demographics_data: parentReport.demographics_data,
        economic_data: parentReport.economic_data,
        financial_calculations: parentReport.financial_calculations,
        investment_score: parentReport.investment_score,
        location_intelligence: parentReport.location_intelligence,
        data_sources: parentReport.data_sources,
        generation_engine: parentReport.generation_engine ?? 'legacy',
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('Failed to create condensed report:', insertError);
        throw new Error(`Failed to create report: ${insertError.message}`);
      }
      condensedReport = data;
    }

    if (!condensedReport) throw new Error(`Failed to initialise ${TIER_CONFIG[targetTier].name}`);
    targetReportId = condensedReport.id;
    console.log(`${existingTier ? 'Regenerating' : 'Created pending'} condensed report:`, condensedReport.id);

    // Get the tier configuration
    const tierConfig = TIER_CONFIG[targetTier];

    // Build the condensation prompt using the structure guide
    const _brandCondense = await getBrandConfig();
    const { resolvePrompt: _resolveCondensePrompt } = await import('../_shared/engine-prompts.ts');
    const systemPrompt = (await _resolveCondensePrompt('condense.system_template', {
      brand_name: _brandCondense.companyName,
      tier_name: tierConfig.name,
      target_pages: tierConfig.targetPages,
      structure_guide: tierConfig.structureGuide,
    })).text;

    // The recorded figures, from the parent's own structured columns — the
    // same reconciled projection every templated document binds. The parent's
    // PROSE deliberately omits most of these (a Compass body carries no
    // financials, and argues its score without restating the components), and
    // a model told to fill a table from a document that never states the
    // numbers wrote N/A nineteen times on a real snapshot whose row held every
    // figure. The block is authoritative; a metric absent from it and from the
    // prose loses its row rather than gaining a placeholder.
    const factsBlock = buildRecordedFactsBlock(projectInvestmentReport(parentReport as InvestmentReportRowLike));

    const userPrompt = `Please condense the following comprehensive investment report into a ${tierConfig.name} format (~${tierConfig.targetPages} pages).

Use the structure template from the system prompt and extract the relevant data from this report:

---
ORIGINAL COMPREHENSIVE REPORT:
${parentReport.report_content}
---
${factsBlock ? `\n${factsBlock}\n` : ''}
IMPORTANT:
- Copy all numerical values, percentages, and scores EXACTLY — from the RECORDED FIGURES block first, then from the report
- Include a metric's table row ONLY when its value is known from those sources; NEVER write "N/A", "TBD" or any placeholder — omit the row entirely
- Keep all table data intact
- Follow the section structure precisely
- Maintain professional formatting throughout`;

    // Call Lovable AI to condense the report
    // Phase 4 (LLM Router): model selection driven by agent_model_assignments
    // for agent_key='investment_report_condense'.
    const { callLLMRaw } = await import('../_shared/llmRouter.ts');
    console.log('Calling LLM router for condensation...');
    const aiResponse = await callLLMRaw({
      agentKey: 'investment_report_condense',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: targetTier === 'briefing' ? 16000 : 6000,
      temperature: 0.3,
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', aiResponse.status, errorText);
      
      // Update report to failed status
      await supabase
        .from('investment_reports')
        .update({
          status: 'failed',
          error_message: `AI condensation failed: ${aiResponse.status}`,
        })
        .eq('id', condensedReport.id);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ 
          error: 'Rate limit exceeded. Please try again later.',
          success: false 
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`AI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    let condensedContent = aiData.choices?.[0]?.message?.content;

    if (!condensedContent) {
      throw new Error('No content received from AI');
    }

    console.log('AI condensation complete, content length:', condensedContent.length);

    // Phase 5+6: word-cap enforcement + page-pressure trimming
    // Phase 7: QA validation (returned in response for observability)
    //
    // Hygiene runs on BOTH tiers now. It ran on the briefing alone, which was
    // exactly backwards: the Snapshot — the format with no room for slack —
    // shipped a double document (its 8 declared sections followed by a copy
    // of the parent's own headings: 17 H2s and 2.5× the format's length on
    // row 8c6edc56) with nothing to catch it.
    let postProcessReport: unknown = null;
    // Sections composed from the record, addressed by the registry id that
    // decides where each one goes. Collected for both condensed tiers and
    // placed by `assembleInDeclaredOrder` below.
    const composedPlacements: ComposedPlacement[] = [];
    let qaReport: unknown = null;
    const hygiene: Record<string, unknown> = {};
    try {
      const { runQAValidation } = await import('../_shared/compassQAValidator.ts');

      if (targetTier === 'briefing') {
        const { postProcessReportMarkdown } = await import('../_shared/compassPostProcessor.ts');
        const result = postProcessReportMarkdown(condensedContent, 'compass-40');
        condensedContent = result.markdown;
        postProcessReport = result.report;

        // The financial tables, the score breakdown and the SWOT are COMPOSED
        // from the row's own record, never asked of the model — the guide
        // forbids it, and the model's version is what wrote 87 N/As on the
        // newest briefing. The parent's score and calculations were copied
        // onto this child above, so the composed sections and the templated
        // KPI tiles read the same record.
        //
        // Each chapter is tagged with the section id the registry places it at.
        // The map is here rather than in the composer because the composer
        // answers to the Financial tier's layout and the registry answers to
        // the Briefing's.
        const CHAPTER_SECTION_ID: Record<number, ComposedPlacement['id']> = {
          4: 'purchaseHolding', 5: 'rentalYield', 6: 'loan', 8: 'sensitivity', 9: 'tenYear',
        };
        for (const ch of composeFinancialChapters(
          { financialCalculations: parentReport.financial_calculations, investmentScore: parentReport.investment_score },
          { scenarios: 'primary' },
        )) {
          // 12 and 14 are the FIN-titled scorecard and SWOT; the briefing
          // carries them under its own headings below.
          const id = CHAPTER_SECTION_ID[ch.ordinal];
          if (id) composedPlacements.push({ id, markdown: ch.markdown });
        }
        const scoreSection = composeScoreBreakdownSection(parentReport.investment_score, 'Investment Score Breakdown');
        if (scoreSection) composedPlacements.push({ id: 'scorecard', markdown: scoreSection });
        const swotSection = composeSwotSection(parentReport.investment_score, 'SWOT Analysis');
        if (swotSection) composedPlacements.push({ id: 'swot', markdown: swotSection });
      }

      // The Snapshot composes too, and until now composed NOTHING — the only
      // member of the family that did not. Briefing 7 sections from the record,
      // Financial 8, Snapshot 0, while four of its nine model-authored sections
      // were numeric. Three of those four are figures the record holds outright,
      // so they are typed from it here; `Key Market Stats` stays authored
      // because median price, vacancy rate, days on market and walk score are
      // NOT in `financial_calculations` and composing them would mean inventing
      // a source, which is the worse failure.
      if (targetTier === 'snapshot') {
        const verdictSection = composeVerdictSection(parentReport.investment_score, 'Investment Score');
        if (verdictSection) composedPlacements.push({ id: 'verdict', markdown: verdictSection });
        const dimsSection = composeScoreDimensionsSection(parentReport.investment_score, 'Score Breakdown');
        if (dimsSection) composedPlacements.push({ id: 'scorecard', markdown: dimsSection });
        const finSection = composeFinancialSnapshotSection(parentReport.financial_calculations, 'Financial Snapshot');
        if (finSection) composedPlacements.push({ id: 'financialSnapshot', markdown: finSection });
      }
      hygiene.composed_sections = composedPlacements.length;

      // Trim to what the tier declares — on BOTH condensed tiers now.
      //
      // The snapshot's list used to be typed out here, a ninth copy of the
      // structure; it comes from the registry, which declares exactly the same
      // nine headings in the same order, so this half is a no-op.
      //
      // The briefing is the change. It had no trim at all, and every one of the
      // 21 briefings in production carries the PARENT's structure rather than
      // its own: `Location Overview` on 20, `Historical Price Growth Table` on
      // 19, `Major Industries & Job Growth` on 19 — while six of its nine
      // declared headings (`Location & Demand`, `Amenity & Access`, `Market
      // Position`, `Property Fit`, `Risk Overview`, `Recommendation`) appear on
      // NONE. Phase 1 re-cut the guide and shipped no enforcement, so the guide
      // was aspirational; the snapshot got both halves and the briefing got one.
      //
      // The trim runs on the model's own output, BEFORE the composed sections
      // are placed — they are ours and always declared, so including them here
      // would only make the "did the model follow the guide" question answer
      // itself.
      if (targetTier === 'briefing' || targetTier === 'snapshot') {
        const declared = markdownHeadingsForTier(targetTier);
        const trimmed = trimToDeclaredSections(condensedContent, declared);
        // A trim that keeps nothing the MODEL wrote is not a trim, it is a
        // deletion: the briefing would go out as its composed financial tables
        // with no case attached to them. In that state, keep the untrimmed text
        // and record it: a stub is worse than a document with the wrong
        // headings, and the count belongs in the log rather than in a client's
        // hands.
        const authored = authoredHeadingsForTier(targetTier).map((h) => h.toLowerCase());
        const survivors = [...trimmed.markdown.matchAll(/^##\s+(.+?)\s*$/gm)]
          .map((m) => m[1].toLowerCase().replace(/\s+/g, ' ').trim());
        const keptAny = survivors.some((h) => authored.some((a) => h === a || h.startsWith(`${a} `)));
        if (keptAny) {
          condensedContent = trimmed.markdown;
          hygiene.sections_dropped = trimmed.dropped;
        } else {
          hygiene.sections_trim_skipped = trimmed.dropped;
        }

        // Place every section in the order the registry declares, composed
        // ones included. They used to be appended after everything the model
        // wrote — so the Briefing's financial tables, score breakdown and SWOT
        // printed after `Recommendation` (order 20) and after `Market Data
        // Sources` (order 90), when the registry places them at 11-17. The
        // trim filters and has never reordered.
        //
        // Assembly runs only where the trim actually ran: on untrimmed text a
        // foreign heading is ABSORBED into whichever section is open rather
        // than dropped, and the fallback append keeps the composed sections in
        // the document rather than losing them to a structural safety check.
        if (composedPlacements.length || keptAny) {
          if (keptAny) {
            const assembled = assembleInDeclaredOrder(condensedContent, composedPlacements, targetTier);
            condensedContent = assembled.markdown;
            hygiene.sections_placed = assembled.placed;
            hygiene.sections_authored = assembled.authored;
            if (assembled.unplaced.length) hygiene.sections_unplaced = assembled.unplaced;
          } else if (composedPlacements.length) {
            condensedContent = `${condensedContent.trimEnd()}\n\n${composedPlacements.map((c) => c.markdown).join('\n\n')}`;
            hygiene.sections_appended_untrimmed = composedPlacements.length;
          }
        }

        const stripped = stripEditorialLabelsFromMarkdown(condensedContent);
        condensedContent = stripped.markdown;
        hygiene.editorial_blocks_removed = stripped.removedBlocks;
      }

      // A labelled row is a promise that a figure follows it — on every tier.
      const scrubbed = stripPlaceholderRows(condensedContent);
      condensedContent = scrubbed.markdown;
      hygiene.placeholder_rows_removed = scrubbed.removedRows;
      hygiene.placeholder_tables_removed = scrubbed.removedTables;

      // The same rule for the two block types the row scrubber cannot see: a
      // stat card with no value (the renderer draws its UNIT in display type)
      // and a chart already drawn earlier in the document.
      const blocks = scrubBlocks(condensedContent);
      condensedContent = blocks.markdown;
      hygiene.empty_stat_cards_removed = blocks.emptyStatCards;
      hygiene.duplicate_directives_removed = blocks.duplicateDirectives;

      qaReport = runQAValidation(condensedContent, 'compass-40');
      console.log('Hygiene:', JSON.stringify(hygiene));
      if (postProcessReport) console.log('Post-processor report:', JSON.stringify(postProcessReport, null, 2));
      console.log('QA report:', JSON.stringify(qaReport, null, 2));
    } catch (ppErr) {
      console.error('Post-processor/QA failed (continuing):', ppErr);
    }

    // Update the condensed report with the content
    const { error: updateError } = await supabase
      .from('investment_reports')
      .update({
        report_content: condensedContent,
        status: 'completed',
        sources_content: parentReport.sources_content, // Copy sources from parent
        // The staleness stamp: this child reflects its parent as of NOW.
        // Freshness is judged against this at read (subReportFamily.pure.ts),
        // never stored as a flag nothing remembers to clear.
        variant_generated_at: new Date().toISOString(),
      })
      .eq('id', condensedReport.id);

    if (updateError) {
      console.error('Failed to update condensed report:', updateError);
      throw new Error(`Failed to update report: ${updateError.message}`);
    }

    console.log('=== Condensation Complete ===');

    return new Response(JSON.stringify({ 
      success: true,
      reportId: condensedReport.id,
      tier: targetTier,
      tierName: tierConfig.name,
      postProcessReport,
      qaReport,
      hygiene,
      message: `${tierConfig.name} generated successfully`
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Condense report error:', error);
    // A report is only completed after its generated content is persisted. If
    // any later stage fails, retain the same target for a safe retry instead
    // of leaving it indefinitely in pending/processing.
    if (targetReportId) {
      try {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        await supabase
          .from('investment_reports')
          .update({
            status: 'failed',
            error_message: 'Client report generation did not complete. Retry the requested report type.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetReportId);
      } catch (statusError) {
        console.error('Failed to mark condensed report as failed:', statusError);
      }
    }
    return new Response(JSON.stringify({
      ...internalError(error, 'condense-investment-report'),
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
