/**
 * BUILDER STOCK — ONE PROPERTY'S FAILURE MUST COST ONE PROPERTY.
 *
 * PRODUCTION, 29 AUGUST 2026, seventeen minutes of the settler:
 *
 *     02:19:09  CPU Time exceeded      (claimed the lease, killed, no release)
 *     02:20:01  lease_held
 *     02:21:01  lease_held
 *     02:22:08  lease claim: canceling statement due to statement timeout
 *     02:23:07  CPU Time exceeded
 *     02:24:01  lease_held
 *     ...
 *
 * Six kills, ten skips, not one completed tick, no work at all. Upload
 * `d49ca895` had imported 23 properties twenty-six hours earlier; the walk had
 * reached item 13 and items 14 to 23 had never been read once.
 *
 * Two structures produced it. The imagery walk is ordered by `created_at` with
 * NO CURSOR and ends the whole run on the first cap it hits, so everything
 * behind the expensive property waits for ever. And the lease is ONE BOOLEAN
 * ROW for the whole deployment — a killed worker runs no `finally`, so it holds
 * that row until it expires and the queue is shut for everybody, not just for
 * the property that died.
 *
 * This file pins the replacement. It is ORCHESTRATION ONLY: source discovery,
 * the Drive rendition rule, web verification, the Street View distance guard,
 * image priority and the sanitizer are called exactly as they were and decide
 * exactly what they decided. What changes is WHICH property, WHEN, and what is
 * written down afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimOneImageWorkItem, completeItemWork, isMissingCapability, readItemWorkPending,
  type ClaimedItem,
} from '../../../supabase/functions/_shared/builderStock/itemWorkClaim';
import {
  settleClaimedItem,
} from '../../../supabase/functions/_shared/builderStock/settleItemImages';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SETTLER = readFileSync(join(REPO_ROOT,
  'supabase/functions/builder-stock-image-settler/index.ts'), 'utf8');

const ORG = 'org-a';

function itemAt(id: string, stage = 'source'): ClaimedItem {
  return {
    id, organisation_id: ORG, upload_id: 'upload-1',
    image_work_stage: stage, image_work_attempts: 0, lifecycle_status: 'active',
  };
}

// ---------------------------------------------------------------------------
// A database that behaves like the claim actually behaves
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  stage: string;
  attempts: number;
  claimUntil: number | null;
  nextAttemptAt: number;
}

/**
 * `claim_builder_stock_image_work` and friends, faithful to the SQL.
 *
 * The important fidelity is the SKIP: a property whose lease has not expired,
 * or whose backoff has not elapsed, is not offered — which is the whole
 * mechanism by which a killed worker costs one property and nobody else.
 */
function fakeClaimDb(rows: QueueRow[], options: { deployed?: boolean } = {}) {
  const deployed = options.deployed !== false;
  const now = () => Date.now();
  const missing = {
    data: null,
    error: { code: '42883', message: 'function public.claim_builder_stock_image_work does not exist' },
  };

  const db = {
    rows,
    calls: [] as string[],
    async rpc(name: string, args: Record<string, unknown> = {}) {
      db.calls.push(name);
      if (!deployed) return missing;

      if (name === 'claim_builder_stock_image_work') {
        const due = rows
          .filter((row) => row.stage !== 'settled')
          .filter((row) => row.nextAttemptAt <= now())
          .filter((row) => row.claimUntil === null || row.claimUntil < now())
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id.localeCompare(b.id));
        const limit = Number(args.p_limit ?? 1);
        const taken = due.slice(0, limit);
        for (const row of taken) {
          row.claimUntil = now() + Number(args.p_lease_seconds ?? 120) * 1000;
          row.nextAttemptAt = now()
            + Math.min(30 * Math.pow(2, Math.min(row.attempts, 7)), 3600) * 1000;
          row.attempts += 1;
        }
        return {
          data: taken.map((row) => ({
            id: row.id, organisation_id: ORG, upload_id: 'upload-1',
            image_work_stage: row.stage, image_work_attempts: row.attempts,
            lifecycle_status: 'active',
          })),
          error: null,
        };
      }

      if (name === 'complete_builder_stock_image_work') {
        const row = rows.find((candidate) => candidate.id === args.p_item_id);
        if (row) {
          const next = (args.p_next_stage as string | null) ?? row.stage;
          if (args.p_reset_attempts === true) row.attempts = 0;
          else if (next !== row.stage) row.attempts = 0;
          row.stage = next;
          row.claimUntil = null;
          row.nextAttemptAt = now() + Number(args.p_retry_after_seconds ?? 0) * 1000;
        }
        return { data: true, error: null };
      }

      if (name === 'builder_stock_image_work_pending') {
        const outstanding = rows.filter((row) => row.stage !== 'settled');
        return {
          data: [{
            claimable: outstanding.filter((row) =>
              row.nextAttemptAt <= now() && (row.claimUntil === null || row.claimUntil < now())).length,
            outstanding: outstanding.length,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return db;
}

/**
 * A property waiting in the queue, in the position the caller lists it.
 *
 * The real claim orders by `image_work_next_attempt_at, id`, so "first",
 * "middle" and "last" below have to be expressed as due times rather than as
 * array positions or names — otherwise the fixture would sort alphabetically
 * and a test called "toxic in the middle" would not have one there.
 */
let queuedAt = 0;
const queued = (id: string, stage = 'source'): QueueRow => ({
  id, stage, attempts: 0, claimUntil: null,
  nextAttemptAt: Date.now() - 100_000 + (queuedAt += 1),
});

// ---------------------------------------------------------------------------
// 1-3. The claim, and what a missing migration means
// ---------------------------------------------------------------------------

describe('the claim is present', () => {
  it('claims EXACTLY ONE property, never a batch', async () => {
    /*
     * Claiming a batch and working through it inside one invocation rebuilds
     * the very thing this replaces: claim A, B, C, D — A kills the worker —
     * and B, C and D are leased by a process that no longer exists, having
     * never been looked at. Throughput comes from invoking more often.
     */
    const db = fakeClaimDb([queued('a'), queued('b'), queued('c'), queued('d')]);
    const claim = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    expect(claim.available).toBe(true);
    expect(db.rows.filter((row) => row.claimUntil !== null)).toHaveLength(1);
  });

  it('is asked for one item by the settler itself, not merely capable of it', () => {
    expect(SETTLER).toMatch(/claimOneImageWorkItem\(/);
    // And the module hard-codes the singular, so no caller can widen it.
    const claimSource = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/itemWorkClaim.ts'), 'utf8');
    expect(claimSource).toMatch(/p_limit: 1/);
  });
});

describe('the claim is NOT deployed yet', () => {
  it('reports skew rather than throwing', async () => {
    const db = fakeClaimDb([queued('a')], { deployed: false });
    await expect(claimOneImageWorkItem(db as never)).resolves.toEqual({ available: false });
  });

  it('recognises every spelling of "not deployed", and nothing else', () => {
    // Three layers can answer first: Postgres (42883), PostgREST's schema
    // cache, and its own PGRST202.
    expect(isMissingCapability({ code: '42883' })).toBe(true);
    expect(isMissingCapability({ code: 'PGRST202' })).toBe(true);
    expect(isMissingCapability({ message: 'Could not find the function in the schema cache' }))
      .toBe(true);
    // DELIBERATELY NARROW. A live fault must never be downgraded to skew — that
    // would hide a broken database behind the slow path.
    expect(isMissingCapability({ code: '57014', message: 'canceling statement due to statement timeout' }))
      .toBe(false);
    expect(isMissingCapability({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingCapability(null)).toBe(false);
  });

  it('makes the settler LOG the skew and fall through to the old path', () => {
    // Not a 503. On 29 August a settler requiring an unapplied lease function
    // answered 503 on every tick and the whole marketplace went blank.
    const skew = SETTLER.slice(SETTLER.indexOf('DEPLOYMENT SKEW'));
    expect(skew).toMatch(/deployment_skew/);
    expect(skew).toMatch(/20261019000000_builder_stock_item_work_claim\.sql/);
    // The skew branch reaches the upload walk rather than returning.
    expect(skew).toMatch(/ONE SETTLER AT A TIME/);
  });

  it('REFUSES loudly when the claim works but the completion does not', () => {
    /*
     * The worst half of a half-deployed migration, and it existed in
     * production: 20261019000000 shipped `complete_builder_stock_image_work`
     * with five arguments while this code calls it with six, and PostgREST
     * resolves by argument NAMES — so the claim succeeds, the work is done,
     * and nothing records it. The property stays leased until expiry and is
     * then re-done, for ever.
     *
     * Silence is the one unacceptable answer. There is no repair from inside
     * the function, so it names the migration and refuses, rather than
     * reporting a successful tick that settled nothing.
     */
    expect(SETTLER).toMatch(/if \(!completion\.available\)/);
    expect(SETTLER).toMatch(/work was claimed but could not be recorded/);
    expect(SETTLER).toMatch(/20261021000000_builder_stock_item_work_claim_amendments\.sql/);
    expect(SETTLER).toMatch(/item_completion_unavailable/);
  });

  it('does not 503 the OLD path either when ITS lease is undeployed', () => {
    /*
     * The fallback must not reintroduce the failure it exists to survive. A
     * deployment with neither migration applied would otherwise answer 503
     * here — an outage reached by falling back FROM an outage.
     */
    expect(SETTLER).toMatch(/const leaseMissing = !!lease\.error && isMissingCapability\(lease\.error\)/);
    expect(SETTLER).toMatch(/if \(lease\.error && !leaseMissing\)/);
    expect(SETTLER).toMatch(/if \(leaseMissing\) return;/);
    // A live lease FAULT still refuses, because that is not skew.
    expect(SETTLER).toMatch(/Settlement lease unavailable/);
  });
});

describe('the global settlement lease is bypassed on the new path', () => {
  it('is claimed only AFTER the per-item path has declined', () => {
    const itemClaimAt = SETTLER.indexOf('claimOneImageWorkItem(');
    const leaseAt = SETTLER.indexOf("supabase.rpc('claim_builder_stock_settlement_lease'");
    expect(itemClaimAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(itemClaimAt);
  });

  it('returns from the per-item path without ever reaching the lease', () => {
    /*
     * All THREE per-item outcomes answer and return above the lease: nothing
     * due, a completion the database cannot record, and one property settled.
     * The block itself names the global lease nowhere at all.
     */
    const perItem = SETTLER.slice(
      SETTLER.indexOf('THE PER-ITEM PATH'),
      SETTLER.indexOf('DEPLOYMENT SKEW'));
    expect(perItem).not.toMatch(/claim_builder_stock_settlement_lease/);
    expect((perItem.match(/path: 'item_work'/g) ?? []).length).toBe(3);
    expect(perItem).toMatch(/complete: pending\.outstanding === 0/);
    expect(perItem).toMatch(/item_completion_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// 4-9. What a claimed property's work is scoped to
// ---------------------------------------------------------------------------

describe('a claimed property is worked ALONE', () => {
  it('scopes the source stage to that stock_item_id', async () => {
    const repairSource = vi.fn().mockResolvedValue({
      imagesStored: 1, matched: 1, demoted: 0, primaryUpdated: 1, incomplete: false,
    });
    const settlement = await settleClaimedItem(
      {} as never, itemAt('item-7'), {}, {
        repairSource: repairSource as never,
        choosePrimary: (async () => 'image-1') as never,
      });
    expect(repairSource).toHaveBeenCalledTimes(1);
    expect(repairSource.mock.calls[0][1]).toMatchObject({
      onlyItemId: 'item-7', uploadId: 'upload-1', organisationId: ORG,
    });
    expect(settlement.nextStage).toBe('eligibility');
  });

  it('scopes eligibility, sanitization and fallback to that property too', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const record = (index: number) => (async (...args: unknown[]) => {
      calls.push(args[index] as Record<string, unknown>);
      return {
        assessed: 0, scanned: 0, incomplete: false,
        repaired: 0, cleared: 0, attempted: 0, resolved: 0, remaining: 0,
      };
    });
    for (const stage of ['eligibility', 'sanitization', 'fallback'] as const) {
      await settleClaimedItem({} as never, itemAt('item-7', stage), {}, {
        settleEligibility: record(2) as never,
        settleSanitization: record(2) as never,
        settleFallback: record(1) as never,
        choosePrimary: (async () => null) as never,
      });
    }
    expect(calls).toHaveLength(3);
    for (const options of calls) expect(options.stockItemId).toBe('item-7');
  });

  it('does not walk the upload by created_at on the new path', () => {
    /*
     * The scoping is inside `repairSourceImages`, and it is deliberately
     * applied AFTER identity is resolved: the reference, development/unit and
     * fingerprint keys are positional against a document that can list one lot
     * twice, so resolving a subset would hand the second row's picture to the
     * first row's property. Only the work is skipped, never the identity.
     */
    const repair = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');
    expect(repair).toMatch(/if \(input\.onlyItemId && itemId !== input\.onlyItemId\) continue;/);
    const scopeAt = repair.indexOf('if (input.onlyItemId && itemId !== input.onlyItemId)');
    const identityAt = repair.indexOf('byFingerprint.get(stockRowFingerprint(record))?.shift()');
    expect(identityAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(identityAt);
  });

  it('never stamps the upload-wide "no row assets left" marker on a scoped run', () => {
    // That marker is a statement about the whole upload. A run that looked at
    // one property has established nothing of the kind, and writing it would
    // strand every other property's cover behind it.
    const repair = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/repairSourceImages.ts'), 'utf8');
    expect(repair).toMatch(
      /if \(!input\.onlyItemId && notionAssetsRead && !assetRowsDeferred && !rowAssetsEnumerated\)/);
  });
});

describe('the package attempt stays the package\'s own', () => {
  it('is not touched by the orchestration', () => {
    /*
     * MAX_PACKAGE_ATTEMPTS = 2 remains authoritative, is written before the
     * download begins, and lives in `source_provenance_result`. Nothing in the
     * per-item machinery may become a second opinion about it.
     *
     * WHAT CHANGED, AND WHY THE RULE DID NOT. The stage machine now READS that
     * column, because the fallback gate has to know whether the builder's own
     * sources are finished with before it routes a property to the external
     * ladder. Reading is not a second opinion; WRITING is, and so is owning
     * the counter. So the rule is pinned as it was always meant: the settler
     * may not name the budget, may not import the attempt module, and may not
     * write the column. `readSuppliedEvidence` is the one interpreter and it
     * is a pure function both this and `settleFallbackImages` call.
     */
    const stageMachine = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/settleItemImages.ts'), 'utf8');
    const code = stageMachine.replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    expect(code).not.toContain('MAX_PACKAGE_ATTEMPTS');
    expect(code).not.toContain('packageAttempt');
    // No write, in any of the shapes a write takes.
    expect(code).not.toMatch(/source_provenance_result\s*:/);
    expect(code).not.toMatch(/\.update\([^)]*source_provenance_result/);
    // And the reading it does make goes through the one shared interpreter.
    expect(code).toContain('readSuppliedEvidence');
  });

  it('gives one property the whole tick, which is what lets a package be attempted at all', () => {
    /*
     * The upload walk gave each property a 12-second slice of which the
     * preceding twelve had already spent most, and a package recovery declines
     * the bet unless ten seconds remain — so Lot 104 could be starved
     * indefinitely while the counter that would have retired it never
     * advanced. It sat at `attempts: 1` for a day.
     */
    expect(SETTLER).toMatch(/deadlineAt: startedAt \+ BUDGET_MS - 10_000/);
  });

  it('lets an exhausted package move the property ON rather than back', async () => {
    // `repairSourceImages` writes the terminal `no_deterministic_image` verdict
    // itself and reports complete, so the property advances and reaches its own
    // fallback ladder. A pinned upload is what the alternative looked like.
    const settlement = await settleClaimedItem({} as never, itemAt('item-7'), {}, {
      repairSource: (async () => ({
        imagesStored: 0, matched: 1, demoted: 0, primaryUpdated: 0, incomplete: false,
      })) as never,
      choosePrimary: (async () => null) as never,
    });
    expect(settlement.nextStage).toBe('eligibility');
  });
});

describe('the card\'s picture is settled after every stage', () => {
  it('runs the existing idempotent selection for that property', async () => {
    const choosePrimary = vi.fn().mockResolvedValue('image-9');
    const settlement = await settleClaimedItem({} as never, itemAt('item-7', 'eligibility'), {}, {
      settleEligibility: (async () => ({ assessed: 1, scanned: 1, incomplete: false })) as never,
      choosePrimary: choosePrimary as never,
    });
    expect(choosePrimary).toHaveBeenCalledWith({}, 'item-7');
    expect(settlement.primarySet).toBe(true);
  });

  it('settles it even when the stage FAILED', async () => {
    /*
     * The pointer is decided from rows already in the table. A photograph an
     * earlier tick approved must not stay unpointed because a later stage
     * threw — which is the shape of the live defect: seven properties held a
     * ready, primary_property, ELIGIBLE builder photograph and a NULL pointer,
     * waiting on an unrelated walk over twenty-three properties.
     */
    const choosePrimary = vi.fn().mockResolvedValue('image-9');
    const settlement = await settleClaimedItem({} as never, itemAt('item-7'), {}, {
      repairSource: (async () => { throw new Error('boom'); }) as never,
      choosePrimary: choosePrimary as never,
    });
    expect(settlement.error).toContain('boom');
    expect(settlement.nextStage).toBe('source');
    expect(choosePrimary).toHaveBeenCalledWith({}, 'item-7');
    expect(settlement.primarySet).toBe(true);
  });

  it('does not fail the settlement when the pointer cannot be written', async () => {
    const settlement = await settleClaimedItem({} as never, itemAt('item-7'), {}, {
      repairSource: (async () => ({
        imagesStored: 1, matched: 1, demoted: 0, primaryUpdated: 0, incomplete: false,
      })) as never,
      choosePrimary: (async () => { throw new Error('pointer'); }) as never,
    });
    expect(settlement.nextStage).toBe('eligibility');
    expect(settlement.primarySet).toBe(false);
  });
});

describe('a resumable step is not punished for resuming', () => {
  it('stays on its stage and reports progress', async () => {
    const settlement = await settleClaimedItem({} as never, itemAt('item-7'), {}, {
      repairSource: (async () => ({
        imagesStored: 2, matched: 1, demoted: 0, primaryUpdated: 0, incomplete: true,
      })) as never,
      choosePrimary: (async () => null) as never,
    });
    expect(settlement.nextStage).toBe('source');
    expect(settlement.progressed).toBe(true);
  });

  it('clears the attempt count through the completion, so backoff does not compound', async () => {
    const db = fakeClaimDb([queued('a')]);
    await claimOneImageWorkItem(db as never);
    expect(db.rows[0].attempts).toBe(1);
    await claimOneImageWorkItem(db as never); // leased, so nobody else gets it
    await completeItemWork(db as never, 'a', {
      nextStage: 'source', result: 'partial', progressed: true,
    });
    expect(db.rows[0].attempts).toBe(0);
    expect(db.rows[0].claimUntil).toBeNull();
  });

  it('a step that made no progress keeps the count', async () => {
    const db = fakeClaimDb([queued('a')]);
    await claimOneImageWorkItem(db as never);
    await completeItemWork(db as never, 'a', {
      nextStage: 'source', result: 'nothing', progressed: false,
    });
    expect(db.rows[0].attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The regression matrix
// ---------------------------------------------------------------------------

describe('one killed property cannot block another', () => {
  it('toxic FIRST: the second property still processes', async () => {
    const db = fakeClaimDb([queued('toxic'), queued('healthy')]);
    // Invocation 1 claims the toxic property and is killed — no completion.
    const first = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    expect(first.available && first.item?.id).toBe('toxic');
    // Invocation 2, a minute later. SKIP LOCKED steps over the leased row.
    const second = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    expect(second.available && second.item?.id).toBe('healthy');
  });

  it('toxic in the MIDDLE: everything after it still processes', async () => {
    const db = fakeClaimDb([queued('a'), queued('toxic'), queued('c'), queued('d')]);
    const seen: string[] = [];
    for (let invocation = 0; invocation < 4; invocation += 1) {
      const claim = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
      if (!claim.available || !claim.item) break;
      seen.push(claim.item.id);
      // Every property except the toxic one completes and settles.
      if (claim.item.id !== 'toxic') {
        await completeItemWork(db as never, claim.item.id, { nextStage: 'settled' });
      }
    }
    expect(seen).toEqual(['a', 'toxic', 'c', 'd']);
    expect(db.rows.filter((row) => row.stage === 'settled').map((row) => row.id))
      .toEqual(['a', 'c', 'd']);
  });

  it('toxic LAST: it affects only itself', async () => {
    const db = fakeClaimDb([queued('a'), queued('b'), queued('toxic')]);
    for (let invocation = 0; invocation < 3; invocation += 1) {
      const claim = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
      if (!claim.available || !claim.item) break;
      if (claim.item.id !== 'toxic') {
        await completeItemWork(db as never, claim.item.id, { nextStage: 'settled' });
      }
    }
    const pending = await readItemWorkPending(db as never);
    expect(pending.outstanding).toBe(1);
    expect(pending.claimable).toBe(0); // leased by the worker that died
  });

  it('a CPU kill leaves a claim on that property and on no other', async () => {
    const db = fakeClaimDb([queued('a'), queued('b'), queued('c')]);
    await claimOneImageWorkItem(db as never, { leaseSeconds: 120 }); // killed
    expect(db.rows.filter((row) => row.claimUntil !== null).map((row) => row.id)).toEqual(['a']);
    expect(db.rows.filter((row) => row.attempts > 0).map((row) => row.id)).toEqual(['a']);
  });

  it('the same property cannot be claimed twice concurrently', async () => {
    const db = fakeClaimDb([queued('only')]);
    const first = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    const second = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    expect(first.available && first.item?.id).toBe('only');
    expect(second.available && second.item).toBeNull();
  });

  it('two invocations may safely own DIFFERENT properties', async () => {
    const db = fakeClaimDb([queued('a'), queued('b')]);
    const [first, second] = await Promise.all([
      claimOneImageWorkItem(db as never, { leaseSeconds: 120 }),
      claimOneImageWorkItem(db as never, { leaseSeconds: 120 }),
    ]);
    const ids = [first, second]
      .map((claim) => (claim.available ? claim.item?.id : null))
      .filter(Boolean)
      .sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('an expired claim is reclaimable', async () => {
    const db = fakeClaimDb([queued('a')]);
    await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    // The lease and the backoff both elapse. Nothing hand-releases it: a killed
    // worker runs no `finally`, so expiry is the ONLY way back.
    db.rows[0].claimUntil = Date.now() - 1;
    db.rows[0].nextAttemptAt = Date.now() - 1;
    const again = await claimOneImageWorkItem(db as never, { leaseSeconds: 120 });
    expect(again.available && again.item?.id).toBe('a');
    expect(db.rows[0].attempts).toBe(2);
  });

  it('a settled property leaves both counts', async () => {
    const db = fakeClaimDb([queued('a'), queued('b')]);
    await completeItemWork(db as never, 'a', { nextStage: 'settled' });
    const pending = await readItemWorkPending(db as never);
    expect(pending).toMatchObject({ available: true, claimable: 1, outstanding: 1 });
  });
});

describe('the scheduler is told both numbers', () => {
  it('reports claimable and outstanding, and completes only on outstanding', () => {
    // Nothing claimable with work outstanding means every candidate is leased
    // or backing off — keep the job. Retiring on `claimable` would kill the
    // engine at exactly the moment a worker died.
    expect(SETTLER).toMatch(/complete: pending\.outstanding === 0/);
    expect(SETTLER).not.toMatch(/complete: pending\.claimable === 0/);
  });

  it('answers "nothing due" without claiming anything', async () => {
    const db = fakeClaimDb([]);
    const claim = await claimOneImageWorkItem(db as never);
    expect(claim).toEqual({ available: true, item: null });
  });
});

describe('nothing about an image is decided here', () => {
  it('leaves source identity, the rendition rule and the ladder guards untouched', () => {
    /*
     * PR 3 is orchestration. These are the modules that decide what a picture
     * IS, and not one of them is imported by the per-item machinery.
     */
    const stageMachine = readFileSync(join(REPO_ROOT,
      'supabase/functions/_shared/builderStock/settleItemImages.ts'), 'utf8');
    for (const untouched of [
      'drivePackage', 'streetViewHeading', 'imagePriority', 'webImageIdentity',
      'sanitizeImage', 'normalise.pure',
    ]) {
      expect(stageMachine).not.toContain(untouched);
    }
  });
});

/**
 * BUILDER STOCK — AN EMPTY ITEM QUEUE IS WHEN THE UPLOAD MARKERS ARE OWED.
 *
 * PRODUCTION, 30 AUGUST - 1 SEPTEMBER 2026. Upload `a0f8dfe4` (`export.csv`,
 * 26 properties) settled every one of its items and then sat at
 * `status = 'enriching'` for thirty-six hours with all three upload markers
 * NULL — `source_images_settled_version`,
 * `marketplace_eligibility_settled_version`,
 * `image_sanitization_settled_version`.
 *
 * The per-item queue replaced the upload walk for finding and judging
 * pictures, but never took over stamping those markers: only
 * `settleUploadSourceImages` writes them, and it is reached only through the
 * sweep that sits BELOW the deployment-skew branch. With the claim function
 * deployed, that branch is unreachable — measured, 4,438 settler invocations
 * in twenty-four hours, every one an item tick, NOT ONE a settlement tick and
 * not one reporting skew.
 *
 * `builder_stock_uploads` therefore never stopped counting as outstanding, so
 * `settle_builder_stock_marketplace_eligibility_tick` could never satisfy its
 * own retirement condition and the cron fired once a minute for ever against
 * an empty queue.
 */
describe('a drained per-item queue continues to the upload-level sweep', () => {
  it('returns early only while item work is still outstanding', () => {
    // Nothing due but something still leased or backing off is the case the
    // early return exists for, and it keeps it.
    expect(SETTLER).toMatch(/if \(pending\.outstanding > 0\) \{/);
  });

  it('falls through when the queue is genuinely empty', () => {
    expect(SETTLER).toMatch(/itemQueueDrained = true;/);
    // And the sweep that stamps the markers is what it falls through to.
    const afterDrain = SETTLER.slice(SETTLER.indexOf('itemQueueDrained = true;'));
    expect(afterDrain).toMatch(/runSettlementTick\(/);
    expect(afterDrain).toMatch(/settleUploadSourceImages\(/);
  });

  it('does not cry deployment skew when the queue is merely empty', () => {
    // The warning names an unapplied migration and a remedy. Emitting it on a
    // healthy deployment every minute would make a real skew unfindable.
    expect(SETTLER).toMatch(/if \(!itemQueueDrained\) \{\s*console\.warn/);
  });

  it('still reports skew when the claim function really is missing', () => {
    // Unchanged: `available: false` sets nothing, so the warning still fires.
    const skew = SETTLER.slice(SETTLER.indexOf('DEPLOYMENT SKEW'));
    expect(skew).toMatch(/deployment_skew/);
    expect(skew).toMatch(/20261019000000_builder_stock_item_work_claim\.sql/);
  });

  it('reaches the sweep under the SAME lease, so two ticks cannot overlap', () => {
    const drainAt = SETTLER.indexOf('itemQueueDrained = true;');
    const leaseAt = SETTLER.indexOf("claim_builder_stock_settlement_lease");
    expect(drainAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(drainAt);
  });
});

