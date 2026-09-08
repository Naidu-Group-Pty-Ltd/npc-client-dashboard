import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  VERIFICATION_ATTEMPT_TOKENS,
  VERIFICATION_RESERVE_TOKENS,
  VERIFICATION_SUCCESS_TOKENS,
  VERIFIED_OUTCOMES,
  WORKSPACE_OUT_OF_TOKENS,
  describeVerificationCharge,
  isVerifiedOutcome,
  verificationTokenCharge,
} from '../../../supabase/functions/_shared/aml/verificationTokenPrice.pure.ts';
import {
  OUTCOME_TO_STATUS,
} from '../../../supabase/functions/_shared/aml/verificationOutcome.pure.ts';

/**
 * What an identity verification costs a workspace.
 *
 * Didit bills Aurixa USD 0.30 for a complete verification and that cost is the
 * platform's; a workspace pays 5 tokens for a consumed attempt and 5 more when
 * the identity is actually verified. These tests hold the properties that make
 * that charge correct rather than merely present.
 */

const read = (p: string) => readFileSync(p, 'utf8');
const standalone = read('supabase/functions/_shared/aml/standaloneVerification.ts');
const legacy = read('supabase/functions/aml-verification/index.ts');
const estimator = read('supabase/functions/_shared/tokenEstimator.ts');

describe('the price', () => {
  it('is 5 for an attempt and 5 more for a success', () => {
    expect(VERIFICATION_ATTEMPT_TOKENS).toBe(5);
    expect(VERIFICATION_SUCCESS_TOKENS).toBe(5);
  });

  it('reserves the worst case, derived from the two rather than typed a third time', () => {
    expect(VERIFICATION_RESERVE_TOKENS)
      .toBe(VERIFICATION_ATTEMPT_TOKENS + VERIFICATION_SUCCESS_TOKENS);
    // A reservation smaller than the maximum charge would let a success land
    // that the workspace could not pay for — it fails only for a workspace
    // near its balance, which is the worst possible way to find out.
    expect(VERIFICATION_RESERVE_TOKENS).toBeGreaterThanOrEqual(
      verificationTokenCharge({ attemptConsumed: true, outcome: 'passed' }));
  });
});

describe('what is charged', () => {
  it('charges nothing where no attempt was consumed', () => {
    for (const outcome of ['passed', 'verified', 'failed', 'referred', null, undefined]) {
      expect(verificationTokenCharge({ attemptConsumed: false, outcome })).toBe(0);
    }
  });

  it('charges the attempt alone for every decline', () => {
    for (const outcome of ['failed', 'referred', 'exhausted', 'manual_review', 'pending']) {
      expect(verificationTokenCharge({ attemptConsumed: true, outcome })).toBe(5);
    }
  });

  it('charges attempt plus success only where the identity was verified', () => {
    expect(verificationTokenCharge({ attemptConsumed: true, outcome: 'passed' })).toBe(10);
    expect(verificationTokenCharge({ attemptConsumed: true, outcome: 'verified' })).toBe(10);
  });

  it('treats an unrecognised status as a decline, never as a success', () => {
    // The conservative side: a status this module has never heard of must not
    // earn a surcharge nobody can justify.
    expect(verificationTokenCharge({ attemptConsumed: true, outcome: 'something_new' })).toBe(5);
    expect(isVerifiedOutcome('something_new')).toBe(false);
    expect(isVerifiedOutcome(null)).toBe(false);
  });
});

describe('both success vocabularies are named', () => {
  /**
   * The defect this guards. The standalone route settles
   * `verification_checks.status` from `canonicalOutcome`, where success is
   * `passed`; the legacy staff route stores the adapter's own word on
   * `identity_checks.status`, where success is `verified`. A charge written
   * against one spelling silently never fires on the other.
   */
  it('knows the canonical spelling the standalone route actually writes', () => {
    const canonicalSuccess = OUTCOME_TO_STATUS.verified;
    expect(canonicalSuccess).toBe('passed');
    expect(VERIFIED_OUTCOMES.has(canonicalSuccess)).toBe(true);
  });

  it('knows the provider spelling the legacy route stores', () => {
    expect(VERIFIED_OUTCOMES.has('verified')).toBe(true);
  });

  it('admits nothing that is not a verification', () => {
    for (const status of Object.values(OUTCOME_TO_STATUS)) {
      if (status === 'passed') continue;
      expect(VERIFIED_OUTCOMES.has(status)).toBe(false);
    }
    // A referral is a case a human must still decide.
    expect(VERIFIED_OUTCOMES.has('referred')).toBe(false);
    expect(VERIFIED_OUTCOMES.has('manual_review')).toBe(false);
  });
});

describe('the reservation is taken before anything is spent', () => {
  it('holds tokens after the free steps and before the first paid call', () => {
    const reserveAt = standalone.indexOf('holdVerificationTokens(check, checkId)');
    const firstPaidCall = standalone.indexOf("meter('id_verification'");
    expect(reserveAt).toBeGreaterThan(-1);
    expect(firstPaidCall).toBeGreaterThan(-1);
    expect(reserveAt).toBeLessThan(firstPaidCall);
    // …and after the download, so a missing object never holds a balance.
    expect(reserveAt).toBeGreaterThan(standalone.indexOf('storage_unreadable'));
  });

  it('refuses without calling the vendor when Mission Control says no', () => {
    const refusal = standalone.slice(
      standalone.indexOf('const hold = await holdVerificationTokens'),
      standalone.indexOf("const vendorData = buildVendorData"));
    // The imported constant, never the literal re-typed at the call site.
    expect(refusal).toContain('WORKSPACE_OUT_OF_TOKENS');
    expect(refusal).not.toContain(`'${WORKSPACE_OUT_OF_TOKENS}'`);
    expect(refusal).toContain("outcome: 'technical_failure'");
    // No attempt is consumed and no customer outcome is written.
    expect(refusal).not.toContain('attempt_consumed: true');
    expect(refusal).not.toContain('status:');
  });

  it('proceeds unmetered when Mission Control is merely unreachable', () => {
    const helper = standalone.slice(
      standalone.indexOf('async function holdVerificationTokens'),
      standalone.indexOf('export async function runStandaloneVerification'));
    // Only an explicit refusal returns null (which is what blocks the run).
    expect(helper).toContain('if (err instanceof InsufficientTokensError) return null;');
    expect(helper).toContain('unmeteredHold(');
  });
});

describe('the charge is settled from the row, once', () => {
  it('reads the same attempt_consumed the row is about to carry', () => {
    expect(standalone).toContain(
      'const charge = { attemptConsumed: outcome.attemptConsumed, outcome: outcome.status };');
    expect(standalone).toContain('hold.settle(verificationTokenCharge(charge)');
  });

  it('gives the whole hold back on a retake and on a provider failure', () => {
    expect(standalone).toContain("hold.release('capture_unusable')");
    expect(standalone).toContain('hold.release(`provider_error:${category}`)');
  });

  it('never turns a settle failure into a verification failure', () => {
    const settle = standalone.slice(
      standalone.indexOf('const settle = async ('),
      standalone.indexOf('return {\n    jobId,'));
    expect(settle).toContain('settle_failed: true');
    expect(settle).not.toMatch(/\bthrow\b/);
  });
});

describe('one price list', () => {
  it('the legacy route reserves the shared amount rather than a literal', () => {
    expect(legacy).toContain('const IDV_ESTIMATED_TOKENS = VERIFICATION_RESERVE_TOKENS;');
    expect(legacy).not.toContain('IDV_ESTIMATED_TOKENS = 400');
    // …and commits what was actually earned, not the reservation.
    expect(legacy).toContain('const chargedTokens = verificationTokenCharge(charge);');
    expect(legacy).toContain('await commitTokens(reservation.jobId, chargedTokens,');
  });

  it('the fallback estimator agrees with what is reserved', () => {
    expect(estimator).toContain('"aml_identity_check": VERIFICATION_RESERVE_TOKENS');
    expect(estimator).not.toContain('"aml_identity_check": 4');
  });
});

describe('a workspace with no tokens is not a provider fault', () => {
  it('has its own category and is never spelled as the vendor running dry', () => {
    expect(WORKSPACE_OUT_OF_TOKENS).toBe('workspace_out_of_tokens');
    // `insufficient_credits` means DIDIT's balance is empty and sends an
    // operator to top up the vendor account — the opposite remedy.
    expect(WORKSPACE_OUT_OF_TOKENS).not.toBe('insufficient_credits');
  });

  it('the column can record it', () => {
    const migration = read(
      'supabase/migrations/20261114090000_verification_workspace_out_of_tokens.sql');
    expect(migration).toContain(`'${WORKSPACE_OUT_OF_TOKENS}'`);
    expect(migration).toContain('verification_checks_provider_error_category_check');
    // Asserted by its effect on the database, not by the statement having run.
    expect(migration).toContain('RAISE EXCEPTION');
  });
});

describe('how the charge reads back', () => {
  it('says what was charged and why', () => {
    expect(describeVerificationCharge({ attemptConsumed: false, outcome: 'referred' }))
      .toBe('no attempt consumed — nothing charged');
    expect(describeVerificationCharge({ attemptConsumed: true, outcome: 'passed' }))
      .toBe('5 attempt + 5 verified = 10 tokens');
    expect(describeVerificationCharge({ attemptConsumed: true, outcome: 'failed' }))
      .toBe('5 attempt (failed) = 5 tokens');
  });
});
