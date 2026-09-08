/**
 * Builder stock — the re-arm has to reach the QUEUE, not just the branch.
 *
 * THE GAP THIS EXISTS FOR. `RUNTIME_VERSION` resets `attemptsSoFar`, which
 * makes a branch askable again. On its own that changes nothing: the queue
 * only claims rows whose `image_work_stage <> 'settled'`, and the six
 * properties of upload `bd7a0ef5` are settled. The only thing that pulls a
 * settled row back is `reopen_builder_stock_stranded_items`, and it reopens on
 * exactly two grounds — an image re-judged after the row concluded, or the
 * ladder GENERATION moving. A runtime bump moves neither.
 *
 * MEASURED against production for all six rows before the fix:
 *   image_work_stage = settled, primary_image_id = null,
 *   reopens_on_generation = false, reopens_on_image = false
 *
 * So the counter reset and nothing ever asked. These tests pin the SQL
 * predicate that closes it — evaluated here as the migration writes it, over
 * the branch shapes production actually holds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

const MIGRATION = 'supabase/migrations/20261113110000_builder_stock_runtime_reopen.sql';
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8');

/**
 * The migration's own predicate, in TypeScript.
 *
 * A faithful transcription rather than a second opinion: each clause below is
 * asserted to exist in the SQL by the tests underneath, so the two cannot
 * drift into disagreeing about which rows reopen.
 */
const branchReopens = (v: Record<string, unknown>, runtime: number): boolean => {
  const stamped = Number(v.runtime_version ?? 0);
  if (v.result === 'package_recovery_attempt') return stamped < runtime;
  if (v.result === 'no_deterministic_image') {
    return 'runtime_version' in v && stamped < runtime;
  }
  return false;
};
const rowReopens = (
  row: { stage: string; hasImage: boolean; branches: Record<string, unknown>[] },
  runtime = RUNTIME_VERSION,
): boolean => row.stage === 'settled' && !row.hasImage
  && row.branches.some((b) => branchReopens(b, runtime));

const OLD = RUNTIME_VERSION - 1;

describe('a six-style row goes settled → claimable', () => {
  it('a branch killed by the old worker reopens the row', () => {
    // Verbatim shape from production: attempts at the kill limit, no verdict,
    // and no runtime field at all because it predates the stamp.
    expect(rowReopens({
      stage: 'settled', hasImage: false,
      branches: [{ result: 'package_recovery_attempt', attempts: 4 }],
    })).toBe(true);
  });

  it('and so does a retirement stamped with the runtime that failed', () => {
    expect(rowReopens({
      stage: 'settled', hasImage: false,
      branches: [{
        result: 'no_deterministic_image', exhaustion: 'operational',
        runtime_version: OLD,
      }],
    })).toBe(true);
  });

  it('the reopened row lands on the SOURCE rung, where recovery runs', () => {
    // `eligibility` — what the sibling reopen uses — would skip the package
    // recovery entirely and settle blank again immediately.
    expect(sql).toMatch(/SET image_work_stage = 'source'/);
  });

  it('and its queue columns are cleared so it is claimable at once', () => {
    expect(sql).toMatch(/image_work_next_attempt_at = now\(\)/);
    expect(sql).toMatch(/image_work_claim_until = NULL/);
    expect(sql).toMatch(/image_work_attempts = 0/);
  });
});

describe('and nothing else moves', () => {
  it('a document that ANSWERED is left alone', () => {
    expect(rowReopens({
      stage: 'settled', hasImage: false,
      branches: [{ result: 'no_deterministic_image', exhaustion: 'inspected' }],
    })).toBe(false);
  });

  it('a DEAD LINK is left alone — no stamp, so no re-chase', () => {
    // `recordPackageUnreachable` writes `operational` without a runtime,
    // because a faster worker cannot open a 404.
    expect(rowReopens({
      stage: 'settled', hasImage: false,
      branches: [{ result: 'no_deterministic_image', exhaustion: 'operational' }],
    })).toBe(false);
  });

  it('a row that already HAS its picture is protected', () => {
    // Measured: of 91 live rows, 7 match the branch predicate and one of them
    // holds a picture found on another branch. Reopening it would discard a
    // good card to re-ask a question already answered.
    expect(rowReopens({
      stage: 'settled', hasImage: true,
      branches: [{ result: 'package_recovery_attempt', attempts: 4 }],
    })).toBe(false);
    expect(sql).toMatch(/AND i\.primary_image_id IS NULL/);
  });

  it('a row still working is not disturbed mid-ladder', () => {
    expect(rowReopens({
      stage: 'source', hasImage: false,
      branches: [{ result: 'package_recovery_attempt', attempts: 4 }],
    })).toBe(false);
    expect(sql).toMatch(/AND i\.image_work_stage = 'settled'/);
  });

  it('a failure from the CURRENT runtime stands — this is not a free retry', () => {
    expect(rowReopens({
      stage: 'settled', hasImage: false,
      branches: [{
        result: 'no_deterministic_image', exhaustion: 'operational',
        runtime_version: RUNTIME_VERSION,
      }],
    })).toBe(false);
  });
});

describe('the migration is dated where it will actually be applied', () => {
  /*
   * MEASURED THE HARD WAY, 7 SEPTEMBER 2026. These migrations first shipped
   * timestamped from the wall clock — `20260907…` — and the deploy reported
   * SUCCESS while applying none of them: this repository forward-dates its
   * migrations, the latest applied was `20261112010000`, and anything sorting
   * below that is treated as history and skipped. The column did not exist,
   * the reopen function did not exist, and the dispatcher still fanned out to
   * ten. A migration below the high-water mark is not a migration; it is a
   * file.
   */
  const migrations = readdirSync(join(process.cwd(), 'supabase/migrations'))
    .filter((f) => /^\d{14}_.*\.sql$/.test(f));

  /*
   * The mark these two had to clear, recorded rather than recomputed.
   *
   * It is the latest version PRODUCTION had applied on 7 September 2026, the
   * measurement in the comment above, and it is a historical fact that cannot
   * change. Deriving it from the tree instead — `max(every migration here)` —
   * is what this test did first, and that is a different and much stronger
   * claim: that no migration dated after these two may ever be added. It fails
   * on the NEXT migration anybody writes, whatever it is and however correct,
   * because a newer file raises the mark it is measured against. The first one
   * to hit it was an unrelated AML change a day later.
   *
   * The rule worth keeping is the one that was measured: a migration below the
   * mark already applied is skipped as history, so these two had to sort above
   * it. A migration ABOVE them is not a violation — it is what every
   * subsequent migration is supposed to look like.
   */
  const APPLIED_HIGH_WATER = '20261112010000';

  it.each([
    '20261113110000_builder_stock_runtime_reopen.sql',
    '20261113110001_builder_stock_settler_fixed_concurrency.sql',
  ])('%s sorts above the version production had already applied', (name) => {
    expect(migrations).toContain(name);
    expect(name.slice(0, 14) > APPLIED_HIGH_WATER).toBe(true);
  });

  it('and the reopen still precedes the tick that calls it', () => {
    // Ordering within the pair matters as much as their floor: the tick's
    // body names a function the earlier file creates.
    expect('20261113110000' < '20261113110001').toBe(true);
  });
});

describe('the SQL and the TypeScript cannot drift apart', () => {
  it('the migrations leave the database on the runtime the code compiles against', () => {
    /*
     * THE LAST WRITER DECIDES, not the first. Each runtime bump adds a
     * migration that raises the column, so reading only the file that created
     * it would pin the database to version 1 for ever while the code moved on
     * — and the reopen function compares against the COLUMN. A bump that
     * changes the constant and forgets its migration is inert; one that
     * changes the migration and forgets the constant reopens work the running
     * worker will retire again immediately. Both are caught here.
     */
    const dir = join(process.cwd(), 'supabase/migrations');
    const settings = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .flatMap((f) => {
        const m = readFileSync(join(dir, f), 'utf8')
          .match(/SET image_runtime_version = (\d+)/);
        return m ? [{ file: f, value: Number(m[1]) }] : [];
      });
    expect(settings.length, 'no migration sets the runtime version').toBeGreaterThan(0);
    expect(settings[settings.length - 1].value).toBe(RUNTIME_VERSION);
    // And it only ever goes up: a later migration lowering it would silently
    // re-retire everything an earlier bump reopened.
    for (let i = 1; i < settings.length; i += 1) {
      expect(settings[i].value).toBeGreaterThan(settings[i - 1].value);
    }
  });

  it('the predicate keys on the stamp, which is what separates ours from theirs', () => {
    expect(sql).toMatch(/v \? 'runtime_version'/);
    expect(sql).toMatch(/package_recovery_attempt/);
  });

  it('and the tick actually calls it, or the whole thing is inert again', () => {
    const tick = readFileSync(join(process.cwd(),
      'supabase/migrations/20261113110001_builder_stock_settler_fixed_concurrency.sql'), 'utf8');
    expect(tick).toMatch(/PERFORM public\.reopen_builder_stock_runtime_failures\(\);/);
  });
});
