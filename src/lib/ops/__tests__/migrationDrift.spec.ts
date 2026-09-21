/**
 * The migration drift report — what it must never get wrong.
 *
 * Every case here is a real observation from 21 Sep 2026 against the
 * production ledger, not an invented scenario.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs, no types; this is a script module by design.
import { assessMigrationDrift, probeIsReadOnly } from '../../../../scripts/ops/migrationDrift.pure.mjs';

const MIGRATIONS = 'supabase/migrations';

const m = (over: Record<string, unknown> = {}) => ({
  version: '20261209000000', file: 'x.sql', objects: [], probe: null, ...over,
});

describe('assessMigrationDrift', () => {
  it('says nothing about a migration the ledger already records', () => {
    const r = assessMigrationDrift({
      migrations: [m({ objects: ['table:public.gone'] })],
      appliedVersions: ['20261209000000'],
      existingObjects: [],
    });
    expect(r.rows).toHaveLength(0);
  });

  /*
   * The whole reason this module exists. Measured: 832 of 1,008 repo
   * migrations carry no ledger row while their objects exist, because
   * migrations here have been applied through routes that record nothing. A
   * report that called those 832 a backlog would be a report nobody reads.
   */
  it('does not call an unrecorded migration a backlog when its objects exist', () => {
    const r = assessMigrationDrift({
      migrations: [m({ objects: ['table:public.urban_centre_register'] })],
      appliedVersions: [],
      existingObjects: ['table:public.urban_centre_register'],
    });
    expect(r.notApplied).toHaveLength(0);
    expect(r.effectPresent).toHaveLength(1);
  });

  it('reports a migration whose object is absent', () => {
    const r = assessMigrationDrift({
      migrations: [m({ objects: ['table:public.a', 'table:public.b'] })],
      appliedVersions: [],
      existingObjects: ['table:public.a'],
    });
    expect(r.notApplied).toHaveLength(1);
    expect(r.notApplied[0].missing).toEqual(['table:public.b']);
  });

  /*
   * The flaw production caught in the first cut of this module, and the reason
   * the probe outranks object counting.
   *
   * Seeds v12 through v18 each create the same helper tables with
   * `if not exists`. v17 created them; v18's objects therefore ALL exist while
   * v18's rows never landed — `template_library_release_baselines` holds v15,
   * v16 and v17 at 543 rows each and no v18. Counting objects would have
   * called it `effect_present` and been wrong, which is precisely the defect
   * that left every report printing "Five dimensions, weighted" over a table
   * of three rows.
   */
  it('believes the declared probe over objects that an earlier migration created', () => {
    const seed = m({
      file: 'v18.sql',
      objects: ['table:public.template_library_release_baselines'],
      probe: "select 1 from public.template_library_release_baselines where release = 'v18'",
    });
    const r = assessMigrationDrift({
      migrations: [seed],
      appliedVersions: [],
      // The table exists — v17 made it.
      existingObjects: ['table:public.template_library_release_baselines'],
      probeResults: new Map([['v18.sql', false]]),
    });
    expect(r.notApplied).toHaveLength(1);
    expect(r.notApplied[0].why).toMatch(/probe is NOT satisfied/);
  });

  it('does not pass a probe that was never run', () => {
    const r = assessMigrationDrift({
      migrations: [m({ file: 'v18.sql', probe: 'select 1' })],
      appliedVersions: [], existingObjects: [], probeResults: new Map(),
    });
    expect(r.notApplied).toHaveLength(1);
    expect(r.notApplied[0].why).toMatch(/was not run/);
  });

  /*
   * `unverifiable` is reported rather than passed. An INSERT-only migration
   * with no probe is not evidence of anything, and silently treating it as
   * applied is the failure this module was written for.
   */
  it('keeps an unjudgeable migration visible rather than passing it', () => {
    const r = assessMigrationDrift({
      migrations: [m({ objects: [], probe: null })],
      appliedVersions: [], existingObjects: [],
    });
    expect(r.unverifiable).toHaveLength(1);
    expect(r.effectPresent).toHaveLength(0);
    expect(r.notApplied).toHaveLength(0);
  });
});

describe('probeIsReadOnly — a probe is read from the repo and run against a writable connection', () => {
  it('accepts a lone select', () => {
    expect(probeIsReadOnly('select 1 from public.t where x = 1')).toBe(true);
  });

  /*
   * A column may be NAMED for a keyword without being one. The first version
   * of this test asserted that `delete_me` was refused; it is not, because
   * `\bdelete\b` finds no boundary before `_`, and the guard is right — the
   * statement is an ordinary SELECT over a column with an unfortunate name.
   * The test was pinning a defect it had invented.
   */
  it('accepts a select over a column whose name contains a keyword', () => {
    expect(probeIsReadOnly('select 1 from t where deleted_at is null')).toBe(true);
    expect(probeIsReadOnly('select 1 from t where f() and delete_me')).toBe(true);
  });

  it.each([
    ['a second statement', 'select 1; drop table t'],
    ['a write', 'insert into t values (1)'],
    ['a write behind a CTE', 'with x as (select 1) update t set a = 1'],
    ['a function that writes', 'select public.truncate everything'],
    ['a DO block', 'do $$ begin end $$'],
    ['a procedure call', 'call public.rebuild()'],
    ['empty', '   '],
  ])('refuses %s', (_label, sql) => {
    expect(probeIsReadOnly(sql)).toBe(false);
  });
});

describe('the probes this repository actually declares', () => {
  const declared = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .map((f) => ({ f, src: readFileSync(join(MIGRATIONS, f), 'utf8') }))
    .map(({ f, src }) => ({ f, probe: src.match(/^\s*--\s*@effect:\s*(.+?)\s*$/mi)?.[1] ?? null }))
    .filter((x) => x.probe);

  it('declares at least one, so the mechanism is exercised rather than described', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('every declared probe is read-only', () => {
    const bad = declared.filter((x) => !probeIsReadOnly(x.probe as string));
    expect(bad.map((x) => x.f)).toEqual([]);
  });
});
