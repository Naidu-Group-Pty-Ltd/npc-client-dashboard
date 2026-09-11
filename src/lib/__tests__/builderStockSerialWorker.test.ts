/**
 * Builder stock — one lease at a time, and the whole document behind one slot.
 *
 * MEASURED, 7 SEPTEMBER 2026, upload `bd7a0ef5` (78 properties):
 *
 *   one 8 MB brochure alone     50–68 MB, elects its facade in ~1 s
 *   five of them concurrently   429 MB peak against a 256 MB ceiling → killed
 *   the upload end to end        161 minutes, 0.48 properties a minute
 *
 * The dispatcher was starting one invocation per outstanding property (capped
 * at ten), so concurrency scaled with the backlog and a large import created
 * maximum memory pressure. Throughput was 20× below that dispatcher's own
 * ceiling because every kill discarded all the work in flight.
 *
 * Both fixes are ORDERING properties — that a claim happens after a
 * completion, that a slot is taken before a text read — and ordering cannot be
 * asserted from outside without a live worker. So they are pinned at the
 * source, in the same spirit as the guard-order tests this repository already
 * keeps for the decode slot.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECOVERY_DEADLINE_MS,
} from '../../../supabase/functions/_shared/builderStock/packageImages';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the settler claims serially and never pre-claims a batch', () => {
  const settler = read('supabase/functions/builder-stock-image-settler/index.ts');

  it('claims the next property only AFTER completing the previous one', () => {
    // The safety rule the old one-per-invocation shape existed for: claiming
    // A, B, C, D and dying on A strands three leases held by a process that no
    // longer exists. Order is the whole guarantee.
    const loop = settler.slice(settler.indexOf('for (;;) {'));
    const completed = loop.indexOf('await completeItemWork(');
    const claimedNext = loop.indexOf('await claimOneImageWorkItem(');
    expect(completed).toBeGreaterThan(-1);
    expect(claimedNext).toBeGreaterThan(-1);
    expect(completed).toBeLessThan(claimedNext);
  });

  it('claims exactly one property per turn — no batch call anywhere', () => {
    expect(settler).not.toMatch(/claim(Many|Batch|Several)ImageWorkItems?/);
    // One claim inside the loop, one before it. Never a list.
    const claims = settler.match(/claimOneImageWorkItem\(/g) ?? [];
    expect(claims.length).toBe(2);
  });

  it('reserves enough for the WORST CASE, not merely some time', () => {
    /*
     * THE ARITHMETIC, WHICH A FLAT RESERVE DID NOT SATISFY. A source-stage
     * claim can legitimately spend `RECOVERY_DEADLINE_MS` before it answers,
     * and the recovery does not consult the item's deadline. A flat 30 s
     * reserve therefore permitted a claim at the 70 s mark that could still
     * be running at 145 s — past a 100 s budget, killed mid-flight, which is
     * the failure this change exists to remove.
     *
     * So the numbers are asserted, not the existence of a constant.
     */
    const num = (name: string): number => {
      const m = settler.match(new RegExp(`${name} = ([0-9_]+)`));
      if (!m) throw new Error(`${name} not found`);
      return Number(m[1].replace(/_/g, ''));
    };
    const budget = num('BUDGET_MS');
    const writeBack = num('WRITE_BACK_RESERVE_MS');
    const light = num('LIGHT_STAGE_RESERVE_MS');
    // The heavy reserve is DERIVED from the recovery ceiling, not chosen.
    expect(settler).toMatch(
      /HEAVY_STAGE_RESERVE_MS = RECOVERY_DEADLINE_MS \+ WRITE_BACK_RESERVE_MS/);
    const heavy = RECOVERY_DEADLINE_MS + writeBack;

    // A heavy item started at the threshold can finish and still be written.
    expect(heavy).toBeGreaterThanOrEqual(RECOVERY_DEADLINE_MS + writeBack);
    // And the budget must be able to hold one at all.
    expect(budget).toBeGreaterThanOrEqual(heavy);
    // A light stage needs less, but never less than the write-back itself.
    expect(light).toBeGreaterThan(writeBack);
    expect(light).toBeLessThan(heavy);
  });

  it('refuses a claim it cannot finish instead of starting it', () => {
    // The stage is only known once claimed, so an over-expensive claim is
    // handed back at the same stage with no progress — the recovery never
    // begins, so no attempt is spent and nothing is recorded about the link.
    const loop = settler.slice(settler.indexOf('for (;;) {'));
    // The reserve is still what decides whether the work may START; the
    // document allowance was added beside it and must not displace it.
    expect(loop).toMatch(/const stage = readStage\(candidate\.image_work_stage\);/);
    expect(loop).toMatch(/remaining < reserveFor\(stage\)/);
    expect(loop).toMatch(/const remaining = startedAt \+ BUDGET_MS - Date\.now\(\);/);
    expect(loop).toMatch(/progressed: false/);
    expect(loop).toMatch(/nextStage: stage,/);
  });
});

describe('the whole heavy PDF path is behind one slot', () => {
  /*
   * The slot's wiring MOVED to `pdfElection.ts` when the election became one
   * named unit — the same code lifted verbatim out of `extractFromDocument`,
   * so that the thing measured to exceed an Edge Function's 2,000 ms CPU limit
   * can run on `builder-stock-pdf-worker` instead. Nothing about the guard
   * changed; every assertion below is the one it always was, read where the
   * code now lives.
   */
  const pkg = read('supabase/functions/_shared/builderStock/pdfElection.ts');

  it('takes the slot BEFORE the text read, not just before the election', () => {
    // The hole that let the six die: the text read runs first, parses the same
    // multi-megabyte document (400–1,029 ms against the election's
    // 670–1,215 ms), and was never behind the slot at all.
    const slot = pkg.indexOf('withPdfDecodeSlot');
    const textRead = pkg.indexOf('await readPageTexts(bytes)');
    expect(slot).toBeGreaterThan(-1);
    expect(textRead).toBeGreaterThan(-1);
    expect(slot).toBeLessThan(textRead);
  });

  it('uses the non-re-entrant election inside it, or the slot self-deadlocks', () => {
    expect(pkg).toMatch(/selectPdfPropertyPrimaryHoldingSlot\(bytes/);
    // The wrapping variant would take the slot a second time in one call
    // stack, which is a deadlock rather than a bound.
    expect(pkg).not.toMatch(/await selectPdfPropertyPrimary\(bytes/);
  });

  it('so one document is read end to end before another begins', () => {
    const body = pkg.slice(pkg.indexOf('withPdfDecodeSlot'));
    const textRead = body.indexOf('await readPageTexts(bytes)');
    const election = body.indexOf('selectPdfPropertyPrimaryHoldingSlot(bytes');
    // The closure's own end, searched from after the election so an earlier
    // block's brace cannot stand in for it.
    const close = body.indexOf('\n  });', election);
    expect(textRead).toBeLessThan(election);
    expect(close).toBeGreaterThan(election);
  });
});

describe('concurrency is a property of the runtime, never of the backlog', () => {
  it('the dispatcher starts a fixed small number of workers', () => {
    const migration = read(
      'supabase/migrations/20261113110001_builder_stock_settler_fixed_concurrency.sql');
    expect(migration).toMatch(/v_dispatch := 2;/);
    // The shape that caused the collapse: one worker per outstanding item.
    expect(migration).not.toMatch(/v_dispatch := least\(greatest\(v_item_work/);
  });
});

/**
 * The serial loop's own cost, which the loop introduced.
 *
 * MEASURED 7 SEPTEMBER 2026 on Lot 608 Acclaim Estate (`1nMsonm9`) — the one
 * property of seventy-eight that did not recover when the runtime re-arm
 * landed. Its brochure reads in 0.84 s and carries its facade render on page
 * one; the document was never the problem. Read six times in one process,
 * resident memory went 50 → 173 → 236 → 247 → 254 → 287 → 318 MB: the FIFTH
 * document crosses an Edge Function's ~256 MB ceiling, and the property in
 * the chair at that moment collects a surviving attempt record for a fault
 * that belongs to the invocation.
 *
 * A clock cannot see this — every one of those reads is under a second — so
 * the budget is counted in documents.
 */
describe('one isolate opens a bounded number of documents', () => {
  const settler = read('supabase/functions/builder-stock-image-settler/index.ts');

  it('stops short of the measured crossing rather than at it', () => {
    const m = settler.match(/HEAVY_DOCUMENTS_PER_INVOCATION\s*=\s*(\d+)/);
    expect(m, 'the budget must be a named constant').not.toBeNull();
    const budget = Number(m![1]);
    // Five is where the ceiling was crossed; the budget leaves real margin and
    // is still more than the one-claim-per-invocation this loop replaced.
    expect(budget).toBeGreaterThan(1);
    expect(budget).toBeLessThan(5);
  });

  it('counts only the stage that decodes', () => {
    expect(settler).toMatch(/const isHeavy\s*=\s*\(stage: string\): boolean\s*=>\s*stage === 'source'/);
    // Counted where the property is actually taken, both for the first claim
    // and for every one the loop takes after it.
    expect(settler).toMatch(/if \(isHeavy\(claimed\.image_work_stage\)\) heavyDocuments \+= 1;/);
    expect(settler).toMatch(/isHeavy\(stage\)\s*\n?\s*&& heavyDocuments >= HEAVY_DOCUMENTS_PER_INVOCATION/);
  });

  it('hands the claim back untouched, exactly as the short-clock path does', () => {
    const idx = settler.indexOf('spentOnDocuments || remaining <');
    expect(idx).toBeGreaterThan(0);
    const block = settler.slice(idx, idx + 1400);
    // The row goes back at its own stage, having done nothing, and must not
    // carry the backoff its claim incremented: the invocation ran out of
    // allowance, which is our scheduling and not the property's document.
    expect(block).toContain('nextStage: stage,');
    expect(block).toContain('progressed: false');
    expect(block).toContain('resetAttempts: true');
  });

  it('says which limit it hit, because one column carries both', () => {
    expect(settler).toContain('deferred: this invocation has opened its allowance of documents');
    expect(settler).toContain('deferred: not enough of this invocation left to finish it');
  });
});
