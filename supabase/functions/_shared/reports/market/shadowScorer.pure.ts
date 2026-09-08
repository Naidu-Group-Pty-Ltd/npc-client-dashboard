/**
 * ME-4 — `scoreInvestmentV2Shadow`, the one place the whole system composes.
 *
 * **This is not connected to report generation and must not be.**
 * `investment-scoring-service` is untouched; nothing here reaches a document, a
 * stored row or a client. It exists so the complete scoring system can be
 * tested, invariant-checked and backtested as one thing before anybody decides
 * to wire it.
 *
 * ## Why one function
 *
 * The five dimensions are individually pure and individually verified, which is
 * necessary and not sufficient: every defect this programme has found lived in
 * the *composition* — a weight applied to a placeholder, a dimension declaring
 * itself measured on evidence it never read, a grade printed on 10% coverage.
 * Those are only visible where the pieces meet, so the pieces meet in exactly
 * one place.
 *
 * ## Three rules
 *
 * **Weights renormalise over what was MEASURED, and the renormalisation is
 * reported.** A composite resting on three of five dimensions is a different
 * claim from one resting on five, and `effectiveWeights` plus
 * `evidenceCoverage` are what let a reader tell them apart. Audit §48's A+
 * properties were all "≤85% of the nominal evidence renormalised to 100%", and
 * the number that would have exposed it is published here.
 *
 * **A dimension that could not be measured is absent, never zero.** It leaves
 * the composite entirely rather than dragging it down, because scoring an
 * unmeasured dimension 0 is a claim about the property that the evidence does
 * not support — and scoring it 50 is the placeholder this programme removes.
 *
 * **The grade is capped by evidence and the cap is explained.** `uncappedGrade`
 * and `grade` are both returned, always, so the difference between "the score
 * says A+" and "the evidence supports A+" is legible rather than silently
 * resolved.
 */

import type { MarketEvidence } from './marketEvidence.pure.ts';
import { type GrowthResult, scoreGrowth, GROWTH_METHODOLOGY_VERSION } from './growthScoring.pure.ts';
import { type DemandResult, scoreDemand, DEMAND_METHODOLOGY_VERSION } from './demandScoring.pure.ts';
import {
  type YieldInputs, type YieldResult, scoreYield, holdingCashFlowSignal,
  YIELD_METHODOLOGY_VERSION,
} from './yieldScoring.pure.ts';
import {
  type LocationInputs, type LocationResult, scoreLocation, LOCATION_METHODOLOGY_VERSION,
} from './locationScoring.pure.ts';
import {
  type RiskInputs, type RiskResult, scoreRisk, RISK_METHODOLOGY_VERSION,
} from './riskScoring.pure.ts';
import {
  type EligibilityResult, applyEligibility, ELIGIBILITY_VERSION,
} from './gradeEligibility.pure.ts';
import {
  type EvidenceStatement, type StatementAudience, buildEvidenceStatement,
} from './evidenceStatement.pure.ts';

/** Bumped whenever composition, weights or versions change. Persisted with the score. */
export const SHADOW_METHODOLOGY_VERSION = '2.0.0-shadow';

/**
 * Nominal weights. Unchanged from the live composite on purpose: this release
 * fixes what each dimension MEASURES, and re-weighting at the same time would
 * make it impossible to attribute any change in the backtest to either.
 */
export const COMPOSITE_WEIGHTS = {
  growth: 0.40,
  location: 0.25,
  yield: 0.15,
  demand: 0.15,
  risk: 0.05,
} as const;

export type DimensionKey = keyof typeof COMPOSITE_WEIGHTS;

/** Below this many measured dimensions there is no defensible headline grade. */
export const MIN_DIMENSIONS_FOR_GRADE = 3;

export interface ShadowScoreInput {
  evidence: MarketEvidence;
  yieldInputs: YieldInputs;
  locationInputs: LocationInputs;
  riskInputs: RiskInputs;
  /** Who the Evidence Behind the Score is being assembled for. */
  audience?: StatementAudience;
  /** Injected for determinism in tests and backtests. */
  now?: Date;
}

export interface DimensionReading {
  key: DimensionKey;
  /** 0-100, or null when the dimension could not be measured. */
  score: number | null;
  /** The weight it would carry if every dimension were measured. */
  nominalWeight: number;
  /**
   * The weight it actually carried, after renormalising over measured
   * dimensions. Zero for an unmeasured dimension.
   */
  effectiveWeight: number;
  /** Share of this dimension's own methodology that ran, 0-1. */
  coverage: number;
  /** 0-100 where the dimension reports one; null where it does not (Yield, Location, Risk). */
  confidence: number | null;
}

export interface ShadowScoreResult {
  methodologyVersion: string;
  /** Every component version, so a stored score can be reproduced exactly. */
  componentVersions: Readonly<Record<string, string>>;

  /** Per-dimension readings, in declaration order. */
  dimensions: ReadonlyArray<DimensionReading>;
  measured: ReadonlyArray<DimensionKey>;
  unavailable: ReadonlyArray<DimensionKey>;

  /**
   * Share of the NOMINAL composite weight that was actually measured, 0-1.
   * The number audit §48's A+ properties would have been caught by.
   */
  evidenceCoverage: number;

  /** 0-100, or null when too few dimensions could be measured to say anything. */
  compositeScore: number | null;
  /** The grade the score alone gives. */
  uncappedGrade: string | null;
  /** The grade after the evidence ceiling. Never better than `uncappedGrade`. */
  grade: string | null;
  /** Why the grade was held down, in the operator's words. Empty when it was not. */
  gradeCapReason: ReadonlyArray<string>;

  /** The full underlying results, for the harness and the evidence trail. */
  growth: GrowthResult;
  demand: DemandResult;
  yieldResult: YieldResult;
  location: LocationResult;
  risk: RiskResult;
  eligibility: EligibilityResult | null;

  /** What a document would show a reader about what the grade rests on. */
  evidenceStatement: EvidenceStatement;

  /**
   * The holding cash-flow reading, carried beside the score rather than inside
   * Yield. Named for its destination so re-entering Yield would be visible.
   */
  holdingCashFlow: ReturnType<typeof holdingCashFlowSignal>;

  /** Set when the composite could not be formed, saying why. */
  unavailableReason: string | null;
}

/**
 * Compose the shadow score.
 *
 * Deterministic: same inputs, same output. No HTTP, no model, no clock beyond
 * the injected `now`.
 */
export function scoreInvestmentV2Shadow(input: ShadowScoreInput): ShadowScoreResult {
  const now = input.now ?? new Date();
  const audience = input.audience ?? 'internal';

  const growth = scoreGrowth(input.evidence, now);
  const demand = scoreDemand(input.evidence, now);
  const yieldResult = scoreYield(input.yieldInputs);
  const location = scoreLocation(input.locationInputs);
  const risk = scoreRisk(input.riskInputs);

  const raw: Array<{ key: DimensionKey; score: number | null; coverage: number; confidence: number | null }> = [
    { key: 'growth', score: growth.score, coverage: growth.weightCovered, confidence: growth.confidence.score },
    { key: 'location', score: location.score, coverage: location.weightCovered, confidence: null },
    { key: 'yield', score: yieldResult.score, coverage: yieldResult.score === null ? 0 : 1, confidence: null },
    { key: 'demand', score: demand.score, coverage: demand.weightCovered, confidence: demand.confidence.score },
    { key: 'risk', score: risk.score, coverage: risk.weightCovered, confidence: null },
  ];

  const measured = raw.filter((d) => d.score !== null);
  const measuredWeight = measured.reduce((s, d) => s + COMPOSITE_WEIGHTS[d.key], 0);

  const dimensions: DimensionReading[] = raw.map((d) => ({
    key: d.key,
    score: d.score,
    nominalWeight: COMPOSITE_WEIGHTS[d.key],
    effectiveWeight: d.score === null || measuredWeight === 0
      ? 0
      : Number((COMPOSITE_WEIGHTS[d.key] / measuredWeight).toFixed(4)),
    coverage: d.coverage,
    confidence: d.confidence,
  }));

  // Evidence coverage is the share of NOMINAL weight measured, discounted by
  // how much of each measured dimension's own methodology ran. A dimension
  // scored on a third of its inputs did not deliver a whole dimension's worth
  // of evidence, and a composite that counted it as one would overstate.
  const evidenceCoverage = Number(
    raw.reduce((s, d) => s + (d.score === null ? 0 : COMPOSITE_WEIGHTS[d.key] * d.coverage), 0).toFixed(4),
  );

  const holdingCashFlow = holdingCashFlowSignal(input.yieldInputs);

  const base: Omit<ShadowScoreResult,
    'compositeScore' | 'uncappedGrade' | 'grade' | 'gradeCapReason' | 'eligibility' | 'unavailableReason'> = {
    methodologyVersion: SHADOW_METHODOLOGY_VERSION,
    componentVersions: {
      growth: GROWTH_METHODOLOGY_VERSION,
      demand: DEMAND_METHODOLOGY_VERSION,
      yield: YIELD_METHODOLOGY_VERSION,
      location: LOCATION_METHODOLOGY_VERSION,
      risk: RISK_METHODOLOGY_VERSION,
      eligibility: ELIGIBILITY_VERSION,
    },
    dimensions,
    measured: measured.map((d) => d.key),
    unavailable: raw.filter((d) => d.score === null).map((d) => d.key),
    evidenceCoverage,
    growth,
    demand,
    yieldResult,
    location,
    risk,
    evidenceStatement: buildEvidenceStatement({
      growth, demand, yieldResult,
      eligibility: applyEligibility({ compositeScore: 0, growth, overallCoverage: evidenceCoverage }),
      evidence: input.evidence,
      audience,
    }),
    holdingCashFlow,
  };

  if (measured.length < MIN_DIMENSIONS_FOR_GRADE || measuredWeight === 0) {
    return {
      ...base,
      compositeScore: null,
      uncappedGrade: null,
      grade: null,
      gradeCapReason: [],
      eligibility: null,
      unavailableReason:
        `Only ${measured.length} of ${raw.length} scoring dimensions could be measured; `
        + `at least ${MIN_DIMENSIONS_FOR_GRADE} are required before a grade is stated.`,
    };
  }

  const compositeScore = Math.round(
    measured.reduce((s, d) => s + (d.score as number) * (COMPOSITE_WEIGHTS[d.key] / measuredWeight), 0),
  );

  const eligibility = applyEligibility({ compositeScore, growth, overallCoverage: evidenceCoverage });

  return {
    ...base,
    compositeScore,
    uncappedGrade: eligibility.scoreGrade,
    grade: eligibility.grade,
    gradeCapReason: eligibility.reasons,
    eligibility,
    // Rebuild the statement with the real eligibility, so the cap it explains
    // is the cap that was applied rather than a placeholder.
    evidenceStatement: buildEvidenceStatement({
      growth, demand, yieldResult, eligibility, evidence: input.evidence, audience,
    }),
    unavailableReason: null,
  };
}
