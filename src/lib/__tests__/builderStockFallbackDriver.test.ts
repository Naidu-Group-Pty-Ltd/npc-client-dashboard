/**
 * BUILDER STOCK — THE FALLBACK LADDER MUST RUN WITHOUT A BROWSER.
 *
 * PRODUCTION, 28 AUGUST 2026, after source settlement had converged on its
 * own. 23 active properties, 20 holding a builder image, and three holding
 * nothing at all:
 *
 *   Lot 13 - Hummock Rise      no_deterministic_image   0 image rows
 *   Lot 1663 - Ringer Street   no_deterministic_image   0 image rows
 *   Lot 3 - 13/15 Rose Street  no_deterministic_image   0 image rows
 *
 * All 23 items read `enrichment_status = 'pending'` with `enriched_at` NULL —
 * the enrichment ladder had never completed for a single property. The three
 * blanks were correct about stage A (their builder's package genuinely names
 * no document for that exact lot) and had simply never been offered stage B or
 * stage C.
 *
 * THE DEFECT WAS NOT IN THE LADDER. `enrichStockItem` and `nextImageStage`
 * were already right. `enrichStockItem` had exactly ONE production caller —
 * `builder-portal-stock`'s `enrich_images` loop — which runs only while a
 * builder has the page open. The autonomous settler drove provenance,
 * eligibility, sanitization and primary enforcement, imported no enrichment at
 * all, and its empty-queue path answered `complete: true`, on which pg_cron
 * unschedules itself. Import, close the browser, and the ladder never ran.
 *
 * These tests are about the missing ORCHESTRATION, not about the ladder.
 */
import { describe, expect, it } from 'vitest';
import {
  settleFallbackImages, readFallbackQueue, MAX_FALLBACK_ITEMS_PER_TICK,
} from '../../../supabase/functions/_shared/builderStock/settleFallbackImages';

// ---------------------------------------------------------------------------
// The in-memory stand-in
// ---------------------------------------------------------------------------

interface Row { [key: string]: unknown }

function fakeDb(seed: { items?: Row[]; orgs?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    builder_stock_items: [...(seed.items ?? [])],
    builder_organisations: [...(seed.orgs ?? [])],
  };
  const reads: string[] = [];

  const matches = (row: Row, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    });

  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let limit = 10000;
    const builder: any = {
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
      in(c: string, v: unknown) { filters.push(['in', c, v]); return builder; },
      order() { return builder; },
      limit(n: number) { limit = n; return builder; },
      maybeSingle() {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: unknown) {
        reads.push(table);
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters)).slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  const db: any = {
    tables,
    reads,
    from(table: string) {
      return {
        select: () => selectBuilder(table),
        update(patch: Row) {
          const filters: Array<[string, string, unknown]> = [];
          const builder: any = {
            eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
            then(resolve: (v: unknown) => unknown, reject?: unknown) {
              for (const row of tables[table] ?? []) {
                if (matches(row, filters)) Object.assign(row, patch);
              }
              return Promise.resolve({ data: null, error: null }).then(resolve, reject as never);
            },
          };
          return builder;
        },
      };
    },
  };
  return db;
}

const ORG = 'org-a';
const item = (id: string, over: Row = {}): Row => ({
  id,
  organisation_id: ORG,
  lifecycle_status: 'active',
  enrichment_status: 'pending',
  enriched_at: null,
  primary_image_id: null,
  address_line: 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
  suburb: 'Werribee', state: 'VIC', postcode: '3030',
  development_name: null, project_name: null, lot_number: '13', unit_number: null,
  ...over,
});

const orgs = [{ id: ORG, trading_name: 'Sandpiper Homes', legal_name: 'Sandpiper Pty Ltd' }];

/**
 * A stand-in for the real ladder that records which stages were bought and
 * settles the item's status exactly as `enrichStockItem` does.
 */
function ladder(script: {
  web?: 'verified' | 'rejected' | 'unavailable';
  streetView?: 'ready' | 'none';
  throws?: boolean;
}) {
  const calls: Array<{ item: string; stage: string; builderName: string | null; org: string }> = [];
  const enrich = async (db: any, subject: any, builderName: string | null) => {
    // What the real one does first, and what the queue predicate keys on.
    await db.from('builder_stock_items')
      .update({ enrichment_status: 'enriching' }).eq('id', subject.id);

    if (script.throws) throw new Error('provider unavailable');

    const row = db.tables.builder_stock_items.find((r: Row) => r.id === subject.id)!;
    const alreadyWeb = Boolean(row.__web);

    // `nextImageStage`'s real order: web first, Street View only after it.
    const stage = row.primary_image_id ? 'none' : (alreadyWeb ? 'street_view' : 'web_search');
    if (stage !== 'none') {
      calls.push({ item: subject.id, stage, builderName, org: subject.organisation_id });
    }

    let outcomes: Array<{ status: string }> = [{ status: 'skipped' }, { status: 'skipped' }];
    if (stage === 'web_search') {
      row.__web = true;
      if (script.web === 'verified') row.primary_image_id = `web-${subject.id}`;
      outcomes = [{ status: script.web === 'unavailable' ? 'unavailable' : 'ready' },
        { status: 'skipped' }];
    } else if (stage === 'street_view') {
      if (script.streetView === 'ready') row.primary_image_id = `sv-${subject.id}`;
      outcomes = [{ status: script.streetView === 'ready' ? 'ready' : 'unavailable' },
        { status: 'skipped' }];
    }

    const anyReady = Boolean(row.primary_image_id);
    row.enrichment_status = anyReady ? 'complete' : 'failed';
    row.enriched_at = new Date().toISOString();
    return { outcomes, enrichmentStatus: row.enrichment_status } as never;
  };
  return { calls, enrich };
}

const paid = (calls: Array<{ stage: string }>, stage: string) =>
  calls.filter((call) => call.stage === stage).length;

// ---------------------------------------------------------------------------

describe('A — the reproduced defect: settlement empty, ladder never driven', () => {
  it('the queue is exactly the semantic queue the portal uses', async () => {
    const db = fakeDb({
      orgs,
      items: [
        item('a'),
        item('b', { enrichment_status: 'enriching' }),
        item('c', { enrichment_status: 'complete', primary_image_id: 'x' }),
        item('d', { enrichment_status: 'failed' }),
        item('e', { lifecycle_status: 'archived' }),
      ],
    });
    const queue = await readFallbackQueue(db, { limit: 50 });
    // pending + enriching + active only. `complete`/`failed` stay terminal, so
    // nothing is bought a second time; an archived property is nobody's work.
    expect(queue.rows.map((row) => row.id).sort()).toEqual(['a', 'b']);
  });

  it('a Stage-A-terminal pending item IS put through the ladder', async () => {
    const db = fakeDb({ orgs, items: [item('lot-13')] });
    const { calls, enrich } = ladder({ web: 'verified' });

    const outcome = await settleFallbackImages(db, {}, { enrich });

    // The whole defect: this used to be zero, for ever.
    expect(calls.length).toBeGreaterThan(0);
    expect(outcome.attempted).toBe(1);
    expect(outcome.resolved).toBe(1);
    expect(outcome.remaining).toBe(0);
  });
});

describe('C,D,E,F — the ladder order is obeyed and is terminal', () => {
  it('C — a verified web photograph ends it: Street View is never called', async () => {
    const db = fakeDb({ orgs, items: [item('lot-13')] });
    const { calls, enrich } = ladder({ web: 'verified' });

    await settleFallbackImages(db, {}, { enrich });

    expect(paid(calls, 'web_search')).toBe(1);
    expect(paid(calls, 'street_view')).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('web-lot-13');
  });

  it('D — an unverifiable web result is refused and Street View DOES run', async () => {
    // The rung that was unreachable: one call per item leaves a rejected web
    // result at `failed`, out of the queue, never offered Street View.
    const db = fakeDb({ orgs, items: [item('lot-1663')] });
    const { calls, enrich } = ladder({ web: 'rejected', streetView: 'ready' });

    await settleFallbackImages(db, {}, { enrich });

    expect(paid(calls, 'web_search')).toBe(1);
    expect(paid(calls, 'street_view')).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('sv-lot-1663');
  });

  it('E — web unavailable, Street View succeeds, Street View is selected', async () => {
    const db = fakeDb({ orgs, items: [item('lot-3')] });
    const { calls, enrich } = ladder({ web: 'unavailable', streetView: 'ready' });

    await settleFallbackImages(db, {}, { enrich });

    expect(paid(calls, 'street_view')).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('sv-lot-3');
  });

  it('F — both stages genuinely fail: no image, terminal, and NOT re-bought',
    async () => {
      const db = fakeDb({ orgs, items: [item('lot-3')] });
      const { calls, enrich } = ladder({ web: 'rejected', streetView: 'none' });

      const first = await settleFallbackImages(db, {}, { enrich });

      expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
      expect(db.tables.builder_stock_items[0].enrichment_status).toBe('failed');
      // "No image found" after both stages honestly failed is a valid answer.
      expect(first.remaining).toBe(0);

      // And the next tick does not hot-loop it: it has left the queue.
      const spent = calls.length;
      const second = await settleFallbackImages(db, {}, { enrich });
      expect(calls.length).toBe(spent);
      expect(second.attempted).toBe(0);
      expect(second.remaining).toBe(0);
    });
});

describe('G,H — a builder image outranks and forecloses the paid ladder', () => {
  it('G — a property that already holds a builder image buys nothing', async () => {
    const db = fakeDb({
      orgs,
      items: [item('lot-42', { primary_image_id: 'builder-image' })],
    });
    const { calls, enrich } = ladder({ web: 'verified', streetView: 'ready' });

    await settleFallbackImages(db, {}, { enrich });

    expect(paid(calls, 'web_search')).toBe(0);
    expect(paid(calls, 'street_view')).toBe(0);
  });

  it('H — a builder image arriving later outranks the fallback', async () => {
    // The ranking itself is `chooseCardImage`'s and is asserted in
    // builderStockImagePriority.test.ts; what matters here is that the driver
    // does not pin a fallback in place against it.
    const { rankImage } = await import(
      '../../../supabase/functions/_shared/builderStock/imagePriority.pure');
    const builder = {
      source_stage: 'uploaded_document', verification_status: 'source_supplied',
      processing_status: 'ready', storage_path: 'p', position: 0,
      source_detail: {
        role: 'primary_property', role_evidence_level: 1,
        stored_sha256: 'a'.repeat(64),
        marketplace_display_eligible: true,
        marketplace_eligibility_state: 'eligible',
        marketplace_measured: true,
        marketplace_eligibility_version: 2,
      },
    };
    const streetView = {
      source_stage: 'google_maps', verification_status: 'unverified',
      processing_status: 'ready', storage_path: 'q', position: 1,
      // Street View is displayable only when it is bound to a geocode of THIS
      // property's address — a place-name shot is refused by the same rule.
      source_detail: {
        product: 'streetview',
        address: 'Lot 13 Hummock Rise, Werribee VIC 3030',
        latitude: -37.9, longitude: 144.66,
      },
    };
    const builderRank = rankImage(builder as never);
    const streetViewRank = rankImage(streetView as never);
    expect(builderRank!.provenance).toBe('builder_supplied');
    /*
     * Street View no longer ranks at all — a still of a house-and-land lot in
     * an estate under construction is not a photograph of the property. The
     * rule this test exists for is unchanged and now holds a fortiori: the
     * driver cannot pin a fallback in place against the builder's own file.
     */
    expect(streetViewRank).toBeNull();
    expect(builderRank!.rank).toBe(1);
  });
});

describe('I — fairness under the batch bound', () => {
  it('two pending items with a limit of one progress on successive ticks',
    async () => {
      const db = fakeDb({ orgs, items: [item('first'), item('second')] });
      const { calls, enrich } = ladder({ web: 'verified' });

      const tick1 = await settleFallbackImages(db, { limit: 1 }, { enrich });
      expect(tick1.attempted).toBe(1);
      expect(tick1.remaining).toBe(1);
      expect(calls.map((c) => c.item)).toEqual(['first']);

      const tick2 = await settleFallbackImages(db, { limit: 1 }, { enrich });
      expect(tick2.attempted).toBe(1);
      expect(tick2.remaining).toBe(0);
      // The second item, not the first again: the queue advances.
      expect(calls.map((c) => c.item)).toEqual(['first', 'second']);
    });

  it('the shipped bound is small, because the worker has been killed before', () => {
    expect(MAX_FALLBACK_ITEMS_PER_TICK).toBeLessThanOrEqual(2);
    expect(MAX_FALLBACK_ITEMS_PER_TICK).toBeGreaterThanOrEqual(1);
  });
});

describe('J — an operational failure keeps the EXISTING policy', () => {
  it('the driver writes no status of its own and reports the problem', async () => {
    const db = fakeDb({ orgs, items: [item('lot-13')] });
    const { enrich } = ladder({ throws: true });

    const outcome = await settleFallbackImages(db, {}, { enrich });

    expect(outcome.problems).toHaveLength(1);
    expect(outcome.resolved).toBe(0);
    // `enrichStockItem` owns the terminal status. A driver that stamped
    // `failed` on a provider outage would retire a property the existing
    // semantics would have retried — so the row is left as the ladder left it.
    expect(db.tables.builder_stock_items[0].enrichment_status).toBe('enriching');
  });
});

describe('K,L — the cron completion rule', () => {
  it('K — fallback work outstanding is reported, so the tick is not complete',
    async () => {
      const db = fakeDb({ orgs, items: [item('a'), item('b'), item('c')] });
      const { enrich } = ladder({ web: 'verified' });

      const outcome = await settleFallbackImages(db, { limit: 1 }, { enrich });

      // The settler answers `complete: fallback.remaining === 0`, so a
      // non-zero remaining is exactly what keeps pg_cron alive.
      expect(outcome.remaining).toBe(2);
      expect(outcome.remaining === 0).toBe(false);
    });

  it('L — an empty fallback queue permits quiet', async () => {
    const db = fakeDb({ orgs, items: [item('done', { enrichment_status: 'complete' })] });
    const { calls, enrich } = ladder({ web: 'verified' });

    const outcome = await settleFallbackImages(db, {}, { enrich });

    expect(outcome.attempted).toBe(0);
    expect(calls).toHaveLength(0);
    expect(outcome.remaining === 0).toBe(true);
  });

  it('an UNREADABLE queue is never mistaken for an empty one', async () => {
    const db = fakeDb({ orgs, items: [item('a')] });
    db.from = () => ({ select: () => { throw new Error('boom'); } });

    const outcome = await settleFallbackImages(db, {}, { enrich: async () => ({}) as never });

    // The settler turns this into a 503 rather than unscheduling the cron on a
    // database fault — the same class as the missing-column bug it already has
    // a named failure for.
    expect(outcome.unavailable).toBe(true);
  });
});

describe('M,N — blast radius and tenancy', () => {
  it('M — the driver writes nothing outside the ladder\'s own columns', async () => {
    const db = fakeDb({
      orgs,
      items: [item('lot-13', {
        source_provenance_result: { result: 'no_deterministic_image' },
        availability_status: 'available',
        price: 812000,
        is_selected: true,
      })],
    });
    const { enrich } = ladder({ web: 'verified' });

    await settleFallbackImages(db, {}, { enrich });

    const row = db.tables.builder_stock_items[0];
    // Source provenance, pricing, availability and client selection are
    // untouched: the fallback is imagery and nothing else.
    expect(row.source_provenance_result).toEqual({ result: 'no_deterministic_image' });
    expect(row.availability_status).toBe('available');
    expect(row.price).toBe(812000);
    expect(row.is_selected).toBe(true);
  });

  it('N — every item is processed under ITS OWN organisation', async () => {
    const db = fakeDb({
      orgs: [
        { id: 'org-a', trading_name: 'Sandpiper Homes', legal_name: null },
        { id: 'org-b', trading_name: 'Cloverton Builders', legal_name: null },
      ],
      items: [
        item('a-item', { organisation_id: 'org-a' }),
        item('b-item', { organisation_id: 'org-b' }),
      ],
    });
    const { calls, enrich } = ladder({ web: 'verified' });

    await settleFallbackImages(db, { limit: 2 }, { enrich });

    const byItem = new Map(calls.map((call) => [call.item, call]));
    // The organisation comes from the candidate ROW, never from a request, so
    // metering is billed to the tenant that owns the stock item...
    expect(byItem.get('a-item')!.org).toBe('org-a');
    expect(byItem.get('b-item')!.org).toBe('org-b');
    // ...and the identity check is given that tenant's own builder name.
    expect(byItem.get('a-item')!.builderName).toBe('Sandpiper Homes');
    expect(byItem.get('b-item')!.builderName).toBe('Cloverton Builders');
  });

  it('an unreadable organisation name never becomes another tenant\'s name',
    async () => {
      const db = fakeDb({ orgs: [], items: [item('lot-13')] });
      const { calls, enrich } = ladder({ web: 'verified' });

      await settleFallbackImages(db, {}, { enrich });

      expect(calls[0].builderName).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// B, K, L — the settler's own wiring.
//
// The handler lives inside `Deno.serve`, so it cannot be invoked here. These
// read its source, which is the same technique the repository already uses to
// stop the LLM router and its usage binding from drifting apart. What they pin
// is the part a unit test of the driver cannot reach: WHERE the fallback phase
// is called from, and what the tick is allowed to call `complete`.
// ---------------------------------------------------------------------------

describe('B,K,L — the autonomous tick\'s contract', () => {
  const settler = () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    return readFileSync(
      join(__dirname, '..', '..', '..',
        'supabase/functions/builder-stock-image-settler/index.ts'),
      'utf8') as string;
  };

  it('B — the fallback phase is reachable ONLY once settlement is empty', () => {
    const source = settler();
    const guard = source.indexOf('if (!outstanding.length) {');
    const call = source.indexOf('settleFallbackImages(supabase');
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);

    // And it is called exactly once, from that one branch — so a tick with any
    // source still being read buys no Perplexity search and no Street View.
    const calls = source.match(/settleFallbackImages\(supabase/g) ?? [];
    expect(calls).toHaveLength(1);

    // The branch it sits in is the one that used to return `complete: true`
    // unconditionally; that literal must no longer exist there.
    const branch = source.slice(guard, source.indexOf('const candidates'));
    expect(branch).not.toContain('remaining: 0, complete: true');
  });

  it('K,L — quiet requires BOTH queues empty', () => {
    const source = settler();
    // The completion flag is derived from the fallback queue, not asserted.
    expect(source).toContain('complete: fallback.remaining === 0');
    // Stage A is a fact on this path, not an assumption, and it is the caller
    // that keeps it one.
    expect(source).toContain('MAX_FALLBACK_ITEMS_PER_TICK');
  });

  it('an unreadable fallback queue answers 503 rather than unscheduling', () => {
    const source = settler();
    expect(source).toContain('fallback_queue_unreadable');
    // A read that FAILED is not a queue that is EMPTY — the same rule the
    // missing-schema path already has a named failure for.
    const at = source.indexOf('fallback_queue_unreadable');
    expect(source.slice(at, at + 400)).toContain('503');
  });
});
