/**
 * The methodology document and the code may not disagree — and the engine may
 * not be wired.
 *
 * `SCORING_V2_METHODOLOGY.md` is the one authoritative statement of the V2
 * methodology. A document like that goes stale the day someone edits a
 * constant, so every load-bearing number and version in it is pinned here to
 * the module that enforces it. Change a weight, a threshold, a rule or a
 * version and this spec names the sentence that now lies.
 *
 * The second describe is the unwired guard: Scoring V2 is shadow-only until
 * ME-7 passes and activation is explicitly approved, so no production edge
 * function entrypoint may import the engine. That is asserted against the
 * sources, not promised in prose.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMPOSITE_WEIGHTS, MIN_DIMENSIONS_FOR_GRADE, SHADOW_METHODOLOGY_VERSION } from '../market/shadowScorer.pure';
import { ELIGIBILITY_RULES, ELIGIBILITY_VERSION, GRADE_THRESHOLDS } from '../market/gradeEligibility.pure';
import { SCORE_OUTPUT_CONTRACT_VERSION } from '../market/scoreOutputContract.pure';
import { GROWTH_METHODOLOGY_VERSION } from '../market/growthScoring.pure';
import { DEMAND_METHODOLOGY_VERSION } from '../market/demandScoring.pure';
import { YIELD_METHODOLOGY_VERSION } from '../market/yieldScoring.pure';
import { LOCATION_METHODOLOGY_VERSION } from '../market/locationScoring.pure';
import {
  MINIMUM_INDEPENDENT_CATEGORIES,
  RISK_METHODOLOGY_STATUS,
  RISK_MODEL_D_VERSION,
} from '../risk/riskModelD.pure';
import { FINANCE_SUITABILITY_VERSION } from '../risk/financeSuitability.pure';

const ROOT = join(__dirname, '..', '..', '..', '..');
const DOC = readFileSync(join(ROOT, 'docs', 'reports', 'SCORING_V2_METHODOLOGY.md'), 'utf8');

describe('the methodology document agrees with the code', () => {
  it('states the composition version and every component version', () => {
    for (const v of [
      SHADOW_METHODOLOGY_VERSION,
      GROWTH_METHODOLOGY_VERSION,
      DEMAND_METHODOLOGY_VERSION,
      YIELD_METHODOLOGY_VERSION,
      LOCATION_METHODOLOGY_VERSION,
      RISK_MODEL_D_VERSION,
      FINANCE_SUITABILITY_VERSION,
      ELIGIBILITY_VERSION,
      SCORE_OUTPUT_CONTRACT_VERSION,
    ]) {
      expect(DOC, `document must state version ${v}`).toContain(`\`${v}\``);
    }
  });

  it('states the exact composite weights, and they sum to 1', () => {
    const sum = Object.values(COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    for (const w of Object.values(COMPOSITE_WEIGHTS)) {
      expect(DOC, `weight ${w} must appear`).toContain(`**${w.toFixed(2)}**`);
    }
  });

  it('states the grade thresholds, A+ 85 and A 75 among them', () => {
    const a = GRADE_THRESHOLDS.find(([, g]) => g === 'A+')![0];
    const b = GRADE_THRESHOLDS.find(([, g]) => g === 'A')![0];
    expect(a).toBe(85);
    expect(b).toBe(75);
    expect(DOC).toContain('| A+ | **85** |');
    expect(DOC).toContain('| A | **75** |');
  });

  it('states every eligibility rule number', () => {
    const r = ELIGIBILITY_RULES;
    expect(DOC).toContain(`**${r.aMinGrowthConfidence}**`);
    expect(DOC).toContain(`**${r.aPlusMinGrowthConfidence}**`);
    expect(DOC).toContain(`**${r.aMinGrowthCoverage.toFixed(2)}**`);
    expect(DOC).toContain(`**${r.aPlusMinGrowthCoverage.toFixed(2)}**`);
    expect(DOC).toContain(`**${r.aMinOverallCoverage.toFixed(2)}**`);
    expect(DOC).toContain(`**${r.aPlusMinOverallCoverage.toFixed(2)}**`);
  });

  it('states the composition floors and Model D rules as the code has them', () => {
    expect(DOC).toContain(`\`MIN_DIMENSIONS_FOR_GRADE\``);
    expect(MIN_DIMENSIONS_FOR_GRADE).toBe(3);
    expect(DOC).toContain('Fewer than **3** measured dimensions');
    expect(DOC).toContain(`\`MINIMUM_INDEPENDENT_CATEGORIES = ${MINIMUM_INDEPENDENT_CATEGORIES}\``);
    // Model D's honesty label travels into the document verbatim.
    expect(DOC).toContain(RISK_METHODOLOGY_STATUS);
  });

  it('is versioned as shadow and says the engine is unwired', () => {
    expect(SHADOW_METHODOLOGY_VERSION.endsWith('-shadow')).toBe(true);
    expect(DOC).toMatch(/shadow-only/);
    expect(DOC).toMatch(/not wired/i);
  });
});

describe('the engine is unwired — asserted, not promised', () => {
  // The modules that constitute Scoring V2. A production entrypoint importing
  // any of them is the wiring this guard exists to catch. `investment/
  // scoringV2.pure.ts` is the earlier unwired analysis module and is held to
  // the same rule.
  const ENGINE_MARKERS = [
    'shadowScorer',
    'scoreOutputContract',
    'riskModelD',
    'scoreInvestmentV2',
    'investment/scoringV2',
  ];

  it('no production edge-function entrypoint imports the V2 engine', () => {
    const fnRoot = join(ROOT, 'supabase', 'functions');
    const offenders: string[] = [];
    for (const dir of readdirSync(fnRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === '_shared') continue;
      const entry = join(fnRoot, dir.name, 'index.ts');
      if (!existsSync(entry)) continue;
      const src = readFileSync(entry, 'utf8');
      for (const marker of ENGINE_MARKERS) {
        if (src.includes(marker)) offenders.push(`${dir.name}: ${marker}`);
      }
    }
    expect(offenders, 'Scoring V2 must stay shadow-only until ME-8 activation is approved').toEqual([]);
  });
});
