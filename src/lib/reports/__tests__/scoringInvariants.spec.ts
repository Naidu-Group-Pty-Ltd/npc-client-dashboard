/**
 * ME-4 — the scoring invariants.
 *
 * ## THESE ARE NOT MARKET EVIDENCE
 *
 * Every fixture is a controlled input constructed to exercise a RULE. Nothing
 * here is a real suburb, median or growth rate, and no result is a backtest or
 * a statement about any Australian market.
 *
 * These tests do not check that the scores are *right* — no test can, and the
 * real historical backtest waits on licensed suburb evidence. They check that
 * the system cannot violate the properties a defensible grade depends on:
 * that more of a good thing never scores worse, that one fact is not rewarded
 * twice, that absence never becomes a favourable number, that corroboration is
 * distinguished from depth, and that a regional figure cannot promote a whole
 * state.
 */
import { describe, expect, it } from 'vitest';

import {
  COMPOSITE_WEIGHTS,
  MIN_DIMENSIONS_FOR_GRADE,
  scoreInvestmentV2Shadow,
  type ShadowScoreInput,
} from '../market/shadowScorer.pure';
import { scoreGrowth } from '../market/growthScoring.pure';
import { scoreDemand } from '../market/demandScoring.pure';
import { scoreRisk } from '../market/riskScoring.pure';
import { scoreLocation } from '../market/locationScoring.pure';
import { scoreYield } from '../market/yieldScoring.pure';
import { DIMENSION_OWNERSHIP, DECLARED_EXCEPTIONS, mayRead } from '../market/dimensionOwnership.pure';
import {
  emptyEvidence,
  type EvidencePoint,
  type EvidenceSubject,
  type MarketEvidence,
} from '../market/marketEvidence.pure';

const NOW = new Date('2026-09-08T00:00:00Z');
const SUBJECT: EvidenceSubject = {
  suburb: 'Test Fixture', postcode: '0000', state: 'NA',
  dwellingType: 'house', resolvedFrom: 'coordinate',
};

const pt = (value: number, o: Partial<EvidencePoint> = {}): EvidencePoint => ({
  value, level: 'suburb', areaName: 'Synthetic fixture area', dwellingType: 'house',
  dwellingTypeMatched: true, provider: 'domain', asOf: '2026-Q2',
  sampleSize: 90, periodsAvailable: 24, method: 'observed',
  licensingStatus: 'licensed_for_client_reports', sourceNote: null, ...o,
});

const series = (steps: number[]): EvidencePoint<ReadonlyArray<{ period: string; value: number }>> => {
  let v = 500_000;
  const out = [{ period: '2020-Q2', value: v }];
  steps.forEach((p, i) => { v *= 1 + p / 100; out.push({ period: `${2021 + i}-Q2`, value: Math.round(v) }); });
  return { ...pt(0), value: out } as EvidencePoint<ReadonlyArray<{ period: string; value: number }>>;
};

const ev = (over: Partial<MarketEvidence>): MarketEvidence => ({ ...emptyEvidence(SUBJECT), ...over });

/** A fully evidenced, unremarkable property. Every invariant perturbs this. */
const BASE: ShadowScoreInput = {
  evidence: ev({
    growth5YearCagr: pt(5.0), growth3YearCagr: pt(5.2), growth1Year: pt(4.8),
    priceSeries: series([5, 5, 5, 5, 5, 5]),
    benchmarkGrowth5YearCagr: pt(4.5, { level: 'gccsa', areaName: 'Synthetic benchmark region' }),
    vacancyRate: pt(2.5), daysOnMarket: pt(35), auctionClearanceRate: pt(62),
    salesCount: pt(60), listingActivity: pt(100), populationGrowth: pt(1.5),
  }),
  yieldInputs: { basis: 'purchase', basisAmount: 800_000, weeklyRent: 670 },
  locationInputs: { walkScore: 72, commuteTimeCBD: 35, schoolsNearby: 4 },
  riskInputs: { lvr: 75, weeklyCashFlow: -220, propertyType: 'House', growth1Year: 4.8 },
  now: NOW,
};

const run = (o: Partial<ShadowScoreInput> = {}) => scoreInvestmentV2Shadow({ ...BASE, ...o });
const withEvidence = (over: Partial<MarketEvidence>) => run({ evidence: { ...BASE.evidence, ...over } });

// ---------------------------------------------------------------------------
// 1. Monotonicity — more of a good thing never scores worse
// ---------------------------------------------------------------------------

describe('monotonicity', () => {
  it('stronger sustained growth never lowers the Growth score', () => {
    let previous = -1;
    for (const rate of [-2, 0, 2, 4, 6, 8, 10, 13]) {
      const r = scoreGrowth(ev({
        growth5YearCagr: pt(rate), growth3YearCagr: pt(rate), growth1Year: pt(rate),
        priceSeries: series([rate, rate, rate, rate, rate, rate]),
      }), NOW);
      expect(r.score).not.toBeNull();
      expect(r.score!).toBeGreaterThanOrEqual(previous);
      previous = r.score!;
    }
  });

  it('tighter vacancy never lowers Demand', () => {
    let previous = -1;
    for (const vac of [8, 6, 5, 4, 3, 2, 1.5, 1, 0.5]) {
      const r = scoreDemand(ev({ vacancyRate: pt(vac) }), NOW);
      expect(r.score!).toBeGreaterThanOrEqual(previous);
      previous = r.score!;
    }
  });

  it('higher rent on the same price never lowers Yield', () => {
    let previous = -1;
    for (const rent of [200, 400, 600, 700, 850, 1000, 1400]) {
      const r = scoreYield({ basis: 'purchase', basisAmount: 800_000, weeklyRent: rent });
      expect(r.score!).toBeGreaterThanOrEqual(previous);
      previous = r.score!;
    }
  });

  it('more leverage never improves Risk', () => {
    let previous = 101;
    for (const lvr of [40, 55, 65, 75, 82, 88, 93, 99]) {
      const r = scoreRisk({ lvr });
      expect(r.score!).toBeLessThanOrEqual(previous);
      previous = r.score!;
    }
  });

  it('a worse cash-flow position never improves Risk', () => {
    let previous = 101;
    for (const cf of [200, 50, 0, -100, -250, -400, -600]) {
      const r = scoreRisk({ weeklyCashFlow: cf });
      expect(r.score!).toBeLessThanOrEqual(previous);
      previous = r.score!;
    }
  });

  it('a longer commute never improves Location', () => {
    let previous = 101;
    for (const mins of [12, 20, 30, 45, 60, 80, 100]) {
      const r = scoreLocation({ commuteTimeCBD: mins });
      expect(r.score!).toBeLessThanOrEqual(previous);
      previous = r.score!;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No duplicate reward
// ---------------------------------------------------------------------------

describe('one characteristic is rewarded once', () => {
  it('vacancy moves Demand and leaves Risk untouched', () => {
    const tight = withEvidence({ vacancyRate: pt(0.6) });
    const loose = withEvidence({ vacancyRate: pt(7.0) });
    expect(tight.demand.score!).toBeGreaterThan(loose.demand.score! + 20);
    // Risk must not have noticed at all.
    expect(tight.risk.score).toBe(loose.risk.score);
  });

  it('days on market moves Demand and leaves Risk untouched', () => {
    const fast = withEvidence({ daysOnMarket: pt(12) });
    const slow = withEvidence({ daysOnMarket: pt(140) });
    expect(fast.demand.score!).toBeGreaterThan(slow.demand.score!);
    expect(fast.risk.score).toBe(slow.risk.score);
  });

  it('holding cash flow moves Risk and leaves Yield untouched', () => {
    const geared = run({ yieldInputs: { ...BASE.yieldInputs, weeklyCashFlow: -600 } });
    const neutral = run({ yieldInputs: { ...BASE.yieldInputs, weeklyCashFlow: 50 } });
    expect(geared.yieldResult.score).toBe(neutral.yieldResult.score);
    expect(geared.holdingCashFlow.reading).not.toBe(neutral.holdingCashFlow.reading);
  });

  it('population growth moves Demand and never Growth', () => {
    const booming = withEvidence({ populationGrowth: pt(4.5) });
    const shrinking = withEvidence({ populationGrowth: pt(-0.5) });
    expect(booming.demand.score!).toBeGreaterThan(shrinking.demand.score!);
    expect(booming.growth.score).toBe(shrinking.growth.score);
  });

  it('the only shared input is a declared exception, moving the two in opposite directions', () => {
    // growth1Year: Growth rewards it, Risk prices its reversal.
    const hot = run({
      evidence: { ...BASE.evidence, growth1Year: pt(24) },
      riskInputs: { ...BASE.riskInputs, growth1Year: 24 },
    });
    const calm = run({
      evidence: { ...BASE.evidence, growth1Year: pt(4) },
      riskInputs: { ...BASE.riskInputs, growth1Year: 4 },
    });
    expect(hot.growth.score!).toBeGreaterThan(calm.growth.score!);   // rewarded
    expect(hot.risk.score!).toBeLessThan(calm.risk.score!);          // and charged
    expect(DECLARED_EXCEPTIONS.some((x) => x.input === 'growth1Year' && x.direction === 'opposes')).toBe(true);
  });

  it('the ownership matrix names one owner per input and permits nothing else', () => {
    const seen = new Set<string>();
    for (const e of DIMENSION_OWNERSHIP) {
      expect(seen.has(e.input)).toBe(false);   // exactly one entry per input
      seen.add(e.input);
      expect(e.rationale.length).toBeGreaterThan(10);
      // An owner may never appear in its own forbidden list.
      expect(e.forbiddenTo).not.toContain(e.owner);
    }
    // Vacancy is Demand's and forbidden to Risk — the duplication this removed.
    expect(mayRead('demand', 'vacancyRate')).toBe(true);
    expect(mayRead('risk', 'vacancyRate')).toBe(false);
    expect(mayRead('yield', 'weeklyCashFlow')).toBe(false);
    expect(mayRead('growth', 'populationGrowth')).toBe(false);
    // …and the one exception is permitted, because it is declared.
    expect(mayRead('risk', 'growth1Year')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing is absent
// ---------------------------------------------------------------------------

describe('missing evidence is absent, never 0, 50, average or favourable', () => {
  it('drops an unmeasured dimension from the composite rather than scoring it', () => {
    const withYield = run();
    const noRent = run({ yieldInputs: { basis: 'purchase', basisAmount: 800_000, weeklyRent: null } });
    expect(noRent.yieldResult.score).toBeNull();
    expect(noRent.unavailable).toContain('yield');
    expect(noRent.dimensions.find((d) => d.key === 'yield')!.effectiveWeight).toBe(0);
    // The other dimensions' weights renormalise upward, and coverage falls.
    expect(noRent.evidenceCoverage).toBeLessThan(withYield.evidenceCoverage);
  });

  it('never returns 0 or 50 for a dimension that has no evidence', () => {
    const bare = run({
      evidence: emptyEvidence(SUBJECT),
      yieldInputs: { basis: 'purchase', basisAmount: null, weeklyRent: null },
      locationInputs: {},
      riskInputs: {},
    });
    for (const d of bare.dimensions) expect(d.score).toBeNull();
    expect(bare.compositeScore).toBeNull();
    expect(bare.grade).toBeNull();
    expect(bare.unavailableReason).toMatch(/at least 3 are required/);
  });

  it('refuses a grade below the minimum measured dimensions', () => {
    const twoOnly = run({
      evidence: emptyEvidence(SUBJECT),                       // no Growth, no Demand
      yieldInputs: { basis: 'purchase', basisAmount: 800_000, weeklyRent: null }, // no Yield
      locationInputs: { walkScore: 90, commuteTimeCBD: 15, schoolsNearby: 8 },
      riskInputs: { lvr: 50, weeklyCashFlow: 300, propertyType: 'house' },
    });
    expect(twoOnly.measured.length).toBeLessThan(MIN_DIMENSIONS_FOR_GRADE);
    expect(twoOnly.grade).toBeNull();
  });

  it('does not let absence become favourable: a location with no evidence scores null, not 32', () => {
    // The live scorer awarded 12 + 12 + 8 for three absent inputs.
    expect(scoreLocation({}).score).toBeNull();
    expect(scoreLocation({}).weightCovered).toBe(0);
  });

  it('gives no dimension a score from the state alone', () => {
    // `state` is owned by nobody; Location must not read it.
    expect(mayRead('location', 'state')).toBe(false);
    expect(scoreLocation({} as never).score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Evidence confidence — depth is not corroboration
// ---------------------------------------------------------------------------

describe('another horizon from one source is not another source', () => {
  const oneHorizon = ev({ growth5YearCagr: pt(9, { provider: 'domain' }) });
  const threeHorizons = ev({
    growth5YearCagr: pt(9, { provider: 'domain' }),
    growth3YearCagr: pt(9, { provider: 'domain' }),
    growth1Year: pt(9, { provider: 'domain' }),
  });
  const twoProviders = ev({
    growth5YearCagr: pt(9, { provider: 'domain' }),
    growth3YearCagr: pt(9, { provider: 'cotality' }),
  });

  const independenceOf = (e: MarketEvidence) =>
    scoreGrowth(e, NOW).confidence.factors.find((f) => f.key === 'sourceIndependence')!.score;

  it('does not raise source independence when one provider supplies more horizons', () => {
    expect(independenceOf(threeHorizons)).toBe(independenceOf(oneHorizon));
  });

  it('does raise it when a second provider corroborates', () => {
    expect(independenceOf(twoProviders)).toBeGreaterThan(independenceOf(oneHorizon));
  });

  it('still credits the extra horizons as HISTORY, which is a different claim', () => {
    const depth = (e: MarketEvidence) =>
      scoreGrowth(e, NOW).confidence.factors.find((f) => f.key === 'history')!.score;
    expect(depth(threeHorizons)).toBeGreaterThan(depth(oneHorizon));
    // …and the wording keeps the two apart.
    const f = scoreGrowth(threeHorizons, NOW).confidence.factors;
    expect(f.find((x) => x.key === 'history')!.detail).toContain('periods of history');
    expect(f.find((x) => x.key === 'sourceIndependence')!.detail).toContain('one provider');
  });
});

// ---------------------------------------------------------------------------
// 5. Grade integrity
// ---------------------------------------------------------------------------

describe('grade integrity', () => {
  it('refuses A+ to a high score built on thin evidence', () => {
    const thin = run({
      evidence: ev({
        growth1Year: pt(19, { level: 'gccsa', sampleSize: 5, periodsAvailable: 2, dwellingTypeMatched: false }),
      }),
      locationInputs: { walkScore: 99, commuteTimeCBD: 10, schoolsNearby: 10 },
      riskInputs: { lvr: 45, weeklyCashFlow: 400, propertyType: 'house' },
      yieldInputs: { basis: 'purchase', basisAmount: 500_000, weeklyRent: 900 },
    });
    expect(thin.compositeScore).not.toBeNull();
    if (thin.uncappedGrade === 'A+' || thin.uncappedGrade === 'A') {
      expect(thin.grade).not.toBe('A+');
      expect(thin.gradeCapReason.length).toBeGreaterThan(0);
    }
    expect(thin.evidenceCoverage).toBeLessThan(0.7);
  });

  it('always reports both the uncapped and the final grade', () => {
    const r = run();
    expect(r.uncappedGrade).not.toBeNull();
    expect(r.grade).not.toBeNull();
  });

  it('publishes the renormalisation rather than hiding it', () => {
    const partial = run({ yieldInputs: { basis: 'purchase', basisAmount: 800_000, weeklyRent: null } });
    const growthRow = partial.dimensions.find((d) => d.key === 'growth')!;
    // Growth's effective weight exceeds its nominal one once Yield drops out…
    expect(growthRow.effectiveWeight).toBeGreaterThan(growthRow.nominalWeight);
    // …and the coverage figure says the composite rests on less evidence.
    expect(partial.evidenceCoverage).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 6. State independence and property differentiation
// ---------------------------------------------------------------------------

describe('a region cannot promote every property in it', () => {
  it('changing only the benchmark moves the score by a bounded amount', () => {
    const strongRegion = withEvidence({
      benchmarkGrowth5YearCagr: pt(12, { level: 'gccsa', areaName: 'Synthetic region' }),
    });
    const weakRegion = withEvidence({
      benchmarkGrowth5YearCagr: pt(0.5, { level: 'gccsa', areaName: 'Synthetic region' }),
    });
    // The subject's own evidence is identical, so only `relative` may move.
    const delta = Math.abs(weakRegion.compositeScore! - strongRegion.compositeScore!);
    // relative is 0.15 of growth, growth is 0.40 of the composite → 6 points max.
    expect(delta).toBeLessThanOrEqual(Math.ceil(100 * 0.15 * COMPOSITE_WEIGHTS.growth));
  });

  it('a booming region does not turn an ordinary property into an A', () => {
    const ordinaryInBoom = withEvidence({
      benchmarkGrowth5YearCagr: pt(13, { level: 'gccsa', areaName: 'Synthetic region' }),
    });
    // Base is a 5%-a-year suburb: solidly average, and it must stay that way.
    expect(ordinaryInBoom.compositeScore!).toBeLessThan(75);
  });

  it('two suburbs in one region can differ materially on their own evidence', () => {
    const benchmark = pt(4.5, { level: 'gccsa', areaName: 'Synthetic region' });
    const strong = withEvidence({
      growth5YearCagr: pt(11.5), growth3YearCagr: pt(12.5), growth1Year: pt(11),
      priceSeries: series([11, 12, 11, 13, 11, 12]), benchmarkGrowth5YearCagr: benchmark,
    });
    const weak = withEvidence({
      growth5YearCagr: pt(0.5), growth3YearCagr: pt(-1), growth1Year: pt(-3),
      priceSeries: series([1, -2, 0, -3, 1, -3]), benchmarkGrowth5YearCagr: benchmark,
    });
    expect(strong.growth.score! - weak.growth.score!).toBeGreaterThan(40);
    expect(strong.compositeScore! - weak.compositeScore!).toBeGreaterThan(15);
  });
});
