/**
 * BUILDER STOCK — AN IMPORT MUST ANSWER, AND PICTURES MUST NOT STOP IT.
 *
 * PRODUCTION, 27 AUGUST 2026. A builder imported a 23-row Notion stock list
 * from the portal twice, two minutes apart, and both times saw:
 *
 *     The stock list could not be imported
 *     Failed to fetch
 *
 * Both times the import had actually WORKED: the upload row was written and
 * every property in it was committed. What failed was the answer. The edge
 * worker was killed on its RESOURCE limit ~16 seconds in — `POST | 546` at
 * 08:41:00 and again at 08:43:20 — because `importStockRecords` downloads,
 * hashes and CLASSIFIES every image inline, and a killed worker emits no body
 * and no CORS headers, so the browser's `fetch` rejects with the only thing it
 * knows: "Failed to fetch".
 *
 * The data recorded the kill point exactly: of the 23 properties, the 9
 * written first held a ready source image and the 14 written after held none,
 * and NONE of them had `primary_image_id` set, because the pointer pass runs
 * after all the image work and was never reached. That is the same defect the
 * marketplace screenshot showed as "No image found".
 *
 * So two rules are pinned here:
 *
 *   THE PROPERTIES ARE NEVER THE THING THAT GETS DROPPED. Every row is
 *   imported however little budget the pictures leave.
 *
 *   PICTURES ARE BUDGETED AND WHAT IS LEFT IS DECLARED. `imageryOutstanding`
 *   is how the caller knows to leave the upload open for the enrichment pass
 *   that already exists.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  importStockRecords,
} from '../../../supabase/functions/_shared/builderStock/importStock';

const ORG = 'org-a';
const UPLOAD = 'upload-1';

/** A database that records writes and answers reads plausibly. */
function fakeDb() {
  const items: Array<Record<string, any>> = [];
  const images: Array<Record<string, any>> = [];
  const db: any = {
    items,
    images,
    from(table: string) {
      const state: any = { table, filters: [] as Array<[string, unknown]> };
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return builder; },
        or() { return builder; },
        not() { return builder; },
        neq() { return builder; },
        in() { return builder; },
        is() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        single() {
          if (table === 'builder_stock_items') {
            const row = { id: `item-${items.length + 1}`, ...(state.payload ?? {}) };
            items.push(row);
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: { id: 'x' }, error: null });
        },
        insert(payload: Record<string, any>) { state.payload = payload; return builder; },
        upsert(payload: Record<string, any>) {
          if (table === 'builder_stock_item_images') images.push(payload);
          return builder;
        },
        update() { return builder; },
        delete() { return builder; },
        then(resolve: any, reject?: any) {
          const rows = table === 'builder_stock_item_images' ? images : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: {
      from() {
        return {
          upload: () => Promise.resolve({ data: { path: 'p' }, error: null }),
          download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
        };
      },
    },
  };
  return db;
}

/** Twelve rows, each naming one picture on its own row. */
const ROWS = Array.from({ length: 12 }, (_, n) => ({
  address_line: `Lot ${n + 1} - Example Street, Example VIC 3000`,
  price: '700000',
  image_urls: [`https://example.test/lot-${n + 1}.jpg`],
  image_url_fields: { [`https://example.test/lot-${n + 1}.jpg`]: 'Property Image' },
  source_anchor: `row-${n + 1}`,
}));

/** A fetcher that is SLOW, the way a real download plus a decode is. */
function slowFetcher(msEach: number) {
  const calls = { count: 0 };
  const fetchImage = async () => {
    calls.count += 1;
    await new Promise((resolve) => setTimeout(resolve, msEach));
    return null; // Never yields bytes: this test measures the BUDGET, not storage.
  };
  return { fetchImage, calls };
}

describe('the import answers even when the pictures cannot all be attached', () => {
  it('imports every property when the image budget is already spent', async () => {
    const db = fakeDb();
    const { fetchImage, calls } = slowFetcher(0);

    const outcome = await importStockRecords(db, {
      organisationId: ORG,
      uploadId: UPLOAD,
      builderUserId: 'builder-1',
      rows: ROWS as never,
      media: [],
      filename: 'stock.csv',
      // Already expired: not one picture may be attempted.
      imageDeadlineAt: Date.now() - 1,
    } as never, { fetchImage } as never);

    // THE PROPERTIES ARE ALL THERE. This is the half that must never be
    // sacrificed to the half that is expensive.
    expect(outcome.detected).toBe(12);
    expect(outcome.imported + outcome.updated).toBe(12);
    expect(outcome.failed).toBe(0);
    // And the pictures were declined rather than attempted or lost.
    expect(calls.count).toBe(0);
    expect(outcome.imageryOutstanding).toBe(true);
  });

  it('stops spending on pictures once the budget runs out, mid-import', async () => {
    const db = fakeDb();
    // Each image costs 40ms; the budget allows roughly the first few.
    const { fetchImage, calls } = slowFetcher(40);

    const outcome = await importStockRecords(db, {
      organisationId: ORG,
      uploadId: UPLOAD,
      builderUserId: 'builder-1',
      rows: ROWS as never,
      media: [],
      filename: 'stock.csv',
      imageDeadlineAt: Date.now() + 120,
    } as never, { fetchImage } as never);

    expect(outcome.detected).toBe(12);
    expect(outcome.imported + outcome.updated).toBe(12);
    // Some were attempted and the rest were not — the point of a budget.
    expect(calls.count).toBeGreaterThan(0);
    expect(calls.count).toBeLessThan(12);
    expect(outcome.imageryOutstanding).toBe(true);
  });

  it('reports nothing outstanding when every picture fitted', async () => {
    const db = fakeDb();
    const { fetchImage, calls } = slowFetcher(0);

    const outcome = await importStockRecords(db, {
      organisationId: ORG,
      uploadId: UPLOAD,
      builderUserId: 'builder-1',
      rows: ROWS.slice(0, 3) as never,
      media: [],
      filename: 'stock.csv',
      imageDeadlineAt: Date.now() + 60_000,
    } as never, { fetchImage } as never);

    expect(outcome.detected).toBe(3);
    expect(calls.count).toBe(3);
    expect(outcome.imageryOutstanding).toBe(false);
  });

  it('caps the COUNT as well as the clock, because the limit is CPU', async () => {
    const db = fakeDb();
    const { fetchImage, calls } = slowFetcher(0);
    // 40 rows, an unlimited clock: the count ceiling is the only thing that
    // can stop this, and a wall-clock deadline alone would not.
    const many = Array.from({ length: 40 }, (_, n) => ({
      ...ROWS[0],
      address_line: `Lot ${n + 100} - Example Street, Example VIC 3000`,
      image_urls: [`https://example.test/many-${n}.jpg`],
      image_url_fields: { [`https://example.test/many-${n}.jpg`]: 'Property Image' },
      source_anchor: `many-${n}`,
    }));

    const outcome = await importStockRecords(db, {
      organisationId: ORG,
      uploadId: UPLOAD,
      builderUserId: 'builder-1',
      rows: many as never,
      media: [],
      filename: 'stock.csv',
      imageDeadlineAt: Date.now() + 600_000,
    } as never, { fetchImage } as never);

    expect(outcome.detected).toBe(40);
    expect(calls.count).toBeLessThanOrEqual(20);
    expect(outcome.imageryOutstanding).toBe(true);
  });
});
