/**
 * What a section is told to write reaches the model whole.
 *
 * ## What was measured (24 Sep 2026)
 *
 * The Compass's structure guide — every section's page budget, purpose, word
 * ceiling and required visuals, then the document's writing, exclusion,
 * consistency and recommendation rules — was PREPENDED to the base prompt.
 * `generateReportSection` then trims that base head-tail (62% head, 38% tail)
 * to whatever the pinned evidence and the section instructions leave of the
 * 70,000-byte ceiling. On the two Compass runs finished on 24 Sep (05:23–05:32Z,
 * `function_logs`) all 32 section calls logged `trimmed true`, with base
 * budgets of 13,938–18,914 bytes: the head kept the first 8,486–11,571 bytes of
 * an 18,706-byte guide, and the tail kept the end of the evidence pack.
 *
 * So on every section of every run:
 *
 *  - **the document rules never reached the model.** They begin 15,043 bytes
 *    in: the financial-modelling exclusions, the word-ceiling and sub-heading
 *    caps, the bed/bath/car/land-size and property-type consistency checks,
 *    and the Final Recommendation's three labels;
 *  - **no section after the ninth reliably had its own instructions in front
 *    of it, and the last four never did.** The Risk Dashboard's begin at byte
 *    10,288 and run 3,202 bytes — they are where `riskRegisterInstruction()`
 *    is composed — which is why none of the five Compass reports finished on
 *    23–24 Sep carried the declared `Risk | Exposure | Evidence` register:
 *    three wrote none, and the two that drew a table invented their own
 *    columns (`Current finding` and `Action before commitment`; `Evidence and
 *    investor implication` and `Required verification`). Its word ceiling
 *    went with it: 7,147–8,601 characters against 4,950.
 *
 * The note at the guide's injection site says the canonical guide is "never
 * trimmed", and that was true of the cap it was written about
 * (`TEMPLATE_CONTEXT_MAX_BYTES`). It was then trimmed by a different
 * arithmetic, one function later: as evidence was pinned for §6's reason, the
 * pinned block grew to 33–46 KB, and every byte of it came off the base.
 *
 * ## The rule
 *
 * §6 of `PLANNING_CONTROLS_IN_THE_REPORT.md`, one layer up: **what a section is
 * told to write may not depend on a byte boundary.** So:
 *
 *  - the section's OWN entry and the document's rules (`sectionContract`)
 *    travel in the SYSTEM message, budgeted before the operator's system
 *    prompt is trimmed and never trimmed themselves, on the full prompt and
 *    the emergency compact prompt alike. Not in the user message's pin: that
 *    message is full — the pinned evidence reached 45.6 KB on a NSW run, where
 *    a 7.4 KB Risk Dashboard contract would have pushed the final safety trim
 *    into the planning controls table, §6's defect caused by its own remedy —
 *    while the system message used 3.5 KB of its 35 KB;
 *  - the base carries only an OUTLINE of the document (`documentOutline`).
 *    The other sections' purposes are not instructions for this call, and they
 *    sat at the head of the base, which is the part a trim keeps — so they
 *    displaced the method contract and the evidence that followed them.
 *
 * The rules and the entry are one text in two places, never two texts: the
 * contract composes `sectionGuideEntry` and `documentRules`, and the
 * outline names the sections from the same registry, so the structure is still
 * stated once.
 *
 * It sits beside `compassSectionRegistry.ts` and `compassQAValidator.ts`, not
 * under `reports/investment/`, because it reads the registry, and a canonical
 * investment module may not (`investmentSourceOfTruth.spec.ts`).
 *
 * Pure: no I/O.
 */

import {
  compassSections,
  financialSections,
  COMPASS_PAGE_BAND,
  EDITORIAL_LABELS,
  type CompassSectionDefinition,
} from './compassSectionRegistry.ts';
import { hasRiskRegister, riskRegisterRepairNote, RISK_REGISTER_COLUMNS } from './reports/investment/riskRegister.pure.ts';
import { promotePipedPseudoTables } from './reports/investment/pseudoTables.pure.ts';

export type CanonicalTier = 'compass-40' | 'financial-analysis';

/** The sections a canonical tier generates, in the order it writes them. */
export function canonicalSectionsFor(tier: CanonicalTier): CompassSectionDefinition[] {
  return tier === 'financial-analysis' ? financialSections() : compassSections();
}

/**
 * The document's title as the guide states it. Read from the band rather than
 * written, because the registry's page budget is the thing that decides it and
 * a literal beside it is how the two come to disagree (v3.0 said 38 against a
 * 23-page document).
 */
export function documentTitle(tier: CanonicalTier): string {
  return tier === 'financial-analysis'
    ? 'Financial Analysis Report Structure'
    : `Investment Location & Property Fit Report Structure (${COMPASS_PAGE_BAND.min}–${COMPASS_PAGE_BAND.max} pages)`;
}

/**
 * The rules every section of the document answers to.
 *
 * Moved here verbatim from the generator, where they were the tail of the
 * structure guide — the part of it no section call ever received. Empty for the
 * Financial Analysis tier, which never carried any.
 */
export function documentRules(tier: CanonicalTier): string {
  if (tier !== 'compass-40') return '';
  return [
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
    '- DO NOT include deposit, stamp duty, LMI, LVR, gross/net yield, loan amount, interest rate, monthly/annual repayments, cashflow, sensitivity, 10-year projections, capital growth %, equity-after-X-years, depreciation, negative gearing, land tax. ALL financial modelling lives in the separate Financial Analysis Report.',
    // The asking price and the indicative rent are NOT on that list, and the
    // line that used to put them there contradicted three things at once: the
    // tier policy (`identityFigures` is true on every tier — what the property
    // costs is a fact about the asset the way its land size is), the document
    // itself (the cover band and the dashboard both print them), and Market
    // Positioning, whose whole job is to place this property in its market and
    // which cannot do it without naming the price. What may not happen is the
    // ANALYSIS of them, and the KPI-row form, both of which the next two lines
    // and the sanitiser hold.
    '- The asking price and the indicative weekly rent MAY be stated, as facts about the property, in a sentence. They may not be analysed — no yield from them, no repayment on them, no projection of them — and they may not be set as a KPI row or a table of figures.',
    '- DO NOT include a dashboard / KPI row of financial figures in the Executive Verdict or anywhere else.',
    '- DO NOT emit `[citation]`, `[source needed]`, `[TBD]` or any placeholder. Either name the real source inline, or omit the claim and let the Source Appendix carry it.',
    '- DO NOT repeat education, transport or employment content across sections. Each is rendered ONCE, in the section that owns it.',
    '- DO NOT include transition paragraphs ("As we move into…", "Building on the above…", "This flows naturally…"). Start the next finding.',
    '',
    '## LENGTH AND STRUCTURE',
    '- Respect the per-section word ceiling given above. It is a ceiling, not a target to reach: a section that says what it has to say in half of it is finished.',
    '- At most 4 `###` sub-headings in a section. A sub-heading carries a group of findings, not a single paragraph.',
    '- At most 2 visualisations per section, each showing data that is not also in a table on the same page.',
    '- Finish every sentence and every paragraph. If you are running out of room, close the section cleanly rather than stopping mid-thought.',
    '',
    '## CONSISTENCY CHECKS',
    '- Bed / bath / car / land size stated in the Property & Locality Snapshot MUST match every later reference (Property Fit, Risk Dashboard, Final Recommendation).',
    '- Property type (house / townhouse / unit) MUST be identical everywhere it is mentioned.',
    '',
    '## RECOMMENDATION FORMAT',
    'The Final Recommendation opens with one of three labels on its own line — **Proceed**, **Proceed with caution**, or **Not suitable** — then 150–250 words of continuous unlabelled rationale tied to location, tenant demand and risk, then the immediate actions as a short list. No financial verdict.',
  ].join('\n');
}

/** One section's entry in the guide: its budget, purpose, ceiling and visuals. */
export function sectionGuideEntry(section: CompassSectionDefinition): string {
  return [
    `## ${section.name}`,
    `- Page budget: ${section.pageBudget}`,
    `- Purpose: ${section.purpose}`,
    `- Narrative word ceiling: ${section.maxWordCount} (a ceiling, not a target)`,
    section.visualComponents.length
      ? `- Required visual/data components: ${section.visualComponents.join(', ')}`
      : '- Required visual/data components: narrative only',
  ].join('\n');
}

/** The heading the contract opens with; a spec finds the block by it. */
export const SECTION_CONTRACT_HEADING = '# THE SECTION YOU ARE WRITING — its instructions, in full';

/**
 * What the model is told about the one section it is writing, and the rules of
 * the document it belongs to. Carried in the system message and never trimmed:
 * it reaches the model whatever else in the prompt was shortened.
 */
export function sectionContract(section: CompassSectionDefinition, tier: CanonicalTier): string {
  const rules = documentRules(tier);
  return [
    SECTION_CONTRACT_HEADING,
    '',
    `You are writing the "${section.name}" section of the ${documentTitle(tier).replace(/ Structure\b.*$/, '')}.`,
    'These are its instructions and the rules of the document. They reach you in full whatever',
    'else was shortened, and where anything else you are given conflicts with them — an outline,',
    'or a note that part of the prompt was truncated — these govern.',
    '',
    sectionGuideEntry(section),
    ...(rules ? ['', rules] : []),
  ].join('\n');
}

/**
 * What the BASE prompt carries about the document's structure: every section,
 * in order, with its word ceiling — enough to know what the other sections
 * cover, and nothing that is an instruction for this call.
 */
export function documentOutline(tier: CanonicalTier): string {
  const sections = canonicalSectionsFor(tier);
  return [
    `# ${documentTitle(tier)}`,
    '',
    'The document has these sections, in this order. You write ONE of them per call, and each',
    'covers its own subject only. The section you are writing is named at the end of this',
    'message; its full instructions and the rules of the document are in your system',
    'instructions, and they reach you in full.',
    '',
    ...sections.map((s, i) => `${i + 1}. ${s.name} — up to ${s.maxWordCount} words`),
  ].join('\n');
}

/** The registry id of the one section whose declared shape IS a register. */
export const RISK_DASHBOARD_SECTION_ID = 'compass.riskDashboard';

/**
 * Whether a written section is missing the SHAPE its registry entry declares —
 * today, the Risk Dashboard's summary register — or null when nothing is.
 *
 * Judged after `promotePipedPseudoTables`, because a register written as piped
 * prose is repaired on the read path and needs no second call. What is left is
 * the case the read path cannot repair: a register nobody wrote cannot be
 * composed without inventing an exposure and an evidence reading for every row
 * (`compassQAValidator`'s `risk-register-missing`), so the only remedy is to
 * ask again.
 */
export function sectionShapeShortfall(registryId: string | null | undefined, content: string): string | null {
  if (registryId !== RISK_DASHBOARD_SECTION_ID) return null;
  if (hasRiskRegister(promotePipedPseudoTables(content || '').markdown)) return null;
  return `No summary register (a ${RISK_REGISTER_COLUMNS.join(' | ')} table)`;
}

/** The correction carried on the one further attempt a shortfall earns, or null. */
export function sectionRepairNote(registryId: string | null | undefined): string | null {
  return registryId === RISK_DASHBOARD_SECTION_ID ? riskRegisterRepairNote() : null;
}
