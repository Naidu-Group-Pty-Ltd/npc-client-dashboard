/**
 * The investment financial engine — every figure the calculator service
 * publishes, as pure arithmetic with no IO. `financial-calculator-service`
 * orchestrates (stamp duty schedule, live CPI cache, HTTP) and delegates all
 * calculation here; `generate-investment-report` derives its prompt-narrative
 * figures from the same helpers so the prose and the tables it introduces
 * cannot disagree.
 *
 * Why this module exists at all: the projections used to fold
 * `Object.values(annualCosts)` — an object that carries its own totals
 * (`totalAnnual`, `totalAnnualExcludingLandTax`) and a percentage beside the
 * line items — so every year of every stored 10-year series charged the
 * operating costs roughly three times over. Measured on a production row
 * ($1.19M property): stored year-1 operating expenses $59,931 against real
 * annual costs of $21,418, overstating the year-1 holding cost by ~$38k and
 * the 10-year cumulative position by ~$370k, while the headline metrics used
 * a different (un-inflated, land-tax-excluded) base — a $43,885/yr
 * contradiction printed on one page. The arithmetic lives once now, against
 * one cost base, and is pinned by `financialEngine.spec.ts` with that
 * production row.
 *
 * The one deliberate asymmetry: net rental YIELD excludes land tax (it is a
 * property-comparison metric and land tax depends on the owner's aggregated
 * landholdings, not the property), while every CASH FLOW figure includes it
 * (the money leaves the owner's account). Reports state the exclusion.
 */

export interface LoanCalculationInput {
  propertyValue: number;
  deposit: number;
  interestRate?: number; // Optional — the service fetches live rates if not provided
  loanTerm: number;
  weeklyRent: number;
  state: string;
  propertyType: 'house' | 'unit' | 'townhouse';
  isFirstHomeBuyer?: boolean;
  isNewBuild?: boolean;
  borrowerType?: 'owner_occupier' | 'investor';
  // Capital growth rate - if provided, uses this instead of hardcoded scenarios
  // This allows researched capital growth from Perplexity to cascade into projections
  capitalGrowthRate?: number;
  // CPI / expense growth rate - independent macro indicator, NOT tied to capital growth
  cpiGrowthRate?: number;
  // Rent growth rate - optional override (defaults to CPI-aligned)
  rentGrowthRate?: number;
  // Reviewed cost figures that replace the formula estimates AS INPUT, so the
  // totals, projections, sensitivity and metrics all describe them. Splatting
  // a reviewed figure over the output instead is how a stored row stops
  // footing against itself.
  annualCostOverrides?: AnnualCostOverrides;
  // An operator-supplied duty figure (e.g. from a settlement statement); the
  // schedule assessment still runs and is reported, but this value funds the
  // upfront position.
  stampDutyOverride?: number;
  legalFeesOverride?: number;
}

export interface AnnualCostOverrides {
  councilRates?: number;
  waterRates?: number;
  landlordInsurance?: number;
  propertyManagement?: number;
  propertyManagementPercent?: number;
  maintenance?: number;
  landTax?: number;
  strataFees?: number;
  /** No formula estimates this; present only when a reviewer supplied it. */
  lettingFees?: number;
}

export interface FinancialProjection {
  year: number;
  propertyValue: number;
  loanBalance: number;
  equity: number;
  annualRent: number;
  cashFlow: number;
  cumulativeCashFlow: number;
  roi: number;
}

export interface InterestRateInfo {
  rate: number;
  lvrTier: string;
  rateType: string;
  source: string;
  lmiRequired: boolean;
  lmiEstimate: number;
}

export interface CpiProjection {
  year: number;
  cpiPercent: number;
}

// LVR-based interest rate tiers (based on current market rates Dec 2024)
export const LVR_RATE_TIERS = {
  owner_occupier: {
    principal_interest: {
      tier_60: 5.99,    // LVR ≤ 60%
      tier_70: 6.04,    // LVR 60-70%
      tier_80: 6.14,    // LVR 70-80%
      tier_90: 6.44,    // LVR 80-90% (includes risk premium)
      tier_95: 6.74,    // LVR 90-95%
    },
    interest_only: {
      tier_60: 6.34,
      tier_70: 6.44,
      tier_80: 6.54,
      tier_90: 6.84,
      tier_95: 7.14,
    }
  },
  investor: {
    principal_interest: {
      tier_60: 6.19,
      tier_70: 6.29,
      tier_80: 6.44,
      tier_90: 6.74,
      tier_95: 7.04,
    },
    interest_only: {
      tier_60: 6.54,
      tier_70: 6.64,
      tier_80: 6.79,
      tier_90: 7.09,
      tier_95: 7.39,
    }
  }
};

export function getInterestRateByLVR(
  lvr: number,
  borrowerType: 'owner_occupier' | 'investor',
  providedRate?: number
): InterestRateInfo {
  // If rate is explicitly provided, use it
  if (providedRate !== undefined && providedRate > 0) {
    return {
      rate: providedRate,
      lvrTier: 'custom',
      rateType: 'user_provided',
      source: 'User specified',
      lmiRequired: lvr > 80,
      lmiEstimate: lvr > 80 ? calculateLMI(lvr) : 0
    };
  }

  const rates = LVR_RATE_TIERS[borrowerType].principal_interest;
  let rate: number;
  let tier: string;

  if (lvr <= 60) {
    rate = rates.tier_60;
    tier = '≤60%';
  } else if (lvr <= 70) {
    rate = rates.tier_70;
    tier = '60-70%';
  } else if (lvr <= 80) {
    rate = rates.tier_80;
    tier = '70-80%';
  } else if (lvr <= 90) {
    rate = rates.tier_90;
    tier = '80-90%';
  } else {
    rate = rates.tier_95;
    tier = '90-95%';
  }

  const lmiRequired = lvr > 80;
  const lmiEstimate = lmiRequired ? calculateLMI(lvr) : 0;

  return {
    rate,
    lvrTier: tier,
    rateType: 'principal_interest',
    source: 'Market rates Dec 2024 (LVR-adjusted)',
    lmiRequired,
    lmiEstimate
  };
}

export function calculateLMI(lvr: number): number {
  // Simplified LMI calculation based on typical LMI rates
  // Actual LMI varies by lender, loan amount, and LVR
  if (lvr <= 80) return 0;
  if (lvr <= 85) return 3500;
  if (lvr <= 90) return 8500;
  if (lvr <= 95) return 15000;
  return 25000;
}

export function calculateMonthlyPayment(loanAmount: number, monthlyRate: number, totalPayments: number): number {
  if (monthlyRate === 0) return loanAmount / totalPayments;

  return loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalPayments)) /
         (Math.pow(1 + monthlyRate, totalPayments) - 1);
}

export function calculateAnnualCosts(
  propertyValue: number,
  weeklyRent: number,
  state: string,
  propertyType: string,
  overrides?: AnnualCostOverrides,
) {
  const annualRent = weeklyRent * 52;
  const o = overrides ?? {};
  // `??` throughout: an explicit reviewed $0 replaces the estimate; only an
  // absent override falls back to the formula.
  const councilRates = o.councilRates ?? Math.floor(propertyValue * 0.008);
  const waterRates = o.waterRates ?? 800;
  const landlordInsurance = o.landlordInsurance ?? Math.floor(annualRent * 0.01);
  const propertyManagementPercent = o.propertyManagementPercent ?? 7;
  const propertyManagement = o.propertyManagement
    ?? Math.floor(annualRent * (propertyManagementPercent / 100));
  const maintenance = o.maintenance ?? 1500;
  const landTax = o.landTax ?? calculateLandTax(propertyValue, state);
  const strataFees = o.strataFees ?? (propertyType === 'unit' ? 4800 : 0);
  const lettingFees = o.lettingFees;

  // The totals foot against the final line items — whatever supplied them —
  // so everything downstream (operatingExpensesFrom prefers this footing)
  // describes the same costs the page lists.
  const totalAnnual = councilRates + waterRates + landlordInsurance + propertyManagement
    + maintenance + strataFees + landTax + (lettingFees ?? 0);
  const totalAnnualExcludingLandTax = totalAnnual - landTax;

  return {
    councilRates,
    waterRates,
    landlordInsurance,
    propertyManagement,
    propertyManagementPercent,
    maintenance,
    landTax,
    strataFees,
    ...(lettingFees !== undefined ? { lettingFees } : {}),
    totalAnnual,
    totalAnnualExcludingLandTax
  };
}

export function calculateLandTax(propertyValue: number, state: string): number {
  const thresholds: { [key: string]: number } = {
    'NSW': 755000,
    'VIC': 300000,
    'QLD': 600000,
    'WA': 300000,
    'SA': 391000,
    'TAS': 25000,
    'NT': 0,
    'ACT': 0
  };

  const threshold = thresholds[state.toUpperCase()] || 755000;

  if (propertyValue <= threshold) return 0;

  return Math.floor((propertyValue - threshold) * 0.015);
}

/**
 * The annual operating cost base (loan payments excluded) shared by the
 * projections, the sensitivity analysis and the headline cash-flow metrics.
 * One base is the point: a report quotes these figures beside each other and
 * a careful reader must be able to reconcile them.
 *
 * Never fold `Object.values(annualCosts)`: the object carries its own totals
 * and a percentage beside the line items, so a blind numeric sum charges
 * every cost roughly three times over (`3×totalAnnual − landTax + percent`)
 * — the defect that inflated every stored projection series.
 */
export function operatingExpensesFrom(annualCosts: any): number {
  const footed = annualCosts?.totalAnnual;
  if (typeof footed === 'number' && Number.isFinite(footed)) return footed;
  const LINE_ITEMS = [
    'councilRates', 'waterRates', 'landlordInsurance',
    'propertyManagement', 'maintenance', 'landTax', 'strataFees',
  ];
  return LINE_ITEMS.reduce(
    (sum, key) => sum + (typeof annualCosts?.[key] === 'number' ? annualCosts[key] : 0),
    0,
  );
}

export function generateProjections(
  input: LoanCalculationInput & { interestRate: number },
  monthlyPayment: number,
  annualCosts: any,
  capitalGrowthRate: number,
  rentGrowthRate: number,
  customCpiGrowth: number | null,
  cpiProjections: CpiProjection[],
): FinancialProjection[] {

  const projections: FinancialProjection[] = [];
  let currentPropertyValue = input.propertyValue;
  let currentRent = input.weeklyRent * 52;
  let loanBalance = input.propertyValue - input.deposit;
  let cumulativeCashFlow = 0;

  const loanPaymentsAnnual = monthlyPayment * 12;
  let currentOperatingExpenses = operatingExpensesFrom(annualCosts);

  for (let year = 1; year <= 10; year++) {
    currentPropertyValue *= (1 + capitalGrowthRate);
    currentRent *= (1 + rentGrowthRate);

    // CPI escalation for operating expenses (not loan payments)
    // Use custom override > year-specific projection > fallback 2.5%
    const yearCpi = customCpiGrowth !== null
      ? customCpiGrowth
      : (cpiProjections.find(p => p.year === year)?.cpiPercent ?? 2.5) / 100;
    currentOperatingExpenses *= (1 + yearCpi);

    const totalAnnualCosts = currentOperatingExpenses + loanPaymentsAnnual;

    const annualPrincipalPayment = loanPaymentsAnnual - (loanBalance * input.interestRate / 100);
    loanBalance = Math.max(0, loanBalance - annualPrincipalPayment);

    const annualCashFlow = currentRent - totalAnnualCosts;
    cumulativeCashFlow += annualCashFlow;

    const equity = currentPropertyValue - loanBalance;
    const roi = (annualCashFlow + (currentPropertyValue - input.propertyValue) / year) / input.deposit * 100;

    projections.push({
      year,
      propertyValue: Math.round(currentPropertyValue),
      loanBalance: Math.round(loanBalance),
      equity: Math.round(equity),
      annualRent: Math.round(currentRent),
      cashFlow: Math.round(annualCashFlow),
      cumulativeCashFlow: Math.round(cumulativeCashFlow),
      roi: Math.round(roi * 100) / 100
    });
  }

  return projections;
}

export function getDefaultCpiProjections(): CpiProjection[] {
  return generateConvergenceProjections(2.5);
}

export function generateConvergenceProjections(currentCpi: number): CpiProjection[] {
  const target = 2.5;
  const projections = [];
  for (let year = 1; year <= 10; year++) {
    const convergenceFactor = 1 - Math.pow(0.8, year);
    const projected = currentCpi + (target - currentCpi) * convergenceFactor;
    projections.push({ year, cpiPercent: Math.round(projected * 10) / 10 });
  }
  return projections;
}

export function calculateKeyMetrics(
  input: LoanCalculationInput & { interestRate: number },
  monthlyPayment: number,
  annualCosts: any,
  totalUpfront: number
) {
  const annualRent = input.weeklyRent * 52;
  // Cash flow shares the projections' cost base (all costs, land tax in);
  // yield keeps the owner-independent base and the report says so.
  const cashFlowCosts = operatingExpensesFrom(annualCosts);
  const yieldCosts = typeof annualCosts?.totalAnnualExcludingLandTax === 'number'
    ? annualCosts.totalAnnualExcludingLandTax
    : cashFlowCosts;

  const grossYield = (annualRent / input.propertyValue) * 100;
  const netYield = ((annualRent - yieldCosts) / input.propertyValue) * 100;
  const netCashFlow = annualRent - cashFlowCosts - (monthlyPayment * 12);

  return {
    grossRentalYield: Math.round(grossYield * 100) / 100,
    netRentalYield: Math.round(netYield * 100) / 100,
    weeklyNet: Math.round(netCashFlow / 52),
    annualNet: Math.round(netCashFlow),
    lvr: Math.round(((input.propertyValue - input.deposit) / input.propertyValue) * 100),
    // The denominator is the same figure initialCosts publishes as
    // totalUpfront — deposit, duty, LMI and the fee lines — never a second
    // derivation that can drift from the number printed above it.
    totalInvestment: totalUpfront,
    cashOnCashReturn: totalUpfront > 0
      ? Math.round((netCashFlow / totalUpfront) * 100 * 100) / 100
      : 0
  };
}

export function calculateSensitivityAnalysis(
  input: LoanCalculationInput & { interestRate: number },
  monthlyPayment: number,
  annualCosts: any
) {
  // Same single cost base as the projections and headline metrics — see
  // operatingExpensesFrom for why the raw object must never be folded.
  const baseNetCashFlow = (input.weeklyRent * 52) -
    operatingExpensesFrom(annualCosts) -
    (monthlyPayment * 12);

  return {
    interestRateChanges: {
      'minus1Percent': calculateImpact(input, input.interestRate - 1, annualCosts),
      'plus1Percent': calculateImpact(input, input.interestRate + 1, annualCosts),
      'plus2Percent': calculateImpact(input, input.interestRate + 2, annualCosts)
    },
    rentChanges: {
      'minus10Percent': baseNetCashFlow - (input.weeklyRent * 52 * 0.1),
      'plus10Percent': baseNetCashFlow + (input.weeklyRent * 52 * 0.1),
      'plus20Percent': baseNetCashFlow + (input.weeklyRent * 52 * 0.2)
    }
  };
}

export function calculateImpact(input: LoanCalculationInput & { interestRate: number }, newRate: number, annualCosts: any) {
  const loanAmount = input.propertyValue - input.deposit;
  const monthlyRate = newRate / 100 / 12;
  const totalPayments = input.loanTerm * 12;
  const newMonthlyPayment = calculateMonthlyPayment(loanAmount, monthlyRate, totalPayments);

  return (input.weeklyRent * 52) - operatingExpensesFrom(annualCosts) - (newMonthlyPayment * 12);
}

// ---------------------------------------------------------------------------
// Series-derived narrative helpers.
//
// A report's prose introduces the projections table it prints; every number
// the prose quotes about that table is derived FROM the series here, so the
// two cannot disagree whatever wrote the series.
// ---------------------------------------------------------------------------

/**
 * The operating costs a projection row implies: rent − loan payments − cash
 * flow. Holds by construction for every row `generateProjections` writes,
 * and doubles as the detector for historic rows written by the pre-fix fold
 * (implied opex ≈ 2–3× the recorded annual costs).
 */
export function impliedOpexFromSeries(row: any, annualLoanPayments: number): number | null {
  if (!row || typeof row.annualRent !== 'number' || typeof row.cashFlow !== 'number') return null;
  if (typeof annualLoanPayments !== 'number' || !Number.isFinite(annualLoanPayments) || annualLoanPayments <= 0) return null;
  return Math.round(row.annualRent - annualLoanPayments - row.cashFlow);
}

/** Thousands separation without consulting the runtime locale. */
const groupThousands = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Accounting sign convention that keeps the sign: a negative cash flow in
 * parentheses, a positive one as plain dollars. Wrapping `Math.abs` in
 * parentheses unconditionally — the previous formatting — rendered POSITIVE
 * cash flow as a loss.
 */
export function fmtCashFlow(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return v < 0 ? `($${groupThousands(Math.abs(v))})` : `$${groupThousands(v)}`;
}

/**
 * LVR for a projection row, computed from the balances the row carries. The
 * rows have no `lvr` field; binding one printed the literal placeholder
 * "XX%" into produced reports.
 */
export function seriesLvrPercent(row: any): string {
  if (!row || typeof row.loanBalance !== 'number' || typeof row.propertyValue !== 'number' || !row.propertyValue) return 'XX';
  return ((row.loanBalance / row.propertyValue) * 100).toFixed(1);
}

/** Sum of a scenario's yearly cash flows; 0 when the series is absent. */
export function cumulativeCashFlow(rows: unknown): number {
  return Array.isArray(rows)
    ? rows.reduce((sum: number, p: any) => sum + (typeof p?.cashFlow === 'number' ? p.cashFlow : 0), 0)
    : 0;
}

// ---------------------------------------------------------------------------
// Reconciling a STORED financial_calculations row at read time.
//
// ~1,170 historic rows were written by the pre-fix fold, and nothing re-writes
// a stored row until its report is regenerated — so every reader of stored
// financials (the template binding projection, the design-composer
// normaliser) reconciles here first. Two independent repairs:
//
//  * The inflated series is healed EXACTLY, not approximately. The old fold's
//    base reconstructs from the row's own aggregates
//    (2·totalAnnual + totalAnnualExcludingLandTax + percent — the aggregates
//    are original even where line items were later overridden, because
//    nothing ever rewrote them), each year's CPI compounding factor recovers
//    as impliedOpex ÷ that base, and the true cash flow follows. Detection is
//    unambiguous: the buggy base is provably ≥ 2× totalAnnual while a healthy
//    year-1 charge is ≤ ~1.1× (one year of CPI), so the 1.7 threshold cannot
//    misfire on either side.
//
//  * Totals are derived, never accepted: totalUpfront becomes the sum of the
//    upfront lines the row itself publishes (132 of 161 sampled rows carried
//    a total that did not foot against its own lines), and the headline
//    weekly/annual net and cash-on-cash are recomputed from the row's
//    components on the engine's one cost base. On a post-fix row every
//    recomputation equals what is stored, so this is a no-op there.
//
// The stored row is NEVER mutated — reconciliation returns a new object —
// and a row whose components are missing keeps its stored values: a heal
// that cannot establish its inputs must not guess.
// ---------------------------------------------------------------------------

export interface StoredFinancialsReconciliation {
  /** The reconciled object (the input, untouched, when nothing applied). */
  fin: any;
  /** Scenario keys whose series were healed from the fold inflation. */
  healedScenarios: string[];
  /** Whether the sensitivity block was healed alongside the series. */
  sensitivityHealed: boolean;
  /** Whether headline metrics were recomputed from components. */
  metricsReconciled: boolean;
  /** Whether totalUpfront was re-derived from the row's own lines. */
  totalUpfrontDerived: boolean;
}

const isRecord = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The threshold separating a CPI-escalated year-1 charge (≤ ~1.1×) from the fold (≥ 2×). */
const FOLD_DETECTION_RATIO = 1.7;

export function reconcileStoredFinancials(raw: unknown): StoredFinancialsReconciliation {
  const none = (fin: any): StoredFinancialsReconciliation => ({
    fin, healedScenarios: [], sensitivityHealed: false, metricsReconciled: false, totalUpfrontDerived: false,
  });
  if (!isRecord(raw)) return none(raw);

  const costs = isRecord(raw.annualCosts) ? raw.annualCosts : {};
  const loan = isRecord(raw.loanDetails) ? raw.loanDetails : {};
  const income = isRecord(raw.income) ? raw.income : {};
  const initial = isRecord(raw.initialCosts) ? raw.initialCosts : {};

  const totalAnnual = operatingExpensesFrom(costs);
  const monthlyPayment = asNum(loan.monthlyPayment);
  const annualLoanPayments = monthlyPayment !== null ? monthlyPayment * 12 : null;
  const weeklyRent = asNum(income.weeklyRent);
  const annualRent = weeklyRent !== null ? weeklyRent * 52 : asNum(income.annualRent);

  // What the old fold summed for THIS row: the line items (= totalAnnual)
  // plus every aggregate the object carries plus the percentage.
  const storedTotalAnnual = asNum(costs.totalAnnual);
  const storedExcl = asNum(costs.totalAnnualExcludingLandTax);
  const pct = asNum(costs.propertyManagementPercent) ?? 0;
  const foldBase = totalAnnual
    + (storedTotalAnnual ?? 0)
    + (storedExcl ?? 0)
    + pct;

  const fin: Record<string, any> = { ...raw };
  const result = none(fin);

  // ── the series ────────────────────────────────────────────────────────────
  const deposit = asNum(initial.deposit);
  const propertyValue0 = asNum(initial.propertyValue);
  if (isRecord(raw.projections) && totalAnnual > 0 && annualLoanPayments !== null && annualLoanPayments > 0 && foldBase > totalAnnual) {
    const healedProjections: Record<string, any> = { ...raw.projections };
    for (const [scenario, rows] of Object.entries(raw.projections)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const opex1 = impliedOpexFromSeries(rows[0], annualLoanPayments);
      if (opex1 === null || opex1 / totalAnnual < FOLD_DETECTION_RATIO) continue;

      let cumulative = 0;
      let healedAny = false;
      const healedRows = rows.map((row: any) => {
        const impliedOpex = impliedOpexFromSeries(row, annualLoanPayments);
        const annualRentN = asNum(row?.annualRent);
        if (impliedOpex === null || annualRentN === null || impliedOpex <= 0) {
          // A row the heal cannot establish keeps its stored values; the
          // running total still counts what the row says.
          cumulative += asNum(row?.cashFlow) ?? 0;
          return row;
        }
        // The CPI compounding factor this row was escalated by, recovered
        // from the inflated charge itself; the true charge is the real cost
        // base under the same factor.
        const cpiFactor = impliedOpex / foldBase;
        const healedOpex = totalAnnual * cpiFactor;
        const cashFlow = Math.round(annualRentN - annualLoanPayments - healedOpex);
        cumulative += cashFlow;
        healedAny = true;
        const healed: Record<string, any> = { ...row, cashFlow, cumulativeCashFlow: Math.round(cumulative) };
        const year = asNum(row?.year);
        const pv = asNum(row?.propertyValue);
        if (deposit !== null && deposit > 0 && propertyValue0 !== null && year !== null && year > 0 && pv !== null) {
          healed.roi = Math.round(((cashFlow + (pv - propertyValue0) / year) / deposit) * 100 * 100) / 100;
        }
        return healed;
      });
      if (healedAny) {
        healedProjections[scenario] = healedRows;
        result.healedScenarios.push(scenario);
      }
    }
    if (result.healedScenarios.length) fin.projections = healedProjections;
  }

  // ── the sensitivity block, written by the same fold ───────────────────────
  if (result.healedScenarios.length && isRecord(raw.sensitivityAnalysis) && annualRent !== null && annualLoanPayments !== null) {
    const sens = raw.sensitivityAnalysis;
    const rents = isRecord(sens.rentChanges) ? sens.rentChanges : null;
    const storedMinus10 = rents ? asNum(rents.minus10Percent) : null;
    // Identity check before touching anything: the stored base the fold
    // produced must reconstruct from this row's own numbers, or the block
    // was written by some other hand and stays as it is.
    const expectedFoldBaseNet = annualRent - foldBase - annualLoanPayments;
    if (storedMinus10 !== null && Math.abs(storedMinus10 + annualRent * 0.1 - expectedFoldBaseNet) <= 5) {
      const excess = foldBase - totalAnnual;
      const healedBaseNet = annualRent - totalAnnual - annualLoanPayments;
      const healedSens: Record<string, any> = { ...sens };
      if (rents) {
        healedSens.rentChanges = {
          ...rents,
          minus10Percent: healedBaseNet - annualRent * 0.1,
          plus10Percent: healedBaseNet + annualRent * 0.1,
          plus20Percent: healedBaseNet + annualRent * 0.2,
        };
      }
      if (isRecord(sens.interestRateChanges)) {
        // Only the payment leg varies with the rate, so the fold's excess is
        // a constant additive error on every rate scenario.
        const healedRates: Record<string, any> = {};
        for (const [k, v] of Object.entries(sens.interestRateChanges)) {
          const n = asNum(v);
          healedRates[k] = n === null ? v : n + excess;
        }
        healedSens.interestRateChanges = healedRates;
      }
      fin.sensitivityAnalysis = healedSens;
      result.sensitivityHealed = true;
    }
  }

  // ── totals derived from the row's own lines ───────────────────────────────
  const stampDuty = asNum(initial.stampDuty);
  let derivedUpfront: number | null = null;
  if (deposit !== null && stampDuty !== null) {
    derivedUpfront = deposit + stampDuty + (asNum(initial.lmi) ?? 0)
      + (asNum(initial.legalFees) ?? 0) + (asNum(initial.inspectionFees) ?? 0);
    if (derivedUpfront !== asNum(initial.totalUpfront)) {
      fin.initialCosts = { ...initial, totalUpfront: derivedUpfront };
      result.totalUpfrontDerived = true;
    }
  }

  // ── headline metrics recomputed from components ───────────────────────────
  if (isRecord(raw.keyMetrics) && totalAnnual > 0 && annualRent !== null && annualLoanPayments !== null && annualLoanPayments > 0) {
    const km = raw.keyMetrics;
    const netCashFlow = annualRent - totalAnnual - annualLoanPayments;
    const denominator = derivedUpfront ?? asNum(initial.totalUpfront) ?? asNum(km.totalInvestment);
    const healedKm: Record<string, any> = {
      ...km,
      annualNet: Math.round(netCashFlow),
      weeklyNet: Math.round(netCashFlow / 52),
    };
    if (denominator !== null && denominator > 0) {
      healedKm.totalInvestment = denominator;
      healedKm.cashOnCashReturn = Math.round((netCashFlow / denominator) * 100 * 100) / 100;
    }
    if (
      healedKm.annualNet !== km.annualNet
      || healedKm.weeklyNet !== km.weeklyNet
      || healedKm.totalInvestment !== km.totalInvestment
      || healedKm.cashOnCashReturn !== km.cashOnCashReturn
    ) {
      fin.keyMetrics = healedKm;
      result.metricsReconciled = true;
    }
  }

  return result;
}
