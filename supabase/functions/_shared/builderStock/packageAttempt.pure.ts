/**
 * "We started reading that package and never came back."
 *
 * WHY THIS EXISTS. `recoverPackageImage` downloads a multi-megabyte PDF,
 * extracts its rasters and classifies them, and once begun nothing stops it.
 * When the edge worker kills the invocation partway through — `CPU Time
 * exceeded`, `Memory limit exceeded` — there is no throw to catch, no `finally`
 * that runs and no response to inspect. The process simply ends.
 *
 * Every guard the repair already has is blind to that. `MAX_ITEMS_RESTORED_PER_RUN`
 * and `MAX_PACKAGE_RECOVERIES_PER_RUN` are counters that reset with the run.
 * `PACKAGE_RECOVERY_RESERVE_MS` reserves WALL CLOCK, and the binding limit here
 * is CPU and memory. The `try/catch` around the recovery cannot catch a kill.
 * So the next tick reads the same queue, reaches the same property, starts the
 * same download and dies at the same place — for ever.
 *
 * PRODUCTION, 28 AUGUST 2026. Upload `eccc9840` settled twelve properties and
 * then stopped dead on the thirteenth, Lot 104 Finch Road. Every tick from
 * 02:00 onward booted, ran six to nine seconds and was killed, alternating
 * `CPU Time exceeded` and `Memory limit exceeded`, emitting no tick log at all.
 * `source_images_settled_version` stayed NULL, so the upload never settled, so
 * the fallback ladder was never entered, so three properties stayed blank on
 * the live Marketplace. One heavy package held twenty-three properties still.
 *
 * THE ANSWER IS TO WRITE SOMETHING DOWN BEFORE THE DANGEROUS STEP, which is
 * the same shape as the repair claim the sanitizer already uses: a
 * compare-and-set before the spend, so that being killed is survivable
 * evidence rather than silence. An attempt is recorded, the step runs, and a
 * verdict overwrites the attempt. A kill leaves the attempt standing, and the
 * next tick can SEE it.
 *
 * IT SHARES `source_provenance_result` WITH THE VERDICT, AND THAT IS SAFE BY
 * CONSTRUCTION. `negativeProvenanceStillStands` returns false for any record
 * whose `result` is not `no_deterministic_image`, so an attempt record reads as
 * "no answer yet — ask again". That is the fail-open direction that module
 * chose deliberately, and this leans on it rather than modifying it: no new
 * column, no new table, no change to what a verdict means.
 */
import {
  recordNoDeterministicImage,
  type ProvenanceQuestion,
} from './negativeProvenance.pure.ts';

/** The marker. Deliberately not a verdict, and never mistaken for one. */
export const PACKAGE_RECOVERY_ATTEMPT = 'package_recovery_attempt' as const;

/**
 * How many times one package may kill the worker before the sweep moves on.
 *
 * TWO, then the third tick gives up. A kill can be transient — a cold cache, a
 * slow origin, another tenant's noisy neighbour — so one is too eager and would
 * retire a package that would have read fine. Each wasted attempt costs one
 * five-minute tick and nothing else, because the attempt is written before the
 * spend rather than after it.
 */
export const MAX_PACKAGE_ATTEMPTS = 2;

export interface PackageAttemptRecord {
  result: typeof PACKAGE_RECOVERY_ATTEMPT;
  provenance_version: number;
  package_reference: string;
  source_anchor: string | null;
  /** How many times this exact question has been started and not finished. */
  attempts: number;
  started_at: string;
}

/** Is this stored record an attempt at the question being asked now? */
function attemptFor(
  stored: unknown,
  question: ProvenanceQuestion,
): PackageAttemptRecord | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Partial<PackageAttemptRecord>;
  if (record.result !== PACKAGE_RECOVERY_ATTEMPT) return null;

  // The same three keys the verdict compares, for the same reasons: a version
  // bump, a swapped package or a different source row is a NEW question, and
  // its attempt count must start again rather than inherit somebody else's.
  if (Number(record.provenance_version) !== question.provenanceVersion) return null;
  if (record.package_reference !== question.packageReference) return null;
  if ((record.source_anchor ?? null) !== question.sourceAnchor) return null;

  return record as PackageAttemptRecord;
}

/** How many times this exact question has been started and not finished. */
export function attemptsSoFar(stored: unknown, question: ProvenanceQuestion): number {
  const record = attemptFor(stored, question);
  if (!record) return 0;
  const attempts = Number(record.attempts);
  return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
}

/**
 * The record to write BEFORE the recovery runs.
 *
 * Written first and overwritten by the verdict, so the only way this survives
 * is for the step never to have finished.
 */
export function recordPackageAttempt(
  stored: unknown,
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
): PackageAttemptRecord {
  return {
    result: PACKAGE_RECOVERY_ATTEMPT,
    provenance_version: question.provenanceVersion,
    package_reference: question.packageReference,
    source_anchor: question.sourceAnchor,
    attempts: attemptsSoFar(stored, question) + 1,
    started_at: now().toISOString(),
  };
}

/** Has this package had its chances? */
export function packageAttemptsExhausted(
  stored: unknown,
  question: ProvenanceQuestion,
): boolean {
  return attemptsSoFar(stored, question) >= MAX_PACKAGE_ATTEMPTS;
}

/**
 * The terminal answer for a package that cannot be processed here.
 *
 * A VERDICT, AND AN HONEST ONE. It is the existing `no_deterministic_image` —
 * this repository has exactly one negative result and this does not invent a
 * second — with a detail that says what actually happened, so an operator
 * reading the column is not told the builder's package was empty when the truth
 * is that we could not open it within an edge worker's limits.
 *
 * Writing it is what lets the upload settle, and settling is what admits the
 * property to stage B and stage C. The alternative is not "we keep trying": the
 * alternative is the whole upload pinned and every property behind it blank.
 */
export function recordPackageUnprocessable(
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
) {
  return recordNoDeterministicImage(
    question,
    `This package could not be processed within the worker's resource limits `
    + `after ${MAX_PACKAGE_ATTEMPTS} attempts, so no builder image was taken `
    + `from it.`,
    now,
  );
}
