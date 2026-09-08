import { describe, expect, it } from 'vitest';
import { getInvestmentGradeTone, getInvestmentScoreSummary, resolveCardInvestmentGrade, resolveInvestmentGrade } from '../utils';

const report = (overrides: Record<string, unknown> = {}) => ({
  id: 'report-1',
  created_at: '2026-07-24T10:00:00.000Z',
  status: 'completed',
  investment_score: undefined,
  ...overrides,
});

describe('resolveInvestmentGrade', () => {
  it('uses the most recent calculated persisted score rather than report variant order', () => {
    const resolved = resolveInvestmentGrade([
      report({ id: 'compass', created_at: '2026-07-22T10:00:00.000Z', investment_score: { grade: 'B', totalScore: 68 } }),
      report({ id: 'briefing', created_at: '2026-07-24T10:00:00.000Z', investment_score: { grade: 'A', totalScore: 84 } }),
    ] as any);

    expect(resolved).toMatchObject({ status: 'calculated', grade: 'A', score: 84, sourceReportId: 'briefing' });
  });

  it('keeps a completed score authoritative while a newer regeneration is pending', () => {
    const resolved = resolveInvestmentGrade([
      report({ id: 'completed', created_at: '2026-07-22T10:00:00.000Z', investment_score: { grade: 'B+', totalScore: 76 } }),
      report({ id: 'regenerating', created_at: '2026-07-24T10:00:00.000Z', status: 'processing' }),
    ] as any);

    expect(resolved).toMatchObject({ status: 'calculated', grade: 'B+', score: 76, sourceReportId: 'completed' });
  });

  it.each([
    [{ status: 'pending' }, 'pending'],
    [{ status: 'failed' }, 'failed'],
    [{ investment_score: { coverage: { dataInsufficient: true } } }, 'insufficient_data'],
    [{}, 'not_graded'],
  ] as const)('returns %s safely without inventing a score', (input, status) => {
    const resolved = resolveInvestmentGrade([report(input)] as any);
    expect(resolved.status).toBe(status);
    expect(resolved.score).toBeNull();
  });
});

describe('investment score display values', () => {
  it('discards malformed JSON values before they reach the report UI', () => {
    const summary = getInvestmentScoreSummary(report({
      investment_score: {
        grade: { unexpected: 'A' },
        recommendation: ['Buy'],
        totalScore: 82,
        coverage: { partialLabel: 42 },
      },
    }) as any);

    expect(summary).toMatchObject({
      grade: null,
      recommendation: null,
      partialLabel: null,
      score: 82,
    });
  });

  it('handles a non-string grade defensively when called with untyped data', () => {
    expect(getInvestmentGradeTone({ unexpected: 'A' } as any)).toBe('bg-muted text-muted-foreground');
  });
});

/**
 * The reported defect: a property with all five report types showed the
 * Investment Grade on three cards and nothing at all on the Financial and
 * Strategic ones.
 *
 * It survived a partial fix because resolution and the render gate were two
 * expressions of one idea in two places — the card resolved across siblings
 * and then asked its own `investment_score` column whether to draw. These pin
 * the joined answer.
 */
describe('resolveCardInvestmentGrade', () => {
  const compass = {
    id: 'compass', created_at: '2026-09-01T00:00:00Z', status: 'completed',
    report_scope: 'property',
    investment_score: { overall_score: 82, grade: 'A', recommendation: 'Strong buy' },
  };
  const financial = {
    id: 'financial', created_at: '2026-09-02T00:00:00Z', status: 'completed',
    report_scope: 'property', investment_score: null,
  };

  it('shows the property grade on a report that carries no score of its own', () => {
    const result = resolveCardInvestmentGrade(financial as any, [compass, financial] as any);
    expect(result.show).toBe(true);
    expect(result.grade.status).toBe('calculated');
    expect(result.grade.score).toBe(82);
  });

  it('says the grade was borrowed, so the card can attribute it', () => {
    const result = resolveCardInvestmentGrade(financial as any, [compass, financial] as any);
    expect(result.borrowedFromReportId).toBe('compass');
  });

  it('does not call a report grade borrowed when it produced the score itself', () => {
    const result = resolveCardInvestmentGrade(compass as any, [compass, financial] as any);
    expect(result.borrowedFromReportId).toBeNull();
    expect(result.show).toBe(true);
  });

  it('shows nothing when no sibling ever calculated a grade', () => {
    // Pending, failed and ungraded are the sibling's news, not this
    // property's; repeating them here reports a state this report is not in.
    const pending = { ...financial, id: 'pending', status: 'processing' };
    const result = resolveCardInvestmentGrade(financial as any, [pending, financial] as any);
    expect(result.show).toBe(false);
  });

  it('never lends a property grade to an area-scope report', () => {
    const suburb = { ...financial, id: 'suburb', report_scope: 'suburb' };
    const result = resolveCardInvestmentGrade(suburb as any, [compass, suburb] as any);
    expect(result.show).toBe(false);
  });

  it('falls back to the report alone when the siblings are unknown', () => {
    expect(resolveCardInvestmentGrade(financial as any).show).toBe(false);
    expect(resolveCardInvestmentGrade(compass as any).show).toBe(true);
  });
});
