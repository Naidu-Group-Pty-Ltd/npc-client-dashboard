/**
 * Builder stock — the extractor version was the one settlement marker the
 * scheduler could not see.
 *
 * `builder_stock_settlement_target` holds a target per settlement concern, and
 * `settle_builder_stock_marketplace_eligibility_tick` counts an upload as
 * outstanding when its marker is behind. That is the entire mechanism by which
 * a rules change reaches uploads already settled under the old rules, and the
 * migration that introduced it said why:
 *
 *     `coalesce(marker, -1) < target` is what replaces `marker IS NULL`. An
 *     upload that has never been judged and one judged under an older
 *     algorithm are the same kind of outstanding, and only the second of those
 *     was previously countable.
 *
 * It was applied to eligibility, then to sanitization, and never to provenance
 * — whose half of the predicate read `source_images_settled_version IS NULL`
 * from 19 August 2026 until this change, while the function's own comment
 * claimed "(or has provenance work outstanding)".
 *
 * MEASURED 11 SEPTEMBER 2026. `PROVENANCE_VERSION` went to 24 to re-ask the
 * negatives banked at 23. The deploy succeeded, four uploads sat at 23, the
 * tick computed zero outstanding because all four markers were non-null, and
 * the job unscheduled itself. The settler, invoked by hand, answered
 * `{"claimed":0}`. The capability shipped and the scheduler never asked for
 * it — which is also why v22 "deployed cleanly and changed nothing in
 * production", the observation the v23 entry opens with.
 *
 * So this file pins the two halves together the way
 * `builderStockMarketplaceEligibility.test.ts` pins its own.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');
const MIGRATION = read(
  'supabase/migrations/20261119130000_builder_stock_provenance_target.sql');

describe('the database target and the code version are one number', () => {
  it('seeds the target to exactly PROVENANCE_VERSION', () => {
    const match = MIGRATION.match(
      /set_builder_stock_source_images_target\((\d+)\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(PROVENANCE_VERSION);
  });

  /*
   * A BUMP IS TWO HALVES AND THIS IS THE REMINDER. Raising the constant
   * without a migration calling the setter leaves the scheduler asking for the
   * old version — which is the defect this whole file records. The seed above
   * fails the moment they drift, and the message is what a developer reads.
   */
  it('so raising PROVENANCE_VERSION requires a migration that raises the target', () => {
    expect(MIGRATION).toContain('MUST EQUAL `PROVENANCE_VERSION`');
  });
});

describe('the tick compares the marker rather than testing it for null', () => {
  it('counts an upload settled under an OLDER extractor as outstanding', () => {
    expect(MIGRATION).toContain(
      'coalesce(source_images_settled_version, -1) < v_provenance');
  });

  it('and no longer counts only the never-judged ones', () => {
    // The old clause must be gone from the function body. It survives in the
    // header prose (quoted as what was wrong), so the assertion is against the
    // predicate's own shape rather than the string appearing anywhere.
    const body = MIGRATION.slice(MIGRATION.indexOf('SELECT count(*) INTO v_outstanding'));
    expect(body).not.toContain('OR source_images_settled_version IS NULL');
  });

  it('reads the target column it added', () => {
    expect(MIGRATION).toContain('source_images_version');
    expect(MIGRATION).toContain('v_provenance := coalesce(v_provenance, 0)');
  });
});

/*
 * THE HALF THAT MAKES THE TARGET MEAN ANYTHING.
 *
 * The sweep's cron job removes itself when the queue empties — it is a repair,
 * not a service. So raising a target has to put the job back, or the target is
 * a number nobody acts on: on 11 September the job was absent, and arming it by
 * hand achieved nothing because the tick still computed zero outstanding and
 * removed it again on the same pass. Both halves are needed and both are here.
 */
describe('raising the target re-schedules the sweep', () => {
  it('the setter schedules the job when it is absent', () => {
    const setter = MIGRATION.slice(
      MIGRATION.indexOf('FUNCTION public.set_builder_stock_source_images_target'),
      MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.settle_builder_stock'));
    // Through the function that owns the schedule, never a second copy of the
    // cron string — two places naming a schedule is how two schedules differ,
    // and they already do: the eligibility setter says `*/5 * * * *` while the
    // job this repair runs on is every minute.
    expect(setter).toContain('public.ensure_builder_stock_settlement_scheduled()');
    expect(setter).not.toContain('cron.schedule');
  });

  it('and never lowers the target', () => {
    expect(MIGRATION).toContain('GREATEST(public.builder_stock_settlement_target.source_images_version');
  });

  /*
   * The column defaults to 0 rather than to the current version: on a restored
   * snapshot it arrives before the seed, and defaulting to "current" would mark
   * every upload settled at a version it was never judged under. Zero is behind
   * everything, and the worst case of being behind is one re-read.
   */
  it('defaults the new column to 0, which is the safe direction', () => {
    expect(MIGRATION).toContain('source_images_version integer NOT NULL DEFAULT 0');
  });
});
