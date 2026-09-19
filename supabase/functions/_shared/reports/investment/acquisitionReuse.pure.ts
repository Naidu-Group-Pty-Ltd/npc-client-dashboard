/**
 * Whether a persisted acquisition result may be reused on a continuation, one
 * dependency at a time.
 *
 * ## Why this is not "skip acquisition on continuation"
 *
 * A blanket gate is the wrong shape twice over. It would reuse a result
 * acquired for a different subject or under a different accepted input, and it
 * would freeze a *failed* acquisition as permanent — so a register that was
 * merely unreachable for four seconds would be reported as holding nothing
 * about the property, for the life of the report.
 *
 * So reuse is decided per dependency, and it is refused unless the stored
 * object can PROVE it describes this subject under these inputs. That is the
 * rule `locationEnrichmentReuse` already established for the enrichment
 * (RF-7.2B.1B1); this generalises it to the rest of the acquisition phase,
 * which today re-runs in full on every continuation because the early-persist
 * block guards the WRITE and nothing guards the FETCH.
 *
 * ## The four refusals
 *
 * 1. **No stamp** — a legacy object that cannot say what it describes is never
 *    reused. It re-acquires exactly as before, which is why adopting this
 *    cannot change any existing report.
 * 2. **Different subject** — address, postcode or state differ. A result about
 *    somewhere else is worse than no result.
 * 3. **Different accepted inputs** — the operator's submitted scenario changed,
 *    so anything derived from price, rent, LVR or loan terms is stale by
 *    definition. Geography-only dependencies are unaffected and say so.
 * 4. **Too old** — each class carries its own shelf life. A cadastral zoning
 *    answer is good for far longer than a market median.
 *
 * And one rule that is not a refusal: a dependency whose last attempt FAILED is
 * always re-attempted. Failure is a fact about that attempt, never about the
 * property.
 */

/** What a stored acquisition result must carry to be reusable. */
export interface AcquisitionStamp {
  /** The address the result was acquired for, as submitted. */
  address: string;
  /** The postcode resolved at acquisition time, if any. */
  postcode: string | null;
  /** The state resolved at acquisition time, if any. */
  state: string | null;
  /**
   * A digest of the accepted inputs this result was derived under. Anything
   * financial must re-acquire when this changes; geography need not.
   */
  inputRevision: string;
  /** When the result was acquired (ISO 8601). */
  acquiredAt: string;
  /** The shape version of the stored payload. */
  schemaVersion: number;
  /** Whether the acquisition succeeded. A failure is never reused. */
  outcome: 'answered' | 'empty' | 'failed';
}

/** The subject and inputs the CURRENT invocation is working on. */
export interface AcquisitionSubject {
  address: string;
  postcode: string | null;
  state: string | null;
  inputRevision: string;
}

/**
 * What a dependency's answer depends on. Decides which changes invalidate it.
 *
 * `geography` results survive a change of accepted inputs — a flood overlay does
 * not move because the operator revised the interest rate. `financial` results
 * do not. `both` is the conservative default for anything mixed.
 */
export type DependencySensitivity = 'geography' | 'financial' | 'both';

/** How long each class of answer stays good, in hours. */
export const REUSE_SHELF_LIFE_HOURS = {
  /** Cadastral and statutory layers: zoning, overlays, lot geometry. */
  cadastral: 24 * 30,
  /** Census, SEIFA and other periodic official statistics. */
  statistical: 24 * 30,
  /** Registers that publish on a cadence: crime, planning applications. */
  register: 24 * 7,
  /** Anything with a market price in it. */
  market: 24,
  /** Derived from the operator's own inputs. */
  derived: 24,
} as const;

export type ReuseClass = keyof typeof REUSE_SHELF_LIFE_HOURS;

export interface DependencyPolicy {
  sensitivity: DependencySensitivity;
  reuseClass: ReuseClass;
}

export type ReuseDecision =
  | { reuse: true; reason: 'valid'; ageHours: number }
  | {
      reuse: false;
      reason:
        | 'no_stamp'
        | 'subject_changed'
        | 'inputs_changed'
        | 'schema_changed'
        | 'expired'
        | 'previous_attempt_failed'
        | 'no_stored_value';
    };

function normaliseAddress(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hoursBetween(thenIso: string, nowMs: number): number | null {
  const then = Date.parse(thenIso);
  if (!Number.isFinite(then)) return null;
  return (nowMs - then) / 3_600_000;
}

/**
 * May this stored result be reused for this subject, now?
 *
 * `storedValue` is passed so an absent or empty payload can never be "reused"
 * into overwriting a later, valid acquisition — the continuation object being
 * empty is not a reason to keep it.
 */
export function assessReuse(args: {
  storedValue: unknown;
  stamp: AcquisitionStamp | null | undefined;
  subject: AcquisitionSubject;
  policy: DependencyPolicy;
  currentSchemaVersion: number;
  nowMs: number;
}): ReuseDecision {
  const { storedValue, stamp, subject, policy, currentSchemaVersion, nowMs } = args;

  if (storedValue === null || storedValue === undefined) {
    return { reuse: false, reason: 'no_stored_value' };
  }
  if (!stamp) {
    // A legacy object with no provenance. Re-acquire, exactly as today.
    return { reuse: false, reason: 'no_stamp' };
  }
  if (stamp.outcome === 'failed') {
    // Never freeze a transient failure into a permanent absence.
    return { reuse: false, reason: 'previous_attempt_failed' };
  }
  if (stamp.schemaVersion !== currentSchemaVersion) {
    return { reuse: false, reason: 'schema_changed' };
  }

  if (normaliseAddress(stamp.address) !== normaliseAddress(subject.address)) {
    return { reuse: false, reason: 'subject_changed' };
  }
  // A null on either side is not a match: we cannot show it describes the same
  // place, and reusing across a jurisdiction boundary is the worst failure here.
  if ((stamp.postcode ?? null) !== (subject.postcode ?? null)) {
    return { reuse: false, reason: 'subject_changed' };
  }
  if ((stamp.state ?? null) !== (subject.state ?? null)) {
    return { reuse: false, reason: 'subject_changed' };
  }

  if (policy.sensitivity !== 'geography' && stamp.inputRevision !== subject.inputRevision) {
    return { reuse: false, reason: 'inputs_changed' };
  }

  const ageHours = hoursBetween(stamp.acquiredAt, nowMs);
  if (ageHours === null || ageHours < 0) {
    return { reuse: false, reason: 'expired' };
  }
  if (ageHours > REUSE_SHELF_LIFE_HOURS[policy.reuseClass]) {
    return { reuse: false, reason: 'expired' };
  }

  return { reuse: true, reason: 'valid', ageHours };
}

/**
 * A stable digest of the accepted inputs, for `inputRevision`.
 *
 * Only the fields that actually change a derived figure are included, so an
 * unrelated edit does not throw away good research. Key order is normalised so
 * two equal scenarios always produce the same revision.
 */
export function inputRevisionOf(overrides: Record<string, unknown> | null | undefined): string {
  const MATERIAL_KEYS = [
    'purchasePrice', 'landPrice', 'buildPrice', 'depositValue', 'loanToValueRatio',
    'interestRate', 'capitalGrowth', 'weeklyRent', 'occupancyRate', 'loanType',
    'loanTermYears', 'loanAmount', 'interestOnlyPeriodYears', 'stampDuty',
    'propertyType', 'buildType', 'isFirstHomeBuyer',
  ];
  const source = overrides ?? {};
  const parts: string[] = [];
  for (const key of MATERIAL_KEYS.slice().sort()) {
    const value = (source as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length === 0 ? 'empty' : parts.join('&');
}

/**
 * Merge a freshly acquired value over a stored one, without ever letting an
 * absence destroy evidence.
 *
 * The continuation path re-enters with a partially-populated object, and a
 * naive spread would write `undefined` over a good stored result. The rule:
 * only a value that was actually acquired replaces what is banked.
 */
export function mergeAcquired<T>(stored: T | null | undefined, fresh: T | null | undefined): T | null {
  if (fresh !== null && fresh !== undefined) return fresh;
  if (stored !== null && stored !== undefined) return stored;
  return null;
}
