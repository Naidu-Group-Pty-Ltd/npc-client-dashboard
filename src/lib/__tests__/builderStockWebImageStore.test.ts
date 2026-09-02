/**
 * Builder stock — a card that says "Web sourced" must be able to draw the
 * photograph it is talking about.
 *
 * MEASURED, 2 SEPTEMBER 2026, lot 310 Watsons Reach: its verified web image
 * hotlinked a builder's WordPress upload that now answers HTTP 404, and the
 * marketplace card kept the "Web sourced" badge over "Image unavailable" — a
 * claim with nothing behind it. The sweep under test stores the bytes for
 * every VERIFIED web image (serving moves into our bucket; the provenance
 * columns stay exactly as recorded) and retires a record only when its
 * address answers that the picture is GONE — so the same tick's
 * `enforceStrictPrimaryImages` takes the badge with the picture. A refusal
 * (403, the hotlink-protection shape) or a bad minute never blanks a card:
 * the attempt is counted, and the budget runs out to "stop trying", never to
 * "stop showing".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  storeVerifiedWebImages, WEB_STORE_DETAIL_KEY,
  type WebImageFetcher,
} from '../../../supabase/functions/_shared/builderStock/webImageStore';

/** A JPEG-shaped byte buffer big enough to pass the source-image floor. */
function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

interface ImageRow {
  id: string;
  organisation_id: string;
  stock_item_id: string;
  source_stage: string;
  verification_status: string;
  processing_status: string;
  storage_path: string | null;
  external_url: string | null;
  source_detail: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * The slice of PostgREST this sweep speaks, over rows in memory. `update`
 * records every write so a test can assert what was and was not touched.
 */
function fakeDb(images: ImageRow[], primaryIds: string[] = []) {
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  const uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [];

  const db = {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (value === null ? row[column] == null : row[column] === value));
          return chain;
        },
        not: (column: string, op: string, value: unknown) => {
          if (op === 'is' && value === null) filters.push((row) => row[column] != null);
          return chain;
        },
        order: () => chain,
        limit: async () => {
          if (table === 'builder_stock_item_images') {
            return { data: images.filter((row) => filters.every((f) => f(row))), error: null };
          }
          if (table === 'builder_stock_items') {
            return {
              data: primaryIds.map((id) => ({ primary_image_id: id })),
              error: null,
            };
          }
          return { data: [], error: null };
        },
        update: (patch: Record<string, unknown>) => {
          const writer: any = {
            eq: (column: string, value: unknown) => {
              if (column === 'id') writer.id = value;
              return writer;
            },
            then: (onFulfilled: (value: { error: null }) => unknown) => {
              updates.push({ table, patch, id: String(writer.id) });
              const target = images.find((row) => row.id === writer.id);
              if (target && table === 'builder_stock_item_images') Object.assign(target, patch);
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return writer;
        },
      };
      return chain;
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array, options: { contentType: string }) => {
          uploads.push({ path, bytes, contentType: options.contentType });
          return { error: null };
        },
      }),
    },
  };
  return { db, updates, uploads };
}

function verifiedRow(id: string, overrides: Partial<ImageRow> = {}): ImageRow {
  return {
    id,
    organisation_id: 'org-1',
    stock_item_id: `item-${id}`,
    source_stage: 'internet_search',
    verification_status: 'property_identity_verified',
    processing_status: 'ready',
    storage_path: null,
    external_url: `https://example.com/${id}.jpg`,
    source_detail: { property_identity: { matched: ['lot'], verified_at: 'x' } },
    ...overrides,
  };
}

describe('storeVerifiedWebImages', () => {
  it('stores the bytes and moves the serving without touching the provenance', async () => {
    const { db, updates, uploads } = fakeDb([verifiedRow('img-1')]);
    const fetchImage: WebImageFetcher = async () => ({ bytes: jpegBytes(), code: null, detail: '' });

    const outcome = await storeVerifiedWebImages(db, 'org-1', { fetchImage });

    expect(outcome).toMatchObject({ attempted: 1, stored: 1, retired: 0, held: 0 });
    expect(uploads[0].path).toBe('org-1/web/img-1.jpg');
    const patch = updates.find((u) => u.patch.storage_path)!.patch;
    expect(patch.storage_path).toBe('org-1/web/img-1.jpg');
    expect(patch.content_type).toBe('image/jpeg');
    // The link is the provenance and is never rewritten.
    expect(Object.keys(patch)).not.toContain('external_url');
    expect(Object.keys(patch)).not.toContain('source_page_url');
    expect(patch.processing_status).toBeUndefined();
  });

  it('retires a record only when the address says the picture is GONE', async () => {
    const { db, updates } = fakeDb([verifiedRow('img-404')]);
    const fetchImage: WebImageFetcher = async () => ({
      bytes: null, code: 'source_not_found', detail: 'Nothing was found at that address.',
    });

    const outcome = await storeVerifiedWebImages(db, 'org-1', { fetchImage });

    expect(outcome).toMatchObject({ retired: 1, stored: 0 });
    const patch = updates[0].patch as Record<string, any>;
    expect(patch.processing_status).toBe('unavailable');
    expect(String(patch.error_message)).toContain('no longer serves');
    expect(patch.source_detail[WEB_STORE_DETAIL_KEY].reason).toBe('source_not_found');
  });

  it('holds on a refusal — a browser may render what our server is refused', async () => {
    const { db, updates } = fakeDb([verifiedRow('img-403')]);
    const fetchImage: WebImageFetcher = async () => ({
      bytes: null, code: 'source_forbidden', detail: 'not publicly accessible',
    });

    const outcome = await storeVerifiedWebImages(db, 'org-1', { fetchImage });

    expect(outcome).toMatchObject({ held: 1, retired: 0 });
    const patch = updates[0].patch as Record<string, any>;
    // Still ready, still hotlinked: the card keeps drawing what it can.
    expect(patch.processing_status).toBeUndefined();
    expect(patch.source_detail[WEB_STORE_DETAIL_KEY].attempts).toBe(1);
    expect(String(patch.source_detail[WEB_STORE_DETAIL_KEY].last_error)).toContain('source_forbidden');
  });

  it('exhausts the attempt budget into "stop trying", never "stop showing"', async () => {
    const row = verifiedRow('img-flaky', {
      source_detail: { [WEB_STORE_DETAIL_KEY]: { attempts: 5 } },
    });
    const { db, updates } = fakeDb([row]);
    const fetchImage: WebImageFetcher = async () => ({ bytes: null, code: 'source_timeout', detail: 'slow' });

    await storeVerifiedWebImages(db, 'org-1', { fetchImage });
    const patch = updates[0].patch as Record<string, any>;
    expect(patch.source_detail[WEB_STORE_DETAIL_KEY].store_exhausted).toBe(true);
    expect(patch.processing_status).toBeUndefined();

    // And an exhausted row is never fetched again.
    let fetches = 0;
    const counting: WebImageFetcher = async () => { fetches += 1; return { bytes: null, code: 'x', detail: '' }; };
    await storeVerifiedWebImages(db, 'org-1', { fetchImage: counting });
    expect(fetches).toBe(0);
  });

  it('spends the budget on the pictures cards actually point at, first', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => verifiedRow(`img-${id}`));
    const { db } = fakeDb(rows, ['img-d']);
    const fetched: string[] = [];
    const fetchImage: WebImageFetcher = async (url) => {
      fetched.push(url);
      return { bytes: jpegBytes(), code: null, detail: '' };
    };

    const outcome = await storeVerifiedWebImages(db, 'org-1', { fetchImage });

    expect(outcome.attempted).toBe(3);
    // The primary jumps the id order; the budget cuts the tail.
    expect(fetched[0]).toContain('img-d');
    expect(fetched).toHaveLength(3);
  });

  it('never touches the pointer — cards belong to the enforcement sweep', async () => {
    const { db, updates } = fakeDb([verifiedRow('img-404')]);
    const fetchImage: WebImageFetcher = async () => ({ bytes: null, code: 'source_not_found', detail: 'gone' });
    await storeVerifiedWebImages(db, 'org-1', { fetchImage });
    expect(updates.every((u) => u.table === 'builder_stock_item_images')).toBe(true);
  });

  it('a 200 that is not an image is an attempt, not a finding', async () => {
    const { db, updates } = fakeDb([verifiedRow('img-html')]);
    const fetchImage: WebImageFetcher = async () => ({
      bytes: new TextEncoder().encode('<!doctype html><html>not found page</html>'), code: null, detail: '',
    });

    const outcome = await storeVerifiedWebImages(db, 'org-1', { fetchImage });
    expect(outcome).toMatchObject({ held: 1, retired: 0, stored: 0 });
    const patch = updates[0].patch as Record<string, any>;
    expect(patch.processing_status).toBeUndefined();
    expect(String(patch.source_detail[WEB_STORE_DETAIL_KEY].last_error)).toContain('not an image');
  });
});

describe('the settler runs the store on its own enumeration', () => {
  const source = () => readFileSync(
    resolve(__dirname, '../../../supabase/functions/builder-stock-image-settler/index.ts'),
    'utf8',
  );

  it('does not hide inside the per-candidate enforcement, which an empty queue never runs', () => {
    // The first wiring sat inside `enforce`, which is only invoked for
    // organisations with settlement candidates — and once the marketplace had
    // settled, it measurably never ran. The pass enumerates the hotlinked
    // displayable images itself, so the steady state is exactly when it works.
    const text = source();
    expect(text).toContain("        .eq('source_stage', 'internet_search')");
    expect(text).toContain('storeVerifiedWebImages(supabase, organisationId)');
  });

  it('a retirement re-decides the card in the SAME tick, past the once-per-tick guard', () => {
    const text = source();
    const retired = text.indexOf('if (webOutcome.retired > 0)');
    expect(retired).toBeGreaterThan(-1);
    const after = text.slice(retired, retired + 400);
    expect(after).toContain('enforced.delete(organisationId)');
    expect(after).toContain('await enforce(organisationId)');
  });
});
