/**
 * ME-8 — Scoring V2 as the production grade engine.
 *
 * What this pins that the engine's own suites do not: the ACTIVATION record
 * and the projection onto the record every reader already understands. The
 * engine's arithmetic is the closure suite's business; this file asserts that
 * a grade the engine forms reaches the record with a `v2` stamp, that a grade
 * it cannot form is withheld with its gaps NAMED, that Growth is required
 * before a grade is issued, that the input policy still refuses the unrepaired
 * Location inputs, and that every frontend and document reader resolves the
 * stamp the way the activation intends.
 */
import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_BY_GRADE,
  SCORING_V2_ACTIVATION,
  SCORING_V2_PRODUCTION_VERSION,
  assembleEngineInput,
  scoreForProduction,
  type ProductionScoringInput,
} from '../market/scoringV2Production.pure';
import { SHADOW_METHODOLOGY_VERSION, SCORING_V2_METHODOLOGY_VERSION } from '../market/shadowScorer.pure';
import {
  NOT_ASSESSED_REASON,
  OVERALL_GRADE_UNAVAILABLE,
  authorityOf,
  mayPublishOverallGrade,
} from '../market/scoringInputPolicy.pure';
import type { EvidencePoint, EvidenceSubject, MarketEvidence } from '../market/marketEvidence.pure';
import { gradedLine, publishableGrade } from '../investment/scoreSections.pure';
import { getInvestmentScoreSummary, readGradePolicy, resolveInvestmentGrade } from '@/components/reports/report-view/utils';
import { buildReportFactContract } from '../contract/reportFactContract.pure';

const NOW = new Date('2026-09-15T10:00:00Z');

const subject = (over: Partial<EvidenceSubject> = {}): EvidenceSubject => ({
  suburb: 'Kellyville', postcode: '2155', state: 'NSW',
  dwellingType: 'house', resolvedFrom: 'coordinate', ...over,
});

const pt = (value: number, o: Partial<EvidencePoint> = {}): EvidencePoint => ({
  value, level: 'suburb', areaName: 'Kellyville NSW 2155', dwellingType: 'house',
  dwellingTypeMatched: true, provider: 'domain', asOf: '2026-06-01',
  sampleSize: 140, periodsAvailable: 12, method: 'observed',
  licensingStatus: 'unverified', acquisition: 'existing_licensed', sourceNote: null, ...o,
});

const series = (rate: number, years = 12): EvidencePoint<ReadonlyArray<{ period: string; value: number }>> => {
  let v = 900_000;
  const out: Array<{ period: string; value: number }> = [];
  for (let i = 0; i < years; i += 1) {
    out.push({ period: `${2015 + i}-06`, value: Math.round(v) });
    v *= 1 + rate / 100;
  }
  return { ...pt(0), value: out } as EvidencePoint<ReadonlyArray<{ period: string; value: number }>>;
};

/** A Domain series worth of growth evidence, as `domainEvidencePoints` would extract it. */
const growthPoints = (rate: number): Partial<Pick<MarketEvidence, 'growth1Year' | 'growth3YearCagr' | 'growth5YearCagr' | 'growth10YearCagr' | 'priceSeries' | 'medianPrice'>> => ({
  medianPrice: pt(1_650_000),
  growth1Year: pt(rate + 0.6, { method: 'calculated' }),
  growth3YearCagr: pt(rate + 0.2, { method: 'calculated' }),
  growth5YearCagr: pt(rate, { method: 'calculated' }),
  growth10YearCagr: pt(rate - 0.3, { method: 'calculated' }),
  priceSeries: series(rate),
});

const demandPoints = () => ({
  daysOnMarket: pt(31),
  salesCount: pt(140),
  listingActivity: pt(210),
  populationGrowth: pt(2.4, {
    provider: 'abs_erp', level: 'sa2', areaName: 'Kellyville - South', dwellingType: 'any',
    method: 'calculated', licensingStatus: 'open', acquisition: 'open_public', asOf: '2025-06-30',
    sampleSize: null, periodsAvailable: 11,
  }),
});

const base = (over: Partial<ProductionScoringInput> = {}): ProductionScoringInput => ({
  subject: subject(),
  market: {
    points: { ...growthPoints(6.1), ...demandPoints() },
    providersConsulted: ['domain', 'abs_erp'],
    providersUnavailable: [],
  },
  property: { price: 1_650_000, weeklyRent: 1_000, propertyType: 'House' },
  finance: { lvr: 80, weeklyCashFlow: -420 },
  now: NOW,
  ...over,
});

describe('the activation record', () => {
  it('is approved, dated, referenced, and requires Growth', () => {
    expect(SCORING_V2_ACTIVATION.approved).toBe(true);
    expect(SCORING_V2_ACTIVATION.approvedOn).toBe('2026-09-15');
    expect(SCORING_V2_ACTIVATION.reference).toBe('ME-8');
    expect(SCORING_V2_ACTIVATION.requiredDimensions).toContain('growth');
    expect(SCORING_V2_ACTIVATION.minDimensions).toBe(3);
  });

  it('the composition version dropped its shadow suffix and is the one the record names', () => {
    expect(SHADOW_METHODOLOGY_VERSION).toBe('2.1.0');
    expect(SCORING_V2_METHODOLOGY_VERSION).toBe(SHADOW_METHODOLOGY_VERSION);
    expect(SCORING_V2_ACTIVATION.methodologyVersion).toBe('2.1.0');
  });
});

describe('a graded property — measured Growth, Demand and Yield', () => {
  const record = scoreForProduction(base());

  it('issues a grade under a v2 stamp the existing readers recognise', () => {
    expect(record.policy.scoringSystem).toBe('scoring-v2');
    expect(record.policy.authority).toBe('v2');
    expect(record.policy.gradeIssued).toBe(true);
    expect(record.policy.eligibility).toBe('issued');
    expect(record.policy.dimensionScoresAuthoritative).toBe(true);
    expect(record.policy.methodologyVersion).toBe('2.1.0');
    expect(record.policy.activation).toEqual({ reference: 'ME-8', approvedOn: '2026-09-15', productionVersion: SCORING_V2_PRODUCTION_VERSION });
    expect(record.policy.measuredDimensions.sort()).toEqual(['demand', 'growth', 'yield']);
    expect(authorityOf(record)).toBe('v2');
    expect(mayPublishOverallGrade(authorityOf(record))).toBe(true);
  });

  it('carries a letter, a total and the recommendation keyed on the letter', () => {
    expect(record.grade).toMatch(/^(A\+|A|B\+|B|C\+|C|D|F)$/);
    expect(typeof record.totalScore).toBe('number');
    expect(record.totalScore).toBe(record.v2.score);
    expect(record.grade).toBe(record.v2.grade);
    expect(record.recommendation).toBe(RECOMMENDATION_BY_GRADE[record.grade as string]);
    expect(record.evidenceStatement).toBeNull();
    expect(record.coverage.dataInsufficient).toBe(false);
    expect(record.coverage.dimensionsScored).toBe(3);
    expect(record.coverage.totalDimensions).toBe(5);
    expect(record.v2.withheldBy).toBeNull();
  });

  it('projects the breakdown the way V1 wrote it — measured dimensions carry weight, unmeasured ones are excluded, never zero-scored as a claim', () => {
    const b = record.breakdown;
    expect(Object.keys(b).sort()).toEqual(['demandScore', 'growthScore', 'locationScore', 'riskScore', 'yieldScore']);
    expect(b.growthScore.hasData).toBe(true);
    expect(b.growthScore.excluded).toBe(false);
    expect(b.growthScore.weight).toBeGreaterThan(0);
    expect(b.locationScore.hasData).toBe(false);
    expect(b.locationScore.excluded).toBe(true);
    expect(b.locationScore.weight).toBe(0);
    expect(b.riskScore.excluded).toBe(true);
    const weights = Object.values(b).reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(weights - 100)).toBeLessThanOrEqual(2); // rounded effective weights
    expect(b.growthScore.details).toMatch(/Five-year capital growth/);
    expect(b.yieldScore.details).toMatch(/yield/i);
  });

  it('names the dimensions it did NOT measure as gaps that do not withhold the grade', () => {
    expect(record.gradeGaps.map((g) => g.dimension).sort()).toEqual(['location', 'risk']);
    for (const gap of record.gradeGaps) {
      expect(gap.withholdsGrade).toBe(false);
      expect(gap.reason).toBe(NOT_ASSESSED_REASON[gap.dimension]);
      expect(gap.remedy.length).toBeGreaterThan(10);
    }
    expect(record.notAssessed).toEqual({ location: NOT_ASSESSED_REASON.location, risk: NOT_ASSESSED_REASON.risk });
  });

  it('is what the document and the page draw as an issued grade', () => {
    expect(publishableGrade(record)).toBe(record.grade);
    expect(gradedLine(record)).toMatch(new RegExp(`^Graded ${record.grade!.replace('+', '\\+')} at ${record.totalScore} out of 100`));
    const summary = getInvestmentScoreSummary({ investment_score: record } as never);
    expect(summary.grade).toBe(record.grade);
    expect(summary.score).toBe(record.totalScore);
    expect(summary.withheld).toBeNull();
    const resolved = resolveInvestmentGrade([{ id: 'r1', created_at: NOW.toISOString(), status: 'completed', investment_score: record } as never]);
    expect(resolved.status).toBe('calculated');
    expect(resolved.grade).toBe(record.grade);
  });

  it('the report fact contract reads the grade as issued under v2', () => {
    const facts = buildReportFactContract({ report: { investment_score: record }, observedAt: NOW });
    expect(facts.scoring.authority).toBe('v2');
    expect(facts.scoring.gradeIssued).toBe(true);
    expect(facts.scoring.dimensionScoresAuthoritative).toBe(true);
  });

  it('the client statement withholds unverified-licence provenance while the internal one names it', () => {
    const client = record.v2.evidenceStatement;
    const internal = record.v2.internalEvidenceStatement;
    expect(client.audience).toBe('client');
    expect(internal.audience).toBe('internal');
    const growthClient = client.dimensions.find((d) => d.key === 'growth')!;
    const growthInternal = internal.dimensions.find((d) => d.key === 'growth')!;
    expect(growthClient.measures.some((m) => m.provenanceWithheld)).toBe(true);
    expect(growthInternal.measures.every((m) => !m.provenanceWithheld)).toBe(true);
    expect(record.v2.renderRestricted.growth).toBe(true);
  });
});

describe('the withheld grade — the 291 Stone Mason Drive shape', () => {
  const record = scoreForProduction(base({
    market: {
      points: {},
      providersConsulted: ['domain'],
      providersUnavailable: [{ provider: 'domain', reason: 'HTTP 403 with no X-Domain-Security-Reason header — a scope, plan, environment or key restriction that Domain must identify' }],
    },
  }));

  it('withholds under the v2 authority for insufficient evidence, never "no authorised system"', () => {
    expect(record.policy.authority).toBe('v2');
    expect(record.policy.gradeIssued).toBe(false);
    expect(record.policy.eligibility).toBe('insufficient_verified_evidence');
    expect(record.grade).toBeNull();
    expect(record.totalScore).toBeNull();
    expect(record.recommendation).toBe(OVERALL_GRADE_UNAVAILABLE.explanation);
    expect(record.evidenceStatement).toEqual({
      heading: OVERALL_GRADE_UNAVAILABLE.heading,
      value: OVERALL_GRADE_UNAVAILABLE.value,
      explanation: OVERALL_GRADE_UNAVAILABLE.explanation,
    });
    expect(record.coverage.dataInsufficient).toBe(true);
    expect(record.coverage.dimensionsScored).toBe(1);
    expect(record.v2.withheldBy).toBe('engine_floor');
  });

  it('names every gap — which market, which provider, what it said', () => {
    const growth = record.gradeGaps.find((g) => g.dimension === 'growth')!;
    expect(growth.withholdsGrade).toBe(true);
    expect(growth.detail).toContain('Kellyville NSW 2155');
    expect(growth.detail).toContain('domain: HTTP 403');
    expect(growth.reason).toBe(NOT_ASSESSED_REASON.growth);
    expect(growth.remedy).toMatch(/DOMAIN_ACTIVATION_REQUEST/);
    expect(record.gradeGaps.map((g) => g.dimension).sort()).toEqual(['demand', 'growth', 'location', 'risk']);
  });

  it('is drawn as withheld, with the gaps, on the card and the page — and never as N/A', () => {
    const policy = readGradePolicy(record);
    expect(policy.issued).toBe(false);
    expect(policy.reason).toBe('insufficient_verified_evidence');
    expect(policy.gaps.some((g) => g.startsWith('growth: No suburb capital-growth series for Kellyville NSW 2155'))).toBe(true);
    const summary = getInvestmentScoreSummary({ investment_score: record } as never);
    expect(summary.grade).toBeNull();
    expect(summary.withheld?.statement).toMatch(/^Withheld by the scoring policy: insufficient verified property evidence\. 1 of 5 dimensions measured \(yield\)\. Not measured — growth: /);
    expect(summary.withheld?.statement).toContain('HTTP 403');
    expect(publishableGrade(record)).toBeUndefined();
    expect(gradedLine(record)).toBeUndefined();
  });

  it('says why nothing was sought when the geography never resolved', () => {
    const unresolved = scoreForProduction(base({
      subject: subject({ suburb: null, postcode: null, resolvedFrom: null }),
      market: { points: {}, providersConsulted: [], providersUnavailable: [] },
      evidenceWithheldReason: 'the property\'s geography did not resolve to a trusted suburb, state and postcode, so no suburb market evidence was sought',
    }));
    const growth = unresolved.gradeGaps.find((g) => g.dimension === 'growth')!;
    expect(growth.detail).toContain('did not resolve to a trusted suburb');
  });
});

describe('Growth is required before a grade is issued', () => {
  it('three measured dimensions without Growth withhold under the activation condition, with the reason named', () => {
    const record = scoreForProduction(base({
      market: { points: { ...demandPoints() }, providersConsulted: ['domain', 'abs_erp'], providersUnavailable: [{ provider: 'domain', reason: 'HTTP 404 — no suburb-performance series for that state, suburb and postcode' }] },
      location: { walkScore: 72, commuteTimeCBD: 38, schoolsNearby: 5 },
      verifiedInputs: ['walkScore', 'commuteTimeCBD', 'schoolsNearby'],
    }));
    expect(record.policy.measuredDimensions.sort()).toEqual(['demand', 'location', 'yield']);
    expect(record.v2.score).not.toBeNull(); // the engine formed a composite…
    expect(record.policy.gradeIssued).toBe(false); // …and the activation withholds it
    expect(record.v2.withheldBy).toBe('required_dimension');
    expect(record.totalScore).toBeNull();
    expect(record.grade).toBeNull();
    expect(record.coverage.partialLabel).toMatch(/^Grade withheld — growth not measured \(3 of 5 dimensions measured\)/);
    const growth = record.gradeGaps.find((g) => g.dimension === 'growth')!;
    expect(growth.withholdsGrade).toBe(true);
    const risk = record.gradeGaps.find((g) => g.dimension === 'risk')!;
    expect(risk.withholdsGrade).toBe(false);
  });
});

describe('the input policy still rules on Location', () => {
  it('refuses the unrepaired inputs unless declared verified', () => {
    const refused = assembleEngineInput(base({ location: { walkScore: 72, commuteTimeCBD: 38, schoolsNearby: 5 } }));
    expect(refused.locationInputs).toEqual({ walkScore: null, commuteTimeCBD: null, schoolsNearby: null });
    const admitted = assembleEngineInput(base({
      location: { walkScore: 72, commuteTimeCBD: 38, schoolsNearby: 5 },
      verifiedInputs: ['walkScore', 'schoolsNearby'],
    }));
    expect(admitted.locationInputs).toEqual({ walkScore: 72, commuteTimeCBD: null, schoolsNearby: 5 });
  });

  it('the yield basis is the purchase price, declared, and the buyer position reaches finance only', () => {
    const input = assembleEngineInput(base());
    expect(input.yieldInputs.basis).toBe('purchase');
    expect(input.yieldInputs.basisAmount).toBe(1_650_000);
    expect(input.finance).toEqual({ lvr: 80, weeklyCashFlow: -420, purchasePrice: 1_650_000 });
    expect(input.propertyRisk.answers).toEqual({});
    expect(input.audience).toBe('client');
  });
});

describe('invariants the activation must keep', () => {
  it('the buyer\'s leverage moves no property number', () => {
    const a = scoreForProduction(base({ finance: { lvr: 60, weeklyCashFlow: 120 } }));
    const b = scoreForProduction(base({ finance: { lvr: 95, weeklyCashFlow: -900 } }));
    expect(a.grade).toBe(b.grade);
    expect(a.totalScore).toBe(b.totalScore);
    expect(a.breakdown).toEqual(b.breakdown);
    expect(a.v2.financeSuitability.band).not.toBe(b.v2.financeSuitability.band);
  });

  it('is deterministic for a given clock', () => {
    const a = JSON.stringify(scoreForProduction(base()));
    const b = JSON.stringify(scoreForProduction(base()));
    expect(a).toBe(b);
  });

  it('stronger growth evidence never lowers the grade', () => {
    const order = ['F', 'D', 'C', 'C+', 'B', 'B+', 'A', 'A+'];
    const weak = scoreForProduction(base({ market: { points: { ...growthPoints(1.0), ...demandPoints() }, providersConsulted: ['domain', 'abs_erp'], providersUnavailable: [] } }));
    const strong = scoreForProduction(base({ market: { points: { ...growthPoints(8.0), ...demandPoints() }, providersConsulted: ['domain', 'abs_erp'], providersUnavailable: [] } }));
    expect(order.indexOf(strong.grade as string)).toBeGreaterThanOrEqual(order.indexOf(weak.grade as string));
  });
});
