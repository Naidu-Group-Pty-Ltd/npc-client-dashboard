/**
 * ME-8 — Scoring V2 as the production grade engine.
 *
 * ## The decision this records
 *
 * On 15 September 2026 the platform owner instructed that the grading system
 * be rectified: every new report was reading "Grade withheld — no scoring
 * system is currently authorised to issue an overall grade", because
 * `PRODUCTION_SCORING_AUTHORITY` was `unavailable` (V1 is not trusted to
 * grade) and Scoring V2 was frozen but never wired. This module is the
 * activation: the frozen engine (`shadowScorer.pure.ts`) is the one that
 * scores a new property report, and its result is projected onto the record
 * every reader already understands.
 *
 * `SCORING_V2_ACTIVATION` is the record of that decision. It is a constant
 * rather than configuration because activating an engine is a decision with a
 * review behind it — the same reason `PRODUCTION_SCORING_AUTHORITY` was — and
 * an environment variable is not that decision.
 *
 * ## What activation does NOT change
 *
 * **Nothing about the methodology.** Weights, anchors, eligibility ceilings
 * and the missing-data contract are the frozen engine's, untouched and still
 * pinned by `scoringMethodology.spec.ts`. Activation wires the engine; it
 * does not tune it.
 *
 * **Nothing about what may count.** The forward-only input policy still rules
 * on Location: its three inputs are `requires_repair` and count only when
 * declared verified for the run. Since IPV 1.1.0 (16 Sep 2026) that
 * declaration is DERIVED by the scoring service from the enrichment's own
 * RF-7.2B acquisition stamp — subject-matched, stage-proven readings verify
 * (`locationInputVerification.pure.ts`); a stampless legacy enrichment
 * verifies nothing, and Location then stays null and disclosed exactly as
 * before, with regeneration (which re-acquires with a stamp) as the remedy.
 *
 * **Nothing stored.** No historical row is recomputed. A score issued under V1
 * keeps its stamp; a withholding keeps its stamp; the next run of a report is
 * the first to carry `authority: 'v2'`.
 *
 * ## The one rule activation adds: Growth is required
 *
 * The engine's own floor is three measured dimensions. On the evidence this
 * deployment holds today, three can be reached WITHOUT Growth — Yield (the
 * record's own rent and price), Demand (Domain's market readings plus the
 * ABS population series) and, once repaired, Location. A grade formed that
 * way would answer to the delivered-points ceiling: with Growth's 40 points
 * unmeasured the best deliverable is 60 of 100, so the printed grade would be
 * a B at most and typically a C — **a letter that is a statement about
 * missing data wearing the shape of a statement about the property.** That is
 * exactly the reading a client cannot tell apart from a poor property.
 *
 * So `requiredDimensions` names Growth. Where it is unmeasured the grade is
 * withheld and the gap is named — which market, which provider, why. The
 * owner may relax this condition by editing the activation record; nothing
 * else in the pipeline assumes it.
 *
 * ## Absence is named, never hidden
 *
 * A withheld grade used to say only "insufficient verified evidence". Here it
 * carries `gradeGaps`: one entry per unmeasured dimension, with the client
 * sentence (`NOT_ASSESSED_REASON`, no codebase vocabulary), the operator
 * detail (the provider's refusal, the missing postcode, the unrepaired
 * inputs) and the remedy. The Generated Reports card and the report page
 * render the same list, so an operator asking "why is there no grade" is
 * told what would change it.
 *
 * Pure: no HTTP, no clock beyond the injected `now`, Deno-parseable. The only
 * production entrypoint that may import it is `investment-scoring-service`,
 * asserted by the pin spec.
 */

import {
  type EvidenceKey,
  type EvidencePoint,
  type EvidenceProvider,
  type EvidenceSubject,
  type MarketEvidence,
  emptyEvidence,
  mayReachClientReport,
} from './marketEvidence.pure.ts';
import {
  MIN_DIMENSIONS_FOR_GRADE,
  SHADOW_METHODOLOGY_VERSION,
  scoreInvestmentV2,
  type DimensionKey,
  type ShadowScoreInput,
  type ShadowScoreResult,
} from './shadowScorer.pure.ts';
import { buildScoreOutput, type ScoreOutput } from './scoreOutputContract.pure.ts';
import { buildEvidenceStatement, type EvidenceStatement } from './evidenceStatement.pure.ts';
import { applyEligibility } from './gradeEligibility.pure.ts';
import {
  admissibleInputs,
  claimPermits,
  NOT_ASSESSED_REASON,
  OVERALL_GRADE_UNAVAILABLE,
  SCORING_INPUT_POLICY_VERSION,
  type ScoredDimension,
} from './scoringInputPolicy.pure.ts';
import { dwellingTypeFor } from './domainEvidence.pure.ts';

export { dwellingTypeFor };

/** Bumped whenever the projection or the activation conditions change. */
export const SCORING_V2_PRODUCTION_VERSION = '1.1.0';

/**
 * The activation record. Editing it is the decision; nothing reads an
 * environment variable for any of this.
 */
export const SCORING_V2_ACTIVATION = {
  approved: true,
  approvedOn: '2026-09-15',
  reference: 'ME-8',
  decidedBy: 'platform owner instruction, 15 September 2026 — "rectify the grading system … execute accordingly"',
  methodologyVersion: SHADOW_METHODOLOGY_VERSION,
  /** The engine's own floor, restated so the record is self-describing. */
  minDimensions: MIN_DIMENSIONS_FOR_GRADE,
  /**
   * Dimensions that must be measured before a grade is issued, over and above
   * the floor. See the header: without Growth the best deliverable grade is a
   * statement about missing data.
   */
  requiredDimensions: ['growth'] as ReadonlyArray<DimensionKey>,
} as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ProductionPropertyInput {
  /** Purchase price, dollars. The yield basis. */
  price: number | null;
  /** Weekly rent actually established for this property, or null. Never a guess. */
  weeklyRent: number | null;
  /** Annual outgoings where known; null otherwise. */
  annualOutgoings?: number | null;
  /** The stored property type. Selects the Risk schema; never scored. */
  propertyType: string | null;
}

export interface ProductionFinanceInput {
  lvr: number | null;
  weeklyCashFlow: number | null;
}

/**
 * Location inputs as the record presents them. They are admitted only when
 * named in `verifiedInputs` — the forward-only policy's rule, unchanged.
 */
export interface ProductionLocationInput {
  walkScore?: number | null;
  commuteTimeCBD?: number | null;
  schoolsNearby?: number | null;
}

/** The market evidence a caller assembled from its adapters. */
export interface ProductionMarketEvidence {
  points: Partial<Pick<MarketEvidence, EvidenceKey>>;
  providersConsulted: ReadonlyArray<EvidenceProvider>;
  providersUnavailable: ReadonlyArray<{ provider: EvidenceProvider; reason: string }>;
}

export interface ProductionScoringInput {
  subject: EvidenceSubject;
  market: ProductionMarketEvidence;
  property: ProductionPropertyInput;
  finance: ProductionFinanceInput;
  location?: ProductionLocationInput;
  /** Inputs declared verified for this run, in the policy's vocabulary. */
  verifiedInputs?: ReadonlyArray<string>;
  /**
   * Why no market evidence could be sought at all — no trusted geography, no
   * postcode. Named so the gap can say so rather than "provider unavailable".
   */
  evidenceWithheldReason?: string | null;
  now: Date;
}

// ---------------------------------------------------------------------------
// Output — the record every reader already understands
// ---------------------------------------------------------------------------

/** The stamp a V2 run writes. Shape-compatible with the legacy stamp, authority `v2`. */
export interface ScoringV2PolicyStamp {
  scoringSystem: 'scoring-v2';
  inputPolicyVersion: string;
  methodologyVersion: string;
  authority: 'v2';
  dimensionScoresAuthoritative: true;
  gradeIssued: boolean;
  eligibility: 'issued' | 'insufficient_verified_evidence';
  measuredDimensions: ScoredDimension[];
  evaluatedAt: string;
  activation: { reference: string; approvedOn: string; productionVersion: string };
}

/** One named reason the grade was withheld, or a dimension was not assessed. */
export interface GradeGap {
  dimension: ScoredDimension;
  /** The client sentence. No codebase vocabulary. */
  reason: string;
  /** The operator detail: which provider, which refusal, which input. */
  detail: string;
  /** What would close the gap. */
  remedy: string;
  /** True when this gap alone withholds the grade. */
  withholdsGrade: boolean;
}

export interface ProductionDimensionScore {
  score: number;
  weight: number;
  details: string;
  hasData: boolean;
  dataPoints: string[];
  excluded: boolean;
}

export type ProductionBreakdownKey =
  | 'yieldScore' | 'growthScore' | 'locationScore' | 'demandScore' | 'riskScore';

export interface ProductionScoreRecord {
  totalScore: number | null;
  grade: string | null;
  recommendation: string;
  breakdown: Record<ProductionBreakdownKey, ProductionDimensionScore>;
  coverage: {
    dimensionsScored: number;
    totalDimensions: number;
    coverageRatio: number;
    weightCovered: number;
    dataInsufficient: boolean;
    partialLabel: string;
    cotalityReady: true;
  };
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  risks: string[];
  policy: ScoringV2PolicyStamp;
  /** The client-facing statement where no grade is issued; null when one is. */
  evidenceStatement: { heading: string; value: string; explanation: string } | null;
  /** Per-dimension reason, in the client's words, for each dimension not assessed. */
  notAssessed: Record<string, string>;
  /** What the record offered before the engine ruled, for the audit trail. */
  dataPointsPresented: Record<string, string[]>;
  /** Every gap, named. Empty when every dimension measured. */
  gradeGaps: GradeGap[];
  /** The engine's own canonical output, for the audit trail and the assessment page. */
  v2: ScoreOutput & {
    productionVersion: string;
    activation: typeof SCORING_V2_ACTIVATION;
    /** The statement with every source named, for an internal reader. */
    internalEvidenceStatement: EvidenceStatement;
    /** Dimensions whose figures may not be printed to a client under their licence. */
    renderRestricted: { growth: boolean; demand: boolean };
    /** Why the grade was withheld although the engine formed a composite, or null. */
    withheldBy: 'engine_floor' | 'required_dimension' | null;
  };
}

// ---------------------------------------------------------------------------
// Vocabulary bridges
// ---------------------------------------------------------------------------

const BREAKDOWN_KEY: Readonly<Record<DimensionKey, ProductionBreakdownKey>> = {
  yield: 'yieldScore',
  growth: 'growthScore',
  location: 'locationScore',
  demand: 'demandScore',
  risk: 'riskScore',
};

/** Evidence keys as the input policy names them, so `claimPermits` can rule on them. */
const POLICY_INPUT_FOR_EVIDENCE: Readonly<Partial<Record<EvidenceKey, string>>> = {
  growth1Year: 'priceGrowth1Year',
  growth3YearCagr: 'priceGrowth3Year',
  populationGrowth: 'populationGrowth',
  vacancyRate: 'vacancyRate',
  daysOnMarket: 'daysOnMarket',
  medianPrice: 'medianSuburbPrice',
};

/**
 * The recommendation a grade carries. The sentences are the ones V1 printed
 * for years, keyed on the LETTER rather than on V1's score bands, so a
 * document's vocabulary does not change with the engine behind it.
 */
export const RECOMMENDATION_BY_GRADE: Readonly<Record<string, string>> = {
  'A+': 'STRONG BUY - Excellent investment opportunity with strong fundamentals across all metrics',
  'A': 'BUY - Very good investment with solid potential for both income and capital growth',
  'B+': 'BUY - Good investment opportunity with favorable metrics in most areas',
  'B': 'HOLD/BUY - Moderate investment potential, consider your personal circumstances',
  'C+': 'HOLD - Above average investment with some positive indicators, monitor closely',
  'C': 'HOLD - Average investment with mixed indicators, monitor market conditions',
  'D': 'CAUTION - Below average investment, significant concerns identified',
  'F': 'AVOID - Poor investment opportunity with multiple red flags',
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The evidence bundle the engine reads, from the caller's adapters. */
export function assembleEvidence(subject: EvidenceSubject, market: ProductionMarketEvidence): MarketEvidence {
  const ev = emptyEvidence(subject) as MarketEvidence & Record<string, unknown>;
  for (const [key, point] of Object.entries(market.points)) {
    if (point && typeof point === 'object' && 'value' in point) ev[key] = point;
  }
  ev.providersConsulted = [...market.providersConsulted];
  ev.providersUnavailable = market.providersUnavailable.map((u) => ({ ...u }));
  return ev as MarketEvidence;
}

/** The engine input, with the policy ruling on Location's inputs. */
export function assembleEngineInput(input: ProductionScoringInput): ShadowScoreInput {
  const evidence = assembleEvidence(input.subject, input.market);
  const verified = input.verifiedInputs ?? [];
  const presentedLocation: string[] = [];
  const loc = input.location ?? {};
  if (num(loc.walkScore) !== null) presentedLocation.push('walkScore');
  if (num(loc.commuteTimeCBD) !== null) presentedLocation.push('commuteTimeCBD');
  if (num(loc.schoolsNearby) !== null) presentedLocation.push('schoolsNearby');
  const admittedLocation = new Set(admissibleInputs('location', presentedLocation, verified));

  return {
    evidence,
    yieldInputs: {
      basisAmount: input.property.price,
      basis: 'purchase',
      weeklyRent: input.property.weeklyRent,
      annualOutgoings: input.property.annualOutgoings ?? null,
      weeklyCashFlow: input.finance.weeklyCashFlow,
    },
    locationInputs: {
      walkScore: admittedLocation.has('walkScore') ? loc.walkScore : null,
      commuteTimeCBD: admittedLocation.has('commuteTimeCBD') ? loc.commuteTimeCBD : null,
      schoolsNearby: admittedLocation.has('schoolsNearby') ? loc.schoolsNearby : null,
    },
    propertyRisk: {
      propertyType: input.property.propertyType,
      answers: {},
      growth1Year: evidence.growth1Year?.value ?? null,
    },
    finance: {
      lvr: input.finance.lvr,
      weeklyCashFlow: input.finance.weeklyCashFlow,
      purchasePrice: input.property.price,
    },
    audience: 'client',
    now: input.now,
  };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

function providerClause(market: ProductionMarketEvidence, evidenceWithheldReason: string | null | undefined): string {
  if (evidenceWithheldReason) return evidenceWithheldReason;
  if (market.providersUnavailable.length) {
    return market.providersUnavailable.map((u) => `${u.provider}: ${u.reason}`).join('; ');
  }
  if (!market.providersConsulted.length) return 'no market-evidence provider was consulted';
  return `consulted ${market.providersConsulted.join(', ')}; the series carried no usable reading`;
}

/** The gaps, one per unmeasured dimension, with the operator detail and the remedy. */
export function describeGaps(
  input: ProductionScoringInput,
  result: ShadowScoreResult,
  withheldBy: ProductionScoreRecord['v2']['withheldBy'],
): GradeGap[] {
  const gaps: GradeGap[] = [];
  const required = new Set<DimensionKey>(SCORING_V2_ACTIVATION.requiredDimensions);
  for (const key of result.unavailable) {
    const dimension = key as ScoredDimension;
    let detail: string;
    let remedy: string;
    switch (key) {
      case 'growth':
        detail = `No suburb capital-growth series for ${subjectLabel(input.subject)} (${providerClause(input.market, input.evidenceWithheldReason)}).`;
        remedy = 'The open-data sales register for the property\'s local government area (QLD) or postcode (NSW), loaded by market-sales-ingest (docs/reports/OPEN_DATA_GROWTH_EVIDENCE.md); a Domain suburb-performance series for the trusted suburb and postcode (docs/integrations/DOMAIN_ACTIVATION_REQUEST.md); or a licensed export ingested through evidenceIngestion.';
        break;
      case 'demand':
        detail = `No demand reading for ${subjectLabel(input.subject)} (${providerClause(input.market, input.evidenceWithheldReason)}).`;
        remedy = 'Domain days-on-market, sales and listing counts for the suburb, or the ABS population series for the property\'s SA2.';
        break;
      case 'yield':
        detail = input.property.weeklyRent === null || input.property.weeklyRent <= 0
          ? 'No weekly rent is established for this property.'
          : 'No purchase price is established for this property.';
        remedy = 'A recorded rent (rental evidence) and purchase price on the report.';
        break;
      case 'location': {
        const presentedLoc = presentedFor('location', input);
        const verifiedLoc = input.verifiedInputs ?? [];
        detail = presentedLoc.length === 0
          ? 'No location readings (walk score, commute, schools) were presented for this run.'
          : `Location readings were presented (${presentedLoc.join(', ')}) but not verified: the `
            + 'enrichment carries no subject-matched RF-7.2B acquisition stamp for them '
            + `(${verifiedLoc.length ? `only ${verifiedLoc.join(', ')} verified` : 'none verified'}; `
            + 'locationInputVerification.pure.ts).';
        remedy = 'Regenerate the report: the location service re-acquires the enrichment with its '
          + 'acquisition stamp (RF-7.2B), and stamped, stage-proven readings verify automatically.';
        break;
      }
      case 'risk':
        detail = result.risk.eligibility.reason;
        remedy = 'Answered property-risk questions from the per-class schema (hazard, planning, condition, strata).';
        break;
      default:
        detail = 'Not measured.';
        remedy = 'Supply the dimension\'s evidence.';
    }
    gaps.push({
      dimension,
      reason: NOT_ASSESSED_REASON[dimension],
      detail,
      remedy,
      withholdsGrade: withheldBy === 'required_dimension' ? required.has(key) : withheldBy === 'engine_floor',
    });
  }
  return gaps;
}

function subjectLabel(subject: EvidenceSubject): string {
  const parts = [subject.suburb, subject.state, subject.postcode].filter((p): p is string => !!p);
  return parts.length ? parts.join(' ') : 'this market';
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function dimensionDetails(key: DimensionKey, r: ShadowScoreResult, out: ScoreOutput): string {
  const reading = out.dimensions.find((d) => d.key === key)!;
  if (!reading.available) return reading.reason;
  switch (key) {
    case 'growth':
      return r.growth.components.map((c) => `${labelOfComponent(c.key)}: ${c.detail}`).join('. ') || reading.reason;
    case 'demand':
      return r.demand.components.map((c) => `${labelOfComponent(c.key)}: ${c.detail}`).join('. ') || reading.reason;
    case 'yield':
      return `${r.yieldResult.label}: ${r.yieldResult.detail}`;
    case 'location':
      return r.location.components.map((c) => c.detail).join('. ') || reading.reason;
    case 'risk':
      return reading.reason;
  }
}

const COMPONENT_LABELS: Readonly<Record<string, string>> = {
  longTerm: 'Five-year capital growth',
  trajectory: 'Three-year against five-year trajectory',
  momentum: 'Twelve-month movement',
  consistency: 'Consistency of growth',
  relative: 'Performance against the wider market',
  rentalTightness: 'Rental vacancy',
  saleUrgency: 'Competition for stock',
  absorption: 'Sales against stock advertised',
  populationDriver: 'Population growth',
};
const labelOfComponent = (key: string): string => COMPONENT_LABELS[key] ?? key;

function dataPointsFor(key: DimensionKey, r: ShadowScoreResult, input: ProductionScoringInput): string[] {
  switch (key) {
    case 'growth': return r.growth.components.map((c) => c.key);
    case 'demand': return r.demand.components.map((c) => c.key);
    case 'yield': return r.yieldResult.score === null ? [] : ['propertyPrice', 'weeklyRent'];
    case 'location': return r.location.components.map((c) => c.key);
    case 'risk': return r.risk.observations.map((o) => o.questionId);
  }
  return [];
}

function presentedFor(key: DimensionKey, input: ProductionScoringInput): string[] {
  const ev = input.market.points;
  switch (key) {
    case 'growth':
      return (['growth1Year', 'growth3YearCagr', 'growth5YearCagr', 'growth10YearCagr', 'priceSeries'] as const)
        .filter((k) => ev[k]);
    case 'demand':
      return (['vacancyRate', 'daysOnMarket', 'vendorDiscount', 'auctionClearanceRate', 'salesCount', 'listingActivity', 'populationGrowth'] as const)
        .filter((k) => ev[k]);
    case 'yield': {
      const out: string[] = [];
      if ((input.property.price ?? 0) > 0) out.push('propertyPrice');
      if ((input.property.weeklyRent ?? 0) > 0) out.push('weeklyRent');
      return out;
    }
    case 'location': {
      const out: string[] = [];
      if (num(input.location?.walkScore) !== null) out.push('walkScore');
      if (num(input.location?.commuteTimeCBD) !== null) out.push('commuteTimeCBD');
      if (num(input.location?.schoolsNearby) !== null) out.push('schoolsNearby');
      return out;
    }
    case 'risk':
      return input.property.propertyType ? ['propertyType'] : [];
  }
  return [];
}

/**
 * The qualitative reading, every claim gated by `claimPermits` exactly as the
 * legacy service gates its own — a sentence is an assessment.
 */
function swot(
  r: ShadowScoreResult,
  input: ProductionScoringInput,
  measured: ScoredDimension[],
): Pick<ProductionScoreRecord, 'strengths' | 'weaknesses' | 'opportunities' | 'risks'> {
  const admitted = Object.entries(POLICY_INPUT_FOR_EVIDENCE)
    .filter(([evidenceKey]) => input.market.points[evidenceKey as EvidenceKey])
    .map(([, policyInput]) => policyInput as string);
  const permits = claimPermits({ authority: 'v2', measuredDimensions: measured, admittedInputs: admitted });
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const opportunities: string[] = [];
  const risks: string[] = [];
  const score = (k: DimensionKey) => r.dimensions.find((d) => d.key === k)?.score ?? null;

  const g = score('growth');
  if (permits.fromDimensionScore('growth') && g !== null) {
    if (g >= 70) strengths.push('Measured capital growth in this suburb is strong');
    else if (g < 45) weaknesses.push('Measured capital growth in this suburb has been limited');
  }
  const y = score('yield');
  if (permits.fromDimensionScore('yield') && y !== null) {
    if (y >= 70) strengths.push('Strong rental yield providing good cash flow');
    else if (y < 40) weaknesses.push('Below average rental yield may require owner contribution');
  }
  const d = score('demand');
  if (permits.fromDimensionScore('demand') && d !== null) {
    if (d >= 70) strengths.push('Measured demand in this market is strong');
    else if (d < 40) weaknesses.push('Measured demand in this market is soft');
  }
  const l = score('location');
  if (permits.fromDimensionScore('location') && l !== null && l >= 70) {
    strengths.push('Excellent location with strong amenities');
  }

  const pop = input.market.points.populationGrowth?.value;
  if (permits.fromInput('populationGrowth') && typeof pop === 'number' && pop > 2) {
    opportunities.push('Strong population growth driving future demand');
  }
  const median = input.market.points.medianPrice?.value;
  if (permits.fromInput('medianSuburbPrice') && typeof median === 'number' && median > 0
    && (input.property.price ?? 0) > 0 && (input.property.price as number) < median * 0.9) {
    opportunities.push('Priced below suburb median - potential for value appreciation');
  }
  const g1 = input.market.points.growth1Year?.value;
  if (permits.fromInput('priceGrowth1Year') && typeof g1 === 'number' && g1 > 15) {
    risks.push('Rapid recent price growth may indicate market cooling ahead');
  }
  const dom = input.market.points.daysOnMarket?.value;
  if (permits.fromInput('daysOnMarket') && typeof dom === 'number' && dom > 80) {
    risks.push('Extended selling times may indicate softer market');
  }
  const vac = input.market.points.vacancyRate?.value;
  if (permits.fromInput('vacancyRate') && typeof vac === 'number' && vac > 4) {
    weaknesses.push('Higher than ideal vacancy rate in the area');
  }
  return { strengths, weaknesses, opportunities, risks };
}

/**
 * Score a property for production.
 *
 * Runs the frozen engine once, decides whether the grade may be ISSUED under
 * the activation record, and projects the result onto the V1-compatible
 * record with a `v2` stamp. Deterministic for a given `now`.
 */
export function scoreForProduction(input: ProductionScoringInput): ProductionScoreRecord {
  const engineInput = assembleEngineInput(input);
  const result = scoreInvestmentV2(engineInput);
  const out = buildScoreOutput(result, engineInput.evidence);

  const measured = result.measured.map((k) => k as ScoredDimension);
  const requiredMissing = SCORING_V2_ACTIVATION.requiredDimensions
    .filter((k) => !result.measured.includes(k));
  const withheldBy: ProductionScoreRecord['v2']['withheldBy'] = result.grade === null
    ? 'engine_floor'
    : requiredMissing.length ? 'required_dimension' : null;
  const gradeIssued = withheldBy === null && result.grade !== null && result.compositeScore !== null;

  const stamp: ScoringV2PolicyStamp = {
    scoringSystem: 'scoring-v2',
    inputPolicyVersion: SCORING_INPUT_POLICY_VERSION,
    methodologyVersion: result.methodologyVersion,
    authority: 'v2',
    dimensionScoresAuthoritative: true,
    gradeIssued,
    eligibility: gradeIssued ? 'issued' : 'insufficient_verified_evidence',
    measuredDimensions: measured,
    evaluatedAt: input.now.toISOString(),
    activation: {
      reference: SCORING_V2_ACTIVATION.reference,
      approvedOn: SCORING_V2_ACTIVATION.approvedOn,
      productionVersion: SCORING_V2_PRODUCTION_VERSION,
    },
  };

  const breakdown = {} as Record<ProductionBreakdownKey, ProductionDimensionScore>;
  for (const d of out.dimensions) {
    breakdown[BREAKDOWN_KEY[d.key]] = {
      score: d.performance ?? 0,
      weight: gradeIssued ? Math.round(d.effectiveWeight * 100) : 0,
      details: dimensionDetails(d.key, result, out),
      hasData: d.available,
      dataPoints: dataPointsFor(d.key, result, input),
      excluded: !d.available,
    };
  }

  const gaps = describeGaps(input, result, withheldBy);
  const notAssessed: Record<string, string> = {};
  for (const gap of gaps) notAssessed[gap.dimension] = gap.reason;

  const dataPointsPresented: Record<string, string[]> = {};
  for (const key of ['yield', 'growth', 'location', 'demand', 'risk'] as const) {
    dataPointsPresented[BREAKDOWN_KEY[key]] = presentedFor(key, input);
  }

  const weightCovered = Number(out.dimensions
    .filter((d) => d.available)
    .reduce((s, d) => s + d.nominalWeight, 0).toFixed(2));
  const total = out.dimensions.length;
  const partialLabel = !gradeIssued
    ? withheldBy === 'required_dimension'
      ? `Grade withheld — ${requiredMissing.join(', ')} not measured (${measured.length} of ${total} dimensions measured)`
      : `Insufficient evidence — qualitative review only (${measured.length} of ${total} dimensions)`
    : measured.length === total
      ? `Full coverage (${total} of ${total} dimensions)`
      : `Partial score: ${measured.length} of ${total} dimensions`;

  const internalEvidenceStatement = buildEvidenceStatement({
    growth: result.growth,
    demand: result.demand,
    yieldResult: result.yieldResult,
    eligibility: result.eligibility ?? applyEligibility({
      compositeScore: 0,
      growth: result.growth,
      overallCoverage: result.evidenceCoverage,
      nominalMeasuredScore: result.nominalMeasuredScore,
    }),
    evidence: engineInput.evidence,
    audience: 'internal',
  });

  const grade = gradeIssued ? result.grade : null;
  return {
    totalScore: gradeIssued ? result.compositeScore : null,
    grade,
    recommendation: grade
      ? (RECOMMENDATION_BY_GRADE[grade] ?? OVERALL_GRADE_UNAVAILABLE.explanation)
      : OVERALL_GRADE_UNAVAILABLE.explanation,
    breakdown,
    coverage: {
      dimensionsScored: measured.length,
      totalDimensions: total,
      coverageRatio: Number((measured.length / total).toFixed(2)),
      weightCovered,
      dataInsufficient: !gradeIssued,
      partialLabel,
      cotalityReady: true,
    },
    ...swot(result, input, measured),
    policy: stamp,
    evidenceStatement: gradeIssued
      ? null
      : {
          heading: OVERALL_GRADE_UNAVAILABLE.heading,
          value: OVERALL_GRADE_UNAVAILABLE.value,
          explanation: OVERALL_GRADE_UNAVAILABLE.explanation,
        },
    notAssessed,
    dataPointsPresented,
    gradeGaps: gaps,
    v2: {
      ...out,
      productionVersion: SCORING_V2_PRODUCTION_VERSION,
      activation: SCORING_V2_ACTIVATION,
      internalEvidenceStatement,
      renderRestricted: {
        growth: result.growth.renderRestricted,
        demand: result.demand.renderRestricted,
      },
      withheldBy,
    },
  };
}

/** Points on a bundle a client document may print, for a renderer that lists figures. */
export function clientPrintablePoints(ev: MarketEvidence): EvidenceKey[] {
  const out: EvidenceKey[] = [];
  for (const [key, v] of Object.entries(ev)) {
    if (v && typeof v === 'object' && 'value' in (v as object) && mayReachClientReport(v as EvidencePoint<unknown>)) {
      out.push(key as EvidenceKey);
    }
  }
  return out;
}
