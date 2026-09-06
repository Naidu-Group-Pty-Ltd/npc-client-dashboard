/**
 * Builder stock — the org-wide enforcement sweep must rank the way everything
 * else ranks.
 *
 * WHAT HAPPENED. `enforceStrictPrimaryImages` settles every property an
 * organisation holds, not only the ones a repair run touched. It ranked with
 * `chooseDisplayableImage` — the builder's own file or nothing — because that
 * was the product rule when it was written. `imagePriority.pure.ts` then
 * replaced that rule with a ladder that admits a web photograph VERIFIED to be
 * this property (tier 3) and Street View of this exact address (tier 4), and
 * `chooseAndStorePrimaryImage` moved onto `chooseCardImage`. The sweep did not.
 *
 * So the two writers disagreed, and whichever ran last won. The per-item path
 * sets a fallback pointer; the sweep deletes it as "nothing to show"; the next
 * repair sets it again. The pointers the sweep clears are exactly the ones the
 * current rule creates.
 *
 * MEASURED AGAINST PRODUCTION, 1 SEPTEMBER 2026, on the 430 live pointers:
 *
 *   156  google_maps / location_derived      cleared — wrong stage
 *     7  internet_search / identity verified  cleared — wrong stage
 *    25  uploaded_document, no stored role    cleared — role reads `unknown`
 *   ---
 *   188  of 430, 44% of the marketplace, blanked by one pass.
 *
 * None of the three is caught by the skip guard: `awaitingVerdict` returns
 * false at the same two gates, so an item it can never rescue is an item it
 * hands straight to the clear. It ran once and 45 pointers went.
 *
 * The rows below are the four shapes production actually holds, taken from
 * that measurement rather than invented.
 *
 * NOTHING HERE WEAKENS THE DISPLAY RULE. An unjudged builder image is still
 * hidden, an unverified search hit is still refused, and a satellite tile is
 * still not a photograph — those are `imagePriority.pure.ts`'s tests, and this
 * file asserts only that the sweep asks it rather than answering by itself.
 */
import { describe, expect, it } from 'vitest';

import {
  enforceStrictPrimaryImages,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  chooseCardImage,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import type {
  DisplayableImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  MARKETPLACE_ELIGIBILITY_VERSION,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';

const ORG = 'org-a';

interface Row extends Record<string, unknown> { id: string }

/**
 * Enough of PostgREST for a select-and-update over two tables — INCLUDING the
 * part that caused the second defect this file now covers.
 *
 * `serverCap` is `db-max-rows`, which is 1,000 on the deployment and is applied
 * to EVERY response whatever `.limit()` asked for. The double enforces it, so a
 * reader that trusts its own limit sees a truncated set here exactly as it does
 * in production. `failReads` is the other half: a read that errors must never
 * reach the sweep as an empty organisation.
 */
function fakeDb(
  items: Row[],
  images: Row[],
  options: { serverCap?: number; failReads?: string } = {},
) {
  const serverCap = options.serverCap ?? 1000;
  const tables: Record<string, Row[]> = {
    builder_stock_items: items,
    builder_stock_item_images: images,
  };
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  const reads: Array<{ table: string; from: number; to: number }> = [];

  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let patch: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {
      select: () => api,
      limit: () => api,
      order: (column: string, opts?: { ascending?: boolean }) => {
        const direction = opts?.ascending === false ? -1 : 1;
        rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -direction : direction));
        return api;
      },
      eq: (column: string, value: unknown) => {
        if (patch) {
          for (const row of (tables[table] ?? []).filter((r) => r[column] === value)) {
            Object.assign(row, patch);
            updates.push({ table, patch: { ...patch }, id: String(row.id) });
          }
          return Promise.resolve({ data: null, error: null });
        }
        rows = rows.filter((row) => row[column] === value);
        return api;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return api;
      },
      update: (next: Record<string, unknown>) => { patch = next; return api; },
      // The server's own cap wins over the range the caller asked for.
      range: (start: number, end: number) => {
        reads.push({ table, from: start, to: end });
        if (options.failReads === table) {
          return Promise.resolve({ data: null, error: { message: 'connection reset' } });
        }
        const width = Math.min(end - start + 1, serverCap);
        return Promise.resolve({ data: rows.slice(start, start + width), error: null });
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows.slice(0, serverCap), error: null }),
    };
    return api;
  };

  return { from, tables, updates, reads } as unknown as {
    from: (table: string) => unknown;
    tables: Record<string, Row[]>;
    updates: typeof updates;
    reads: typeof reads;
  };
}

const item = (id: string, primary: string | null): Row => ({
  id, organisation_id: ORG, lifecycle_status: 'active', primary_image_id: primary,
});

/** A builder cover, judged clean under the current version. Tier 1. */
const builderClean = (id: string, stockItemId: string): Row => ({
  id, organisation_id: ORG, stock_item_id: stockItemId,
  source_stage: 'uploaded_document', verification_status: 'source_supplied',
  processing_status: 'ready', position: 0,
  storage_path: `org/items/${stockItemId}/source/cover.png`,
  source_detail: {
    role: 'primary_property', role_evidence_level: 3,
    marketplace_eligibility_state: 'eligible',
    marketplace_display_eligible: true,
    marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION,
  },
});

/** A builder row written before roles existed. 25 of these hold a pointer. */
const builderNoRole = (id: string, stockItemId: string): Row => ({
  id, organisation_id: ORG, stock_item_id: stockItemId,
  source_stage: 'uploaded_document', verification_status: 'source_supplied',
  processing_status: 'ready', position: 0,
  storage_path: `org/items/${stockItemId}/source/legacy.png`,
  source_detail: { origin: 'notion_page_cover' },
});

/** A web photograph verified to be this exact property. Tier 3. */
const verifiedWeb = (id: string, stockItemId: string): Row => ({
  id, organisation_id: ORG, stock_item_id: stockItemId,
  source_stage: 'internet_search', verification_status: 'property_identity_verified',
  processing_status: 'ready', position: 0,
  external_url: 'https://example.test/photo.jpg',
  source_detail: {
    property_identity: {
      matched: ['street', 'lot', 'development'],
      verified_at: '2026-08-28T02:14:00.000Z',
    },
  },
});

/** Street View of this exact address. Tier 4. */
const streetView = (id: string, stockItemId: string): Row => ({
  id, organisation_id: ORG, stock_item_id: stockItemId,
  source_stage: 'google_maps', verification_status: 'location_derived',
  processing_status: 'ready', position: 0,
  storage_path: `org/items/${stockItemId}/maps/streetview.jpg`,
  source_detail: {
    product: 'streetview',
    address: '12 Example Street, Sampleton NSW 2000',
    latitude: -33.86, longitude: 151.2,
  },
});

// ---------------------------------------------------------------------------

describe('the sweep settles to the ladder, not to the repealed builder-only rule', () => {
  it('keeps a Street View pointer the ladder itself chose', async () => {
    const image = streetView('image-sv', 'item-sv');
    const db = fakeDb([item('item-sv', 'image-sv')], [image]);

    // The ladder put it there: tier 4 is a real answer, not an absence.
    expect(chooseCardImage([image as unknown as DisplayableImage])?.image.id).toBe('image-sv');

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.cleared).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-sv');
  });

  it('keeps a verified web pointer the ladder itself chose', async () => {
    const image = verifiedWeb('image-web', 'item-web');
    const db = fakeDb([item('item-web', 'image-web')], [image]);

    expect(chooseCardImage([image as unknown as DisplayableImage])?.image.id).toBe('image-web');

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.cleared).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-web');
  });

  it('clears nothing across the four shapes production holds', async () => {
    const images = [
      builderClean('image-clean', 'item-clean'),
      verifiedWeb('image-web', 'item-web'),
      streetView('image-sv', 'item-sv'),
    ];
    const db = fakeDb([
      item('item-clean', 'image-clean'),
      item('item-web', 'image-web'),
      item('item-sv', 'image-sv'),
    ], images);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.inspected).toBe(3);
    expect(enforced.cleared).toBe(0);
    expect(enforced.corrected).toBe(0);
    // Not one write attempted: the pointers already say what the ladder says.
    expect(db.updates).toHaveLength(0);
  });
});

describe('what it must still clear, and what it must still prefer', () => {
  it('clears a pointer to a row with no stored role and no fallback behind it', async () => {
    // The 25-row shape. There is genuinely nothing displayable here: an
    // unknown role is not a builder photograph and no fallback was ever
    // written for this property, so an empty frame is the honest answer.
    const image = builderNoRole('image-legacy', 'item-legacy');
    const db = fakeDb([item('item-legacy', 'image-legacy')], [image]);

    expect(chooseCardImage([image as never])).toBeNull();

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.cleared).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
  });

  it('but demotes that same property to Street View where one exists', async () => {
    const images = [
      builderNoRole('image-legacy', 'item-legacy'),
      streetView('image-sv', 'item-legacy'),
    ];
    const db = fakeDb([item('item-legacy', 'image-legacy')], images);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.cleared).toBe(0);
    expect(enforced.corrected).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-sv');
  });

  it('and a builder photograph still outranks both fallbacks', async () => {
    const images = [
      streetView('image-sv', 'item-1'),
      verifiedWeb('image-web', 'item-1'),
      builderClean('image-clean', 'item-1'),
    ];
    // Pointing at the weakest tier, as a stale pointer would.
    const db = fakeDb([item('item-1', 'image-sv')], images);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(enforced.corrected).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-clean');
  });
});

describe('the two writers can no longer disagree', () => {
  it('the sweep reaches the same answer chooseCardImage does, row for row', async () => {
    const cases: Array<[string, Row[]]> = [
      ['builder', [builderClean('a', 'i')]],
      ['web', [verifiedWeb('b', 'i')]],
      ['street view', [streetView('c', 'i')]],
      ['legacy only', [builderNoRole('d', 'i')]],
      ['legacy + fallback', [builderNoRole('d', 'i'), streetView('c', 'i')]],
      ['all tiers', [streetView('c', 'i'), verifiedWeb('b', 'i'), builderClean('a', 'i')]],
    ];

    for (const [label, images] of cases) {
      const db = fakeDb([item('i', null)], images);
      await enforceStrictPrimaryImages(db as never, ORG);

      expect(
        db.tables.builder_stock_items[0].primary_image_id,
        `${label}: the sweep and the ranking must agree`,
      ).toBe(chooseCardImage(images as unknown as DisplayableImage[])?.image.id ?? null);
    }
  });
});

/**
 * THE SECOND WAY THE TWO WRITERS DISAGREED, and the one that was live.
 *
 * The sweep read the organisation's images with `.limit(200000)` and treated
 * the answer as the whole set. PostgREST caps a response at `db-max-rows` —
 * 1,000 here, declared in `supabase/config.toml` and measured against
 * production, where a request for 200,000 rows of an 18,519-row table answered
 * `content-range: 0-999/18519` with HTTP 200 and no error.
 *
 * The organisation held 1,926 images. The sweep saw 1,000. The missing 926 did
 * not read as unloaded; they read as ABSENT — so every property whose
 * photograph sat past the cut reached `chooseCardImage([])` and had its pointer
 * CLEARED. All eleven properties holding an eligible builder photograph had it
 * at physical position 1,125-1,781, and all eleven were blank. Live pointers
 * fell 27 to 6 in an hour, because `chooseAndStorePrimaryImage` asks for ONE
 * property's images — never truncated — and put them back between sweeps.
 */
describe('the response cap must not read as an absent photograph', () => {
  it('keeps a builder photograph that sits beyond the server row cap', async () => {
    // Eleven properties whose images fill the first pages, and a twelfth whose
    // photograph is last by id and therefore invisible to a single-page read.
    const filler = Array.from({ length: 11 }, (_, n) =>
      builderNoRole(`img-${String(n).padStart(2, '0')}`, `item-${n}`));
    const target = builderClean('zz-target-image', 'item-target');

    const db = fakeDb(
      [...filler.map((image, n) => item(`item-${n}`, String(image.id))),
        item('item-target', 'zz-target-image')],
      [...filler, target],
      { serverCap: 5 },
    );

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    // Every property was inspected, not just the first page of them.
    expect(enforced.inspected).toBe(12);
    // And the photograph on page three is still the card's.
    expect(db.tables.builder_stock_items
      .find((row) => row.id === 'item-target')?.primary_image_id).toBe('zz-target-image');
    // The eleven legacy rows are still cleared: nothing here loosens the rule.
    expect(enforced.cleared).toBe(11);
  });

  it('reads in pages rather than trusting one oversized request', async () => {
    const images = Array.from({ length: 7 }, (_, n) =>
      builderClean(`img-${n}`, `item-${n}`));
    const db = fakeDb(images.map((image, n) => item(`item-${n}`, String(image.id))),
      images, { serverCap: 3 });

    await enforceStrictPrimaryImages(db as never, ORG);

    const imageReads = db.reads.filter((read) => read.table === 'builder_stock_item_images');
    // Three full pages and the empty one that ends it — never a single request
    // whose answer is believed to be complete.
    expect(imageReads.length).toBeGreaterThan(1);
    expect(imageReads[0].from).toBe(0);
    expect(imageReads[1].from).toBe(3);
  });
});

describe('a read that failed is not an organisation with no images', () => {
  it('clears nothing when the images cannot be read', async () => {
    const db = fakeDb([item('item-clean', 'image-clean')],
      [builderClean('image-clean', 'item-clean')],
      { failReads: 'builder_stock_item_images' });

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(db.updates).toHaveLength(0);
    expect(enforced.cleared).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-clean');
  });

  it('clears nothing when the properties cannot be read', async () => {
    const db = fakeDb([item('item-clean', 'image-clean')],
      [builderClean('image-clean', 'item-clean')],
      { failReads: 'builder_stock_items' });

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);

    expect(db.updates).toHaveLength(0);
    expect(enforced.inspected).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-clean');
  });
});
