/**
 * Builder stock — a claim handed back untouched must cost the property nothing.
 *
 * THE SERIAL LOOP CLAIMS BEFORE IT KNOWS THE STAGE, so it sometimes takes a
 * property it has not the clock left to finish and hands it straight back.
 * Nothing is attempted: the stage is never entered, no document is fetched,
 * no branch attempt is written.
 *
 * But the CLAIM increments `image_work_attempts` before any of that, and the
 * completion clears it only when work progressed or the stage moved — neither
 * of which is true of a handback at the same stage. Evaluated against the
 * live function's own CASE, a row claimed at 5 attempts comes back at 6, and
 * the claim's backoff is `least(30 * 2^attempts, 3600)`:
 *
 *   6 attempts → 1,920 seconds → a 32-MINUTE backoff
 *
 * A healthy property would be pushed there by our scheduling alone, having
 * done nothing, slowing the very queue the serial loop exists to speed up.
 * So the handback resets the counter, and the two questions — did work
 * advance, should the backoff clear — stop being one flag.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  completeItemWork,
} from '../../../supabase/functions/_shared/builderStock/itemWorkClaim';

/** A database that records the arguments rather than running them. */
const recorder = () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ error: null });
    },
  };
};

describe('the completion separates "work advanced" from "clear the backoff"', () => {
  it('a handback asks for the counter to be cleared', async () => {
    const db = recorder();
    await completeItemWork(db, 'item-1', {
      nextStage: 'source',
      result: 'deferred: not enough of this invocation left to finish it',
      retryAfterSeconds: 0,
      progressed: false,
      resetAttempts: true,
    });
    const args = db.calls[0].args;
    expect(args.p_reset_attempts).toBe(true);
    // And it is honest about the other question: nothing progressed.
    expect(args.p_next_stage).toBe('source');
    expect(args.p_retry_after_seconds).toBe(0);
  });

  it('a stage that RAN and failed still keeps its attempt, as before', async () => {
    // The counter is a real backoff for real failures; this change must not
    // hand a failing stage an infinite supply of immediate retries.
    const db = recorder();
    await completeItemWork(db, 'item-2', {
      nextStage: 'source', result: 'source: failed', progressed: false,
    });
    expect(db.calls[0].args.p_reset_attempts).toBe(false);
  });

  it('and progress still clears it, with no caller changing', async () => {
    const db = recorder();
    await completeItemWork(db, 'item-3', { nextStage: 'eligibility', progressed: true });
    expect(db.calls[0].args.p_reset_attempts).toBe(true);
  });
});

describe('the deferral path in the settler asks for exactly that', () => {
  const settler = readFileSync(join(process.cwd(),
    'supabase/functions/builder-stock-image-settler/index.ts'), 'utf8');
  const loop = settler.slice(settler.indexOf('for (;;) {'));
  /*
   * Anchored on the guard's own condition rather than on the whole `if`,
   * which now also carries the document allowance. Both limits release the
   * claim the same way and this file is the assertion that they do.
   */
  const handback = loop.slice(loop.indexOf('const remaining = startedAt + BUDGET_MS'));

  it('releases the claim with the counter reset and no progress claimed', () => {
    expect(handback).toMatch(/resetAttempts: true/);
    expect(handback).toMatch(/progressed: false/);
  });

  it('returns it at its OWN stage, so the ladder does not skip a rung', () => {
    expect(handback).toMatch(/nextStage: readStage\(next\.item\.image_work_stage\)/);
  });

  it('asks for no retry delay — the next tick may take it immediately', () => {
    expect(handback).toMatch(/retryAfterSeconds: 0/);
  });

  it('and stops the loop rather than working the property it just released', () => {
    const release = handback.indexOf('resetAttempts: true');
    const brk = handback.indexOf('break;', release);
    expect(brk).toBeGreaterThan(release);
  });
});

describe('the backoff this protects a property from', () => {
  it('is exponential, so a retained increment is not a rounding error', () => {
    // The claim's own formula, from 20261022000000. Six deferrals would cost
    // half an hour of a healthy property's time.
    const backoff = (attempts: number) =>
      Math.min(30 * 2 ** Math.min(attempts, 7), 3600);
    expect(backoff(0)).toBe(30);
    expect(backoff(6)).toBe(1920);
    expect(backoff(7)).toBe(3600);
  });
});
