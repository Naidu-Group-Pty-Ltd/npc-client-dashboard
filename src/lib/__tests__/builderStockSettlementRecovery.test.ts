/**
 * Builder stock — the production blackout, and the two things that caused it.
 *
 * WHAT HAPPENED. The display gate went live and every Marketplace card went
 * blank, including properties whose builder photograph is perfectly clean. The
 * gate is right — an image with no display verdict is not displayable — and it
 * is safe only if the backfill that writes those verdicts actually runs. It did
 * not, for two independent reasons, and each of them reported success:
 *
 *   1  THE SCHEMA WAS NOT THERE. Edge functions ship automatically when `main`
 *      moves; migrations in this project are dispatched by hand, one file at a
 *      time. So the gate shipped and the settlement columns did not. The
 *      settler read a column that did not exist, could not tell that from an
 *      empty queue, and answered `success: true, skipped: 'marker_unavailable'`
 *      — a green report of work it had not done.
 *
 *   2  AND HAD IT RUN, IT WOULD HAVE MADE THINGS WORSE. Primary-image
 *      enforcement ran for every organisation the tick ATTEMPTED, and decided
 *      each item by reading verdicts. An item whose verdict had not been
 *      written yet therefore looked like an item with nothing to show, and its
 *      pointer was cleared — after which the backfill would write `eligible`
 *      onto an image nothing pointed at.
 *
 * The fix for the first is that a missing schema is now a named operational
 * failure. The fix for the second is that enforcement decides only where the
 * evidence is in: per ITEM, because one property's images can come from several
 * uploads, so "this upload settled" and "this property's candidates have all
 * been judged" are different statements and only the second licenses a write.
 *
 * None of this weakens the rule. Unjudged is still hidden.
 */
import { describe, expect, it } from 'vitest';

import {
  chooseDisplayableImage, enforceStrictPrimaryImages,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  readOutstandingUploads, readSettlementReadiness, runSettlementTick,
  type SettlementCandidate,
} from '../../../supabase/functions/_shared/builderStock/settleSourceImages';
import { PROVENANCE_VERSION } from '../../../supabase/functions/_shared/builderStock/sourceImages';
import { settleMarketplaceEligibility } from '../../../supabase/functions/_shared/builderStock/settleMarketplaceEligibility';
import {
  MARKETPLACE_ELIGIBILITY_VERSION, decideMarketplaceEligibility,
  isMarketplaceEligible, marketplaceEligibilityDetail,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import {
  SANITIZATION_VERSION,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import { readMarketingOverlay } from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import { eligibilityDetailFor } from '../../../supabase/functions/_shared/builderStock/assessSourceImage';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { annotatedPicture, cleanPicture } from './fixtures/builderStockPictures';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

/*
 * 640x332 rather than an arbitrary size, and that is not incidental.
 *
 * The drawn fixture's ground is a pair of coherent sine washes, and at a few
 * awkward downscale ratios — 480x250 among them — those beat into something the
 * faint-typography pass reads as a line of type. No real photograph does that:
 * the three known-clean production covers were resampled to seven widths from
 * 400 to 640 and stayed eligible at every one. This size is inside the range the
 * classifier's thresholds were fitted against, so the fixture stands in for a
 * photograph rather than for an interference pattern.
 */
const cleanBytes = async () => {
  const picture = cleanPicture(640, 332);
  return (await encodePng(picture.pixels,
    { width: picture.width, height: picture.height, components: 3 }))!;
};
const annotatedBytes = async () => {
  const picture = annotatedPicture(640, 332);
  return (await encodePng(picture.pixels,
    { width: picture.width, height: picture.height, components: 3 }))!;
};

/** The shape a legacy row has: provenance and a role, and no verdict at all. */
const legacyDetail = () => ({
  origin: 'notion_page_cover',
  role: 'primary_property',
  role_evidence_level: 3,
  source_sha256: 'a'.repeat(64),
  stored_sha256: 'a'.repeat(64),
  provenance_version: 3,
});

interface Row extends Record<string, unknown> { id: string }

/**
 * Enough of PostgREST to run the settlement and the enforcement.
 *
 * `missingColumns` is the point of it: a production database whose migration
 * has not been applied answers an error for the whole statement, and a probe
 * that cannot tell that from an empty table is the defect under test.
 */
function fakeDb(options: {
  uploads?: Row[];
  items?: Row[];
  images?: Row[];
  objects?: Record<string, Uint8Array>;
  missingColumns?: string[];
  missingTables?: string[];
  failWritesFor?: (table: string) => boolean;
  failDownloads?: boolean;
}) {
  const tables: Record<string, Row[]> = {
    builder_stock_uploads: options.uploads ?? [],
    builder_stock_items: options.items ?? [],
    builder_stock_item_images: options.images ?? [],
    builder_stock_settlement_target: options.missingTables?.includes(
      'builder_stock_settlement_target')
      ? []
      : [{ id: 'true', marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION }],
  };
  const objects = options.objects ?? {};
  const missingColumns = new Set(options.missingColumns ?? []);
  const missingTables = new Set(options.missingTables ?? []);
  const writes: Array<{ table: string; patch: Record<string, unknown>; id: unknown }> = [];

  const select = (table: string, columns: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let limit = 100000;
    const asked = columns.split(',').map((column) => column.trim());
    const builder: any = {
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
      gt(c: string, v: unknown) { filters.push(['gt', c, v]); return builder; },
      lt(c: string, v: unknown) { filters.push(['lt', c, v]); return builder; },
      is(c: string, v: unknown) { filters.push(['is', c, v]); return builder; },
      order() { return builder; },
      limit(v: number) { limit = v; return builder; },
      then(resolve: (r: { data: Row[] | null; error: unknown }) => unknown, reject?: unknown) {
        if (missingTables.has(table)) {
          return Promise.resolve({ data: null, error: { message: `relation ${table} missing` } })
            .then(resolve, reject as never);
        }
        const absent = asked.find((column) => missingColumns.has(column));
        if (absent) {
          return Promise.resolve({
            data: null, error: { code: '42703', message: `column ${absent} does not exist` },
          }).then(resolve, reject as never);
        }
        const rows = (tables[table] ?? []).filter((row) =>
          filters.every(([op, column, value]) => {
            const current = row[column];
            if (op === 'eq') return current === value;
            if (op === 'is') return (current ?? null) === value;
            if (op === 'gt') return String(current) > String(value);
            return current !== null && current !== undefined && Number(current) < Number(value);
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  return {
    writes,
    tables,
    from(table: string) {
      return {
        select: (columns = '*') => select(table, columns),
        update(patch: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = [];
          const builder: any = {
            eq(c: string, v: unknown) { filters.push([c, v]); return builder; },
            then(resolve: (r: unknown) => unknown, reject?: unknown) {
              if (options.failWritesFor?.(table)) {
                return Promise.resolve({ data: null, error: { message: 'write rejected' } })
                  .then(resolve, reject as never);
              }
              for (const row of tables[table] ?? []) {
                if (filters.every(([c, v]) => row[c] === v)) {
                  Object.assign(row, patch);
                  writes.push({ table, patch, id: row.id });
                }
              }
              return Promise.resolve({ data: null, error: null }).then(resolve, reject as never);
            },
          };
          return builder;
        },
      };
    },
    storage: {
      from() {
        return {
          download(path: string) {
            if (options.failDownloads) {
              return Promise.resolve({ data: null, error: { message: 'storage unavailable' } });
            }
            const bytes = objects[path];
            if (!bytes) return Promise.resolve({ data: null, error: { message: 'missing' } });
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) },
              error: null,
            });
          },
        };
      },
    },
  };
}

const image = (over: Partial<Row> = {}): Row => ({
  id: 'image-1',
  organisation_id: ORG,
  upload_id: 'upload-1',
  stock_item_id: 'item-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  position: 0,
  storage_bucket: 'builder-stock-images',
  storage_path: 'org/items/item-1/source/cover.png',
  source_detail: legacyDetail(),
  ...over,
});

const item = (over: Partial<Row> = {}): Row => ({
  id: 'item-1',
  organisation_id: ORG,
  lifecycle_status: 'active',
  primary_image_id: 'image-1',
  ...over,
});

// ---------------------------------------------------------------------------
// 1 / 2 — the backfill itself
// ---------------------------------------------------------------------------

describe('1 — a clean legacy primary with no verdict is assessed and restored', () => {
  it('reads its stored bytes, writes eligible, and becomes the chosen image', async () => {
    const row = image();
    const db = fakeDb({
      images: [row],
      items: [item({ primary_image_id: null })],
      objects: { [row.storage_path as string]: await cleanBytes() },
    });

    // Before: no verdict, so the display rule hides it and the card is blank.
    expect(isMarketplaceEligible(row.source_detail as Record<string, unknown>)).toBe(false);
    expect(chooseDisplayableImage([row as never])).toBeNull();

    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.assessed).toBe(1);
    expect(outcome.rejected).toBe(0);
    expect(outcome.unresolved).toBe(0);

    const settled = row.source_detail as Record<string, unknown>;
    expect(settled.marketplace_eligibility_state).toBe('eligible');
    expect(settled.marketplace_display_eligible).toBe(true);
    expect(settled.marketplace_eligibility_version).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
    // The role and the provenance are untouched — this adds a fact, it does not
    // restate one.
    expect(settled.role).toBe('primary_property');
    expect(settled.source_sha256).toBe('a'.repeat(64));

    expect((chooseDisplayableImage([row as never]) as { id?: string } | null)?.id).toBe('image-1');

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);
    expect(enforced.skipped).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-1');
  });
});

describe('2 — an annotated legacy primary is refused and shows nothing', () => {
  it('writes ineligible and the pointer is cleared', async () => {
    const row = image();
    const db = fakeDb({
      images: [row],
      items: [item()],
      objects: { [row.storage_path as string]: await annotatedBytes() },
    });

    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.assessed).toBe(1);
    expect(outcome.rejected).toBe(1);

    const settled = row.source_detail as Record<string, unknown>;
    expect(settled.marketplace_eligibility_state).toBe('ineligible');
    expect(settled.marketplace_rejection_reason).toBe('annotated_marketing_tile');
    expect(chooseDisplayableImage([row as never])).toBeNull();

    await enforceStrictPrimaryImages(db as never, ORG);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 / 4 — an unfinished backfill must not clear anything
// ---------------------------------------------------------------------------

describe('3 — an operational failure never clears an unassessed pointer', () => {
  it('a storage outage leaves the item exactly as it was', async () => {
    const row = image();
    const db = fakeDb({
      images: [row], items: [item()], failDownloads: true,
      objects: { [row.storage_path as string]: await cleanBytes() },
    });

    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.unresolved).toBe(1);
    expect(outcome.assessed).toBe(0);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);
    // Skipped rather than cleared: there is no evidence to decide on, and
    // "no verdict" must not be read as "nothing to show".
    expect(enforced.skipped).toBe(1);
    expect(enforced.cleared).toBe(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-1');
  });

  it('and so does a rejected verdict write', async () => {
    const row = image();
    const db = fakeDb({
      images: [row], items: [item()],
      objects: { [row.storage_path as string]: await cleanBytes() },
      failWritesFor: (table) => table === 'builder_stock_item_images',
    });

    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.unresolved).toBe(1);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);
    expect(enforced.skipped).toBe(1);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('image-1');
  });
});

describe('4 — one upload failing must not clear another property in the same organisation', () => {
  it('enforces only where the evidence is complete', async () => {
    const settledImage = image({
      id: 'image-settled', upload_id: 'upload-1', stock_item_id: 'item-settled',
      storage_path: 'org/items/item-settled/source/cover.png',
    });
    const strandedImage = image({
      id: 'image-stranded', upload_id: 'upload-2', stock_item_id: 'item-stranded',
      storage_path: 'org/items/item-stranded/source/missing.png',
    });
    const db = fakeDb({
      images: [settledImage, strandedImage],
      items: [
        item({ id: 'item-settled', primary_image_id: null }),
        item({ id: 'item-stranded', primary_image_id: 'image-stranded' }),
      ],
      // Only the first upload's object is readable.
      objects: { [settledImage.storage_path as string]: await cleanBytes() },
    });

    await settleMarketplaceEligibility(db as never, ORG, { uploadId: 'upload-1' });
    const stranded = await settleMarketplaceEligibility(db as never, ORG, { uploadId: 'upload-2' });
    expect(stranded.unresolved).toBe(1);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);
    expect(enforced.skipped).toBe(1);

    const items = db.tables.builder_stock_items;
    // The settled property gains its picture...
    expect(items.find((row) => row.id === 'item-settled')!.primary_image_id)
      .toBe('image-settled');
    // ...and the one whose evidence never arrived keeps what it had.
    expect(items.find((row) => row.id === 'item-stranded')!.primary_image_id)
      .toBe('image-stranded');
  });

  it('and a tick only enforces organisations whose ELIGIBILITY sweep finished', async () => {
    const attempted: string[] = [];
    const outcome = await runSettlementTick(
      [
        { id: 'upload-fail', organisation_id: ORG },
        { id: 'upload-ok', organisation_id: OTHER_ORG },
      ] as SettlementCandidate[],
      { maxSettled: 10, deadlineAt: Date.now() + 60_000 },
      async (candidate) => {
        attempted.push(candidate.id);
        const ok = candidate.id === 'upload-ok';
        return { uploadId: candidate.id, settled: ok, eligibilitySettled: ok };
      },
    );
    expect(attempted).toEqual(['upload-fail', 'upload-ok']);
    expect(outcome.attempted).toBe(2);
    expect(outcome.settled).toBe(1);
    // The organisation whose sweep failed is NOT handed to enforcement.
    expect(outcome.organisations).toEqual([OTHER_ORG]);
  });

  /*
   * The two markers are independent, and enforcement belongs to only one of
   * them. Production upload f7e0d4d1 reached a complete set of verdicts while
   * its provenance marker was still null — the source repair re-fetches remote
   * documents and had not finished — so gating the pointers on the whole
   * settlement would have left them stale behind unrelated work.
   */
  it('enforces on a finished eligibility sweep even when provenance has not settled', async () => {
    const outcome = await runSettlementTick(
      [{ id: 'upload-half', organisation_id: ORG }] as SettlementCandidate[],
      { maxSettled: 10, deadlineAt: Date.now() + 60_000 },
      async (candidate) => ({
        uploadId: candidate.id,
        settled: false,          // provenance still outstanding
        eligibilitySettled: true, // verdicts are all written
      }),
    );
    expect(outcome.settled).toBe(0);
    expect(outcome.organisations).toEqual([ORG]);
  });

  /*
   * The converse, which is the defect this pair exists to prevent: a sweep that
   * ran out of budget or hit an unresolved operation must not license a
   * pointer rewrite, even though the tick otherwise looks healthy.
   */
  it('does not enforce when the eligibility sweep itself did not finish', async () => {
    const outcome = await runSettlementTick(
      [{ id: 'upload-partial', organisation_id: ORG }] as SettlementCandidate[],
      { maxSettled: 10, deadlineAt: Date.now() + 60_000 },
      async (candidate) => ({
        uploadId: candidate.id, settled: false, eligibilitySettled: false,
      }),
    );
    expect(outcome.organisations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5 — the finished state
// ---------------------------------------------------------------------------

describe('5 — after a complete settlement the pointers are exactly right', () => {
  it('eligible gets the pointer, ineligible gets null', async () => {
    const cleanRow = image({
      id: 'image-clean', stock_item_id: 'item-clean',
      storage_path: 'org/items/item-clean/source/cover.png',
    });
    const tileRow = image({
      id: 'image-tile', stock_item_id: 'item-tile',
      storage_path: 'org/items/item-tile/source/tile.png',
    });
    const db = fakeDb({
      images: [cleanRow, tileRow],
      items: [
        item({ id: 'item-clean', primary_image_id: null }),
        item({ id: 'item-tile', primary_image_id: 'image-tile' }),
      ],
      objects: {
        [cleanRow.storage_path as string]: await cleanBytes(),
        [tileRow.storage_path as string]: await annotatedBytes(),
      },
    });

    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.assessed).toBe(2);
    expect(outcome.unresolved).toBe(0);

    const enforced = await enforceStrictPrimaryImages(db as never, ORG);
    expect(enforced.skipped).toBe(0);

    const items = db.tables.builder_stock_items;
    expect(items.find((row) => row.id === 'item-clean')!.primary_image_id).toBe('image-clean');
    expect(items.find((row) => row.id === 'item-tile')!.primary_image_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6 / 7 — future imports arrive already judged
// ---------------------------------------------------------------------------

describe('6/7 — a fresh import is judged during ingestion, not by the cron', () => {
  it('6 — a clean image arrives eligible', async () => {
    const detail = await eligibilityDetailFor(await cleanBytes(), 'primary_property');
    expect(detail.marketplace_eligibility_state).toBe('eligible');
    expect(detail.marketplace_display_eligible).toBe(true);
    expect(detail.marketplace_eligibility_version).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
    expect(isMarketplaceEligible(detail)).toBe(true);
  });

  it('7 — a marketing tile arrives ineligible', async () => {
    const detail = await eligibilityDetailFor(await annotatedBytes(), 'primary_property');
    expect(detail.marketplace_eligibility_state).toBe('ineligible');
    expect(detail.marketplace_display_eligible).toBe(false);
    expect(detail.marketplace_rejection_reason).toBe('annotated_marketing_tile');
  });

  it('and neither one waits for a settlement pass to get its first verdict', async () => {
    // The verdict is complete at ingestion, so the sweep has nothing to do with
    // it: `needsEligibilityAssessment` is already false.
    const detail = await eligibilityDetailFor(await cleanBytes(), 'primary_property');
    const row = image({ source_detail: { ...legacyDetail(), ...detail } });
    const db = fakeDb({ images: [row], items: [item()], objects: {} });
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.outstanding).toBe(0);
    expect(outcome.unresolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8 — still no fallback
// ---------------------------------------------------------------------------

describe('8 — nothing stands in for a refused primary', () => {
  it('not another role, and not another provider', () => {
    const refused = {
      id: 'tile', source_stage: 'uploaded_document', verification_status: 'source_supplied',
      processing_status: 'ready', position: 0, storage_path: 'tile.png',
      source_detail: {
        role: 'primary_property',
        role_evidence_level: 3,
        ...marketplaceEligibilityDetail(
          decideMarketplaceEligibility(readMarketingOverlay(annotatedPicture(400, 200)))),
      },
    };
    const others = ['interior', 'floorplan', 'site_plan', 'masterplan', 'location_map', 'materials']
      .map((role, index) => ({
        id: `other-${index}`, source_stage: 'uploaded_document',
        verification_status: 'source_supplied', processing_status: 'ready',
        position: 0, storage_path: `${role}.png`,
        source_detail: { role, role_evidence_level: 1 },
      }));
    const providers = [
      ['google_maps', 'location_derived'], ['google_street_view', 'location_derived'],
      ['satellite', 'location_derived'], ['internet_search', 'unverified'],
      ['ai_generated', 'unverified'],
    ].map(([stage, verification], index) => ({
      id: `provider-${index}`, source_stage: stage, verification_status: verification,
      processing_status: 'ready', position: 0, storage_path: `${stage}.jpg`,
      source_detail: null,
    }));

    expect(chooseDisplayableImage([refused, ...others, ...providers] as never)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The deployment-order defect itself
// ---------------------------------------------------------------------------

describe('a missing migration is an operational failure, never a quiet success', () => {
  it('names every piece of schema that is absent', async () => {
    const db = fakeDb({
      missingColumns: ['source_images_settled_version', 'marketplace_eligibility_settled_version'],
      missingTables: ['builder_stock_settlement_target'],
    });
    const readiness = await readSettlementReadiness(db as never);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([
      'builder_stock_uploads.source_images_settled_version',
      'builder_stock_uploads.marketplace_eligibility_settled_version',
      'builder_stock_settlement_target',
    ]);
    expect(readiness.target).toBeNull();
  });

  it('and reports ready, with the database target, once it is applied', async () => {
    const db = fakeDb({ uploads: [] });
    const readiness = await readSettlementReadiness(db as never);
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(readiness.target).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
  });

  it('a half-applied migration is still not ready', async () => {
    const db = fakeDb({ missingColumns: ['marketplace_eligibility_settled_version'] });
    const readiness = await readSettlementReadiness(db as never);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing)
      .toEqual(['builder_stock_uploads.marketplace_eligibility_settled_version']);
  });

  /*
   * The terminal-negative-provenance column is probed for a sharper reason
   * than the markers. The repair reads it beside every property row, so
   * without it that whole read errors, no property is matched — and the loop
   * would reach the end and call itself COMPLETE, settling an upload it never
   * looked at. Refusal, not a quiet no-op.
   */
  it('refuses when the terminal-provenance column has not been applied', async () => {
    const db = fakeDb({ missingColumns: ['source_provenance_result'] });
    const readiness = await readSettlementReadiness(db as never);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(['builder_stock_items.source_provenance_result']);
  });

  /*
   * K and L — the END CONDITION, which is the only thing that makes this a
   * repair rather than a service.
   *
   * The sweep's cron job removes itself when nothing is outstanding. That can
   * only happen if every upload can actually REACH both current versions —
   * which is precisely what the immortal package loop prevented: upload
   * f7e0d4d1 could never write `source_images_settled_version`, so the queue
   * was never empty and the job ran every five minutes for ever.
   */
  describe('K and L — the queue empties and the job can unschedule itself', () => {
    const upload = (over: Record<string, unknown>) => ({
      id: 'upload-1', organisation_id: 'org-a', deleted_at: null,
      created_at: '2026-08-01T00:00:00Z',
      source_images_settled_version: null,
      marketplace_eligibility_settled_version: null,
      ...over,
    });

    /** Only what `readOutstandingUploads` asks of a database. */
    const queueDb = (rows: Array<Record<string, unknown>>) => ({
      from() {
        const filters: Array<[string, string, unknown]> = [];
        const builder: any = {
          select() { return builder; },
          is(column: string, value: unknown) { filters.push(['is', column, value]); return builder; },
          lt(column: string, value: unknown) { filters.push(['lt', column, value]); return builder; },
          order() { return builder; },
          limit() { return builder; },
          then(resolve: (value: unknown) => unknown, reject?: unknown) {
            const data = rows.filter((row) => filters.every(([op, column, value]) => {
              const held = row[column];
              if (op === 'is') return value === null ? held == null : held === value;
              if (op === 'lt') return held != null && Number(held) < Number(value);
              return true;
            }));
            return Promise.resolve({ data, error: null }).then(resolve, reject as never);
          },
        };
        return builder;
      },
    });

    it('K — an upload current on ALL THREE dimensions leaves the queue empty', async () => {
      const outstanding = await readOutstandingUploads(
        queueDb([upload({
          source_images_settled_version: PROVENANCE_VERSION,
          marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
          image_sanitization_settled_version: SANITIZATION_VERSION,
        })]) as never,
        { limit: 100 },
      );

      expect(outstanding.unavailable).toBeFalsy();
      expect(outstanding.rows).toEqual([]);
    });

    it('L — zero outstanding is the self-unschedule condition the tick tests', async () => {
      const empty = await readOutstandingUploads(
        queueDb([upload({
          source_images_settled_version: PROVENANCE_VERSION,
          marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
          image_sanitization_settled_version: SANITIZATION_VERSION,
        })]) as never,
        { limit: 100 },
      );
      // What the cron function counts before unscheduling itself.
      expect(empty.rows.length).toBe(0);

      // And the converse, so the assertion above cannot pass vacuously: an
      // upload still short on the PROVENANCE half alone keeps the job alive.
      const stillOwed = await readOutstandingUploads(
        queueDb([upload({
          source_images_settled_version: null,
          marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
          image_sanitization_settled_version: SANITIZATION_VERSION,
        })]) as never,
        { limit: 100 },
      );
      expect(stillOwed.rows.length).toBe(1);
    });
  });
});
