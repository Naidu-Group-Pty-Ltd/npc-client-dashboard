import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { logApiUsage } from '../_shared/logApiUsage.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { withReportMetering, resolveUserId, buildIdempotencyKey } from '../_shared/reportMetering.ts';
import { insertTargetedNotification } from '../_shared/notify.ts';
import { compassSections, financialSections, COMPASS_PAGE_BAND, EDITORIAL_LABELS, type CompassSectionDefinition as CanonicalSectionDefinition } from '../_shared/compassSectionRegistry.ts';
import { postProcessReportMarkdown } from '../_shared/compassPostProcessor.ts';
import { runQAValidation } from '../_shared/compassQAValidator.ts';
import { startRun as traceStartRun, recordChunk as traceRecordChunk, finishRun as traceFinishRun, packetKeysAttached as tracePacketKeys } from '../_shared/generation-trace.ts';
import { buildInvestmentReportMeteringParts } from '../_shared/investmentReportMeteringKey.ts';
const INTERNAL_EDGE_SECRET = (Deno.env.get('INTERNAL_EDGE_SECRET') || '').trim();

// ============================================================================
// WALL-CLOCK BUDGET
// ============================================================================
// The Supabase edge runtime terminates an invocation at ~150s. A full Compass
// report is a dozen sections at 9-37s each, so a single invocation can never
// finish one — it used to be killed around section 6, leaving `status` stuck on
// 'processing' with `report_generation_runs.status` still 'running' and no error
// anywhere. Instead of racing the ceiling we stop before it and report progress
// honestly; the caller resumes with `continueFrom: true`.
//
// Budget stops us STARTING a section we predict we cannot finish. The reserve
// covers post-processing (schema validation, dedup, DB write) on the run that
// does complete the final section.
const SECTION_LOOP_BUDGET_MS = 110_000;
const POST_PROCESSING_RESERVE_MS = 25_000;
// Fallback estimate before we have measured a section in this run.
const DEFAULT_SECTION_ESTIMATE_MS = 30_000;

// Per-call ceilings for the model. These used to be 150s/120s — longer than the
// entire edge invocation, so one hung call could still blow the whole run past
// the platform ceiling before the between-sections budget guard could fire.
// Observed section latency in production is 9-37s, so these leave ample room.
const SECTION_REQUEST_TIMEOUT_MS = 60_000;
const SECTION_CONTINUATION_TIMEOUT_MS = 45_000;

// ============================================================================
// REPORT SECTION DEFINITIONS - SYNCED WITH DATABASE TEMPLATE STRUCTURE
// ============================================================================
// These section definitions match the "Investor Compass Structure v2" template
// stored in report_structure_templates table. They serve as:
// 1. Fallback when template parsing fails
// 2. Validation reference for dynamic parsing
// 3. Performance tuning (maxTokens, requiredKeywords)
// ============================================================================

interface ReportSectionDefinition {
  id: string;
  name: string;
  sections: string[];  // H2 headings from template that belong to this group
  maxTokens: number;
  minContentLength: number;
  /** Upper bound in characters. Optional: the legacy scope templates set none. */
  maxContentLength?: number;
  requiredKeywords: string[];
}

/**
 * Headings a single section may carry before it counts as over-structured.
 *
 * Production ran at 96 headings a report across 17 sections — 24.6 `##`, 68.1
 * `###`, 2.9 `####`. The floor of three in `validateSectionContent` is part of
 * why: a section with two findings still had to invent a third heading to clear
 * it. Six leaves room for a genuinely structured section (an H2 plus four or
 * five sub-heads) and flags the ones padding to a number.
 */
const MAX_SECTION_HEADINGS = 6;

/** Same five labels the registry forbids; used to flag a section in the log. */
const EDITORIAL_LABEL_PROBE = new RegExp(
  `^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(?:${EDITORIAL_LABELS
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

// FALLBACK HARDCODED SECTIONS - Matches database template "Investor Compass Structure v2"
// These 12 groups contain all 26 H2 sections from the template, logically grouped for generation
const DEFAULT_REPORT_SECTIONS: ReportSectionDefinition[] = [
  {
    id: 'section0',
    name: 'Executive Summary',
    sections: ['Executive Summary'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['investment', 'property', 'recommendation', 'score'],
  },
  {
    id: 'section1',
    name: 'Location Overview',
    sections: ['Location Overview'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['suburb', 'community', 'transport', 'lifestyle'],
  },
  {
    id: 'section2',
    name: 'Market & Economics',
    sections: ['Current Market Performance', 'Current Economic Context'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['market', 'cash rate', 'inflation', 'growth'],
  },
  {
    id: 'section3',
    name: 'Demographics & Demand',
    sections: ['Demographics & Demand Drivers'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['population', 'income', 'employment', 'household'],
  },
  {
    id: 'section4',
    name: 'Education & Healthcare',
    sections: ['Schools & Education', 'Healthcare & Shopping'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['school', 'education', 'hospital', 'healthcare'],
  },
  {
    id: 'section5',
    name: 'Recreation & Transport',
    sections: ['Recreational Amenities', 'Transport & Accessibility'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['recreation', 'park', 'transport', 'commute'],
  },
  {
    id: 'section6',
    name: 'Environment & Safety',
    sections: ['Environmental Risks & Climate', 'Crime & Safety'],
    maxTokens: 4000,
    minContentLength: 3500,
    requiredKeywords: ['flood', 'bushfire', 'crime', 'safety'],
  },
  {
    id: 'section7',
    name: 'Property & Zoning',
    // Updated: Strategic Assessment, Top 3 Opportunities, and Top 3 Risks now under Property-Level Information
    sections: ['Property-Level Information', 'Strategic Assessment', 'Capital Appreciation Potential', 'Leveraged Equity Accumulation', 'Sustained Employment Growth', 'Structural Cashflow Deficit', 'Interest Rate Sensitivity', 'Environmental Risk'],
    maxTokens: 5000,
    minContentLength: 4500,
    requiredKeywords: ['property', 'zoning', 'land', 'strategic', 'opportunity', 'risk'],
  },
  {
    id: 'section8',
    name: 'Costs & Rental',
    sections: ['Purchase & Ongoing Costs (Annual)', 'Rental Assessment & Yield Calculation'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['purchase', 'stamp duty', 'rent', 'yield'],
  },
  {
    id: 'section9',
    name: 'Loan & Sensitivity',
    sections: ['Loan Structure & Repayment Analysis', 'Sensitivity Analysis'],
    maxTokens: 2500,
    minContentLength: 2500,
    requiredKeywords: ['loan', 'repayment', 'cashflow', 'sensitivity'],
  },
  {
    id: 'section10',
    name: 'Projections & SWOT',
    // Removed: Top 3 Opportunities (moved to Property-Level Information)
    sections: ['10-Year Investment Projections', 'Investment Score Analysis', 'SWOT Analysis Summary'],
    maxTokens: 3000,
    minContentLength: 3000,
    requiredKeywords: ['projection', 'swot', 'score'],
  },
  {
    id: 'section11',
    name: 'Risks & Recommendations',
    // Removed: Top 3 Risks (moved to Property-Level Information)
    sections: ['Investment Recommendations', 'Final Conclusion', 'PROFESSIONAL DISCLAIMER'],
    maxTokens: 4000,
    minContentLength: 3000,
    requiredKeywords: ['recommendation', 'conclusion'],
  }
];

// ============================================================================
// SUBURB REPORT SECTIONS - Fallback for suburb-scope reports
// ============================================================================
const DEFAULT_SUBURB_SECTIONS: ReportSectionDefinition[] = [
  {
    id: 'suburb_section0',
    name: 'Executive Summary',
    sections: ['Executive Summary'],
    maxTokens: 2000,
    minContentLength: 1500,
    requiredKeywords: ['suburb', 'investment', 'thesis'],
  },
  {
    id: 'suburb_section1',
    name: 'Suburb Profile',
    sections: ['Suburb Profile', 'Location & Profile'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['suburb', 'character', 'geographic', 'LGA'],
  },
  {
    id: 'suburb_section2',
    name: 'Market Analysis & Trends',
    sections: ['Market Analysis', 'Price Trends & Growth'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['median', 'growth', 'clearance', 'price'],
  },
  {
    id: 'suburb_section3',
    name: 'Rental Market',
    sections: ['Rental Market Deep Dive'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['rent', 'yield', 'vacancy', 'demand'],
  },
  {
    id: 'suburb_section4',
    name: 'Demographics & Economics',
    sections: ['Demographics & Economics'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['population', 'income', 'employment', 'household'],
  },
  {
    id: 'suburb_section5',
    name: 'Location & Amenities',
    sections: ['Location & Amenities', 'Infrastructure & Amenities'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['transport', 'school', 'shopping', 'healthcare'],
  },
  {
    id: 'suburb_section6',
    name: 'Supply & Development',
    sections: ['Supply & Development Pipeline'],
    maxTokens: 2000,
    minContentLength: 1500,
    requiredKeywords: ['development', 'DA', 'rezoning', 'supply'],
  },
  {
    id: 'suburb_section7',
    name: 'Risk & Safety',
    sections: ['Risk Assessment', 'Crime & Safety'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['flood', 'bushfire', 'crime', 'risk'],
  },
  {
    id: 'suburb_section8',
    name: 'Investment Score & SWOT',
    sections: ['Investment Score & SWOT', 'SWOT Analysis'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['score', 'strength', 'weakness', 'opportunity'],
  },
  {
    id: 'suburb_section9',
    name: 'Comparative Context & Disclaimer',
    sections: ['Comparative Context', 'Disclaimer'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['comparison', 'benchmark', 'disclaimer'],
  },
];

// ============================================================================
// POSTCODE REPORT SECTIONS - Fallback for postcode-scope reports
// ============================================================================
const DEFAULT_POSTCODE_SECTIONS: ReportSectionDefinition[] = [
  {
    id: 'postcode_section0',
    name: 'Executive Summary',
    sections: ['Executive Summary'],
    maxTokens: 2000,
    minContentLength: 1500,
    requiredKeywords: ['postcode', 'investment', 'thesis'],
  },
  {
    id: 'postcode_section1',
    name: 'Zone Profile',
    sections: ['Zone Profile'],
    maxTokens: 2000,
    minContentLength: 1500,
    requiredKeywords: ['suburbs', 'LGA', 'boundaries', 'zone'],
  },
  {
    id: 'postcode_section2',
    name: 'Market Overview',
    sections: ['Market Overview'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['median', 'clearance', 'stock', 'market'],
  },
  {
    id: 'postcode_section3',
    name: 'Suburb-by-Suburb Breakdown',
    sections: ['Suburb-by-Suburb Breakdown'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['suburb', 'comparison', 'standout'],
  },
  {
    id: 'postcode_section4',
    name: 'Price Trends & Rental Market',
    sections: ['Price Trends & Growth', 'Rental Market'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['growth', 'benchmark', 'rent', 'yield', 'vacancy'],
  },
  {
    id: 'postcode_section5',
    name: 'Demographics & Infrastructure',
    sections: ['Demographics & Economics', 'Infrastructure & Development'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['population', 'income', 'projects', 'transport'],
  },
  {
    id: 'postcode_section6',
    name: 'Risk & Investment Score',
    sections: ['Risk Assessment', 'Investment Score & Hotspot Identification'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['risk', 'hazard', 'score', 'hotspot', 'SWOT'],
  },
  {
    id: 'postcode_section7',
    name: 'Disclaimer',
    sections: ['Disclaimer'],
    maxTokens: 1500,
    minContentLength: 500,
    requiredKeywords: ['disclaimer'],
  },
];

// ============================================================================
// STATEWIDE REPORT SECTIONS - Fallback for statewide-scope reports
// ============================================================================
const DEFAULT_STATEWIDE_SECTIONS: ReportSectionDefinition[] = [
  {
    id: 'statewide_section0',
    name: 'Executive Summary',
    sections: ['Executive Summary'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['state', 'investment', 'climate'],
  },
  {
    id: 'statewide_section1',
    name: 'State Economic Overview',
    sections: ['State Economic Overview'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['GDP', 'employment', 'population', 'migration'],
  },
  {
    id: 'statewide_section2',
    name: 'Property Market Overview',
    sections: ['Property Market Overview'],
    maxTokens: 2500,
    minContentLength: 2000,
    requiredKeywords: ['median', 'clearance', 'listings', 'market'],
  },
  {
    id: 'statewide_section3',
    name: 'Regional Comparison',
    sections: ['Regional Comparison'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['metro', 'regional', 'top', 'bottom'],
  },
  {
    id: 'statewide_section4',
    name: 'Price Trends & Rental Market',
    sections: ['Price Trends & Affordability', 'Rental Market'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['growth', 'affordability', 'vacancy', 'yield'],
  },
  {
    id: 'statewide_section5',
    name: 'Policy & Infrastructure',
    sections: ['Government Policy & Regulation', 'Infrastructure Pipeline'],
    maxTokens: 3000,
    minContentLength: 2500,
    requiredKeywords: ['stamp duty', 'land tax', 'projects', 'infrastructure'],
  },
  {
    id: 'statewide_section6',
    name: 'Risk & Hotspots',
    sections: ['Risk & Macro Factors', 'Investment Hotspots'],
    maxTokens: 3500,
    minContentLength: 3000,
    requiredKeywords: ['interest rate', 'supply', 'hotspot', 'SWOT'],
  },
  {
    id: 'statewide_section7',
    name: 'Disclaimer',
    sections: ['Disclaimer'],
    maxTokens: 1500,
    minContentLength: 500,
    requiredKeywords: ['disclaimer'],
  },
];

// Helper: get default sections by scope
function getDefaultSectionsForScope(scope: string): ReportSectionDefinition[] {
  switch (scope) {
    case 'suburb': return [...DEFAULT_SUBURB_SECTIONS];
    case 'postcode': return [...DEFAULT_POSTCODE_SECTIONS];
    case 'statewide': return [...DEFAULT_STATEWIDE_SECTIONS];
    default: return [...DEFAULT_REPORT_SECTIONS];
  }
}

function normaliseGenerationTier(_raw: unknown): 'compass-40' | 'financial-analysis' {
  // Composite-first strategy: only the Compass-40 composite is ever generated.
  // Client-facing FIN / PLDD variants are derived post-hoc by fork-investment-report.
  // The 'financial-analysis' standalone tier is intentionally retired here.
  return 'compass-40';
}

/**
 * Turn a registry section into a generation chunk.
 *
 * `maxTokens` used to be `maxWordCount * 4` (capped at 5,000) and was then
 * multiplied by 1.6 again for Compass — handing a 650-word section about 4,160
 * tokens, roughly 3,100 words, **4.8× its own cap**. The budget was not a
 * budget.
 *
 * It is now derived from the cap with a margin that is deliberately generous
 * rather than tight: `docs/reports/INVESTMENT.md` records mid-sentence
 * truncation as a live defect, and the `finish_reason === 'length'`
 * continuation pass exists because of it. Cutting a section off at the token
 * limit produces a broken sentence on a client's page, which is worse than a
 * long section. The cap is enforced by the prompt, by `maxContentLength` here,
 * and finally by the post-processor — never by truncation.
 */
function canonicalSectionsToGenerationSections(
  canonicalSections: CanonicalSectionDefinition[],
  prefix: string,
): ReportSectionDefinition[] {
  return canonicalSections.map((section, index) => {
    // ~6 chars a word, ×1.5 for the tables and directives that are not narrative
    // and so are not charged against `maxWordCount`.
    const maxContentLength = Math.round(section.maxWordCount * 9);
    // The floor is derived from the same number as the ceiling and then held
    // below half of it. Independently clamped floors and ceilings is how the
    // old pair ended up with a 600-char floor on a 60-word cover page — a
    // section penalised for being short at the length it was asked to be.
    const minContentLength = Math.min(
      Math.round(maxContentLength * 0.5),
      Math.max(300, section.maxWordCount * 2),
    );
    return {
      id: `${prefix}${index}`,
      name: section.name,
      sections: [section.name],
      // Deliberately above what `maxContentLength` allows: ~9 chars a word is
      // ~2.25 tokens a word, so ×3 leaves the model room to finish its last
      // sentence rather than being cut mid-thought at the token limit.
      // Truncation is a defect on a client's page (`INVESTMENT.md`); a long
      // section is not — the ceiling is enforced by the prompt, by
      // `maxContentLength` and finally by the post-processor, never here.
      maxTokens: Math.min(4000, Math.max(900, Math.round(section.maxWordCount * 3))),
      minContentLength,
      maxContentLength,
      requiredKeywords: section.sourceHeadings.slice(0, 3).map((heading) => heading.split(/\s+/)[0]?.toLowerCase()).filter(Boolean),
    };
  });
}

function getCanonicalSectionsForTier(tier: 'compass-40' | 'financial-analysis'): ReportSectionDefinition[] {
  return tier === 'financial-analysis'
    ? canonicalSectionsToGenerationSections(financialSections(), 'financialSection')
    : canonicalSectionsToGenerationSections(compassSections(), 'compassSection');
}

function buildCanonicalTemplateContext(tier: 'compass-40' | 'financial-analysis'): string {
  const sections = tier === 'financial-analysis' ? financialSections() : compassSections();
  const title = tier === 'financial-analysis'
    ? 'Financial Analysis Report Structure'
    : 'Investment Location & Property Fit Report Structure (≈38 pages)';

  const compassStyleRules = tier === 'compass-40' ? [
    '',
    '## MANDATORY WRITING STYLE — data first, no commentary blocks',
    'Every section follows the same three steps, repeated as many times as it has findings:',
    '1. **State the finding** in the sentence that introduces the data — one sentence, specific, with the number in it.',
    '2. **Show the data** — a figure, a table, or a short list.',
    '3. **Move on** to the next finding.',
    '',
    'A paragraph that follows a table or a figure and restates it is the single',
    'thing this report must not contain. If a sentence would begin "this means",',
    '"in other words", "for an investor this suggests" or similar, delete it: the',
    'finding belongs in the sentence that introduced the data, not underneath it.',
    '',
    '## FORBIDDEN LABELS — these must not appear anywhere, in any form',
    `- Never write ${EDITORIAL_LABELS.map((l) => `"${l}"`).join(', ')}.`,
    '- That applies to all three forms: as a heading (`### NPC view`), as a bold',
    '  lead-in (`**What This Means**`), and as a bare line above a paragraph.',
    '- There is no permitted number of these. Not one per section, not one per report.',
    '- Advisory judgement belongs in exactly two places: the Executive Verdict and the',
    '  Final Recommendation. In both it is written as continuous prose with no label.',
    '',
    '## HARD EXCLUSIONS (Compass / Location & Property Fit Report)',
    '- DO NOT include purchase price, deposit, stamp duty, LMI, LVR, weekly rent, gross/net yield, loan amount, interest rate, monthly/annual repayments, cashflow, sensitivity, 10-year projections, capital growth %, equity-after-X-years, depreciation, negative gearing, land tax. ALL financial modelling lives in the separate Financial Analysis Report.',
    '- DO NOT include a dashboard / KPI row of financial figures in the Executive Verdict or anywhere else.',
    '- DO NOT emit `[citation]`, `[source needed]`, `[TBD]` or any placeholder. Either name the real source inline, or omit the claim and let the Source Appendix carry it.',
    '- DO NOT repeat education, transport or employment content across sections. Each is rendered ONCE, in the section that owns it.',
    '- DO NOT include transition paragraphs ("As we move into…", "Building on the above…", "This flows naturally…"). Start the next finding.',
    '',
    '## LENGTH AND STRUCTURE',
    '- Respect the per-section word ceiling given above. It is a ceiling, not a target to reach: a section that says what it has to say in half of it is finished.',
    '- At most 4 `###` sub-headings in a section. A sub-heading carries a group of findings, not a single paragraph.',
    '- At most 2 visualisations per section, each showing data that is not also in a table on the same page.',
    '',
    '## CONSISTENCY CHECKS',
    '- Bed / bath / car / land size stated in the Property & Locality Snapshot MUST match every later reference (Property Fit, Risk Dashboard, Final Recommendation).',
    '- Property type (house / townhouse / unit) MUST be identical everywhere it is mentioned.',
    '',
    '## RECOMMENDATION FORMAT',
    'The Final Recommendation opens with one of three labels on its own line — **Proceed**, **Proceed with caution**, or **Not suitable** — then 150–250 words of continuous unlabelled rationale tied to location, tenant demand and risk, then the immediate actions as a short list. No financial verdict.',
    '',
  ].join('\n') : '';

  return [
    `# ${title}`,
    '',
    ...sections.flatMap((section) => [
      `## ${section.name}`,
      `- Page budget: ${section.pageBudget}`,
      `- Purpose: ${section.purpose}`,
      `- Narrative word ceiling: ${section.maxWordCount} (a ceiling, not a target)`,
      section.visualComponents.length ? `- Required visual/data components: ${section.visualComponents.join(', ')}` : '- Required visual/data components: narrative only',
      '',
    ]),
    compassStyleRules,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Compass-40 content sanitizer
//
// Compass-40 is the "Location & Property Fit" report. Even with the prompt
// overlay + canonical section list, Perplexity occasionally leaks financial
// KPI rows ("Purchase Price | $681,000"), KPI dashboard tiles, citation
// placeholders ("[1][2]") and stops mid-sentence when it hits max_tokens.
// This sanitizer scrubs the leaks and trims trailing partial sentences so
// the rendered PDF never shows a half-finished paragraph.
// ─────────────────────────────────────────────────────────────────────────────
const COMPASS40_FORBIDDEN_LINE_PATTERNS: RegExp[] = [
  /^[\s>*\-]*\**\s*(Estimated\s+)?Purchase\s+Price\b/i,
  /^[\s>*\-]*\**\s*(Estimated\s+)?Weekly\s+Rent\b/i,
  /^[\s>*\-]*\**\s*Loan[-\s]?to[-\s]?Value\b/i,
  /^[\s>*\-]*\**\s*LVR\b/i,
  /^[\s>*\-]*\**\s*(Gross|Net)\s+(Rental\s+)?Yield\b/i,
  /^[\s>*\-]*\**\s*Annual\s+Rental\s+Income\b/i,
  /^[\s>*\-]*\**\s*Loan\s+Amount\b/i,
  /^[\s>*\-]*\**\s*Interest\s+Rate\b/i,
  /^[\s>*\-]*\**\s*Capital\s+Growth\b/i,
  /^[\s>*\-]*\**\s*Deposit\s+Required\b/i,
  /^[\s>*\-]*\**\s*Stamp\s+Duty\b/i,
  /^[\s>*\-]*\**\s*Monthly\s+Repayment\b/i,
  /^[\s>*\-]*\**\s*Cashflow\b/i,
  /^[\s>*\-]*\**\s*Negative(ly)?\s+Geared\b/i,
  /^[\s>*\-]*\**\s*Investment\s+Grade\b/i,
  /^[\s>*\-]*\**\s*Total\s+Investment\s+Score\b/i,
  /^[\s>*\-]*\**\s*(Growth|Location|Yield|Demand|Risk)\s+Score\b/i,
];

// Table rows / KPI cells we should drop wholesale. Also used to detect entire
// financial tables (any matching cell taints the whole table block).
const COMPASS40_FORBIDDEN_CELL_PATTERNS: RegExp[] = [
  /\|\s*\$\d[\d,]*\s*\|/,
  /\|\s*[Ll][Vv][Rr]\s*\|/,
  /\|\s*(Gross|Net)\s+Yield\s*\|/i,
  /\|\s*Weekly\s+Rent\s*\|/i,
  /\|\s*(Estimated\s+)?Purchase\s+Price\s*\|/i,
  /\|\s*Loan\s+Amount\s*\|/i,
  /\|\s*Interest\s+Rate\s*\|/i,
  /\|\s*Stamp\s+Duty\s*\|/i,
  /\|\s*Score\s*\(?\/?\s*100/i,
  /\|\s*Weight\s*\|/i,
  /\|\s*(Total\s+)?Investment\s+Score\s*\|/i,
  /\|\s*Investment\s+Grade\s*\|/i,
  /\|\s*Recommendation\s*\|/i,
  /\|\s*HOLD\b/i,
  /\|\s*Capital\s+Growth\b/i,
  /\|\s*(Growth|Location|Yield|Demand|Risk)\s+Score\s*\|/i,
  /\|\s*Contribution\s+to\s+Total\s*\|/i,
];

// Whole sections (H2/H3) that must be dropped under Compass-40.
const COMPASS40_FORBIDDEN_HEADINGS: RegExp[] = [
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Investment\s+Highlights\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Key\s+Findings\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Headline\s+Scores?\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Overall\s+Investment\s+Profile\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Overall\s+Investment\s+Position\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Investment\s+Score\s+Analysis\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Macro\s+Investment\s+Scorecard\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Property\s+Snapshot\s*[-–—]?\s*Non[-\s]?Financial\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Property\s+Snapshot\s*$/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Category\s+Breakdown\b/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?(Growth|Location|Yield|Demand|Risk)\s+Score\b/i,
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?Investment\s+Recommendation\s*$/i,
  // The commentary labels, when the model reaches for a heading. This catches
  // them per-section during generation; `compassPostProcessor.stripEditorialBlocks`
  // catches the bold and bare-line forms across the whole document afterwards.
  /^#{1,4}\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:What\s+This\s+Means(?:\s+for\s+You)?|Why\s+This\s+Matters(?:\s+for\s+Investors)?|What\s+to\s+Watch|Key\s+Takeaways?|NPC\s+(?:View|Take)|Our\s+View)\b/i,
];

// Sentences containing these are dropped (financial leaks in prose).
const COMPASS40_FORBIDDEN_SENTENCE_REGEX =
  /\b(LVR|loan-to-value|gross\s+(rental\s+)?yield|net\s+(rental\s+)?yield|rental\s+yield|cash\s*flow|cashflow|negatively?\s+geared|negative\s+gearing|stamp\s+duty|interest\s+rate|monthly\s+repayment|annual\s+repayment|purchase\s+price|deposit\s+required|loan\s+amount|weekly\s+rent|annual\s+rent|investment\s+grade|hold\s+recommendation|out[-\s]?of[-\s]?pocket|capital\s+growth\s*:|sensitivity\s+analysis|negative\s+cashflow|tipping\s+in\s+cash)\b/i;

// Bullet/line-level leak (no period required) — drops short bullets that pair a
// finance keyword with a $ amount or % figure (e.g. "Gross rental yield: 3.74%").
const COMPASS40_FORBIDDEN_BULLET_REGEX =
  /\b(yield|rent|LVR|loan|deposit|stamp\s+duty|purchase\s+price|cashflow|cash\s+flow|interest\s+rate|capital\s+growth|repayment|land\s+tax|annual\s+(rental\s+)?income|annual\s+costs?|negatively?\s+geared|investment\s+grade|total\s+investment\s+score)\b[^.\n]{0,80}(\$[\d,]+|\d+(\.\d+)?\s*%)/i;

// Adjacent word/phrase duplications that the model occasionally produces in headings
// (e.g. "Industry 4 Industry & Employment Structure", "Amenity Amenity & Livability",
//  "SEIFA IFA & Socio-Economic", "Key Strengths Key Strengths & Watch Points").
export function dedupeRepeatedWords(s: string): string {
  if (!s) return s;
  let out = s;
  // "Word N Word" -> "Word"
  out = out.replace(/\b(\w+)\s+\d+\s+\1\b/gi, '$1');
  // "Phrase N Phrase" (1-3 word phrase with intervening digit)
  out = out.replace(/\b((?:\w+\s+){1,3}\w+)\s+\d+\s+\1\b/gi, '$1');
  // "Word Word" -> "Word" / "Phrase Phrase" -> "Phrase"
  for (let i = 0; i < 2; i++) {
    out = out.replace(/\b((?:\w+\s+){0,3}\w+)\s+\1\b/gi, '$1');
  }
  // ", Competition , Competition" -> ", Competition"
  out = out.replace(/(\b\w+\b)\s*,\s*\1\b/gi, '$1');
  // "SEIFA IFA" -> "SEIFA" (second word is a >=3 char suffix of the first)
  out = out.replace(/\b(\w*?)(\w{3,})\s+\2\b/gi, '$1$2');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function sanitizeCompass40Content(raw: string): string {
  if (!raw) return raw;
  const rawLines = raw.split('\n');

  // ---- Pass 1: collect line metadata, group table blocks ----
  type Block = { kind: 'line' | 'table'; lines: string[]; startIdx: number };
  const blocks: Block[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const t = rawLines[i].trim();
    if (t.startsWith('|')) {
      const tbl: string[] = [];
      const startIdx = i;
      while (i < rawLines.length && rawLines[i].trim().startsWith('|')) {
        tbl.push(rawLines[i]);
        i++;
      }
      blocks.push({ kind: 'table', lines: tbl, startIdx });
    } else {
      blocks.push({ kind: 'line', lines: [rawLines[i]], startIdx: i });
      i++;
    }
  }

  // ---- Pass 2: filter blocks ----
  const kept: string[] = [];
  let inForbiddenSection = false;
  const seenH2Topics = new Set<string>();
  const topicOf = (heading: string): string | null => {
    const h = heading.toLowerCase();
    if (/\b(transport|connectivity|commute|rail|road network)\b/.test(h)) return 'transport';
    if (/\bpopulation\s+(growth|trends)\b/.test(h)) return 'population';
    if (/\beducation\b/.test(h) && /\bfamily\b/.test(h)) return 'education-family';
    return null;
  };

  for (const blk of blocks) {
    if (blk.kind === 'table') {
      // Drop the entire table if ANY row matches a forbidden cell/header.
      const tainted = blk.lines.some(
        (ln) =>
          COMPASS40_FORBIDDEN_CELL_PATTERNS.some((p) => p.test(ln)) ||
          COMPASS40_FORBIDDEN_LINE_PATTERNS.some((p) => p.test(ln.replace(/^\|\s*/, '')))
      );
      if (tainted || inForbiddenSection) continue;

      // SEIFA validation: drop table if (a) all deciles identical (templated),
      // (b) any row's text label contradicts its decile direction, or
      // (c) the table is self-flagged as "Illustrative" / "Scenario".
      const isSeifa = blk.lines.some((ln) => /\b(SEIFA|IRSAD|IRSD|IEO|IER)\b/i.test(ln));
      if (isSeifa) {
        const deciles = blk.lines
          .map((ln) => ln.match(/\|\s*(\d{1,2})\s*\/\s*10\s*\|/))
          .filter(Boolean)
          .map((m) => parseInt(m![1], 10));
        if (deciles.length >= 3 && new Set(deciles).size === 1) continue;
        const contradicts = blk.lines.some((ln) => {
          const m = ln.match(/\|\s*(\d{1,2})\s*\/\s*10\s*\|.*\|\s*([^|]+?)\s*\|?\s*$/);
          if (!m) return false;
          const dec = parseInt(m[1], 10);
          const label = m[2].toLowerCase();
          if (dec >= 7 && /\bdisadvantag/.test(label) && !/low|moderate\s+to\s+low/.test(label)) return true;
          if (dec <= 3 && /\badvantag/.test(label) && !/dis/.test(label)) return true;
          return false;
        });
        if (contradicts) continue;
      }
      kept.push(...blk.lines);
      continue;
    }

    const line = blk.lines[0];
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      if (COMPASS40_FORBIDDEN_HEADINGS.some((p) => p.test(trimmed))) {
        inForbiddenSection = true;
        continue;
      }
      // Topic-collision dedup for H2 headings (transport, population, ...).
      const level = headingMatch[1].length;
      const cleanHeading = dedupeRepeatedWords(headingMatch[2]);
      const topic = level <= 2 ? topicOf(cleanHeading) : null;
      if (topic && seenH2Topics.has(topic)) {
        inForbiddenSection = true;
        continue;
      }
      if (topic) seenH2Topics.add(topic);
      inForbiddenSection = false;
      kept.push(`${headingMatch[1]} ${cleanHeading}`);
      continue;
    }
    if (inForbiddenSection) continue;

    // Line-start forbidden patterns (e.g. "Estimated Purchase Price ...").
    if (COMPASS40_FORBIDDEN_LINE_PATTERNS.some((p) => p.test(line))) continue;

    // Bullet-level financial leak ($X or N% paired with finance keyword).
    if (COMPASS40_FORBIDDEN_BULLET_REGEX.test(line)) continue;

    // Sentence-level financial leak scrub for prose lines.
    if (line && /[.!?]/.test(line)) {
      const sentences = line.split(/(?<=[.!?])\s+/);
      const scrubbed = sentences.filter((s) => !COMPASS40_FORBIDDEN_SENTENCE_REGEX.test(s));
      if (scrubbed.length === 0) continue;
      kept.push(scrubbed.join(' '));
      continue;
    }

    kept.push(line);
  }

  let out = kept.join('\n');

  // Strip Perplexity-style inline citation markers like [1], [2], [1][3]
  out = out.replace(/\[\d+\](?:\[\d+\])*/g, '');

  // Strip placeholder tokens
  out = out.replace(/\[(citation(?:\s+needed)?|source(?:\s+needed)?|TBD|placeholder)\]/gi, '');
  out = out.replace(/\((citation(?:\s+needed)?|source(?:\s+needed)?|TBD|placeholder)\)/gi, '');

  // Strip leaked binding labels left in prose (e.g. "Interest Rate: 6.5%",
  // "Capital Growth: 5% per annum") — these come from the override-injection.
  out = out.replace(/\b(Interest Rate|Capital Growth(?:\s+Rate)?|LVR|Loan[-\s]?to[-\s]?Value(?:\s+Ratio)?|Purchase Price|Weekly Rent|Loan Amount|Stamp Duty|Deposit|CPI Growth Rate)\s*:\s*\$?[\d.,]+\s*%?\s*(?:per\s+annum|p\.?\s*a\.?)?\s*\)?/gi, '');
  // Drop stray placeholder strings the model never resolved (e.g. "Medical Centre Name").
  out = out.replace(/\b(Medical Centre|School|Suburb|Hospital|Park|Station|Shopping Centre)\s+Name\b/gi, '');

  // Drop orphaned "What This Means" labels with no body before next heading.
  out = out.replace(
    /(^|\n)(?:>\s*)?\**\s*(?:#{1,4}\s*)?(?:WHAT\s+THIS\s+MEANS|What\s+This\s+Means)\s*:?\s*\**\s*(?:[-–—]{1,3})?\s*(?=\n\s*(?:#{1,4}\s|$))/g,
    '$1'
  );

  // Trim trailing partial sentence (when model hit max_tokens mid-thought).
  out = trimDanglingSentence(out);

  // Collapse 3+ blank lines that result from dropped rows.
  out = out.replace(/\n{3,}/g, '\n\n').trimEnd();

  // Drop self-flagged "Illustrative" / "Scenario" disclaimers that follow
  // SEIFA or other data tables (these admit the numbers are fabricated).
  out = out.replace(/\([^)]*\b(Illustrative|Consistent\s+Scenario|Indicative\s+Scenario|Hypothetical)\b[^)]*\)/gi, '');

  // Cross-section dedup: drop a markdown table if an identical row signature
  // appeared earlier in the same content blob (e.g. "Family demand strength
  // vs trade-offs" table rendered twice).
  const seenTableSig = new Set<string>();
  out = out.split(/\n\n+/).filter((para) => {
    if (!/^\s*\|/.test(para)) return true;
    const sig = para
      .split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s\-:|]+\|\s*$/.test(l))
      .map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase())
      .slice(0, 4)
      .join('||');
    if (!sig) return true;
    if (seenTableSig.has(sig)) return false;
    seenTableSig.add(sig);
    return true;
  }).join('\n\n');

  return out;
}

function trimDanglingSentence(text: string): string {
  if (!text) return text;
  if (/[.!?")\]}]\s*$/.test(text)) return text;
  const lastTerminator = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('! '),
    text.lastIndexOf('? '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('?\n'),
  );
  if (lastTerminator > text.length - 800 && lastTerminator > 200) {
    return text.slice(0, lastTerminator + 1).trimEnd();
  }
  return text;
}

// Dynamic sections - populated from database template at runtime
let REPORT_SECTIONS: ReportSectionDefinition[] = [...DEFAULT_REPORT_SECTIONS];

// ============================================================================
// CAPITAL GROWTH EXTRACTION - Extract researched capital growth from AI content
// ============================================================================
// Perplexity is instructed to research capital growth when not provided.
// This function extracts that researched value from the generated content.
// ============================================================================

/**
 * Extracts capital growth rate from AI-generated report content
 * Looks for patterns like "5.2% capital growth", "capital appreciation of 4.5%", etc.
 * Returns null if no valid rate is found
 */
function extractCapitalGrowthFromContent(content: string): number | null {
  if (!content) return null;
  
  // Pattern priority order - most specific first
  const patterns = [
    // "capital growth rate of X%", "capital growth of X%"
    /capital\s+growth\s+(?:rate\s+)?(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    // "X% capital growth", "X% annual capital growth"
    /(\d+(?:\.\d+)?)\s*%\s*(?:annual\s+)?capital\s+growth/gi,
    // "annual appreciation of X%", "property appreciation of X%"
    /(?:annual|property)\s+appreciation\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    // "X% annual appreciation"
    /(\d+(?:\.\d+)?)\s*%\s*annual\s+(?:property\s+)?appreciation/gi,
    // "median price growth of X%", "historical growth of X%"
    /(?:median\s+price|historical)\s+growth\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    // "X-X% annual growth" - take the average
    /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*%\s*(?:annual\s+)?(?:capital\s+)?growth/gi,
  ];
  
  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      // Handle range patterns (e.g., "4-6%")
      if (match[2] !== undefined) {
        const low = parseFloat(match[1]);
        const high = parseFloat(match[2]);
        if (!isNaN(low) && !isNaN(high) && low >= 0 && low <= 20 && high >= 0 && high <= 20) {
          const avg = (low + high) / 2;
          console.log(`📊 Extracted capital growth range: ${low}%-${high}%, using average: ${avg}%`);
          return avg;
        }
      } else {
        const rate = parseFloat(match[1]);
        // Validate: capital growth should typically be between 0% and 15%
        if (!isNaN(rate) && rate >= 0 && rate <= 15) {
          console.log(`📊 Extracted capital growth rate: ${rate}%`);
          return rate;
        }
      }
    }
  }
  
  console.log('⚠️ Could not extract capital growth rate from content');
  return null;
}

// ============================================================================
// DYNAMIC TEMPLATE PARSING
// ============================================================================
// Extracts H2 section headings from database template and groups them
// into generation sections while preserving the template's order
// ============================================================================

interface ParsedTemplateStructure {
  headings: string[];
  sections: ReportSectionDefinition[];
  templateName: string;
  templateId: string;
}

/**
 * Parses the template content to extract H2 headings and create section definitions
 * Falls back to DEFAULT_REPORT_SECTIONS if parsing fails
 */
function parseTemplateStructure(
  templateContent: string,
  templateName: string = 'Unknown',
  templateId: string = ''
): ParsedTemplateStructure {
  try {
    // Extract all H2 headings (## Heading)
    const h2Pattern = /^## ([^\n]+)/gm;
    const headings: string[] = [];
    let match;
    
    while ((match = h2Pattern.exec(templateContent)) !== null) {
      const heading = match[1].trim();
      // Skip empty or very short headings
      if (heading.length > 2) {
        headings.push(heading);
      }
    }
    
    console.log(`📋 Parsed ${headings.length} H2 headings from template "${templateName}"`);
    
    if (headings.length < 5) {
      console.log('⚠️ Too few headings found, using default sections');
      return {
        headings: [],
        sections: DEFAULT_REPORT_SECTIONS,
        templateName,
        templateId
      };
    }
    
    // Group headings into logical sections based on keywords and order
    const sections = groupHeadingsIntoSections(headings);
    
    console.log(`✓ Created ${sections.length} generation sections from template`);
    sections.forEach((s, i) => {
      console.log(`  Section ${i}: ${s.name} → [${s.sections.join(', ')}]`);
    });
    
    return {
      headings,
      sections,
      templateName,
      templateId
    };
  } catch (error) {
    console.error('⚠️ Template parsing error:', error);
    return {
      headings: [],
      sections: DEFAULT_REPORT_SECTIONS,
      templateName,
      templateId
    };
  }
}

/**
 * Groups extracted headings into logical generation sections
 * Maintains order from template while grouping related topics
 */
function groupHeadingsIntoSections(headings: string[]): ReportSectionDefinition[] {
  // Keyword mapping for section grouping
  const sectionKeywordMap: Record<string, { keywords: string[], name: string, requiredKeywords: string[], maxTokens: number, minContentLength: number }> = {
    'executive': {
      keywords: ['executive', 'summary', 'overview report'],
      name: 'Executive Summary',
      requiredKeywords: ['investment', 'property', 'recommendation', 'score'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'location': {
      keywords: ['location', 'suburb character'],
      name: 'Location Overview',
      requiredKeywords: ['suburb', 'community', 'lifestyle'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'market': {
      keywords: ['market', 'economic', 'economy'],
      name: 'Market & Economics',
      requiredKeywords: ['market', 'cash rate', 'growth'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'demographics': {
      keywords: ['demographic', 'demand', 'population'],
      name: 'Demographics & Demand',
      requiredKeywords: ['population', 'income', 'employment'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'education': {
      keywords: ['school', 'education', 'healthcare', 'hospital', 'shopping'],
      name: 'Education & Healthcare',
      requiredKeywords: ['school', 'education', 'healthcare'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'recreation': {
      keywords: ['recreation', 'transport', 'accessibility', 'amenities', 'commute'],
      name: 'Recreation & Transport',
      requiredKeywords: ['recreation', 'transport', 'commute'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'environment': {
      keywords: ['environment', 'climate', 'crime', 'safety', 'flood', 'bushfire', 'risk'],
      name: 'Environment & Safety',
      requiredKeywords: ['flood', 'crime', 'safety'],
      maxTokens: 4000,
      minContentLength: 3500
    },
    'property': {
      // Updated: Property section now includes Strategic Assessment, Opportunities, and Risks subsections
      keywords: ['property-level', 'property level', 'zoning', 'land size', 'building', 'strategic assessment', 'capital appreciation', 'leveraged equity', 'employment growth', 'cashflow deficit', 'interest rate sensitivity', 'environmental risk'],
      name: 'Property & Zoning',
      requiredKeywords: ['property', 'zoning', 'strategic', 'opportunity', 'risk'],
      maxTokens: 5000,
      minContentLength: 4500
    },
    'costs': {
      keywords: ['purchase', 'ongoing costs', 'rental', 'yield', 'stamp duty'],
      name: 'Costs & Rental',
      requiredKeywords: ['purchase', 'rent', 'yield'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'loan': {
      keywords: ['loan', 'repayment', 'sensitivity', 'cashflow', 'mortgage'],
      name: 'Loan & Sensitivity',
      requiredKeywords: ['loan', 'repayment', 'cashflow'],
      maxTokens: 2500,
      minContentLength: 2500
    },
    'projections': {
      // Removed: Top 3 Opportunities (now under Property section)
      keywords: ['projection', 'swot', 'investment score', '10-year', 'ten year'],
      name: 'Projections & SWOT',
      requiredKeywords: ['projection', 'swot'],
      maxTokens: 3000,
      minContentLength: 3000
    },
    'recommendations': {
      // Removed: Top 3 Risks (now under Property section)
      keywords: ['recommendation', 'conclusion', 'final', 'suitability'],
      name: 'Risks & Recommendations',
      requiredKeywords: ['recommendation', 'conclusion'],
      maxTokens: 4000,
      minContentLength: 3000
    }
  };
  
  // Group headings by matching keywords
  const groups: Record<string, string[]> = {};
  const usedHeadings = new Set<string>();
  
  // First pass: assign headings to groups based on keyword matches
  for (const heading of headings) {
    const headingLower = heading.toLowerCase();
    
    for (const [groupKey, config] of Object.entries(sectionKeywordMap)) {
      if (config.keywords.some(kw => headingLower.includes(kw))) {
        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(heading);
        usedHeadings.add(heading);
        break; // Assign to first matching group
      }
    }
  }
  
  // Second pass: assign unmatched headings to nearest logical group
  for (const heading of headings) {
    if (!usedHeadings.has(heading)) {
      // Default unmatched headings to 'recommendations' section
      if (!groups['recommendations']) {
        groups['recommendations'] = [];
      }
      groups['recommendations'].push(heading);
      console.log(`  Unmatched heading "${heading}" → recommendations`);
    }
  }
  
  // Build final section definitions in correct order
  const orderedKeys = ['executive', 'location', 'market', 'demographics', 'education', 'recreation', 'environment', 'property', 'costs', 'loan', 'projections', 'recommendations'];
  const sections: ReportSectionDefinition[] = [];
  
  for (let i = 0; i < orderedKeys.length; i++) {
    const key = orderedKeys[i];
    const config = sectionKeywordMap[key];
    const groupHeadings = groups[key] || [];
    
    // Only include section if it has headings OR use fallback from defaults
    if (groupHeadings.length > 0) {
      sections.push({
        id: `section${i}`,
        name: config.name,
        sections: groupHeadings,
        maxTokens: config.maxTokens,
        minContentLength: config.minContentLength,
        requiredKeywords: config.requiredKeywords
      });
    } else {
      // Use fallback from defaults if no headings matched
      const defaultSection = DEFAULT_REPORT_SECTIONS.find(s => s.id === `section${i}`);
      if (defaultSection) {
        sections.push(defaultSection);
      }
    }
  }
  
  return sections;
}

// Section validation helper — is this section the right size and shape?
//
// This is the only gate that runs inside the generation loop, and until v3.0
// every rule in it pushed one way: too short scored a penalty, fewer than three
// headings scored a penalty, and NOTHING had an upper bound. A model asked to
// clear a floor with no ceiling clears it by a wide margin, which is how a
// report with a 9,170-word budget came to run at ~21,000. The bounds below are
// symmetric now.
function validateSectionContent(
  sectionDef: typeof REPORT_SECTIONS[0],
  content: string
): { isValid: boolean; issues: string[]; score: number } {
  const issues: string[] = [];
  let score = 100;

  // Check minimum content length
  const contentLength = content?.length || 0;
  if (contentLength < sectionDef.minContentLength) {
    issues.push(`Content too short: ${contentLength} chars (min: ${sectionDef.minContentLength})`);
    score -= 30;
  }

  // And the ceiling, which is the half that was missing. `maxContentLength` is
  // derived from the section's own word cap, so this cannot drift from it.
  const maxContentLength = sectionDef.maxContentLength ?? 0;
  if (maxContentLength > 0 && contentLength > maxContentLength) {
    issues.push(`Content too long: ${contentLength} chars (max: ${maxContentLength})`);
    score -= 20;
  }

  // Check for required keywords (case-insensitive)
  const contentLower = (content || '').toLowerCase();
  const missingKeywords = (sectionDef.requiredKeywords || []).filter(
    kw => !contentLower.includes(kw.toLowerCase())
  );

  if (missingKeywords.length > 0) {
    issues.push(`Missing content areas: ${missingKeywords.join(', ')}`);
    score -= missingKeywords.length * 10;
  }

  // Check for structural elements (headings, tables). One heading is structure;
  // three was a floor the model met by inventing sub-headings, and 68 `###` a
  // report was the structural half of the noise this change removes.
  const headingCount = (content?.match(/^#{1,3}\s+/gm) || []).length;
  if (headingCount < 1) {
    issues.push(`Insufficient structure: only ${headingCount} headings found`);
    score -= 15;
  } else if (headingCount > MAX_SECTION_HEADINGS) {
    issues.push(`Over-structured: ${headingCount} headings (max ${MAX_SECTION_HEADINGS})`);
    score -= 10;
  }

  // Commentary labels. The post-processor strips these before the report is
  // stored; flagging here means a section that produces them is visible in the
  // generation log rather than only in the diff between raw and stored content.
  const editorialHits = (content || '')
    .split('\n')
    .filter((line) => EDITORIAL_LABEL_PROBE.test(line)).length;
  if (editorialHits > 0) {
    issues.push(`Contains ${editorialHits} editorial commentary label(s); they will be stripped`);
    score -= 10;
  }
  
  // Check for data presentation (tables with |)
  const hasDataTables = content?.includes('|') && content?.includes('---');
  if (!hasDataTables && sectionDef.id !== 'section4') {
    issues.push('No data tables found');
    score -= 10;
  }
  
  return {
    isValid: score >= 60, // Threshold for acceptable content
    issues,
    score: Math.max(0, score)
  };
}

// ============================================================================
// ROBUSTNESS INFRASTRUCTURE - Circuit Breaker, Retry with Jitter, Timeouts
// ============================================================================

// Circuit breaker state for tracking failed services
const circuitBreaker = new Map<string, { failures: number; lastFailure: number; isOpen: boolean }>();
const CIRCUIT_BREAKER_THRESHOLD = 2; // Open after 2 failures
const CIRCUIT_BREAKER_RESET_MS = 30000; // Reset after 30 seconds

function isCircuitOpen(serviceName: string): boolean {
  const state = circuitBreaker.get(serviceName);
  if (!state) return false;
  
  // Check if circuit should reset
  if (state.isOpen && Date.now() - state.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
    state.isOpen = false;
    state.failures = 0;
    return false;
  }
  
  return state.isOpen;
}

function recordServiceFailure(serviceName: string): void {
  const state = circuitBreaker.get(serviceName) || { failures: 0, lastFailure: 0, isOpen: false };
  state.failures++;
  state.lastFailure = Date.now();
  
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.isOpen = true;
    console.log(`🔴 Circuit breaker OPEN for ${serviceName} after ${state.failures} failures`);
  }
  
  circuitBreaker.set(serviceName, state);
}

function recordServiceSuccess(serviceName: string): void {
  circuitBreaker.delete(serviceName);
}

// Helper function to add jitter to prevent thundering herd
function getRetryDelayWithJitter(attempt: number, baseDelayMs: number = 2000): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 1000; // 0-1000ms random jitter
  return Math.min(exponentialDelay + jitter, 15000); // Cap at 15 seconds
}

// Helper function to fetch with timeout and circuit breaker
async function fetchWithTimeout(
  url: string, 
  options: RequestInit, 
  timeoutMs: number = 90000,
  serviceName?: string
): Promise<Response> {
  // Check circuit breaker
  if (serviceName && isCircuitOpen(serviceName)) {
    throw new Error(`Circuit breaker open for ${serviceName}, skipping request`);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`⏱️ Request timeout after ${timeoutMs}ms, aborting...`);
    controller.abort();
  }, timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (serviceName && response.ok) {
      recordServiceSuccess(serviceName);
    }
    
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (serviceName) {
      recordServiceFailure(serviceName);
    }
    
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  }
}

// Wrapper for parallel API calls with graceful degradation
interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  serviceName: string;
}

async function fetchServiceWithFallback<T>(
  serviceName: string,
  fetchFn: () => Promise<T | null>,
  fallbackValue: T | null = null
): Promise<ServiceResult<T>> {
  if (isCircuitOpen(serviceName)) {
    console.log(`⏭️ Skipping ${serviceName} (circuit breaker open)`);
    return { success: false, error: 'Circuit breaker open', serviceName, data: fallbackValue || undefined };
  }
  
  try {
    const startTime = Date.now();
    const result = await fetchFn();
    const duration = Date.now() - startTime;
    
    if (result) {
      console.log(`✓ ${serviceName} completed in ${duration}ms`);
      recordServiceSuccess(serviceName);
      return { success: true, data: result, serviceName };
    } else {
      console.log(`⚠️ ${serviceName} returned no data (${duration}ms)`);
      return { success: false, error: 'No data returned', serviceName, data: fallbackValue || undefined };
    }
  } catch (error: any) {
    console.log(`❌ ${serviceName} failed:`, error?.message || 'Unknown error');
    recordServiceFailure(serviceName);
    return { success: false, error: error?.message, serviceName, data: fallbackValue || undefined };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EDITORIAL PRIMITIVES — shortcodes the WeasyPrint renderer converts into
// pull-quotes, sidenotes, multi-column blocks, SVG visualisations, footnotes
// and cross-references. Inject this block into every generator prompt so the
// model knows the exact syntax. Keep terse — the model just needs the contract.
// ─────────────────────────────────────────────────────────────────────────────
const EDITORIAL_PRIMITIVES_BLOCK = `
**EDITORIAL PRIMITIVES (VISUAL-FIRST — USE THESE TO REPLACE DENSE PROSE)**

You may emit these block-level shortcodes inside the markdown. The renderer
converts them to print-quality typography and inline SVG. Visuals are not optional:
each chapter should carry one opener strip plus multiple in-flow visualisations.
Keep pull-quotes rare, but use data visuals wherever they replace a paragraph or
table. Each shortcode must sit on its own line(s), with a blank line before and after.

1. PULL QUOTE — for one striking sentence that summarises the chapter's thesis.
\`\`\`
::: pullquote
A weighted score of 78/100 places this property in the top quartile for combined yield and growth.
:::
\`\`\`

2. SIDENOTE — short aside that hangs in the right margin (≤25 words).
\`\`\`
::: sidenote
Council rezoning to MU3 was gazetted March 2026, lifting permissible density.
:::
\`\`\`

3. GAUGE — single-metric score visualisation (0–100 unless max specified).
   Format: \`{{gauge: VALUE[/MAX] | LABEL | CAPTION}}\`
\`\`\`
{{gauge: 78 | Investment Score | Weighted composite}}
\`\`\`

4. WATERFALL — cash-flow build-up. Use \`+\` / \`-\` for movements, \`=\` for totals.
   Numbers can include $ signs and commas; they will be parsed.
\`\`\`
{{waterfall: Gross Rent +28000, Interest -19500, Outgoings -4200, Tax shield +1100, Net =5400}}
\`\`\`

5. HEATMAP — m×n matrix; rows separated by \`/\`, cells by \`,\`.
   Format: \`{{heatmap: VALUES | rows=A,B,C | cols=X,Y,Z | title=…}}\`
\`\`\`
{{heatmap: 5.2,6.1,7.4 / 4.8,5.9,6.7 / 3.1,4.0,5.2 | rows=2024,2025,2026 | cols=Q1,Q2,Q3 | title=Suburb Growth %}}
\`\`\`

6. SCORE WHEEL — multi-dimensional radar (3+ scores).
   Format: \`{{wheel: s1,s2,s3,… | labels=L1,L2,L3,… | max=100 | title=…}}\`
\`\`\`
{{wheel: 78,64,82,71,55 | labels=Yield,Growth,Risk,Demand,Infra | title=Score Breakdown}}
\`\`\`

7. FOOTNOTES — for source citations or methodology notes. Use \`[^id]\` at the
   call-site and \`[^id]: text\` on its own line for the definition.
\`\`\`
The 5-year capital growth rate sits at 7.2%[^abs1].

[^abs1]: ABS Cat. 6416.0, residential property price indexes, March 2026.
\`\`\`

8. CROSS-REFERENCE — auto-resolves to the printed page number.
   Format: \`[[see:#chapter-anchor-id]]\` or \`[[see:#id|custom prefix]]\`
\`\`\`
For full risk methodology [[see:#ch-risk-analysis]].
\`\`\`

9. SECTION DIVIDER — full-bleed dark "chapter break" page with one oversized
   statistic. Use AT MOST ONCE per chapter, only when a single headline number
   genuinely anchors the section's argument (e.g. "78" for an investment score,
   "4.8%" for a yield, "$28k" for projected first-year cash flow).
   Format:
\`\`\`
::: divider stat="78" label="Composite investment score" eyebrow="Chapter 04 · Verdict"
Why this property earns a top-quartile rating.
:::
\`\`\`

10. QUOTE PAGE — full-bleed paper-toned page with a single editorial pull-quote
    on its own spread. Use AT MOST ONCE per report, reserved for the most
    important strategic line (e.g. our thesis on the suburb, RBA commentary).
    Format:
\`\`\`
::: quote-page attribution="RBA Statement on Monetary Policy, May 2026" eyebrow="Market context"
"Housing demand remains underpinned by population growth running well above the long-run average."
:::
\`\`\`

11. STAT BLOCK — inline oversized statistic that breaks up dense prose. Use for
    a key in-flow number that doesn't warrant a full divider page.
    Format: \`::: stat label="…" unit="%" sub="…"  \\n  4.8  \\n  :::\`
\`\`\`
::: stat label="Median rental yield" unit="%" sub="Suburb median, 12-mo trailing"
4.8
:::
\`\`\`

12. HORIZONTAL BARS — Tufte-style ranked comparator. Perfect for scorecards,
    suburb rankings, lender comparisons, expense breakdowns. Each row = label + value.
    Values can be raw numbers, percentages (e.g. \`70%\`), or money (\`$1.2M\`, \`450k\`).
    Format: \`{{bars: Label1 70, Label2 45%, Label3 $1.2M | title=… | max=100 | unit=%}}\`
\`\`\`
{{bars: Yield 7.4, Growth 8.1, Liquidity 5.2, Demand 8.6, Infrastructure 6.9 | title=Investment Pillars | max=10}}
\`\`\`

13. QUADRANT MATRIX — 2×2 scatter for trade-off framing (Risk×Return, Yield×Growth,
    Cost×Speed). Append \`*\` to a point to highlight (gold). Quadrant labels (q1..q4)
    label corners clockwise from top-right.
    Format: \`{{quadrant: x,y "label", x,y "label"* | xlabel=Yield | ylabel=Growth | xmax=10 | ymax=10 | q1=Sweet spot | q2=Capital play | q3=Avoid | q4=Income play | title=…}}\`
\`\`\`
{{quadrant: 7.4,8.1 "This property"*, 5.2,6.8 "Suburb median", 4.1,5.5 "Metro median" | xlabel=Yield % | ylabel=Growth % | xmax=10 | ymax=10 | q1=Sweet spot | q2=Capital play | q3=Avoid | q4=Income play | title=Yield vs Growth}}
\`\`\`

14. PICTOGRAPH — icon-array showing "K of N". Killer for tenure mix, demographics,
    ownership ratios. \`icon\` is \`person\`, \`house\` or \`dollar\`.
    Format: \`{{pictograph: FILLED/TOTAL | label=… | sub=… | icon=person | cols=10}}\`
\`\`\`
{{pictograph: 3/10 | label=Renter share | sub=3 in 10 dwellings are tenanted | icon=person | cols=10}}
\`\`\`

15. AT-A-GLANCE STRIP — 3-4 cell editorial strip that opens a chapter. Each cell:
    "<symbol> <text>". Symbols: ✓ strength, ⚠ watch, ▲ trend up, ▼ trend down, ◆ metric, ★ verdict.
    Use ONCE at the very top of each chapter (right after the H2) to compress the
    "TL;DR" so the reader doesn't have to wade through prose to find the verdict.
    Format: \`{{glance: ✓ Strong fundamentals | ⚠ Vacancy uptick | ◆ Yield 4.8% | ★ Buy with caveats}}\`
\`\`\`
{{glance: ✓ Top-quartile growth | ⚠ Body-corporate fees rising | ◆ Median $1.18M | ★ Hold 7-10y}}
\`\`\`

16. INLINE SPARKLINE — tiny chart that flows next to prose. Use inside a sentence
    to show a trend ("yields ~~[4.2,4.4,4.6,4.5,4.8]~~ now 4.8%"). 5-12 numbers ideal.
    Format: \`~~[v1,v2,v3,…]~~\`
\`\`\`
Median values have climbed steadily ~~[820,860,910,980,1050,1180]~~ over six years.
\`\`\`

17. DONUT / RING — composition chart for mixes (tenure, demographics, capital
    allocation, expense shares). Center number is the headline slice.
    Format: \`{{donut: SliceA value, SliceB value, … | title=… | center=58% | centerSub=Owner-occupied}}\`
\`\`\`
{{donut: Owner-occupied 58, Renter 32, Other 10 | title=Tenure mix | center=58% | centerSub=Owner-occupied}}
\`\`\`

18. SUBURB TILES — small-multiples grid that reads like a faux-choropleth. Use
    for "this suburb + 3-7 adjacent suburbs" comparisons. \`int=0..1\` shades the
    tile (higher = stronger). \`sub\` lives in quotes.
    Format: \`{{tiles: Label value sub="…" int=0.7, Label value sub="…" int=0.5 | title=… | cols=4}}\`
\`\`\`
{{tiles: Hawthorn $1.42M sub="↑ 6.4% YoY" int=0.85, Kew $1.61M sub="↑ 5.1% YoY" int=0.70, Camberwell $1.28M sub="↑ 4.8% YoY" int=0.60, Glen Iris $1.19M sub="↑ 3.2% YoY" int=0.45 | title=Adjacent suburbs · median house | cols=4}}
\`\`\`

19. MARGIN MICRO-CHART — editorial sidenote with a tiny sparkline. Use to flag
    a single supporting datum without breaking prose flow. Keep \`note\` to one line.
    Format: \`{{margin: Title | spark=v1,v2,v3,… | note=One-line context | label=Context}}\`
\`\`\`
{{margin: RBA cash-rate trajectory | spark=4.35,4.35,4.10,3.85,3.60,3.35 | note=Six-month decline supports the refinancing window in Q3. | label=Macro watch}}
\`\`\`

20. TIMELINE RIBBON — infrastructure / delivery pipeline. Use instead of a list
    of projects and timing windows.
    Format: \`{{timeline: Existing "Station access", 0-2y "Road upgrade", 3-5y "Hospital stage", 5y+ "Town centre renewal" | title=Infrastructure pipeline}}\`

21. BIG-NUMBER KPI STRIPS — when a sentence says "median grew from X to Y" or
    compares 3 headline metrics, use stat blocks / gauges / bars rather than prose.
    Use \`::: stat\` for a single in-flow number, \`{{bars}}\` for X vs suburb vs metro,
    and \`~~[…]~~\` beside any trend sentence.

VISUAL-FIRST RULES (CRITICAL):
- Every chapter MUST open with a \`{{glance: …}}\` strip immediately after the H2.
- **At most 2 visualisations per chapter**, drawn from the full library
  (gauge / bars / quadrant / pictograph / donut / tiles / heatmap / wheel /
  waterfall / margin / timeline / stat / inline sparkline), each showing data
  that is not also in a table on the same page. Prose INTRODUCES a visualisation
  and never restates it afterwards.
- Any "median grew from X to Y" / trend sentence MUST include either \`~~[…]~~\` inline or a \`::: stat\` callout nearby.
- Any "subject vs suburb vs metro/state" comparison MUST use \`{{bars: Subject X, Suburb Y, Metro Z | title=…}}\`.
- Investment Score, Affordability, Risk, Suitability, Confidence, and similar 0-100 ratings MUST use \`{{gauge: …}}\`.
- Any list of 3+ ranked metrics MUST be rendered as \`{{bars: …}}\` instead of a table.
- Any "X of Y households / dwellings / buyers" stat MUST use \`{{pictograph: …}}\`.
- Any composition / share-of-total (tenure mix, age bands, expense split, capital
  allocation) MUST use \`{{donut: …}}\` instead of a table.
- Any suburb × metric matrix MUST use \`{{heatmap: …}}\`.
- Any infrastructure/project pipeline MUST use \`{{timeline: …}}\`.
- Any "subject suburb vs N nearby suburbs" comparison MUST use \`{{tiles: …}}\`.
- Any trade-off between two dimensions (yield vs growth, risk vs return) MUST use
  \`{{quadrant: …}}\`. Highlight the subject property with a trailing \`*\`.
- Use \`{{margin: …}}\` to push secondary context off the main column instead of
  parenthetical asides — saves prose and adds visual rhythm.
- Use \`~~[…]~~\` inline sparklines liberally for any time-series mentioned in prose.
- All shortcodes must use REAL figures from the data provided. Never fabricate.
- If a visualisation would duplicate a table on the same page, choose the visualisation.
- Cross-references must point to a chapter heading that actually exists.
- Footnote definitions must appear in the same section as the call.
- Section dividers and quote pages BREAK THE PAGE — only use when a moment of
  pause genuinely serves the reader. Never two in a row.
`;

const textEncoder = new TextEncoder();
const PERPLEXITY_MESSAGE_HARD_LIMIT_BYTES = 100_000;
const PERPLEXITY_SAFE_USER_MESSAGE_BYTES = 70_000;
const PERPLEXITY_SAFE_SYSTEM_MESSAGE_BYTES = 35_000;
const DOCUMENT_CONTEXT_MAX_BYTES = 24_000;
const TEMPLATE_CONTEXT_MAX_BYTES = 12_000;

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function sliceHeadByBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(value.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
}

function sliceTailByBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(value.slice(value.length - mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(value.length - lo);
}

function compactPromptContext(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function limitPromptContext(value: string, maxBytes: number, label: string, mode: 'head' | 'tail' | 'head-tail' = 'head-tail'): string {
  const compacted = compactPromptContext(value);
  const originalBytes = byteLength(compacted);
  if (originalBytes <= maxBytes) return compacted;

  const notice = `\n\n[${label} truncated from ${originalBytes.toLocaleString()} bytes to stay within Perplexity's ${PERPLEXITY_MESSAGE_HARD_LIMIT_BYTES / 1000}KB message limit. Prioritise extracted specifications and request fresh web research for missing details.]\n\n`;
  const remaining = Math.max(0, maxBytes - byteLength(notice));
  let text: string;
  if (mode === 'head') {
    text = sliceHeadByBytes(compacted, remaining) + notice;
  } else if (mode === 'tail') {
    text = notice + sliceTailByBytes(compacted, remaining);
  } else {
    const headBudget = Math.floor(remaining * 0.62);
    const tailBudget = remaining - headBudget;
    text = `${sliceHeadByBytes(compacted, headBudget)}${notice}${sliceTailByBytes(compacted, tailBudget)}`;
  }
  console.log(`✂️ ${label} trimmed: ${originalBytes} → ${byteLength(text)} bytes`);
  return text;
}

// Helper function to generate a single section via API with retry logic

async function generateReportSection(
  sectionDef: typeof REPORT_SECTIONS[0],
  basePrompt: string,
  systemMessage: string,
  perplexityApiKey: string,
  previousSections: string,
  propertyAddress: string,
  enhancedData: any,
  maxRetries: number = 2
): Promise<{ content: string; citations: any[]; error?: string }> {
  // For section10 (Projections & SWOT), inject explicit investment score data
  let investmentScoreContext = '';
  if ((sectionDef.id === 'section10' || sectionDef.name.toLowerCase().includes('score')) && enhancedData?.investmentScore) {
    const score = enhancedData.investmentScore;
    console.log('📊 Injecting investment score data into section10 (Projections & SWOT):', {
      totalScore: score.totalScore,
      grade: score.grade,
      recommendation: score.recommendation
    });
    
    investmentScoreContext = `
**INVESTMENT SCORE DATA (USE THESE EXACT VALUES):**
- Total Investment Score: ${score.totalScore}/100
- Investment Grade: ${score.grade}
- Recommendation: ${score.recommendation}
- Growth Score: ${score.breakdown?.growthScore?.score || 'N/A'}/100 (Weight: ${score.breakdown?.growthScore?.weight || 40}%)
- Location Score: ${score.breakdown?.locationScore?.score || 'N/A'}/100 (Weight: ${score.breakdown?.locationScore?.weight || 25}%)
- Yield Score: ${score.breakdown?.yieldScore?.score || 'N/A'}/100 (Weight: ${score.breakdown?.yieldScore?.weight || 15}%)
- Demand Score: ${score.breakdown?.demandScore?.score || 'N/A'}/100 (Weight: ${score.breakdown?.demandScore?.weight || 15}%)
- Risk Score: ${score.breakdown?.riskScore?.score || 'N/A'}/100 (Weight: ${score.breakdown?.riskScore?.weight || 5}%)
${score.strengths?.length ? `- Strengths: ${score.strengths.join(', ')}` : ''}
${score.weaknesses?.length ? `- Weaknesses: ${score.weaknesses.join(', ')}` : ''}
${score.opportunities?.length ? `- Opportunities: ${score.opportunities.join(', ')}` : ''}
${score.risks?.length ? `- Risks: ${score.risks.join(', ')}` : ''}

**CRITICAL: You MUST include the Investment Score Analysis section with the EXACT values above. Do NOT skip this section or use placeholder values.**

`;
  }

  const sectionInstructions = `

---
**SECTION GENERATION TASK:**
You are generating ONLY the following sections of a comprehensive investment report:
${sectionDef.sections.map(s => `- ${s}`).join('\n')}

${investmentScoreContext}${previousSections ? `**CONTEXT FROM PREVIOUS SECTIONS (for consistency — you MUST reuse the same figures for distances, risk levels, SEIFA scores, population, labor force, cashflow, and LVR/deposit):**
${previousSections.substring(Math.max(0, previousSections.length - 6000))}
` : ''}

**CRITICAL INSTRUCTIONS:**
1. Generate ONLY the sections listed above - no introduction, no conclusion beyond what's specified
 2. Follow the exact markdown formatting with ## for main section headings and ### for subsections
3. Use tables ONLY when a visual shortcode cannot express the data. Prefer \`{{bars}}\`, \`{{heatmap}}\`, \`{{donut}}\`, \`{{tiles}}\`, \`{{timeline}}\`, \`{{gauge}}\`, \`{{pictograph}}\`, and inline \`~~[…]~~\` sparklines over tables or long paragraphs.
4. NEVER follow a visual, table or data point with a paragraph explaining it. State the finding in the sentence that INTRODUCES the data, then show the data, then move on. Do not write ${EDITORIAL_LABELS.map((l) => `"${l}"`).join(', ')} — not as a heading, not as a bold lead-in, not as a bare line. There is no permitted number of these.
5. Lead each section with a \`{{glance: …}}\` strip carrying the section's own findings — not a description of what the section will cover.
6. Be thorough and accurate, but compress prose aggressively; every paragraph must add a fact that is not already on the page.
7. Start immediately with the first section heading - no preamble
8. Use contextual comparisons (e.g., "30% above the state average") to make numbers meaningful
9. End the section when its findings are stated. No transition sentence, no summary of what was just said, no preview of what comes next.
${sectionDef.id === 'section10' ? '10. MUST include the Investment Score Analysis section with the exact score values provided above' : ''}

**CROSS-SECTION CONSISTENCY (MANDATORY):**
- If previous sections mentioned specific distances, SEIFA scores, risk ratings, population figures, or cashflow numbers, you MUST use the EXACT same values. Do NOT introduce contradicting figures.
- If you compare a metric to a benchmark (e.g., yield vs national average), verify the comparison is mathematically correct BEFORE writing it. If 4.13% < 4.2%, say "slightly below", never "exceeds".
- Use ONLY the single financial scenario from the PRE-CALCULATED section (one LVR, one deposit amount). Do not introduce alternative scenarios unless explicitly creating a labelled comparison table.
- Do NOT fabricate hyper-specific percentages for infrastructure impact (e.g., "9.2% uplift"). Use ranges or qualitative language unless citing a specific study.
- If a property is negatively geared, describe it honestly as "growth-focused with negative cashflow" — never as "balanced growth + income".
- All time-sensitive economic data must include "as at [Month Year]".

${EDITORIAL_PRIMITIVES_BLOCK}

Generate the ${sectionDef.name} sections now:`;
  const sectionInstructionBytes = byteLength(sectionInstructions);
  const basePromptBudget = Math.max(0, PERPLEXITY_SAFE_USER_MESSAGE_BYTES - sectionInstructionBytes - 2_000);
  const safeBasePrompt = limitPromptContext(basePrompt, basePromptBudget, `Base prompt for ${sectionDef.name}`);
  let sectionPrompt = `${safeBasePrompt}${sectionInstructions}`;
  if (byteLength(sectionPrompt) > PERPLEXITY_SAFE_USER_MESSAGE_BYTES) {
    const reducedBaseBudget = Math.max(0, PERPLEXITY_SAFE_USER_MESSAGE_BYTES - sectionInstructionBytes - 500);
    sectionPrompt = `${limitPromptContext(basePrompt, reducedBaseBudget, `Base prompt fallback for ${sectionDef.name}`, 'head-tail')}${sectionInstructions}`;
  }
  if (byteLength(sectionPrompt) > PERPLEXITY_SAFE_USER_MESSAGE_BYTES) {
    console.warn(`⚠️ Section instructions alone are close to Perplexity's message limit for ${sectionDef.name}; applying final tail-preserving trim.`);
    sectionPrompt = limitPromptContext(sectionPrompt, PERPLEXITY_SAFE_USER_MESSAGE_BYTES, `Final section prompt for ${sectionDef.name}`, 'tail');
  }
  const safeSystemMessage = limitPromptContext(systemMessage, PERPLEXITY_SAFE_SYSTEM_MESSAGE_BYTES, 'System prompt', 'head');
  const emergencySectionPromptUnbounded = `Generate ONLY this investment report section for ${propertyAddress}: ${sectionDef.name}.

Required headings:
${sectionDef.sections.map(s => `## ${s}`).join('\n')}

Use Australian property advisory language, real web research via Perplexity, concise markdown, inline source names, and no placeholders. Keep figures internally consistent. If exact supplied context is unavailable because the source packet was too large, research the suburb/property details live and state uncertainty rather than inventing facts.

${investmentScoreContext ? limitPromptContext(investmentScoreContext, 5_000, `Emergency investment score context for ${sectionDef.name}`, 'head') : ''}

Previous-section consistency hints:
${previousSections ? sliceTailByBytes(previousSections, 4_000) : 'None'}

Start now with the first heading.`;
  const emergencySectionPrompt = byteLength(emergencySectionPromptUnbounded) > PERPLEXITY_SAFE_USER_MESSAGE_BYTES
    ? limitPromptContext(emergencySectionPromptUnbounded, PERPLEXITY_SAFE_USER_MESSAGE_BYTES, `Emergency section prompt for ${sectionDef.name}`, 'head-tail')
    : emergencySectionPromptUnbounded;
  console.log(`📏 Prompt size for ${sectionDef.name}: user=${byteLength(sectionPrompt)} bytes, system=${byteLength(safeSystemMessage)} bytes`);

  // Retry loop with improved backoff and jitter
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📝 Generating section: ${sectionDef.name}... (attempt ${attempt}/${maxRetries})`);
      const userPromptForAttempt = attempt > 1 ? emergencySectionPrompt : sectionPrompt;
      if (attempt > 1) {
        console.log(`🧯 Using emergency compact prompt for ${sectionDef.name}: ${byteLength(userPromptForAttempt)} bytes`);
      }
      
      const systemPromptForAttempt = attempt > 1
        ? 'You are an Australian property investment analyst. Produce concise, sourced markdown and never invent exact figures.'
        : safeSystemMessage;
      const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${perplexityApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          max_tokens: sectionDef.maxTokens,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPromptForAttempt },
            { role: 'user', content: userPromptForAttempt }
          ]
        }),
      }, SECTION_REQUEST_TIMEOUT_MS, 'perplexity-api'); // bounded so the loop always regains control, with circuit breaker tracking

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Section ${sectionDef.id} API error (attempt ${attempt}):`, response.status, errorText);
        
        const isPromptTooLarge = response.status === 400 && /content exceeds maximum length|100KB|maximum length/i.test(errorText);
        // If prompt is too large, rate limited or server error, wait and retry with jitter
        if ((isPromptTooLarge || response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          if (isPromptTooLarge) console.warn(`🧯 Perplexity rejected ${sectionDef.name} prompt as too large; retrying with emergency compact prompt.`);
          const waitTime = getRetryDelayWithJitter(attempt, response.status === 429 ? 5000 : 3000);
          console.log(`⏳ Waiting ${(waitTime/1000).toFixed(1)}s before retry (with jitter)...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        return { content: '', citations: [], error: `API error ${response.status}: ${errorText}` };
      }

      const data = await response.json();
      let content = data.choices?.[0]?.message?.content || '';
      const citations = data.citations || [];
      let finishReason = data.choices?.[0]?.finish_reason || '';

      // Log Perplexity API usage
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const sbLog = createClient(supabaseUrl, supabaseKey);
      const pUsage = data.usage;
      await logApiUsage(sbLog, {
        service_name: 'perplexity',
        endpoint: '/chat/completions',
        model_used: 'sonar-pro',
        prompt_tokens: pUsage?.prompt_tokens || 0,
        completion_tokens: pUsage?.completion_tokens || 0,
        tokens_used: pUsage?.total_tokens || 0,
        status: 'success',
        metadata: { function: 'generate-investment-report', section: sectionDef.name },
      });

      console.log(`✓ Section ${sectionDef.name} generated: ${content.length} chars (finish_reason=${finishReason})`);

      // CONTINUATION: if the model stopped because it hit max_tokens, ask it
      // to continue from where it left off so the last paragraph isn't cut
      // off on the final PDF page. Up to 2 continuation rounds per section.
      let continuationRounds = 0;
      // Treat content as truncated if API said so OR the tail ends mid-thought:
      //   • trailing comma / colon / dash / ellipsis
      //   • dangling "First,", "Second," etc.
      //   • last paragraph is suspiciously short for a real conclusion
      const endsMidThought = (s: string): boolean => {
        const tail = s.trimEnd().slice(-200);
        if (!tail) return false;
        if (/[,:;\-–—]$/.test(tail)) return true;
        if (/\.{3}$/.test(tail) || /…$/.test(tail)) return true;
        if (/\b(First|Second|Third|Finally|In summary|Importantly|Crucially),?\s*$/i.test(tail)) return true;
        if (!/[.!?")\]}]$/.test(tail)) return true;
        return false;
      };
      while ((finishReason === 'length' || endsMidThought(content)) && continuationRounds < 2) {
        continuationRounds++;
        console.log(`↪️  Section ${sectionDef.name} appears truncated (finish=${finishReason}) — continuation round ${continuationRounds}`);
        const tail = content.slice(-1200);
        const continuePrompt = `You were writing the "${sectionDef.name}" section of an investment report and were cut off mid-thought. Continue writing from EXACTLY where you stopped. Do NOT repeat any earlier text, do NOT restart the section, do NOT add a preamble. Simply resume the next words and finish the section cleanly.\n\nLast 1200 characters you produced (your reply will be appended directly after the final character):\n\n${tail}`;
        try {
          const contResp = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${perplexityApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'sonar-pro',
              max_tokens: Math.min(2500, sectionDef.maxTokens),
              temperature: 0.1,
              messages: [
                { role: 'system', content: safeSystemMessage },
                { role: 'user', content: sectionPrompt },
                { role: 'assistant', content: limitPromptContext(content, 50_000, `Continuation prior content for ${sectionDef.name}`, 'tail') },
                { role: 'user', content: continuePrompt },
              ],
            }),
          }, SECTION_CONTINUATION_TIMEOUT_MS, 'perplexity-api');
          if (!contResp.ok) {
            console.warn(`   continuation HTTP ${contResp.status} — stopping continuation loop`);
            break;
          }
          const contData = await contResp.json();
          const addition = contData.choices?.[0]?.message?.content || '';
          finishReason = contData.choices?.[0]?.finish_reason || '';
          if (!addition.trim()) {
            console.warn('   continuation returned empty content — stopping');
            break;
          }
          // Strip any echoed overlap with the existing tail before appending.
          let joinedAddition = addition;
          const maxOverlap = Math.min(120, addition.length);
          for (let k = maxOverlap; k > 12; k--) {
            if (content.endsWith(addition.slice(0, k))) {
              joinedAddition = addition.slice(k);
              break;
            }
          }
          content = content + joinedAddition;
          console.log(`   continuation added ${joinedAddition.length} chars (new total ${content.length}, finish=${finishReason})`);
        } catch (contErr: any) {
          console.warn('   continuation call failed:', contErr?.message);
          break;
        }
      }

      return { content, citations };
    } catch (error: any) {
      console.error(`❌ Error generating section ${sectionDef.id} (attempt ${attempt}):`, error?.message);
      
      // Retry on timeout or network errors with jitter
      if (attempt < maxRetries) {
        const waitTime = getRetryDelayWithJitter(attempt, 2000);
        console.log(`⏳ Waiting ${(waitTime/1000).toFixed(1)}s before retry (with jitter)...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      return { content: '', citations: [], error: error?.message };
    }
  }
  
  return { content: '', citations: [], error: 'Max retries exceeded' };
}

// Helper function to update report status to failed
async function markReportFailed(reportId: string | null, errorMessage: string): Promise<void> {
  if (!reportId) return;
  
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    if (supabaseUrl && supabaseKey) {
      const client = createClient(supabaseUrl, supabaseKey);
      await client
        .from('investment_reports')
        .update({ 
          status: 'failed',
          error_message: errorMessage,
          updated_at: new Date().toISOString()
        })
        .eq('id', reportId);
      
      // Also update auto_report_generation_log if this was an auto-generated report
      await client
        .from('auto_report_generation_log')
        .update({
          status: 'failed',
          error_message: `Report generation failed: ${errorMessage}`,
          completed_at: new Date().toISOString()
        })
        .eq('report_id', reportId);
      
      console.log(`✓ Marked report ${reportId} as failed: ${errorMessage}`);
    }
  } catch (updateError) {
    console.error('Error updating report status to failed:', updateError);
  }
}

const __investmentReportHandler = async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);

  // Wall-clock reference for the section budget. The Supabase edge runtime kills
  // an invocation at ~150s; a Compass report needs several times that. Before this
  // existed the loop simply ran until the platform killed it mid-section, which
  // left the row stuck at 'processing' forever with no error recorded. We now
  // stop voluntarily and hand the rest to the next caller (cron watchdog or the
  // browser pump). See docs/reports/INVESTMENT_REPORT_RESUME.md.
  const runStartedAt = Date.now();

  console.log('Investment report function invoked with method:', req.method);
  
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request');
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for internal-pipeline callers (HMAC/internal secret, no session cookie).
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    console.log('Starting investment report generation...');
    
    // Parse request body
    let requestBody;
    try {
      requestBody = await req.json();
      console.log('Request body parsed successfully');
    } catch (parseError) {
      console.error('Error parsing request body:', parseError);
      return new Response(JSON.stringify({ 
        error: 'Invalid JSON in request body',
        success: false 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // SECURITY: Verify authentication
    // IMPORTANT: trim() secrets to avoid subtle "Invalid JWT" errors if newline/whitespace was copied into env vars.
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').trim();
    const supabaseServiceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
    const supabaseAnonKey = (Deno.env.get('SUPABASE_ANON_KEY') || '').trim();
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const { error: authError, userId } = await verifyAuth(supabase, req.headers, requestBody);
    if (authError) {
      console.log('[generate-investment-report] Auth failed:', authError);
      return createUnauthorizedResponse(authError, corsHeaders);
    }
    console.log('[generate-investment-report] Authenticated user:', userId);
    
    let { reportId, propertyAddress, propertyDetails, continueFrom, singleSection } = requestBody;
    // Get scope from request, with fallback to existing report's scope for continuation/chunked calls
    let reportScope = propertyDetails?.queryType || 'address';
    let isAreaReport = ['suburb', 'postcode', 'statewide', 'zipcode'].includes(reportScope);
    
    // Flag to indicate if we're continuing from existing content
    const isContinuation = continueFrom === true;
    // Flag for chunked mode - generate one section per call to avoid platform timeouts
    const isSingleSectionMode = singleSection === true;
    console.log('Continuation mode:', isContinuation, '| Single-section mode:', isSingleSectionMode);
    
    // UNIFIED DOCUMENT CONTENT: Accept both scrapedContent (URL scrape) AND pdfContent (PDF upload)
    // This ensures consistent content injection regardless of the input source
    const scrapedContent = propertyDetails?.scrapedContent || null;
    const pdfContent = propertyDetails?.pdfContent || null;
    const documentContent = scrapedContent || pdfContent || null; // Unified content variable
    
    const sourceUrl = propertyDetails?.sourceUrl || null;
    const fromUrlScrape = propertyDetails?.fromUrlScrape || false;
    const fromPdfUpload = propertyDetails?.fromPdfUpload || false;
    const contentSource = fromUrlScrape ? 'URL Scrape' : (fromPdfUpload ? 'PDF Upload' : 'Manual Entry');
    
    console.log('=== REPORT GENERATION REQUEST ===');
    console.log('Report ID:', reportId);
    console.log('Property address:', propertyAddress);
    console.log('Report scope:', reportScope);
    console.log('Content source:', contentSource);
    console.log('From URL scrape:', fromUrlScrape);
    console.log('From PDF upload:', fromPdfUpload);
    console.log('Scraped content available:', !!scrapedContent, scrapedContent ? `(${scrapedContent.length} chars)` : '');
    console.log('PDF content available:', !!pdfContent, pdfContent ? `(${pdfContent.length} chars)` : '');
    console.log('Unified document content available:', !!documentContent, documentContent ? `(${documentContent.length} chars)` : '');
    console.log('Source URL:', sourceUrl);
    
    // Log all property details for debugging
    if (propertyDetails) {
      console.log('Property details received:');
      console.log('  - Price:', propertyDetails.price);
      console.log('  - Beds:', propertyDetails.beds);
      console.log('  - Baths:', propertyDetails.baths);
      console.log('  - Car spaces:', propertyDetails.carSpaces);
      console.log('  - Land size:', propertyDetails.landSizeSqm);
      console.log('  - Build size:', propertyDetails.buildSizeSqm);
      console.log('  - Property type:', propertyDetails.propertyType);
      console.log('  - Postcode:', propertyDetails.postcode);
      console.log('  - State:', propertyDetails.state);
      console.log('  - Suburb:', propertyDetails.suburb);
      console.log('  - Weekly rent:', propertyDetails.weeklyRent);
      console.log('  - Is new build:', propertyDetails.isNewBuild);
    }
    
    // If reportId is provided but no propertyAddress, fetch it from the existing report (for retries)
    if (reportId && !propertyAddress) {
      console.log('Fetching property address from existing report for retry...');
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && supabaseKey) {
        const client = createClient(supabaseUrl, supabaseKey);
        const { data: existingReport, error: fetchError } = await client
          .from('investment_reports')
          .select('property_address')
          .eq('id', reportId)
          .single();
        
        if (fetchError || !existingReport?.property_address) {
          console.error('Failed to fetch property address for retry:', fetchError);
          await markReportFailed(reportId, 'Could not find existing report for retry');
          return new Response(JSON.stringify({ 
            error: 'Could not find existing report for retry',
            success: false 
          }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        propertyAddress = existingReport.property_address;
        console.log('Fetched property address from existing report:', propertyAddress);
      }
    }
    
    if (!propertyAddress) {
      console.error('Property address is missing');
      await markReportFailed(reportId, 'Property address is required');
      return new Response(JSON.stringify({ 
        error: 'Property address is required',
        success: false 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Initialize Supabase client for database updates
    let supabaseClient = null;
    let existingManualOverrides = null;
    // Track which enhanced fields are already persisted on the report (so we don't overwrite them)
    let existingEnhancedFields: {
      investmentScore?: any;
      financials?: any;
      demographics?: any;
      economics?: any;
      locationIntelligence?: any;
    } = {};
    
    // Get pre-generation overrides from request (passed from frontend)
    const frontendManualOverrides = propertyDetails?.manualOverrides || null;
    if (frontendManualOverrides && Object.keys(frontendManualOverrides).length > 0) {
      console.log('📝 Received pre-generation overrides from frontend:', Object.keys(frontendManualOverrides).length, 'fields');
      console.log('  Override keys:', Object.keys(frontendManualOverrides).join(', '));
    }
    
    // Variables for continuation mode
    let existingReportContent = '';
    let completedSectionIndices: number[] = [];
    
    if (reportId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && supabaseKey) {
        supabaseClient = createClient(supabaseUrl, supabaseKey);
        
        // Fetch existing report data (including content for continuation)
        const { data: existingReport } = await supabaseClient
          .from('investment_reports')
          .select('manual_overrides, report_content, property_address, last_completed_section, total_sections, investment_score, financial_calculations, demographics_data, economic_data, location_intelligence, report_scope, report_tier, generation_engine')
          .eq('id', reportId)
          .single();
        
        if (
          existingReport?.property_address
          && propertyAddress
          && existingReport.property_address.trim().toLowerCase() !== propertyAddress.trim().toLowerCase()
        ) {
          console.warn('[generate-investment-report] Rejected property address mismatch for report:', reportId);
          return new Response(JSON.stringify({
            error: 'Property address does not match the existing report',
            success: false,
          }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // CRITICAL: If queryType wasn't passed (e.g., chunked regeneration), use the existing report's scope
        if (existingReport?.report_scope && reportScope === 'address' && !propertyDetails?.queryType) {
          reportScope = existingReport.report_scope;
          isAreaReport = ['suburb', 'postcode', 'statewide', 'zipcode'].includes(reportScope);
          console.log(`📋 Restored report_scope from existing report: ${reportScope} (isAreaReport: ${isAreaReport})`);
        }
        
        if (existingReport?.manual_overrides) {
          existingManualOverrides = existingReport.manual_overrides;
          console.log('📝 Fetched existing manual overrides from DB:', Object.keys(existingManualOverrides).length, 'fields');
        }

        if (existingReport?.report_tier && !propertyDetails?.reportTier) {
          propertyDetails = {
            ...(propertyDetails || {}),
            reportTier: existingReport.report_tier,
          };
          console.log(`📋 Restored report_tier from existing report: ${existingReport.report_tier}`);
        }

        // CRITICAL: Restore generation_engine from the DB record when the caller
        // didn't send it (auto-resume / continuation paths don't pass
        // propertyDetails). Without this the engine silently falls back to
        // 'legacy' on every resume, flipping a compass-40 run mid-flight and
        // vice-versa — i.e. the user's explicit engine selection is not
        // respected.
        if (existingReport?.generation_engine && !propertyDetails?.generationEngine) {
          const storedEngine = existingReport.generation_engine === 'compass-40' ? 'compass-40' : 'legacy';
          propertyDetails = {
            ...(propertyDetails || {}),
            generationEngine: storedEngine,
          };
          console.log(`⚙️ Restored generation_engine from existing report: ${storedEngine}`);
        }

        // Capture existing enhanced fields so we can avoid overwriting already-persisted values
        if (existingReport) {
          existingEnhancedFields = {
            investmentScore: (existingReport as any).investment_score,
            financials: (existingReport as any).financial_calculations,
            demographics: (existingReport as any).demographics_data,
            economics: (existingReport as any).economic_data,
            locationIntelligence: (existingReport as any).location_intelligence,
          };
        }
        
        // If continuing, use the stored last_completed_section index for reliable resume
        if (isContinuation && existingReport?.report_content) {
          const lastCompletedSection = existingReport.last_completed_section || 0;
          
          console.log('🔄 CONTINUATION MODE: Checking section progress');
          console.log('   Existing content length:', existingReport.report_content.length, 'chars');
          console.log('   Last completed section (from DB):', lastCompletedSection);
          
          // A report banked under a different section list cannot be resumed.
          //
          // `last_completed_section` is a raw index into the CURRENT registry,
          // so a row stopped at 8 of 17 that resumed under the 12-section v3.0
          // list would splice sections 8-11 of the new structure onto sections
          // 0-7 of the old one — a document with two Population sections, no
          // Demand Drivers, and no way to tell from the row that anything went
          // wrong. `total_sections` records which list the banked content was
          // written against, so the mismatch is detectable; when it does not
          // match, the report starts again rather than being stitched together.
          //
          // This costs one full regeneration, and only for reports in flight
          // across the deploy. Reports already `completed` are never resumed.
          const storedTotal = Number((existingReport as any).total_sections) || 0;
          const registryTotal = /^(compass|compass-40)$/i.test(String((existingReport as any).report_tier ?? 'compass'))
            ? compassSections().length
            : 0;
          const registryChanged = storedTotal > 0 && registryTotal > 0 && storedTotal !== registryTotal;
          if (registryChanged) {
            console.log(
              `   ⚠️ Section list changed since this report was banked ` +
              `(stored total_sections=${storedTotal}, registry now ${registryTotal}). ` +
              `Regenerating from scratch — resuming would splice two different structures together.`,
            );
          }

          // CRITICAL FIX: Only use existing content for TRUE resume (last_completed_section > 0)
          // If last_completed_section is 0, this is a FRESH REGENERATION - do NOT prepend old content
          if (lastCompletedSection > 0 && !registryChanged) {
            existingReportContent = existingReport.report_content;
            console.log('   ✓ RESUME mode: Using existing content as base');
            
            // Build completed section indices from the stored value
            // All sections from 0 to lastCompletedSection-1 are complete (0-indexed section IDs)
            // If lastCompletedSection = 5, then sections 0,1,2,3,4 are complete
            for (let idx = 0; idx < lastCompletedSection; idx++) {
              completedSectionIndices.push(idx);
            }
            
            console.log(`   Completed sections: ${completedSectionIndices.length}/${REPORT_SECTIONS.length}`);
            console.log(`   Will resume from section: ${lastCompletedSection} (${REPORT_SECTIONS[lastCompletedSection]?.name || 'END'})`);
          } else {
            // Fresh regeneration: either last_completed_section was reset to 0,
            // or the section list changed underneath a partially generated
            // report. Do NOT use existing content - start completely fresh.
            existingReportContent = '';
            completedSectionIndices.length = 0;
            console.log(
              registryChanged
                ? '   🔄 FRESH REGENERATION mode: section list changed, discarding partial content'
                : '   🔄 FRESH REGENERATION mode: Starting from scratch (last_completed_section=0)',
            );
            console.log('   Old content will be discarded, generating all sections fresh');
          }
          
          // Use property address from existing report if not provided
          if (!propertyAddress && existingReport.property_address) {
            propertyAddress = existingReport.property_address;
            console.log('   Using property address from existing report:', propertyAddress);
          }
        }
        
        // Update status to processing
        await supabaseClient
          .from('investment_reports')
          .update({ status: 'processing' })
          .eq('id', reportId);
        
        console.log('Updated report status to processing');
      }
    }
    
    // Merge overrides: frontend takes precedence over existing DB overrides
    const mergedOverrides = {
      ...(existingManualOverrides || {}),
      ...(frontendManualOverrides || {})
    };
    const hasOverrides = Object.keys(mergedOverrides).length > 0;
    if (hasOverrides) {
      console.log('🔀 Merged overrides total:', Object.keys(mergedOverrides).length, 'fields');
    }
    
    // ============================================================================
    // CRITICAL: Define effective values ONCE at the top and use consistently
    // These values respect the override hierarchy and are used throughout
    // ============================================================================
    const effectivePurchasePrice = mergedOverrides.purchasePrice || propertyDetails?.price || 0;
    const effectiveWeeklyRent = mergedOverrides.weeklyRent || propertyDetails?.weeklyRent || 0;
    const effectiveLvr = mergedOverrides.loanToValueRatio || propertyDetails?.loanToValueRatio || 80;
    
    // CRITICAL: Deposit value handling - check both mergedOverrides and propertyDetails
    // Parse as number since frontend may send as string
    const rawDepositValue = mergedOverrides.depositValue ?? propertyDetails?.depositValue ?? null;
    const parsedDepositValue = rawDepositValue !== null ? parseFloat(String(rawDepositValue)) : NaN;
    const effectiveDepositValue = !isNaN(parsedDepositValue) && parsedDepositValue > 0 
      ? parsedDepositValue 
      : (effectivePurchasePrice * ((100 - effectiveLvr) / 100));
    
    console.log('📦 Deposit Value Debug:');
    console.log(`  Raw from mergedOverrides: ${mergedOverrides.depositValue}`);
    console.log(`  Raw from propertyDetails: ${propertyDetails?.depositValue}`);
    console.log(`  Parsed value: ${parsedDepositValue}`);
    console.log(`  Effective deposit: $${effectiveDepositValue?.toLocaleString()}`);
    
    const effectiveInterestRate = mergedOverrides.interestRate || propertyDetails?.interestRate || 6.5;
    const effectiveLoanTerm = mergedOverrides.loanTermYears || propertyDetails?.loanTermYears || 30;
    const effectiveIsFirstHomeBuyer = mergedOverrides.isFirstHomeBuyer || false;
    const effectiveBuildType = mergedOverrides.buildType || (propertyDetails?.isNewBuild ? 'new_build' : 'existing_property');
    const effectiveIsNewBuild = effectiveBuildType === 'new_build';
    const effectiveIsLandOnly = effectiveBuildType === 'land_only';
    const effectiveLandSizeSqm = mergedOverrides.landSizeSqm || propertyDetails?.landSizeSqm || null;
    const effectiveBuildSizeSqm = effectiveIsLandOnly ? null : (mergedOverrides.buildSizeSqm || propertyDetails?.buildSizeSqm || null);
    const effectiveBeds = effectiveIsLandOnly ? 0 : (mergedOverrides.bedrooms || propertyDetails?.beds || 3);
    const effectiveBaths = effectiveIsLandOnly ? 0 : (mergedOverrides.bathrooms || propertyDetails?.baths || 2);
    
    // Zoning effective values
    const effectiveZoningCode = mergedOverrides.zoningCode || null;
    const effectiveZoningDescription = mergedOverrides.zoningDescription || null;
    const effectivePermittedUses = mergedOverrides.permittedUses || null;
    const effectiveDevelopmentPotential = mergedOverrides.developmentPotential || null;
    const effectiveZoningOverlays = mergedOverrides.zoningOverlays || null;
    const effectiveMinimumLotSize = mergedOverrides.minimumLotSize || null;
    const effectiveMaximumHeight = mergedOverrides.maximumHeight || null;
    const effectiveFloorSpaceRatio = mergedOverrides.floorSpaceRatio || null;
    const hasZoningData = effectiveZoningCode || effectiveZoningDescription || effectivePermittedUses || effectiveDevelopmentPotential;
    
    console.log('📊 EFFECTIVE VALUES (after merging overrides):');
    console.log(`  Purchase Price: $${effectivePurchasePrice?.toLocaleString()} ${mergedOverrides.purchasePrice ? '(OVERRIDE)' : '(from property)'}`);
    console.log(`  Weekly Rent: $${effectiveWeeklyRent} ${mergedOverrides.weeklyRent ? '(OVERRIDE)' : '(from property)'}`);
    console.log(`  LVR: ${effectiveLvr}% ${mergedOverrides.loanToValueRatio ? '(OVERRIDE)' : '(default)'}`);
    console.log(`  Interest Rate: ${effectiveInterestRate}% ${mergedOverrides.interestRate ? '(OVERRIDE)' : '(default)'}`);
    console.log(`  Build Type: ${effectiveBuildType}`);
    console.log(`  Is New Build: ${effectiveIsNewBuild}`);
    console.log(`  Is Land Only: ${effectiveIsLandOnly}`);

    // Check for Perplexity API key
    const perplexityApiKey = Deno.env.get('PERPLEXITY_API_KEY');
    console.log('Perplexity API key configured:', !!perplexityApiKey);
    
    if (!perplexityApiKey) {
      console.error('Perplexity API key not found in environment');
      const errorMsg = 'Perplexity API key not configured. Please set PERPLEXITY_API_KEY in Supabase secrets.';
      await markReportFailed(reportId, errorMsg);
      return new Response(JSON.stringify({ 
        error: errorMsg,
        success: false 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Determine analysis mode and format input query
    let analysisMode = 'address'; // Default mode
    let formattedInput = propertyAddress;
    let detectedSuburb = null;
    let detectedPostcode = null;
    let detectedState = null;
    
    // Extract postcode and state from input
    const postcodeMatch = propertyAddress.match(/\b(\d{4})\b/);
    const stateMatch = propertyAddress.match(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT|Western Australia|New South Wales|Victoria|Queensland|South Australia|Tasmania|Northern Territory|Australian Capital Territory)\b/i);
    
    if (postcodeMatch) {
      detectedPostcode = postcodeMatch[1];
    }
    if (stateMatch) {
      const stateInput = stateMatch[1].toUpperCase();
      // Convert full state names to abbreviations
      const stateMap: Record<string, string> = {
        'WESTERN AUSTRALIA': 'WA',
        'NEW SOUTH WALES': 'NSW',
        'VICTORIA': 'VIC',
        'QUEENSLAND': 'QLD',
        'SOUTH AUSTRALIA': 'SA',
        'TASMANIA': 'TAS',
        'NORTHERN TERRITORY': 'NT',
        'AUSTRALIAN CAPITAL TERRITORY': 'ACT'
      };
      detectedState = stateMap[stateInput] || stateInput;
    }
    
    // Detect analysis mode
    if (/^\d{4}$/.test(propertyAddress.trim()) || /postcode\s+\d{4}/i.test(propertyAddress)) {
      // Pure postcode mode
      analysisMode = 'postcode';
      const postcode = postcodeMatch ? postcodeMatch[1] : propertyAddress.trim();
      // Require state for postcode to avoid ambiguity
      if (!detectedState) {
        console.warn('⚠️ Postcode provided without state, defaulting to NSW');
        detectedState = 'NSW';
      }
      formattedInput = `Postcode ${postcode}, ${detectedState}, Australia`;
    } else if (propertyAddress.match(/^[A-Za-z\s]+(?:,\s*(?:\d{4}|NSW|VIC|QLD|WA|SA|TAS|NT|ACT))+/i)) {
      // Suburb mode: Suburb name followed by postcode and/or state
      // Examples: "Bondi, 2026, NSW" or "Bondi NSW 2026" or "Bondi, NSW"
      analysisMode = 'suburb';
      const parts = propertyAddress.split(',').map((p: string) => p.trim());
      detectedSuburb = parts[0];
      
      // Require both postcode and state for suburb to avoid ambiguity
      if (!detectedPostcode || !detectedState) {
        console.warn('⚠️ Suburb provided without complete postcode/state information');
        if (!detectedState) {
          detectedState = 'NSW'; // Default fallback
        }
      }
      
      formattedInput = `${detectedSuburb}${detectedPostcode ? ', ' + detectedPostcode : ''}${detectedState ? ', ' + detectedState : ''}, Australia`;
      console.log('Suburb analysis mode detected:', { suburb: detectedSuburb, postcode: detectedPostcode, state: detectedState });
    } else if (/(western australia|wa|new south wales|nsw|victoria|vic|queensland|qld|south australia|sa|tasmania|tas|northern territory|nt|australian capital territory|act)$/i.test(propertyAddress.trim())) {
      // State-wide mode: ends with just a state name
      analysisMode = 'state';
      formattedInput = propertyAddress;
    } else {
      // Default to address mode
      analysisMode = 'address';
    }

    console.log('Analysis mode:', analysisMode);
    console.log('Formatted input:', formattedInput);
    console.log('Analysis details:', { suburb: detectedSuburb, postcode: detectedPostcode, state: detectedState });

    // Fetch enhanced data from multiple sources
    console.log('Fetching enhanced data from multiple APIs...');
    
    interface EnhancedData {
      demographics?: any;
      economics?: any;
      financials?: any;
      locationIntelligence?: any;
      investmentScore?: any;
      domainData?: any;
      riskAssessment?: any;
      seifaData?: any;
      crimeStatistics?: any;
      employmentData?: any;
      climateData?: any;
      schoolData?: any;
    }
    
    let enhancedData: EnhancedData = {};
    
    // Declare suburb/state/postcode OUTSIDE try block so they're accessible in reportContent
    let postcode = detectedPostcode;
    let state = detectedState || 'NSW';
    let suburb = detectedSuburb;
    
    try {
      // Use detected values from earlier, or extract from formatted input
      
      // If not detected earlier, try to extract from formatted input
      if (!postcode) {
        const postcodeMatch = formattedInput.match(/\b(\d{4})\b/);
        postcode = postcodeMatch ? postcodeMatch[1] : null;
      }
      if (!state || state === 'NSW') {
        const stateMatch = formattedInput.match(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i);
        if (stateMatch) state = stateMatch[1].toUpperCase();
      }
      if (!suburb) {
        // Extract suburb from address (everything between street and state/postcode)
        const suburbMatch = formattedInput.match(/,\s*([A-Za-z\s]+)(?:,|\s+(?:NSW|VIC|QLD|WA|SA|TAS|NT|ACT))/i);
        suburb = suburbMatch ? suburbMatch[1].trim().toLowerCase().replace(/\s+/g, '-') : null;
      } else {
        // Convert suburb to URL-friendly format if not already
        suburb = suburb.toLowerCase().replace(/\s+/g, '-');
      }
      
      console.log('Using for API calls:', { suburb, postcode, state });

      // ============================================================================
      // PHASE 1: PARALLEL INDEPENDENT DATA FETCHING
      // These services don't depend on each other, so fetch them all simultaneously
      // ============================================================================
      console.log('🚀 Starting PARALLEL data fetch (Phase 1)...');
      const phase1StartTime = Date.now();
      
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      
      // IMPORTANT: Use service role key for internal service-to-service calls
      // The anon key has role='anon' which fails verifyAuth in sub-functions
      // Service role is recognized by verifyAuth as a valid internal caller
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
        ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
      };

      // Define all Phase 1 fetch promises
      const phase1Promises = [
        // 1. Domain market data
        (suburb && state) ? fetchServiceWithFallback('domain-data-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/domain-data-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ 
              suburb, state, postcode,
              propertyCategory: propertyDetails?.propertyType?.toLowerCase() === 'unit' ? 'unit' : 'house'
            })
          }, 30000, 'domain-data-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'domain-data-service', error: 'Missing suburb/state' }),

        // 2. ABS demographic data
        postcode ? fetchServiceWithFallback('abs-data-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/abs-data-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ postcode, state })
          }, 30000, 'abs-data-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'abs-data-service', error: 'Missing postcode' }),

        // 3. RBA economic data
        fetchServiceWithFallback('rba-data-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/rba-data-service`, {
            method: 'POST',
            headers
          }, 20000, 'rba-data-service');
          if (response.ok) {
            const data = await response.json();
            return data.data || null;
          }
          return null;
        }),

        // 4. SEIFA socioeconomic data
        postcode ? fetchServiceWithFallback('abs-seifa-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/abs-seifa-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ postcode, state })
          }, 25000, 'abs-seifa-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'abs-seifa-service', error: 'Missing postcode' }),

        // 5. Crime statistics
        (suburb && state) ? fetchServiceWithFallback('crime-statistics-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/crime-statistics-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ suburb, state, postcode })
          }, 30000, 'crime-statistics-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'crime-statistics-service', error: 'Missing suburb/state' }),

        // 6. Employment data
        state ? fetchServiceWithFallback('abs-employment-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/abs-employment-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ suburb, state, postcode })
          }, 25000, 'abs-employment-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'abs-employment-service', error: 'Missing state' }),

        // 7. Climate data
        state ? fetchServiceWithFallback('climate-data-service', async () => {
          const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/climate-data-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ suburb, state, postcode })
          }, 25000, 'climate-data-service');
          if (response.ok) {
            const data = await response.json();
            return data.success ? data.data : null;
          }
          return null;
        }) : Promise.resolve({ success: false, serviceName: 'climate-data-service', error: 'Missing state' }),
      ];

      // Execute all Phase 1 fetches in parallel
      const phase1Results = await Promise.allSettled(phase1Promises);
      const phase1Duration = Date.now() - phase1StartTime;
      
      // Process Phase 1 results
      let successCount = 0;
      let failCount = 0;
      
      phase1Results.forEach((result, index) => {
        const serviceNames = ['domain', 'demographics', 'economics', 'seifaData', 'crimeStatistics', 'employmentData', 'climateData'];
        const serviceName = serviceNames[index];
        
        // The settled union mixes ServiceResult<any> with a bare error shape that
        // carries no `data`, so read the payload through the widened result — the
        // truthiness check below is what actually decides whether it is present.
        const fulfilled = result.status === 'fulfilled'
          ? (result.value as ServiceResult<any>)
          : null;
        if (fulfilled && fulfilled.success && fulfilled.data) {
          enhancedData = { ...enhancedData, [serviceName === 'domain' ? 'domainData' : serviceName]: fulfilled.data };
          successCount++;
        } else {
          failCount++;
          const reason = result.status === 'rejected' 
            ? result.reason?.message 
            : (result.value as ServiceResult<any>).error;
          if (reason && !reason.includes('Missing')) {
            console.log(`  ⚠️ ${serviceName}: ${reason}`);
          }
        }
      });
      
      console.log(`✓ Phase 1 complete in ${phase1Duration}ms: ${successCount} succeeded, ${failCount} skipped/failed`);

      // ============================================================================
      // PHASE 2: SEQUENTIAL DEPENDENT DATA FETCHING
      // These services depend on Phase 1 results or each other
      // ============================================================================
      console.log('🔄 Starting Phase 2 (dependent services)...');

      // Fetch risk assessment data (can use coordinates from location intelligence)
      if (postcode && state) {
        try {
          const riskResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/risk-assessment-service`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ 
              suburb: suburb || 'unknown',
              state: state,
              postcode: postcode
            })
          }, 25000, 'risk-assessment-service');
          
          if (riskResponse.ok) {
            const riskData = await riskResponse.json();
            if (riskData.success && riskData.data) {
              enhancedData = { ...enhancedData, riskAssessment: riskData.data };
              console.log('✓ Risk assessment data fetched');
            }
          }
        } catch (error: any) {
          console.log('⚠️ Risk assessment skipped:', error?.message?.substring(0, 50));
        }
      }

      // NOTE: ABS demographics and RBA economics are now fetched in Phase 1 parallel block above

      // Fetch rent from cache if not provided
      let weeklyRent = propertyDetails?.weeklyRent;
      let rentSource = 'user_input';
      
      if (!weeklyRent && suburb && state) {
        try {
          console.log('📊 Weekly rent not provided, fetching from SQM Research cache...');
          const rentResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/sqm-rent-service`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
                // The gateway requires a JWT; verifyAuth uses the separate internal credential.
                'Authorization': `Bearer ${supabaseAnonKey}`,
                'x-internal-edge-secret': INTERNAL_EDGE_SECRET,
                ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
            },
            body: JSON.stringify({
              suburb: suburb.replace(/-/g, ' '),
              state: state,
              postcode: postcode || '',
              propertyType: propertyDetails?.propertyType?.toLowerCase() || 'house',
              bedrooms: propertyDetails?.bedrooms || 3
            })
          });
          
          if (rentResponse.ok) {
            const rentData = await rentResponse.json();
            if (rentData.success && rentData.data?.medianWeeklyRent) {
              weeklyRent = rentData.data.medianWeeklyRent;
              rentSource = rentData.source === 'cache' ? 'sqm_cache' : 'sqm_scraped';
              console.log(`✓ Median weekly rent from ${rentSource}: $${weeklyRent}`);
            } else {
              console.log('⚠️ No rent data available from SQM Research');
            }
          }
        } catch (error: any) {
          console.log('⚠️ SQM rent lookup failed:', error?.message || 'Unknown error');
        }
      }
      
      // Calculate financial projections if property details available
      // Use effective values defined at the top (which already include overrides)
      if (effectivePurchasePrice > 0) {
        try {
          // Use effective values that were defined at the top (already include overrides)
          const calcWeeklyRent = effectiveWeeklyRent || weeklyRent || 0;
          
          console.log('📊 Financial calculator inputs (using top-level effective values):');
          console.log(`  Property Value: $${effectivePurchasePrice.toLocaleString()}`);
          console.log(`  Deposit: $${effectiveDepositValue.toLocaleString()} (LVR: ${effectiveLvr}%)`);
          console.log(`  Interest Rate: ${effectiveInterestRate}%`);
          console.log(`  Loan Term: ${effectiveLoanTerm} years`);
          console.log(`  Weekly Rent: $${calcWeeklyRent}`);
          console.log(`  First Home Buyer: ${effectiveIsFirstHomeBuyer}`);
          console.log(`  New Build: ${effectiveIsNewBuild}`);
          
          const financialResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/financial-calculator-service`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
              ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
            },
            body: JSON.stringify({
              propertyValue: effectivePurchasePrice,
              deposit: effectiveDepositValue,
              interestRate: effectiveInterestRate,
              loanTerm: effectiveLoanTerm,
              weeklyRent: calcWeeklyRent,
              weeklyRentSource: rentSource,
              state: state,
              propertyType: propertyDetails?.propertyType || 'house',
              isFirstHomeBuyer: effectiveIsFirstHomeBuyer,
              isNewBuild: effectiveIsNewBuild
            })
          });
          
          if (financialResponse.ok) {
            const financialData = await financialResponse.json();
            
            // Merge manual overrides with fresh financial calculations
            if (hasOverrides) {
              console.log('🔀 Merging manual overrides with fresh financial calculations');
              
              // Create a deep copy of financial data
              const mergedFinancials = JSON.parse(JSON.stringify(financialData.data));
              
              // Map flat override keys to nested structure
              const overrideMapping: Record<string, string> = {
                'purchasePrice': 'initialCosts.propertyValue',
                'stampDuty': 'initialCosts.stampDuty',
                'depositValue': 'initialCosts.deposit',
                'loanToValueRatio': 'keyMetrics.lvr',
                'interestRate': 'loanDetails.interestRate',
                'weeklyRent': 'income.weeklyRent',
                'councilRates': 'annualCosts.councilRates',
                'waterRates': 'annualCosts.waterRates',
                'bodyCorporateFees': 'annualCosts.strataFees',
                'buildingLandlordInsurance': 'annualCosts.landlordInsurance',
                'propertyManagementFees': 'annualCosts.propertyManagementPercent',
                'solicitorFees': 'initialCosts.legalFees',
                'repairsMaintenance': 'annualCosts.maintenance',
                'lettingFees': 'annualCosts.lettingFees',
                'capitalGrowth': 'assumptions.capitalGrowth',
                'buildPrice': 'initialCosts.buildPrice',
                'landPrice': 'initialCosts.landPrice',
                'landSizeSqm': 'propertySpecs.landSizeSqm',
                'buildSizeSqm': 'propertySpecs.buildSizeSqm',
                'landTax': 'annualCosts.landTax',
                'depreciation': 'taxBenefits.depreciation',
                'taxRate': 'taxBenefits.marginalTaxRate',
                'occupancyRate': 'assumptions.occupancyWeeks',
                'cpiGrowthRate': 'assumptions.cpiGrowth',
                'loanType': 'loanDetails.loanType',
                'loanAmount': 'loanDetails.loanAmount',
                'interestOnlyPeriodYears': 'loanDetails.interestOnlyPeriod'
              };
              
              // Apply overrides to the nested structure
              for (const [flatKey, overrideValue] of Object.entries(mergedOverrides)) {
                const nestedPath = overrideMapping[flatKey];
                if (nestedPath) {
                  const keys = nestedPath.split('.');
                  let current = mergedFinancials;
                  
                  // Navigate to the nested location
                  for (let i = 0; i < keys.length - 1; i++) {
                    if (!current[keys[i]]) {
                      current[keys[i]] = {};
                    }
                    current = current[keys[i]];
                  }
                  
                  // Set the overridden value
                  current[keys[keys.length - 1]] = overrideValue;
                  console.log(`  ✓ Override applied: ${flatKey} → ${nestedPath} = ${overrideValue}`);
                }
              }
              
              enhancedData = { 
                ...enhancedData, 
                financials: mergedFinancials
              };
              console.log('✓ Manual overrides applied to financial calculations');
            } else {
              enhancedData = { ...enhancedData, financials: financialData.data };
            }
            
            console.log('Financial calculations completed successfully');
            
            // Run validation on financial calculations - USE EFFECTIVE VALUES
            try {
              const validationResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/financial-validation-service`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  // The gateway requires a JWT; verifyAuth uses the separate internal credential.
                  'Authorization': `Bearer ${supabaseAnonKey}`,
                  'x-internal-edge-secret': INTERNAL_EDGE_SECRET,
                  ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
                },
                body: JSON.stringify({
                  propertyValue: effectivePurchasePrice,
                  weeklyRent: effectiveWeeklyRent || weeklyRent,
                  stampDuty: financialData.data.initialCosts.stampDuty,
                  councilRates: financialData.data.annualCosts.councilRates,
                  annualCosts: financialData.data.annualCosts,
                  state: state,
                  propertyType: propertyDetails?.propertyType || 'house'
                })
              });
              
              if (validationResponse.ok) {
                const validationData = await validationResponse.json();
                enhancedData = { ...enhancedData, validation: validationData.data };
                console.log('✓ Financial validation completed:', {
                  qualityScore: validationData.data.qualityScore,
                  flagCount: validationData.data.flags.length
                });
                
                // Log any critical validation errors
                const criticalFlags = validationData.data.flags.filter((f: any) => f.severity === 'critical');
                if (criticalFlags.length > 0) {
                  console.warn('⚠️ CRITICAL validation issues detected:', criticalFlags);
                }
              }
            } catch (validationError: any) {
              console.warn('⚠️ Validation service failed (non-blocking):', validationError?.message);
            }
          }
        } catch (error: any) {
          console.log('Financial calculations failed:', error?.message || 'Unknown error');
        }
      }

      // Fetch location intelligence data
      try {
        console.log('Fetching location intelligence for:', formattedInput);
        const locationResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/location-intelligence-service`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
            ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
          },
          body: JSON.stringify({
            address: formattedInput,
            postcode: postcode,
            state: state
          })
        });
        
        if (locationResponse.ok) {
          const locationData = await locationResponse.json();
          
          if (locationData.success && locationData.data) {
            enhancedData = { ...enhancedData, locationIntelligence: locationData.data };
            console.log('✓ Location intelligence data fetched successfully');
            
            if (locationData.usingMockData) {
              console.warn('⚠️ Using mock location data:', locationData.message);
            }
          } else {
            console.warn('⚠️ Location intelligence returned no data');
          }
        } else {
          const errorText = await locationResponse.text();
          console.error('❌ Location intelligence API error:', locationResponse.status, errorText);
        }
      } catch (error: any) {
        console.error('❌ Location intelligence fetch failed:', error?.message || 'Unknown error');
      }

      // Calculate investment score - property OR area scoring
      if (!isAreaReport && effectivePurchasePrice > 0) {
        // Property-specific scoring
        try {
          console.log('📊 Investment scoring inputs (using effective values):');
          console.log(`  Price: $${effectivePurchasePrice.toLocaleString()}`);
          console.log(`  Weekly Rent: $${effectiveWeeklyRent}`);
          
          const scoreResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/investment-scoring-service`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
              ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
            },
            body: JSON.stringify({
              property: {
                price: effectivePurchasePrice,
                weeklyRent: effectiveWeeklyRent || 0,
                propertyType: propertyDetails?.propertyType || 'house',
                bedrooms: effectiveBeds,
                bathrooms: effectiveBaths
              },
              demographics: enhancedData.demographics,
              locationIntelligence: enhancedData.locationIntelligence,
              financials: enhancedData.financials
            })
          });
          
          if (scoreResponse.ok) {
            const scoreData = await scoreResponse.json();
            if (scoreData?.success && scoreData?.data) {
              enhancedData = { ...enhancedData, investmentScore: scoreData.data };
              console.log('✓ Investment score calculated:', scoreData.data?.grade, scoreData.data?.totalScore);
            } else if (scoreData) {
              enhancedData = { ...enhancedData, investmentScore: scoreData };
              console.log('✓ Investment score (direct):', scoreData?.grade, scoreData?.totalScore);
            }
          } else {
            const errorText = await scoreResponse.text();
            console.error('❌ Investment scoring service error:', scoreResponse.status, errorText);
          }
        } catch (error: any) {
          console.error('❌ Investment score calculation failed:', error?.message || 'Unknown error');
        }
      } else if (isAreaReport) {
        // Area-level scoring (suburb/postcode/statewide)
        const areaScope = queryType === 'suburb' ? 'suburb' : queryType === 'zipcode' ? 'zipcode' : 'state';
        console.log(`📊 Area scoring for scope: ${areaScope} (isAreaReport: ${isAreaReport}, queryType: ${queryType})`);
        console.log(`📊 Area scoring input data - demographics keys: ${Object.keys(enhancedData.demographics || {}).join(', ') || 'NONE'}`);
        console.log(`📊 Area scoring input data - locationIntelligence keys: ${Object.keys(enhancedData.locationIntelligence || {}).join(', ') || 'NONE'}`);
        
        let areaScoreCalculated = false;
        
        // Try service call first
        try {
          const scoreResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/investment-scoring-service`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
              ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
            },
            body: JSON.stringify({
              scope: areaScope,
              demographics: enhancedData.demographics || {},
              locationIntelligence: enhancedData.locationIntelligence || {},
              state: state || undefined
            })
          });
          
          console.log(`📊 Area scoring service response status: ${scoreResponse.status}`);
          
          if (scoreResponse.ok) {
            const scoreData = await scoreResponse.json();
            console.log(`📊 Area scoring response: success=${scoreData?.success}, hasData=${!!scoreData?.data}, grade=${scoreData?.data?.grade}`);
            if (scoreData?.success && scoreData?.data) {
              enhancedData = { ...enhancedData, investmentScore: scoreData.data };
              areaScoreCalculated = true;
              console.log('✓ Area score calculated via service:', scoreData.data?.grade, scoreData.data?.totalScore);
            }
          } else {
            const errorText = await scoreResponse.text();
            console.error('❌ Area scoring service error:', scoreResponse.status, errorText);
          }
        } catch (error: any) {
          console.error('❌ Area scoring service call failed:', error?.message || 'Unknown error');
        }
        
        // FALLBACK: Calculate area score inline if service call failed
        if (!areaScoreCalculated) {
          console.log('📊 Falling back to inline area scoring calculation...');
          try {
            const demographics = enhancedData.demographics || {};
            const locationIntelligence = enhancedData.locationIntelligence || {};
            const marketData = demographics.marketData || {};
            
            // Simple inline area scoring
            let totalScore = 50; // Base score
            const factors: string[] = [];
            const strengths: string[] = [];
            const weaknesses: string[] = [];
            
            // Market momentum (30%)
            let marketScore = 50;
            if (marketData.priceGrowth1Year > 5) { marketScore += 20; strengths.push('Strong price growth'); }
            else if (marketData.priceGrowth1Year < 0) { marketScore -= 20; weaknesses.push('Declining prices'); }
            if (marketData.daysOnMarket < 30) { marketScore += 10; strengths.push('Fast-selling market'); }
            
            // Economic strength (25%)
            let economicScore = 50;
            if (demographics.unemploymentRate < 4) { economicScore += 15; strengths.push('Low unemployment'); }
            else if (demographics.unemploymentRate > 7) { economicScore -= 15; weaknesses.push('High unemployment'); }
            if (demographics.populationGrowth > 1.5) { economicScore += 10; strengths.push('Growing population'); }
            
            // Livability (15%)
            let livabilityScore = 50;
            if (locationIntelligence.walkScore > 70) { livabilityScore += 20; strengths.push('High walkability'); }
            
            // Rental market (15%)
            let rentalScore = 50;
            if (marketData.vacancyRate < 2) { rentalScore += 20; strengths.push('Tight rental market'); }
            else if (marketData.vacancyRate > 5) { rentalScore -= 15; weaknesses.push('High vacancy rate'); }
            
            // Future outlook (15%)
            let futureScore = 50;
            
            totalScore = Math.round(
              marketScore * 0.30 + economicScore * 0.25 + livabilityScore * 0.15 + rentalScore * 0.15 + futureScore * 0.15
            );
            totalScore = Math.max(0, Math.min(100, totalScore));
            
            // Determine grade
            let grade = 'C';
            let recommendation = 'HOLD';
            if (totalScore >= 80) { grade = 'A'; recommendation = 'PRIME SUBURB'; }
            else if (totalScore >= 70) { grade = 'B+'; recommendation = 'STRONG AREA'; }
            else if (totalScore >= 60) { grade = 'B'; recommendation = 'SOLID AREA'; }
            else if (totalScore >= 50) { grade = 'C+'; recommendation = 'HOLD'; }
            else if (totalScore >= 40) { grade = 'C'; recommendation = 'MONITOR'; }
            else { grade = 'D'; recommendation = 'CAUTION'; }
            
            enhancedData = {
              ...enhancedData,
              investmentScore: {
                totalScore,
                grade,
                recommendation,
                scoreType: 'area',
                scope: areaScope,
                breakdown: {
                  marketMomentum: { score: marketScore, weight: 30, details: 'Inline calculation' },
                  economicStrength: { score: economicScore, weight: 25, details: 'Inline calculation' },
                  livability: { score: livabilityScore, weight: 15, details: 'Inline calculation' },
                  rentalMarket: { score: rentalScore, weight: 15, details: 'Inline calculation' },
                  futureOutlook: { score: futureScore, weight: 15, details: 'Inline calculation' },
                },
                strengths,
                weaknesses,
                opportunities: [],
                risks: [],
              }
            };
            console.log('✓ Inline area score calculated:', grade, totalScore);
          } catch (inlineError: any) {
            console.error('❌ Inline area scoring also failed:', inlineError?.message);
          }
        }
        
        console.log(`📊 Final investmentScore after area scoring: ${enhancedData.investmentScore ? 'SET' : 'NULL'} (grade: ${enhancedData.investmentScore?.grade || 'N/A'})`);
      }

      // NOTE: SEIFA, Crime, Employment, and Climate data are now fetched in Phase 1 parallel block above

      // Fetch school data
      if (suburb && state && postcode) {
        try {
          console.log('Fetching school data for:', suburb, state, postcode);
          
          // Extract coordinates from location intelligence if available
          const latitude = enhancedData.locationIntelligence?.coordinates?.lat;
          const longitude = enhancedData.locationIntelligence?.coordinates?.lng;
          
          const schoolResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/school-data-service`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${INTERNAL_EDGE_SECRET}`,
              ...(supabaseAnonKey ? { 'apikey': supabaseAnonKey } : {})
            },
            body: JSON.stringify({ 
              suburb: suburb,
              state: state,
              postcode: postcode,
              latitude: latitude || undefined,
              longitude: longitude || undefined
            })
          });
          
          if (schoolResponse.ok) {
            const schoolData = await schoolResponse.json();
            if (schoolData.success && schoolData.data) {
              enhancedData = { ...enhancedData, schoolData: schoolData.data };
              console.log('✓ School data fetched successfully');
              console.log(`  Found ${schoolData.data.summary?.totalSchools || 0} schools in ${postcode}`);
            }
          }
        } catch (error: any) {
          console.log('School data fetch failed:', error?.message || 'Unknown error');
        }
      }


    } catch (error: any) {
      console.log('Enhanced data fetch failed, proceeding with basic analysis:', error?.message || 'Unknown error');
    }

    // ============================================================================
    // DATA AVAILABILITY SUMMARY - Graceful Degradation Report
    // ============================================================================
    const dataAvailability = {
      demographics: !!enhancedData.demographics,
      economics: !!enhancedData.economics,
      financials: !!enhancedData.financials,
      locationIntelligence: !!enhancedData.locationIntelligence,
      investmentScore: !!enhancedData.investmentScore,
      domainData: !!enhancedData.domainData,
      riskAssessment: !!enhancedData.riskAssessment,
      seifaData: !!enhancedData.seifaData,
      crimeStatistics: !!enhancedData.crimeStatistics,
      employmentData: !!enhancedData.employmentData,
      climateData: !!enhancedData.climateData,
      schoolData: !!enhancedData.schoolData
    };
    
    const availableServices = Object.entries(dataAvailability).filter(([_, v]) => v).map(([k]) => k);
    const unavailableServices = Object.entries(dataAvailability).filter(([_, v]) => !v).map(([k]) => k);
    
    console.log('\n📊 === DATA AVAILABILITY SUMMARY ===');
    console.log(`✅ Available (${availableServices.length}): ${availableServices.join(', ') || 'None'}`);
    console.log(`⚠️ Unavailable (${unavailableServices.length}): ${unavailableServices.join(', ') || 'None'}`);
    console.log(`📈 Data completeness: ${Math.round((availableServices.length / 12) * 100)}%`);
    
    // Circuit breaker status
    if (circuitBreaker.size > 0) {
      console.log('🔴 Circuit breakers active:', Array.from(circuitBreaker.keys()).join(', '));
    }
    console.log('=================================\n');

    // Build year context string for suburb analysis
    let yearContextString = '';
    if (propertyDetails?.dataYearType === 'single' && propertyDetails?.dataYear) {
      yearContextString = `\n\n**CRITICAL DATA YEAR REQUIREMENT:**
Focus the analysis on data from the year ${propertyDetails.dataYear}. All statistics, market data, demographics, and trends should be sourced from or reference ${propertyDetails.dataYear} data where available. Clearly indicate when data from ${propertyDetails.dataYear} is used vs. when more recent or older data is substituted.`;
      console.log('📅 Single year context:', propertyDetails.dataYear);
    } else if (propertyDetails?.dataYearType === 'range' && propertyDetails?.dataYearStart && propertyDetails?.dataYearEnd) {
      yearContextString = `\n\n**CRITICAL DATA YEAR RANGE REQUIREMENT:**
Analyze trends and data spanning from ${propertyDetails.dataYearStart} to ${propertyDetails.dataYearEnd}. 
- Include year-over-year comparisons across this period
- Show growth/decline trends from ${propertyDetails.dataYearStart} to ${propertyDetails.dataYearEnd}
- Compare early period (${propertyDetails.dataYearStart}-${Math.floor((propertyDetails.dataYearStart + propertyDetails.dataYearEnd) / 2)}) vs. recent period (${Math.ceil((propertyDetails.dataYearStart + propertyDetails.dataYearEnd) / 2)}-${propertyDetails.dataYearEnd})
- Clearly label data sources with their respective years
- Highlight significant changes or inflection points within the ${propertyDetails.dataYearEnd - propertyDetails.dataYearStart + 1}-year period`;
      console.log('📅 Year range context:', propertyDetails.dataYearStart, '-', propertyDetails.dataYearEnd);
    }

    // Create enhanced prompt with additional data
    // Suburb-specific prompt for suburb investment analysis
    const suburbPrompt = `You are an expert Australian suburb analyst creating comprehensive suburb investment snapshots.
Your goal is to generate a professional suburb-level investment analysis report.

**SUBURB TO ANALYZE: ${formattedInput}**
${yearContextString}

${propertyDetails ? `Context: ${propertyDetails.propertyType || 'Property'} analysis in this suburb${propertyDetails.landSizeSqm ? `, typical land size: ${propertyDetails.landSizeSqm}m²` : ''}${propertyDetails.buildSizeSqm ? `, typical build size: ${propertyDetails.buildSizeSqm}m²` : ''}` : ''}

**CRITICAL - MANDATORY SUBURB REPORT STRUCTURE:**

Follow this exact structure for suburb-level analysis:

# REPORT TITLE
Suburb Investment Snapshot: [SUBURB NAME], [STATE]

# 1. Location & Profile
- Suburb overview and character
- Distance to CBD/major employment centers (e.g., "12km north of Sydney CBD")
- Statistical areas: SA2, SA3, SA4, LGA
- Suburb type (beachside, urban, suburban, regional)
- Lifestyle description
- Key attractions and features
- Development status and trends

# 2. Property Market Data
**Current Market Snapshot (use most recent data):**

| Property Type | Median Price | Median Rent (Weekly) | Gross Yield | Annual Growth |
|--------------|--------------|---------------------|-------------|---------------|
| Houses | $XXX,XXX | $XXX | X.XX% | +/-X.X% |
| Units | $XXX,XXX | $XXX | X.XX% | +/-X.X% |

**Market Activity:**
| Metric | Houses | Units |
|--------|---------|-------|
| Sales Volume (12 months) | XX | XX |
| Days on Market | XX | XX |
| Stock on Market | XX | XX |
| Vacancy Rate | X.X% | X.X% |

# 3. Market Performance
**5-Year Price Growth:**
| Property Type | 1-Year | 3-Year | 5-Year | Peak Growth Period |
|--------------|--------|--------|--------|-------------------|
| Houses | +/-X.X% | +/-XX.X% | +/-XX.X% | [period] |
| Units | +/-X.X% | +/-XX.X% | +/-XX.X% | [period] |

**Rental Growth History:**
| Property Type | 1-Year | 3-Year | 5-Year |
|--------------|--------|--------|--------|
| Houses | +/-X.X% | +/-XX.X% | +/-XX.X% |
| Units | +/-X.X% | +/-XX.X% | +/-XX.X% |

[Include market cycle analysis and trends]

# 4. Demographics
**Population Statistics:**
| Metric | Value | State Average | National Average |
|--------|-------|---------------|------------------|
| Total Population | XX,XXX | - | - |
| Population Density | XX per km² | XX per km² | XX per km² |
| Population Growth (5yr) | +/-X.X% | +/-X.X% | +/-X.X% |
| Median Age | XX years | XX years | XX years |
| Families with Children | XX.X% | XX.X% | XX.X% |
| Couples without Children | XX.X% | XX.X% | XX.X% |
| Single Occupants | XX.X% | XX.X% | XX.X% |

**Income & Employment:**
| Metric | Value | State Average |
|--------|-------|---------------|
| Median Household Income | $X,XXX/week | $X,XXX/week |
| Median Annual Income | $XX,XXX | $XX,XXX |
| Employment Rate | XX.X% | XX.X% |
| Unemployment Rate | X.X% | X.X% |
| SEIFA Index (IRSAD) | XXX (Decile X) | - |

**Top Industries:**
1. [Industry] - XX.X%
2. [Industry] - XX.X%
3. [Industry] - XX.X%
4. [Industry] - XX.X%
5. [Industry] - XX.X%

# 5. Infrastructure & Amenities
**Education:**
| School Name | Type | Level | Distance | Rating/ICSEA |
|------------|------|-------|----------|--------------|

**Transport:**
| Mode | Details | Access Score |
|------|---------|--------------|
| Train Stations | [names] (XXkm) | XX/100 |
| Bus Routes | XX routes | XX/100 |
| Major Roads | [list] | - |
| CBD Commute | XX mins by [mode] | - |
| Walk Score | XX/100 | - |

**Shopping & Services:**
| Facility Type | Nearest | Distance | Details |
|--------------|---------|----------|---------|
| Shopping Center | [name] | XXkm | [description] |
| Supermarkets | [names] | XXkm | - |
| Cafes/Restaurants | XX+ venues | within XXkm | - |

**Healthcare:**
| Facility | Name | Distance |
|----------|------|----------|
| Hospital | [name] | XXkm |
| Medical Centers | XX facilities | within XXkm |

**Recreation:**
| Facility Type | Count | Details |
|--------------|-------|---------|
| Parks | XX | [names] |
| Beaches | XX | [names] |
| Sports Facilities | XX | [types] |

# 6. Investment Insights
**Market Strengths:**
- [Key advantages for investors]
- [Growth drivers]
- [Demand factors]

**Considerations:**
- [Risks or challenges]
- [Market competition]
- [Supply dynamics]

**Buyer Profile:**
[Who typically buys here and why]

**Rental Demand:**
[Who rents here, typical lease terms, vacancy patterns]

**Capital Growth Outlook:**
[Short and medium term price expectations with reasoning]

**Rental Yield Outlook:**
[Income potential and rental growth expectations]

# 7. Environmental & Risk Factors
| Risk Type | Assessment | Details |
|-----------|-----------|---------|
| Flood Risk | [Low/Medium/High] | [explanation] |
| Bushfire Risk | [Low/Medium/High] | [explanation] |
| Coastal Erosion | [Low/Medium/High] | [explanation if applicable] |
| Climate Risks | [assessment] | [heatwaves, storms, etc.] |

# 8. Crime & Safety
| Metric | Value | Comparison to State |
|--------|-------|-------------------|
| Crime Rate per 100k | XXX | [above/below average] |
| Safety Score | XX/100 | - |
| Trend (3-year) | [Improving/Stable/Worsening] | - |

**Crime Breakdown:**
| Category | Percentage | Trend |
|----------|-----------|-------|

[Include safety commentary]

---

**DATA QUALITY REQUIREMENTS:**
- Use live data where available from ABS, Domain, CoreLogic, state authorities
- Clearly mark estimated or inferred data points
- Include data sources and "as of" dates for all statistics
- Prioritize recent data (last 12 months preferred)

**OUTPUT STYLE:**
- Use markdown tables extensively for data presentation
- Include horizontal rulers (---) between major sections
- Professional, data-driven language
- Specific numbers, percentages, dollar amounts
- Actionable insights for investors
- No code blocks or JSON formatting

Produce a comprehensive suburb investment snapshot following the structure above with specific Australian market data.`;

    // ============================================================================
    // POSTCODE / ZIP CODE ANALYSIS PROMPT
    // ============================================================================
    const postcodePrompt = `You are an expert Australian property market analyst creating comprehensive postcode-zone investment analysis reports.
Your goal is to generate a professional postcode-level analysis covering all suburbs within the zone.

**POSTCODE TO ANALYZE: ${formattedInput}**
${yearContextString}

${propertyDetails ? `Context: ${propertyDetails.propertyType || 'General'} market analysis for this postcode zone` : ''}

**CRITICAL - MANDATORY POSTCODE REPORT STRUCTURE:**

Follow this exact structure for postcode-level analysis:

# REPORT TITLE
Postcode Investment Analysis: ${formattedInput}

# 1. Executive Summary
- Postcode investment thesis
- Key takeaways and overall market assessment

# 2. Zone Profile
- List of all suburbs within this postcode
- LGA(s) and geographic boundaries
- Zone character and overview

# 3. Market Overview
**Aggregated Market Data:**

| Property Type | Median Price | Annual Growth | Gross Yield | DOM |
|--------------|--------------|---------------|-------------|-----|
| Houses | $XXX,XXX | +/-X.X% | X.XX% | XX |
| Units | $XXX,XXX | +/-X.X% | X.XX% | XX |

**Market Activity:**
- Auction clearance rates
- Stock on market levels
- Sales volume trends

# 4. Suburb-by-Suburb Breakdown
| Suburb | Median House Price | Median Unit Price | Annual Growth | Gross Yield | Vacancy Rate | DOM |
|--------|-------------------|-------------------|---------------|-------------|--------------|-----|

[Include ALL suburbs in the postcode with comprehensive data]

**Standout Performers:**
- Identify top-performing suburbs with reasoning

# 5. Price Trends & Growth
**Postcode-Wide Historical Trends:**
| Period | Houses Growth | Units Growth | Metro Average | State Average |
|--------|-------------|-------------|---------------|---------------|
| 1-Year | +/-X.X% | +/-X.X% | +/-X.X% | +/-X.X% |
| 3-Year | +/-XX.X% | +/-XX.X% | +/-XX.X% | +/-XX.X% |
| 5-Year | +/-XX.X% | +/-XX.X% | +/-XX.X% | +/-XX.X% |

# 6. Rental Market
**Aggregate Rental Data:**
| Property Type | Median Weekly Rent | Annual Rent Growth | Vacancy Rate |
|--------------|-------------------|-------------------|--------------|

**Suburb-Level Yield Comparison:**
| Suburb | Median Rent | House Yield | Unit Yield |
|--------|------------|-------------|------------|

# 7. Demographics & Economics
- Population & growth across the zone
- Income & employment data
- Household profile

# 8. Infrastructure & Development
- Major projects & transport upgrades affecting this postcode
- Rezoning & development pipeline
- Impact on property values

# 9. Risk Assessment
- Zone-level hazard mapping (flood, bushfire)
- Market diversification analysis
- Crime & safety overview

# 10. Investment Score & Hotspot Identification
- Zone investment score
- Best value suburbs within the postcode (with data-driven reasoning)
- SWOT Analysis (minimum 8 bullet points per category)

# 11. Disclaimer
[Standard professional disclaimer]

---

**DATA QUALITY REQUIREMENTS:**
- Use live data where available from ABS, Domain, CoreLogic, state authorities
- Clearly mark estimated or inferred data points
- Include data sources and "as of" dates
- Compare against metro and state benchmarks throughout

**OUTPUT STYLE:**
- Use markdown tables extensively
- Include horizontal rulers (---) between major sections
- Professional, data-driven language
- Specific numbers, percentages, dollar amounts
- Actionable insights for investors
- No code blocks or JSON formatting

Produce a comprehensive postcode investment analysis following the structure above with specific Australian market data.`;

    // ============================================================================
    // STATEWIDE ANALYSIS PROMPT
    // ============================================================================
    const statewidePrompt = `You are an expert Australian property market economist creating comprehensive state-level investment analysis reports.
Your goal is to generate a professional statewide market analysis covering macro-economic conditions, regional comparisons, and investment opportunities.

**STATE TO ANALYZE: ${formattedInput}**
${yearContextString}

**CRITICAL - MANDATORY STATEWIDE REPORT STRUCTURE:**

Follow this exact structure for state-level analysis:

# REPORT TITLE
Statewide Investment Analysis: ${formattedInput}

# 1. Executive Summary
- State investment climate summary
- Key takeaways and macro assessment

# 2. State Economic Overview
**Economic Indicators:**
| Metric | Value | National Average | Trend |
|--------|-------|-----------------|-------|
| GSP/GDP Growth | X.X% | X.X% | [trend] |
| Unemployment Rate | X.X% | X.X% | [trend] |
| Population Growth | X.X% | X.X% | [trend] |
| Net Interstate Migration | +/-XX,XXX | - | [trend] |
| Net Overseas Migration | +XX,XXX | - | [trend] |

**Major Industries:**
[Top 5-10 industries by employment share]

# 3. Property Market Overview
**State-Wide Market Data:**
| Property Type | Median Price | Annual Growth | Gross Yield | DOM | Total Listings |
|--------------|--------------|---------------|-------------|-----|----------------|
| Houses | $XXX,XXX | +/-X.X% | X.XX% | XX | XX,XXX |
| Units | $XXX,XXX | +/-X.X% | X.XX% | XX | XX,XXX |

- Auction clearance rates (state average)
- Total listings volume & trend

# 4. Regional Comparison
**Metro vs Regional Performance:**
| Region | Median House Price | Annual Growth | Yield | Vacancy | Population Growth |
|--------|-------------------|---------------|-------|---------|-------------------|

**Top 10 Performing Areas:**
| Rank | Area/Suburb | Median Price | 12-Month Growth | Key Driver |
|------|------------|--------------|-----------------|------------|

**Bottom 10 Performing Areas:**
| Rank | Area/Suburb | Median Price | 12-Month Growth | Key Concern |
|------|------------|--------------|-----------------|-------------|

# 5. Price Trends & Affordability
**State Growth vs National Benchmarks:**
| Period | State Houses | State Units | National Houses | National Units |
|--------|-------------|-------------|-----------------|----------------|
| 1-Year | +/-X.X% | +/-X.X% | +/-X.X% | +/-X.X% |
| 3-Year | +/-XX.X% | +/-XX.X% | +/-XX.X% | +/-XX.X% |
| 5-Year | +/-XX.X% | +/-XX.X% | +/-XX.X% | +/-XX.X% |
| 10-Year | +/-XX.X% | +/-XX.X% | +/-XX.X% | +/-XX.X% |

**Affordability Index:**
[Housing affordability metrics, price-to-income ratios]

# 6. Rental Market
**State Vacancy Rates:**
| Region | Current Vacancy | 12-Month Ago | 5-Year Average |
|--------|----------------|-------------|----------------|

**Rental Growth by Region:**
| Region | Weekly Rent (Houses) | Annual Growth | Weekly Rent (Units) | Annual Growth |
|--------|---------------------|---------------|--------------------|----|

**Rental Yield by Region:**
| Region | House Yield | Unit Yield | State Average |
|--------|------------|------------|---------------|

# 7. Government Policy & Regulation
- Stamp duty thresholds and rates
- Land tax thresholds and rates
- First home buyer schemes and grants
- Planning reforms and zoning changes
- Foreign investment rules (if applicable)

# 8. Infrastructure Pipeline
**Major State Projects:**
| Project | Budget | Completion | Impact Region | Property Impact |
|---------|--------|------------|---------------|-----------------|

**Investment Impact Zones:**
[Areas most likely to benefit from infrastructure spending]

# 9. Risk & Macro Factors
**Interest Rate Sensitivity:**
[Impact of RBA rate changes on state market]

**Supply Pipeline Risk:**
[New housing supply vs demand balance]

**Population Growth Corridors:**
[Where population is heading and property demand implications]

# 10. Investment Hotspots
**Top Opportunity Regions/Suburbs:**
| Rank | Area | Why It's a Hotspot | Entry Price | Growth Forecast | Yield |
|------|------|-------------------|-------------|-----------------|-------|

**Hotspot Reasoning:**
[Detailed data-driven explanation for each hotspot]

**State-Level SWOT Analysis:**
- Strengths (minimum 8 points)
- Weaknesses (minimum 8 points)
- Opportunities (minimum 8 points)
- Threats (minimum 8 points)

# 11. Disclaimer
[Standard professional disclaimer]

---

**DATA QUALITY REQUIREMENTS:**
- Use live data where available from ABS, Domain, CoreLogic, state authorities, RBA
- Compare all metrics against national benchmarks
- Include data sources and "as of" dates
- Focus on macro trends and their property market implications

**OUTPUT STYLE:**
- Use markdown tables extensively for data presentation
- Include horizontal rulers (---) between major sections
- Professional, economist-level language
- Specific numbers, percentages, dollar amounts
- Actionable insights for investors
- No code blocks or JSON formatting

Produce a comprehensive statewide investment analysis following the structure above with specific Australian market data.`;

    // STRICT REFERENCE TEMPLATE - Based on the advisory's Investment Report format
    // This template enforces the exact structure, length, content, and sources matching the reference PDF
    
    // ============================================================================
    // STANDARDIZED PROPERTY TYPE - Consistent terminology throughout report
    // ============================================================================
    const rawPropertyType = propertyDetails?.propertyType?.toLowerCase() || '';
    const isStrataProperty = rawPropertyType.includes('unit') || rawPropertyType.includes('apartment') || 
                            rawPropertyType.includes('flat') || rawPropertyType.includes('townhouse') ||
                            rawPropertyType.includes('villa') || rawPropertyType.includes('studio');
    const standardizedPropertyType = isStrataProperty 
      ? (rawPropertyType.includes('apartment') ? 'Apartment' : 
         rawPropertyType.includes('townhouse') ? 'Townhouse' :
         rawPropertyType.includes('villa') ? 'Villa' :
         rawPropertyType.includes('studio') ? 'Studio Apartment' : 'Unit')
      : (rawPropertyType.includes('house') ? 'House' :
         rawPropertyType.includes('duplex') ? 'Duplex' :
         rawPropertyType || 'Residential Property');
    
    console.log(`🏠 Property Type Standardization: "${rawPropertyType}" → "${standardizedPropertyType}" (isStrata: ${isStrataProperty})`);
    
    // ============================================================================
    // PRE-CALCULATED YIELD VALUES - Recalculated using OVERRIDDEN expense values
    // These values MUST be used exactly in the report, not recalculated by AI
    // ============================================================================
    const effectiveOccupancyRate = mergedOverrides.occupancyRate || 52; // weeks per year
    const annualRentIncome = effectiveWeeklyRent * effectiveOccupancyRate;

    // Coerce potentially string-based overrides to numbers (prevents incorrect totals like "1000" + "1500")
    const toNumberOr = (value: any, fallback: number): number => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const n = parseFloat(String(value));
      return Number.isFinite(n) ? n : fallback;
    };
    
    // Calculate Gross Yield from overridden values
    const preCalculatedGrossYield = effectivePurchasePrice > 0 
      ? ((annualRentIncome / effectivePurchasePrice) * 100).toFixed(2)
      : enhancedData.financials?.keyMetrics?.grossRentalYield || '0.00';
    
    // CRITICAL FIX: Recalculate Net Yield using OVERRIDDEN expense values
    // Net Yield = (Annual Rent - Total Annual Costs) / Purchase Price * 100
    // Extract effective annual costs from merged overrides (use ?? to respect explicit 0)
    const effectiveCouncilRates = toNumberOr(mergedOverrides.councilRates ?? enhancedData.financials?.annualCosts?.councilRates, 2500);
    const effectiveWaterRates = toNumberOr(mergedOverrides.waterRates ?? enhancedData.financials?.annualCosts?.waterRates, 1000);
    const effectiveStrataFees = toNumberOr(mergedOverrides.bodyCorporateFees ?? enhancedData.financials?.annualCosts?.strataFees, 0);
    const effectiveLandlordInsurance = toNumberOr(mergedOverrides.buildingLandlordInsurance ?? enhancedData.financials?.annualCosts?.landlordInsurance, 1800);
    const effectiveMaintenance = toNumberOr(mergedOverrides.repairsMaintenance ?? enhancedData.financials?.annualCosts?.maintenance, 1500);
    const effectiveLandTax = toNumberOr(mergedOverrides.landTax ?? enhancedData.financials?.annualCosts?.landTax, 0);
    const effectivePmPercent = toNumberOr(mergedOverrides.propertyManagementFees ?? enhancedData.financials?.annualCosts?.propertyManagementPercent, 8);
    const effectivePmDollar = Math.round(annualRentIncome * (effectivePmPercent / 100));
    
    // Total annual costs for net yield calculation (excluding land tax per standard practice)
    const totalAnnualCostsForNetYield = effectiveCouncilRates + effectiveWaterRates + effectiveStrataFees + 
      effectiveLandlordInsurance + effectiveMaintenance + effectivePmDollar;
    
    const preCalculatedNetYield = effectivePurchasePrice > 0
      ? (((annualRentIncome - totalAnnualCostsForNetYield) / effectivePurchasePrice) * 100).toFixed(2)
      : enhancedData.financials?.keyMetrics?.netRentalYield || '0.00';
    
    console.log(`📊 Pre-calculated Yields: Gross=${preCalculatedGrossYield}%, Net=${preCalculatedNetYield}%`);
    console.log(`📊 Net Yield Calculation: ($${annualRentIncome} rent - $${totalAnnualCostsForNetYield} costs) / $${effectivePurchasePrice} = ${preCalculatedNetYield}%`);
    console.log(`📊 Annual Costs Breakdown: Council=$${effectiveCouncilRates}, Water=$${effectiveWaterRates}, Strata=$${effectiveStrataFees}, Insurance=$${effectiveLandlordInsurance}, Maintenance=$${effectiveMaintenance}, PM=$${effectivePmDollar}`);
    console.log(`📅 Occupancy: ${effectiveOccupancyRate} weeks/year (${((effectiveOccupancyRate/52)*100).toFixed(0)}%)`);
    console.log(`📊 Land Tax Override: $${effectiveLandTax} (will be injected into prompt)`);
    const _brandPp = await getBrandConfig();
    const propertyPrompt = `You are an expert Australian property investment analyst for ${_brandPp.companyName}.
Your role is to produce comprehensive, professional-grade investment reports following the EXACT structure, length, and format of our reference template.

**CRITICAL CALCULATION RULES:**
1. OCCUPANCY ASSUMPTION: Use 100% occupancy rate (52 weeks per year) for ALL rental income calculations unless explicitly overridden. This is industry standard for investment analysis.
2. YIELD VALUES: Use the pre-calculated yield values provided below EXACTLY - do NOT recalculate or estimate yields.
3. PROPERTY TYPE: Use the standardized property type "${standardizedPropertyType}" consistently throughout the report - never switch terminology.

**PRE-CALCULATED FINANCIAL VALUES (USE THESE EXACTLY - DO NOT RECALCULATE):**
- Gross Rental Yield: ${preCalculatedGrossYield}%
- Net Rental Yield: ${preCalculatedNetYield}%
- Annual Rental Income: $${annualRentIncome.toLocaleString()} (based on ${effectiveOccupancyRate} weeks @ $${effectiveWeeklyRent}/week)
- Occupancy Rate: ${effectiveOccupancyRate} weeks per year (${((effectiveOccupancyRate/52)*100).toFixed(0)}% occupancy)

**PRE-CALCULATED ANNUAL COSTS (USE THESE EXACTLY - DO NOT SUBSTITUTE WITH DEFAULTS):**
- Council Rates: $${effectiveCouncilRates.toLocaleString()}/year
- Water Rates: $${effectiveWaterRates.toLocaleString()}/year
- Strata/Body Corporate: $${effectiveStrataFees.toLocaleString()}/year
- Landlord Insurance: $${effectiveLandlordInsurance.toLocaleString()}/year
- Repairs & Maintenance: $${effectiveMaintenance.toLocaleString()}/year
- Property Management: $${effectivePmDollar.toLocaleString()}/year (${effectivePmPercent}% of rent)
- Land Tax: $${effectiveLandTax.toLocaleString()}/year
- Total Annual Costs (excl. Land Tax): $${totalAnnualCostsForNetYield.toLocaleString()}/year

**PROPERTY ADDRESS TO ANALYZE: ${formattedInput}**

${propertyDetails ? `**Property Details Provided:**
- Price: $${propertyDetails.price?.toLocaleString() || 'Not specified'}
- Weekly Rent: $${propertyDetails.weeklyRent || 'Not specified'}
- Property Type: ${standardizedPropertyType}
- Bedrooms: ${propertyDetails.beds || 'Not specified'}
- Bathrooms: ${propertyDetails.baths || 'Not specified'}
${propertyDetails.landSizeSqm ? `- Land Size: ${propertyDetails.landSizeSqm}m²` : ''}
${propertyDetails.buildSizeSqm ? `- Building Size: ${propertyDetails.buildSizeSqm}m²` : ''}
${propertyDetails.carSpaces ? `- Car Spaces: ${propertyDetails.carSpaces}` : ''}
${propertyDetails.isNewBuild ? `- New Build: Yes` : ''}
${isStrataProperty ? `- Strata Property: Yes (body corporate/strata fees apply)` : ''}` : ''}

---

# ═══════════════════════════════════════════════════════════════════════════════
# MANDATORY REPORT STRUCTURE - 38-PAGE REFERENCE TEMPLATE
# YOU MUST FOLLOW THIS EXACT STRUCTURE, LENGTH, AND FORMAT
# ═══════════════════════════════════════════════════════════════════════════════

---

# Investment Report: [Property Address], [STATE] [POSTCODE]

---

# Executive Summary

**REQUIRED CONTENT (Minimum 400 words for this section):**

This executive summary provides a high-level overview of the investment opportunity at ${formattedInput}.

**Property Snapshot:**

| Attribute | Value |
|-----------|-------|
| Property Address | ${formattedInput} |
| Property Type | ${standardizedPropertyType} |
| Purchase Price | $${effectivePurchasePrice?.toLocaleString() || 'X,XXX,XXX'} |
| Estimated Weekly Rent | $${effectiveWeeklyRent || 'XXX'} |
| Gross Rental Yield | ${preCalculatedGrossYield}% |
| Net Rental Yield | ${preCalculatedNetYield}% |

**Investment Highlights:**

1. **Location Strength:** [Summarize key location advantages - proximity to CBD, transport, schools]
2. **Market Position:** [Current market conditions and growth prospects]
3. **Income Potential:** [Rental yield assessment and demand drivers]
4. **Growth Outlook:** [Capital growth expectations based on market data]

**Key Findings:**

- **Strengths:** [List 2-3 key property/location strengths]
- **Considerations:** [List 2-3 areas requiring investor attention]
- **Overall Assessment:** [Brief investment suitability statement]

**Investment Recommendation:**

Based on our comprehensive analysis, this property is [suitable/moderately suitable/requires careful consideration] for investors seeking [capital growth/rental income/balanced returns]. The investment is best suited for [investor profile description].

---

# Location Overview

**REQUIRED OPENING LINE:** "This investment report analyzes: [FULL PROPERTY ADDRESS]"

**CONTENT REQUIREMENTS (Minimum 500 words for this section):**

[Suburb name] is a [description] community located [XX] kilometres [direction] of [City]'s CBD[citation], positioned within the [District] region of [Metro Area]. The suburb is distinguished by its [key characteristics][citation].

**Geographic Classification:**
- Local Government Area (LGA): [Name] Council
- Statistical Areas: [Suburb] falls within the broader [Area] Statistical Area Level 2 (SA2)

**Suburb Character & Lifestyle:**

[Suburb] presents [description of blend/character]. The suburb features [specific details about streets, properties, land parcels][citation]. A diversity level of [XX.X]% reflects the [description of composition][citation].

The suburb's lifestyle is characterised by:
- **Family-oriented infrastructure:** [Specific facility name] features [detailed list of amenities - courts, fields, parks with exact counts][citation]. [Playground name] offers [specific features including water play, trampolines, shade structures][citation]
- **Parks and green spaces:** [Park 1], [Park 2], and [Park 3] provide [specific amenities][citation]
- **Shopping and dining:** [Shopping centre] and [Secondary centre] host [stores, dining options]. Nearby dining precincts in [Area 1], [Area 2], and [Area 3] offer [cuisine types][citation]

**Employment hubs:**
[Business Park 1] and [Business Park 2] provide significant local job opportunities[citation].

**Public Transport Access:**

A major infrastructure advancement occurred with the opening of [Station Name] in [Year], located at [specific location][citation]. This development has dramatically improved accessibility, providing commuters with access to the [Line Name] through [Connection Station]. The station includes [facilities - car park, bus connections] serving [list of destinations][citation].

**Commute Performance:**
| Metric | Value |
|--------|-------|
| CBD Commute | ${enhancedData.locationIntelligence?.commute?.durationMinutes || 'XX'} minutes via public transit (${enhancedData.locationIntelligence?.commute?.distanceKm || 'XX'} km distance) |
| Public Transport Quality Score | ${enhancedData.locationIntelligence?.transport?.qualityScore || 'XX'}/100 |

The suburb benefits from excellent service frequency, with peak hour services operating at [XX] services per hour and off-peak services at [XX] services per hour across multiple transport modes[citation].

**Population & Development Trends:**

[Suburb] is experiencing [description of growth]. The suburb's future prospects are described as [assessment], with planned infrastructure and residential developments set to [impact]. Population growth is being driven by [factors][citation].

---

# Current Market Performance

| Metric | Value | Data Source |
|--------|-------|-------------|
| Walk Score | ${enhancedData.locationIntelligence?.walkScore || 'XX'}/100 | Location Intelligence Data |
| Public Transport Score | ${enhancedData.locationIntelligence?.transport?.qualityScore || 'XX'}/100 | Location Intelligence Data |

**Market Commentary (150+ words required):**

[Suburb]'s [exceptionally high/moderate/etc.] walk score of [XX]/100 reflects [assessment of pedestrian accessibility]. The [XX]/100 public transport score demonstrates [connectivity assessment]. These metrics underscore the suburb's appeal to [target demographics].

Current market conditions are influenced by the National House Price Growth Rate of [X.X]% (as of [Date]), with [Suburb] positioned to benefit from [demand drivers]. The suburb's inventory includes [property mix description][citation].

---

# Current Economic Context

**VERIFIED ECONOMIC DATA (use these exact figures — sourced ${enhancedData.economics?.retrievedAt ? `on ${new Date(enhancedData.economics.retrievedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}` : 'from latest available data'}):**

| Indicator | Current Value | Source |
|-----------|--------------|--------|
| RBA Cash Rate | ${enhancedData.economics?.cashRate?.current || '4.10'}% | ${enhancedData.economics?.cashRate?.source || 'RBA'} |
| Annual Inflation (CPI) | ${enhancedData.economics?.inflation?.annual || '2.4'}% | ${enhancedData.economics?.inflation?.source || 'ABS'} |
| Core Inflation (Trimmed Mean) | ${enhancedData.economics?.inflation?.core || '2.9'}% | ABS |
| GDP Growth | ${enhancedData.economics?.indicators?.gdpGrowth || '1.3'}% | ABS |
| National Unemployment | ${enhancedData.economics?.indicators?.unemploymentRate || '4.1'}% | ABS Labour Force |

Write 2-3 paragraphs in plain English explaining how the current cash rate of ${enhancedData.economics?.cashRate?.current || '4.10'}% and inflation at ${enhancedData.economics?.inflation?.annual || '2.4'}% affect mortgage costs, borrowing capacity, and property demand in practical terms. Avoid jargon — explain as you would to a client sitting across the table. Connect these macro conditions specifically to the property's local market. Do NOT put a "What This Means" heading or any other commentary label above them.

---

# Demographics & Demand Drivers

**Population & Employment Statistics:**

| Metric | Value | Data Source |
|--------|-------|-------------|
| Labor Force Size | ${enhancedData.demographics?.employment?.laborForce || 'XX,XXX'} | ABS Employment Data |
| Employment Rate | ${enhancedData.demographics?.employment?.employmentRate || 'XX.X'}% | ABS (2025) |
| Unemployment Rate | ${enhancedData.demographics?.income?.unemploymentRate || 'X.X'}% | ABS (2025) |
| Participation Rate | ${enhancedData.demographics?.employment?.laborForceParticipation || 'XX.X'}% | ABS (2025) |
| Median Weekly Income | $${enhancedData.demographics?.income?.medianWeeklyIncome || 'X,XXX'} | ABS (2025) |
| Median Annual Income | $${enhancedData.demographics?.income?.medianHouseholdIncome || 'XX,XXX'} | ABS (2025) |
| Annual Income Growth (last 12 months) | +${enhancedData.demographics?.income?.incomeGrowth || 'X.X'}% | ABS (2025) |

**Socioeconomic Profile (SEIFA Indices):**

| Index | Score | Decile | Rating |
|-------|-------|--------|--------|
| IRSAD | ${enhancedData.seifaData?.irsad?.score || 'XXX'} | ${enhancedData.seifaData?.irsad?.decile || 'X'}/10 | ${enhancedData.seifaData?.irsad?.rating || 'Moderate Advantage'} |
| IRSD | ${enhancedData.seifaData?.irsd?.score || 'XXX'} | ${enhancedData.seifaData?.irsd?.decile || 'X'}/10 | ${enhancedData.seifaData?.irsd?.rating || 'Moderate Disadvantage'} |
| IER | ${enhancedData.seifaData?.ier?.score || 'XXX'} | ${enhancedData.seifaData?.ier?.decile || 'X'}/10 | ${enhancedData.seifaData?.ier?.rating || 'Moderate Education/Occupation'} |
| IEO | ${enhancedData.seifaData?.ieo?.score || 'XXX'} | ${enhancedData.seifaData?.ieo?.decile || 'X'}/10 | ${enhancedData.seifaData?.ieo?.rating || 'Moderate Economic Resources'} |

[Suburb] demonstrates [socioeconomic assessment], positioning the area at [comparative level] across income, education, and occupation dimensions. The IRSAD score of [XXX] (Decile [X]/10) indicates [interpretation]. This socioeconomic profile supports [demand implications].

**Employment & Industry Breakdown:**

| Industry | Workforce % | Growth Rate |
|----------|-------------|-------------|
| Professional Services | ${enhancedData.employmentData?.industries?.[0]?.percentage || 'XX.X'}% | +${enhancedData.employmentData?.industries?.[0]?.growth || 'X.X'}% |
| Healthcare & Social Assistance | ${enhancedData.employmentData?.industries?.[1]?.percentage || 'XX.X'}% | +${enhancedData.employmentData?.industries?.[1]?.growth || 'X.X'}% |
| Retail Trade | ${enhancedData.employmentData?.industries?.[2]?.percentage || 'XX.X'}% | +${enhancedData.employmentData?.industries?.[2]?.growth || 'X.X'}% |
| Education & Training | ${enhancedData.employmentData?.industries?.[3]?.percentage || 'XX.X'}% | +${enhancedData.employmentData?.industries?.[3]?.growth || 'X.X'}% |
| Construction | ${enhancedData.employmentData?.industries?.[4]?.percentage || 'XX.X'}% | +${enhancedData.employmentData?.industries?.[4]?.growth || 'X.X'}% |

**Job Growth Trends:**

| Time Period | Growth Rate | Data Source |
|-------------|-------------|-------------|
| Annual Growth | +${enhancedData.employmentData?.annualGrowth || 'X.X'}% | ABS (2025) |
| 3-Year Growth | +${enhancedData.employmentData?.threeYearGrowth || 'X.X'}% | ABS (2025) |
| 5-Year Growth | +${enhancedData.employmentData?.fiveYearGrowth || 'XX.X'}% | ABS (2025) |

Employment growth has been [assessment], with [XX.X]% cumulative growth over five years. [Leading industry] leads job creation at [X.X]% annual growth, followed by [secondary industry] at [X.X]%. This employment dynamism reflects structural shifts toward [sector types], directly supporting rental demand from workers employed at [nearby employment hubs][citation].

**Demand Drivers (150+ words required):**

The combination of [employment factor], [income factor], and [unemployment factor] creates robust demand for both owner-occupied and rental properties. Population growth is being driven by [demographic groups] attracted to the suburb's [appeal factors]. The suburb attracts [target demographics description].

---

# Schools & Education

**Education Infrastructure Summary:**

| Metric | Value | Data Source |
|--------|-------|-------------|
| Total Schools in Postcode | ${enhancedData.schoolData?.summary?.totalSchools || 'XX'} | Google Places API |
| Average School Rating | ${enhancedData.schoolData?.summary?.averageRating || 'X.X'}/5 stars | Google Places API |
| Education Quality | ${enhancedData.schoolData?.summary?.qualityAssessment || 'Average'} (National Standard) | School Data Analysis |

**Nearest School:**

| School Name | Distance | Type |
|-------------|----------|------|
| ${enhancedData.schoolData?.nearestSchool?.name || '[School Name]'} | ${enhancedData.schoolData?.nearestSchool?.distance || 'X.XX'} km | ${enhancedData.schoolData?.nearestSchool?.type || 'Early Learning'} |

**Top-Rated Schools in Local Area:**

| School Name | Distance | Type |
|-------------|----------|------|
${enhancedData.schoolData?.topSchools?.slice(0, 5).map((s: any) => `| ${s.name} | ${s.distance} km | ${s.type} |`).join('\n') || '| [School 1] | Nearby | Government |'}

**Education Facilities (Extended List):**

| School Name | Distance | Type |
|-------------|----------|------|
${enhancedData.schoolData?.allSchools?.slice(0, 7).map((s: any) => `| ${s.name} | ${s.distance} km | ${s.type} |`).join('\n') || '| [School 1] | X.XX km | Government |'}

**Secondary Education:**

[Secondary school name], the nearest secondary facility, is located [X.X] km distant and rated [X]/5 stars. [Additional schools] provide additional secondary options in the immediate vicinity.

**Education Profile (100+ words required):**

[Suburb] benefits from comprehensive educational coverage with [XX] schools across all levels within the postcode. A diverse range of government and private institutions serve the area, with early learning facilities rated highly (averaging [X.X]/5 stars), making the suburb particularly attractive to families with young children. The availability of quality schools directly supports property demand from families and contributes to capital growth expectations in family-oriented suburbs.

---

# Healthcare & Shopping

**Healthcare Facilities:**

| Category | Facilities Count | Nearest Facility |
|----------|-----------------|------------------|
| Healthcare | ${enhancedData.locationIntelligence?.healthcare?.facilitiesWithin5km || 'XX'} | ${enhancedData.locationIntelligence?.healthcare?.nearestFacility || '[Medical Centre Name]'} |

[Suburb]'s healthcare infrastructure includes [XX] facilities within 5 km, with [Primary facility] as the primary provider just [X.XX] km away. The area benefits from proximity to [hospital description][citation].

**Shopping & Dining Facilities:**

| Category | Facilities Count | Nearest Facility | Distance |
|----------|-----------------|------------------|----------|
| Supermarkets | ${enhancedData.locationIntelligence?.lifestyle?.supermarkets || 'X'} | ${enhancedData.locationIntelligence?.lifestyle?.nearestSupermarket || '[Supermarket Name]'} | X.X km |
| Shopping Centres | ${enhancedData.locationIntelligence?.lifestyle?.shoppingCenters || 'X'} | ${enhancedData.locationIntelligence?.lifestyle?.nearestShopping || '[Shopping Centre]'} | X.X km |
| Restaurants & Cafes | XX | Multiple Precincts | Within X km |

[Shopping centre] serves as the central shopping hub, located [X.XX] km away, offering [stores - supermarkets, specialty stores, dining options][citation]. [Secondary shopping description]. Nearby dining precincts in [Area 1], [Area 2], and [Area 3] extend culinary choices[citation].

---

# Recreational Amenities

**Recreation & Parks:**

| Category | Facilities Count | Nearest Facility | Distance |
|----------|-----------------|------------------|----------|
| Parks & Recreation | ${enhancedData.locationIntelligence?.lifestyle?.parks || 'XX'} | ${enhancedData.locationIntelligence?.lifestyle?.nearestPark || '[Reserve Name]'} | ${enhancedData.locationIntelligence?.lifestyle?.nearestParkDistance || 'X.X'} km |

[Nearest park/reserve] is [location description] at just [X.X] km distance, providing immediate access to local parks and recreational facilities. This [proximity level] to green space enhances the property's appeal for families and health-conscious residents.

**Major Recreational Complexes:**

The [Sports Complex Name] is a premier recreational hub featuring:
- [XX] indoor courts
- [XX] outdoor fields (including [XX] all-weather synthetic fields)
- [XX] netball courts
- [XX] tennis courts
- [XX] cricket pitches
- Dog park
- Walking tracks

[Playground name] at [Complex] offers inclusive recreational amenities with water play areas, trampolines, slides, sandpit, balancing beams, swings, musical instruments, climbing ropes, covered shade areas, and barbecue facilities[citation].

Additional parks include [Park 1] and [Park 2], both offering picnic areas, walking paths, and playgrounds. [Regional Park] provides expansive green spaces, bushwalking trails, and wildlife observation opportunities[citation].

**Amenity Summary:**

[Suburb] delivers exceptional recreational access with [XX] major parks and recreation facilities, including world-class sporting complexes and accessible playgrounds. The immediate proximity of [Reserve] ([X.X] km) to the subject property provides superior outdoor recreation without vehicle dependency.

---

# Transport & Accessibility

**Public Transport Network:**

| Metric | Value | Details |
|--------|-------|---------|
| Walk Score | ${enhancedData.locationIntelligence?.walkScore || 'XX'}/100 | ${enhancedData.locationIntelligence?.walkScore >= 70 ? 'Excellent' : 'Moderate'} pedestrian accessibility |
| Public Transport Score | ${enhancedData.locationIntelligence?.transport?.qualityScore || 'XX'}/100 | ${enhancedData.locationIntelligence?.transport?.qualityScore >= 70 ? 'Excellent' : 'Moderate'} service coverage and frequency |
| CBD Commute Time | ${enhancedData.locationIntelligence?.commute?.durationMinutes || 'XX'} minutes | Via public transit (${enhancedData.locationIntelligence?.commute?.distanceKm || 'XX'} km) |
| Nearest Station | ${enhancedData.locationIntelligence?.transport?.nearestStation || '[Station Name]'} | [Location details] |
| Station Opening | [Year] | Multi-storey car park included |

**Service Frequency & Routes:**
- Peak Hour Service: ${enhancedData.locationIntelligence?.transport?.serviceFrequency?.peak || 'XX'} services/hour
- Off-Peak Service: ${enhancedData.locationIntelligence?.transport?.serviceFrequency?.offPeak || 'XX'} services/hour
- Transport Types: ${enhancedData.locationIntelligence?.transport?.transportTypes?.join(', ') || 'Train, Bus, Light Rail'}
- Primary Lines: [Line names]
- Bus Connections: Services to [destinations list]

**Accessibility Features:**
- Wheelchair accessible facilities
- Lift availability at major stations
- Tactile paving for visually impaired users
- Multiple stop locations within 1 km radius

**Transport Advantages (100+ words required):**

The opening of [Station] in [Year] fundamentally transformed the suburb's transport profile. Direct access to the [Line Name] provides express connectivity to [Major hub] and beyond, with frequent peak-hour services ensuring reliable commuting for professionals. Bus integration provides comprehensive coverage of surrounding business districts and educational centers. The walk score of [XX]/100 indicates residents can accomplish most daily tasks on foot, reducing transport dependency and vehicle ownership costs.

---

# Environmental Risks & Climate

**Climate Profile:**

| Metric | Value | Data Source |
|--------|-------|-------------|
| Climate Zone | ${enhancedData.climateData?.climateZone || 'Temperate'} | Bureau of Meteorology |
| Annual Average Temperature | ${enhancedData.climateData?.temperature?.annual || 'XX.X'}°C | BoM |
| Summer Temperature | ${enhancedData.climateData?.temperature?.summer || 'XX.X'}°C | BoM |
| Winter Temperature | ${enhancedData.climateData?.temperature?.winter || 'XX.X'}°C | BoM |
| Annual Rainfall | ${enhancedData.climateData?.rainfall?.annual || 'X,XXX'} mm | BoM |
| Humidity | ${enhancedData.climateData?.humidity?.annual || 'XX'}% | BoM |

**Extreme Weather Risk Assessment:**

| Risk Type | Assessment | Details |
|-----------|------------|---------|
| Heatwaves | ${enhancedData.riskAssessment?.heatwaveRisk?.level || 'Moderate to High'} | ${enhancedData.riskAssessment?.heatwaveRisk?.description || 'Typical for region; increasing frequency due to climate change'} |
| Bushfire | ${enhancedData.riskAssessment?.bushfireRisk?.level || 'High'} | ${enhancedData.riskAssessment?.bushfireRisk?.description || 'Requires verification with state Rural Fire Service for specific property rating'} |
| Flooding | ${enhancedData.riskAssessment?.floodRisk?.level || 'Moderate'} | ${enhancedData.riskAssessment?.floodRisk?.description || 'General flood information available through council and AFRIP'} |
| Storms | ${enhancedData.riskAssessment?.stormRisk?.level || 'Moderate'} | Thunderstorms and severe weather typical in summer months |
| Cyclones | ${enhancedData.riskAssessment?.cycloneRisk?.level || 'Low'} | Not applicable to inland locations |

**Climate Risk Commentary (150+ words required):**

[Suburb] experiences a [climate zone] climate with [rainfall level] rainfall ([X,XXX] mm annually), concentrated in the [peak months] period. Heatwaves represent a [risk level] risk, consistent with [region description], with potential for increasing frequency due to climate change. Bushfire risk is rated as [level] for [State], though specific property-level risk assessment requires verification with the [State] Rural Fire Service (RFS). Flooding risk is [level]; property-specific flood assessment requires property coordinates and consultation with [Council] or AFRIP.

Long-term climate considerations include potential increases in cooling costs during summer months, possible insurance premium adjustments reflecting bushfire risk, and maintenance implications for properties in high-risk bushfire zones. These factors should be incorporated into long-term ownership cost projections and risk management strategies.

---

# Crime & Safety

**Crime Statistics:**

| Metric | Value | Comparison |
|--------|-------|------------|
| Overall Crime Rating | ${enhancedData.crimeStatistics?.overallRating || 'Medium'} | ${enhancedData.crimeStatistics?.comparedToStateAverage || 'X% higher/lower than state average'} |
| Rate per 100,000 people | ${enhancedData.crimeStatistics?.ratePer100k || 'X,XXX'} | Latest 12 months |
| Safety Score | ${enhancedData.crimeStatistics?.safetyScore || 'XX'}/100 | - |
| Year-on-Year Change | ${enhancedData.crimeStatistics?.yoyChange || '-X.X'}% | - |
| 3-Year Trend | ${enhancedData.crimeStatistics?.threeYearTrend || '-X.X'}% | [Improving/Stable/Worsening] |

**Crime Profile Analysis:**

| Offence Category | Incidents | Percentage |
|-----------------|-----------|------------|
| Property Offences | ${enhancedData.crimeStatistics?.breakdown?.property?.incidents || 'X,XXX'} | ${enhancedData.crimeStatistics?.breakdown?.property?.percentage || 'XX'}% |
| Violent Offences | ${enhancedData.crimeStatistics?.breakdown?.violent?.incidents || 'XXX'} | ${enhancedData.crimeStatistics?.breakdown?.violent?.percentage || 'XX'}% |
| Drug Offences | ${enhancedData.crimeStatistics?.breakdown?.drug?.incidents || 'XXX'} | ${enhancedData.crimeStatistics?.breakdown?.drug?.percentage || 'XX'}% |
| Public Order Offences | ${enhancedData.crimeStatistics?.breakdown?.publicOrder?.incidents || 'X,XXX'} | ${enhancedData.crimeStatistics?.breakdown?.publicOrder?.percentage || 'XX'}% |

[Suburb]'s crime profile reflects typical suburban characteristics, with property offences ([XX]%) representing the largest category, primarily comprising theft, break-and-enter, and motor vehicle theft incidents. Violent offences account for [XX]% of incidents, [comparison to property crimes]. The overall crime rate of [X,XXX] per 100,000 population is approximately [X]% [higher/lower] than the [State] state average; however, the critical positive indicator is the 3-year [direction] trend of [X.X]%, indicating [interpretation].

The year-on-year change of [X.X]% suggests [trend assessment]. The safety score of [XX]/100 positions [Suburb] as a [safety assessment] suburb, consistent with [suburb type] areas. For investment purposes, the [declining/stable/increasing] crime trend is [significance assessment].

**Data Source:** [State] Bureau of Crime Statistics and Research (BOCSAR), [URL]

---

# Property-Level Information

**Property Address:** ${formattedInput}

**Property Characteristics:**

Based on ${documentContent ? 'the provided property listing data' : 'location intelligence and comparable market evidence'} for [Street] properties in [Suburb], ${documentContent ? 'this property exhibits' : 'typical residential properties in this location exhibit'} the following profile:

| Property Characteristic | ${documentContent ? 'Value' : 'Estimated Value'} |
|------------------------|-------|
| Property Type | ${standardizedPropertyType} |
| Land Size | ${effectiveLandSizeSqm ? effectiveLandSizeSqm + ' m²' : 'Estimated XXX-XXX m² (typical for suburb)'} |
| Bedrooms | ${effectiveBeds || 'X (typical for property type)'} |
| Bathrooms | ${effectiveBaths || 'X-X (typical modern standard)'} |
| Parking | ${propertyDetails?.carSpaces || 'X-X spaces'} |
| Year Built | ${propertyDetails?.yearBuilt || 'Estimated XXXX-XXXX'} |
| Condition | ${propertyDetails?.condition || 'Good to excellent'} |
${isStrataProperty ? `| Strata Type | ${standardizedPropertyType} within strata scheme |` : ''}

**${documentContent ? 'Property Price' : 'Estimated Property Value'}:** $${effectivePurchasePrice?.toLocaleString() || 'X,XXX,XXX'} AUD

This valuation reflects typical [Suburb] [property type] prices for [configuration description] on [land description]. The ${documentContent ? 'price' : 'estimate'} is based on the suburb's positioning as [suburb characteristics], and [infrastructure/transport factors].

**Property Position Relative to Market:**

[Suburb] [property type] at this specification typically command [premium/discount] pricing relative to [comparison suburbs] due to [factors]. Properties on [Street] benefit from [specific advantages].

---

# Zoning & Planning Analysis

${hasZoningData ? `**Zoning Classification:**

| Zoning Attribute | Details |
|-----------------|---------|
| Zoning Code | ${effectiveZoningCode || 'Not specified'} |
| Category | ${effectiveZoningDescription || 'Not specified'} |
| Permitted Uses | ${effectivePermittedUses ? effectivePermittedUses.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Standard residential uses'} |
| Development Potential | ${effectiveDevelopmentPotential ? effectiveDevelopmentPotential.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Subject to council approval'} |
| Planning Overlays | ${effectiveZoningOverlays ? effectiveZoningOverlays.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'No significant overlays identified'} |
| Heritage Status | [Confirm heritage overlay status with local council] |
| Conservation Areas | [Identify any environmental conservation restrictions] |

**Development Controls:**

| Control | Value | Investment Implication |
|---------|-------|------------------------|
| Minimum Lot Size | ${effectiveMinimumLotSize ? effectiveMinimumLotSize + ' m²' : 'Refer to LEP'} | [Assess subdivision feasibility] |
| Maximum Building Height | ${effectiveMaximumHeight ? effectiveMaximumHeight + ' m' : 'Refer to LEP'} | [Multi-storey development potential] |
| Floor Space Ratio (FSR) | ${effectiveFloorSpaceRatio ? effectiveFloorSpaceRatio + ':1' : 'Refer to LEP'} | [Maximum buildable area ratio] |
| Site Coverage | [XX]% | [Permissible building footprint] |
| Setbacks (Front) | [X]m | [Building positioning constraints] |
| Setbacks (Side/Rear) | [X]m / [X]m | [Side and rear boundary requirements] |
| Landscaping Requirements | [XX]% minimum | [Green space allocation] |

**Local Environmental Plan (LEP) Analysis:**

The property falls under the [Council Name] Local Environmental Plan [Year]. Key considerations:

- **Principal Permitted Uses:** Dwelling houses, secondary dwellings (granny flats), home occupations, home businesses
- **Uses Requiring Consent:** Dual occupancy, attached dwellings, boarding houses, child care centres
- **Prohibited Uses:** Commercial retail, industrial, intensive agriculture

**Development Control Plan (DCP) Requirements:**

- **Dwelling Design:** Character requirements, articulation, façade treatment
- **Landscaping:** Deep soil zones, tree retention, canopy coverage targets
- **Parking:** Minimum [X] off-street spaces per dwelling
- **Stormwater:** On-site detention requirements, water sensitive urban design
- **Private Open Space:** Minimum [XX]m² principal private open space

**Strategic Planning Context:**

- **Growth Corridor Status:** [Is the area within a designated growth corridor?]
- **Urban Renewal Precinct:** [Proximity to renewal areas with potential upzoning]
- **State Significant Development:** [Any state-level planning schemes affecting the area]
- **Future Rezoning Potential:** [Analysis of strategic planning documents for potential uplift]

**Zoning Investment Implications:**

The ${effectiveZoningCode || 'residential'} zoning ${effectiveDevelopmentPotential && effectiveDevelopmentPotential !== 'none' ? 'provides potential for ' + effectiveDevelopmentPotential.replace(/_/g, ' ') + ', which could enhance long-term investment value through development upside' : 'is typical for the area and supports standard residential use, with limited immediate development potential'}. ${effectiveZoningOverlays && effectiveZoningOverlays !== 'none' ? 'The ' + effectiveZoningOverlays.replace(/_/g, ' ') + ' overlay may impact development options and should be factored into renovation or development plans. Additional consultant reports may be required for development applications.' : 'No significant planning overlays were identified that would restrict standard residential development.'}

${effectivePermittedUses && (effectivePermittedUses.includes('dual') || effectivePermittedUses.includes('secondary') || effectivePermittedUses.includes('multi')) ? `**Value-Add Development Opportunities:**

1. **Secondary Dwelling (Granny Flat):** Subject to lot size requirements, a secondary dwelling up to 60m² could provide rental income of approximately $[XXX]/week
2. **Dual Occupancy Conversion:** If lot size permits, conversion to dual occupancy could increase property value by 30-50%
3. **Subdivision Potential:** [Assess whether lot size supports Torrens title or strata subdivision]

These development options require detailed feasibility analysis and council pre-lodgement consultation.` : ''}

**Planning Risk Assessment:**

| Risk Factor | Assessment | Mitigation Strategy |
|-------------|------------|---------------------|
| Rezoning Risk | Low/Medium/High | Monitor council strategic planning updates |
| Heritage Overlay | [Confirm with council] | Obtain heritage impact assessment if required |
| Bushfire Prone Land | [BAL rating if applicable] | Comply with AS3959 construction standards |
| Flood Affectation | [Check flood maps] | Obtain flood certificate, confirm habitable floor levels |

**Recommendation:** Verify all zoning information with the [Council Name] planning portal before proceeding with any development applications. Obtain a Section 10.7 (formerly Section 149) Planning Certificate for comprehensive zoning confirmation.` : `**Zoning Information:**

Specific zoning data was not provided for this property. For comprehensive investment analysis, verify the following with the local council:

**Planning Certificate Requirements (Section 10.7):**

| Certificate Type | Information Provided |
|-----------------|---------------------|
| Section 10.7(2) | Basic zoning classification |
| Section 10.7(2)+(5) | Comprehensive: all planning restrictions, overlays, development contributions |

**Key Zoning Verification Items:**

1. **Current Zoning Classification:** Confirm zone code (e.g., R2, R3, R4 for residential)
2. **Permitted Land Uses:** Primary and secondary dwelling entitlements
3. **Development Controls:** Height limits, FSR, setbacks, minimum lot size
4. **Planning Overlays:** Heritage, conservation, bushfire, flood, acoustic

**Future Planning Considerations:**

- Review council's Local Strategic Planning Statement (LSPS)
- Check Housing Strategy for density targets
- Identify proximity to nominated urban renewal precincts
- Monitor state government planning initiatives (e.g., transit-oriented development, housing policy changes)

**Development Potential Assessment:**

- **Secondary Dwelling:** Check minimum lot size requirements (typically 450m²)
- **Dual Occupancy:** Assess zoning permissions and lot size requirements
- **Subdivision:** Review minimum lot sizes for new allotments
- **Multi-Unit Development:** Confirm if R3/R4 rezoning potential exists

**Note:** Zoning can significantly impact both development potential and long-term investment value. Strategic rezoning can deliver substantial capital uplift. We strongly recommend obtaining a Section 10.7(2)+(5) Planning Certificate and reviewing the council's strategic planning documents before finalising investment decisions.`}

---

# Purchase & Ongoing Costs (Annual)

**Assumptions:**
- Property Price: $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} AUD
- Deposit: ${100 - effectiveLvr}% = $${effectiveDepositValue?.toLocaleString() || enhancedData.financials?.initialCosts?.deposit?.toLocaleString() || 'XXX,XXX'}
- Loan Amount: $${enhancedData.financials?.initialCosts?.loanAmount?.toLocaleString() || 'X,XXX,XXX'}
- Loan Term: ${effectiveLoanTerm} years
- Interest Rate: ${effectiveInterestRate}%

**Purchase Costs:**

| Cost Category | Amount (AUD) | Calculation Method |
|---------------|--------------|-------------------|
| Property Price | $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} | Reference value |
| Stamp Duty | $${enhancedData.financials?.initialCosts?.stampDuty?.toLocaleString() || 'XX,XXX'} | [State]: [X.XX]% on $[X.XXm] (approximate marginal rate) |
| Legal Fees | $${enhancedData.financials?.initialCosts?.legalFees?.toLocaleString() || '1,200'} | Typical conveyancing costs |
| Building Inspection | $600 | Standard pre-purchase inspection |
| Total Acquisition Cost | $${enhancedData.financials?.initialCosts?.totalUpfront?.toLocaleString() || 'X,XXX,XXX'} | Property + all purchase costs |

**Annual Ongoing Costs:**

| Cost Category | Amount (AUD) | Calculation Method |
|---------------|--------------|-------------------|
| Council Rates | $${effectiveCouncilRates?.toLocaleString() || '2,500'} | Local council rates notice |
| Water Rates | $${effectiveWaterRates?.toLocaleString() || '1,000'} | Estimated based on local water authority |
| Property Management Fee | $${effectivePmDollar?.toLocaleString() || '1,500'} | ${effectivePmPercent}% × annual rent |
| Property Insurance | $${effectiveLandlordInsurance?.toLocaleString() || '1,200'} | Typical comprehensive home insurance |
| Maintenance | $${effectiveMaintenance?.toLocaleString() || '0'} | User-specified maintenance cost |
| Land Tax | $${effectiveLandTax?.toLocaleString() || '0'} | State land tax (pre-calculated) |
| **Total Annual Costs** | **$${(totalAnnualCostsForNetYield + effectiveLandTax)?.toLocaleString() || '0'}** | Sum of ALL ongoing costs |

**Land Tax Calculation (Information Only):**

[State] Land Tax applies to investment properties with aggregated land value exceeding $[threshold]. For a property at $[price] with standard land value allocation (~[XX]% = $[value]), land tax would be approximately: [calculation]. However, for comparative purposes, if threshold exceeded: [X.X]% marginal rate applies to amount over threshold.

Note: Land tax is highly property-specific and depends on aggregated landholding. Recommend consultation with [State] Revenue for accurate calculation.

---

# Rental Assessment & Yield Calculation

**Rental Market Assessment:**

The rental analysis below is based on suburb-level median rental data and the specific property configuration. For detailed comparable rental evidence with specific addresses and lease dates, consult a local property manager or licensed real estate agent.

| Property Type | Estimated Weekly Rent | Annual Rental Income |
|--------------|----------------------|---------------------|
| ${effectiveBeds || 'X'}-Bed ${standardizedPropertyType} | $${effectiveWeeklyRent || (enhancedData.financials?.income?.weeklyRent) || 'XXX'} - $${(effectiveWeeklyRent || enhancedData.financials?.income?.weeklyRent || 0) + 50 || 'XXX'} | $${annualRentIncome.toLocaleString() || 'XX,XXX'} - $${(annualRentIncome + (50 * effectiveOccupancyRate)).toLocaleString() || 'XX,XXX'} |

**Selected Rental Assumption:** $${effectiveWeeklyRent || enhancedData.financials?.income?.weeklyRent || 'XXX'}/week × ${effectiveOccupancyRate} weeks = $${annualRentIncome.toLocaleString() || 'XX,XXX'} annually (${effectiveOccupancyRate === 52 ? '100% occupancy' : `${((effectiveOccupancyRate/52)*100).toFixed(0)}% occupancy`})

**IMPORTANT: All calculations use ${effectiveOccupancyRate} weeks/year occupancy (${((effectiveOccupancyRate/52)*100).toFixed(0)}%). Do NOT interpret this as ${effectiveOccupancyRate}% occupancy - it is ${effectiveOccupancyRate} WEEKS per year.**

**Gross Rental Yield Calculation (USE THESE EXACT VALUES):**

| Metric | Calculation | Value |
|--------|-------------|-------|
| Annual Rental Income | $${effectiveWeeklyRent || enhancedData.financials?.income?.weeklyRent || 'XXX'} × ${effectiveOccupancyRate} weeks | $${annualRentIncome.toLocaleString() || 'XX,XXX'} |
| Property Price | Reference value | $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} |
| **Gross Rental Yield** | **Pre-calculated (DO NOT recalculate)** | **${preCalculatedGrossYield}%** |

**Net Rental Yield Calculation (USE THESE EXACT VALUES):**

| Metric | Calculation | Value |
|--------|-------------|-------|
| Annual Income | $${effectiveWeeklyRent || enhancedData.financials?.income?.weeklyRent || 'XXX'} × ${effectiveOccupancyRate} weeks | $${annualRentIncome.toLocaleString() || 'XX,XXX'} |
| Annual Expenses | Property Mgmt + Maintenance + Rates + Insurance | $${enhancedData.financials?.annualCosts?.totalAnnualExcludingLandTax?.toLocaleString() || 'X,XXX'} |
| Net Annual Return | Income - Expenses | $${(annualRentIncome - (enhancedData.financials?.annualCosts?.totalAnnualExcludingLandTax || 0)).toLocaleString() || 'XX,XXX'} |
| **Net Rental Yield** | **Pre-calculated (DO NOT recalculate)** | **${preCalculatedNetYield}%** |

**Yield Comparison to Benchmarks:**

| Benchmark | Gross Yield | Net Yield | Comparison |
|-----------|-------------|-----------|------------|
| This Property | ${preCalculatedGrossYield}% | ${preCalculatedNetYield}% | - |
| ${suburb || 'Suburb'} Median | [X.XX]% | [X.XX]% | [Above/Below] |
| LGA Average | [X.XX]% | [X.XX]% | [Above/Below] |
| ${state || 'State'} Average | [X.XX]% | [X.XX]% | [Above/Below] |
| National Average | 4.2% | 2.8% | [Above/Below] |

**Yield Commentary:**

The gross rental yield of ${preCalculatedGrossYield}% and net yield of ${preCalculatedNetYield}% reflect typical [Suburb] residential rental returns. These yields are [comparison to other areas]. The [modest/strong] rental yield positioning suggests this property is primarily suitable for investors prioritizing [capital growth/rental income], typical of [suburb characteristics].

---

# Loan Structure & Repayment Analysis

**Loan Assumptions:**
- Loan Amount: $${enhancedData.financials?.initialCosts?.loanAmount?.toLocaleString() || 'X,XXX,XXX'}
- Interest Rate: ${enhancedData.financials?.loanDetails?.interestRate || 6.5}%
- Loan Term: 30 years
- Repayment: Annual calculations

**Principal & Interest Loan (P&I):**

Monthly repayment formula: M = P[r(1+r)^n]/[(1+r)^n-1]

Where:
- P = $${enhancedData.financials?.initialCosts?.loanAmount?.toLocaleString() || 'X,XXX,XXX'}
- r = ${enhancedData.financials?.loanDetails?.interestRate || 6.5}%/12 = ${((enhancedData.financials?.loanDetails?.interestRate || 6.5) / 12 / 100).toFixed(6)} (monthly)
- n = 360 months

| Item | Amount (Annual) | Amount (Monthly) |
|------|-----------------|------------------|
| Principal & Interest Repayment | $${(enhancedData.financials?.loanDetails?.monthlyPayment ? enhancedData.financials.loanDetails.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | $${enhancedData.financials?.loanDetails?.monthlyPayment?.toLocaleString() || 'X,XXX'} |
| Interest Paid (Year 1) | $${(enhancedData.financials?.loanDetails?.interestOnlyPayment ? enhancedData.financials.loanDetails.interestOnlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | $${enhancedData.financials?.loanDetails?.interestOnlyPayment?.toLocaleString() || 'X,XXX'} |
| Principal Repaid (Year 1) | $${((enhancedData.financials?.loanDetails?.monthlyPayment || 0) * 12 - (enhancedData.financials?.loanDetails?.interestOnlyPayment || 0) * 12).toLocaleString() || 'X,XXX'} | $${((enhancedData.financials?.loanDetails?.monthlyPayment || 0) - (enhancedData.financials?.loanDetails?.interestOnlyPayment || 0)).toLocaleString() || 'XXX'} |

Note: Blended calculation for annual presentation; actual P&I repayments decline monthly as principal portion increases.

**Interest-Only Loan (First 5 Years):**

| Item | Amount (Annual) | Amount (Monthly) |
|------|-----------------|------------------|
| Interest-Only Repayment | $${(enhancedData.financials?.loanDetails?.interestOnlyPayment ? enhancedData.financials.loanDetails.interestOnlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | $${enhancedData.financials?.loanDetails?.interestOnlyPayment?.toLocaleString() || 'X,XXX'} |

---

# Cashflow Analysis

**Cashflow Analysis - Principal & Interest Scenario (Year 1):**

| Item | Amount (AUD) |
|------|--------------|
| Gross Rental Income (${effectiveOccupancyRate} weeks @ $${effectiveWeeklyRent}/wk) | $${annualRentIncome.toLocaleString() || 'XX,XXX'} |
| Less: P&I Loan Repayment | ($${(enhancedData.financials?.loanDetails?.monthlyPayment ? enhancedData.financials.loanDetails.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'}) |
| Less: Council Rates | ($${effectiveCouncilRates?.toLocaleString() || enhancedData.financials?.annualCosts?.councilRates?.toLocaleString() || 'X,XXX'}) |
| Less: Water Rates | ($${effectiveWaterRates?.toLocaleString() || enhancedData.financials?.annualCosts?.waterRates?.toLocaleString() || 'XXX'}) |
| Less: Property Management (${effectivePmPercent}%) | ($${effectivePmDollar?.toLocaleString() || enhancedData.financials?.annualCosts?.propertyManagement?.toLocaleString() || 'X,XXX'}) |
| Less: Insurance | ($${effectiveLandlordInsurance?.toLocaleString() || enhancedData.financials?.annualCosts?.landlordInsurance?.toLocaleString() || '1,200'}) |
| Less: Maintenance | ($${effectiveMaintenance?.toLocaleString() || '0'}) |
${isStrataProperty ? `| Less: Body Corporate/Strata | ($${effectiveStrataFees?.toLocaleString() || enhancedData.financials?.annualCosts?.bodyCorporate?.toLocaleString() || mergedOverrides.bodyCorporateFees?.toLocaleString() || '3,000'}) |` : ''}
| **Net Cashflow Before Tax** | **($${Math.abs(enhancedData.financials?.keyMetrics?.annualNet || 0).toLocaleString() || 'XX,XXX'})** |

**Cashflow Analysis - Interest-Only Scenario (Year 1):**

| Item | Amount (AUD) |
|------|--------------|
| Gross Rental Income (${effectiveOccupancyRate} weeks @ $${effectiveWeeklyRent}/wk) | $${annualRentIncome.toLocaleString() || 'XX,XXX'} |
| Less: Interest-Only Repayment | ($${(enhancedData.financials?.loanDetails?.interestOnlyPayment ? enhancedData.financials.loanDetails.interestOnlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'}) |
| Less: Council Rates | ($${effectiveCouncilRates?.toLocaleString() || enhancedData.financials?.annualCosts?.councilRates?.toLocaleString() || 'X,XXX'}) |
| Less: Water Rates | ($${effectiveWaterRates?.toLocaleString() || enhancedData.financials?.annualCosts?.waterRates?.toLocaleString() || 'XXX'}) |
| Less: Property Management (${effectivePmPercent}%) | ($${effectivePmDollar?.toLocaleString() || enhancedData.financials?.annualCosts?.propertyManagement?.toLocaleString() || 'X,XXX'}) |
| Less: Insurance | ($${effectiveLandlordInsurance?.toLocaleString() || enhancedData.financials?.annualCosts?.landlordInsurance?.toLocaleString() || '1,200'}) |
| Less: Maintenance | ($${effectiveMaintenance?.toLocaleString() || '0'}) |
${isStrataProperty ? `| Less: Body Corporate/Strata | ($${effectiveStrataFees?.toLocaleString() || enhancedData.financials?.annualCosts?.bodyCorporate?.toLocaleString() || mergedOverrides.bodyCorporateFees?.toLocaleString() || '3,000'}) |` : ''}
| **Net Cashflow Before Tax** | **($${Math.abs((enhancedData.financials?.keyMetrics?.annualNet || 0) - ((enhancedData.financials?.loanDetails?.monthlyPayment || 0) - (enhancedData.financials?.loanDetails?.interestOnlyPayment || 0)) * 12).toLocaleString() || 'XX,XXX'})** |

**IMPORTANT NOTE:** Gross Rental Income assumes ${effectiveOccupancyRate} weeks per year occupancy (${((effectiveOccupancyRate/52)*100).toFixed(0)}%), which is industry standard for investment analysis.

**Cashflow Commentary (150+ words required):**

Both P&I and Interest-Only loan structures produce negative cash flow in Year 1, with the property requiring approximately $[XX,XXX] annually (P&I) or $[XX,XXX] annually (IO) in additional investor capital. This negative cashflow is typical for established suburbs where rental yields lag loan serviceability costs. The investor must be positioned to cover this annual shortfall, or alternatively, factor capital growth appreciation as the primary return driver.

The P&I scenario provides superior long-term economics as principal repayment builds equity, while the Interest-Only scenario maximizes tax deductibility of interest expense during the IO period but offers no principal reduction.

---

# Sensitivity Analysis

**Impact of Interest Rate Variations on Annual Cashflow (P&I Scenario):**

| Scenario | Interest Rate | Annual Loan Repayment | Annual Cashflow |
|----------|---------------|----------------------|-----------------|
| Stress Case | ${(enhancedData.financials?.loanDetails?.interestRate || 6.5) + 1}% (+1.0%) | $${(enhancedData.financials?.sensitivityAnalysis?.interestRateUp?.monthlyPayment ? enhancedData.financials.sensitivityAnalysis.interestRateUp.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | ($${Math.abs(enhancedData.financials?.sensitivityAnalysis?.interestRateUp?.annualNet || 0).toLocaleString() || 'XX,XXX'}) |
| Base Case | ${enhancedData.financials?.loanDetails?.interestRate || 6.5}% | $${(enhancedData.financials?.loanDetails?.monthlyPayment ? enhancedData.financials.loanDetails.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | ($${Math.abs(enhancedData.financials?.keyMetrics?.annualNet || 0).toLocaleString() || 'XX,XXX'}) |
| Improvement Case | ${(enhancedData.financials?.loanDetails?.interestRate || 6.5) - 1}% (-1.0%) | $${(enhancedData.financials?.sensitivityAnalysis?.interestRateDown?.monthlyPayment ? enhancedData.financials.sensitivityAnalysis.interestRateDown.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} | ($${Math.abs(enhancedData.financials?.sensitivityAnalysis?.interestRateDown?.annualNet || 0).toLocaleString() || 'XX,XXX'}) |

**Sensitivity Commentary (150+ words required):**

A 1% increase in interest rate (to [X.X]%) would increase annual loan repayments by $[X,XXX], pushing negative cashflow to approximately ($[XX,XXX]), requiring significantly higher investor capital contributions. Conversely, a 1% decrease in rates (to [X.X]%) would reduce annual repayments to $[XX,XXX], improving the negative cashflow position to ($[XX,XXX]).

This sensitivity analysis demonstrates that the property's cashflow profile is interest-rate sensitive. In a rising-rate environment, negative cashflow pressures intensify, requiring investors to have substantial capital reserves. The property is fundamentally a capital growth play, not a cashflow-positive investment, making it unsuitable for investors dependent on rental income to service debt.

---

# 10-Year Investment Projections

**Projection Assumptions:**
- Conservative Scenario: 2% annual price growth, 2% annual rent growth
- Base Case Scenario: 4% annual price growth, 3% annual rent growth
- Optimistic Scenario: 6% annual price growth, 4% annual rent growth

**Annual Operating Costs Projections (AUD):**

The following table shows year-by-year escalation of operating costs assuming CPI growth of 2.5% annually.

| Year | Council Rates | Water Rates | Insurance | Land Tax | Maintenance | Property Mgmt | Total |
|------|--------------|-------------|-----------|----------|-------------|---------------|-------|
| 1 | $${effectiveCouncilRates?.toLocaleString() || '2,500'} | $${effectiveWaterRates?.toLocaleString() || '1,000'} | $${effectiveLandlordInsurance?.toLocaleString() || '1,800'} | $${effectiveLandTax?.toLocaleString() || '0'} | $${effectiveMaintenance?.toLocaleString() || '0'} | $${effectivePmDollar?.toLocaleString() || '1,500'} | $${((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveLandTax || 0) + (effectiveMaintenance || 0) + (effectivePmDollar || 0)).toLocaleString()} |
| 2 | $${Math.round((effectiveCouncilRates || 2500) * 1.025).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.025).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.025).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.025).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.02).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.025 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.02).toLocaleString()} |
| 3 | $${Math.round((effectiveCouncilRates || 2500) * 1.051).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.051).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.051).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.051).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.04).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.051 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.04).toLocaleString()} |
| 4 | $${Math.round((effectiveCouncilRates || 2500) * 1.077).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.077).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.077).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.077).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.06).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.077 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.06).toLocaleString()} |
| 5 | $${Math.round((effectiveCouncilRates || 2500) * 1.104).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.104).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.104).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.104).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.08).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.104 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.08).toLocaleString()} |
| 6 | $${Math.round((effectiveCouncilRates || 2500) * 1.131).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.131).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.131).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.131).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.10).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.131 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.10).toLocaleString()} |
| 7 | $${Math.round((effectiveCouncilRates || 2500) * 1.159).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.159).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.159).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.159).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.12).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.159 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.12).toLocaleString()} |
| 8 | $${Math.round((effectiveCouncilRates || 2500) * 1.188).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.188).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.188).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.188).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.14).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.188 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.14).toLocaleString()} |
| 9 | $${Math.round((effectiveCouncilRates || 2500) * 1.218).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.218).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.218).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.218).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.16).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.218 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.16).toLocaleString()} |
| 10 | $${Math.round((effectiveCouncilRates || 2500) * 1.249).toLocaleString()} | $${Math.round((effectiveWaterRates || 1000) * 1.249).toLocaleString()} | $${Math.round((effectiveLandlordInsurance || 1800) * 1.249).toLocaleString()} | $${(effectiveLandTax || 0).toLocaleString()} | $${Math.round((effectiveMaintenance || 0) * 1.249).toLocaleString()} | $${Math.round((effectivePmDollar || 1500) * 1.18).toLocaleString()} | $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.249 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.18).toLocaleString()} |

**Operating Costs Analysis:**

Annual operating costs escalate from $${((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveLandTax || 0) + (effectiveMaintenance || 0) + (effectivePmDollar || 0)).toLocaleString()} in Year 1 to approximately $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.249 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.18).toLocaleString()} in Year 10, representing cumulative increase of approximately 21.4% over the period. This escalation is driven by CPI-linked increases in council rates, insurance premiums, and property management fees.

**Property Value Projections (AUD):**

| Year | Conservative (2%) | Base Case (4%) | Optimistic (6%) |
|------|-------------------|----------------|-----------------|
| 0 | $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} | $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} | $${effectivePurchasePrice?.toLocaleString() || (enhancedData.financials?.initialCosts?.propertyValue?.toLocaleString()) || 'X,XXX,XXX'} |
${enhancedData.financials?.projections?.conservative ? enhancedData.financials.projections.conservative.slice(0, 10).map((p: any, i: number) => 
`| ${i + 1} | $${p.propertyValue?.toLocaleString() || 'X,XXX,XXX'} | $${enhancedData.financials?.projections?.moderate?.[i]?.propertyValue?.toLocaleString() || 'X,XXX,XXX'} | $${enhancedData.financials?.projections?.optimistic?.[i]?.propertyValue?.toLocaleString() || 'X,XXX,XXX'} |`
).join('\n') : '| 1-10 | [Calculate based on growth rates] | [Calculate based on growth rates] | [Calculate based on growth rates] |'}

**Rental Income Projections (Annual - AUD):**

| Year | Conservative (2%) | Base Case (3%) | Optimistic (4%) |
|------|-------------------|----------------|-----------------|
${enhancedData.financials?.projections?.conservative ? enhancedData.financials.projections.conservative.slice(0, 10).map((p: any, i: number) => 
`| ${i + 1} | $${p.annualRent?.toLocaleString() || 'XX,XXX'} | $${enhancedData.financials?.projections?.moderate?.[i]?.annualRent?.toLocaleString() || 'XX,XXX'} | $${enhancedData.financials?.projections?.optimistic?.[i]?.annualRent?.toLocaleString() || 'XX,XXX'} |`
).join('\n') : '| 1-10 | [Calculate based on rent growth] | [Calculate based on rent growth] | [Calculate based on rent growth] |'}

**Cumulative Cashflow Projections (10 Years - AUD):**

Cashflow = Annual Rental Income - Annual Operating Costs - Annual Loan Repayments

**Annual Operating Costs (excluding loan repayment):** $${enhancedData.financials?.annualCosts?.totalAnnualExcludingLandTax?.toLocaleString() || 'X,XXX'} Year 1, escalating to $${Math.round(((effectiveCouncilRates || 0) + (effectiveWaterRates || 0) + (effectiveLandlordInsurance || 0) + (effectiveMaintenance || 0)) * 1.249 + (effectiveLandTax || 0) + (effectivePmDollar || 0) * 1.18).toLocaleString()} Year 10 (as detailed in table above)

**Annual P&I Repayment:** $${(enhancedData.financials?.loanDetails?.monthlyPayment ? enhancedData.financials.loanDetails.monthlyPayment * 12 : 0).toLocaleString() || 'XX,XXX'} Year 1 (declining to $${Math.round((enhancedData.financials?.loanDetails?.monthlyPayment || 0) * 12 * 0.95).toLocaleString()} Year 10 as interest component decreases and principal portion increases through amortization)

| Year | Conservative (2%) | Base Case (3%) | Optimistic (4%) |
|------|-------------------|----------------|-----------------|
${enhancedData.financials?.projections?.conservative ? enhancedData.financials.projections.conservative.slice(0, 10).map((p: any, i: number) => 
`| ${i + 1} | ($${Math.abs(p.cashFlow || 0).toLocaleString()}) | ($${Math.abs(enhancedData.financials?.projections?.moderate?.[i]?.cashFlow || 0).toLocaleString()}) | ($${Math.abs(enhancedData.financials?.projections?.optimistic?.[i]?.cashFlow || 0).toLocaleString()}) |`
).join('\n') : '| 1-10 | [Calculate] | [Calculate] | [Calculate] |'}
| **10-Year Total** | **($${Math.abs(enhancedData.financials?.projections?.conservative?.reduce((sum: number, p: any) => sum + (p.cashFlow || 0), 0) || 0).toLocaleString() || 'XXX,XXX'})** | **($${Math.abs(enhancedData.financials?.projections?.moderate?.reduce((sum: number, p: any) => sum + (p.cashFlow || 0), 0) || 0).toLocaleString() || 'XXX,XXX'})** | **($${Math.abs(enhancedData.financials?.projections?.optimistic?.reduce((sum: number, p: any) => sum + (p.cashFlow || 0), 0) || 0).toLocaleString() || 'XXX,XXX'})** |

**Projected Loan-to-Value Ratio (LVR) - Year 10:**

Loan Balance at Year 10: Approximately $[XXX,XXX] (declining from initial $${enhancedData.financials?.initialCosts?.loanAmount?.toLocaleString() || 'X,XXX,XXX'})

| Scenario | Year 10 Property Value | Loan Balance | LVR |
|----------|------------------------|--------------|-----|
| Conservative (2%) | $${enhancedData.financials?.projections?.conservative?.[9]?.propertyValue?.toLocaleString() || 'X,XXX,XXX'} | $${enhancedData.financials?.projections?.conservative?.[9]?.loanBalance?.toLocaleString() || 'XXX,XXX'} | ${enhancedData.financials?.projections?.conservative?.[9]?.lvr || 'XX'}% |
| Base Case (4%) | $${enhancedData.financials?.projections?.moderate?.[9]?.propertyValue?.toLocaleString() || 'X,XXX,XXX'} | $${enhancedData.financials?.projections?.moderate?.[9]?.loanBalance?.toLocaleString() || 'XXX,XXX'} | ${enhancedData.financials?.projections?.moderate?.[9]?.lvr || 'XX'}% |
| Optimistic (6%) | $${enhancedData.financials?.projections?.optimistic?.[9]?.propertyValue?.toLocaleString() || 'X,XXX,XXX'} | $${enhancedData.financials?.projections?.optimistic?.[9]?.loanBalance?.toLocaleString() || 'XXX,XXX'} | ${enhancedData.financials?.projections?.optimistic?.[9]?.lvr || 'XX'}% |

**10-Year Projection Commentary (200+ words required):**

The conservative scenario (2% growth) produces a Year 10 Property Value of $[X,XXX,XXX] representing cumulative Capital Growth of [XX]%. The LVR declines to [XX]% through principal repayment, though the property remains [leverage assessment].

The base case scenario (4% growth) delivers Year 10 value of $[X,XXX,XXX], producing substantial capital appreciation of $[XXX,XXX] ([XX.X]%). LVR declines to [XX]%, reflecting healthy equity accumulation through both property appreciation and loan reduction.

The optimistic scenario (6% growth) projects Year 10 value of $[X,XXX,XXX], with capital gains of $[X,XXX,XXX] ([XX.X]%). LVR declines to [XX]%, indicating strong equity position and reduced leverage.

**Cumulative Cashflow:** All scenarios produce negative cumulative cashflow over the 10-year period, ranging from ($[XXX,XXX]) in the conservative case to ($[XXX,XXX]) in the optimistic case. This negative cashflow is offset by capital appreciation, making the investment viable only for investors capable of sustaining annual shortfalls and targeting long-term wealth accumulation through capital growth rather than rental income.

**Critical Insight:** This property is fundamentally structured as a Capital Growth investment, with [X]% annual property appreciation expectations, with rental income insufficient to cover debt servicing costs.

---

# Investment Score Analysis

**CRITICAL NOTE:** ${documentContent ? 'Analysis based on provided property data and market research.' : 'Insufficient comparable market data and recent sales analysis specific to this property may prevent calculation of a precise investment score. The following analysis is based on suburb-level characteristics and general market positioning.'}

**Investment Grade:** ${enhancedData.investmentScore?.grade || 'B'} (${documentContent ? 'Based on property analysis' : 'Based on suburb fundamentals - requires property-specific assessment'})

**Total Score:** ${enhancedData.investmentScore?.totalScore || 'XX'}/100

**Recommendation:** ${enhancedData.investmentScore?.recommendation || 'HOLD'} ${documentContent ? '' : 'with caution pending property-specific verification'}

**Score Breakdown:**

| Component | Weight (%) | Score (/100) |
|-----------|------------|--------------|
| Growth Score | 30% | ${enhancedData.investmentScore?.breakdown?.growthScore?.score || 'XX'} |
| Location Score | 25% | ${enhancedData.investmentScore?.breakdown?.locationScore?.score || 'XX'} |
| Yield Score | 20% | ${enhancedData.investmentScore?.breakdown?.yieldScore?.score || 'XX'} |
| Demand Score | 15% | ${enhancedData.investmentScore?.breakdown?.demandScore?.score || 'XX'} |
| Risk Score | 10% | ${enhancedData.investmentScore?.breakdown?.riskScore?.score || 'XX'} |

---

# SWOT Analysis

**Strengths (Minimum 10 bullet points required, each with 2-3 sentence explanation):**

- **Exceptional location:** Walk score of [XX]/100 provides pedestrian accessibility without car dependency. This reduces transport costs and enhances lifestyle convenience for residents.
- **Metro connectivity:** [Metro Line] opened [Year], fundamentally improving transport profile and CBD commute time to [XX] minutes. This infrastructure investment typically drives long-term capital growth.
- **Education infrastructure:** [XX] schools within postcode, with multiple highly-rated early learning facilities ([X.X] stars), supporting family demand. Quality schools are a primary driver of family property purchases.
- **Employment dynamics:** Strong job growth (+[X.X]% annually, +[XX.X]% over 5 years) across professional services, healthcare, and education sectors. Employment growth directly correlates with housing demand.
- **Population growth drivers:** Family-friendly positioning, quality schools, modern recreational facilities, and improved transport creating sustained rental and owner-occupier demand.
- **Demographic alignment:** Employment rate [XX.X]%, unemployment [X.X]%, median income $[XX,XXX], supporting strong renter and buyer demand.
- **Safety trends:** Crime [declining/stable] [X.X]% over 3 years despite moderate overall crime rating. Improving safety metrics support capital appreciation.
- **Proximity to green space:** [Reserve/Park] immediately adjacent ([X.X] km) to subject property. Green space proximity enhances property values and lifestyle appeal.
- **Established suburb:** Mature residential area with well-maintained properties and established community infrastructure. Established suburbs typically offer more stable capital growth.
- **[Additional strength based on property specifics]**

**Weaknesses (Minimum 10 bullet points required, each with 2-3 sentence explanation):**

- **Weak rental yield:** Gross yield [X.XX]%, net yield [X.XX]% insufficient to cover loan serviceability; requires investor capital support. This is typical for growth-focused suburbs but requires careful financial planning.
- **Negative cashflow:** Year 1 cashflow negative $[XX,XXX] (P&I) or ($[XX,XXX]) (IO), with cumulative 10-year shortfalls of ($[XXX,XXX]) to ($[XXX,XXX]). Investors must have stable income to sustain this commitment.
- **Interest rate sensitivity:** [X]% rate rise increases annual cashflow deficit by $[X,XXX]; vulnerable in tightening rate environment. Rising rates could strain investor cash reserves.
- **Environmental risks:** [High/Moderate] bushfire risk rating requires verification; flood risk assessment pending property-specific analysis. Environmental risks may impact insurance costs.
- **Market valuation:** Estimated $[X,XXX,XXX] price point reflects premium positioning relative to [comparison] suburbs; capitalizes growth expectations. Premium pricing reduces margin for error.
- **Leverage structure:** 20% deposit requires $[X,XXX,XXX] loan financing; LVR declines [slowly/moderately] over 10-year period. High leverage amplifies both gains and losses.
- **Rent growth constraints:** Rental income growing [X-X]% annually insufficient to improve cashflow economics; persistent shortfall across projections.
- **Premium pricing:** High purchase price relative to rental income suggests limited margin for economic downturns or rental market compression.
- **Demand concentration:** Market appeal primarily to families; reduces buyer base diversity and increases exposure to family-formation demographic shifts.
- **[Additional weakness based on property specifics]**

**Opportunities (Minimum 10 bullet points required, each with 2-3 sentence explanation):**

- **Capital appreciation:** Base case [X]% annual growth produces $[XXX,XXX] capital gains over 10 years; optimistic case delivers $[X,XXX,XXX] gains. Leverage amplifies returns on investor equity.
- **Debt reduction:** Principal repayment over 30-year term builds equity; loan balance declining $[XXX,XXX] over 10 years creates wealth accumulation. This is forced savings discipline.
- **Rental income growth:** Conservative [X-X]% annual rent increases provide inflation hedge; Year 10 rental income reaching $[XX,XXX]-$[XX,XXX] annually.
- **Interest rate improvement:** Current [X.XX]% rate provides potential for downward movement; 1% decline improves cashflow by $[X,XXX] annually.
- **Infrastructure development:** Planned residential and commercial developments in [Suburb] region support continued population growth and property appreciation.
- **Employment expansion:** Continued job growth in healthcare (+[X.X]%), professional services (+[X.X]%), and education creates sustained demand for rental properties.
- **Family lifecycle demand:** Strong family positioning attracts growing cohort of families seeking suburban education and lifestyle amenities.
- **Leverage amplification:** Capital appreciation on $[X.XX]m asset magnified through 80% financing; [X]% price growth on fully-leveraged position produces enhanced returns relative to deposit.
- **Tax deductibility:** Interest expense on investment property fully tax-deductible, improving after-tax cashflow position for investors in higher tax brackets.
- **Equity release optionality:** Accumulated equity over 10 years ($[XXX]k-$[XXX]k depending on growth scenario) enables future capital access for portfolio expansion.

**Threats (Minimum 10 bullet points required, each with 2-3 sentence explanation):**

- **Interest rate increases:** [X]%+ rates creating ($[XX,XXX]) annual cashflow deficit. Rising rates reduce affordability and may suppress property values.
- **Rental market softening:** Oversupply in [Suburb] rental market could compress yields below [X.XX]%; downward rent pressure prevents cashflow improvement.
- **Economic recession:** Economic downturn could suppress both capital growth and rental demand; [X]% growth vulnerable if growth turns negative.
- **Property price correction:** Outer suburbs exposed to correction risk if interest rates remain elevated; premium valuation relative to yield vulnerable to repricing.
- **Bushfire risk:** High bushfire rating may increase insurance costs, trigger evacuation requirements, or result in property damage requiring major repairs.
- **Flood risk:** Pending flood assessment could reveal constraints on insurability, lender appetite, or future development rights.
- **Family demographic shift:** Aging population or migration patterns could reduce demand from family cohorts, decreasing rental pool and owner-occupier competition.
- **Transport demand saturation:** Metro line usage may not meet projections; reduced commuter demand could moderate capital growth expectations.
- **Regulatory changes:** Negative gearing restrictions, capital gains tax changes, or rental price controls could impact investment economics.
- **Concentration risk:** Portfolio overly exposed to [region] family suburbs; lacks geographic diversification of capital.

**SWOT Analysis Summary (200+ words required):**

This is a summary of the Strengths, Weaknesses, Opportunities, and Threats analyzed above. Investors should consider these factors holistically when making their investment decision.

---

**Note: The following Strategic Assessment, Investment Opportunities, and Investment Risks are detailed subsections of Property-Level Information above. They provide property-specific strategic analysis.**

### Strategic Assessment

The [Property Address] investment presents a growth-focused opportunity suitable for investors with long-term capital, capacity to absorb negative cashflow, and confidence in [X-X]% annual [City] property appreciation. The property is structurally unsuitable for income-focused investors or those dependent on rental cashflow.

Location fundamentals are [exceptional/strong/moderate] - the walk score of [XX]/100, proximity to [Transport line], comprehensive schools and recreational facilities, and strong employment growth create sustained demand drivers. Demographic tailwinds are supportive, with low unemployment ([X.X]%), strong wage growth (+[X.X]% annually), and [suburb type] positioning.

Financial structure is inherently cashflow-negative, requiring approximately $[XX,XXX]-$[XX,XXX] annual investor capital support throughout the 10-year projection period. This structure only works if investors target $[XXX,XXX]-$[X,XXX,XXX]+ capital appreciation offsetting annual shortfalls. Risk profile is [elevated/moderate], particularly regarding interest rate sensitivity (1% increase adds $[X,XXX] annual cashflow pressure) and [unverified/verified] environmental hazards.

**Investment suitability:**

Best suited to investors who (1) have secure employment supporting annual $[XX]k+ cashflow contributions, (2) seek wealth accumulation through capital appreciation rather than income generation, (3) possess long-term 10+ year investment horizon, (4) can tolerate leverage and interest rate sensitivity, and (5) believe in [X]%+ annual appreciation through multiple economic cycles.

### Capital Appreciation Potential - $${Math.round((enhancedData.financials?.projections?.moderate?.[9]?.propertyValue || 0) - (effectivePurchasePrice || enhancedData.financials?.initialCosts?.propertyValue || 0)).toLocaleString() || 'XXX,XXX'} to $${Math.round((enhancedData.financials?.projections?.optimistic?.[9]?.propertyValue || 0) - (effectivePurchasePrice || enhancedData.financials?.initialCosts?.propertyValue || 0)).toLocaleString() || 'X,XXX,XXX'} (10-Year Projection)

Base case scenario projects Property Value of $[X,XXX,XXX] at Year 10, representing capital gains of $[XXX,XXX] ([XX.X]% total return). Optimistic scenario delivers $[X,XXX,XXX] value with gains of $[X,XXX,XXX] ([XX.X]% return). These projections assume [X-X]% annual appreciation, consistent with historical [City] metropolitan trends and supported by [Suburb]'s improving infrastructure, employment growth, and population inflows. Leverage amplifies returns: $[XXX,XXX] equity deployed generates $[XXX,XXX]+ appreciation, producing [X.X]x to [X.X]x return on equity invested. This capital appreciation fundamentally underwrites the investment case and offsets negative cashflow across projection period.

### Leveraged Equity Accumulation Through Debt Reduction

Over 10 years, principal repayment reduces loan balance from $[X,XXX,XXX] to approximately $[XXX,XXX], building equity of $[XXX,XXX] independent of property appreciation. Combined with capital appreciation, total wealth accumulation reaches $[XXX,XXX]-$[X,XXX,XXX] across projection scenarios. This debt reduction is automatic and inevitable, creating forced savings discipline. Accumulated equity provides optionality for future portfolio expansion, home renovation, or accessing capital during market stress periods.

### Sustained Employment Growth Driving Rental Demand (+[X.X]% annually, +[XX.X]% over 5 years)

Strong local job growth across professional services (+[X.X]%), healthcare (+[X.X]%), and education (+[X.X]%) creates sustained demand for rental properties from employed professionals. Labor force participation rate of [XX.X]% and unemployment rate of [X.X]% indicate tight labor market supporting wage growth and rental affordability. Median income of $[XX,XXX] annually positions renters comfortably within serviceability parameters for $[XXX]/week rental commitments. Continued population growth driven by employment expansion supports rental demand resilience, reducing vacancy risk and providing uplift potential as rents normalize toward market levels.

### Structural Cashflow Deficit Requiring Ongoing Investor Capital Support

The property generates negative cashflow of ($[XX,XXX]) annually under base assumptions, with cumulative 10-year shortfalls of ($[XXX,XXX]). This structure requires investors to contribute approximately $[X,XXX] monthly (P&I scenario) or $[X,XXX] monthly (IO scenario) in addition to deposit capital. Investors with insufficient liquid capital, unstable employment, or income constraints cannot sustain this commitment. Life events (job loss, income reduction, health crisis) that impact investor capital capacity create forced-sale risk or default risk. The property is unsuitable for self-funding through rental income and represents a capital commitment, not an income stream.

### Interest Rate Sensitivity and Debt Serviceability Pressure

Loan repayments at current [X.X]% rate absorb [XX]% of gross rental income before accounting for property management, rates, insurance, and maintenance. A 1% rate increase (to [X.X]%) increases annual repayments by $[X,XXX], pushing negative cashflow to ($[XX,XXX])-a [XX]% increase in annual capital requirement. RBA maintains potential for further rate increases if inflation remains sticky; even modest tightening creates material cashflow deterioration. Investors with limited capital buffers face refinancing stress or forced sale risk if rates spike. Conversely, rate reductions provide primary cashflow improvement pathway; any base case reliance on rate cuts represents uncontrollable external dependency.

### Environmental Risk: [High/Moderate] Bushfire Rating and Unverified Flood Risk

[State] experiences regular bushfire seasons, and [Suburb] is rated [LEVEL] for bushfire risk. Specific property-level risk assessment requires verification with [State] Rural Fire Service (RFS); properties in extreme fire risk zones face insurance unavailability or extreme premium escalation. Flood risk is currently [verified/unverified] and requires property coordinates for accurate assessment; potential flooding exposure could impact insurability, lender appetite, or development constraints. Combined environmental risks create tail-risk exposure: (1) insurance premium spikes reducing net yields further, (2) uninsurable property becoming unmarketable, (3) damage events creating unexpected capital calls for repairs, or (4) regulatory evacuation requirements constraining usage or rental marketability. Hazard verification is essential precondition to purchase commitment.

---

# Investment Recommendations

**Short-term Actions (Prior to Purchase):**

- Engage professional valuer to obtain formal property valuation for [Property Address]; assess whether ${documentContent ? 'the listed price' : 'estimated reference price'} of $[X,XXX,XXX] accurately reflects current market conditions and property-specific features
- Conduct environmental hazard verification through [State] RFS for bushfire risk assessment and AFRIP for flood risk mapping; make fire/flood insurance availability and cost confirmation conditional to purchase commitment
- Request local real estate agent market analysis for suburb price forecasts and trends from licensed agents familiar with [Street/Area]
- NOTE: Specific comparable sales data should be obtained directly from agents or property data providers (CoreLogic, RP Data)
- Verify financial serviceability with mortgage broker or bank; confirm loan approval capacity at current [X.X]% rate AND at stressed [X.X]% rate (RBA upside scenario)
- Confirm liquid capital reserves capable of supporting ($[XX,XXX]) annual negative cashflow over minimum 10-year investment period; calculate capacity to sustain scenario with [X.X]%+ rates producing ($[XX,XXX]) annual shortfalls

**Before proceeding with purchase commitment, conduct:**

- Professional property appraisal to verify ${documentContent ? 'listed' : 'estimated'} $[X,XXX,XXX] valuation
- [State] RFS property risk assessment to confirm bushfire risk rating and evacuation zone status
- AFRIP flood mapping using property coordinates to assess flooding exposure
- Local council rates search to verify exact annual council and water charges
- Rental market assessment through local real estate agents to validate $[XXX]/week rental estimate
- Request comparative sales analysis from licensed real estate agents or property data providers for recent transaction evidence
- Pest and building inspection to assess structural condition and maintenance requirements
- Lender pre-approval to confirm serviceability assessment and loan terms at current interest rates
- Model personal tax position with accountant to quantify benefit of negative gearing deductions and capital gains tax treatment on projected appreciation

**Long-term Strategy (Ownership & Wealth Maximization):**

- Adopt minimum 10-year hold strategy to allow capital appreciation projections to materialize and debt reduction to accumulate meaningful equity; short-term trading exposes property to transaction costs and market timing risk
- Refinance to interest-only loan after 5-7 years of principal repayment if equity position permits; interest-only structure optimizes tax deductibility and preserves capital for portfolio expansion or alternative investments
- Target rental income optimization through property maintenance and positioning; monitor rent market annually and reset tenancy at market rates to capture upward rent growth ([X-X]% annually); under-market rents represent lost opportunity cost
- Maintain comprehensive property insurance including home and landlord liability; given [LEVEL] bushfire risk rating, confirm policy includes fire damage coverage and evacuation expense reimbursement
- Monitor local infrastructure developments including [Transport] extensions, school expansions, and commercial developments; infrastructure improvements provide capital appreciation catalysts
- Build equity buffer through principal repayment; accumulated equity after 10 years ($[XXX,XXX]-$[XXX,XXX] range across growth scenarios) provides optionality for portfolio expansion or capital access without forced sales

---

# Investment Suitability Screening

**This investment is APPROPRIATE for investors who:**

- Possess 10+ year investment horizon and patience for long-term wealth accumulation
- Have stable employment supporting minimum $[XX,XXX]+ annual cashflow contributions
- Seek capital appreciation ([X-X]%) over rental income generation
- Can absorb 1-2% annual portfolio volatility and extended flat-growth periods
- Have confidence in [City] metropolitan property market sustainability
- Maintain sufficient liquid reserves ($[XXX,XXX] deposit + $[XX,XXX]+ annual reserves minimum)
- Are comfortable with 80% leverage and interest rate sensitivity
- Accept environmental hazard exposure (bushfire, flood) pending verification

**This investment is NOT APPROPRIATE for investors who:**

- Require immediate positive cashflow or rental income to service costs
- Have unstable employment or insufficient capital reserves
- Seek quick returns (3-5 year timeframes); capital appreciation requires minimum 10-year hold
- Cannot afford $[XX,XXX]+ annual capital contributions
- Are sensitive to interest rate increases or economic downturns
- Require 100% equity financing or cannot access 80% LVR
- Are risk-averse regarding leverage, environmental hazards, or market volatility

---

# Final Conclusion

**Investment Thesis Summary:**

[Property Address] represents a structured capital growth opportunity for investors capable of sustaining negative cashflow and confident in [City] metropolitan property appreciation over a 10+ year investment horizon. The property offers [exceptional/strong/moderate] location fundamentals (walk score [XX]/100, metro accessibility, quality schools, strong employment growth) and demographic tailwinds supporting rental demand and capital appreciation.

However, the investment exhibits significant financial constraints: Negative annual cashflow of ($[XX,XXX]) to ($[XX,XXX]), depending on loan structure, requires investor capital support throughout the projection period. The property is fundamentally unsuitable for income-focused investors or those dependent on rental income. Return generation depends entirely on achieving [X-X]% annual property appreciation; rental income ($[XX,XXX] annually) covers only [XX]% of debt serviceability costs.

Risk profile is [elevated/moderate] due to interest rate sensitivity ([X]% rate change impacts annual cashflow by $[X,XXX]), [unverified/verified] environmental hazards ([level] bushfire risk, [level] flood risk), and leverage exposure (80% LVR). The investment requires investors to maintain strict financial discipline, verify environmental hazards prior to purchase, and commit to long-term ownership even through periods of market stagnation.

**Valuation Assessment:**

${documentContent ? 'The listed' : 'Estimated'} property price of $[X,XXX,XXX] reflects market [premium/standard] positioning for [suburb type] with [infrastructure/amenity factors]. Price appears [reasonable/premium/discounted] relative to [Suburb] benchmarks but provides [limited/adequate] margin for economic downturns or extended periods of below-trend property growth.

**Overall Recommendation:**

**QUALIFIED ${enhancedData.investmentScore?.recommendation || 'HOLD'} with Contingencies**

This property warrants serious consideration for investors who (1) verify environmental hazards as acceptable, (2) confirm financial capacity to sustain negative cashflow, (3) achieve mortgage pre-approval at serviceability-acceptable terms, and (4) obtain professional valuation confirming price point aligns with current market conditions. The investment is suitable for disciplined, long-term capital accumulators with strong employment stability and confidence in [City] metropolitan property markets. Investors prioritizing immediate returns or requiring rental income should pursue alternative investments with superior yield profiles.

**Report Completion Date:** ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}

**Data Currency:** ${new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}

**Analyst Disclaimer:**

This report synthesizes publicly available data and ${documentContent ? 'provided property listing information' : 'generic suburb-level analysis'}. It does not constitute financial advice, property valuation, or legal guidance. Investors must conduct independent verification of all material facts, obtain professional appraisals, and consult with licensed real estate agents, valuers, accountants, and financial advisors prior to making investment commitments.

---

# ═══════════════════════════════════════════════════════════════════════════════
# ABSOLUTE FORMATTING REQUIREMENTS - FOLLOW EXACTLY
# ═══════════════════════════════════════════════════════════════════════════════

1. **38+ PAGE REPORT**: This MUST be a comprehensive report equivalent to 38+ printed pages (12,000-15,000 words minimum)
2. **EVERY SECTION REQUIRED**: Include ALL sections exactly as specified above - do not skip any
3. **SUBSTANTIAL CONTENT**: Each section must meet the minimum word counts specified in parentheses
4. **TABLE FORMAT**: Use markdown tables EXACTLY as shown with proper column alignment
5. **NO PLACEHOLDERS**: NEVER use "N/A", "TBD", "data unavailable", or "XX" placeholders - use real data or realistic estimates
6. **ALL 10 YEARS**: Projection tables MUST include all 10 years of data
7. **DOLLAR AMOUNTS**: All amounts in AUD with $ symbol and proper comma formatting
8. **CITATIONS**: Include [citation] markers where data is sourced from external references
9. **HORIZONTAL RULES**: Use --- between ALL major sections for visual separation
10. **PROFESSIONAL LANGUAGE**: Data-driven, specific, actionable insights throughout
11. **EXPENSE VALUES**: Use the EXACT expense values provided in PRE-CALCULATED ANNUAL COSTS section - do not substitute with defaults
12. **COMPLETE SWOT**: Minimum 10 detailed bullet points per SWOT category with 2-3 sentence explanations each
13. **TOP 3 SECTIONS**: Each of Top 3 Opportunities and Top 3 Risks must be 150+ words with specific dollar amounts
14. **DATA CONSISTENCY**: Every data point (distances, SEIFA scores, risk ratings, labor force, population, cashflow deficit) MUST be stated identically across all sections. A single contradicting figure destroys report credibility.
15. **BENCHMARK ACCURACY**: Double-check every "exceeds/outperforms/above average" claim — if 4.13% < 4.2%, it is BELOW, not above. Mathematical errors in comparisons are unacceptable.
16. **SINGLE FINANCIAL SCENARIO**: Use ONE LVR/deposit combination (from PRE-CALCULATED values) throughout. Do not switch between 80% and 90% LVR or 10% and 20% deposit without an explicitly labelled scenario comparison.
17. **NO FABRICATED PRECISION**: Do not invent specific percentages for infrastructure impact (e.g., "9.2% uplift") without a cited source. Use honest ranges or qualitative language.
18. **HONEST CHARACTERIZATION**: If negative cashflow, say "growth-focused, negatively geared". If crime is average, say "average" — do not oversell as "low crime elite suburb". Credibility over salesmanship.
19. **NO DUPLICATE CONTENT**: Each topic (e.g., environmental risks) gets ONE authoritative section. Do not repeat the same analysis in two places with slightly different values.
20. **DATE-STAMP ECONOMICS**: All economic indicators must include "as at [Month Year]" to convey data currency.`;

    // Select the appropriate prompt based on report scope
    let prompt = reportScope === 'suburb' ? suburbPrompt 
      : reportScope === 'postcode' ? postcodePrompt
      : reportScope === 'statewide' ? statewidePrompt
      : propertyPrompt;
    
    // For area reports, inject explicit exclusion instructions to prevent property-level sections
    if (isAreaReport) {
      const areaExclusionInstructions = `
---
**CRITICAL: AREA-LEVEL ANALYSIS ONLY — NO PROPERTY-SPECIFIC SECTIONS**

This is a ${reportScope.toUpperCase()}-level area analysis report. You MUST NOT include any of the following property-specific sections or content:

- ❌ Loan Repayment calculations or tables
- ❌ Cash Flow Analysis or Projections (weekly/monthly/annual)
- ❌ 10-Year Cash Flow Projection tables
- ❌ Mortgage / Loan Scenarios
- ❌ Stamp Duty calculations
- ❌ Depreciation schedules
- ❌ Rental Yield calculations for a specific property
- ❌ Property Snapshot tables with specific purchase price, weekly rent, LVR, etc.
- ❌ Net/Gross Rental Yield for a single property
- ❌ Acquisition Cost breakdowns
- ❌ Annual Operating Cost breakdowns for a single property
- ❌ Negative Gearing / Tax Benefit calculations
- ❌ Equity Growth projections for a single property

Instead, focus EXCLUSIVELY on area-level analysis:
- ✅ Median prices, rental yields, and vacancy rates for the area
- ✅ Supply pipeline and development activity
- ✅ Demographics and population trends
- ✅ Infrastructure and government investment
- ✅ Market momentum and growth trends
- ✅ Comparative suburb/region analysis
- ✅ Investment hotspot identification
- ✅ Zoning and planning considerations
- ✅ SWOT analysis at the area level

---

`;
      prompt = areaExclusionInstructions + prompt;
      console.log('✅ Area-level exclusion instructions injected for scope:', reportScope);
    }
    
    // If document content is available (from URL scrape OR PDF upload), prepend it to the prompt for context
    if (documentContent) {
      const contentSourceLabel = fromPdfUpload ? 'PDF Document' : (sourceUrl || 'Property Listing');
      console.log(`📄 Injecting ${fromPdfUpload ? 'PDF' : 'scraped'} property listing content into prompt...`);
      console.log(`   Content source: ${contentSourceLabel}`);
      console.log(`   Content length: ${documentContent.length} characters`);
      
      // Build a summary of extracted property details
      const extractedDetailsSummary: string[] = [];
      if (propertyDetails?.price) extractedDetailsSummary.push(`Price: $${propertyDetails.price.toLocaleString()}`);
      if (propertyDetails?.beds) extractedDetailsSummary.push(`Bedrooms: ${propertyDetails.beds}`);
      if (propertyDetails?.baths) extractedDetailsSummary.push(`Bathrooms: ${propertyDetails.baths}`);
      if (propertyDetails?.carSpaces) extractedDetailsSummary.push(`Car Spaces: ${propertyDetails.carSpaces}`);
      if (propertyDetails?.landSizeSqm) extractedDetailsSummary.push(`Land Size: ${propertyDetails.landSizeSqm} sqm`);
      if (propertyDetails?.buildSizeSqm) extractedDetailsSummary.push(`Building Size: ${propertyDetails.buildSizeSqm} sqm`);
      if (propertyDetails?.propertyType) extractedDetailsSummary.push(`Property Type: ${propertyDetails.propertyType}`);
      if (propertyDetails?.suburb) extractedDetailsSummary.push(`Suburb: ${propertyDetails.suburb}`);
      if (propertyDetails?.postcode) extractedDetailsSummary.push(`Postcode: ${propertyDetails.postcode}`);
      if (propertyDetails?.state) extractedDetailsSummary.push(`State: ${propertyDetails.state}`);
      if (propertyDetails?.weeklyRent) extractedDetailsSummary.push(`Weekly Rent: $${propertyDetails.weeklyRent}`);
      if (propertyDetails?.isNewBuild) extractedDetailsSummary.push(`New Build: Yes`);
      if (propertyDetails?.landPrice) extractedDetailsSummary.push(`Land Price: $${propertyDetails.landPrice.toLocaleString()}`);
      if (propertyDetails?.buildPrice) extractedDetailsSummary.push(`Build Price: $${propertyDetails.buildPrice.toLocaleString()}`);
      
      const extractedDetailsText = extractedDetailsSummary.length > 0 
        ? `\n\n**EXTRACTED PROPERTY SPECIFICATIONS:**\n${extractedDetailsSummary.join('\n')}\n`
        : '';
      
      // Use different instructions based on content source
      const sourceSpecificInstructions = fromPdfUpload 
        ? `**CRITICAL INSTRUCTIONS FOR PDF-UPLOADED LISTINGS:**
1. The above content was extracted from a property listing PDF document
2. This is the PRIMARY source of truth for this property's specifications and features
3. Extract and use the EXACT property specifications from the document (bedrooms, bathrooms, land size, price)
4. Use the property address exactly as shown in the document
5. Include all relevant property features, upgrades, and selling points mentioned in the document
6. If a price is mentioned (guide, asking, or range), use it for financial calculations
7. Note any specific renovations, improvements, or unique characteristics
8. Consider the property description when assessing investment potential
9. Verify the suburb/postcode from the document for accurate location analysis
10. For new builds: Use the land + build package price for total property value`
        : `**CRITICAL INSTRUCTIONS FOR URL-SCRAPED LISTINGS:**
1. The above scraped content is the PRIMARY source of truth for this property
2. Extract and use the EXACT property specifications from the listing (bedrooms, bathrooms, land size, price)
3. Use the property address exactly as shown in the listing
4. Include all relevant property features, upgrades, and selling points mentioned in the listing
5. If a price is mentioned (guide, asking, or range), use it for financial calculations
6. Note any specific renovations, improvements, or unique characteristics
7. Consider the property description when assessing investment potential
8. Verify the suburb/postcode from the listing for accurate location analysis`;
      
      const limitedDocumentContent = limitPromptContext(
        String(documentContent),
        DOCUMENT_CONTEXT_MAX_BYTES,
        `${fromPdfUpload ? 'PDF' : 'Scraped'} listing content`,
        'head-tail'
      );
      const documentContextSection = `
---
**PROPERTY LISTING DATA (SOURCE: ${contentSourceLabel})**

The following is the available content ${fromPdfUpload ? 'extracted from the property listing PDF' : 'scraped from the property listing'}. Use this as PRIMARY context for property details, features, description, and specific information mentioned in the listing. If this block was truncated, use the extracted specifications below and fresh web research to fill gaps without inventing facts:

${limitedDocumentContent}
${extractedDetailsText}
---

${sourceSpecificInstructions}

---

`;
      prompt = documentContextSection + prompt;
      console.log(`✓ ${fromPdfUpload ? 'PDF' : 'Scraped'} content injected with extracted details. New prompt length:`, prompt.length);
    } else {
      console.log('ℹ️ No document content available - generating report from property address and web search only');
    }

    // ========== MANUAL OVERRIDES INJECTION ==========
    // Only inject property-level overrides for address-scope reports
    // Area reports (suburb/postcode/statewide) do NOT use property-level overrides
    // isAreaReport already defined at top of function
    const manualOverrides = isAreaReport ? null : (propertyDetails?.manualOverrides || null);
    // Compass is a NON-financial location/property-fit report. Injecting
    // financial labels (Purchase Price: $X, Interest Rate: 6.5%, Capital Growth:
    // 5% p.a.) caused the model to regurgitate them verbatim into narrative
    // prose. For every Compass tier we strip every financial override line at the
    // source so the LLM never sees them.
    // Use the report tier rather than the caller-selected generation engine:
    // omitted tiers default to Compass and the legacy engine remains selectable.
    const __compassReport = ['compass', 'compass-40'].includes(propertyDetails?.reportTier || 'compass');
    const __FINANCIAL_OVERRIDE_KEYS = new Set<string>([
      'purchasePrice','landPrice','buildPrice','weeklyRent','depositValue',
      'loanToValueRatio','interestRate','loanType','loanTermYears','loanAmount',
      'interestOnlyPeriodYears','repaymentFrequency','extraRepaymentPerMonth','offsetBalance',
      'capitalGrowth','cpiGrowthRate',
      'stampDuty','solicitorFees','agentFee','isFirstHomeBuyer',
      'bodyCorporateFees','strataAdminFund','strataSinkingFund','strataSpecialLevies',
      'landTax','councilRates','waterRates','buildingLandlordInsurance',
      'propertyManagementFees','repairsMaintenance','lettingFees',
      'depreciation','taxRate','occupancyRate','marketValueNow',
    ]);
    if (__compassReport && manualOverrides) {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(manualOverrides)) {
        if (!__FINANCIAL_OVERRIDE_KEYS.has(k)) filtered[k] = v;
      }
      const dropped = Object.keys(manualOverrides).length - Object.keys(filtered).length;
      if (dropped > 0) {
        console.log(`🛡️ Compass: stripped ${dropped} financial override keys from prompt context`);
      }
      Object.keys(manualOverrides).forEach((k) => {
        if (!filtered.hasOwnProperty(k)) delete (manualOverrides as Record<string, unknown>)[k];
      });
    }
    if (manualOverrides && Object.keys(manualOverrides).length > 0) {
      console.log('📝 Injecting manual overrides into prompt...');
      const overrideLines: string[] = [];
      
      // Build Type
      if (manualOverrides.buildType) {
        const buildTypeLabels: Record<string, string> = {
          'new_build': 'New Build (House & Land Package)',
          'existing_property': 'Existing Property',
          'land_only': 'Land Only (Vacant Land - No Structure)'
        };
        overrideLines.push(`Build Type: ${buildTypeLabels[manualOverrides.buildType] || manualOverrides.buildType}`);
      }
      
      // Property Values
      if (manualOverrides.purchasePrice) overrideLines.push(`Purchase Price: $${manualOverrides.purchasePrice.toLocaleString()}`);
      if (manualOverrides.landPrice) overrideLines.push(`Land Price: $${manualOverrides.landPrice.toLocaleString()}`);
      if (manualOverrides.buildPrice) overrideLines.push(`Build Price: $${manualOverrides.buildPrice.toLocaleString()}`);
      if (manualOverrides.weeklyRent) overrideLines.push(`Weekly Rent: $${manualOverrides.weeklyRent}`);
      if (manualOverrides.depositValue) overrideLines.push(`Deposit: $${manualOverrides.depositValue.toLocaleString()}`);
      
      // Loan Settings
      if (manualOverrides.loanToValueRatio) overrideLines.push(`Loan-to-Value Ratio (LVR): ${manualOverrides.loanToValueRatio}%`);
      if (manualOverrides.interestRate) overrideLines.push(`Interest Rate: ${manualOverrides.interestRate}%`);
      if (manualOverrides.loanType) overrideLines.push(`Loan Type: ${manualOverrides.loanType === 'interest_only' ? 'Interest Only' : 'Principal & Interest'}`);
      if (manualOverrides.loanTermYears) overrideLines.push(`Loan Term: ${manualOverrides.loanTermYears} years`);
      if (manualOverrides.loanAmount) overrideLines.push(`Loan Amount: $${manualOverrides.loanAmount.toLocaleString()}`);
      if (manualOverrides.interestOnlyPeriodYears) overrideLines.push(`Interest-Only Period: ${manualOverrides.interestOnlyPeriodYears} years`);
      if (manualOverrides.repaymentFrequency) overrideLines.push(`Repayment Frequency: ${manualOverrides.repaymentFrequency}`);
      if (manualOverrides.extraRepaymentPerMonth) overrideLines.push(`Extra Repayment/Month: $${manualOverrides.extraRepaymentPerMonth}`);
      if (manualOverrides.offsetBalance) overrideLines.push(`Offset Balance: $${manualOverrides.offsetBalance.toLocaleString()}`);
      
      // Growth Assumptions
      if (manualOverrides.capitalGrowth) overrideLines.push(`Capital Growth Rate: ${manualOverrides.capitalGrowth}% p.a.`);
      if (manualOverrides.cpiGrowthRate) overrideLines.push(`CPI Growth Rate: ${manualOverrides.cpiGrowthRate}% p.a.`);
      
      // Acquisition Costs
      if (manualOverrides.stampDuty) overrideLines.push(`Stamp Duty: $${manualOverrides.stampDuty.toLocaleString()}`);
      if (manualOverrides.solicitorFees) overrideLines.push(`Solicitor Fees: $${manualOverrides.solicitorFees.toLocaleString()}`);
      if (manualOverrides.agentFee) overrideLines.push(`Agent Fee/Commission: $${manualOverrides.agentFee.toLocaleString()}`);
      if (manualOverrides.isFirstHomeBuyer) overrideLines.push(`First Home Buyer: Yes (apply stamp duty concessions)`);
      
      // Annual Expenses
      if (manualOverrides.bodyCorporateFees) overrideLines.push(`Body Corporate/Strata Fees: $${manualOverrides.bodyCorporateFees.toLocaleString()} p.a.`);
      if (manualOverrides.strataAdminFund) overrideLines.push(`Strata Admin Fund: $${manualOverrides.strataAdminFund.toLocaleString()} p.a.`);
      if (manualOverrides.strataSinkingFund) overrideLines.push(`Strata Sinking Fund: $${manualOverrides.strataSinkingFund.toLocaleString()} p.a.`);
      if (manualOverrides.strataSpecialLevies) overrideLines.push(`Strata Special Levies: $${manualOverrides.strataSpecialLevies.toLocaleString()} p.a.`);
      if (manualOverrides.landTax) overrideLines.push(`Land Tax: $${manualOverrides.landTax.toLocaleString()} p.a.`);
      if (manualOverrides.councilRates) overrideLines.push(`Council Rates: $${manualOverrides.councilRates.toLocaleString()} p.a.`);
      if (manualOverrides.waterRates) overrideLines.push(`Water Rates: $${manualOverrides.waterRates.toLocaleString()} p.a.`);
      if (manualOverrides.buildingLandlordInsurance) overrideLines.push(`Building/Landlord Insurance: $${manualOverrides.buildingLandlordInsurance.toLocaleString()} p.a.`);
      if (manualOverrides.propertyManagementFees) overrideLines.push(`Property Management Fees: ${manualOverrides.propertyManagementFees}%`);
      if (manualOverrides.repairsMaintenance) overrideLines.push(`Repairs & Maintenance: $${manualOverrides.repairsMaintenance.toLocaleString()} p.a.`);
      if (manualOverrides.lettingFees) overrideLines.push(`Letting Fees: $${manualOverrides.lettingFees.toLocaleString()} p.a.`);
      
      // Cash Flow Analysis
      if (manualOverrides.depreciation) overrideLines.push(`Depreciation: $${manualOverrides.depreciation.toLocaleString()} p.a.`);
      if (manualOverrides.taxRate) overrideLines.push(`Marginal Tax Rate: ${manualOverrides.taxRate}%`);
      // CLARIFIED: Occupancy rate is in WEEKS per year, NOT percentage
      if (manualOverrides.occupancyRate) overrideLines.push(`Occupancy Rate: ${manualOverrides.occupancyRate} WEEKS per year (equals ${((manualOverrides.occupancyRate/52)*100).toFixed(0)}% annual occupancy - DO NOT confuse with ${manualOverrides.occupancyRate}%)`);
      if (manualOverrides.marketValueNow) overrideLines.push(`Current Market Value: $${manualOverrides.marketValueNow.toLocaleString()}`);
      
      // Property Specs
      if (manualOverrides.landSizeSqm) overrideLines.push(`Land Size: ${manualOverrides.landSizeSqm} sqm`);
      if (manualOverrides.buildSizeSqm) overrideLines.push(`Build Size: ${manualOverrides.buildSizeSqm} sqm`);
      
      // New Build Specifics
      if (manualOverrides.buildType === 'new_build') {
        if (manualOverrides.constructionDurationMonths) overrideLines.push(`Construction Duration: ${manualOverrides.constructionDurationMonths} months`);
        if (manualOverrides.constructionYear) overrideLines.push(`Construction Year: ${manualOverrides.constructionYear}`);
        
        // Construction Stage Percentages
        const stagePercentages: string[] = [];
        if (manualOverrides.stageDepositPercent) stagePercentages.push(`Deposit: ${manualOverrides.stageDepositPercent}%`);
        if (manualOverrides.stageSlabPercent) stagePercentages.push(`Slab: ${manualOverrides.stageSlabPercent}%`);
        if (manualOverrides.stageFramePercent) stagePercentages.push(`Frame: ${manualOverrides.stageFramePercent}%`);
        if (manualOverrides.stageLockupPercent) stagePercentages.push(`Lockup: ${manualOverrides.stageLockupPercent}%`);
        if (manualOverrides.stageFixingPercent) stagePercentages.push(`Fixing: ${manualOverrides.stageFixingPercent}%`);
        if (manualOverrides.stageCompletionPercent) stagePercentages.push(`Completion: ${manualOverrides.stageCompletionPercent}%`);
        if (stagePercentages.length > 0) {
          overrideLines.push(`Construction Stage Payment Schedule: ${stagePercentages.join(', ')}`);
        }
        
        // Construction Schedule Preset Mode
        if (manualOverrides.schedulePreset) {
          const presetDescriptions: Record<string, string> = {
            'rapid': 'Rapid Front-Load (accelerated early stages)',
            'even': 'Even Distribution (equal monthly spread)',
            'custom': 'Custom Timing (user-defined month positions)'
          };
          overrideLines.push(`Construction Schedule Mode: ${presetDescriptions[manualOverrides.schedulePreset] || manualOverrides.schedulePreset}`);
        }
        
        // Custom Stage Months (when custom schedule preset is used)
        if (manualOverrides.schedulePreset === 'custom' && manualOverrides.customStageMonths) {
          const stageNames = ['Deposit', 'Slab', 'Frame', 'Lockup', 'Fixing', 'Completion'];
          const stageTiming: string[] = [];
          for (const [index, month] of Object.entries(manualOverrides.customStageMonths)) {
            const stageName = stageNames[parseInt(index)] || `Stage ${index}`;
            stageTiming.push(`${stageName}: Month ${month}`);
          }
          if (stageTiming.length > 0) {
            overrideLines.push(`Custom Stage Timing: ${stageTiming.join(', ')}`);
          }
        }
      }
      
      // Land Only Specifics - Add special instructions
      if (manualOverrides.buildType === 'land_only') {
        overrideLines.push(`\n**LAND ONLY PROPERTY ANALYSIS NOTES:**`);
        overrideLines.push(`- This is VACANT LAND with no existing structure - use "Vacant Land" as the Property Type throughout`);
        overrideLines.push(`- NO rental income should be calculated (no dwelling exists) - DO NOT include Weekly Rent, Rental Yield, Occupancy rows in any tables`);
        overrideLines.push(`- NO depreciation applies (no building to depreciate)`);
        overrideLines.push(`- REMOVE all rental-related rows from Property Snapshot and financial tables (Weekly Rent, Gross Rental Yield, Net Rental Yield, Rental Income, Occupancy Rate)`);
        overrideLines.push(`- Focus on DEVELOPMENT POTENTIAL and zoning analysis`);
        overrideLines.push(`- Use VACANT LAND stamp duty rates (often different from residential)`);
        overrideLines.push(`- Key metrics: Land value appreciation, holding costs (council rates, land tax), development feasibility`);
        overrideLines.push(`- SKIP the entire "Rental Assessment & Yield Calculation" section - this section does not apply to vacant land`);
        overrideLines.push(`- SKIP the "Cashflow Analysis" section - vacant land generates no rental cashflow`);
        if (manualOverrides.zoningCode) overrideLines.push(`- Zoning Code: ${manualOverrides.zoningCode}`);
        if (manualOverrides.developmentPotential) overrideLines.push(`- Development Potential: ${manualOverrides.developmentPotential}`);
      }
      
      if (overrideLines.length > 0) {
        const overridesSection = `
---
**PRE-GENERATION MANUAL OVERRIDES (USE THESE VALUES EXACTLY):**

The following values have been manually specified by the user. Use these EXACT values in your calculations and report - do NOT estimate or override these with AI-fetched data:

${overrideLines.join('\n')}

**IMPORTANT:** These manual overrides take precedence over any data fetched from external sources. Apply them directly to all financial calculations, projections, and cost analyses.

---

`;
        prompt = overridesSection + prompt;
        console.log(`✓ Manual overrides injected (${overrideLines.length} values). New prompt length:`, prompt.length);
      }
      
      // If capital growth was NOT manually overridden, instruct Perplexity to dynamically research it
      if (!manualOverrides.capitalGrowth) {
        const capitalGrowthResearchInstruction = `
---
**CAPITAL GROWTH RATE - REQUIRED RESEARCH:**

The capital growth rate was NOT provided by the user. You MUST:
1. Research and fetch the historical capital growth rate for this specific suburb/area
2. Use reliable sources like CoreLogic, PropTrack, Domain, or local council data
3. Calculate an appropriate capital growth projection based on:
   - Historical 5-10 year median price trends for the suburb
   - Current market conditions and growth trajectory
   - Comparison to broader metropolitan/regional averages
4. Cite the source and timeframe of your capital growth data
5. Use this researched value in ALL financial calculations and 10-year projections

DO NOT default to 0% or any arbitrary value. The capital growth rate is critical for accurate investment analysis.

---

`;
        prompt = capitalGrowthResearchInstruction + prompt;
        console.log('✓ Capital growth research instruction injected (no manual override provided)');
      }
    } else {
      console.log('ℹ️ No manual overrides provided');
      
      // When no overrides at all, still instruct Perplexity to research capital growth
      const capitalGrowthResearchInstruction = `
---
**CAPITAL GROWTH RATE - REQUIRED RESEARCH:**

No capital growth rate was provided. You MUST research and determine an appropriate capital growth rate for this property's suburb/area:
1. Fetch historical capital growth data from CoreLogic, PropTrack, Domain, or similar reliable sources
2. Analyze 5-10 year median price trends for the suburb
3. Consider current market conditions and growth trajectory
4. Use this researched value in ALL financial calculations and 10-year projections
5. Cite your source and the timeframe of the data

DO NOT default to 0% or any arbitrary value. The capital growth rate is critical for accurate investment analysis.

---

`;
      prompt = capitalGrowthResearchInstruction + prompt;
      console.log('✓ Capital growth research instruction injected (no overrides provided)');
    }

    // ========== DIRECT TEMPLATE INJECTION (Hard Enforced) ==========
    // Fetch AI structure template directly from database - bypasses RAG similarity search
    let templateContext = '';
    let compass40OverlayActive = false;
    try {
      console.log('🔍 Fetching AI structure template directly from database...');

      const rawTier = propertyDetails?.reportTier || 'compass';
      const requestedEngine = propertyDetails?.generationEngine;
      const isCompassTier = rawTier === 'compass' || rawTier === 'compass-40';
      // The report tier is the authoritative data-minimization boundary. An
      // engine preference must never downgrade a non-financial Compass report.
      const generationEngine = isCompassTier || requestedEngine === 'compass-40'
        ? 'compass-40'
        : 'legacy';
      compass40OverlayActive = generationEngine === 'compass-40';
      if (compass40OverlayActive && propertyDetails?.generationEngine !== 'compass-40') {
        propertyDetails = { ...(propertyDetails || {}), generationEngine: 'compass-40' };
        console.log('⚙️ Compass-tier report promoted to compass-40 engine for prompt-size safety');
      }
      console.log(`⚙️ Generation engine: ${generationEngine} (compass-40 overlay: ${compass40OverlayActive}, tier: ${rawTier})`);
      const tierMapping: Record<string, string> = {
        'compass-40': 'compass',
        'briefing': 'executive',
        'compass': 'compass',
        'snapshot': 'snapshot',
        'executive': 'executive',
        'financial': 'financial',
        'financial-analysis': 'financial',
      };
      const reportTier = tierMapping[rawTier] || rawTier;
      const scopeCategoryMap: Record<string, string> = {
        'suburb': 'suburb',
        'postcode': 'postcode',
        'statewide': 'statewide',
      };
      const reportCategory = scopeCategoryMap[reportScope] || 'investment';

      console.log(`📋 Tier mapping: "${rawTier}" → "${reportTier}"`);

      // ── COMPASS-40 SHORT-CIRCUIT ──────────────────────────────────────────
      // When the user picks the Compass-40 engine we DO NOT load the legacy
      // 12-group section list or the legacy DB AI-structure template. The
      // legacy template is what was forcing financial KPI rows, P&I cashflow,
      // 10-year projections and the duplicate "Property Snapshot" pages into
      // the output. Instead we use the canonical Compass registry (no
      // financials) and a thin canonical template context. The Compass-40
      // overlay below still runs on top to enforce style rules.
      //
      // The ×1.6 token bump that used to be applied here is gone. It was added
      // against mid-sentence truncation, but it compounded with a maxTokens
      // already set at 4× the word cap, so a 650-word section was given room
      // for about 3,100. The headroom now lives in the single derivation in
      // `canonicalSectionsToGenerationSections`, where it can be reasoned about
      // against the cap it is a multiple of.
      if (compass40OverlayActive) {
        REPORT_SECTIONS = getCanonicalSectionsForTier('compass-40');
        templateContext = buildCanonicalTemplateContext('compass-40');
        console.log(`✓ Compass-40: using canonical ${REPORT_SECTIONS.length}-section registry (legacy template bypassed)`);
      } else {
        // Always start from legacy default sections; legacy engine reuses this base.
        REPORT_SECTIONS = getDefaultSectionsForScope(reportScope);

        const templateClient = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        let { data: templates, error: templateError } = await templateClient
          .from('report_structure_templates')
          .select('id, name, parsed_content, report_tier, report_category')
          .eq('template_type', 'ai_structure')
          .eq('is_active', true)
          .order('priority', { ascending: false });

        if (templateError) {
          console.log('⚠️ Template query error:', templateError.message);
        } else if (templates && templates.length > 0) {
          let selectedTemplate = templates.find(t =>
            t.report_tier === reportTier && t.report_category === reportCategory
          ) || templates.find(t =>
            t.report_tier === reportTier && !t.report_category
          ) || templates.find(t =>
            !t.report_tier && t.report_category === reportCategory
          ) || templates.find(t =>
            !t.report_tier && !t.report_category
          ) || templates[0];

          if (selectedTemplate?.parsed_content) {
            templateContext = selectedTemplate.parsed_content;
            console.log(`✓ Template loaded: "${selectedTemplate.name}"`);
            console.log(`  Tier: ${selectedTemplate.report_tier || 'any'}, Category: ${selectedTemplate.report_category || 'any'}`);
            console.log(`  Content size: ${templateContext.length} chars`);

            console.log('\n📋 Parsing template structure...');
            const parsedStructure = parseTemplateStructure(
              templateContext,
              selectedTemplate.name,
              selectedTemplate.id
            );

            if (parsedStructure.sections.length > 0) {
              REPORT_SECTIONS = parsedStructure.sections;
              console.log(`✓ REPORT_SECTIONS updated with ${REPORT_SECTIONS.length} sections from template`);
              console.log(`  Template headings found: ${parsedStructure.headings.length}`);
            } else {
              console.log('⚠️ Template parsing returned no sections, using DEFAULT_REPORT_SECTIONS');
              REPORT_SECTIONS = getDefaultSectionsForScope(reportScope);
            }
          } else {
            console.log('⚠️ Template found but parsed_content is empty');
            REPORT_SECTIONS = getDefaultSectionsForScope(reportScope);
          }
        } else {
          console.log('ℹ️ No active AI structure templates found in database');
          REPORT_SECTIONS = getDefaultSectionsForScope(reportScope);
        }
      }
    } catch (templateError: any) {
      console.log('⚠️ Template fetch failed (non-critical):', templateError?.message || 'Unknown error');
      REPORT_SECTIONS = getDefaultSectionsForScope(reportScope);
    }


    // Inject template context into prompt if available
    if (templateContext) {
      const limitedTemplateContext = limitPromptContext(templateContext, TEMPLATE_CONTEXT_MAX_BYTES, 'Reference template structure', 'head');
      const templateSection = `
---
**REFERENCE TEMPLATE STRUCTURE (Follow this structure closely):**

The following is extracted from your reference templates. Use this structure and formatting as a guide for generating the report. If the template was truncated, follow the section-generation task and canonical rules as the authority:

${limitedTemplateContext}

---

`;
      prompt = templateSection + prompt;
      console.log('✓ Template context injected into prompt. New length:', prompt.length);
    }

    // ========== COMPASS-40 OVERLAY (Client brief: trim legacy report) ==========
    // Applied ONLY when generationEngine === 'compass-40'. Built on top of the
    // legacy structure: KEEP Priority-1 sections, COMPRESS Priority-2 sections,
    // REMOVE all financial modelling (Priority-3). See client brief for the
    // exact priority list — these overrides WIN over the template above.
    if (compass40OverlayActive) {
      const compass40Overlay = `

---
**COMPASS-40 OVERLAY — MANDATORY OVERRIDES TO THE TEMPLATE ABOVE**

You are generating the trimmed, client-facing version of the Investor Compass report. Use the template structure above as the base, but apply ALL of the following overrides. These overrides WIN over anything in the template.

### 1. KEEP (Priority 1) — write these in full, but strip every financial figure

- **Executive Summary** — exactly ONE page. Cover: location verdict, property fit, tenant demand, key risks, recommendation. DO NOT include purchase price, LVR, yield, weekly rent, loan or cashflow figures. Use a non-financial \`{{glance}}\` opener and visual callouts rather than a financial KPI dashboard row.
- **Property Snapshot** — physical and strategic only: property type, bed/bath/car, land size, estate, suburb, target tenant, locality fit. DO NOT include price, rent, yield, LVR or loan details.
- **Location Overview** — strengthen. This is a core section explaining why the area matters.
- **Population & Development Trends** — keep in full (macro demand, master-planned growth corridor).
- **Suburb Character & Lifestyle** — keep but REDUCE. Who lives there, why tenants/buyers want it.
- **Demand Drivers** — major client-facing section: tenant demand, family formation, employment access, master-planned amenity.
- **Property-Level Information** — non-financial only: layout, land size, dwelling type, position within estate, tenant suitability, strengths, limitations.
- **Risk Summary** — consolidate crime + environmental + planning + supply into ONE visual risk panel using \`{{gauge}}\`, \`{{heatmap}}\` or \`{{bars}}\`; only use a table if the data cannot be visualised.
- **Final Recommendation** — rewrite as a simple verdict: **Proceed**, **Proceed with caution**, or **Not suitable**, followed by 150–250 words of plain rationale tied to location, tenant demand and risk. No financial verdict.

### 2. COMPRESS (Priority 2) — cap pages as specified, no padding

- **Education** — max 2–3 pages total. Do NOT split into multiple school sections.
- **Healthcare** — max 1 page (½ page is fine).
- **Shopping & Dining** — max 1 page. Daily convenience only, no long descriptive paragraphs.
- **Parks & Recreation** — max 1 page.
- **Transport** — consolidate public transport, commute, bus, road links and future upgrades into ONE 2–3 page section.
- **SEIFA / Socioeconomic Profile** — small evidence box only. Do NOT explain the index methodology.
- **Employment & Industry Composition** — render ONCE. Remove any duplicate employment sections appearing later in the template.

### 3. REMOVE ENTIRELY (Priority 3) — these sections and items MUST NOT appear anywhere

Sections to omit completely:
- Purchase Costs / Purchase & Ongoing Costs
- Annual Ongoing Costs
- Rental Yield Calculations (Gross & Net)
- Loan Assumptions
- Cashflow Analysis (P&I Scenario, any scenario)
- Interest Rate Sensitivity / Debt Serviceability Pressure
- 10-Year Projections (Property Value, Rental Income, Annual Cashflow, Cumulative)
- Loan Balance & Equity After 10 Years
- Capital Appreciation Potential – 10-Year Projection
- Structural Cashflow Deficit
- Rental Assessment & Yield Calculation
- Yield Comparison to Benchmarks
- Land Tax Note
- Income Potential – Pre-Calculated Yields (or rewrite as a short "tenant demand profile" with NO numbers)
- Growth Outlook – 5% p.a. Capital Growth Assumption
- Clear Yield Profile / Yield Below National Averages / Negative Cashflow Under 90% LVR

Dashboard / KPI items to omit (no card, no table cell, no inline mention):
- Purchase Price / Estimated Purchase Price
- Weekly Rent / Estimated Weekly Rent
- LVR
- Net Yield / Gross Rental Yield / Net Rental Yield
- Annual Rental Income
- Occupancy Assumption
- Loan amount and interest rate commentary

### 4. STYLE RULES

- Remove repeated transition paragraphs ("As we move into…", "Building on the above…", "This flows naturally…"). They make the report artificially long.
- NO commentary blocks at all. Never write ${EDITORIAL_LABELS.map((l) => `"${l}"`).join(', ')} — not as a heading, not as a bold lead-in, not as a bare line above a paragraph. There is no permitted number: not one per section, not one per report. State the finding in the sentence that introduces the data instead.
- Do NOT emit \`[citation]\`, \`[source needed]\`, \`[TBD]\` or any placeholder. Name the real source inline or omit the claim.
- Bed / bath / car / land size / property type stated in the Property Snapshot MUST match every later reference exactly.
- Where the legacy template would emit a financial figure, replace it with a single approved sentence: *"Detailed cashflow, yield, loan and 10-year projections are provided in the separate Financial Analysis Report."* Use this sentence AT MOST ONCE in the whole report.

### 5. PAGE TARGET

Aim for ${COMPASS_PAGE_BAND.min}–${COMPASS_PAGE_BAND.max} pages total after these trims. If the template would push you longer, trim Priority-2 sections further — never trim Priority-1 sections. A section that says what it has to say in half its word ceiling is finished; do not pad to the ceiling.

---
`;
      // Append at end AND prepend a short hard-rule banner at the very start
      // so the model sees the financial exclusions before any legacy template
      // language it may still be biased by from training data.
      const compass40Banner = `\n**⚠️ COMPASS-40 HARD RULES (read first, apply globally)**\n- This is a Location & Property Fit report. NO financial modelling appears anywhere: no purchase price, weekly rent, LVR, gross/net yield, loan amount, interest rate, monthly/annual repayment, cashflow, sensitivity, 10-year projections, stamp duty, deposit, LMI, depreciation, negative gearing, land tax.\n- NO FINANCIAL KPI dashboard rows. NO "Purchase Price | $X | Weekly Rent | $Y" tables. Non-financial visual callouts, gauges, bars, heatmaps, timelines, pictographs, donuts and glance strips are REQUIRED.\n- NO inline citation markers like [1] [2] [1][2] — name the real source inline or omit the claim.\n- Finish every sentence and paragraph. Do NOT stop mid-thought. If running out of room, end the section cleanly.\n- Render Education, Transport and Employment exactly ONCE, in their own dedicated sections, never repeated under other sections.\n---\n`;
      prompt = compass40Banner + prompt + compass40Overlay;
      console.log(`✓ Compass-40 banner + overlay injected. Prompt length now: ${prompt.length}`);
    }

    // ========== END RAG TEMPLATE CONTEXT INJECTION ==========
    
    const _brandSys = await getBrandConfig();
    const _brandName = _brandSys.companyName;
    const areaSystemMessages: Record<string, string> = {
      'suburb': `You are a trusted property investment advisor at ${_brandName} writing suburb-level analysis for clients who may not have a finance background. Lead with clear, plain-English insights and use supporting data selectively — never dump raw statistics without context. Explain what numbers mean in practical terms (e.g., "growing 40% faster than the metro average, which signals strong demand"). Use tables only for direct comparisons, not for listing single values. Every section should feel like advice from a knowledgeable friend, not an academic paper. Still be thorough and accurate — but prioritise readability and actionable takeaways.`,
      'postcode': `You are a trusted property investment advisor at ${_brandName} writing postcode-zone analysis for clients who may not have a finance background. Compare suburbs within the zone using clear narrative language. Use comparison tables sparingly and only when they genuinely aid understanding. Lead each section with the key insight before supporting it with data. Explain implications in practical terms — what does this mean for an investor considering this area?`,
      'statewide': `You are a trusted property investment advisor at ${_brandName} writing statewide macro analysis for clients who may not have a finance background. Provide a bird's-eye view of the state's property market in accessible, conversational language. Use data to support narrative points, not as the centrepiece. Focus on what matters to investors: where the opportunities are, what risks to watch, and how macro trends translate to real-world investment decisions.`,
    };
    const systemMessageDefault = areaSystemMessages[reportScope] || `You are a trusted property investment advisor at ${_brandName} writing a premium client-facing report. Your reader is a potential property investor who may not have a finance or economics background.

WRITING STYLE RULES:
1. Lead every section with a clear, plain-English insight or takeaway BEFORE presenting any data
2. Use a warm, professional, consultative tone — like a knowledgeable advisor speaking to a client
3. State what a figure means in the sentence that introduces it. NEVER add a paragraph after a table or data point that explains it — no "What This Means", "Why this matters", "What to watch", "Key takeaway" or "NPC view", as a heading, a bold lead-in or a bare line
4. Use tables ONLY for direct comparisons or financial breakdowns (max 5-6 rows). Never use a table when a well-written sentence would suffice
5. Replace jargon with plain language or briefly define technical terms on first use (e.g., "gross rental yield — the annual rent as a percentage of the property price")
6. Use contextual comparisons to make numbers meaningful (e.g., "This is 15% above the state average" rather than just stating the number)
7. Include brief connecting sentences between sections for narrative flow
8. Never use placeholders like "N/A" or "XX" — provide real data or clearly labelled estimates
9. Use the EXACT expense values provided in the PRE-CALCULATED ANNUAL COSTS section — do not substitute with defaults
10. Every section is MANDATORY — do not skip any

DATA INTEGRITY & CONSISTENCY RULES (CRITICAL — VIOLATIONS DESTROY REPORT CREDIBILITY):
11. SINGLE SOURCE OF TRUTH: When a specific data point is stated (e.g., station distance, SEIFA score, flood risk level, labor force size), you MUST use the IDENTICAL value in every section of the report. Never contradict yourself across sections.
12. BENCHMARK COMPARISONS MUST BE MATHEMATICALLY CORRECT: If you say a value "exceeds" or "outperforms" a benchmark, the value MUST actually be higher. If 4.13% yield is compared to a 4.2% national average, that is BELOW average — say "slightly below" or "competitive with", never "exceeds". Double-check every comparison statement.
13. ONE FINANCIAL SCENARIO: Use a SINGLE deposit/LVR scenario consistently throughout the report. Do NOT switch between 10% and 20% deposit, or 80% and 90% LVR, without explicitly labelling them as separate scenarios in a dedicated comparison table. The PRIMARY scenario uses the values from the PRE-CALCULATED section.
14. RISK RATINGS MUST BE CONSISTENT: If flood risk is stated as "Moderate" in the Environmental section, it must remain "Moderate" everywhere. Never contradict a risk rating (e.g., "moderate" then "low/none" then "unverified") — pick the most accurate assessment from the data provided and use it consistently.
15. NO FABRICATED PRECISION: Do not invent hyper-specific statistics like "9.2% growth uplift from station upgrade" or "8.2% transport-driven uplift" unless you can cite a specific study. Use ranges ("5-8% historically") or qualitative language ("significant positive impact") instead. Overly precise unsourced claims feel fabricated and undermine trust.
20. DATE-STAMP TIME-SENSITIVE DATA: For economic indicators (cash rate, CPI, unemployment), always include "as at [Month Year]" so readers know the currency of the data.

This report should feel like a polished advisory document that inspires confidence, not a data spreadsheet.`;

    // Runtime overrides (resolution order, first hit wins):
    //  1. report_engine_config(config_key='prompt:investment_report.system.<scope>', scope='default')  ← Prompt Library
    //  2. report_engine_config(config_key='prompt:investment_report.system.default', scope='default')  ← Prompt Library fallback
    //  3. report_engine_config(config_key='system_message', scope=<scope>)                              ← legacy Engine Config
    //  4. report_engine_config(config_key='system_message', scope='default')                            ← legacy Engine Config fallback
    //  5. in-code areaSystemMessages[<scope>] / systemMessageDefault
    let systemMessage = systemMessageDefault;
    let systemMessageOverrideScope: string | null = null;
    try {
      const scopeKey = `prompt:investment_report.system.${reportScope}`;
      const defaultKey = 'prompt:investment_report.system.default';
      const [{ data: promptRows }, { data: cfgRows }] = await Promise.all([
        supabase
          .from('report_engine_config')
          .select('config_key, value')
          .in('config_key', [scopeKey, defaultKey])
          .eq('scope', 'default'),
        supabase
          .from('report_engine_config')
          .select('scope, value')
          .eq('config_key', 'system_message')
          .in('scope', [reportScope, 'default']),
      ]);
      const promptScoped = (promptRows ?? []).find((r: any) => r.config_key === scopeKey);
      const promptDefault = (promptRows ?? []).find((r: any) => r.config_key === defaultKey);
      const legacyScoped = (cfgRows ?? []).find((r: any) => r.scope === reportScope);
      const legacyDefault = (cfgRows ?? []).find((r: any) => r.scope === 'default');
      const pick = promptScoped || (areaSystemMessages[reportScope] ? null : promptDefault) || legacyScoped || legacyDefault;
      const pickSource = pick === promptScoped ? `prompt-library:${reportScope}`
        : pick === promptDefault ? 'prompt-library:default'
        : pick === legacyScoped ? `engine-config:${reportScope}`
        : pick === legacyDefault ? 'engine-config:default'
        : null;
      const rawValue = pick ? (typeof pick.value === 'string' ? pick.value : (pick.value?.text ?? pick.value?.value ?? null)) : null;
      if (rawValue && typeof rawValue === 'string' && rawValue.trim()) {
        systemMessage = rawValue
          .replace(/\{\{brand_name\}\}/g, _brandName)
          .replace(/\{\{scope\}\}/g, reportScope || '');
        systemMessageOverrideScope = pickSource;
        console.log(`✏️  system prompt override from ${pickSource}`);
      }
    } catch (cfgErr) {
      console.warn('system prompt override lookup failed (fail-open):', cfgErr);
    }


    console.log('=== MULTI-SECTION REPORT GENERATION ===');
    console.log('Report scope:', reportScope);
    console.log('Base prompt length:', prompt.length);
    console.log('Document content included:', !!documentContent);
    console.log('Template context included:', !!templateContext);
    console.log('Content source:', contentSource);
    console.log('Continuation mode:', isContinuation);
    console.log('Completed sections to skip:', completedSectionIndices);
    console.log('Generating report in', REPORT_SECTIONS.length, 'sections...');

    // Generate report in multiple sections
    let combinedContent = '';
    let allCitations: any[] = [];
    let generationErrors: string[] = [];
    // Ensures enhanced data (score/financials/etc.) is persisted once per request in chunked mode
    let enhancedDataPersisted = false;
    
    // Handle continuation mode: start with existing content if available
    if (isContinuation && existingReportContent && existingReportContent.length > 0) {
      combinedContent = existingReportContent;
      console.log('🔄 Starting from existing content:', combinedContent.length, 'chars');
      
      // Ensure content ends with proper separator for appending new sections
      if (!combinedContent.trim().endsWith('---')) {
        combinedContent = combinedContent.trim() + '\n\n---\n\n';
      }
    } else {
      // Fresh generation: Add report header
      const reportHeader = `# ${_brandName.toUpperCase()}

YOUR DEDICATED PROPERTY PARTNER

# Investment Report: ${formattedInput}

---

`;
      combinedContent = reportHeader;
    }

    // Track section quality for final validation
    const sectionResults: Array<{ id: string; name: string; content: string; valid: boolean; score: number; attempts: number }> = [];

    // ============================================================================
    // EARLY ENHANCED DATA PERSISTENCE
    // Persist scoring + calculations before section generation so chunked/resume calls
    // don't miss the one-time "first section" persistence condition.
    // ============================================================================
    if (reportId && supabaseClient) {
      try {
        const earlyUpdate: any = { updated_at: new Date().toISOString() };

        // Only write fields that are currently missing on the report row
        if (!existingEnhancedFields.investmentScore && enhancedData?.investmentScore) {
          earlyUpdate.investment_score = enhancedData.investmentScore;
        }
        if (!existingEnhancedFields.financials && enhancedData?.financials) {
          earlyUpdate.financial_calculations = enhancedData.financials;
        }
        if (!existingEnhancedFields.demographics && enhancedData?.demographics) {
          earlyUpdate.demographics_data = enhancedData.demographics;
        }
        if (!existingEnhancedFields.economics && enhancedData?.economics) {
          earlyUpdate.economic_data = enhancedData.economics;
        }
        if (!existingEnhancedFields.locationIntelligence && enhancedData?.locationIntelligence) {
          earlyUpdate.location_intelligence = enhancedData.locationIntelligence;
        }

        const hasAnyEnhancedField = Object.keys(earlyUpdate).length > 1;
        const alreadyHasAnyEnhancedField = !!(
          existingEnhancedFields.investmentScore ||
          existingEnhancedFields.financials ||
          existingEnhancedFields.demographics ||
          existingEnhancedFields.economics ||
          existingEnhancedFields.locationIntelligence
        );

        if (hasAnyEnhancedField) {
          console.log('💾 Early persistence: saving enhanced data to DB before section generation...');
          await supabaseClient
            .from('investment_reports')
            .update(earlyUpdate)
            .eq('id', reportId);
          enhancedDataPersisted = true;
          console.log('✓ Early enhanced data saved:', Object.keys(earlyUpdate).filter(k => k !== 'updated_at').join(', '));
        } else {
          // If the DB already has enhanced fields, treat them as persisted for this run
          enhancedDataPersisted = alreadyHasAnyEnhancedField;
        }
      } catch (earlyPersistError: any) {
        console.warn('⚠️ Early enhanced data persistence failed (non-blocking):', earlyPersistError?.message);
      }
    }
    
    // ============================================================================
    // AREA REPORT SECTION EXCLUSION
    // For suburb/postcode/statewide reports, filter out property-specific financial sections
    // These sections require property-level data (purchase price, loan details, etc.)
    // that don't apply to area-level analysis
    // ============================================================================
    const AREA_EXCLUDED_SECTION_KEYWORDS = [
      'costs & rental', 'loan & sensitivity', 'projections & swot',
      'assumptions', 'cash flow', 'cashflow', 'loan structure', 'repayment',
      'sensitivity analysis', 'purchase & ongoing', 'rental assessment',
      '10-year', 'ten-year', 'ten year', 'operating costs',
      'initial purchase', 'annual costs', 'financial analysis',
      'mortgage', 'stamp duty calculation', 'depreciation',
      'negative gearing', 'tax benefit', 'equity growth projection'
    ];

    const filteredSections = isAreaReport
      ? REPORT_SECTIONS.filter(s => {
          const nameLower = s.name.toLowerCase();
          const sectionHeadingsLower = s.sections.map(h => h.toLowerCase());
          const isExcluded = AREA_EXCLUDED_SECTION_KEYWORDS.some(kw =>
            nameLower.includes(kw) || sectionHeadingsLower.some(h => h.includes(kw))
          );
          if (isExcluded) {
            console.log(`⏭️ AREA REPORT: Excluding property-level section: "${s.name}" [${s.sections.join(', ')}]`);
          }
          return !isExcluded;
        })
      : REPORT_SECTIONS;

    console.log(`📋 Sections to generate: ${filteredSections.length}/${REPORT_SECTIONS.length}${isAreaReport ? ` (${REPORT_SECTIONS.length - filteredSections.length} excluded for area report)` : ''}`);

    // === OBSERVABILITY: start a generation run row (best-effort, never throws) ===
    const _traceSb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const _traceRunId: string | null = await traceStartRun(_traceSb, {
      report_id: reportId ?? null,
      scope: reportScope ?? null,
      variant: (requestBody as any)?.variant ?? null,
      engine_version: 'composite-v1',
      trigger_source: isContinuation ? 'chunked-resume' : 'generate',
      template_ids: [],
      system_prompt: systemMessage,
      data_packet: enhancedData ?? null,
      model: 'sonar-pro',
    });
    if (_traceRunId) console.log(`🔭 generation-trace run started: ${_traceRunId}`);

    // Rolling average of section wall time, used to predict whether the next
    // section fits in what is left of the budget.
    const sectionDurationsMs: number[] = [];
    let budgetExhausted = false;
    let lastCompletedSectionIndex = completedSectionIndices.length
      ? Math.max(...completedSectionIndices) + 1
      : 0;

    for (let i = 0; i < filteredSections.length; i++) {
      const sectionDef = filteredSections[i];
      const _chunkStart = Date.now();

      // CONTINUATION MODE: Skip already-completed sections
      if (isContinuation && completedSectionIndices.includes(i)) {
        console.log(`\n⏭️ Skipping section ${i + 1}/${filteredSections.length}: ${sectionDef.name} (already complete)`);
        sectionResults.push({
          id: sectionDef.id,
          name: sectionDef.name,
          content: '[Retained from previous generation]',
          valid: true,
          score: 100,
          attempts: 0
        });
        continue;
      }

      // === WALL-CLOCK BUDGET GUARD ===
      // Only ever bail BETWEEN sections, and only once this run has banked at
      // least one section — otherwise a resume that starts near the ceiling
      // could spin forever making no progress.
      const elapsedMs = Date.now() - runStartedAt;
      const predictedSectionMs = sectionDurationsMs.length
        ? sectionDurationsMs.reduce((a, b) => a + b, 0) / sectionDurationsMs.length
        : DEFAULT_SECTION_ESTIMATE_MS;
      const isLastSection = i === filteredSections.length - 1;
      // The final section is followed by post-processing, so it needs more room.
      const requiredMs = predictedSectionMs + (isLastSection ? POST_PROCESSING_RESERVE_MS : 0);

      if (sectionDurationsMs.length > 0 && elapsedMs + requiredMs > SECTION_LOOP_BUDGET_MS) {
        console.log(
          `⏱️ Wall-clock budget reached after ${Math.round(elapsedMs / 1000)}s ` +
          `(next section needs ~${Math.round(requiredMs / 1000)}s, budget ${SECTION_LOOP_BUDGET_MS / 1000}s). ` +
          `Stopping at section ${lastCompletedSectionIndex}/${filteredSections.length} and handing off to resume.`
        );
        budgetExhausted = true;
        break;
      }

      console.log(`\n📄 Generating section ${i + 1}/${filteredSections.length}: ${sectionDef.name}`);
      
      // Pass context from previous sections for consistency
      const previousContext = combinedContent.length > 500 ? combinedContent.substring(combinedContent.length - 2000) : '';
      
      // === SECTION GENERATION WITH VALIDATION AND RETRY ===
      let bestContent = '';
      let bestScore = 0;
      let sectionAttempts = 0;
      const maxSectionAttempts = 2; // Retry once if content is insufficient
      
      for (let attempt = 1; attempt <= maxSectionAttempts; attempt++) {
        sectionAttempts = attempt;
        
        const result = await generateReportSection(
          sectionDef,
          prompt,
          systemMessage,
          perplexityApiKey,
          previousContext,
          formattedInput,
          enhancedData
        );
        
        if (result.error) {
          console.error(`⚠️ Section ${sectionDef.name} attempt ${attempt} failed:`, result.error);
          if (attempt === maxSectionAttempts) {
            generationErrors.push(`${sectionDef.name}: ${result.error}`);
          }
          continue;
        }
        
        if (result.content) {
          // Clean the content
          let cleanContent = result.content
            .replace(/^(Here|I will|Let me|Now|The following).*?:\s*/im, '')
            .replace(/^(Certainly|Sure|Of course).*?\n/im, '')
            .trim();

          // Compass-40: scrub financial leaks, citation markers, dangling sentences.
          if (compass40OverlayActive) {
            const before = cleanContent.length;
            cleanContent = sanitizeCompass40Content(cleanContent);
            if (cleanContent.length !== before) {
              console.log(`🧼 Compass-40 sanitizer: ${before} → ${cleanContent.length} chars (section "${sectionDef.name}")`);
            }
          }

          
          // Validate section content
          const validation = validateSectionContent(sectionDef, cleanContent);
          console.log(`📊 Section ${sectionDef.name} validation (attempt ${attempt}):`, {
            contentLength: cleanContent.length,
            minRequired: sectionDef.minContentLength,
            score: validation.score,
            isValid: validation.isValid,
            issues: validation.issues.length > 0 ? validation.issues : 'None'
          });
          
          // Keep the best attempt
          if (validation.score > bestScore) {
            bestContent = cleanContent;
            bestScore = validation.score;
            allCitations = [...allCitations, ...result.citations];
          }
          
          // If valid, no need to retry
          if (validation.isValid) {
            console.log(`✓ Section ${sectionDef.name} passed validation with score ${validation.score}`);
            break;
          } else if (attempt < maxSectionAttempts) {
            console.log(`⚠️ Section ${sectionDef.name} below threshold (score: ${validation.score}), retrying...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
          }
        }
      }
      // === END SECTION GENERATION WITH VALIDATION ===
      
      // Use best content from all attempts
      if (bestContent) {
        // === CAPITAL GROWTH EXTRACTION: Extract researched capital growth from content ===
        // If capital growth was not manually overridden, try to extract the researched value from the AI-generated content
        if (!hasOverrides || !manualOverrides?.capitalGrowth) {
          const extractedCapitalGrowth = extractCapitalGrowthFromContent(bestContent);
          if (extractedCapitalGrowth !== null && enhancedData?.financials) {
            console.log(`📈 Extracted researched capital growth rate: ${extractedCapitalGrowth}%`);
            
            // Ensure assumptions object exists
            if (!enhancedData.financials.assumptions) {
              enhancedData.financials.assumptions = {};
            }
            
            // Only set if not already set by manual override
            if (!enhancedData.financials.assumptions.capitalGrowth) {
              enhancedData.financials.assumptions.capitalGrowth = extractedCapitalGrowth;
              console.log(`✓ Capital growth rate set in financials: ${extractedCapitalGrowth}%`);
            }
          }
        }
        // === END CAPITAL GROWTH EXTRACTION ===
        
        combinedContent += bestContent + '\n\n---\n\n';

        // === OBSERVABILITY: record this chunk ===
        await traceRecordChunk(_traceSb, _traceRunId, {
          section_key: sectionDef.id,
          section_label: sectionDef.name,
          ordinal: i,
          phase: sectionAttempts > 1 ? 'retry' : 'first-pass',
          model: 'sonar-pro',
          system_prompt: systemMessage,
          user_prompt: `[section ${sectionDef.name}] basePrompt sha-skipped (len=${prompt.length})`,
          attached_packet_keys: enhancedData ? Object.keys(enhancedData).filter((k) => !k.startsWith('_')) : [],
          response: bestContent,
          retry_count: sectionAttempts - 1,
          status: 'completed',
          latency_ms: Date.now() - _chunkStart,
        });
        
        sectionResults.push({
          id: sectionDef.id,
          name: sectionDef.name,
          content: bestContent,
          valid: bestScore >= 60,
          score: bestScore,
          attempts: sectionAttempts
        });
        
        // === PROGRESSIVE SAVE: Save after each section ===
        // CRITICAL: Save last_completed_section for reliable resume functionality
        if (reportId && supabaseClient) {
          try {
            const completedSectionIndex = i + 1; // Section i is now complete (0-indexed to 1-indexed)
            console.log(`💾 Progressive save after section ${completedSectionIndex}/${filteredSections.length}...`);
            
            // Build progressive update payload
            // Persist `total_sections` so the front-end progress widget can
            // show the actual chunk count for the engine that ran (legacy
            // groups headings dynamically and the count varies between
            // templates; Compass-40 is a fixed 17). Without this the widget
            // falls back to the tier-based default and may misreport totals.
            const progressiveUpdatePayload: any = {
              report_content: combinedContent,
              last_completed_section: completedSectionIndex,
              total_sections: filteredSections.length,
              updated_at: new Date().toISOString()
            };
            
            // CRITICAL: Save enhanced data (including investment_score) on FIRST section completion
            // This ensures scores are persisted early, even if chunked generation is interrupted
            let didAttachEnhancedData = false;
            if (!enhancedDataPersisted && enhancedData) {
              console.log('📊 First generated section in this run - saving enhanced data to DB...');
              if (enhancedData.investmentScore) {
                progressiveUpdatePayload.investment_score = enhancedData.investmentScore;
                console.log('  ✓ Saving investment_score:', enhancedData.investmentScore?.grade, enhancedData.investmentScore?.totalScore);
                didAttachEnhancedData = true;
              }
              if (enhancedData.financials) {
                progressiveUpdatePayload.financial_calculations = enhancedData.financials;
                console.log('  ✓ Saving financial_calculations');
                didAttachEnhancedData = true;
              }
              if (enhancedData.demographics) {
                progressiveUpdatePayload.demographics_data = enhancedData.demographics;
                console.log('  ✓ Saving demographics_data');
                didAttachEnhancedData = true;
              }
              if (enhancedData.economics) {
                progressiveUpdatePayload.economic_data = enhancedData.economics;
                console.log('  ✓ Saving economic_data');
                didAttachEnhancedData = true;
              }
              if (enhancedData.locationIntelligence) {
                progressiveUpdatePayload.location_intelligence = enhancedData.locationIntelligence;
                console.log('  ✓ Saving location_intelligence');
                didAttachEnhancedData = true;
              }
            }
            
            await supabaseClient
              .from('investment_reports')
              .update(progressiveUpdatePayload)
              .eq('id', reportId);
            console.log(`✓ Progress saved: ${combinedContent.length} chars, last_completed_section=${completedSectionIndex}`);
            // Feed the budget predictor and remember how far we actually got,
            // so a budget-exhausted return can report the true section count.
            sectionDurationsMs.push(Date.now() - _chunkStart);
            lastCompletedSectionIndex = completedSectionIndex;

            if (didAttachEnhancedData) {
              enhancedDataPersisted = true;
            }
            
            // === SINGLE-SECTION MODE: Return immediately after saving one section ===
            // This allows the frontend to call again for the next section, avoiding platform timeouts
            if (isSingleSectionMode) {
              const isFullyComplete = completedSectionIndex >= filteredSections.length;
              console.log(`🔧 Single-section mode: Completed section ${completedSectionIndex}/${filteredSections.length}`);
              
              if (!isFullyComplete) {
                // Return immediately - UI will call again for next section
                return new Response(JSON.stringify({
                  success: true,
                  message: `Section ${completedSectionIndex}/${filteredSections.length} completed`,
                  sectionCompleted: completedSectionIndex,
                  totalSections: filteredSections.length,
                  isComplete: false,
                  contentLength: combinedContent.length
                }), {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
              }
              // If all sections complete, continue to post-processing below
              console.log('✅ All sections complete in single-section mode, proceeding to finalization...');
            }
            // === END SINGLE-SECTION MODE ===
          } catch (saveError: any) {
            console.warn(`⚠️ Progressive save failed (non-blocking):`, saveError?.message);
          }
        }
        // === END PROGRESSIVE SAVE ===
      } else {
        // No content generated for this section at all - still save progress
        sectionResults.push({
          id: sectionDef.id,
          name: sectionDef.name,
          content: '',
          valid: false,
          score: 0,
          attempts: sectionAttempts
        });
        
        // === PROGRESSIVE SAVE ON FAILURE: Save current state even if section failed ===
        // This allows continuation from last successful section
        // Note: last_completed_section is NOT incremented on failure (keeps last good value)
        if (reportId && supabaseClient && combinedContent.length > 0) {
          try {
            console.log(`💾 Progressive save after section ${i + 1} failure (preserving progress)...`);
            await supabaseClient
              .from('investment_reports')
              .update({
                report_content: combinedContent,
                // Don't update last_completed_section - it should stay at the last successfully completed section
                updated_at: new Date().toISOString(),
                error_message: `Section ${sectionDef.name} failed to generate after ${sectionAttempts} attempts`
              })
              .eq('id', reportId);
            console.log(`✓ Progress preserved: ${combinedContent.length} chars before failed section (last_completed_section unchanged)`);
          } catch (saveError: any) {
            console.warn(`⚠️ Failed section save error (non-blocking):`, saveError?.message);
          }
        }

        // === SINGLE-SECTION MODE: return on failure too ===
        // The success path returns after one section; without the same return
        // here a failed section fell through and the loop carried on generating
        // every remaining section in the same invocation — precisely the
        // platform-timeout behaviour single-section mode exists to prevent.
        if (isSingleSectionMode) {
          console.log(`🔧 Single-section mode: section ${i + 1}/${filteredSections.length} failed, returning for retry`);
          await traceFinishRun(_traceSb, _traceRunId, { status: 'failed', error: `Section ${sectionDef.name} produced no content` });
          return new Response(JSON.stringify({
            success: false,
            error: `Section ${sectionDef.name} failed to generate after ${sectionAttempts} attempts`,
            sectionCompleted: lastCompletedSectionIndex,
            totalSections: filteredSections.length,
            isComplete: false,
            resumeRequired: true,
            contentLength: combinedContent.length,
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Adaptive delay between sections to avoid rate limiting
      // Use jitter to prevent thundering herd
      if (i < filteredSections.length - 1) {
        const baseDelay = 500;
        const jitter = Math.random() * 500; // 0-500ms jitter
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
      }
    }

    // === BUDGET HANDOFF ===
    // We stopped short of the last section on purpose. Everything generated so
    // far is already persisted by the progressive save above, and the row stays
    // 'processing' so the watchdog (or the browser pump) picks it up. Returning
    // 200 with resumeRequired is what distinguishes "more work to do" from the
    // old silent kill, where the caller learned nothing at all.
    if (budgetExhausted) {
      const remaining = filteredSections.length - lastCompletedSectionIndex;
      console.log(
        `🔁 Handing off after ${lastCompletedSectionIndex}/${filteredSections.length} sections ` +
        `(${remaining} remaining, ${combinedContent.length} chars banked)`
      );
      await traceFinishRun(_traceSb, _traceRunId, {
        status: 'paused',
        error: `Wall-clock budget reached at section ${lastCompletedSectionIndex}/${filteredSections.length}`,
      });

      // Persist the true section count (the progress widget and the watchdog
      // both read it) and clear any error left by an earlier failed attempt —
      // this run succeeded, it just is not finished. updated_at is stamped so
      // the watchdog's staleness window runs from real progress.
      if (reportId && supabaseClient) {
        await supabaseClient
          .from('investment_reports')
          .update({
            status: 'processing',
            error_message: null,
            total_sections: filteredSections.length,
            updated_at: new Date().toISOString(),
          })
          .eq('id', reportId);
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Generated ${lastCompletedSectionIndex}/${filteredSections.length} sections; resume required`,
        sectionCompleted: lastCompletedSectionIndex,
        totalSections: filteredSections.length,
        isComplete: false,
        resumeRequired: true,
        contentLength: combinedContent.length,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === FINAL VALIDATION SUMMARY ===
    const totalScore = sectionResults.reduce((sum, s) => sum + s.score, 0);
    const avgScore = Math.round(totalScore / sectionResults.length);
    const invalidSections = sectionResults.filter(s => !s.valid);
    
    console.log('\n📊 === REPORT GENERATION QUALITY SUMMARY ===');
    console.log(`Total content length: ${combinedContent.length} chars`);
    console.log(`Average section score: ${avgScore}/100`);
    console.log(`Sections passed: ${sectionResults.filter(s => s.valid).length}/${sectionResults.length}`);
    
    if (invalidSections.length > 0) {
      console.log('⚠️ Sections with quality issues:');
      invalidSections.forEach(s => {
        console.log(`  - ${s.name}: score ${s.score}, ${s.content.length} chars, ${s.attempts} attempts`);
      });
    }
    
    // Store quality metadata for debugging
    const qualityMetadata = {
      generatedAt: new Date().toISOString(),
      totalContentLength: combinedContent.length,
      averageScore: avgScore,
      sectionScores: sectionResults.map(s => ({ id: s.id, name: s.name, score: s.score, valid: s.valid, attempts: s.attempts })),
      invalidSectionCount: invalidSections.length,
      errorsEncountered: generationErrors.length
    };
    console.log('📋 Quality metadata:', JSON.stringify(qualityMetadata));
    // === END FINAL VALIDATION ===

    // Enhanced content validation with stricter minimum threshold
    const MINIMUM_TOTAL_CONTENT = 45000; // Based on analysis of good reports (50k+ chars)
    
    if (combinedContent.length < 5000) {
      const errorMsg = `Report generation produced insufficient content (${combinedContent.length} chars). Errors: ${generationErrors.join('; ')}`;
      console.error('❌', errorMsg);
      await markReportFailed(reportId, errorMsg);
      return new Response(JSON.stringify({ 
        error: errorMsg,
        success: false 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // Warn if content is below ideal threshold but still usable
    if (combinedContent.length < MINIMUM_TOTAL_CONTENT) {
      console.warn(`⚠️ Report content (${combinedContent.length} chars) is below ideal threshold (${MINIMUM_TOTAL_CONTENT} chars)`);
      console.warn(`   This may result in fewer pages. Average score: ${avgScore}/100`);
      // Add a validation flag for low content
      generationErrors.push(`Content below ideal threshold: ${combinedContent.length} chars (recommended: ${MINIMUM_TOTAL_CONTENT}+)`);
    }

    console.log(`\n✓ Multi-section generation complete`);
    console.log(`  Total content length: ${combinedContent.length} chars`);
    console.log(`  Total citations: ${allCitations.length}`);
    console.log(`  Sections with errors: ${generationErrors.length}`);
    console.log(`  Quality assessment: ${avgScore >= 70 ? '✅ Good' : avgScore >= 50 ? '⚠️ Acceptable' : '❌ Below Standard'}`);


    let reportContent = combinedContent;
    
    // ========== DEDUPLICATE HEADERS ==========
    // The AI sometimes generates duplicate company headers and report titles
    // This removes all occurrences except the first one
    console.log('🧹 Deduplicating headers from report content...');
    
    // Helper function to remove duplicate header patterns
    const deduplicateHeaders = (content: string): string => {
      // Patterns to deduplicate (keep only first occurrence)
      const headerPatterns = [
        // Company name header (with # or without)
        /^#?\s*NAIDU PROPERTY CONSULTING SERVICES\s*$/gim,
        // Company slogan
        /^YOUR DEDICATED PROPERTY PARTNER\s*$/gim,
        // Investment Report title (with # or without, captures the address)
        /^#?\s*Investment Report:\s*.+$/gim,
      ];
      
      let result = content;
      
      for (const pattern of headerPatterns) {
        // Find all matches
        const matches = result.match(pattern);
        if (matches && matches.length > 1) {
          console.log(`  Found ${matches.length} occurrences of pattern, keeping first only`);
          // Keep only the first occurrence by replacing subsequent ones
          let count = 0;
          result = result.replace(pattern, (match) => {
            count++;
            return count === 1 ? match : '';
          });
        }
      }
      
      // Clean up excessive newlines and separators left after removal
      result = result
        .replace(/\n{4,}/g, '\n\n\n') // Max 3 consecutive newlines
        .replace(/(\n---\s*){2,}/g, '\n---\n') // Remove duplicate separators
        .replace(/^\s*---\s*\n\s*---/gm, '---') // Clean adjacent separators
        .trim();
      
      return result;
    };
    
    const beforeDedup = reportContent.length;
    reportContent = deduplicateHeaders(reportContent);
    const afterDedup = reportContent.length;
    console.log(`✓ Header deduplication complete: ${beforeDedup} → ${afterDedup} chars (removed ${beforeDedup - afterDedup} chars)`);
    // ========== END DEDUPLICATE HEADERS ==========
    
    // Filter out reasoning sections from Sonar Deep Research model
    // Remove content between reasoning markers and thinking blocks
    reportContent = reportContent
      .replace(/```thinking[\s\S]*?```/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/\*\*Reasoning:\*\*[\s\S]*?(?=\*\*|$)/gi, '')
      .replace(/\*\*Analysis:\*\*[\s\S]*?(?=\*\*|$)/gi, '')
      .replace(/\*\*Thought process:\*\*[\s\S]*?(?=\*\*|$)/gi, '')
      .replace(/Let me analyze[\s\S]*?(?=\n\n|\*\*|$)/gi, '')
      .replace(/I need to[\s\S]*?(?=\n\n|\*\*|$)/gi, '')
      .replace(/First, I'll[\s\S]*?(?=\n\n|\*\*|$)/gi, '')
      .replace(/To provide[\s\S]*?(?=\n\n|\*\*|$)/gi, '')
      .trim();

    // ========== POST-PROCESSING SANITIZATION ==========
    // Fix HTML entities that may have been introduced during generation
    reportContent = reportContent
      // Fix common HTML entities
      .replace(/&#x26;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&#x22;/g, '"')
      .replace(/&#x3C;/g, '<')
      .replace(/&#x3E;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      // Fix erroneous semicolons in text
      .replace(/(\w);(\s)/g, '$1,$2')
      // Remove stray page numbers appearing as standalone lines
      .replace(/^\d{1,3}\s*$/gm, '')
      // Remove pagination artifacts like "Page X of Y"
      .replace(/^Page\s+\d+\s*(of\s+\d+)?\s*$/gim, '')
      // Remove empty methodology sections (heading with no content before next heading)
      .replace(/#{2,3}\s*Methodology\s*Notes?\s*\n+(?=#{1,3}\s|\n*$)/gi, '')
      // Clean up excessive whitespace left after removals
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/(\n---\s*){2,}/g, '\n---\n')
      .trim();
    console.log('✓ Post-processing sanitization complete');
    // ========== END POST-PROCESSING SANITIZATION ==========

    // ========== COMPASS POST-PROCESSOR + QA ==========
    //
    // This is the seam that was missing. `compassPostProcessor` and
    // `compassQAValidator` were written, tested and imported by exactly one
    // caller — `condense-investment-report`, which makes the derived snapshot
    // and briefing variants (44 rows). The generator that produced all 1,124
    // Compass reports in the table called neither, so every cap they enforce
    // applied to everything except the document a client receives. That is why
    // the report ran at 2.3× its declared budget with ~90 commentary labels.
    //
    // It runs after the sanitizer (which works line by line on a section) and
    // before the row is written, because it needs the assembled document: the
    // page-pressure ladder measures the whole thing, and a label's paragraph
    // can cross a section boundary.
    //
    // QA is recorded, never thrown. A report that exists and is over its band
    // is more use to everyone than no report; `validation_flags` is where a
    // finding belongs, and the row carries the rest of its quality metadata
    // there already.
    let compassQa: ReturnType<typeof runQAValidation> | null = null;
    if (compass40OverlayActive) {
      const beforePost = reportContent.length;
      const { markdown, report: postReport } = postProcessReportMarkdown(reportContent, 'compass-40');
      reportContent = markdown;
      compassQa = runQAValidation(reportContent, 'compass-40');

      console.log(
        `✓ Compass post-processor: ${beforePost} → ${reportContent.length} chars, ` +
        `${postReport.editorialBlocksRemoved} editorial block(s) removed (${postReport.editorialWordsRemoved} words), ` +
        `${postReport.sectionsTrimmed.length} section(s) trimmed, ` +
        `trims applied: [${postReport.trimsApplied.join(', ') || 'none'}], ` +
        `${postReport.initialEstimatedPages} → ${postReport.finalEstimatedPages} est. pages`,
      );
      console.log(
        `✓ Compass QA: ${compassQa.passed ? 'passed' : 'FAILED'} — ` +
        `${compassQa.estimatedPages} est. pages, ${compassQa.wordCount} words, ` +
        `${compassQa.findings.filter((f) => f.severity === 'error').length} error(s), ` +
        `${compassQa.findings.filter((f) => f.severity === 'warning').length} warning(s)`,
      );
      for (const finding of compassQa.findings) {
        console.log(`   [${finding.severity}] ${finding.rule}: ${finding.message}`);
      }
    }
    // ========== END COMPASS POST-PROCESSOR + QA ==========


    // Extract citations and sources from the response
    const citations = allCitations;
    const searchResults: any[] = [];
    
    // Format sources section
    let sourcesContent = '';
    if (citations.length > 0 || searchResults.length > 0) {
      sourcesContent = '\n\n## SOURCES & REFERENCES\n\n';
      
      if (citations.length > 0) {
        sourcesContent += '### Citations:\n';
        // Deduplicate citations
        const uniqueCitations = [...new Set(citations.map((c: any) => c.url || c.title || c))];
        uniqueCitations.forEach((citation: any, index: number) => {
          sourcesContent += `${index + 1}. ${citation}\n`;
        });
        sourcesContent += '\n';
      }
      
      if (searchResults.length > 0) {
        sourcesContent += '### Additional Sources:\n';
        searchResults.forEach((result: any, index: number) => {
          const title = result.title || 'Source';
          const url = result.url || '';
          sourcesContent += `${index + 1}. [${title}](${url})\n`;
        });
      }
    }

    console.log('Report generated successfully, content length:', reportContent.length);
    console.log('Citations found:', citations.length);

    // Validate report structure against schema
    console.log('🔍 Validating report structure...');
    let schemaValidationFlags: any[] = [];
    
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
      
      if (supabaseUrl && supabaseAnonKey) {
        const schemaValidatorClient = createClient(supabaseUrl, supabaseAnonKey);
        
        const { data: schemaValidation, error: schemaError } = await schemaValidatorClient.functions.invoke(
          'report-schema-validator',
          {
            body: { reportContent }
          }
        );
        
        if (schemaError) {
          console.error('Schema validation error:', schemaError);
        } else if (schemaValidation) {
          console.log('✓ Schema validation complete');
          console.log('Schema valid:', schemaValidation.valid);
          console.log('Schema issues found:', schemaValidation.issues?.length || 0);
          
          // Convert schema issues to validation flags
          if (schemaValidation.issues && schemaValidation.issues.length > 0) {
            schemaValidationFlags = schemaValidation.issues.map((issue: any) => ({
              type: 'schema',
              severity: issue.severity || 'medium',
              field: issue.section || 'structure',
              message: issue.message,
              value: issue.details || null
            }));
          }
        }
      }
    } catch (validationError) {
      console.error('Error during schema validation:', validationError);
      // Continue without blocking report generation
    }

    // Update database if reportId provided
    if (reportId && supabaseClient) {
      console.log('Updating report in database with ID:', reportId);
      
      // Prepare property specs from property details
      const propertySpecs = {
        land_size_sqm: propertyDetails?.landSize || null,
        building_size_sqm: propertyDetails?.buildingSize || null,
        bedrooms: propertyDetails?.beds || null,
        bathrooms: propertyDetails?.baths || null,
        parking: propertyDetails?.parking || null,
        year_built: propertyDetails?.yearBuilt || null,
        property_type: standardizedPropertyType || propertyDetails?.propertyType || 'Residential Property',
        zoning: propertyDetails?.zoning || null,
        council_area: propertyDetails?.councilArea || null
      };
      
      // Prepare data sources tracking
      const dataSources = {
        demographics: enhancedData.demographics ? {
          source: 'abs',
          confidence: enhancedData.demographics.data_quality === 'live' ? 1.0 : 0.6,
          timestamp: new Date().toISOString()
        } : null,
        financials: enhancedData.financials ? {
          source: 'calculated',
          confidence: 1.0,
          timestamp: new Date().toISOString()
        } : null,
        marketData: enhancedData.domainData ? {
          source: 'domain',
          confidence: 0.9,
          timestamp: new Date().toISOString()
        } : null,
        locationIntelligence: enhancedData.locationIntelligence ? {
          source: 'google_maps',
          confidence: 0.95,
          timestamp: new Date().toISOString()
        } : null
      };
      
      // Combine financial validation flags with schema validation flags
      const allValidationFlags = [
        ...(enhancedData.validation?.flags || []),
        ...schemaValidationFlags,
        // Add quality-based validation flags
        ...(avgScore < 70 ? [{
          type: 'quality',
          severity: 'warning',
          field: 'content_quality',
          message: `Report quality score (${avgScore}/100) below optimal threshold`,
          value: { avgScore, invalidSections: invalidSections.length }
        }] : []),
        // The 45,000-char floor below was written for the 17-section document
        // and is not a target for the v3.0 Compass, which is deliberately about
        // a third of that. Compass reports are judged by `compassQa` instead.
        ...(!compass40OverlayActive && combinedContent.length < 45000 ? [{
          type: 'quality',
          severity: 'info',
          field: 'content_length',
          message: `Report content length (${combinedContent.length} chars) may result in fewer pages`,
          value: { actual: combinedContent.length, recommended: 45000 }
        }] : []),
        // Compass structural QA. Recorded rather than thrown — see the seam above.
        ...(compassQa ? compassQa.findings.map((f) => ({
          type: 'structure',
          severity: f.severity,
          field: f.sectionId ?? f.rule,
          message: f.message,
          value: { rule: f.rule, estimatedPages: compassQa!.estimatedPages, wordCount: compassQa!.wordCount }
        })) : [])
      ];
      
      // Prepare update object with quality metadata
      const updateData: any = {
        report_content: reportContent,
        sources_content: sourcesContent,
        demographics_data: enhancedData.demographics || null,
        economic_data: enhancedData.economics || null,
        financial_calculations: enhancedData.financials || null,
        investment_score: enhancedData.investmentScore || null,
        location_intelligence: enhancedData.locationIntelligence || null,
        property_specs: propertySpecs,
        validation_flags: allValidationFlags,
        calculation_version: '1.0.0',
        data_sources: {
          ...dataSources,
          // Add generation quality metadata
          _generationQuality: qualityMetadata
        },
        report_scope: reportScope,
        status: 'completed'
      };
      
      // Build initial manual overrides from extracted property data
      // This applies to ALL input methods (manual, URL scrape, PDF upload)
      const extractedOverrides: any = {};
      
      if (propertyDetails?.price) extractedOverrides.purchasePrice = propertyDetails.price;
      if (propertyDetails?.weeklyRent) extractedOverrides.weeklyRent = propertyDetails.weeklyRent;
      if (propertyDetails?.landSizeSqm) extractedOverrides.landSizeSqm = propertyDetails.landSizeSqm;
      if (propertyDetails?.buildSizeSqm) extractedOverrides.buildSizeSqm = propertyDetails.buildSizeSqm;
      if (propertyDetails?.landPrice) extractedOverrides.landPrice = propertyDetails.landPrice;
      if (propertyDetails?.buildPrice) extractedOverrides.buildPrice = propertyDetails.buildPrice;
      if (propertyDetails?.beds) extractedOverrides.bedrooms = propertyDetails.beds;
      if (propertyDetails?.baths) extractedOverrides.bathrooms = propertyDetails.baths;
      if (propertyDetails?.carSpaces) extractedOverrides.carSpaces = propertyDetails.carSpaces;
      if (propertyDetails?.isNewBuild !== undefined) extractedOverrides.isNewBuild = propertyDetails.isNewBuild;
      if (propertyDetails?.buildType) extractedOverrides.buildType = propertyDetails.buildType;
      
      // Merge all overrides: extracted < existing DB < frontend (priority order)
      // Frontend overrides (mergedOverrides already contains frontend + existing DB)
      // Now add extracted overrides as fallback
      const finalOverrides = { ...extractedOverrides, ...mergedOverrides };
      
      if (Object.keys(finalOverrides).length > 0) {
        updateData.manual_overrides = finalOverrides;
        console.log('✓ Final manual_overrides saved:', Object.keys(finalOverrides).length, 'fields');
        console.log('  Fields:', Object.keys(finalOverrides).join(', '));
      }
      
      const { error: updateError } = await supabaseClient
        .from('investment_reports')
        .update(updateData)
        .eq('id', reportId);

      if (updateError) {
        console.error('Error updating report:', updateError);
        throw new Error(`Failed to save report: ${updateError.message}`);
      }
      
      console.log('Report successfully updated in database with validation and property specs');
      
      // Add success notification
      try {
        await insertTargetedNotification(supabaseClient, {
          moduleKey: 'reports',
          notification: {
            type: 'report_generation_completed',
            title: 'Report Generated',
            message: `Investment report for ${propertyAddress} is ready to view`,
            report_id: reportId,
            entity_id: reportId,
          },
        });
        console.log('✓ Success notification created');
      } catch (notifError) {
        console.error('Failed to create notification:', notifError);
        // Don't throw - notification failure shouldn't block report completion
      }
      
      // Log data quality score
      if (enhancedData.validation) {
        console.log('📊 Report Quality Score:', enhancedData.validation.qualityScore, '/100');
      }
    }

    console.log('Report generation complete, returning response');

    // Return successful response
    const responseData = { 
      reportContent,
      sourcesContent,
      propertyAddress,
      success: true,
      isComplete: true,
      enhancedData: {
        locationIntelligence: enhancedData.locationIntelligence,
        investmentScore: enhancedData.investmentScore,
        financials: enhancedData.financials,
        demographics: enhancedData.demographics,
        economics: enhancedData.economics,
        schoolData: enhancedData.schoolData
      }
    };

    console.log('Returning successful response');
    await traceFinishRun(_traceSb, _traceRunId, { status: 'completed' });
    return new Response(JSON.stringify(responseData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });

  } catch (error: any) {
    console.error('Error in generate-investment-report function:', error);
    console.error('Error stack:', error?.stack);
    
    // Update report status to failed if reportId provided
    if (requestBody?.reportId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (supabaseUrl && supabaseKey) {
          const supabaseClient = createClient(supabaseUrl, supabaseKey);
          await supabaseClient
            .from('investment_reports')
            .update({ 
              status: 'failed',
              error_message: error?.message || 'An unexpected error occurred'
            })
            .eq('id', requestBody.reportId);
          
          // Add failure notification
          await insertTargetedNotification(supabaseClient, {
            moduleKey: 'reports',
            notification: {
              type: 'report_generation_failed',
              title: 'Report Generation Failed',
              message: `Failed to generate report: ${error?.message || 'Unknown error'}`,
              report_id: requestBody.reportId,
              entity_id: requestBody.reportId,
            },
          });
          
          console.log('Updated report status to failed');
        }
      } catch (updateError) {
        console.error('Error updating report status to failed:', updateError);
      }
    }
    
    const errorResponse = { 
      error: error?.message || 'An unexpected error occurred',
      success: false,
      timestamp: new Date().toISOString()
    };
    
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
};

Deno.serve(withReportMetering(async (body, req) => {
  if (!body) return null;
  const userId = await resolveUserId(req, body);
  if (!userId) return null;
  const scope = body?.propertyDetails?.queryType || 'address';
  const isArea = ['suburb', 'postcode', 'statewide', 'zipcode'].includes(scope);
  const tier = (body?.propertyDetails?.tier || body?.tier || 'compass').toLowerCase();
  const kind = isArea
    ? (scope === 'suburb' ? 'report.suburb.compass'
      : scope === 'postcode' || scope === 'zipcode' ? 'report.postcode.compass'
      : 'report.investment.compass')
    : (tier === 'executive' ? 'report.investment.executive'
      : tier === 'snapshot' ? 'report.investment.snapshot'
      : tier === 'financial' ? 'report.investment.financial'
      : 'report.investment.compass');
  let reportVersion: number | string = `unresolved-${crypto.randomUUID()}`;
  if (body?.reportId) {
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').trim();
    const supabaseKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
    if (supabaseUrl && supabaseKey) {
      const { data } = await createClient(supabaseUrl, supabaseKey)
        .from('investment_reports')
        .select('current_version')
        .eq('id', body.reportId)
        .single();
      reportVersion = data?.current_version ?? reportVersion;
    }
  }
  // One reservation per generation version. All chunks in that version share
  // the key, but a later regeneration or changed caller-supplied inputs cannot
  // reuse the original report's paid reservation.
  const idempotencyKey = buildIdempotencyKey(
    'inv-report',
    await buildInvestmentReportMeteringParts(body, reportVersion),
  );
  return {
    kind: kind as any,
    userId,
    idempotencyKey,
    estimateOptions: { aiNarrative: true },
    requestPayload: {
      reportId: body?.reportId,
      propertyAddress: body?.propertyAddress,
      scope,
      tier,
    },
  };
}, __investmentReportHandler));
