/**
 * BUILDER STOCK — THE CRON GATE MUST COUNT BOTH QUEUES.
 *
 * THE DEFECT, MEASURED IN PRODUCTION ON 28 AUGUST 2026. Three properties on the
 * live Marketplace read "No image found" — Lot 13 Hummock Rise, Lot 1663 Ringer
 * Street, Lot 3 Rose Street Yamanto — each with a correct terminal stage-A
 * answer, zero image rows, and `enrichment_status = 'pending'`.
 *
 * PR #2318 had given the settler a fallback-enrichment phase and a completion
 * rule of `complete: fallback.remaining === 0`. Both were deployed and correct.
 * They were also unreachable, because the thing pg_cron actually runs is
 * `settle_builder_stock_marketplace_eligibility_tick()`, and that function
 * decided whether to invoke the settler from `builder_stock_uploads` alone:
 *
 *   IF v_outstanding = 0 THEN unschedule; RETURN;   -- without invoking
 *
 * So the instant settlement finished it unscheduled the job AND returned
 * without calling the function — at exactly the moment the fallback phase would
 * have applied. The completion rule was installed one layer too high.
 *
 * WHY THIS IS A TEXT TEST. The rule lives in PL/pgSQL and this repository has
 * no in-process Postgres, so the five cases cannot be executed against a real
 * server here. They are executed against the REAL MIGRATION TEXT instead: the
 * gate expression is parsed out of the shipped function and evaluated with the
 * counts each case describes. That is weaker than a live database and much
 * stronger than restating the rule in TypeScript — narrowing the gate back to
 * `v_outstanding = 0` fails cases 1 and 2 here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION =
  'supabase/migrations/20261005000000_builder_stock_cron_gate_fallback.sql';
const sql = readFileSync(join(REPO_ROOT, MIGRATION), 'utf8');

/** The function body as shipped, without the surrounding commentary. */
const body = (() => {
  const start = sql.indexOf('AS $$');
  const end = sql.indexOf('$$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

/**
 * The gate, taken from the shipped SQL rather than assumed.
 *
 * Evaluating the real expression is what makes the case table below a test of
 * the migration instead of a test of a paraphrase of it.
 */
function gateSaysQuiet(settlement: number, fallback: number): boolean {
  const match = body.match(/IF\s+([a-z_+\s]+?)\s*=\s*0\s+THEN/i);
  expect(match, 'the function must gate on a count reaching zero').toBeTruthy();
  const expression = match![1].trim();
  const value = Function(
    'v_outstanding', 'v_fallback', `"use strict"; return (${expression});`,
  )(settlement, fallback);
  return value === 0;
}

/** Quiet means both: it unschedules AND it does not invoke the settler. */
const invokes = (settlement: number, fallback: number) =>
  !gateSaysQuiet(settlement, fallback);

describe('the five cases the live defect turned on', () => {
  it('CASE 1 — settlement 0, one PENDING item: invoke, do not unschedule', () => {
    // The exact production shape. This returned "quiet" before the fix, which
    // is why three cards stayed blank with a ladder that had never been asked.
    expect(invokes(0, 1)).toBe(true);
    expect(gateSaysQuiet(0, 1)).toBe(false);
  });

  it('CASE 2 — settlement 0, one ENRICHING item: invoke, do not unschedule', () => {
    // `enriching` is a claimed item, not a finished one; a tick that went quiet
    // on it would strand a property mid-ladder.
    expect(invokes(0, 1)).toBe(true);
  });

  it('CASE 3 — both queues empty: do not invoke, unschedule', () => {
    expect(gateSaysQuiet(0, 0)).toBe(true);
    expect(invokes(0, 0)).toBe(false);
  });

  it('CASE 4 — settlement outstanding, no fallback: unchanged behaviour', () => {
    expect(invokes(1, 0)).toBe(true);
  });

  it('CASE 5 — both queues outstanding: exactly ONE invocation', () => {
    expect(invokes(3, 17)).toBe(true);
    // The settler picks its own phase, so waking it twice buys the same tick
    // twice. One call site, and it is the signed one.
    const calls = body.match(/cron_invoke_signed_function/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

describe('the fallback queue is the portal\'s own semantics', () => {
  it('counts active items in pending or enriching, and nothing else', () => {
    expect(body).toMatch(/FROM\s+public\.builder_stock_items/i);
    expect(body).toMatch(/lifecycle_status\s*=\s*'active'/i);
    expect(body).toMatch(/enrichment_status\s+IN\s*\(\s*'pending'\s*,\s*'enriching'\s*\)/i);
    // `complete`, `partial` and `failed` stay terminal, so a property with no
    // picture available cannot hold the cron open for ever.
    expect(body).not.toMatch(/'complete'|'partial'|'failed'/);
  });

  it('SQL answers one question and does not re-implement the ladder', () => {
    // Which stage is owed, whether a web result is that property, whether
    // Street View has coverage and which picture wins are the edge function's.
    for (const leak of [
      /street/i, /streetview/i, /perplexity/i, /sonar/i, /geocode/i,
      /internet_search/i, /google_maps/i, /verification_status/i, /primary_image_id/i,
    ]) {
      expect(body, `the gate must not encode ${leak}`).not.toMatch(leak);
    }
  });
});

describe('everything else about the function is preserved', () => {
  it('keeps the settlement half exactly as it was', () => {
    expect(body).toMatch(/FROM\s+public\.builder_stock_uploads/i);
    expect(body).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(body).toMatch(/marketplace_eligibility_settled_version, -1\) < v_target/);
    expect(body).toMatch(/image_sanitization_settled_version, -1\) < v_sanitization/);
    expect(body).toMatch(/source_images_settled_version\s+IS\s+NULL/i);
    expect(body).toMatch(/FROM\s+public\.builder_stock_settlement_target/i);
  });

  it('keeps its security posture, invoker and job name', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, extensions');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]{0,160}FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]{0,160}TO postgres, service_role/);
    expect(body).toContain("'builder-stock-image-settler', '{}'::jsonb, 'pg_cron'");
    expect(body).toContain("jobname = 'settle-builder-stock-marketplace-eligibility'");
    // One job, not a second one beside it.
    const schedules = sql.match(/cron\.schedule/g) ?? [];
    expect(schedules).toHaveLength(0);
  });

  it('unschedules only inside the quiet branch, and invokes only outside it', () => {
    const gate = body.search(/IF\s+[a-z_+\s]+?\s*=\s*0\s+THEN/i);
    const unschedule = body.indexOf('cron.unschedule');
    const ret = body.indexOf('RETURN;');
    const invoke = body.indexOf('cron_invoke_signed_function');
    expect(gate).toBeGreaterThan(-1);
    expect(unschedule).toBeGreaterThan(gate);
    expect(ret).toBeGreaterThan(unschedule);
    // The invocation is after the branch closes — never reached when quiet.
    expect(invoke).toBeGreaterThan(ret);
  });

  it('adds no table and no column', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });
});
