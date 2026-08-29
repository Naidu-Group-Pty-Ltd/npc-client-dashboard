/**
 * BUILDER STOCK — AN IMPORT MUST FINISH ITS OWN IMAGERY, WITH NOBODY WATCHING.
 *
 * PRODUCTION, 28 AUGUST 2026. Upload 4dfe1be7 imported 23 properties at
 * 10:05:33 and did nothing at all. Every card on the live Marketplace read
 * "No image found" — including properties whose builder photographs sat in
 * their own linked Drive folder — and the only thing that started the work was
 * a person running `cron.schedule` by hand. That had already happened once the
 * same morning: jobid 121, then 122, then 123.
 *
 * THE WAKE PATH WAS A ONE-SHOT. `cron.schedule` for this job appears in exactly
 * two places, both migrations that ran once. `cron.unschedule` lives in the
 * tick and fires the moment both queues reach zero, which is correct. Nothing
 * anywhere re-arms it — so the FIRST upload to finish retires the engine
 * permanently and every later import has none. The import path settles inline
 * inside the request and returns; it never touches the schedule.
 *
 * AND THE CADENCE WAS SIZED FOR A CRISIS. Every five minutes, one package per
 * run. Measured across 101 production ticks in the 23 hours to 11:00: median
 * under 7 seconds, maximum 16.9 seconds. The engine idled 96% of every
 * interval while a builder watched blank cards.
 *
 * WHY THESE ARE TEXT TESTS. The rules live in PL/pgSQL and this repository has
 * no in-process Postgres, so they are asserted against the REAL MIGRATION TEXT
 * — the same approach, for the same reason, as `builderStockCronGate.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION =
  'supabase/migrations/20261012000000_builder_stock_auto_source_drain.sql';
const sql = readFileSync(join(REPO_ROOT, MIGRATION), 'utf8');
const GATE = readFileSync(join(REPO_ROOT,
  'supabase/migrations/20261005000000_builder_stock_cron_gate_fallback.sql'), 'utf8');
const SETTLER = readFileSync(join(REPO_ROOT,
  'supabase/functions/builder-stock-image-settler/index.ts'), 'utf8');

/** The body of one named function as shipped. */
const bodyOf = (name: string) => {
  const at = sql.indexOf(`FUNCTION public.${name}`);
  expect(at).toBeGreaterThan(-1);
  const start = sql.indexOf('AS $$', at);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe('a finished upload may leave no engine behind', () => {
  it('the tick still unschedules itself when both queues are empty', () => {
    // Unchanged and deliberate. This test exists to pin that the fix does NOT
    // work by keeping a job alive for ever.
    expect(GATE).toContain("PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility')");
    expect(GATE).toContain('IF v_outstanding + v_fallback = 0 THEN');
  });

  it('nothing in the import path re-arms it, which is why this migration exists', () => {
    // The only schedulers are migrations. If an edge function ever schedules
    // directly this assertion should be revisited deliberately, not silently.
    const portal = readFileSync(join(REPO_ROOT,
      'supabase/functions/builder-portal-stock/index.ts'), 'utf8');
    expect(portal).not.toContain('cron.schedule');
  });
});

describe('every insert of a property re-arms the engine', () => {
  const rearm = bodyOf('ensure_builder_stock_settlement_scheduled');

  it('schedules the job when it is absent', () => {
    expect(rearm).toContain("cron.schedule(");
    expect(rearm).toContain("'settle-builder-stock-marketplace-eligibility'");
  });

  it('is idempotent — an existing job is left exactly as it is', () => {
    // The early return must come BEFORE the schedule call, or a second import
    // would replace or duplicate a running job.
    const existing = rearm.indexOf('IF EXISTS (');
    const schedule = rearm.indexOf('cron.schedule(');
    expect(existing).toBeGreaterThan(-1);
    expect(existing).toBeLessThan(schedule);
    expect(rearm).toMatch(/WHERE jobname = 'settle-builder-stock-marketplace-eligibility'[\s\S]*?RETURN false;/);
  });

  it('does nothing where pg_cron is not installed', () => {
    expect(rearm).toMatch(/pg_extension WHERE extname = 'pg_cron'[\s\S]*?RETURN false;/);
  });

  it('is attached to the rows, so any import path arms it', () => {
    // Attaching to the WRITE rather than to one caller is what makes a future
    // import format arm the engine without remembering to.
    expect(sql).toContain('AFTER INSERT ON public.builder_stock_items');
    expect(sql).toContain('FOR EACH STATEMENT');
    expect(sql).toContain('EXECUTE FUNCTION public.builder_stock_items_rearm_settlement()');
  });

  it('needs no browser, no operator and no manual SQL', () => {
    // A trigger on the table is reachable from every writer, including the
    // background ones. Nothing here depends on a client call.
    const trigger = bodyOf('builder_stock_items_rearm_settlement');
    expect(trigger).toContain('ensure_builder_stock_settlement_scheduled()');
  });
});

describe('a shorter cadence, and only while there is work', () => {
  it('offers a turn every minute instead of every five', () => {
    expect(bodyOf('ensure_builder_stock_settlement_scheduled')).toContain("'* * * * *'");
  });

  it('does not raise the per-run package cap', () => {
    // The whole point: more turns, never more work per turn.
    const repair = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/packageImages.ts'), 'utf8');
    const shared = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');
    // Neither the migration nor the settler may ASSIGN it; the migration is
    // free to name it in prose, and does, to say it is deliberately untouched.
    expect(`${sql}${SETTLER}`).not.toMatch(/MAX_PACKAGE_RECOVERIES_PER_RUN\s*=/);
    expect(`${repair}${shared}`).toMatch(/MAX_PACKAGE_RECOVERIES_PER_RUN\s*=\s*1\b/);
  });

  it('does not give a run more wall clock', () => {
    expect(SETTLER).toContain('const BUDGET_MS = 100_000;');
  });

  it('an idle deployment is left with no job at all', () => {
    // The one-off re-arm at the end of the migration is conditional on work.
    expect(sql).toMatch(/enrichment_status IN \('pending', 'enriching'\)[\s\S]*?ensure_builder_stock_settlement_scheduled\(\)/);
  });
});

describe('two settlers can never run at once', () => {
  const claim = bodyOf('claim_builder_stock_settlement_lease');

  it('the lease is compare-and-set, not a read then a write', () => {
    expect(claim).toContain('leased_until <= now()');
    expect(claim).toContain('SET leased_until = now() +');
    expect(claim).toContain('RETURNING true');
  });

  it('the settler takes it before doing any work', () => {
    // Against the CALL SITE, not the import at the top of the file.
    const claimAt = SETTLER.indexOf("claim_builder_stock_settlement_lease");
    const work = SETTLER.indexOf('await readSettlementReadiness(supabase)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(work);
  });

  it('a declined turn is a normal outcome, not a failure', () => {
    expect(SETTLER).toContain("skipped: 'lease_held'");
    // A lease that cannot be READ is different — that is a deployment fault.
    expect(SETTLER).toContain('Settlement lease unavailable');
  });

  it('the lease outlives the longest run the budget permits', () => {
    // 100s budget + margin, so it cannot expire under a run still going.
    expect(SETTLER).toContain('p_seconds: Math.ceil(BUDGET_MS / 1000) + 20');
  });

  it('a killed worker cannot wedge the queue shut', () => {
    // Expiry, not release, is what survives a resource-limit kill — which runs
    // no `finally` and returns nothing.
    expect(claim).toContain('make_interval');
    expect(SETTLER).toContain('await releaseLease();');
  });
});

describe('the lease and the re-arm are not reachable by a browser', () => {
  it('every new function is revoked from anon and authenticated', () => {
    /*
     * THE TRIGGER FUNCTION IS IN THIS LIST BECAUSE IT WAS MISSING FROM IT.
     *
     * CI caught it: `CREATE FUNCTION` grants EXECUTE to PUBLIC by default and
     * `anon` inherits it, so a SECURITY DEFINER trigger body — this one reaches
     * `cron.schedule` — shipped callable by the publishable key in the browser
     * bundle. The trigger fires as the table owner and needs no grant at all.
     */
    for (const fn of [
      'claim_builder_stock_settlement_lease',
      'release_builder_stock_settlement_lease',
      'ensure_builder_stock_settlement_scheduled',
      'builder_stock_items_rearm_settlement',
    ]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]*?FROM PUBLIC, anon, authenticated`));
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO postgres, service_role`));
    }
  });

  it('the lease table carries RLS and no public grant', () => {
    expect(sql).toContain('ALTER TABLE public.builder_stock_settlement_lease ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON TABLE public.builder_stock_settlement_lease FROM PUBLIC, anon, authenticated');
  });
});
