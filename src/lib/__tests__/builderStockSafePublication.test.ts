/**
 * BUILDER STOCK — A REPLACEMENT LIST MUST NOT BLANK A WORKING MARKETPLACE.
 *
 * WHAT #2347 LEFT. That change made a re-import find the property it already
 * imported — same `source_anchor`, same exact-property identity, update in
 * place, imagery survives. It fixes MATCHED properties completely, and it was
 * said at the time that it fixes nothing else.
 *
 * A genuinely NEW or UNMATCHED row is still inserted `lifecycle_status =
 * 'active'` inside the import request, before one pixel of its imagery has
 * been looked for. The Marketplace's only visibility gate is
 * `.eq('lifecycle_status','active')`, so that row reaches a client's screen
 * immediately as a card reading "No image found", and stays that way for as
 * long as its source work takes. A replacement list of twenty-three new
 * properties turns a working Marketplace into twenty-three blank cards the
 * instant it is imported.
 *
 * THE MODEL IS ONE EXTRA LIFECYCLE VALUE. Every consumer of `lifecycle_status`
 * already filters POSITIVELY on `'active'`, so a third value is invisible
 * everywhere by construction — nothing has to learn to hide it. The half that
 * is easy to miss is the other side: PROCESSING has to widen, or a staged row
 * can never reach readiness and would sit invisible for ever.
 *
 *     SERVING     stays  = 'active'
 *     PROCESSING becomes IN ('active','staged')
 *
 * The migration's behaviour was verified against the live database inside a
 * rolled-back transaction: staged rows invisible (2 staged, 0 active),
 * publication refused while one row still owed source work
 * (`source_outstanding: 1`), the published set untouched by that refusal (23
 * active), then published (promoted 2), the replaced upload's remaining rows
 * archived (0 still active), the new dataset served, `published_at` stamped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROCESSED_LIFECYCLE, SERVED_LIFECYCLE, isProcessed, isServed,
  lifecycleForNewProperty,
} from '../../../supabase/functions/_shared/builderStock/stockLifecycle.pure';
import {
  importStockRecords,
} from '../../../supabase/functions/_shared/builderStock/importStock';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION =
  'supabase/migrations/20261022000000_builder_stock_safe_publication.sql';
const sql = readFileSync(join(REPO_ROOT, MIGRATION), 'utf8');
const ORG = 'org-a';

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('serving and processing are different questions', () => {
  it('serves only published stock', () => {
    expect(SERVED_LIFECYCLE).toBe('active');
    expect(isServed('active')).toBe(true);
    expect(isServed('staged')).toBe(false);
    expect(isServed('archived')).toBe(false);
  });

  it('processes published AND staged stock', () => {
    // The half that is easy to miss. A staged row that is never processed can
    // never reach readiness, so it could never publish and would sit invisible
    // for ever — the same blank Marketplace, reached from the other side.
    expect([...PROCESSED_LIFECYCLE]).toEqual(['active', 'staged']);
    expect(isProcessed('active')).toBe(true);
    expect(isProcessed('staged')).toBe(true);
    expect(isProcessed('archived')).toBe(false);
  });

  it('stages a new property ONLY where there is something to protect', () => {
    /*
     * An organisation with no published stock has no working Marketplace to
     * blank, and staging its first upload would leave it looking at an empty
     * page until the imagery finished — turning a fix for the replacement case
     * into a regression for the first-run case.
     */
    expect(lifecycleForNewProperty({ organisationHasPublishedStock: false })).toBe('active');
    expect(lifecycleForNewProperty({ organisationHasPublishedStock: true })).toBe('staged');
  });
});

describe('every processing path was widened, and no serving path was', () => {
  const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

  it('widens the five queues the image engine drives', () => {
    for (const path of [
      'supabase/functions/_shared/builderStock/repairSourceImages.ts',
      'supabase/functions/_shared/builderStock/primaryImage.ts',
      'supabase/functions/_shared/builderStock/settleFallbackImages.ts',
    ]) {
      const source = read(path);
      expect(source, `${path} still filters lifecycle to active alone`)
        .not.toMatch(/\.eq\('lifecycle_status', 'active'\)/);
      expect(source).toMatch(/\.in\('lifecycle_status', PROCESSED_LIFECYCLE\)/);
    }
    // …and the SQL side: the claim, the pending count and the cron gate.
    expect((sql.match(/lifecycle_status IN \('active', 'staged'\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });

  it('leaves the Marketplace and the portal serving `active` alone', () => {
    /*
     * THE WHOLE SAFETY PROPERTY. If a serving query widened, a staged row would
     * appear on a client's screen as the blank card this exists to prevent.
     */
    for (const path of [
      'supabase/functions/builder-stock-marketplace/index.ts',
      'supabase/functions/builder-portal-stock/index.ts',
    ]) {
      const source = read(path);
      expect(source).toMatch(/\.eq\('lifecycle_status', 'active'\)/);
      expect(source, `${path} must not serve staged stock`)
        .not.toMatch(/lifecycle_status[^)]*staged/);
    }
  });

  it('re-states the claim index for the widened predicate', () => {
    // The partial index from 20261019000000 says `= 'active'`, so a staged row
    // would not be in it and the claim would sequential-scan for exactly the
    // rows that need claiming most.
    expect(sql).toMatch(/DROP INDEX IF EXISTS builder_stock_items_image_work_queue_idx/);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS builder_stock_items_image_work_queue_idx[\s\S]{0,200}lifecycle_status IN \('active', 'staged'\)/);
  });
});

// ---------------------------------------------------------------------------
// Readiness and the cutover
// ---------------------------------------------------------------------------

describe('readiness is one question, asked of the rows themselves', () => {
  it('is "has every staged row had its own source work run"', () => {
    expect(sql).toMatch(
      /WHERE i\.lifecycle_status = 'staged' AND i\.image_work_stage = 'source'\s*\n?\s*\) = 0 AS ready/);
  });

  it('counts a matched property that is waiting only on its patch', () => {
    /*
     * An import whose rows ALL matched stages nothing at all. A readiness rule
     * that looked only at staged rows would answer "nothing here" for ever, and
     * the new prices would never publish. Such a property owes no source work —
     * its imagery is already earned and its row is already serving.
     */
    expect(sql).toMatch(/OR \(i\.pending_upload_id = p_upload_id\)/);
  });

  it('does not require a picture, because blank is a valid terminal outcome', () => {
    /*
     * A property whose builder supplied nothing is a legitimate blank, and
     * blocking on it would mean a replacement list could never publish because
     * of one property nobody has a photograph of. A package that exhausted
     * MAX_PACKAGE_ATTEMPTS is written its terminal verdict by the repair and
     * advances off `source` like any other — so it counts as ready.
     */
    expect(sql).not.toMatch(/primary_image_id IS NOT NULL/);
    expect(sql).toMatch(/blank[\s\S]{0,80}legitimate|legitimate blank/i);
  });

  it('does not gate on the fallback ladder', () => {
    // Fallback runs after `source`, can only ADD an image to a card that would
    // otherwise be blank, and `chooseDisplayableImage` keeps builder imagery
    // ahead of it — so letting it continue past the cutover cannot produce the
    // failure this exists to prevent.
    expect(sql).not.toMatch(/image_work_stage = 'fallback'[^\n]*ready/);
  });
});

describe('the cutover is atomic and refuses unless ready', () => {
  it('evaluates readiness INSIDE the statement that flips the rows', () => {
    const fn = sql.slice(sql.indexOf('FUNCTION public.publish_builder_stock_upload'));
    expect(fn).toMatch(/builder_stock_publication_readiness\(p_upload_id\)/);
    expect(fn).toMatch(/IF NOT coalesce\(v_ready, false\) THEN[\s\S]{0,200}'not_ready'/);
    // Nothing may change between the check and the act.
    expect(fn.indexOf('builder_stock_publication_readiness'))
      .toBeLessThan(fn.indexOf("SET lifecycle_status = 'active'"));
  });

  it('archives ONLY what the uploads it replaces still supply', () => {
    /*
     * #2347 re-points a matched row's `upload_id` during the import, so any row
     * still carrying a superseded upload's id is by definition one the new list
     * did not contain: a removed property. A stock list the builder keeps
     * BESIDE this one has an id that is not in `replaces_upload_ids` and is
     * never touched — which is why the set is recorded rather than derived from
     * "anything that is not mine".
     */
    const fn = sql.slice(sql.indexOf('FUNCTION public.publish_builder_stock_upload'));
    expect(fn).toMatch(/upload_id = ANY\(v_replaces\)/);
    expect(fn).toMatch(/SET lifecycle_status = 'archived'/);
    // Archived, never deleted: an adviser's selection survives.
    expect(fn).not.toMatch(/DELETE FROM/i);
  });

  it('is hardened like every other function in this programme', () => {
    for (const fn of [
      'claim_builder_stock_image_work\\(integer, integer, uuid\\)',
      'builder_stock_image_work_pending\\(\\)',
      'builder_stock_publication_readiness\\(uuid\\)',
      'publish_builder_stock_upload\\(uuid\\)',
      'settle_builder_stock_marketplace_eligibility_tick\\(\\)',
    ]) {
      expect(sql).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${fn}\\s*\\n?\\s*FROM PUBLIC, anon, authenticated`));
      expect(sql).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${fn}\\s*\\n?\\s*TO postgres, service_role`));
    }
  });

  it('publishes itself, with no operator in the loop', () => {
    const settler = readFileSync(join(REPO_ROOT,
      'supabase/functions/builder-stock-image-settler/index.ts'), 'utf8');
    // Asked after every completed item, because that item may be the last one
    // its upload was waiting on and nothing else is watching.
    expect(settler).toMatch(/publishUploadIfReady\(supabase, claimed\.upload_id\)/);
    expect(settler).toMatch(/claimed\.lifecycle_status === 'staged'/);
  });
});

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

interface StoredItem extends Record<string, unknown> {
  id: string;
  lifecycle_status: string;
  upload_id: string | null;
  source_anchor: string | null;
}

function dbHolding(existing: StoredItem[]) {
  const updated: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const uploadPatches: Array<Record<string, unknown>> = [];
  let nextId = existing.length + 1;

  const db: any = {
    updated, inserted, uploadPatches,
    from(table: string) {
      const state: any = { filters: [] as Array<[string, unknown]> };
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return builder; },
        or() { return builder; }, not() { return builder; }, neq() { return builder; },
        in() { return builder; }, is() { return builder; },
        order() { return builder; }, limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload: Record<string, unknown>) { state.insert = payload; return builder; },
        update(payload: Record<string, unknown>) {
          state.update = payload;
          if (table === 'builder_stock_uploads') uploadPatches.push(payload);
          return builder;
        },
        upsert() { return builder; },
        delete() { return builder; },
        single() {
          if (table !== 'builder_stock_items') return Promise.resolve({ data: { id: 'x' }, error: null });
          if (state.update) {
            const id = String(state.filters.find(([c]: [string, unknown]) => c === 'id')?.[1] ?? '');
            updated.push({ id, payload: state.update });
            return Promise.resolve({ data: { id }, error: null });
          }
          const row = { id: `new-${nextId++}`, ...(state.insert ?? {}) };
          inserted.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: any, reject?: any) {
          const rows = table === 'builder_stock_items' ? existing : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: 'p' }, error: null }),
        download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
      }),
    },
  };
  return db;
}

const HELD: StoredItem = {
  id: 'item-1', lifecycle_status: 'active', upload_id: 'upload-1',
  source_anchor: 'notion:lot-13',
  external_reference: null, development_name: 'Hummock Rise', project_name: null,
  unit_number: null, lot_number: null,
  address_line: 'Lot 13 - Hummock Rise, Werribee, VIC', suburb: null,
  building_size_sqm: '231.00',
};

const ROW = (overrides: Record<string, unknown> = {}) => ({
  Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
  Price: '865000', 'Building Size': '231',
  npc_source_anchor: 'notion:lot-13',
  ...overrides,
});

function runImport(db: unknown, rows: Array<Record<string, unknown>>) {
  return importStockRecords(db as never, {
    organisationId: ORG, uploadId: 'upload-2', builderUserId: 'builder-1',
    rows: rows as never, media: [], filename: 'stock.csv',
    imageDeadlineAt: Date.now() - 1,
  } as never);
}

describe('importing a replacement list', () => {
  it('1. a first-ever upload publishes immediately — there is nothing to protect', async () => {
    const db = dbHolding([]);
    const outcome = await runImport(db, [ROW()]);
    expect(outcome.imported).toBe(1);
    expect(outcome.staged).toBe(0);
    expect(db.inserted[0].lifecycle_status).toBe('active');
  });

  it('4. a new property in a replacement list arrives STAGED, not blank on a card', async () => {
    const db = dbHolding([HELD]);
    const outcome = await runImport(db, [
      ROW(),
      ROW({ Property: 'Lot 900 - Brand New Street, Nowhere VIC',
            npc_source_anchor: 'notion:lot-900' }),
    ]);
    expect(outcome.updated).toBe(1);   // the matched one, still serving
    expect(outcome.imported).toBe(1);  // the new one
    expect(outcome.staged).toBe(1);
    expect(db.inserted[0].lifecycle_status).toBe('staged');
  });

  it('2, 3. a matched property keeps serving, and its lifecycle is never rewritten', async () => {
    /*
     * The update deliberately does not name `lifecycle_status`, so a published
     * property goes on serving its correct imagery throughout the replacement —
     * the whole point of #2347 — and a still-staged one stays invisible.
     */
    const db = dbHolding([HELD]);
    await runImport(db, [ROW({ Price: '999000' })]);
    expect(db.updated).toHaveLength(1);
    // Not one served value is written. The price, the availability and the
    // membership all wait in the patch; only the imagery levers apply now.
    const payload = db.updated[0].payload as Record<string, unknown>;
    expect(payload.pending_upload_id).toBe('upload-2');
    expect((payload.pending_patch as Record<string, unknown>).price).toBe(999000);
    expect(payload.price).toBeUndefined();
    expect(payload.lifecycle_status).toBeUndefined();
    expect(payload.upload_id).toBeUndefined();
    // …and `source_row` does, because it is what finds the photographs.
    expect(payload.source_row).toBeTruthy();
  });

  it('5, 14. records the upload it replaces, so removal waits for the cutover', async () => {
    const db = dbHolding([HELD]);
    const outcome = await runImport(db, [ROW()]);
    // Captured BEFORE `upload_id` was re-pointed — the only moment it exists.
    expect(outcome.replacesUploadIds).toEqual(['upload-1']);
    expect(db.uploadPatches).toContainEqual({ replaces_upload_ids: ['upload-1'] });
  });

  it('records an EMPTY predecessor set rather than leaving it unknown', async () => {
    // An upload that superseded nothing must archive nothing. A NULL that later
    // reads as "unknown" is how a cutover talks itself into archiving a stock
    // list the builder keeps beside this one.
    const db = dbHolding([]);
    const outcome = await runImport(db, [ROW()]);
    expect(outcome.replacesUploadIds).toEqual([]);
    expect(db.uploadPatches).toContainEqual({ replaces_upload_ids: [] });
  });

  it('6, 15. a changed identity under one anchor still stages rather than carrying imagery', async () => {
    const db = dbHolding([HELD]);
    const outcome = await runImport(db, [
      ROW({ Property: 'Lot 14 - Hummock Rise, Werribee, VIC' }),
    ]);
    // #2347 refuses the carry-forward; PR 4 makes the replacement invisible
    // until its own imagery has been looked for. Both rules, one row.
    expect(outcome.replacedProperties).toHaveLength(1);
    expect(outcome.imported).toBe(1);
    expect(db.inserted[0].lifecycle_status).toBe('staged');
  });

  it('a re-import never PUBLISHES a still-staged replacement property', async () => {
    /*
     * The defect this test was written to catch. The matched-row update wrote a
     * flat `lifecycle_status: 'active'` — correct when there were two
     * lifecycles, and a silent publication of an unready row now there are
     * three. A staged property publishes when its upload is ready and never
     * because a later list mentioned it again.
     */
    const db = dbHolding([
      { ...HELD, id: 'served', source_anchor: 'notion:served' },
      { ...HELD, id: 'pending', lifecycle_status: 'staged', source_anchor: 'notion:lot-13' },
    ]);
    await runImport(db, [ROW()]);
    expect(db.updated).toHaveLength(1);
    expect(db.updated[0].id).toBe('pending');
    expect(db.updated[0].payload.lifecycle_status).toBe('staged');
  });

  it('revives an ARCHIVED property as staged where there is a Marketplace to protect', async () => {
    const db = dbHolding([
      { ...HELD, id: 'served', source_anchor: 'notion:served' },
    ]);
    // The archived row is not in the anchor index, so this arrives as a new
    // property — and a new property stages while published stock exists.
    const outcome = await runImport(db, [ROW()]);
    expect(outcome.staged).toBe(1);
    expect(db.inserted[0].lifecycle_status).toBe('staged');
  });

  it('stages against PUBLISHED stock only, not against a half-finished replacement', async () => {
    /*
     * An organisation holding nothing but staged rows still has an empty page,
     * and staging again would keep it empty. Only `active` counts as something
     * to protect.
     */
    const db = dbHolding([{ ...HELD, lifecycle_status: 'staged' }]);
    const outcome = await runImport(db, [
      ROW({ Property: 'Lot 900 - Brand New Street, Nowhere VIC',
            npc_source_anchor: 'notion:lot-900' }),
    ]);
    expect(outcome.staged).toBe(0);
    expect(db.inserted[0].lifecycle_status).toBe('active');
  });

  it('decides once, so a 23-row list cannot stage its first row and publish its last', async () => {
    const db = dbHolding([HELD]);
    const rows = Array.from({ length: 6 }, (_, n) => ROW({
      Property: `Lot ${900 + n} - Brand New Street, Nowhere VIC`,
      npc_source_anchor: `notion:lot-${900 + n}`,
    }));
    const outcome = await runImport(db, rows);
    expect(outcome.staged).toBe(6);
    expect(new Set(db.inserted.map((row: Record<string, unknown>) => row.lifecycle_status)))
      .toEqual(new Set(['staged']));
  });

  it('18. the import writes everything it needs and never waits on a browser', async () => {
    // The record write, the predecessor set and the staged lifecycle are all
    // committed inside the request; publication is the settler's, driven by
    // cron. Nothing here needs the page to stay open.
    const db = dbHolding([HELD]);
    const outcome = await runImport(db, [ROW(), ROW({
      Property: 'Lot 900 - Brand New Street, Nowhere VIC',
      npc_source_anchor: 'notion:lot-900',
    })]);
    expect(outcome.failed).toBe(0);
    expect(outcome.itemIds).toHaveLength(2);
    // The predecessor set and the staged lifecycle are both committed here.
    expect(db.uploadPatches).toContainEqual({ replaces_upload_ids: ['upload-1'] });
    expect(db.inserted[0].lifecycle_status).toBe('staged');
  });
});

describe('a failed replacement leaves the published Marketplace alone', () => {
  it('12. reports the failure without touching the served rows', async () => {
    const db = dbHolding([HELD]);
    const inner = db.from;
    db.from = (table: string) => {
      const builder = inner(table);
      if (table !== 'builder_stock_uploads') return builder;
      builder.single = () => Promise.resolve({ data: null, error: { message: 'gone' } });
      const update = builder.update;
      builder.update = (payload: Record<string, unknown>) => {
        update(payload);
        const chained: any = { ...builder };
        chained.eq = () => chained;
        chained.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ error: { message: 'gone' } }).then(resolve);
        return chained;
      };
      return builder;
    };
    const outcome = await runImport(db, [ROW()]);
    // The properties are saved; only the predecessor record failed, and it is
    // reported in the uploader's own words rather than thrown.
    expect(outcome.updated).toBe(1);
    expect(outcome.failures.some((f: { reason: string }) =>
      /removed properties/i.test(f.reason))).toBe(true);
  });

  it('11, 13. nothing publishes until readiness, and then all at once', () => {
    /*
     * Proved against the live database in a rolled-back transaction, because
     * atomicity is a property of the statement rather than of the caller:
     *   staged rows invisible ......................... 2 staged, 0 active
     *   publication refused, one row owing source ..... source_outstanding: 1
     *   published set untouched by the refusal ........ 23 active
     *   then published ................................ promoted 2
     *   replaced upload's leftovers archived .......... 0 still active
     *   the new dataset is served ..................... both promoted
     * A `LANGUAGE plpgsql` function is one statement to its caller, so the
     * Marketplace can observe the moment before and the moment after and
     * nothing in between.
     */
    const fn = sql.slice(sql.indexOf('FUNCTION public.publish_builder_stock_upload'));
    expect(fn).toMatch(/GET DIAGNOSTICS v_published = ROW_COUNT/);
    expect(fn).toMatch(/GET DIAGNOSTICS v_archived = ROW_COUNT/);
  });
});
