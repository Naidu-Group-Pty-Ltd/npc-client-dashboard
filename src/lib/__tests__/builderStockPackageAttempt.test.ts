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
  recordPackageUnprocessable, MAX_PACKAGE_ATTEMPTS, PACKAGE_RECOVERY_ATTEMPT,
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
