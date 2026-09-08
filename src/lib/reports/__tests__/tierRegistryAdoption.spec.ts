/**
 * Phase 2 adoption — the registry is read, not just declared.
 *
 * `sectionRegistry.spec.ts` proves the constitution is coherent and that every
 * section it declares can be produced. These pins are the other half: that the
 * call sites which used to keep their own copy of the structure now ask it, and
 * that doing so changed the snapshot not at all and the briefing exactly as
 * intended.
 *
 * The briefing is the behaviour change in this phase, so it is measured rather
 * than asserted: the fixture below is the literal heading list of production
 * row `89b451f6` (4 September 2026, the newest briefing and the one Phase 1's
 * own comment names), and the expectations state what the trim does to it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authoredHeadingsForTier,
  markdownHeadingsForTier,
} from '../investment/sectionRegistry.pure';
import { trimToDeclaredSections } from '../investment/derivedHygiene.pure';

const REPO = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
const CONDENSE = 'supabase/functions/condense-investment-report/index.ts';

const doc = (headings: readonly string[]) =>
  headings.map((h) => `## ${h}\n\nBody for ${h}.\n`).join('\n');

const headingsOf = (markdown: string) =>
  [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// The snapshot is unchanged — the same nine headings, in the same order
// ---------------------------------------------------------------------------

describe('the snapshot list moved to the registry and did not change', () => {
  /**
   * The array that was typed inline at the trim call site, verbatim from before
   * this phase. If the registry ever stops reproducing it exactly, a snapshot
   * loses or gains a section — so the old list is kept here as the witness
   * rather than deleted with the code that held it.
   */
  const AS_TYPED_INLINE = [
    'Property Summary', 'Key Market Stats', 'Investment Score', 'Score Breakdown',
    'Financial Snapshot', 'Top 3 Opportunities', 'Top 3 Risks', 'Quick Recommendation',
    'Market Data Sources',
  ];

  it('the registry produces the identical list, in the identical order', () => {
    expect(markdownHeadingsForTier('snapshot')).toEqual(AS_TYPED_INLINE);
  });

  it('trims a snapshot to exactly what it did before', () => {
    // A snapshot as production writes them, plus two headings echoed from the
    // parent — the defect Phase 1 fixed for this tier.
    const written = doc([
      'Property Summary', 'Key Market Stats', 'Investment Score',
      'Score Breakdown (simplified)', 'Financial Snapshot', 'Top 3 Opportunities',
      'Top 3 Risks', 'Quick Recommendation', 'Market Data Sources',
      'Location Overview', 'Loan Analysis (P&I and Interest-Only)',
    ]);
    const trimmed = trimToDeclaredSections(written, markdownHeadingsForTier('snapshot'));
    expect(headingsOf(trimmed.markdown)).toEqual([
      'Property Summary', 'Key Market Stats', 'Investment Score',
      'Score Breakdown (simplified)', 'Financial Snapshot', 'Top 3 Opportunities',
      'Top 3 Risks', 'Quick Recommendation', 'Market Data Sources',
    ]);
    expect(trimmed.dropped).toEqual(['Location Overview', 'Loan Analysis (P&I and Interest-Only)']);
  });
});

// ---------------------------------------------------------------------------
// The briefing gains the trim it never had
// ---------------------------------------------------------------------------

describe('the briefing is trimmed to its own structure', () => {
  /** Production row 89b451f6, 2026-09-04 — all 29 H2 headings, in order. */
  const PRODUCTION_BRIEFING = [
    'Location Overview', 'Current Market Performance (Q3/Q4 2025)',
    'Historical Price Growth Table', 'Historical Rent Growth Table', 'Market Activity',
    'Population & Household Characteristics', 'Major Industries & Job Growth',
    'Transport & Accessibility', 'Education Facilities', 'Healthcare & Shopping',
    'Environmental Risks', 'Crime Statistics', 'Property-Level Information',
    'Purchase & Ongoing Costs', 'Base Assumptions', 'Gross & Net Yield Calculation',
    'Loan Analysis (P&I and Interest-Only)', 'Sensitivity Analysis',
    'Property Value Projections', 'Rental Income Projections',
    'Cumulative Cashflow Projections', 'LVR Projections', 'Overall Investment Score',
    'Investment Score Breakdown', 'SWOT Analysis', 'Top 3 Opportunities',
    'Top 3 Risks', 'Investment Recommendations', 'Market Data Sources',
  ];

  it('declares seventeen headings — nine authored, eight composed and appended', () => {
    const all = markdownHeadingsForTier('briefing');
    const authored = authoredHeadingsForTier('briefing');
    expect(authored).toEqual([
      'Executive Summary', 'Location & Demand', 'Amenity & Access', 'Market Position',
      'Property Fit', 'Risk Overview', 'Top 3 Opportunities', 'Top 3 Risks',
      'Recommendation', 'Market Data Sources',
    ]);
    // The rest are the chapters composed from the record after the model call.
    expect(all.filter((h) => !authored.includes(h))).toEqual([
      'Purchase Costs & Annual Holding Cost Breakdown',
      'Rental Assessment, Gross Yield & Net Yield',
      'Loan Structure, Repayments & Cashflow Impact',
      'Sensitivity & Scenario Testing',
      '10-Year Cashflow, Equity & Growth Projection',
      'Investment Score Breakdown',
      'SWOT Analysis',
    ]);
  });

  it('keeps every section a correctly-written briefing carries', () => {
    const written = doc(markdownHeadingsForTier('briefing'));
    const trimmed = trimToDeclaredSections(written, markdownHeadingsForTier('briefing'));
    expect(trimmed.dropped).toEqual([]);
    expect(headingsOf(trimmed.markdown)).toEqual(markdownHeadingsForTier('briefing'));
  });

  it('drops the parent\'s structure from the briefing production actually shipped', () => {
    const trimmed = trimToDeclaredSections(
      doc(PRODUCTION_BRIEFING),
      markdownHeadingsForTier('briefing'),
    );
    // Five of twenty-nine survive: everything else is the Compass parent's own
    // headings, echoed into a document that declares nine of its own.
    expect(headingsOf(trimmed.markdown)).toEqual([
      'Investment Score Breakdown', 'SWOT Analysis', 'Top 3 Opportunities',
      'Top 3 Risks', 'Market Data Sources',
    ]);
    expect(trimmed.dropped).toHaveLength(24);
    expect(trimmed.dropped).toContain('Location Overview');
    expect(trimmed.dropped).toContain('Historical Price Growth Table');
    // Including the financial tables — which the new pipeline composes from the
    // record and appends under the declared headings instead.
    expect(trimmed.dropped).toContain('Loan Analysis (P&I and Interest-Only)');
  });
});

// ---------------------------------------------------------------------------
// The safety valve
// ---------------------------------------------------------------------------

describe('a trim that would empty the prose is refused', () => {
  /** The guard as the edge function computes it. */
  const authoredSurvives = (markdown: string, tier: 'briefing' | 'snapshot') => {
    const authored = authoredHeadingsForTier(tier).map((h) => h.toLowerCase());
    return headingsOf(markdown)
      .map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim())
      .some((h) => authored.some((a) => h === a || h.startsWith(`${a} `)));
  };

  it('a composed chapter alone does not count as the model having written anything', () => {
    // This is why the guard asks about authored headings and not about `##`:
    // the composed chapters are appended by us and always match, so a document
    // whose prose was entirely discarded would otherwise look healthy.
    const composedOnly = doc([
      'Purchase Costs & Annual Holding Cost Breakdown',
      'Rental Assessment, Gross Yield & Net Yield',
      '10-Year Cashflow, Equity & Growth Projection',
    ]);
    expect(headingsOf(composedOnly)).toHaveLength(3);
    expect(authoredSurvives(composedOnly, 'briefing')).toBe(false);
  });

  it('one surviving authored section is enough', () => {
    expect(authoredSurvives(doc(['Risk Overview']), 'briefing')).toBe(true);
    // The guide's own qualified spelling still matches, as the trim does.
    expect(authoredSurvives(doc(['Top 3 Opportunities']), 'snapshot')).toBe(true);
  });

  it('a snapshot of nothing but its composed sections has not survived either', () => {
    // `Score Breakdown` used to be this tier's example of a qualified authored
    // heading. It is composed from the record now, along with `Investment
    // Score` and `Financial Snapshot` — so, exactly like the briefing's
    // chapters above, a document containing only those three is our own output
    // and says nothing about whether the model followed the guide.
    const composedOnly = doc(['Investment Score', 'Score Breakdown', 'Financial Snapshot']);
    expect(headingsOf(composedOnly)).toHaveLength(3);
    expect(authoredSurvives(composedOnly, 'snapshot')).toBe(false);
  });

  it('the edge function keeps the untrimmed text in that state', () => {
    const src = read(CONDENSE);
    expect(src).toContain('authoredHeadingsForTier');
    expect(src).toMatch(/if \(keptAny\) \{/);
    expect(src).toContain('hygiene.sections_trim_skipped');
  });
});

// ---------------------------------------------------------------------------
// The dead declarations are gone, and the guide asks for what the tier promises
// ---------------------------------------------------------------------------

describe('the condense function keeps no structure of its own', () => {
  const src = () => read(CONDENSE);

  it('TIER_CONFIG no longer declares sections or a content ratio', () => {
    const config = src().slice(src().indexOf('const TIER_CONFIG'), src().indexOf('structureGuide'));
    // Both were read by nothing, and the snapshot's copy disagreed with the
    // guide beside it: `Top Opportunities & Risks` and `Recommendation` against
    // the guide's `Top 3 Opportunities`, `Top 3 Risks` and `Quick
    // Recommendation`. A structure a reader trusts and no code consults.
    expect(config).not.toContain('contentRatio');
    expect(config).not.toMatch(/^\s*sections: \[/m);
    // As a string literal — the comment above TIER_CONFIG names it in
    // backticks, because the record of what was wrong is worth keeping.
    expect(src()).not.toContain("'Top Opportunities & Risks'");
  });

  it('both trims read the registry rather than a literal', () => {
    const s = src();
    expect(s).toContain("markdownHeadingsForTier(targetTier)");
    // The inline nine are gone.
    expect(s).not.toContain("'Property Summary', 'Key Market Stats'");
  });

  it('the briefing guide asks for the sources section its tier promises', () => {
    // `provenance` is spine — mandatory in every tier — and the Phase 1 re-cut
    // left the briefing without it. The registry's producibility check is what
    // said so.
    const s = src();
    const briefing = s.slice(s.indexOf('briefing: {'), s.indexOf('snapshot: {'));
    expect(briefing).toContain('## Market Data Sources');
    expect(briefing).toContain('WRITE ONLY THE SECTIONS ABOVE');
  });
});
