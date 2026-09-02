/**
 * BUILDER STOCK — THE SWEEP MUST GET SOMEWHERE, NOT MERELY SURVIVE.
 *
 * PRODUCTION, 27 AUGUST 2026, AFTER the crash was fixed. Every settlement tick
 * returned 200 in about eleven seconds and reported `incomplete`, for ever:
 *
 *   [builder-stock-image-settler] tick { attempted: 1, settled: 0, remaining: 1 }
 *   [builderStock] source image settlement incomplete { upload_id: 7ef5c2cb… }
 *
 * Fourteen properties whose builder image sits in a linked package were never
 * once attempted. The run spent its whole budget re-deriving the record map
 * from the live Notion page (~9s), then correctly declined a package recovery
 * (~15s) for want of time — and the next tick did exactly the same thing.
 *
 * A crash that stops is a bug. A run that survives and never advances is the
 * same bug wearing a 200.
 *
 * THE FACT THAT SETTLES IT: the `Complete Package Pack` link is already in
 * `builder_stock_items.source_row.unmapped`, captured at import. Production
 * has it for all 23 rows and for all 14 of the blocked ones. Nothing on the
 * live page is needed to read it.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTION_ROW_ASSETS_VERSION_KEY,
} from '../../../supabase/functions/_shared/builderStock/repairSourceImages';
import {
  negativeProvenanceStillStands, recordNoDeterministicImage,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  nextImageStage,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
/*
 * THE REAL CONSTANT, NOT A COPY OF IT. This was `const PROVENANCE_VERSION = 5`
 * — a literal restating a value that exists to be raised, so every bump broke
 * two tests that had no opinion about the version at all. A literal at each end
 * is how two ends drift.
 */
import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/sourceImages';

describe('A — the package link is readable without the live source', () => {
  it('a stored source_row carries the package link and the anchor', () => {
    // Shape taken verbatim from production (`Lot 13 - Hummock Rise`).
    const sourceRow = {
      address_line: 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
      source_anchor: 'notion:32ecabf9-2010-802d-bed3-fae241e875c1',
      image_urls: [],
      image_url_fields: {},
      unmapped: {
        'Complete Package Pack':
          'https://drive.google.com/drive/folders/1lGjGRBRbatScwq7oFYAB2815w5fOAw8a',
        'EOI Deposit': '5000',
        Registration: 'Q2 27',
      },
    };

    // Everything the package recovery needs, with no network call:
    expect(sourceRow.unmapped['Complete Package Pack']).toMatch(/drive\.google\.com/);
    expect(sourceRow.source_anchor).toMatch(/^notion:/);
    // And nothing on the live page is required, because the row names no
    // image of its own — that is exactly why it is blocked on the package.
    expect(sourceRow.image_urls).toHaveLength(0);
  });

  it('the enumeration stamp is a version, keyed where the upload already records imagery', () => {
    expect(NOTION_ROW_ASSETS_VERSION_KEY).toBe('notion_row_assets_version');
    // Merged into the existing summary, never written over it.
    const before = { uploaded_document: { ready: 9 } };
    const after = { ...before, [NOTION_ROW_ASSETS_VERSION_KEY]: PROVENANCE_VERSION };
    expect(after.uploaded_document).toEqual({ ready: 9 });
    expect(Number(after[NOTION_ROW_ASSETS_VERSION_KEY])).toBe(PROVENANCE_VERSION);
  });
});

describe('B,C,D — a package answered once is never bought twice', () => {
  const question = (pkg: string, anchor: string) => ({
    provenanceVersion: PROVENANCE_VERSION,
    packageReference: pkg,
    sourceAnchor: anchor,
  });

  const noImageDetail = 'package named no deterministic image';

  it('C — a package that named no image is remembered, so the next tick moves on', () => {
    const answered = recordNoDeterministicImage(question('pkg-a', 'row-a'), noImageDetail, 'inspected');
    // Asked again at the same version, about the same package and row: settled.
    expect(negativeProvenanceStillStands(answered, question('pkg-a', 'row-a'))).toBe(true);
    // A DIFFERENT property is not answered by it, so the sweep advances.
    expect(negativeProvenanceStillStands(answered, question('pkg-b', 'row-b'))).toBe(false);
  });

  it('a changed package or a version bump re-opens the question', () => {
    const answered = recordNoDeterministicImage(question('pkg-a', 'row-a'), noImageDetail, 'inspected');
    expect(negativeProvenanceStillStands(answered, question('pkg-new', 'row-a'))).toBe(false);
    expect(negativeProvenanceStillStands(answered, {
      ...question('pkg-a', 'row-a'), provenanceVersion: PROVENANCE_VERSION + 1,
    })).toBe(false);
  });

  it('B — fourteen rows, one package per tick, all terminal and none repeated', () => {
    // The production shape. Each tick answers exactly one row and the answer
    // is durable, so the queue drains rather than restarting at row one.
    const rows = Array.from({ length: 14 }, (_, n) => ({
      pkg: `pkg-${n}`, anchor: `row-${n}`,
    }));
    const answers = new Map<string, unknown>();
    const bought: string[] = [];

    for (let tick = 0; tick < 40 && answers.size < rows.length; tick++) {
      const next = rows.find((row) =>
        !negativeProvenanceStillStands(answers.get(row.anchor), question(row.pkg, row.anchor)));
      if (!next) break;
      bought.push(next.anchor);                       // one recovery this tick
      answers.set(next.anchor, recordNoDeterministicImage(question(next.pkg, next.anchor), noImageDetail, 'inspected'));
    }

    expect(answers.size).toBe(14);
    // Exactly fourteen recoveries for fourteen rows: nothing was bought twice.
    expect(bought).toHaveLength(14);
    expect(new Set(bought).size).toBe(14);
    // And no tick restarted at the first row.
    expect(bought[0]).toBe('row-0');
    expect(bought[13]).toBe('row-13');
  });

  it('D — an OPERATIONAL failure stays retryable and does not answer the row', () => {
    // Nothing is recorded for a fetch that failed, so the row is picked again
    // — the cooldown, not a false terminal answer, is what paces it.
    const answers = new Map<string, unknown>();
    expect(negativeProvenanceStillStands(answers.get('row-a'), question('pkg-a', 'row-a')))
      .toBe(false);
  });
});

describe('J,G,H,I — the paid stages still wait for this property, and only this property', () => {
  const sourceRow = (over: Record<string, unknown> = {}) => ({
    id: 'src', source_stage: 'uploaded_document', verification_status: 'source_supplied',
    processing_status: 'ready', storage_path: 'p', position: 0,
    source_detail: {
      role: 'primary_property', role_evidence_level: 1, stored_sha256: 'a'.repeat(64),
      marketplace_display_eligible: true, marketplace_eligibility_state: 'eligible',
      marketplace_measured: true, marketplace_eligibility_version: 2,
    },
    ...over,
  });

  it('J — while its own source is still being read, neither fallback runs', () => {
    expect(nextImageStage([] as never, { sourceSettlementComplete: false })).toBe('wait');
  });

  it('G — a recovered builder package image ends it: no web search, no Street View', () => {
    expect(nextImageStage([sourceRow()] as never, { sourceSettlementComplete: true }))
      .toBe('none');
    // And even mid-settlement, a property that already HAS its builder image
    // is finished — it does not wait on somebody else's row.
    expect(nextImageStage([sourceRow()] as never, { sourceSettlementComplete: false }))
      .toBe('none');
  });

  it('H — a property whose source is terminal with no usable image goes to web search', () => {
    expect(nextImageStage([] as never, { sourceSettlementComplete: true })).toBe('web_search');
  });

  it('I — an unverifiable web result falls through to Street View', () => {
    const unverified = {
      id: 'w', source_stage: 'internet_search', verification_status: 'unverified',
      processing_status: 'ready', external_url: 'https://x.test/a.jpg', position: 0,
      source_detail: {},
    };
    expect(nextImageStage([unverified] as never, { sourceSettlementComplete: true }))
      .toBe('street_view');
  });

  it('K — one property having its builder image does not hold another back', () => {
    // The two questions are asked per property, from that property's own rows.
    const done = nextImageStage([sourceRow()] as never, { sourceSettlementComplete: true });
    const waiting = nextImageStage([] as never, { sourceSettlementComplete: false });
    expect(done).toBe('none');
    expect(waiting).toBe('wait');
  });
});

describe('E,F — reading from stored rows must not cost the source its own imagery', () => {
  it('E — the live page is still read while the asset question is open', () => {
    // The stamp is the whole gate, and it is absent until a run enumerates
    // the assets AND defers none of them.
    const summary: Record<string, unknown> = { uploaded_document: { ready: 9 } };
    const enumerated = Number(summary[NOTION_ROW_ASSETS_VERSION_KEY] ?? -1) >= PROVENANCE_VERSION;
    expect(enumerated).toBe(false);
  });

  it('E — a run that DEFERRED an asset-bearing row must not record the enumeration', () => {
    // The guard is `notionAssetsRead && !assetRowsDeferred`. Modelled here so
    // the rule is stated where it can fail loudly: a cover left unstored must
    // keep the live read alive, or nobody would ever look for it again.
    const stamp = (read: boolean, deferred: number) => read && deferred === 0;
    expect(stamp(true, 0)).toBe(true);
    expect(stamp(true, 1)).toBe(false);
    expect(stamp(false, 0)).toBe(false);
  });

  it('F — an explicit Property Image field still outranks a page cover', () => {
    // Evidence level 1 is the explicit field; the page cover is level 3. The
    // ordering lives in the source rules and is unchanged by reading rows from
    // storage — the stored row carries `image_url_fields` verbatim.
    const stored = {
      image_urls: ['https://x.test/field.jpg'],
      image_url_fields: { 'https://x.test/field.jpg': 'Property Image' },
    };
    expect(stored.image_url_fields[stored.image_urls[0]]).toBe('Property Image');
  });
});

// ---------------------------------------------------------------------------
// THE SAME RULES, EXECUTED.
//
// Everything above models the rule. That is not enough here, and this file is
// the proof: the enumeration stamp shipped once INSIDE THE WRONG FUNCTION —
// `repairPdfUpload`, where none of its variables are in scope — and every
// assertion above stayed green, because none of them runs the code. A
// ReferenceError on the Notion path is exactly the class of defect this
// repository has already paid for (`TS2304` is fatal in `check-edge-functions`
// for that reason).
//
// So the branch is driven for real, against the in-memory stand-in the other
// Builder Stock suites use, with the live read as an injected seam: a run that
// reads the live page fails loudly here if it should not have, and a run that
// does not read it cannot pretend it did.
// ---------------------------------------------------------------------------

interface FakeRow { [key: string]: unknown }

const NOTION_URL = 'https://acme.notion.site/Stock-List-32ecabf90000';

function liveDb(seed: { uploads: FakeRow[]; items: FakeRow[] }) {
  const tables: Record<string, FakeRow[]> = {
    builder_stock_uploads: seed.uploads.map((row) => ({ ...row })),
    builder_stock_items: seed.items.map((row) => ({ ...row })),
    builder_stock_item_images: [],
  };
  const matches = (row: FakeRow, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'is') return row[column] === value || (value === null && row[column] == null);
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    });

  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: any = {
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
      is(c: string, v: unknown) { filters.push(['is', c, v]); return builder; },
      in(c: string, v: unknown) { filters.push(['in', c, v]); return builder; },
      limit() { return builder; },
      order() { return builder; },
      // A paged read asks for one page at a time, because the API caps every
      // response at `db-max-rows` however large a `.limit()` it is given.
      range(from: number, to: number) {
        return Promise.resolve(builder as any).then((page: any) => ({ data: (page?.data ?? []).slice(from, to + 1), error: page?.error ?? null }));
      },
      maybeSingle() {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown, reject?: unknown) {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  const db: any = {
    tables,
    from(table: string) {
      return {
        select: () => selectBuilder(table),
        upsert(row: FakeRow) {
          (tables[table] ?? (tables[table] = [])).push({ id: `row-${Math.random()}`, ...row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: FakeRow) {
          const filters: Array<[string, string, unknown]> = [];
          const builder: any = {
            eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
            then(resolve: (value: unknown) => unknown, reject?: unknown) {
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
    storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: { message: 'no' } }) }) },
  };
  return db;
}

const PACKAGE_LINK = 'https://drive.google.com/drive/folders/1lGjGRBRbatScwq7oFYAB2815w5fOAw8a';

/** Exactly the shape production stores, for the reported property. */
const storedRow = (anchor: string) => ({
  external_reference: null, development_name: null, project_name: null,
  address_line: 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
  suburb: 'Werribee', state: 'VIC', postcode: '3030',
  lot_number: '13', unit_number: null,
  bedrooms: 4, bathrooms: 2, car_spaces: 2, property_type: 'house',
  land_size_sqm: 350, building_size_sqm: null,
  price: 812000, price_display: '$812,000', availability_status: 'unknown',
  expected_completion: null, description: null,
  image_urls: [], image_url_fields: {},
  source_anchor: `notion:${anchor}`,
  unmapped: { 'Complete Package Pack': PACKAGE_LINK, 'EOI Deposit': '5000' },
});

const upload = (summary: Record<string, unknown>) => ({
  id: 'upload-1', organisation_id: 'org-a', source_type: 'url',
  source_url: NOTION_URL, final_url: NOTION_URL, original_filename: 'stock',
  storage_bucket: 'builder-stock-lists', storage_path: 'p/stock.html',
  deleted_at: null, image_stage_summary: summary,
});

const item = (anchor: string) => ({
  id: `item-${anchor}`, organisation_id: 'org-a', upload_id: 'upload-1',
  lifecycle_status: 'active', primary_image_id: null,
  external_reference: null, development_name: null, project_name: null,
  unit_number: null, lot_number: '13',
  source_row: storedRow(anchor), source_provenance_result: null,
});

describe('EXECUTED — the stamp gates the live read, and the stored row carries the package',
  () => {
    it('with the stamp present the live page is NOT read and the stored rows are used',
      async () => {
        const { repairSourceImagesForUpload } = await import(
          '../../../supabase/functions/_shared/builderStock/repairSourceImages');
        const db = liveDb({
          uploads: [upload({
            uploaded_document: { ready: 9 },
            [NOTION_ROW_ASSETS_VERSION_KEY]: PROVENANCE_VERSION,
          })],
          items: [item('a1')],
        });

        const readLive: string[] = [];
        const packages: string[] = [];
        const outcome = await repairSourceImagesForUpload(
          db, { organisationId: 'org-a', uploadId: 'upload-1' },
          {
            readNotionSource: async (url: string) => {
              readLive.push(url);
              return { ok: true as const, rows: [], assets: [] };
            },
            fetchPackage: async (url: string) => {
              packages.push(url);
              return { bytes: new Uint8Array(), finalUrl: url };
            },
          },
        );

        // The whole liveness fix: nothing on the live page was bought...
        expect(readLive).toEqual([]);
        // ...the stored row was read as a RECORD (not re-normalised into
        // nothing), and it matched the property it came from...
        expect(outcome.rowsRead).toBe(1);
        expect(outcome.error).toBeUndefined();
        // ...and the budget went where it was always meant to go: the package
        // link that was sitting in `source_row.unmapped` all along.
        expect(packages.some((url) => url.includes('1lGjGRBRbatScwq7oFYAB2815w5fOAw8a')))
          .toBe(true);
      });

    it('without the stamp the live page IS read, and a clean run records the enumeration',
      async () => {
        const { repairSourceImagesForUpload } = await import(
          '../../../supabase/functions/_shared/builderStock/repairSourceImages');
        const db = liveDb({
          uploads: [upload({ uploaded_document: { ready: 9 } })],
          items: [item('a1')],
        });

        const readLive: string[] = [];
        await repairSourceImagesForUpload(
          db, { organisationId: 'org-a', uploadId: 'upload-1' },
          {
            readNotionSource: async (url: string) => {
              readLive.push(url);
              // The live page, carrying the row keyed by the SOURCE's headers.
              return {
                ok: true as const,
                rows: [{
                  Deal: 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
                  'Complete Package Pack': PACKAGE_LINK,
                  __source_anchor: 'notion:a1',
                }],
                assets: [],
              };
            },
            fetchPackage: async (url: string) => ({ bytes: new Uint8Array(), finalUrl: url }),
          },
        );

        expect(readLive).toEqual([NOTION_URL]);
        const summary = db.tables.builder_stock_uploads[0].image_stage_summary as
          Record<string, unknown>;
        // Recorded — and MERGED, so the stage counts beside it survive.
        expect(Number(summary[NOTION_ROW_ASSETS_VERSION_KEY])).toBe(PROVENANCE_VERSION);
        expect(summary.uploaded_document).toEqual({ ready: 9 });
      });

    it('a live read that FAILED records nothing, so the next tick reads the page again',
      async () => {
        const { repairSourceImagesForUpload } = await import(
          '../../../supabase/functions/_shared/builderStock/repairSourceImages');
        const db = liveDb({
          uploads: [upload({ uploaded_document: { ready: 9 } })],
          items: [item('a1')],
        });

        const outcome = await repairSourceImagesForUpload(
          db, { organisationId: 'org-a', uploadId: 'upload-1' },
          { readNotionSource: async () => ({ ok: false as const }) },
        );

        expect(outcome.error).toBeDefined();
        const summary = db.tables.builder_stock_uploads[0].image_stage_summary as
          Record<string, unknown>;
        expect(summary[NOTION_ROW_ASSETS_VERSION_KEY]).toBeUndefined();
      });

    it('L — the stored path demotes nothing: it did not look, so it found nothing',
      async () => {
        const { repairSourceImagesForUpload } = await import(
          '../../../supabase/functions/_shared/builderStock/repairSourceImages');
        const db = liveDb({
          uploads: [upload({
            uploaded_document: { ready: 9 },
            [NOTION_ROW_ASSETS_VERSION_KEY]: PROVENANCE_VERSION,
          })],
          items: [{ ...item('a1'), primary_image_id: 'img-served' }],
        });
        // A served card whose reference exists ONLY on the live page — the
        // shape all nine of this deployment's cards actually have — and which
        // predates the current provenance version, so the re-audit would
        // convict it if it ran.
        db.tables.builder_stock_item_images.push({
          id: 'img-served', stock_item_id: 'item-a1', organisation_id: 'org-a',
          source_stage: 'uploaded_document', source_provider: 'notion',
          processing_status: 'ready',
          source_reference: 'attachment:7661b441-f342-472e-85ca-760b522a962c:cover.jpg',
          source_detail: { provenance_version: PROVENANCE_VERSION - 1 },
        });

        const outcome = await repairSourceImagesForUpload(
          db, { organisationId: 'org-a', uploadId: 'upload-1' },
          { fetchPackage: async (url: string) => ({ bytes: new Uint8Array(), finalUrl: url }) },
        );

        expect(outcome.demoted).toBe(0);
        const served = db.tables.builder_stock_item_images
          .find((row: FakeRow) => row.id === 'img-served')!;
        expect(served.processing_status).toBe('ready');
      });

    it('a stored record is never put back through the header normaliser', async () => {
      // The defect this guards: `normaliseStockRow` reads a row keyed by the
      // SOURCE's own headers. A stored record's `unmapped` is a nested object,
      // which stringifies to nothing usable — the package link would be lost
      // and the row would then fail `identifiesAProperty` and disappear in
      // silence, leaving the sweep with nothing to do and no error to show.
      const { normaliseStockRow } = await import(
        '../../../supabase/functions/_shared/builderStock/normalise.pure');
      const round = normaliseStockRow(storedRow('a1') as unknown as Record<string, unknown>);
      expect(round?.unmapped?.['Complete Package Pack']).toBeUndefined();
    });
  });
