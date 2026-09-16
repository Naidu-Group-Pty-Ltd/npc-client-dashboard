import { describe, expect, it } from 'vitest';
import { amortisingPayment, buildLoanLedger, describeLoanStructure, ledgerYear } from '@/lib/reports/investment/loanLedger.pure';

/**
 * Gate 2 of the audit's acceptance criteria (QA-291SM-20260915), verified
 * against the engine rather than reasoned: for L = $1,039,200, r = 6.5%,
 * n = 360 the monthly payment is $6,568.4509 and the year-10 balance is
 * $880,993.51 (QA-05); a pure interest-only loan pays $67,548 a year with no
 * principal reduction before its stated transition (QA-04).
 */
describe('buildLoanLedger', () => {
  const L = 1_039_200;

  it('reproduces the audited P&I payment and the monthly-consistent year-10 balance (QA-05)', () => {
    const ledger = buildLoanLedger({ loanAmount: L, annualRatePercent: 6.5, termYears: 30 });
    expect(ledger.loanType).toBe('principal_interest');
    expect(ledger.firstMonthlyPayment).toBeCloseTo(6_568.4509, 3);
    expect(ledgerYear(ledger, 10)!.closingBalance).toBeCloseTo(880_993.51, 1);
    // The audit's other reconstruction points, to the cent.
    expect(ledgerYear(ledger, 1)!.closingBalance).toBeCloseTo(1_027_584.60, 1);
    expect(ledgerYear(ledger, 5)!.closingBalance).toBeCloseTo(972_805.28, 1);
    // Every year foots: opening + interest − payments = closing.
    for (const y of ledger.years) {
      expect(y.openingBalance + y.interest - y.payments).toBeCloseTo(y.closingBalance, 6);
    }
    expect(ledger.years[29].closingBalance).toBeCloseTo(0, 4);
    expect(ledger.totalInterest).toBeCloseTo(6_568.4509 * 360 - L, 0);
  });

  it('the annual-accrual shortcut the report used is NOT what this produces', () => {
    const ledger = buildLoanLedger({ loanAmount: L, annualRatePercent: 6.5, termYears: 30 });
    let annualShortcut = L;
    for (let y = 1; y <= 10; y += 1) annualShortcut = annualShortcut * 1.065 - 6_568.4509 * 12;
    expect(annualShortcut).toBeCloseTo(887_071.83, 0);
    expect(ledgerYear(ledger, 10)!.closingBalance).toBeLessThan(annualShortcut - 6_000);
  });

  it('an interest-only loan pays interest alone for its period and amortises after (QA-04)', () => {
    const ledger = buildLoanLedger({ loanAmount: L, annualRatePercent: 6.5, termYears: 30, loanType: 'interest_only', interestOnlyYears: 5 });
    expect(ledger.firstMonthlyPayment).toBeCloseTo(L * 0.065 / 12, 6);
    expect(ledgerYear(ledger, 1)!.payments).toBeCloseTo(67_548, 0);
    expect(ledgerYear(ledger, 1)!.principal).toBe(0);
    expect(ledgerYear(ledger, 5)!.closingBalance).toBe(L);
    expect(ledgerYear(ledger, 5)!.interestOnly).toBe(true);
    expect(ledgerYear(ledger, 6)!.interestOnly).toBe(false);
    expect(ledgerYear(ledger, 6)!.principal).toBeGreaterThan(0);
    expect(ledger.amortisingMonthlyPayment).toBeCloseTo(amortisingPayment(L, 0.065 / 12, 300), 6);
    expect(ledger.years[29].closingBalance).toBeCloseTo(0, 4);
    expect(describeLoanStructure(ledger)).toBe('Interest only for 5 years, then principal and interest over the remaining 25 years (30-year term)');
  });

  it('an interest-only label with no period is a P&I schedule — the label alone changes nothing', () => {
    const ledger = buildLoanLedger({ loanAmount: L, annualRatePercent: 6.5, termYears: 30, loanType: 'interest_only', interestOnlyYears: 0 });
    expect(ledger.interestOnlyYears).toBe(0);
    expect(ledger.firstMonthlyPayment).toBeCloseTo(6_568.4509, 3);
    expect(describeLoanStructure(ledger)).toBe('Principal and interest over 30 years');
  });

  it('handles a zero rate and caps an interest-only period inside the term', () => {
    const zero = buildLoanLedger({ loanAmount: 120_000, annualRatePercent: 0, termYears: 10 });
    expect(zero.firstMonthlyPayment).toBe(1_000);
    expect(zero.years[9].closingBalance).toBeCloseTo(0, 6);
    const capped = buildLoanLedger({ loanAmount: L, annualRatePercent: 6.5, termYears: 5, loanType: 'interest_only', interestOnlyYears: 40 });
    expect(capped.interestOnlyYears).toBe(4);
    expect(capped.years[4].closingBalance).toBeCloseTo(0, 4);
  });
});
