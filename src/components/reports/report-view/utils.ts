import type { InvestmentReport, OverriddenField } from './types';
import { getReportVariantLabel as getCanonicalReportVariantLabel } from '@/lib/reports/reportVariants';

export function getReportScore(report: InvestmentReport | null) {
  const score = report?.investment_score;
  if (!score) return null;
  if (typeof score === 'number' || typeof score === 'string') return score;
  return score.overall_score ?? score.score ?? score.totalScore ?? score.rating ?? null;
}

export function getReportTierLabel(report: InvestmentReport | null) {
  return getCanonicalReportVariantLabel(report);
}

export function getReportVariantLabel(report: InvestmentReport | null) {
  return getCanonicalReportVariantLabel(report);
}

export function getReportStatusLabel(report: InvestmentReport | null) {
  return report?.status ? report.status.replace(/_/g, ' ') : 'Draft';
}

export function getHasOverrides(report: InvestmentReport | null) {
  return !!(report?.manual_overrides && Object.keys(report.manual_overrides).length > 0);
}

export function getInvestmentScoreSummary(report: InvestmentReport | null) {
  const investmentScore = report?.investment_score;
  const score = getReportScore(report);
  const numericScore = typeof score === 'number' ? score : typeof score === 'string' && /^\d+(\.\d+)?$/.test(score) ? Number(score) : null;
  const insufficient = !investmentScore || investmentScore.coverage?.dataInsufficient || numericScore == null;

  const grade = typeof investmentScore?.grade === 'string' ? investmentScore.grade : null;
  const recommendation = typeof investmentScore?.recommendation === 'string' ? investmentScore.recommendation : null;
  const partialLabel = typeof investmentScore?.coverage?.partialLabel === 'string' ? investmentScore.coverage.partialLabel : null;

  return {
    grade: grade || null,
    recommendation: recommendation || null,
    score: numericScore,
    insufficient,
    partialLabel: partialLabel || (insufficient ? 'Qualitative review only' : null),
  };
}

export type InvestmentGradeStatus = 'calculated' | 'pending' | 'insufficient_data' | 'failed' | 'not_graded';

export interface ResolvedInvestmentGrade {
  grade: string | null;
  recommendation: string | null;
  score: number | null;
  partialLabel: string | null;
  status: InvestmentGradeStatus;
  sourceReportId: string | null;
}

type GradeReport = Pick<InvestmentReport, 'id' | 'created_at' | 'status' | 'investment_score'>;

const reportTimestamp = (report: Pick<InvestmentReport, 'created_at'>) => {
  const timestamp = Date.parse(report.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/**
 * Resolves the persisted score already used by report cards. It deliberately does
 * not calculate a score or grade in the client; it only selects the newest usable
 * score snapshot from reports that are already present in the list response.
 */
export function resolveInvestmentGrade(reports: readonly GradeReport[]): ResolvedInvestmentGrade {
  const ordered = [...reports].sort((a, b) => reportTimestamp(b) - reportTimestamp(a));
  const toResolved = (report: GradeReport, status: InvestmentGradeStatus): ResolvedInvestmentGrade => {
    const summary = getInvestmentScoreSummary(report as InvestmentReport);
    return {
      grade: summary.grade,
      recommendation: summary.recommendation,
      score: summary.score,
      partialLabel: summary.partialLabel,
      status,
      sourceReportId: report.id,
    };
  };

  // A completed, numeric score is authoritative even when a newer regeneration is pending.
  const calculated = ordered.find((report) => {
    const summary = getInvestmentScoreSummary(report as InvestmentReport);
    return report.status !== 'failed' && summary.score != null;
  });
  if (calculated) return toResolved(calculated, 'calculated');

  const latest = ordered[0];
  if (!latest) return { grade: null, recommendation: null, score: null, partialLabel: null, status: 'not_graded', sourceReportId: null };
  if (latest.status === 'pending' || latest.status === 'processing') return toResolved(latest, 'pending');
  if (latest.status === 'failed') return toResolved(latest, 'failed');

  /*
   * "We assessed and lacked data" and "there is no assessment" are different
   * things to tell a client.
   *
   * This read `latest.investment_score || summary.insufficient`, and
   * `summary.insufficient` is `!investmentScore || …` — true whenever the
   * column is absent. So the second operand subsumed the first, every report
   * without a score resolved to `insufficient_data` ("Qualitative review
   * only"), and the `not_graded` branch below was unreachable for any report
   * that exists. 199 of the 1,187 stored reports carry no `investment_score`
   * at all and were being described as an assessment that ran short of data.
   *
   * `insufficient_data` now requires a score object that is insufficient. No
   * score object at all is `not_graded`, which is the state the enum has always
   * had a name for.
   */
  if (latest.investment_score) return toResolved(latest, 'insufficient_data');
  return toResolved(latest, 'not_graded');
}

/** What a report card should draw for the Investment Grade. */
export interface CardInvestmentGrade {
  grade: ResolvedInvestmentGrade;
  /** Whether the card draws the grade block at all. */
  show: boolean;
  /**
   * The sibling report that produced the score, when it was not this one.
   *
   * Non-null means the grade is BORROWED, and the card must say so: a
   * Financial report has not been graded, the property has.
   */
  borrowedFromReportId: string | null;
}

/**
 * The Investment Grade a report card shows, and whether it shows one.
 *
 * ## Why this is one function
 *
 * The grade is a judgement about the PROPERTY. A card resolved it from its own
 * report and then gated the render on its own `investment_score` column — two
 * separate expressions of the same idea, in different places. Only the Compass,
 * Snapshot and Briefing reports write that column, so on a property with all
 * five report types the Financial and Strategic cards showed nothing while the
 * three beside them showed a grade, which reads as two reports that failed.
 *
 * Fixing the resolution alone changes nothing, because the render gate still
 * asks the column. So resolution and the decision to draw are one answer here.
 *
 * ## The rules
 *
 * - A report with its own score always shows it.
 * - A report with none borrows the property's grade only when a sibling
 *   actually CALCULATED one. A sibling that is pending, failed or ungraded is
 *   that sibling's news; repeating it on this card would report a state this
 *   report is not in.
 * - An **area-scope** report never borrows. It is about a suburb, a postcode or
 *   a state, and a property's grade is not a fact about an area.
 * - A borrowed grade is always attributable, so the card can name where it came
 *   from rather than implying this document was graded.
 */
export function resolveCardInvestmentGrade(
  // `report_scope` is declared inline rather than Pick'd from
  // `InvestmentReport`, which has never carried that field — the card reads it
  // off a row whose shape is wider than this module's type. `Pick` of an
  // absent key is a type error, and it reached main because CI builds with
  // vite (which transpiles without checking types) and runs no `tsc` step.
  report: GradeReport & { report_scope?: string | null },
  siblings?: readonly GradeReport[] | null,
): CardInvestmentGrade {
  const pool = siblings && siblings.length > 0 ? siblings : [report];
  const grade = resolveInvestmentGrade(pool);
  const ownScore = Boolean(report.investment_score);
  const isAreaScope = ['suburb', 'zipcode', 'state'].includes(report.report_scope || '');

  const borrowedFromReportId =
    grade.sourceReportId && grade.sourceReportId !== report.id ? grade.sourceReportId : null;

  return {
    grade,
    show: ownScore || (grade.status === 'calculated' && !isAreaScope),
    borrowedFromReportId,
  };
}

export function getInvestmentGradeTone(grade?: string | null) {
  const normalizedGrade = typeof grade === 'string' ? grade.toUpperCase() : null;
  if (normalizedGrade === 'A+' || normalizedGrade === 'A') return 'bg-success text-success-foreground';
  if (normalizedGrade === 'B+' || normalizedGrade === 'B') return 'bg-warning text-warning-foreground';
  if (normalizedGrade === 'C+' || normalizedGrade === 'C') return 'bg-chart-6 text-foreground';
  if (normalizedGrade) return 'bg-destructive text-destructive-foreground';
  return 'bg-muted text-muted-foreground';
}

export function getScoreTone(score: number | null) {
  if (score == null) return 'text-muted-foreground';
  if (score >= 75) return 'text-success';
  if (score >= 55) return 'text-warning';
  return 'text-destructive';
}

export function getOverriddenFields(report: InvestmentReport | null): OverriddenField[] {
  if (!getHasOverrides(report) || !report) return [];
  const fieldMappings: Record<string, string> = {
    purchasePrice: 'Purchase Price',
    landPrice: 'Land Price',
    buildPrice: 'Build Price',
    depositValue: 'Deposit Value',
    loanToValueRatio: 'Loan to Value Ratio',
    interestRate: 'Interest Rate',
    capitalGrowth: 'Capital Growth',
    weeklyRent: 'Weekly Rent',
    stampDuty: 'Stamp Duty',
    bodyCorporateFees: 'Body Corporate/Strata Fees',
    councilRates: 'Council Rates',
    waterRates: 'Water Rates',
    solicitorFees: 'Solicitor Fees',
    buildingLandlordInsurance: 'Building & Landlord Insurance',
    propertyManagementFees: 'Property Management',
    repairsMaintenance: 'Repairs & Maintenance',
    lettingFees: 'Letting Fees',
  };
  return Object.keys(report.manual_overrides).map((key) => ({
    key,
    displayName: fieldMappings[key] || key.replace(/([A-Z])/g, ' $1').trim(),
    value: report.manual_overrides[key],
  }));
}
