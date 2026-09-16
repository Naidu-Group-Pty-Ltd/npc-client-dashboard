/**
 * Compass QA Validator — Phase 7
 * -------------------------------
 * Runs structural QA on a generated report's markdown. Used by:
 *   • generate-investment-report (recorded on the report row)
 *   • condense-investment-report (returns assertions in response)
 *   • Deno tests (compassPostProcessor_test.ts)
 *   • Frontend QA panel (mirror in src/lib/reports/)
 *
 * Checks:
 *   1. Page band: Compass 20–26, Financial 18–22
 *   2. Financial content exclusion from Compass (no yield/LVR/cashflow tables)
 *   2b. No unresolved placeholders
 *   2c. No editorial commentary label survives, in any form
 *   3. Suburb-narrative exclusion from Financial Analysis
 *   4. Duplicate H2 heading detection
 *   6. Protected sections present
 *   7. Per-section word-cap compliance
 *   8. Sub-heading density per section
 *
 * A finding is a report of fact, never a reason to discard a document. The
 * generator records this and stores the report either way: a report that exists
 * and is over its band is more useful to everyone than no report at all.
 */

import {
  COMPASS_40_SECTIONS,
  FINANCIAL_ANALYSIS_SECTIONS,
  COMPASS_PAGE_BAND,
  PROTECTED_SECTION_IDS,
  type CompassSectionDefinition,
} from './compassSectionRegistry.ts';
import { countWords, estimatePages, findEditorialLabels } from './compassPostProcessor.ts';
import { findScoreClaims } from './reports/investment/scoreClaims.pure.ts';

/**
 * The prompt asks for at most 4 `###` a section; this flags at 6+.
 *
 * One of tolerance, deliberately: QA reports on a document that already exists
 * and a section that runs to a fifth sub-head is not a defect worth a finding.
 * v2.0 produced 68 `###` a report across 17 sections; 4 a section over 11 is ~44.
 */
const MAX_SUBHEADINGS_PER_SECTION = 5;

/** A sentence that introduces a table or matrix said to follow it. */
const TABLE_PROMISE = /\b(?:table|matrix|grid|schedule)\s+(?:below|that follows|following)\b|\bbelow\s+(?:table|matrix)\b|\b(?:summari[sz]ed|set out|shown|listed|presented)\s+(?:in\s+the\s+)?(?:table|matrix)\s+below\b/i;
/** A heading or bold label naming a pair of lists. */
const PAIR_HEADING = /^(?:#{2,4}\s+|\*\*)?strengths?\s*(?:and|&)\s*(?:limitations?|weaknesses|considerations|watch[- ]?points)\b/i;
/** The second half of that pair, as a sub-heading or a bold label. */
const PAIR_SECOND_LABEL = /^(?:#{3,5}\s+|\*\*)?(?:limitations?|weaknesses|considerations|watch[- ]?points)\b\*{0,2}:?\s*$/i;


export type QASeverity = 'error' | 'warning' | 'info';

export interface QAFinding {
  rule: string;
  severity: QASeverity;
  message: string;
  sectionId?: string;
}

export interface QAReport {
  tier: 'compass-40' | 'financial-analysis';
  estimatedPages: number;
  wordCount: number;
  passed: boolean;
  findings: QAFinding[];
}

const FINANCIAL_KEYWORDS = [
  /\bgross yield\b/i,
  /\bnet yield\b/i,
  /\brental yield\b/i,
  /\bLVR\b/,
  /\bLMI\b/,
  /\bP&I\b/,
  /\bweekly rent\b/i,
  /\bpurchase price\b/i,
  /\bstamp duty\b/i,
  /\bloan amount\b/i,
  /\bmonthly repayment/i,
  /\bannual repayment/i,
  /\binterest rate sensitivity\b/i,
  /\b10[- ]year (cashflow|projection|cash contribution)/i,
  /\bsensitivity analysis\b/i,
  /\bafter[- ]tax cashflow\b/i,
  /\bnegative cashflow\b/i,
  /\bnegative gearing\b/i,
  /\bdepreciation schedule\b/i,
  /\bcumulative cashflow\b/i,
  /\bequity after\s+\d+\s+years?\b/i,
  /\bcapital growth (assumption|rate)\b/i,
];

const FORBIDDEN_PLACEHOLDERS = [
  /\[citation\]/i,
  /\[source\s+needed\]/i,
  /\[TBD\]/i,
  /\bcitation needed\b/i,
];

const SUBURB_KEYWORDS = [
  /\bSEIFA\b/,
  /\bschool catchment\b/i,
  /\bcrime statistics\b/i,
  /\bflood (zone|risk)\b/i,
  /\bbushfire\b/i,
  /\bdemograph/i,
  /\binfrastructure pipeline\b/i,
  /\bzoning overlay\b/i,
];

function parseH2(markdown: string): string[] {
  const matches = markdown.match(/^##\s+(.+?)\s*$/gm) ?? [];
  return matches.map((m) => m.replace(/^##\s+/, '').trim());
}

function normalize(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findDef(heading: string, registry: CompassSectionDefinition[]) {
  const target = normalize(heading);
  return registry.find(
    (s) =>
      normalize(s.name) === target ||
      s.sourceHeadings.some((sh) => normalize(sh) === target),
  );
}

function splitBySections(markdown: string): { heading: string; body: string }[] {
  const lines = markdown.split('\n');
  const out: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) out.push(current);
      current = { heading: m[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) out.push(current);
  return out;
}

export interface QAContext {
  /**
   * The numbers `investment_score` actually holds (`recordedScoreValues`).
   * When given, a score-shaped claim in the prose that matches none of them
   * is reported (QA-18) — a document may print a score the record holds, and
   * no other.
   */
  recordedScores?: number[];
}

export function runQAValidation(
  markdown: string,
  tier: 'compass-40' | 'financial-analysis',
  context: QAContext = {},
): QAReport {
  const findings: QAFinding[] = [];
  const registry =
    tier === 'compass-40' ? COMPASS_40_SECTIONS : FINANCIAL_ANALYSIS_SECTIONS;
  const wordCount = countWords(markdown);
  const estimatedPages = estimatePages(markdown);

  // Rule 1 — page band
  const band =
    tier === 'compass-40' ? COMPASS_PAGE_BAND : { min: 18, max: 22 };
  if (estimatedPages < band.min) {
    findings.push({
      rule: 'page-band',
      severity: 'warning',
      message: `Estimated ${estimatedPages} pages, below target min ${band.min}.`,
    });
  } else if (estimatedPages > band.max) {
    findings.push({
      rule: 'page-band',
      severity: 'error',
      message: `Estimated ${estimatedPages} pages, exceeds target max ${band.max}.`,
    });
  }

  // Rule 2 — financial exclusion (Compass only)
  if (tier === 'compass-40') {
    for (const pat of FINANCIAL_KEYWORDS) {
      if (pat.test(markdown)) {
        findings.push({
          rule: 'financial-exclusion',
          severity: 'error',
          message: `Compass contains financial content matching ${pat}. Move to Financial Analysis Report.`,
        });
      }
    }
  }

  // Rule 2b — forbidden placeholders / unresolved citations (both tiers)
  for (const pat of FORBIDDEN_PLACEHOLDERS) {
    if (pat.test(markdown)) {
      findings.push({
        rule: 'forbidden-placeholder',
        severity: 'error',
        message: `Report contains unresolved placeholder matching ${pat}. Replace with a real source reference or remove and consolidate into the source appendix.`,
      });
    }
  }

  // Rule 2d — no score the record does not hold (QA-18). Tables and chart
  // directives print recorded figures and are not read here; prose is.
  if (context.recordedScores) {
    const recorded = new Set(context.recordedScores.map((n) => Math.round(n)));
    const prose = markdown
      .split('\n')
      .filter((l) => { const t = l.trim(); return t && !t.startsWith('|') && !t.startsWith('{{') && !t.startsWith('#'); })
      .join('\n');
    const unrecorded = findScoreClaims(prose).filter((c) => !recorded.has(c.value));
    if (unrecorded.length) {
      findings.push({
        rule: 'unrecorded-score',
        severity: 'warning',
        message: `Prose asserts ${unrecorded.length} score(s) the record does not hold: `
          + unrecorded.slice(0, 5).map((c) => `"${c.text}"`).join(', ')
          + '. A document may print the recorded score and its scored dimensions, and no other.',
      });
    }
  }

  // Rule 2c — no editorial commentary label survives, in any of its three forms.
  //
  // This replaces the v2.0 pair of decision-box rules, which counted only
  // `^#{2,4} what this means` and so found 11 of the 5,043 labels in the
  // production corpus. It shares its matcher with the post-processor that does
  // the removing, so the check and the fix cannot disagree about what a label is.
  const survivingLabels = findEditorialLabels(markdown);
  if (survivingLabels.length > 0) {
    const sample = survivingLabels.slice(0, 5).join(' / ');
    findings.push({
      rule: 'editorial-label',
      severity: 'error',
      message:
        `Report contains ${survivingLabels.length} editorial commentary label(s) — e.g. ${sample}. ` +
        'State the finding in the sentence introducing the data instead.',
    });
  }

  // Rule 3 — suburb-narrative exclusion (Financial only)
  if (tier === 'financial-analysis') {
    for (const pat of SUBURB_KEYWORDS) {
      if (pat.test(markdown)) {
        findings.push({
          rule: 'suburb-exclusion',
          severity: 'warning',
          message: `Financial report contains suburb-narrative content matching ${pat}.`,
        });
      }
    }
  }

  // Rule 4 — duplicate H2 headings
  const h2s = parseH2(markdown);
  const seen = new Map<string, number>();
  for (const h of h2s) {
    const k = normalize(h);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, count] of seen) {
    if (count > 1) {
      findings.push({
        rule: 'duplicate-h2',
        severity: 'error',
        message: `Heading "${k}" appears ${count} times.`,
      });
    }
  }

  // Rules 5–7 — per-section checks
  const sections = splitBySections(markdown);
  for (const sec of sections) {
    const def = findDef(sec.heading, registry);
    if (!def) continue;

    // 7 — per-section word cap
    const w = countWords(sec.body);
    if (def.maxWordCount > 0 && w > def.maxWordCount * 1.1) {
      findings.push({
        rule: 'word-cap',
        severity: 'warning',
        sectionId: def.id,
        message: `Section "${sec.heading}" has ${w} words, over cap ${def.maxWordCount}.`,
      });
    }

    // 8 — heading density. 68 H3s a report across 17 sections was the
    // structural half of the noise; the prompt asks for at most four.
    const h3 = (sec.body.match(/^###\s+/gm) ?? []).length;
    if (h3 > MAX_SUBHEADINGS_PER_SECTION) {
      findings.push({
        rule: 'subheading-density',
        severity: 'warning',
        sectionId: def.id,
        message: `Section "${sec.heading}" has ${h3} sub-headings (max ${MAX_SUBHEADINGS_PER_SECTION}).`,
      });
    }
  }

  // 6 — Protected sections must be present (Compass only)
  if (tier === 'compass-40') {
    const presentDefs = new Set(
      sections.map((s) => findDef(s.heading, registry)?.id).filter(Boolean),
    );
    for (const protectedId of PROTECTED_SECTION_IDS) {
      if (!presentDefs.has(protectedId)) {
        findings.push({
          rule: 'missing-protected-section',
          severity: 'error',
          sectionId: protectedId,
          message: `Required Protected section "${protectedId}" missing from Compass report.`,
        });
      }
    }
  }


  // Rule 9 — a promised table is a table that exists (QA-33).
  //
  // "The matrix below groups the main amenities by type" printed on two of
  // the audited documents with nothing below it: the figure was a chart
  // directive the standard presentation could not draw, so it was dropped,
  // and the sentence that introduced it stayed. A lead-in is a promise; a
  // section that makes one must carry a table or a directive after it.
  for (const s of splitBySections(markdown)) {
    const lines = s.body.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('|') || t.startsWith('{{') || t.startsWith('#')) return;
      if (!TABLE_PROMISE.test(t)) return;
      const kept = lines.slice(i + 1).some((l) => { const u = l.trim(); return u.startsWith('|') || u.startsWith('{{'); });
      if (!kept) {
        findings.push({
          rule: 'promised-table',
          severity: 'error',
          sectionId: findDef(s.heading, registry)?.id,
          message: `"${s.heading}" promises a table or matrix below ("${t.slice(0, 80)}…") and none follows. Draw it or remove the promise.`,
        });
      }
    });
  }

  // Rule 10 — a paired heading carries both halves (QA-33).
  //
  // "Strengths and Limitations" on the audited Compass printed strengths and
  // no limitations at all — the second half had been cut by a word cap. A
  // heading that names two lists is a promise of two lists.
  for (const s of splitBySections(markdown)) {
    const lines = s.body.split('\n');
    const pairAt = lines.findIndex((l) => PAIR_HEADING.test(l.trim()));
    if (pairAt < 0) continue;
    const rest = lines.slice(pairAt + 1);
    const secondAt = rest.findIndex((l) => PAIR_SECOND_LABEL.test(l.trim()));
    const secondHasContent = secondAt >= 0 && rest.slice(secondAt + 1).some((l) => {
      const t = l.trim();
      return t && !t.startsWith('#') && !PAIR_SECOND_LABEL.test(t);
    });
    if (!secondHasContent) {
      findings.push({
        rule: 'unbalanced-pair',
        severity: 'error',
        sectionId: findDef(s.heading, registry)?.id,
        message: `"${s.heading}" announces "${lines[pairAt].trim().replace(/^#+\s*/, '')}" but carries no ${secondAt >= 0 ? 'content under the second list' : 'second list'}. State the limitations or rename the heading.`,
      });
    }
  }

  // Rule 11 — confidence is evidence completeness, not reassurance (QA-20).
  //
  // "Environmental Risk — Level: Moderate — Confidence: High" sat beside the
  // instruction to obtain the flood and bushfire checks. A rating may be
  // called high-confidence only once the dated, parcel-level check is held;
  // while a required check is outstanding the honest word is "unverified".
  {
    const lines = markdown.split('\n');
    lines.forEach((line, i) => {
      if (!/confidence:\s*high\b/i.test(line)) return;
      const window = lines.slice(i + 1, i + 8).join(' ');
      if (/required (?:check|action|dd)|verification required|to be (?:verified|confirmed|assessed)|pending|obtain|confirm with|verify with/i.test(window)) {
        findings.push({
          rule: 'risk-confidence-overstated',
          severity: 'warning',
          message: `A risk is rated "Confidence: High" while its required check is still outstanding ("${line.trim().slice(0, 80)}"). Confidence describes evidence held, so rate it "Unverified" until the dated check exists.`,
        });
      }
    });
  }

  const passed = findings.every((f) => f.severity !== 'error');
  return { tier, estimatedPages, wordCount, passed, findings };
}
