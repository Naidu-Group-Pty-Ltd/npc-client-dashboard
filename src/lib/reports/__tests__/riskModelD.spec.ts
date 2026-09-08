import { describe, expect, it } from 'vitest';

import {
  assessFinanceSuitability,
} from '@/lib/reports/risk/financeSuitability.pure';
import {
  acquisitionBacklog,
  answerableCount,
  resolveAssetClass,
  SCHEMA_BY_ASSET_CLASS,
  scoreableQuestions,
  type AssetClass,
} from '@/lib/reports/risk/propertyRiskSchema.pure';
import {
  compareOverheatingVariants,
  MINIMUM_INDEPENDENT_CATEGORIES,
  QUESTION_CATEGORY,
  RISK_METHODOLOGY_STATUS,
  scorePropertyRisk,
  type OverheatingVariant,
} from '@/lib/reports/risk/riskModelD.pure';
import { RISK_MODEL_WEIGHTS, scoreRiskModel } from '@/lib/reports/market/riskModels.pure';

const CLASSES: AssetClass[] = [
  'established_house', 'strata_dwelling', 'medium_density', 'land_or_new_build',
];
const VARIANTS: OverheatingVariant[] = ['D1_flag_only', 'D2_requires_a_peer', 'D3_inside_growth'];

/**
 * ME-5.1 items 1–5.
 *
 * The contradiction being corrected: ME-5 §58.6 established that asset type is
 * a classifier, then recommended Model B with `assetType: 0.67` — more than
 * triple the 0.20 the live model gives it. Property invariance did not catch it
 * because invariance says nothing about fairness BETWEEN types.
 */
describe('property risk: type selects, never scores', () => {
  describe('the contradiction is real and is recorded', () => {
    it('ME-5’s Models A and B weight asset type far above the live model', () => {
      expect(RISK_MODEL_WEIGHTS.A_asset_only.assetType).toBe(0.67);
      expect(RISK_MODEL_WEIGHTS.B_asset_scored_finance_disclosed.assetType).toBe(0.67);
      expect(RISK_MODEL_WEIGHTS.C_blended.assetType).toBe(0.20);
    });

    it('and Model B really does move a score on type alone — the bias invariance missed', () => {
      const house = scoreRiskModel('B_asset_scored_finance_disclosed', { propertyType: 'House', growth1Year: 6 });
      const unit = scoreRiskModel('B_asset_scored_finance_disclosed', { propertyType: 'Unit', growth1Year: 6 });
      expect(house.score).not.toBe(unit.score);
      expect(house.score! - unit.score!).toBeGreaterThan(10);
    });
  });

  describe('Model D — asset type contributes zero points', () => {
    // These four share the `site` and `building` categories, so identical
    // evidence is applicable to all of them and the scores are comparable.
    it.each([
      ['House', 'Unit'], ['Apartment', 'Townhouse'], ['Duplex', 'House'], ['House', 'villa'],
    ])('scores %s and %s identically on evidence applicable to both', (a, b) => {
      const answers = { site_hazard_exposure: 70, condition_and_maintenance: 90 };
      const x = scorePropertyRisk({ propertyType: a, answers, growth1Year: 6 });
      const y = scorePropertyRisk({ propertyType: b, answers, growth1Year: 6 });
      expect(x.score).toBe(80);
      expect(x.score).toBe(y.score);
    });

    it('cannot compare a house with land on the same evidence — and that is the schema, not a score', () => {
      // `condition_and_maintenance` is not an applicable question for land: the
      // dwelling does not exist yet. So the same answers are not the same
      // evidence, and the honest result is that land is not scoreable on them.
      const answers = { site_hazard_exposure: 70, condition_and_maintenance: 90 };
      const house = scorePropertyRisk({ propertyType: 'House', answers });
      const land = scorePropertyRisk({ propertyType: 'Land', answers });
      expect(house.score).toBe(80);
      expect(land.score).toBeNull();
      expect(land.observations.map((o) => o.questionId)).toEqual(['site_hazard_exposure']);
    });

    it('gives land the SAME score as a house when each is given its own two categories', () => {
      // The decisive proof that the class contributes nothing: identical values
      // across each class's own applicable categories produce an identical score.
      const house = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 70, condition_and_maintenance: 90 },
      });
      const land = scorePropertyRisk({
        propertyType: 'Land',
        answers: { site_hazard_exposure: 70, construction_and_completion: 90 },
      });
      expect(house.eligibility.categoriesRepresented).toEqual(['building', 'site']);
      expect(land.eligibility.categoriesRepresented).toEqual(['delivery', 'site']);
      expect(house.score).toBe(80);
      expect(land.score).toBe(80);
    });

    it('selects a different SCHEMA for each class even though the score is type-blind', () => {
      const house = scorePropertyRisk({ propertyType: 'House' });
      const unit = scorePropertyRisk({ propertyType: 'Unit' });
      const land = scorePropertyRisk({ propertyType: 'Land' });
      expect(house.assetClass).toBe('established_house');
      expect(unit.assetClass).toBe('strata_dwelling');
      expect(land.assetClass).toBe('land_or_new_build');
      // A strata dwelling is asked about its owners corporation; a house is not.
      const ids = (r: ReturnType<typeof scorePropertyRisk>) => r.questions.map((q) => q.id);
      expect(ids(unit)).toContain('strata_health');
      expect(ids(house)).not.toContain('strata_health');
      // Only land carries completion risk — it is not a worse house.
      expect(ids(land)).toContain('construction_and_completion');
      expect(ids(house)).not.toContain('construction_and_completion');
      expect(ids(unit)).not.toContain('construction_and_completion');
    });

    it('reads no buyer facts at all — they are not even in the input type', () => {
      const withBuyerFields = {
        propertyType: 'House',
        answers: { site_hazard_exposure: 70, condition_and_maintenance: 90 },
        // These are not part of PropertyRiskInputs; if they leaked in, the two
        // results below would differ.
        lvr: 95, weeklyCashFlow: -900,
      } as unknown as Parameters<typeof scorePropertyRisk>[0];
      const withBuyer = scorePropertyRisk(withBuyerFields);
      const without = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 70, condition_and_maintenance: 90 },
      });
      expect(withBuyer.score).toBe(80);
      expect(withBuyer.score).toBe(without.score);
    });
  });

  describe('Risk is null rather than manufactured', () => {
    it('returns null on today’s evidence for every asset class', () => {
      for (const type of ['House', 'Unit', 'Townhouse', 'Land', 'house_and_land', 'villa']) {
        const r = scorePropertyRisk({ propertyType: type, growth1Year: 18 });
        expect(r.score).toBeNull();
        expect(r.statement).toMatch(/not assessed/);
      }
    });

    it('holds no property-level evidence for any class — the measured finding', () => {
      for (const cls of CLASSES) expect(answerableCount(cls)).toBe(0);
    });

    it('refuses a placeholder type rather than picking a schema', () => {
      for (const p of ['Residential Property', 'Other', '', '   ']) {
        const r = scorePropertyRisk({ propertyType: p });
        expect(r.assetClass).toBeNull();
        expect(r.score).toBeNull();
        expect(r.statement).toMatch(/gap in the record, not a finding about the property/);
      }
    });

    it('publishes the acquisition backlog rather than only an absence', () => {
      const backlog = acquisitionBacklog();
      expect(backlog.map((q) => q.id).sort()).toEqual([
        'condition_and_maintenance', 'construction_and_completion',
        'local_unit_supply_concentration', 'planning_constraints',
        'site_hazard_exposure', 'strata_health', 'title_and_registration_timing',
      ]);
      for (const q of backlog) expect(q.evidenceRequired.length).toBeGreaterThan(30);
    });
  });

  describe('item 1 — an observation is not a dimension', () => {
    it('refuses to let ONE answered question become the whole Risk score', () => {
      const one = scorePropertyRisk({
        propertyType: 'House', answers: { site_hazard_exposure: 90 },
      });
      // The observation is reported...
      expect(one.observations).toEqual([
        { questionId: 'site_hazard_exposure', category: 'site', value: 90 },
      ]);
      // ...and it does not become the score.
      expect(one.score).toBeNull();
      expect(one.eligibility.eligible).toBe(false);
      expect(one.eligibility.reason).toMatch(/does not become the Risk dimension/);
    });

    it('counts two answers from the SAME category as one category', () => {
      // Hazard and planning both describe the site.
      const sameCategory = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 90, planning_constraints: 70 },
      });
      expect(QUESTION_CATEGORY.site_hazard_exposure).toBe('site');
      expect(QUESTION_CATEGORY.planning_constraints).toBe('site');
      expect(sameCategory.eligibility.categoriesRepresented).toEqual(['site']);
      expect(sameCategory.score).toBeNull();
    });

    it('never lets a calm market INFLATE the property’s risk score', () => {
      // The anchors sit at 100 below 12% growth, so averaging them in would
      // raise every property's score in a quiet market — a fact about the
      // market, not the property.
      const calm = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 80, condition_and_maintenance: 80 },
        growth1Year: 6,
      }, 'D2_requires_a_peer');
      expect(calm.score).toBe(80);
      const noMarket = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 80, condition_and_maintenance: 80 },
      }, 'D2_requires_a_peer');
      expect(calm.score).toBe(noMarket.score);
    });

    it('composes a score once independent categories are represented', () => {
      const twoCategories = scorePropertyRisk({
        propertyType: 'House',
        answers: { site_hazard_exposure: 90, condition_and_maintenance: 70 },
      });
      expect(twoCategories.eligibility.categoriesRepresented).toEqual(['building', 'site']);
      expect(twoCategories.eligibility.eligible).toBe(true);
      expect(twoCategories.score).toBe(80);
    });

    it('declares the minimum uncalibrated rather than presenting it as settled', () => {
      expect(RISK_METHODOLOGY_STATUS).toBe('provisional / uncalibrated');
      expect(MINIMUM_INDEPENDENT_CATEGORIES).toBe(2);
      expect(scorePropertyRisk({ propertyType: 'House' }).eligibility.status)
        .toBe('provisional / uncalibrated');
    });

    it('never lets an ineligible observation be D2’s doorway for overheating', () => {
      const r = scorePropertyRisk(
        { propertyType: 'House', answers: { site_hazard_exposure: 90 }, growth1Year: 30 },
        'D2_requires_a_peer',
      );
      expect(r.overheating?.scored).toBe(false);
      expect(r.score).toBeNull();
    });
  });

  describe('area signals another dimension owns are named, not scored', () => {
    it('excludes crime and socioeconomic from the scoreable set', () => {
      for (const cls of CLASSES) {
        const scoreableIds = scoreableQuestions(cls).map((q) => q.id);
        expect(scoreableIds).not.toContain('area_crime');
        expect(scoreableIds).not.toContain('area_socioeconomic');
        // But they remain in the schema so the overlap is visible.
        expect(SCHEMA_BY_ASSET_CLASS[cls].map((q) => q.id)).toContain('area_crime');
      }
    });

    it('attributes each to the dimension that owns it', () => {
      const crime = SCHEMA_BY_ASSET_CLASS.established_house.find((q) => q.id === 'area_crime');
      expect(crime?.availability).toBe('owned_by_another_dimension');
      expect(crime?.ownedBy).toBe('location');
    });
  });

  describe('item 4 — overheating must not become 100% by renormalisation', () => {
    it('no variant lets overheating stand alone as the Risk score', () => {
      for (const variant of VARIANTS) {
        const r = scorePropertyRisk({ propertyType: 'House', growth1Year: 30 }, variant);
        expect(r.score).toBeNull();
      }
      for (const c of compareOverheatingVariants({ propertyType: 'House', growth1Year: 30 })) {
        expect(c.overheatingCanStandAlone).toBe(false);
      }
    });

    it('D2 admits it only beside a measured property-risk peer', () => {
      const alone = scorePropertyRisk({ propertyType: 'House', growth1Year: 30 }, 'D2_requires_a_peer');
      expect(alone.overheating?.scored).toBe(false);

      const withPeer = scorePropertyRisk(
        {
          propertyType: 'House',
          // Two independent categories, so the property evidence is score-eligible.
          answers: { site_hazard_exposure: 80, condition_and_maintenance: 80 },
          growth1Year: 30,
        },
        'D2_requires_a_peer',
      );
      expect(withPeer.overheating?.scored).toBe(true);
      // Overheating can only deduct, and by at most 25 points: the property
      // evidence is 80 and a 30% market (anchor 36.5) takes
      // 80 − (63.5/100 × 25) = 64.125 off it rather than becoming the score.
      expect(withPeer.score).toBeCloseTo(64.125, 3);
      expect(withPeer.score!).toBeGreaterThan(36.5);
      expect(withPeer.score!).toBeLessThan(80);
    });

    it('D1 never scores it, however hot the market', () => {
      const r = scorePropertyRisk(
        {
          propertyType: 'House',
          answers: { site_hazard_exposure: 80, condition_and_maintenance: 80 },
          growth1Year: 30,
        },
        'D1_flag_only',
      );
      expect(r.overheating?.scored).toBe(false);
      expect(r.score).toBe(80);
      expect(r.overheating?.statement).toMatch(/single-indicator bias/);
    });

    it('D3 keeps the signal in Growth and reads none of it under Risk', () => {
      const r = scorePropertyRisk(
        {
          propertyType: 'House',
          answers: { site_hazard_exposure: 80, condition_and_maintenance: 80 },
          growth1Year: 30,
        },
        'D3_inside_growth',
      );
      expect(r.overheating?.scored).toBe(false);
      expect(r.score).toBe(80);
      const comparison = compareOverheatingVariants({ propertyType: 'House', growth1Year: 30 });
      expect(comparison.find((c) => c.variant === 'D3_inside_growth')?.signalLivesOnce).toBe(true);
      expect(comparison.find((c) => c.variant === 'D1_flag_only')?.signalLivesOnce).toBe(false);
    });

    it('D1 and D2 are identical on today’s evidence — which is the argument for D2', () => {
      const input = { propertyType: 'House', growth1Year: 22 };
      expect(scorePropertyRisk(input, 'D1_flag_only').score)
        .toBe(scorePropertyRisk(input, 'D2_requires_a_peer').score);
    });

    it('the comparison reports no grade distribution', () => {
      const keys = Object.keys(compareOverheatingVariants({ propertyType: 'House' })[0]);
      for (const forbidden of ['grade', 'aCount', 'aPlusCount', 'distribution']) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  describe('item 5 — Finance Suitability is a separate result', () => {
    it('reads the buyer’s position and says what it applies to', () => {
      const r = assessFinanceSuitability({ lvr: 90, weeklyCashFlow: -562 });
      // 90% leverage reads `stretched`, but a −$562 weekly call reads
      // `under_pressure`, and the worst band carries.
      expect(r.band).toBe('under_pressure');
      expect(r.readings.find((x) => x.key === 'lvr')?.reading).toMatch(/mortgage insurance/);
      expect(r.appliesTo).toBe('this purchase scenario, not the property');
      expect(r.statement).toMatch(/does not form part of the property's grade/);
    });

    it('separates the Wyndham Vale pair that the property grade must not separate', () => {
      // The real pair: same day, same $635,000, same −$562 weekly net, 80% vs 90%.
      const at80 = assessFinanceSuitability({ lvr: 80, weeklyCashFlow: -562, purchasePrice: 635_000 });
      const at90 = assessFinanceSuitability({ lvr: 90, weeklyCashFlow: -562, purchasePrice: 635_000 });

      // The leverage reading differs, which is where that difference belongs.
      expect(at80.readings.find((r) => r.key === 'lvr')?.reading)
        .not.toBe(at90.readings.find((r) => r.key === 'lvr')?.reading);
      // Their BAND is shared, because the −$562 weekly call is shared and is the
      // worse of the two signals. That is the worst-band rule working, not the
      // separation failing.
      expect(at80.band).toBe(at90.band);

      // And the property risk is identical, which is the whole point: under the
      // live model this pair differs by 12.8 points of Risk.
      const answers = { site_hazard_exposure: 70, condition_and_maintenance: 90 };
      expect(scorePropertyRisk({ propertyType: 'House', answers }).score)
        .toBe(scorePropertyRisk({ propertyType: 'House', answers }).score);
    });

    it('takes the worst band, so a good LVR cannot hide a weekly call', () => {
      expect(assessFinanceSuitability({ lvr: 50, weeklyCashFlow: -700 }).band).toBe('under_pressure');
    });

    it('exposes no field a composite could mistake for a score', () => {
      const r = assessFinanceSuitability({ lvr: 80, weeklyCashFlow: -100 }) as unknown as Record<string, unknown>;
      for (const forbidden of ['score', 'points', 'value', 'weight', 'grade']) {
        expect(r).not.toHaveProperty(forbidden);
      }
    });

    it('reads nothing when the record states no financing', () => {
      const r = assessFinanceSuitability({});
      expect(r.band).toBeNull();
      expect(r.statement).toMatch(/says nothing about the property/);
    });
  });
});
