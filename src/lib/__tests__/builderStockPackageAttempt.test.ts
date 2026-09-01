/**
 * BUILDER STOCK — ONE HEAVY PACKAGE MUST NOT PIN AN ENTIRE UPLOAD.
 *
 * PRODUCTION, 28 AUGUST 2026. Upload `eccc9840` settled twelve properties and
 * then stopped dead on the thirteenth — Lot 104, Finch Road, Century Estate,
 * package folder `1K8Pl5x…`. Every tick from 02:00 onward did the same thing:
 *
 *   02:00:02 booted → 02:00:11  CPU Time exceeded / shutdown
 *   02:05:01 booted → 02:05:07  CPU Time exceeded / shutdown
 *   02:15:01 booted → 02:15:08  CPU Time exceeded / shutdown
 *   02:20:01 booted → 02:20:07  Memory limit exceeded / shutdown
 *
 * No tick log was ever emitted, because the log line comes after the work. The
 * upload's `source_images_settled_version` stayed NULL, so it never settled, so
 * the fallback ladder was never entered, so Lot 13, Lot 1663 and Lot 3 Yamanto
 * stayed blank on the live Marketplace. Twenty-three properties held still by
 * one document.
 *
 * WHY NOTHING ALREADY CAUGHT IT. `recoverPackageImage` is uninterruptible and a
 * worker kill raises nothing — no throw to catch, no `finally`, no response.
 * `MAX_ITEMS_RESTORED_PER_RUN` and `MAX_PACKAGE_RECOVERIES_PER_RUN` are
 * per-run counters that reset. `PACKAGE_RECOVERY_RESERVE_MS` reserves wall
 * clock, and the binding limit is CPU and memory. So every guard was blind and
 * the next tick restarted the identical work.
 *
 * These tests pin the property that fixes it: an attempt is durable, so being
 * killed is evidence, and evidence lets the sweep advance.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptsSoFar, packageAttemptsExhausted, recordPackageAttempt,
  recordPackageUnprocessable, provenanceAfterAttempt,
  recordUnreachableAttempt, recordPackageUnreachable, unreachableSoFar,
  unreachableAttemptsExhausted,
  MAX_PACKAGE_ATTEMPTS, MAX_UNREACHABLE_ATTEMPTS, PACKAGE_RECOVERY_ATTEMPT,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  negativeProvenanceStillStands, recordNoDeterministicImage,
  NO_DETERMINISTIC_IMAGE,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';

const PROVENANCE_VERSION = 5;
const question = (over: Partial<{
  provenanceVersion: number; packageReference: string; sourceAnchor: string | null;
}> = {}) => ({
  provenanceVersion: PROVENANCE_VERSION,
  // The actual folder the worker died on.
  packageReference: 'https://drive.google.com/drive/folders/1K8Pl5x-qWtyykzx4e_',
  sourceAnchor: 'notion:lot-104-finch-road',
  ...over,
});

/**
 * A tick that is KILLED: the attempt is written, the recovery never returns,
 * nothing else is. That is the whole shape of the defect.
 */
const killedTick = (stored: unknown) => recordPackageAttempt(stored, question());

describe('the reproduced defect — repeated kills on one package', () => {
  it('a killed tick leaves durable evidence instead of silence', () => {
    const afterFirstKill = killedTick(null);
    expect(afterFirstKill.result).toBe(PACKAGE_RECOVERY_ATTEMPT);
    expect(afterFirstKill.attempts).toBe(1);
    // Before the fix there was nothing here at all, which is why every tick
    // started the identical download.
    expect(attemptsSoFar(afterFirstKill, question())).toBe(1);
  });

  it('attempts accumulate across ticks rather than resetting with the run', () => {
    // `MAX_ITEMS_RESTORED_PER_RUN` and the recovery cap are per-run counters;
    // this is the one thing that survives the process ending.
    let stored: unknown = null;
    for (let tick = 1; tick <= 3; tick += 1) {
      stored = killedTick(stored);
      expect(attemptsSoFar(stored, question())).toBe(tick);
    }
  });

  it('THE FIX — the upload is not pinned: the package is retired and the sweep advances',
    () => {
      let stored: unknown = null;

      // Tick 1 and tick 2 are killed mid-recovery.
      stored = killedTick(stored);
      expect(packageAttemptsExhausted(stored, question())).toBe(false);
      stored = killedTick(stored);

      // Tick 3 refuses to start the work that killed the previous two.
      expect(packageAttemptsExhausted(stored, question())).toBe(true);

      const verdict = recordPackageUnprocessable(question());
      // It is the EXISTING negative result — no second vocabulary — so the
      // upload can settle, and settling is what admits the property to the
      // fallback ladder it could not reach at all before.
      expect(verdict.result).toBe(NO_DETERMINISTIC_IMAGE);
      expect(negativeProvenanceStillStands(verdict, question())).toBe(true);
    });

  it('the retired verdict tells an operator the truth about why', () => {
    const verdict = recordPackageUnprocessable(question());
    // Not "the builder's package was empty" — we could not open it.
    expect(verdict.detail).toMatch(/resource limits/i);
    expect(verdict.detail).toMatch(new RegExp(String(MAX_PACKAGE_ATTEMPTS)));
    expect(verdict.detail).not.toMatch(/names no|empty/i);
  });

  it('gives a package more than one chance, because a kill can be transient', () => {
    expect(MAX_PACKAGE_ATTEMPTS).toBeGreaterThanOrEqual(2);
    // And not so many that a pinned upload waits an hour to advance.
    expect(MAX_PACKAGE_ATTEMPTS).toBeLessThanOrEqual(3);
    expect(packageAttemptsExhausted(killedTick(null), question())).toBe(false);
  });
});

describe('a new question starts its own count', () => {
  it('a swapped package does not inherit the old one\'s failures', () => {
    let stored: unknown = killedTick(null);
    stored = recordPackageAttempt(stored, question());
    expect(packageAttemptsExhausted(stored, question())).toBe(true);

    // The builder swapped package A for package B: a different document, and
    // its own chances.
    const swapped = question({ packageReference: 'https://drive.google.com/drive/folders/other' });
    expect(attemptsSoFar(stored, swapped)).toBe(0);
    expect(packageAttemptsExhausted(stored, swapped)).toBe(false);
  });

  it('a version bump and a different source row each reopen it', () => {
    let stored: unknown = killedTick(null);
    stored = recordPackageAttempt(stored, question());

    expect(attemptsSoFar(stored, question({ provenanceVersion: PROVENANCE_VERSION + 1 })))
      .toBe(0);
    expect(attemptsSoFar(stored, question({ sourceAnchor: 'notion:another-row' }))).toBe(0);
  });
});

describe('the attempt shares a column with the verdict and cannot be mistaken for one', () => {
  it('an attempt never reads as a settled answer', () => {
    const attempt = killedTick(null);
    // `negativeProvenanceStillStands` fails open for anything that is not the
    // verdict, so an attempt means "no answer yet — ask again". That is what
    // makes sharing `source_provenance_result` safe with no new column.
    expect(negativeProvenanceStillStands(attempt, question())).toBe(false);
  });

  it('a real verdict is never counted as an attempt', () => {
    const verdict = recordNoDeterministicImage(question(), 'that folder names no document');
    expect(attemptsSoFar(verdict, question())).toBe(0);
    expect(packageAttemptsExhausted(verdict, question())).toBe(false);
    // And it still stands as the answer it is.
    expect(negativeProvenanceStillStands(verdict, question())).toBe(true);
  });

  it('a successful recovery clears the attempt by overwriting the column', () => {
    // The verdict paths write over the claim, so an attempt survives only when
    // the step did not finish. Modelled here because that is the invariant the
    // whole design rests on.
    const attempt = killedTick(null);
    expect(attemptsSoFar(attempt, question())).toBe(1);
    const settled = recordNoDeterministicImage(question(), 'read, names nothing');
    expect(attemptsSoFar(settled, question())).toBe(0);
  });

  it('malformed or foreign records are treated as no attempt at all', () => {
    for (const junk of [null, undefined, 'text', 42, [], {}, { result: 'something_else' }]) {
      expect(attemptsSoFar(junk, question())).toBe(0);
      expect(packageAttemptsExhausted(junk, question())).toBe(false);
    }
    // A negative or nonsense count cannot retire a package by accident.
    expect(attemptsSoFar({ ...killedTick(null), attempts: -3 }, question())).toBe(0);
    expect(attemptsSoFar({ ...killedTick(null), attempts: 'lots' }, question())).toBe(0);
  });
});

describe('the settler wires the claim before the uninterruptible step', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', '..',
      'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');

  it('records the attempt BEFORE recoverPackageImage, not after', () => {
    const claim = source.indexOf('recordPackageAttempt(');
    const recover = source.indexOf('await recoverPackageImage(');
    expect(claim).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(-1);
    // After the call, a kill would leave nothing — which is the bug.
    expect(claim).toBeLessThan(recover);
  });

  it('checks exhaustion before spending anything on the package', () => {
    const exhausted = source.indexOf('packageAttemptsExhausted(');
    const recover = source.indexOf('await recoverPackageImage(');
    expect(exhausted).toBeGreaterThan(-1);
    expect(exhausted).toBeLessThan(recover);
  });
});

/**
 * THE COUNTER MUST BE MONOTONIC ACROSS KILLS, OR THE GUARD IS UNREACHABLE.
 *
 * PRODUCTION, 28 AUGUST 2026, upload `55d12d53`. #2323 was deployed and had
 * already retired Lot 104 correctly — and the sweep still could not advance.
 * Lot 1342 Austin Estate [4 Bed 184 m2] (`a9f231f3`, folder `1jlUkB8O…`) held:
 *
 *   { result: "package_recovery_attempt", attempts: 1,
 *     started_at: "2026-08-28T05:35:02.698Z" }        updated_at 05:55:10
 *
 * `attempts` frozen at 1 and `started_at` twenty minutes stale while the row
 * was still being written — the signature of a rollback, because
 * `recordPackageAttempt` always stamps a fresh `started_at` and only the undo
 * path rewrites a record it did not author. Four ticks (05:40, 05:45, 05:50,
 * 05:55) each wrote attempt 2 and each rolled it back to 1, so
 * `packageAttemptsExhausted` never fired and the three properties after it in
 * `created_at` order — Lot 3 Yamanto, Lot 1663 Ringer St, Lot 13 Hummock Rise —
 * were never touched at all: `updated_at` still 02:53:19, import time.
 *
 * `source outstanding` therefore never reached 0, so stage B never began.
 */
describe('a returned step never resurrects the claim a kill left behind', () => {
  const folder = 'https://drive.google.com/drive/folders/1jlUkB8OR5Uq6msBjnBDJg1mmMQmWoLaB';
  const anchor = 'notion:38fcabf9-2010-8012-aa84-dc649c24903f';
  const lot1342 = {
    provenanceVersion: PROVENANCE_VERSION,
    packageReference: folder,
    sourceAnchor: anchor,
  };

  it('clears a surviving attempt rather than restoring it', () => {
    const survived = recordPackageAttempt(null, lot1342);
    expect(survived.attempts).toBe(1);
    // The undo path used to hand this straight back, which is the defect.
    expect(provenanceAfterAttempt(survived, lot1342)).toBeNull();
  });

  it('reaches exhaustion even when returns and kills alternate', () => {
    // Tick 1: nothing stored, killed. The attempt survives.
    let stored: unknown = recordPackageAttempt(null, lot1342);
    expect(attemptsSoFar(stored, lot1342)).toBe(1);

    // Tick 2: claims attempt 2, then the step RETURNS unreachable and undoes.
    const claimed = recordPackageAttempt(stored, lot1342);
    expect(claimed.attempts).toBe(2);
    stored = provenanceAfterAttempt(stored, lot1342);

    // Production rolled back to 1 here and looped for ever. It must not.
    expect(attemptsSoFar(stored, lot1342)).toBe(0);

    // Tick 3 and 4 are two clean kills, which is what the guard counts.
    stored = recordPackageAttempt(stored, lot1342);
    stored = recordPackageAttempt(stored, lot1342);
    expect(attemptsSoFar(stored, lot1342)).toBe(MAX_PACKAGE_ATTEMPTS);
    expect(packageAttemptsExhausted(stored, lot1342)).toBe(true);
  });

  it('never counts more kills than actually happened', () => {
    // Two kills in a row must exhaust, and no undo ran between them.
    let stored: unknown = recordPackageAttempt(null, lot1342);
    expect(packageAttemptsExhausted(stored, lot1342)).toBe(false);
    stored = recordPackageAttempt(stored, lot1342);
    expect(packageAttemptsExhausted(stored, lot1342)).toBe(true);
  });

  it('gives back a real verdict untouched — only a claim is cleared', () => {
    const verdict = recordNoDeterministicImage(lot1342, 'That folder names no document.');
    expect(provenanceAfterAttempt(verdict, lot1342)).toBe(verdict);
    expect(provenanceAfterAttempt(null, lot1342)).toBeNull();
  });

  it('leaves another question\'s attempt alone', () => {
    // A different package is a different question; clearing this claim must not
    // silently discard the record a neighbouring one is relying on.
    const other = recordPackageAttempt(null, { ...lot1342, packageReference: 'https://drive.google.com/drive/folders/OTHER' });
    expect(provenanceAfterAttempt(other, lot1342)).toBe(other);
  });
});

describe('the settler undoes its claim through the pure rule', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', '..',
      'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');

  it('does not hand negativeBefore back verbatim', () => {
    // The exact expression that froze Lot 1342 at attempts: 1.
    expect(source).not.toContain(
      'source_provenance_result: negativeBefore.get(itemId) ?? null');
    expect(source).toContain('provenanceAfterAttempt(');
  });
});

/**
 * BUILDER STOCK — A LINK THAT CAN NEVER BE READ MUST NOT PIN A PROPERTY.
 *
 * PRODUCTION, 31 AUGUST 2026, upload `43ffa452`. After the branch-rotation fix
 * thirteen properties were still claimed every sixty seconds, indefinitely,
 * making no progress. Every one of their remaining branches answered
 * `unreachable`, and `unreachable` records nothing on purpose:
 *
 *   1Tce_9IApKLACbWDP8FvEmdC2mC3RPD5j   HTTP 404  — Drive file gone
 *   118vbAYRYMQi4L4sLYakT-nUdI6xysEiS   HTTP 404  — Drive file gone
 *   1R9J70QzZqD5B7xupf-gIhM6gepQQNAVQ   "Google Drive: Sign-in"
 *   1Pwauab0FRFVdPA7zP4tiRPpFli455977   4.2 MB single-page scan, no text layer
 *
 * Rotation gave each branch its turn and each turn answered the same nothing,
 * so `openBranches` never emptied, the property never left the source stage,
 * and it never reached the fallback ladder that would have given it a picture.
 *
 * "We keep trying" was not the alternative to retiring. The alternative was a
 * property with no image at all, for ever.
 */
describe('a link that can be fetched and never read is retired, eventually', () => {
  const unreadableTick = (stored: unknown) => recordUnreachableAttempt(stored, question());

  it('counts an unreachable answer instead of forgetting it', () => {
    let state: unknown = null;
    expect(unreachableSoFar(state, question())).toBe(0);
    state = unreadableTick(state);
    expect(unreachableSoFar(state, question())).toBe(1);
    state = unreadableTick(state);
    expect(unreachableSoFar(state, question())).toBe(2);
  });

  it('retires the branch once the budget is spent, and not before', () => {
    let state: unknown = null;
    for (let tick = 1; tick <= MAX_UNREACHABLE_ATTEMPTS; tick += 1) {
      expect(unreachableAttemptsExhausted(state, question())).toBe(false);
      state = unreadableTick(state);
    }
    expect(unreachableAttemptsExhausted(state, question())).toBe(true);
  });

  it('gives an unreadable link more goes than a package that kills the worker', () => {
    // A killed worker costs a whole invocation; an unreadable link costs one
    // cheap fetch, and some of its failures are genuinely transient.
    expect(MAX_UNREACHABLE_ATTEMPTS).toBeGreaterThan(MAX_PACKAGE_ATTEMPTS);
  });

  it('never pushes a package towards the resource-limit retirement', () => {
    // The two findings are different and must not borrow each other's budget:
    // an unreachable answer proves nothing about the worker's limits.
    let state: unknown = recordPackageAttempt(null, question());
    expect(attemptsSoFar(state, question())).toBe(1);
    state = unreadableTick(state);
    expect(attemptsSoFar(state, question())).toBe(0);
    expect(packageAttemptsExhausted(state, question())).toBe(false);
  });

  it('a kill and an unreadable answer each still reach their own retirement', () => {
    let killed: unknown = null;
    for (let i = 0; i < MAX_PACKAGE_ATTEMPTS; i += 1) killed = recordPackageAttempt(killed, question());
    expect(packageAttemptsExhausted(killed, question())).toBe(true);

    let unread: unknown = null;
    for (let i = 0; i < MAX_UNREACHABLE_ATTEMPTS; i += 1) unread = unreadableTick(unread);
    expect(unreachableAttemptsExhausted(unread, question())).toBe(true);
  });

  it('the retirement is a verdict, and says the link could not be READ', () => {
    const verdict = recordPackageUnreachable(question()) as Record<string, unknown>;
    expect(verdict.result).toBe(NO_DETERMINISTIC_IMAGE);
    // It must not claim the builder's document was empty, nor blame the
    // worker's limits — an operator is told what actually happened.
    expect(String(verdict.detail)).toMatch(/could not be read/i);
    expect(String(verdict.detail)).not.toMatch(/resource limits/i);
    expect(String(recordPackageUnprocessable(question()).detail)).toMatch(/resource limits/i);
  });

  it('the retirement settles the question, so the property advances', () => {
    const state = { branches: { [question().packageReference]: recordPackageUnreachable(question()) } };
    expect(negativeProvenanceStillStands(
      state.branches[question().packageReference], question())).toBe(true);
  });

  it('a new question asks again from zero, so retiring is never for ever', () => {
    let state: unknown = null;
    for (let i = 0; i < MAX_UNREACHABLE_ATTEMPTS; i += 1) state = unreadableTick(state);
    // A bumped extractor, a swapped package, or a re-imported row.
    expect(unreachableSoFar(state, question({ provenanceVersion: PROVENANCE_VERSION + 1 }))).toBe(0);
    expect(unreachableSoFar(state, question({ packageReference: 'https://drive.google.com/file/d/other/view' }))).toBe(0);
    expect(unreachableSoFar(state, question({ sourceAnchor: 'notion:another-lot' }))).toBe(0);
  });

  it('an unreachable attempt is never mistaken for a verdict while it stands', () => {
    const standing = unreadableTick(null);
    expect(standing.result).toBe(PACKAGE_RECOVERY_ATTEMPT);
    // `negativeProvenanceStillStands` is false for anything that is not the
    // negative verdict, so an in-flight count reads as "ask again".
    expect(negativeProvenanceStillStands(standing, question())).toBe(false);
  });
});

describe('the settler banks an unreachable answer rather than discarding it', () => {
  const source = () => readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');

  it('both unreachable exits go through the one bounded path', () => {
    const body = source();
    // The throw path and the returned-unreachable path.
    expect(body).toContain('await bankUnreachable();');
    expect((body.match(/await bankUnreachable\(\);/g) ?? []).length).toBe(2);
    // And neither of them rolls the count back any more.
    expect(body).not.toContain('await clearAttempt();\n      outcome.packageUnreachable');
  });

  it('it retires through the pure rule rather than a local copy', () => {
    const body = source();
    expect(body).toContain('unreachableAttemptsExhausted(branchBefore, question)');
    expect(body).toContain('recordPackageUnreachable(question)');
    expect(body).toContain('recordUnreachableAttempt(branchBefore, question)');
  });

  it('an unrecorded retirement is never settled on', () => {
    const body = source();
    expect(body).toContain('if (bankError) outcome.incomplete = true;');
  });
});
