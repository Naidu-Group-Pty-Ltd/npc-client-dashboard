/**
 * Compass Section Registry — Shared (edge runtime)
 * ------------------------------------------------
 * Single source of truth for the Investment Location & Property Fit report's
 * structure, and for the separate Financial Analysis Report.
 *
 * `generate-investment-report` builds its section list, its per-section prompt
 * and its `total_sections` from this file; `compassPostProcessor` and
 * `compassQAValidator` enforce what it declares. A change here reaches
 * production without any renderer work, because the markdown this produces is
 * the report on every live path (see docs/reports/COVERAGE.md).
 *
 * Frontend mirror: src/lib/reports/compassSectionRegistry.ts.
 * The two are kept in step by `compassRegistryParity.spec.ts`, which compares
 * the section arrays field by field — they had drifted to 672 lines against
 * 174 with nothing checking, which docs/reports/DESIGN_SYSTEM.md records.
 */

// ─── Classification primitives ──────────────────────────────────────────────

export type SectionPriority =
  | 'Protected' // Never trim under page pressure (zoning, planning, risk, infrastructure)
  | 'High'      // Reduce narrative to summary + table before cutting
  | 'Medium'    // Condense heavily, prefer matrices
  | 'Low'       // Move to appendix / internal first
  | 'Excluded'; // Routed to Financial Analysis Report

export type ConfidenceTag =
  | 'Verified'
  | 'Indicative'
  | 'Planned'
  | 'UnderConstruction'
  | 'Unverified'
  | 'NotAvailable';

export type SectionVisualComponent =
  | 'kpiTiles'
  | 'scorecard'
  | 'strengthsWatchPoints'
  | 'infrastructureTimeline'
  | 'amenityMatrix'
  | 'riskRegister'
  | 'planningActionTable'
  | 'dueDiligenceChecklist'
  | 'confidenceChip'
  | 'narrative'
  | 'attributeTable'
  | 'trendTable'
  | 'chart';

export interface CompassSectionDefinition {
  /** Stable id (e.g. `compass.executiveSummary`). */
  id: string;
  /** 1-based ordinal in the Compass layout. */
  ordinal: number;
  /** Display title for the section. */
  name: string;
  /** Underlying H2 headings produced by the generator that map into this section. */
  sourceHeadings: string[];
  /** Target page count (page budget) in the report layout. */
  pageBudget: number;
  /** Classification flags. */
  includeInCompass: boolean;
  includeInFinancialReport: boolean;
  includeInAppendix: boolean;
  isInternalOnly: boolean;
  /** Trim priority under page-pressure logic. */
  sectionPriority: SectionPriority;
  /** Per-section maximum word count for narrative (excludes tables/visuals). */
  maxWordCount: number;
  /** Visual components this section should render. */
  visualComponents: SectionVisualComponent[];
  /** Plain-English purpose for prompt and UI tooltips. */
  purpose: string;
}

/**
 * The five labels this report must never print, in any form.
 *
 * Measured over 56 production Compass reports before they were banned: 5,043
 * occurrences, about 90 a report, carrying 24,713 characters — 16.9% of the
 * document. They are restatement, not findings: a paragraph under a table
 * saying what the table already says.
 *
 * Three forms occur and all three must be matched. Counted in that corpus:
 * `**What This Means**` (bold lead-in) 4,161, `### NPC view` (heading) 424, and
 * a bare `What to watch` line 458. The post-processor's original matcher was
 * heading-only and caught **11 of the 5,043** — 0.2% — which is why this list
 * lives here, beside the sections, rather than as a regex in one consumer.
 *
 * `compassPostProcessor.stripEditorialBlocks` removes them and
 * `compassQAValidator`'s `editorial-label` rule fails the report if any survive.
 */
export const EDITORIAL_LABELS: readonly string[] = [
  'what this means',
  'what this means for you',
  'why this matters',
  'why this matters for investors',
  'what to watch',
  'key takeaway',
  'key takeaways',
  'npc view',
  'npc take',
  'our view',
];

// ─── Investment Location & Property Fit Report (≈23 pages, 11 sections) ─────
// v3.0 — the commentary strip. ALL detailed financial modelling (purchase
// costs, yield, loan, cashflow, sensitivity, 10-year projections, land tax,
// equity) lives in the separate Financial Analysis Report and MUST NOT appear
// here; that rule is unchanged from v2.0.
//
// WHAT CHANGED, AND WHY
//
// v2.0 declared a 4-block writing style for every narrative section — Key
// takeaway / Why this matters / What to watch / NPC view — and the generator
// separately told the model to add a "What This Means" paragraph after *every*
// visual, table and data point. Measured against the 56 most recent reports,
// that produced **90 editorial labels a report carrying 16.9% of the
// document**, against a declared budget the report was already exceeding by
// 2.3× (86 rendered pages, ~21,000 words, against 45 declared pages and 9,170
// words).
//
// The writing style is now:
//   1. State the finding in the sentence that introduces the data.
//   2. Show the data — a figure, a table, or a short list.
//   3. Move on.
//
// There is no commentary block, and no paragraph that restates the figure
// above it. See EDITORIAL_LABELS for the exact strings this forbids and the
// two modules that enforce it.
//
// The section list is 11 client-facing sections plus back matter, down from
// 17. Two merges: Demand Drivers absorbs population, tenant/buyer and
// employment (one question — who wants to live here, and why); Amenity &
// Access absorbs education, retail/healthcare/lifestyle and transport (one
// question — what is nearby, and how long to reach it). Both are
// consolidations the v2.0 `purpose` strings already asked for and the prompt
// could not deliver, because each was a separate section. Client Reading Guide
// is gone: it was a prose contents page, and the typeset document has a real
// one.
//
// A section name here is load-bearing downstream — `TITLED_SECTION_CHARTS` in
// reports/investment/normalise.pure.ts attaches infographics by title, and
// reportSplitRegistry.ts routes derived variants by heading substring. Both
// were updated with this list; read those two before renaming anything.

export const COMPASS_40_SECTIONS: CompassSectionDefinition[] = [
  {
    // Excluded from Compass assembly (2026-09): every surface that draws this
    // narrative draws its own cover, and the model-written one rendered as a
    // SECOND cover inside the body — the firm's masthead, the words "Cover
    // Page" as a visible heading, and "Prepared for: Premium client of …" as
    // body copy, measured on a real client document. Same treatment the prose
    // contents section got, for the same reason. Stored reports that already
    // carry it are cleaned at read time by
    // `reports/investment/narrativeClean.pure.ts`.
    id: 'compass.cover',
    ordinal: 1,
    name: 'Cover Page',
    sourceHeadings: ['Cover'],
    pageBudget: 1,
    includeInCompass: false,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 60,
    visualComponents: [],
    purpose: 'NPC branding, report name ("Investment Location & Property Fit Report"), property address, report date.',
  },
  {
    id: 'compass.executiveVerdict',
    ordinal: 2,
    name: 'Executive Verdict',
    sourceHeadings: ['Executive Summary', 'Executive Verdict', 'Overall Assessment', 'Investment Recommendation'],
    pageBudget: 2,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 450,
    visualComponents: ['kpiTiles', 'scorecard'],
    purpose: 'The verdict, first: location call, property fit, tenant demand, the top 2–3 risks, and a Proceed / Proceed with caution / Not suitable recommendation. Write it as findings, not as a preview of the sections below. NO purchase price, LVR, yield, cashflow or any financial figure — those belong in the Financial Analysis Report.',
  },
  {
    id: 'compass.propertyLocalitySnapshot',
    ordinal: 3,
    name: 'Property & Locality Snapshot',
    sourceHeadings: ['Property Snapshot', 'Property-Level Information', 'Locality Snapshot'],
    pageBudget: 2,
    includeInCompass: true,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 300,
    visualComponents: ['attributeTable', 'kpiTiles'],
    purpose: 'Facts in a table, not prose: property type, bed/bath/car, land size, dwelling configuration, estate, suburb, LGA, target occupier, locality fit. Bed/bath/car must be internally consistent throughout the whole report. NO price, rent, yield, LVR, loan or any financial field.',
  },
  {
    id: 'compass.whyLocationMatters',
    ordinal: 4,
    name: 'Why This Location Matters',
    sourceHeadings: ['Location Overview', 'Why This Location Matters', 'Future Infrastructure', 'Infrastructure & Development', 'Growth Corridor'],
    pageBudget: 3,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 700,
    visualComponents: ['narrative', 'infrastructureTimeline', 'confidenceChip'],
    purpose: 'The macro thesis: growth corridor, master-planned estate, LGA, economic links, and the staged infrastructure pipeline (schools, town centre, transport, roads, health, parks) as a timeline. Each infrastructure item carries a confidence chip (Verified / Planned / Under Construction). Name the project, the stage and the date — not what the project means for the reader.',
  },
  {
    id: 'compass.demandDrivers',
    ordinal: 5,
    name: 'Demand Drivers',
    sourceHeadings: [
      'Demand Drivers',
      'Population & Housing Demand',
      'Population and Development Trends',
      'Supply & Development Pipeline',
      'Tenant & Buyer Profile',
      'Demographics & Demand Drivers',
      'Target Tenant',
      'Employment & Economic Linkages',
      'Employment Hubs',
      'Sustained Employment Growth',
      'Employment & Industry',
      'Economic Context',
    ],
    pageBudget: 3,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 750,
    visualComponents: ['trendTable', 'kpiTiles', 'attributeTable'],
    purpose: 'One section answering who wants to live here and why — merged from the v2.0 population, tenant/buyer and employment sections, which repeated each other. Covers population growth and household formation, the supply pipeline, the tenant and buyer profile (household types, income brackets, a small SEIFA evidence box), and the corridor industries, major employers and employment-hub access that support that demand. Render employment ONCE, here. Macro demand only — no rent or yield numbers.',
  },
  {
    id: 'compass.amenityAccess',
    ordinal: 6,
    name: 'Amenity & Access',
    sourceHeadings: [
      'Amenity & Access',
      'Schools & Education',
      'Education Infrastructure',
      'Education Profile',
      'Education Lifecycle',
      'Key Local Schools',
      'Education & Family Amenity',
      'Healthcare & Shopping',
      'Recreational Amenities',
      'Suburb Character',
      'Lifestyle',
      'Retail, Healthcare & Lifestyle Amenity',
      'Transport & Accessibility',
      'Public Transport Access',
      'Public Transport Network',
      'Commute Metrics',
      'Connectivity & Transport',
      'Transport & Connectivity',
    ],
    pageBudget: 3,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: true,
    isInternalOnly: false,
    sectionPriority: 'Medium',
    maxWordCount: 600,
    visualComponents: ['amenityMatrix', 'attributeTable'],
    purpose: 'One section answering what is nearby and how long it takes to reach — merged from the v2.0 education, retail/healthcare/lifestyle and transport sections. Lead with a single matrix: Amenity / Distance / Current / Future. Covers schools and childcare, healthcare, shopping and dining, parks and recreation, and rail, road, bus and real commute times including honest car-reliance. Top 3–5 per category; full school and facility lists go to the appendix. Render each ONCE.',
  },
  {
    id: 'compass.marketPositioning',
    ordinal: 7,
    name: 'Market Positioning',
    sourceHeadings: ['Market Positioning', 'Current Market Performance', 'Market Analysis'],
    pageBudget: 2,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 450,
    visualComponents: ['trendTable', 'kpiTiles'],
    purpose: 'Where this property sits in the local market: new-estate context, owner-occupier appeal, comparable supply, demand signals. Qualitative growth drivers only — NO yield, cashflow, capital growth %, repayment or loan numbers.',
  },
  {
    id: 'compass.propertyFit',
    ordinal: 8,
    name: 'Property Fit Within the Suburb',
    sourceHeadings: ['Property Fit Within the Suburb', 'Property-Level Information', 'Strategic Assessment', 'Property Fit'],
    pageBudget: 2,
    includeInCompass: true,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 450,
    visualComponents: ['strengthsWatchPoints', 'attributeTable'],
    purpose: 'How this specific dwelling aligns with local demand: lot position, layout, land/build balance, tenant appeal, resale story, limitations. Strengths and limitations as two short lists, not as paragraphs. Bed/bath/car must match the Property & Locality Snapshot. NO valuation, yield or financial assessment.',
  },
  {
    id: 'compass.riskDashboard',
    ordinal: 9,
    name: 'Risk Dashboard',
    sourceHeadings: ['Risk Dashboard', 'Risk Summary', 'Environmental Risks & Climate', 'Crime & Safety', 'Environmental Risk', 'Zoning', 'Planning', 'Key Risks Before Proceeding'],
    pageBudget: 2,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: true,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 500,
    visualComponents: ['riskRegister', 'confidenceChip'],
    purpose: 'One consolidated risk table: Risk / Level / Why It Matters / Required Check. Covers crime, environmental (bushfire, flood), planning overlays and covenants, supply, transport reliance and infrastructure timing. Every risk carries a confidence chip and a required DD action. The table IS the section — no prose restating rows.',
  },
  {
    id: 'compass.dueDiligenceChecklist',
    ordinal: 10,
    name: 'Due Diligence Checklist',
    sourceHeadings: ['Due Diligence Checklist', 'Due Diligence', 'Investment Recommendations'],
    pageBudget: 1,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 250,
    visualComponents: ['dueDiligenceChecklist'],
    purpose: 'A plain checklist of what to verify before proceeding: planning certificate, title/covenant, overlays, insurance/BAL position, comparables, rent, contract and estate covenants. Checklist items only — one line each, no explanatory paragraphs.',
  },
  {
    id: 'compass.finalRecommendation',
    ordinal: 11,
    name: 'Final Recommendation',
    sourceHeadings: ['Final Recommendation', 'Final Conclusion', 'Investment Recommendation'],
    pageBudget: 1,
    includeInCompass: true,
    includeInFinancialReport: false,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 250,
    visualComponents: ['narrative'],
    purpose: 'Open with the verdict in bold on its own line — **Proceed**, **Proceed with caution** or **Not suitable** — then 150–250 words of continuous rationale tied to location, tenant demand and risk, then the immediate actions as a short list. Write the rationale as one unlabelled passage: this section carried four labelled commentary blocks in v2.0 and they were 39% of it. NO financial verdict and no financial figures.',
  },
  {
    id: 'compass.disclaimer',
    ordinal: 12,
    name: 'Appendix, Source Notes & Disclaimer',
    sourceHeadings: ['PROFESSIONAL DISCLAIMER', 'Disclaimer', 'Source Appendix', 'Appendix'],
    pageBudget: 1,
    includeInCompass: true,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 250,
    visualComponents: ['narrative'],
    purpose: 'Back matter, not an analysis section: data sources, appendix listings (full school and facility lists moved out of Amenity & Access), general advice warning, report limitations. Replaces any inline "[citation]" placeholders.',
  },
];

// ─── Financial Analysis Report architecture (separate document) ─────────────

export const FINANCIAL_ANALYSIS_SECTIONS: CompassSectionDefinition[] = [
  {
    id: 'financial.cover',
    ordinal: 1,
    name: 'Cover Page',
    sourceHeadings: ['Cover'],
    pageBudget: 1,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 60,
    visualComponents: [],
    purpose: 'NPC branding, "Financial Analysis Report", property address, report date.',
  },
  {
    id: 'financial.propertySnapshot',
    ordinal: 2,
    name: 'Property & Inputs Snapshot',
    sourceHeadings: ['Property Snapshot'],
    pageBudget: 1,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 220,
    visualComponents: ['attributeTable', 'kpiTiles'],
    purpose: 'Address, type, configuration, purchase price, deposit, loan, rate, term assumptions.',
  },
  {
    id: 'financial.purchaseCosts',
    ordinal: 3,
    name: 'Purchase & Ongoing Costs',
    sourceHeadings: ['Purchase & Ongoing Costs (Annual)'],
    pageBudget: 2,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 350,
    visualComponents: ['attributeTable', 'kpiTiles'],
    purpose: 'Stamp duty, conveyancing, building/pest, LMI, annual property expenses, land tax breakdown.',
  },
  {
    id: 'financial.yield',
    ordinal: 4,
    name: 'Rental Assessment & Yield Calculation',
    sourceHeadings: ['Rental Assessment & Yield Calculation'],
    pageBudget: 2,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 350,
    visualComponents: ['kpiTiles', 'trendTable'],
    purpose: 'Weekly rent, gross yield, net yield, vacancy, management costs, yield benchmark commentary.',
  },
  {
    id: 'financial.loan',
    ordinal: 5,
    name: 'Loan Structure & Repayment Analysis',
    sourceHeadings: ['Loan Structure & Repayment Analysis'],
    pageBudget: 2,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 400,
    visualComponents: ['attributeTable', 'kpiTiles'],
    purpose: 'LVR, loan amount, interest rate, product type, IO vs P&I, monthly/annual repayments.',
  },
  {
    id: 'financial.cashflow',
    ordinal: 6,
    name: 'Year-1 Cashflow & Sensitivity',
    sourceHeadings: ['Sensitivity Analysis', 'Interest Rate Sensitivity', 'Structural Cashflow Deficit'],
    pageBudget: 3,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 600,
    visualComponents: ['trendTable', 'chart'],
    purpose: 'Year-1 net cashflow pre/post tax, monthly shortfall, ±1% / ±2% interest rate sensitivity.',
  },
  {
    id: 'financial.tenYear',
    ordinal: 7,
    name: '10-Year Cashflow & Equity Projections',
    sourceHeadings: ['10-Year Investment Projections', 'Capital Appreciation Potential', 'Leveraged Equity Accumulation'],
    pageBudget: 4,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 700,
    visualComponents: ['trendTable', 'chart'],
    purpose: '10-year cashflow, rental projections, loan balance, equity growth, cumulative cash contributions.',
  },
  {
    id: 'financial.tax',
    ordinal: 8,
    name: 'Tax Treatment & Land Tax',
    sourceHeadings: ['Land Tax', 'Tax Treatment'],
    pageBudget: 2,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 400,
    visualComponents: ['attributeTable'],
    purpose: 'Negative gearing, depreciation outline, land tax thresholds, client-specific assumptions and disclaimers.',
  },
  {
    id: 'financial.serviceability',
    ordinal: 9,
    name: 'Serviceability & Buffer',
    sourceHeadings: ['Borrowing Capacity', 'Serviceability'],
    pageBudget: 2,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'High',
    maxWordCount: 400,
    visualComponents: ['kpiTiles', 'attributeTable'],
    purpose: 'Client serviceability headroom, recommended cash buffer, lender stress test assumptions.',
  },
  {
    id: 'financial.recommendation',
    ordinal: 10,
    name: 'Financial Recommendation',
    sourceHeadings: ['Financial Recommendation'],
    pageBudget: 1,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 280,
    visualComponents: ['narrative'],
    purpose: 'Financial suitability verdict tied to client serviceability, buffers and cashflow capacity.',
  },
  {
    id: 'financial.disclaimer',
    ordinal: 11,
    name: 'Disclaimer & Source Appendix',
    sourceHeadings: ['PROFESSIONAL DISCLAIMER', 'Disclaimer'],
    pageBudget: 1,
    includeInCompass: false,
    includeInFinancialReport: true,
    includeInAppendix: false,
    isInternalOnly: false,
    sectionPriority: 'Protected',
    maxWordCount: 300,
    visualComponents: ['narrative'],
    purpose: 'General advice warning, source data, methodology notes. Not personal financial advice.',
  },
];

// ─── Word-cap governance (component-level, from §7 of the brief) ────────────

// `whatThisMeansBox` is gone with the boxes themselves — see EDITORIAL_LABELS.
// `executiveSummaryTotal` halved with the section's own cap.
export const COMPASS_WORD_CAPS = {
  executiveSummaryTotal: { min: 300, max: 450 },
  sectionOpeningTakeaway: { min: 35, max: 50 },
  standardParagraph: { min: 45, max: 80 },
  amenityCategorySummary: { min: 40, max: 70 },
  riskItemExplanation: { min: 25, max: 45 },
  planningItemExplanation: { min: 40, max: 70 },
  finalRecommendation: { min: 150, max: 250 },
} as const;

// ─── Page-pressure trim order (§6, §11 of the brief) ────────────────────────
// Applied in sequence when rendered page count exceeds the target band.
// Sections with sectionPriority === 'Protected' are NEVER touched.
//
// `collapseDecisionBoxes` is gone: it collapsed duplicate boxes down to one,
// and there is no longer a permitted first one. `stripEditorialBlocks` removes
// all of them unconditionally, before page pressure is even measured.
//
// `reduceEconomicContext` and `reduceLifestyle` now name the sections that
// absorbed the ones they used to target — they addressed `compass.economicContext`
// and `compass.suburbCharacter`, neither of which has existed since v2.0, so
// both steps have been no-ops for their whole life.

export const PAGE_PRESSURE_TRIM_ORDER: ReadonlyArray<{
  id: string;
  description: string;
}> = [
  { id: 'transitions',          description: 'Strip repeated transition paragraphs ("As we move into…").' },
  { id: 'capListsToTop5',       description: 'Cap school / amenity / transport lists to top 5 records.' },
  { id: 'mergeDuplicateDemographics', description: 'Merge duplicate demographic/employment commentary.' },
  { id: 'moveListsToAppendix',  description: 'Move long lists to appendix / internal view.' },
  { id: 'reduceDemandDrivers',  description: 'Reduce Demand Drivers to one page.' },
  { id: 'reduceAmenityAccess',  description: 'Reduce Amenity & Access to one page.' },
];

// ─── Protected section ids (never trim under page pressure) ─────────────────

export const PROTECTED_SECTION_IDS: ReadonlySet<string> = new Set([
  'compass.executiveVerdict',
  'compass.whyLocationMatters',
  'compass.propertyFit',
  'compass.riskDashboard',
  'compass.dueDiligenceChecklist',
  'compass.finalRecommendation',
]);

// ─── Approved hand-off copy (placed at the bottom of Exec Summary) ──────────

export const COMPASS_FINANCIAL_HANDOFF_COPY =
  'This Compass Report focuses on macro suitability, suburb fundamentals, planning considerations and property-positioning factors. Detailed cashflow, lending structure, tax position, yield and 10-year financial modelling should be reviewed separately in the Financial Analysis Report.';

// ─── Source-heading routing (used by the legacy generator section-by-section
//     output to decide where each H2 lands in either report) ─────────────────

export interface HeadingRouting {
  /** Source H2 heading produced by the existing generator. */
  heading: string;
  /** Target section ids in each report (zero or more). */
  compassSectionId: string | null;
  financialSectionId: string | null;
  /** Move to appendix-only inside Compass. */
  compassAppendixOnly?: boolean;
  /** Hide entirely from client-facing outputs. */
  internalOnly?: boolean;
}

function buildRoutingTable(): HeadingRouting[] {
  const map = new Map<string, HeadingRouting>();
  const upsert = (heading: string, patch: Partial<HeadingRouting>) => {
    const key = heading.toLowerCase().trim();
    const existing = map.get(key) ?? {
      heading,
      compassSectionId: null,
      financialSectionId: null,
    };
    map.set(key, { ...existing, ...patch });
  };

  for (const section of COMPASS_40_SECTIONS) {
    for (const h of section.sourceHeadings) {
      upsert(h, {
        compassSectionId: section.id,
        compassAppendixOnly: section.includeInAppendix && !section.includeInCompass,
      });
    }
  }
  for (const section of FINANCIAL_ANALYSIS_SECTIONS) {
    for (const h of section.sourceHeadings) {
      upsert(h, { financialSectionId: section.id });
    }
  }
  return Array.from(map.values());
}

export const HEADING_ROUTING: ReadonlyArray<HeadingRouting> = buildRoutingTable();

export function routeHeading(heading: string): HeadingRouting | undefined {
  const key = heading.toLowerCase().trim();
  return HEADING_ROUTING.find((r) => r.heading.toLowerCase().trim() === key);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const COMPASS_40_PAGE_BUDGET = COMPASS_40_SECTIONS.reduce(
  (sum, s) => sum + s.pageBudget,
  0,
);

export const FINANCIAL_PAGE_BUDGET = FINANCIAL_ANALYSIS_SECTIONS.reduce(
  (sum, s) => sum + s.pageBudget,
  0,
);

/**
 * Accepted page band for QA (20–26).
 *
 * The v2.0 band was 38–42 and the page budgets summed to 45, so the band was
 * never reachable from the budgets even in principle. Production rendered at
 * 86. The budgets above now sum to 23, which is inside this band with room for
 * the part-full chapter tail every chaptered document pays per section.
 */
export const COMPASS_PAGE_BAND = { min: 20, max: 26 } as const;

/** Sections allowed in the Compass Report, in render order. */
export const compassSections = (): CompassSectionDefinition[] =>
  COMPASS_40_SECTIONS.filter((s) => s.includeInCompass).sort(
    (a, b) => a.ordinal - b.ordinal,
  );

/** Sections allowed in the Financial Analysis Report, in render order. */
export const financialSections = (): CompassSectionDefinition[] =>
  FINANCIAL_ANALYSIS_SECTIONS.filter((s) => s.includeInFinancialReport).sort(
    (a, b) => a.ordinal - b.ordinal,
  );

/** Total word-cap budget for a tier (sum of section maxWordCount). */
export function totalWordBudget(
  tier: 'compass-40' | 'financial-analysis',
): number {
  const list = tier === 'compass-40' ? compassSections() : financialSections();
  return list.reduce((sum, s) => sum + s.maxWordCount, 0);
}
