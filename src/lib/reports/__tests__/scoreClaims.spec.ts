/**
 * QA-18 — a summarising report may not invent or re-estimate a score.
 *
 * The Briefing of 291 Stone Mason Drive rated an "overall investment fit"
 * 68/100 and gave two "scores of 82" that appear nowhere in the record or
 * in the parent document. These pin the guard that removes such claims.
 */
import { describe, expect, it } from 'vitest';
import {
  findScoreClaims,
  recordedScoreValues,
  suppressUnrecordedScores,
} from '@/lib/reports/investment/scoreClaims.pure';

const STONE_MASON_SCORE = {
  totalScore: 39,
  grade: 'D',
  breakdown: {
    yieldScore: { score: 30, weight: 33, available: true },
    riskScore: { score: 75, weight: 11, available: true },
    locationScore: { score: 58, weight: 56, available: true },
    // Excluded dimensions carry a placeholder 50 that is not a score.
    growthScore: { score: 50, weight: 0, excluded: true, available: false },
    demandScore: { score: 50, weight: 0, hasData: false },
  },
};

describe('findScoreClaims', () => {
  it('recognises the forms the corpus uses', () => {
    const text = 'Overall fit is rated 68/100. The property has a Metro-linked accessibility score of 82. '
      + 'It scored 75 on risk and is 58 out of 100 for location.';
    expect(findScoreClaims(text).map((c) => c.value)).toEqual([68, 82, 75, 58]);
  });

  it('does not read a percentage, a distance or a price as a score', () => {
    expect(findScoreClaims('Gross yield of 3.6% and a rating of 95% occupancy; 2 km; score of 1,299,000')).toEqual([]);
  });
});

describe('recordedScoreValues', () => {
  it('holds the total and the scored dimensions, never an excluded placeholder', () => {
    expect(recordedScoreValues(STONE_MASON_SCORE).sort((a, b) => a - b)).toEqual([30, 39, 58, 75]);
  });
  it('is empty for no record', () => {
    expect(recordedScoreValues(null)).toEqual([]);
    expect(recordedScoreValues('x')).toEqual([]);
  });
});

describe('suppressUnrecordedScores', () => {
  const recorded = recordedScoreValues(STONE_MASON_SCORE);

  it('removes the sentence that carries an invented score and keeps the rest', () => {
    const md = [
      '## Executive Verdict',
      '',
      'Kellyville is a family suburb with metro access. Overall investment fit is rated 68/100, indicating strong potential. The record grades it D at 39/100.',
      '',
      '- Metro access: the property has a Metro-linked accessibility score of 82.',
      '- Schools: strong government options in the catchment.',
    ].join('\n');
    const { markdown, removed } = suppressUnrecordedScores(md, { recorded });
    expect(markdown).toContain('Kellyville is a family suburb with metro access. The record grades it D at 39/100.');
    expect(markdown).not.toContain('68/100');
    expect(markdown).not.toContain('score of 82');
    expect(markdown).toContain('- Schools: strong government options in the catchment.');
    expect(removed.map((r) => r.value)).toEqual([68, 82]);
  });

  it('keeps a claim the parent document made itself', () => {
    const md = 'The walk score of 62/100 supports car-light living.';
    const parent = 'Walk Score: 62/100 (Somewhat Walkable), measured for the address.';
    expect(suppressUnrecordedScores(md, { recorded, parentText: parent }).markdown).toBe(md);
  });

  it('never edits a table, a directive or a heading', () => {
    const md = [
      '## Score 88/100 Overview',
      '| Dimension | Weight | Score |',
      '| --- | --- | --- |',
      '| Fit | 10% | 88/100 |',
      '{{gauge: 88 | max=100 | label=Fit}}',
    ].join('\n');
    const { markdown, removed } = suppressUnrecordedScores(md, { recorded });
    expect(markdown).toBe(md);
    expect(removed).toEqual([]);
  });

  it('drops a bullet whose only sentence was the claim', () => {
    const md = 'Intro.\n\n- Suburb fit score of 82 for commuter families.\n- Kept.\n';
    const { markdown } = suppressUnrecordedScores(md, { recorded });
    expect(markdown).toBe('Intro.\n\n- Kept.\n');
  });
});
