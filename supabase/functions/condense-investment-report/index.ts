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

// Report tier configurations based on NPC report templates
const TIER_CONFIG = {
  briefing: {
    name: 'Executive Briefing',
    targetPages: 20,
    contentRatio: 0.4, // 40% of original content
    sections: [
      'Location Overview',
      'Current Market Performance',
      'Market Activity',
      'Population & Household Characteristics',
      'Major Industries & Job Growth',
      'Transport & Accessibility',
      'Education Facilities',
      'Healthcare & Shopping',
      'Environmental Risks',
      'Crime Statistics',
      'Property-Level Information',
      'Purchase & Ongoing Costs',
      // NOTE: Comparable Sales and Rentals sections removed - requires paid API integration (CoreLogic/RP Data)
      // TODO: Re-enable when transaction data APIs are integrated
      'Financial Analysis (Yields, Loan Analysis, Sensitivity)',
      'Property Value & Rental Projections',
      'Investment Score Breakdown',
      'SWOT Analysis',
      'Top Opportunities & Risks',
      'Investment Recommendations',
      'Market Data Sources'
    ],
    structureGuide: `
REPORT STRUCTURE (~20 PAGES):

## Location Overview
- Address being analyzed
- SA2/SA3/SA4/LGA statistical areas
- Suburb description (2-3 sentences)
- Population trends (1-2 sentences)

## Current Market Performance (Q3/Q4 2025)
| Metric | Value | YoY Change |
- Median House Price, Median Unit Price
- Gross Rental Yield, Units Sold, Days on Market, Capital Growth
- Source attribution

## Historical Price Growth Table
## Historical Rent Growth Table

## Market Activity
| Metric | Value | Source |
- Active Listings, Sales Volume, Vacancy Rate

## Population & Household Characteristics
| Metric | Value | Source |
- Employment Rate, Unemployment Rate, Labor Force
- Median Income, IRSAD/IRSD Scores

## Major Industries & Job Growth
| Industry | Workforce % | Growth Rate |
- Top 5 industries with growth rates
- Job Growth Trends table

## Transport & Accessibility
| Metric | Value | Details |
- Walk Score, CBD Commute, Public Transport Score

## Education Facilities
| Facility | Distance | Rating |
- 5 nearest facilities

## Healthcare & Shopping
| Facility | Distance | Details |
- Amenity Scores table

## Environmental Risks
| Risk Type | Assessment | Details |
- Flood, Bushfire, Heatwave risks

## Crime Statistics
| Metric | Value | Comparison |
- Crime Breakdown table

## Property-Level Information
| Property Characteristic | Value |
- Type, Bedrooms, Bathrooms, Parking, Year Built, Estimated Value

## Purchase & Ongoing Costs
| Cost Category | Amount | Calculation |
- All annual costs itemized

## Base Assumptions
- Bullet list of all financial assumptions

## Gross & Net Yield Calculation
| Metric | Calculation | Value |

## Loan Analysis (P&I and Interest-Only)
| Item | Annual | Monthly |

## Sensitivity Analysis
| Scenario | Interest Rate | Annual Cashflow |

## Property Value Projections
| Year | Conservative | Base |
- Years 1, 3, 5, 10

## Rental Income Projections
| Year | Conservative | Base |

## Cumulative Cashflow Projections
| Year | Conservative | Base |

## LVR Projections
| Scenario | Year 10 LVR |

## Overall Investment Score
- Investment Grade (letter)
- Total Score (/100)
- Recommendation

## Investment Score Breakdown
| Component | Weight | Score |
- Growth, Location, Yield, Demand, Risk

## SWOT Analysis
### Strengths (4 bullet points)
### Weaknesses (4 bullet points)
### Opportunities (4 bullet points)
### Threats (4 bullet points)

## Top 3 Opportunities
- Detailed paragraph for each

## Top 3 Risks
- Detailed paragraph for each

## Investment Recommendations
### Short-term Actions
### Long-term Strategy
### Key Considerations

## Market Data Sources
| Metric | Source | URL |
`
  },
  snapshot: {
    name: 'Snapshot',
    targetPages: 5,
    contentRatio: 0.15, // 15% of original content
    sections: [
      'Property Summary',
      'Key Market Stats',
      'Investment Score',
      'Financial Snapshot',
      'Top Opportunities & Risks',
      'Recommendation'
    ],
    structureGuide: `
REPORT STRUCTURE (~5 PAGES):

## Property Summary
- Address, Property Type, Bedrooms/Bathrooms
- Estimated Value, Location highlights (3 sentences max)

## Key Market Stats
| Metric | Value |
- Median Price, Rental Yield, Vacancy Rate, Capital Growth
- Days on Market, Walk Score

## Investment Score
- Grade: [Letter Grade]
- Score: [X]/100
- Recommendation: [BUY/HOLD/SELL]

## Score Breakdown (simplified)
| Component | Score |
- Growth, Location, Yield, Demand, Risk

## Financial Snapshot
| Metric | Value |
- Purchase Price, Weekly Rent, Gross Yield, Net Yield
- Annual Cashflow, 10-Year Projected Value

## Top 3 Opportunities
- Brief bullet points (1-2 sentences each)

## Top 3 Risks
- Brief bullet points (1-2 sentences each)

## Quick Recommendation
- 2-3 sentences summarizing the investment thesis
`
  },
  financial: {
    name: 'Financial Analysis Report',
    targetPages: 20,
    contentRatio: 0.35,
    sections: [
      'Property & Purchase Snapshot',
      'Purchase & Acquisition Costs',
      'Annual Holding Costs',
      'Rental Income & Yield Analysis',
      'Loan Structure & Serviceability (LVR, LMI, P&I vs IO)',
      'Year-1 Cashflow Summary',
      'Sensitivity Analysis (interest rate, rent, vacancy)',
      '10-Year Projections (value, rent, cashflow, equity)',
      'Tax Position & Depreciation',
      'Equity & Exit Scenarios',
      'Financial Assumptions & Data Sources',
    ],
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

    const userPrompt = `Please condense the following comprehensive investment report into a ${tierConfig.name} format (~${tierConfig.targetPages} pages).

Use the structure template from the system prompt and extract the relevant data from this report:

---
ORIGINAL COMPREHENSIVE REPORT:
${parentReport.report_content}
---

IMPORTANT:
- Copy all numerical values, percentages, and scores EXACTLY
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
    let postProcessReport: unknown = null;
    let qaReport: unknown = null;
    if (targetTier === 'briefing') {
      try {
        const { postProcessReportMarkdown } = await import('../_shared/compassPostProcessor.ts');
        const { runQAValidation } = await import('../_shared/compassQAValidator.ts');
        const tier = 'compass-40';
        const result = postProcessReportMarkdown(condensedContent, tier);
        condensedContent = result.markdown;
        postProcessReport = result.report;
        qaReport = runQAValidation(condensedContent, tier);
        console.log('Post-processor report:', JSON.stringify(result.report, null, 2));
        console.log('QA report:', JSON.stringify(qaReport, null, 2));
      } catch (ppErr) {
        console.error('Post-processor/QA failed (continuing):', ppErr);
      }
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
