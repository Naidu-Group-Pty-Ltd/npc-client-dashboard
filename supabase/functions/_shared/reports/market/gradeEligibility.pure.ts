/**
 * What a grade requires of the evidence behind it.
 *
 * ## The case this exists for
 *
 * The methodology fixtures produce one result that is correct and must not be
 * allowed to become an A+: a suburb with a single strong twelve-month figure,
 * measured at regional level, on six transactions and two periods, with the
 * dwelling type unmatched. Growth scores **93**. Coverage is **10%**.
 * Confidence is **low**.
 *
 * Nothing is wrong with that 93 — it is what the evidence says. What would be
 * wrong is printing "A+" on it, because the honest sentence underneath would
 * read *"this property is exceptional, on the strength of one year of regional
 * data covering six sales of a different dwelling type."* No client should be
 * shown that, and Aurixa could not defend it.
 *
 * ## The rule
 *
 * A grade is a claim about a property. The score says how strong the claim is;
 * eligibility says whether the evidence can carry it. They are checked
 * separately, and **eligibility never changes the score** — it caps the grade
 * and states why, so the number and the reason stay legible side by side.
 *
 * Deliberately **not** "4 of 5 dimensions". Counting dimensions treats a
 * missing vacancy rate as equivalent to a missing five-year growth series, and
 * they are nothing alike: one is a nice-to-have, the other is the single most
 * important input to a property investment grade. The rule below is about
 * Growth specifically, plus a floor on overall coverage — so a strongly
 * evidenced property is not blocked by one absent minor metric, and a property
 * with no credible suburb growth evidence cannot reach A+ on Yield and
 * Location alone.
 *
 * ## The second ceiling (2.0.0): absence never lifts a grade
 *
 * The composite renormalises over measured dimensions, which is right for the
 * SCORE — three strong dimensions are a claim about those three. But the
 * arithmetic has a reward hiding in it: drop the WEAKEST dimension and the
 * renormalised composite rises, and with the coverage floor at 0.70 a strong
 * property missing a mediocre Demand could cross the A+ line it would not
 * cross with Demand measured. Found by fixture before any real evidence was
 * scored: growth 90 / location 80 / yield 85 / demand 55 composites to ~81
 * with Demand and ~86 without it.
 *
 * So the printed grade also answers to the **nominal-weight sum of what was
 * measured**: the points the evidence actually delivered, over the full 100.
 * Missing evidence still never scores — the composite, the coverage and the
 * disclosure are untouched — but it can no longer LIFT the badge, because a
 * dimension that was not measured contributes nothing toward the higher
 * grade's floor. Adding evidence can only raise this ceiling (a measured
 * score is ≥ 0), so the property the mandate demands holds by construction:
 * **missing data never improves the grade, and arriving data never lowers
 * this ceiling.** With Risk structurally unavailable today the ceiling's
 * maximum is 95 of 100, so A+ (85) remains mathematically reachable — on
 * genuinely exceptional evidence across the four live dimensions, which is
 * what an A+ is supposed to mean.
 */

import type { GrowthResult } from './growthScoring.pure.ts';

/** Bumped whenever a threshold changes. Persisted beside the grade. */
export const ELIGIBILITY_VERSION = '2.0.0';

/** The grade thresholds. Unchanged, and not this module's to move. */
export const GRADE_THRESHOLDS: ReadonlyArray<readonly [number, string]> = [
  [85, 'A+'], [75, 'A'], [65, 'B+'], [55, 'B'], [50, 'C+'], [40, 'C'], [30, 'D'], [0, 'F'],
];

export function gradeFor(score: number): string {
  for (const [floor, grade] of GRADE_THRESHOLDS) if (score >= floor) return grade;
  return 'F';
}

export const ELIGIBILITY_RULES = {
  /** A needs Growth evidence that is at least credible. */
  aMinGrowthConfidence: 45,
  /** …and enough of the Growth weight actually measured. */
  aMinGrowthCoverage: 0.45,
  /** A+ needs Growth evidence that is strong. */
  aPlusMinGrowthConfidence: 70,
  aPlusMinGrowthCoverage: 0.70,
  /** A+ also needs the composite to rest on most of its dimensions. */
  aPlusMinOverallCoverage: 0.70,
  /** A needs the composite to rest on more than half of its dimensions. */
  aMinOverallCoverage: 0.55,
} as const;

export interface EligibilityInput {
  /** The composite score, 0-100. */
  compositeScore: number;
  growth: GrowthResult;
  /** Share of the composite's nominal weight that was measured, 0-1. */
  overallCoverage: number;
  /**
   * Σ (measured dimension score × nominal weight) — the points the evidence
   * actually delivered over the full 100. The renormalised composite answers
   * "how strong is what we measured"; this answers "how much did the evidence
   * deliver", and the printed grade may not exceed what was delivered.
   */
  nominalMeasuredScore: number;
}

export interface EligibilityResult {
  version: string;
  /** The grade the score alone would give. */
  scoreGrade: string;
  /** The grade after the evidence cap. Never better than `scoreGrade`. */
  grade: string;
  /** True when evidence held the grade below what the score would allow. */
  capped: boolean;
  /** The highest grade the evidence supports. */
  ceiling: string;
  /** Why, in the operator's terms. Empty when nothing was capped. */
  reasons: ReadonlyArray<string>;
}

/**
 * Apply the evidence ceiling to a composite score.
 *
 * A grade can only ever be lowered here, never raised: this is a guard on an
 * over-claim, not a second opinion on the arithmetic.
 */
export function applyEligibility(input: EligibilityInput): EligibilityResult {
  const { compositeScore, growth, overallCoverage, nominalMeasuredScore } = input;
  const scoreGrade = gradeFor(compositeScore);
  const reasons: string[] = [];
  const r = ELIGIBILITY_RULES;

  const gConf = growth.confidence.score;
  const gCover = growth.weightCovered;
  const hasGrowth = growth.score !== null;

  // Can the evidence carry an A+?
  const aPlusOk =
    hasGrowth
    && gConf >= r.aPlusMinGrowthConfidence
    && gCover >= r.aPlusMinGrowthCoverage
    && overallCoverage >= r.aPlusMinOverallCoverage;

  // Can it carry an A?
  const aOk =
    hasGrowth
    && gConf >= r.aMinGrowthConfidence
    && gCover >= r.aMinGrowthCoverage
    && overallCoverage >= r.aMinOverallCoverage;

  const growthCeiling = aPlusOk ? 'A+' : aOk ? 'A' : 'B+';

  // The second ceiling: the grade the DELIVERED points support. Unmeasured
  // weight contributes nothing toward a higher badge — it is not scored, and
  // it does not lift.
  const nominalCeiling = gradeFor(nominalMeasuredScore);

  const order = ['F', 'D', 'C', 'C+', 'B', 'B+', 'A', 'A+'];
  const ceiling = order[Math.min(order.indexOf(growthCeiling), order.indexOf(nominalCeiling))];

  // Only explain the constraint that actually binds.
  const wanted = scoreGrade === 'A+' ? 'A+' : scoreGrade === 'A' ? 'A' : null;
  if (wanted === 'A+' && !aPlusOk) {
    if (!hasGrowth) reasons.push('No capital-growth evidence was available for this property.');
    else {
      if (gConf < r.aPlusMinGrowthConfidence) {
        reasons.push(
          `Growth evidence confidence is ${gConf} (${growth.confidence.band}); ` +
            `A+ requires at least ${r.aPlusMinGrowthConfidence}.`,
        );
      }
      if (gCover < r.aPlusMinGrowthCoverage) {
        reasons.push(
          `Only ${Math.round(gCover * 100)}% of the growth methodology could be measured; ` +
            `A+ requires at least ${Math.round(r.aPlusMinGrowthCoverage * 100)}%.`,
        );
      }
      if (overallCoverage < r.aPlusMinOverallCoverage) {
        reasons.push(
          `Only ${Math.round(overallCoverage * 100)}% of the scoring dimensions were measured; ` +
            `A+ requires at least ${Math.round(r.aPlusMinOverallCoverage * 100)}%.`,
        );
      }
    }
  } else if (wanted === 'A' && !aOk) {
    if (!hasGrowth) reasons.push('No capital-growth evidence was available for this property.');
    else {
      if (gConf < r.aMinGrowthConfidence) {
        reasons.push(
          `Growth evidence confidence is ${gConf} (${growth.confidence.band}); ` +
            `A requires at least ${r.aMinGrowthConfidence}.`,
        );
      }
      if (gCover < r.aMinGrowthCoverage) {
        reasons.push(
          `Only ${Math.round(gCover * 100)}% of the growth methodology could be measured; ` +
            `A requires at least ${Math.round(r.aMinGrowthCoverage * 100)}%.`,
        );
      }
      if (overallCoverage < r.aMinOverallCoverage) {
        reasons.push(
          `Only ${Math.round(overallCoverage * 100)}% of the scoring dimensions were measured; ` +
            `A requires at least ${Math.round(r.aMinOverallCoverage * 100)}%.`,
        );
      }
    }
  }

  // Say when the delivered-points ceiling is the binding one.
  const capIndex = order.indexOf(ceiling);
  const scoreIndex = order.indexOf(scoreGrade);
  if (scoreIndex > capIndex && order.indexOf(nominalCeiling) < order.indexOf(growthCeiling)) {
    reasons.push(
      `The measured evidence delivers ${Math.round(nominalMeasuredScore)} of the composite's 100 `
        + `nominal points, which supports at most ${nominalCeiling}. A dimension that was not `
        + 'measured is never scored — and never lifts the grade.',
    );
  }

  const grade = scoreIndex > capIndex ? ceiling : scoreGrade;

  return {
    version: ELIGIBILITY_VERSION,
    scoreGrade,
    grade,
    capped: grade !== scoreGrade,
    ceiling,
    reasons,
  };
}
