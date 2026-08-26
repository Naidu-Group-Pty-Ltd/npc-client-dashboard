/**
 * Builder stock — a clean builder original comes FIRST, and a badge cannot end
 * the search for one.
 *
 * THE DEFECT THIS FILE PINS. Eight live cards were blank because their
 * selected builder-supplied image is the property's facade under promotional
 * pills — and for several of them the SAME builder supplies a clean render of
 * the SAME property one link away, inside the row's own package PDF. The
 * repair loop's row-asset branch ended the property's search the moment the
 * row owned any asset at all (`if (all.length) { …; continue; }`), so a
 * badged Notion page cover was enough to stop the discovery of the clean file
 * the card should be showing.
 *
 * The corrected rule is deliberately narrow: only a row whose OWN primary
 * candidates are all measured-and-convicted promotional falls through to its
 * OWN linked package, under every identity proof that path has always
 * demanded. A clean cover ends the search exactly as before; a pending
 * verdict ends it; another lot's package remains as unreachable as ever.
 */
import { describe, expect, it } from 'vitest';

import {
  ANNOTATED_VERDICT, CLEAN_VERDICT, annotatedPicture, cleanPicture, jpegOf, pngOf,
} from './fixtures/builderStockPictures';
import {
  repairSourceImagesForUpload,
} from '../../../supabase/functions/_shared/builderStock/repairSourceImages';
import {
  PROVENANCE_VERSION, readPrimaryImageStanding,
} from '../../../supabase/functions/_shared/builderStock/sourceImages';
import {
  chooseDisplayableImage, classifyPrimaryImageStanding, servesCleanOriginal,
  type DisplayableImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  newRepairBudget, settleImageSanitization,
} from '../../../supabase/functions/_shared/builderStock/settleImageSanitization';
import {
  SANITIZATION_VERSION,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

// ---------------------------------------------------------------------------
// Fixtures: a stock list whose row carries BOTH a cover and a package link
// ---------------------------------------------------------------------------

const ORG = 'org-a';
const DEAL =
  'Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]';

const csvWith = (photoUrl: string) => [
  'Deal,Estate Tag,Package Price,Photo,Complete Package Pack',
  `"${DEAL}",Sandpiper Estate,1307585,${photoUrl},`
    + 'https://drive.google.com/drive/folders/pack-root-0001',
].join('\r\n');

const upload = {
  id: 'upload-1',
  organisation_id: ORG,
  source_type: 'file',
  source_url: null,
  final_url: null,
  original_filename: 'stock.csv',
  storage_bucket: 'builder-stock-lists',
  storage_path: 'stock-lists/org-a/upload-1/stock.csv',
  deleted_at: null,
};

const item = () => ({
  id: 'item-43', organisation_id: ORG, lifecycle_status: 'active',
  external_reference: null, development_name: 'Sandpiper Estate',
  project_name: null, unit_number: null, lot_number: null,
  primary_image_id: null,
  source_row: {
    address_line: DEAL, development_name: 'Sandpiper Estate', price: 1307585,
  },
});

/** The builder's clean render, as the package PDF carries it. */
const packageJpeg = jpegOf(cleanPicture(340, 191), 160_000);

const encoder = new TextEncoder();
const FOLDER = 'application/vnd.google-apps.folder';
const listing = (entries: Array<[string, string, string]>) => {
  const json = JSON.stringify([entries.map(([id, label, mime]) => [id, ['p'], label, mime]), null]);
  const escaped = json.replace(/[[\]"\\/]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return encoder.encode(`<script>window['_DRIVE_ivd'] = '${escaped}';</script>`);
};
const packagePdf = (() => {
  const draw = 'q 516 0 0 290 40 480 cm /Im0 Do Q';
  const head = encoder.encode('%PDF-1.4\n'
    + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
    + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n'
    + `4 0 obj<</Type/XObject/Subtype/Image/Width 1700/Height 956/Filter/DCTDecode/Length ${packageJpeg.length}>>stream\n`);
  const tail = encoder.encode('\nendstream\nendobj\n'
    + `5 0 obj<</Length ${draw.length}>>stream\n${draw}\nendstream\nendobj\n`
    + 'trailer<</Root 1 0 R>>\n');
  const out = new Uint8Array(head.length + packageJpeg.length + tail.length);
  out.set(head, 0); out.set(packageJpeg, head.length);
  out.set(tail, head.length + packageJpeg.length);
  return out;
})();

/** The builder's own library: Packages / Lot 43 / one PDF naming lot + design. */
function packageFetcher() {
  const requested: string[] = [];
  const fetchPackage = async (url: string) => {
    requested.push(url);
    if (url.includes('/folders/pack-root-0001')) {
      return { bytes: listing([['packages-0001', 'Tweed Heads Packages', FOLDER]]), finalUrl: url };
    }
    if (url.includes('/folders/packages-0001')) {
      return { bytes: listing([['lot43-0001', 'Lot 43', FOLDER]]), finalUrl: url };
    }
    if (url.includes('/folders/lot43-0001')) {
      return {
        bytes: listing([
          ['doc-strad-0001', 'Lot 43 - Stradbroke 180 - Property Package.pdf', 'application/pdf'],
        ]),
        finalUrl: url,
      };
    }
    if (url.includes('id=doc-strad-0001')) return { bytes: packagePdf, finalUrl: url };
    return { bytes: encoder.encode('<html>Sign in</html>'), finalUrl: url };
  };
  return { requested, fetchPackage };
}

const readPageTexts = async () => [
  `${DEAL}\nFIXED PRICE CONTRACT\n$1,307,585\nLand Size 350 m2\n4 bed 2 bath 2 car`,
];

// The same in-memory stand-in the other Builder Stock suites use.
interface FakeRow { [key: string]: unknown }

function fakeDb(seed: {
  images?: FakeRow[]; items?: FakeRow[]; uploads?: FakeRow[];
  objects?: Record<string, Uint8Array>;
} = {}) {
  const tables: Record<string, FakeRow[]> = {
    builder_stock_item_images: [...(seed.images ?? [])],
    builder_stock_items: [...(seed.items ?? [])],
    builder_stock_uploads: [...(seed.uploads ?? [])],
  };
  const stored: Record<string, { bytes: Uint8Array; contentType: string }> = {};
  const sourceObjects = seed.objects ?? {};
  let autoId = 0;

  const matches = (row: FakeRow, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'is') return row[column] === value || (value === null && row[column] == null);
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      if (op === 'gt') return String(row[column]) > String(value);
      return true;
    });

  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let limit = 100000;
    const builder: any = {
      eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
      is(column: string, value: unknown) { filters.push(['is', column, value]); return builder; },
      in(column: string, value: unknown) { filters.push(['in', column, value]); return builder; },
      gt(column: string, value: unknown) { filters.push(['gt', column, value]); return builder; },
      limit(value: number) { limit = value; return builder; },
      order() { return builder; },
      maybeSingle() {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown, reject?: unknown) {
        const rows = (tables[table] ?? [])
          .filter((row) => matches(row, filters))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  const db: any = {
    tables,
    stored,
    from(table: string) {
      return {
        select: () => selectBuilder(table),
        upsert(row: FakeRow) {
          const list = tables[table] ?? (tables[table] = []);
          const index = list.findIndex((existing) =>
            existing.stock_item_id === row.stock_item_id
            && existing.source_stage === row.source_stage
            && existing.source_reference === row.source_reference);
          if (index >= 0) list[index] = { ...list[index], ...row };
          else list.push({ id: `image-${++autoId}`, ...row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: FakeRow) {
          const filters: Array<[string, string, unknown]> = [];
          const builder: any = {
            eq(column: string, value: unknown) {
              filters.push(['eq', column, value]); return builder;
            },
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
    storage: {
      from() {
        return {
          upload(path: string, bytes: Uint8Array | Blob, options: { contentType: string }) {
            stored[path] = { bytes: bytes as Uint8Array, contentType: options.contentType };
            return Promise.resolve({ data: { path }, error: null });
          },
          download(path: string) {
            const bytes = sourceObjects[path];
            if (!bytes) return Promise.resolve({ data: null, error: { message: 'not found' } });
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) },
              error: null,
            });
          },
        };
      },
    },
  };
  return db;
}

const PROMO_PNG = await pngOf(annotatedPicture(400, 200));
const CLEAN_PNG = await pngOf(cleanPicture(320, 166));

const sourceRows = (db: any): FakeRow[] =>
  db.tables.builder_stock_item_images.filter(
    (row: FakeRow) => row.source_stage === 'uploaded_document');

// ---------------------------------------------------------------------------
// TEST 1 / 2 — a convicted cover does not stop same-property package discovery
// ---------------------------------------------------------------------------

describe('a promotional row-owned image cannot end the search for a clean one', () => {
  it('falls through to the SAME property\'s own package and the clean render wins',
    async () => {
      const { requested, fetchPackage } = packageFetcher();
      const db = fakeDb({
        uploads: [upload],
        items: [item()],
        objects: {
          [upload.storage_path]:
            encoder.encode(csvWith('https://builder.example/img/lot-43-cover.png')),
        },
      });

      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: ORG, uploadId: 'upload-1' },
        {
          // The row's own cover: the facade under promotional pills.
          fetchImage: async (url: string) => ({ bytes: PROMO_PNG, finalUrl: url }),
          fetchPackage,
          readPageTexts,
        },
      );

      expect(outcome.error).toBeUndefined();
      // The cover was stored AND measured as a marketing tile...
      const cover = sourceRows(db).find(
        (row) => String(row.source_reference).includes('lot-43-cover'));
      expect(cover).toBeDefined();
      expect((cover!.source_detail as Record<string, unknown>)
        .marketplace_rejection_reason).toBe('annotated_marketing_tile');

      // ...and its existence did NOT stop the package walk: the property's own
      // library was read and the clean render recovered.
      expect(requested.length).toBeGreaterThan(0);
      expect(outcome.fromPackage).toBe(1);
      const recovered = sourceRows(db).find(
        (row) => row.source_provider === 'linked_package');
      expect(recovered).toBeDefined();
      expect((recovered!.source_detail as Record<string, unknown>)
        .marketplace_eligibility_state).toBe('eligible');

      // The card shows the clean builder original — never the badged cover.
      expect(db.tables.builder_stock_items[0].primary_image_id).toBe(recovered!.id);

      // And the audit trail keeps the cover, refused for display, not deleted.
      expect(cover!.processing_status).toBe('ready');
    });

  it('converges: the next run does not re-read the package a clean image came from',
    async () => {
      const { requested, fetchPackage } = packageFetcher();
      const db = fakeDb({
        uploads: [upload],
        items: [item()],
        objects: {
          [upload.storage_path]:
            encoder.encode(csvWith('https://builder.example/img/lot-43-cover.png')),
        },
      });
      const deps = {
        fetchImage: async (url: string) => ({ bytes: PROMO_PNG, finalUrl: url }),
        fetchPackage,
        readPageTexts,
      };

      await repairSourceImagesForUpload(db, { organisationId: ORG, uploadId: 'upload-1' }, deps);
      const afterFirst = requested.length;
      expect(afterFirst).toBeGreaterThan(0);

      const second = await repairSourceImagesForUpload(
        db, { organisationId: ORG, uploadId: 'upload-1' }, deps);
      // A clean primary now stands, so the convicted cover no longer licenses
      // any further reading: no fetch, no package walk, a finished run.
      expect(requested.length).toBe(afterFirst);
      expect(second.incomplete).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// TEST 3 — a clean cover ends the search exactly as it always did
// ---------------------------------------------------------------------------

describe('a clean row-owned image is used as-is and nothing else is read', () => {
  it('stores the clean cover, reads no package, and the cover stays the card',
    async () => {
      const { requested, fetchPackage } = packageFetcher();
      const db = fakeDb({
        uploads: [upload],
        items: [item()],
        objects: {
          [upload.storage_path]:
            encoder.encode(csvWith('https://builder.example/img/lot-43-clean.png')),
        },
      });

      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: ORG, uploadId: 'upload-1' },
        {
          fetchImage: async (url: string) => ({ bytes: CLEAN_PNG, finalUrl: url }),
          fetchPackage,
          readPageTexts,
        },
      );

      expect(outcome.error).toBeUndefined();
      expect(outcome.imagesStored).toBe(1);
      // NOT unnecessarily replaced: the package was never even listed.
      expect(requested).toHaveLength(0);
      expect(outcome.fromPackage).toBe(0);

      const cover = sourceRows(db)[0];
      expect((cover.source_detail as Record<string, unknown>)
        .marketplace_eligibility_state).toBe('eligible');
      expect(db.tables.builder_stock_items[0].primary_image_id).toBe(cover.id);
    });
});

// ---------------------------------------------------------------------------
// TEST 4 — another lot's package remains as unreachable as it ever was
// ---------------------------------------------------------------------------

describe('cross-property sourcing stays forbidden (the Lot 1663 rule)', () => {
  it('a convicted cover whose own package names another lot gets NO image from it',
    async () => {
      /*
       * The Lot 1663 shape: its own promotional cover, and a linked library
       * whose only package documents belong to Lot 1639. The clean master in
       * there is real, it is one selector call away, and it is not this
       * property's — so the answer is a banked "names no image", never a
       * borrowed facade.
       */
      const requested: string[] = [];
      const fetchPackage = async (url: string) => {
        requested.push(url);
        if (url.includes('/folders/pack-root-0001')) {
          return {
            bytes: listing([['lot1639-0001', 'Lot 1639', FOLDER]]), finalUrl: url,
          };
        }
        if (url.includes('/folders/lot1639-0001')) {
          return {
            bytes: listing([
              ['doc-1639', 'Lot 1639 - Coolum 199 - Property Package.pdf', 'application/pdf'],
            ]),
            finalUrl: url,
          };
        }
        if (url.includes('id=doc-1639')) return { bytes: packagePdf, finalUrl: url };
        return { bytes: encoder.encode('<html>Sign in</html>'), finalUrl: url };
      };

      const deal1663 = 'Lot 1663 - Ringer Street, Lara VIC 3212 [Aspen 210]';
      const csv = [
        'Deal,Estate Tag,Package Price,Photo,Complete Package Pack',
        `"${deal1663}",Lara,643000,https://builder.example/img/lot-1663-cover.png,`
          + 'https://drive.google.com/drive/folders/pack-root-0001',
      ].join('\r\n');

      const db = fakeDb({
        uploads: [upload],
        items: [{
          ...item(),
          id: 'item-1663',
          development_name: 'Lara',
          source_row: { address_line: deal1663, development_name: 'Lara', price: 643000 },
        }],
        objects: { [upload.storage_path]: encoder.encode(csv) },
      });

      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: ORG, uploadId: 'upload-1' },
        {
          fetchImage: async (url: string) => ({ bytes: PROMO_PNG, finalUrl: url }),
          fetchPackage,
          readPageTexts: async () => [
            'Lot 1639 - Coolum 199\nFIXED PRICE\n$800,000\nLand 400 m2',
          ],
        },
      );

      expect(outcome.error).toBeUndefined();
      // The library WAS read (the fall-through happened)...
      expect(requested.length).toBeGreaterThan(0);
      // ...and it named nothing for THIS lot, so nothing was taken from it.
      expect(outcome.fromPackage).toBe(0);
      expect(outcome.packageNotIdentified).toBe(1);
      expect(sourceRows(db).filter(
        (row) => row.source_provider === 'linked_package')).toHaveLength(0);
      // The card shows nothing rather than another property's house.
      expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The standing classifier: what licenses a fall-through, and what never does
// ---------------------------------------------------------------------------

describe('classifyPrimaryImageStanding', () => {
  const row = (detail: Record<string, unknown>): DisplayableImage => ({
    id: 'row', source_stage: 'uploaded_document',
    verification_status: 'source_supplied', processing_status: 'ready',
    storage_path: 'x.png',
    source_detail: {
      role: 'primary_property', provenance_version: PROVENANCE_VERSION, ...detail,
    },
  });

  it('a convicted-only property licenses the fall-through', () => {
    const standing = classifyPrimaryImageStanding(
      [row(ANNOTATED_VERDICT)], PROVENANCE_VERSION);
    expect(standing).toEqual({ ready: true, clean: false, convictedOnly: true });
  });

  it('one clean candidate ends the question', () => {
    const standing = classifyPrimaryImageStanding(
      [row(ANNOTATED_VERDICT), row(CLEAN_VERDICT)], PROVENANCE_VERSION);
    expect(standing.clean).toBe(true);
    expect(standing.convictedOnly).toBe(false);
  });

  it('a PENDING verdict is evidence that has not arrived, and licenses nothing', () => {
    const standing = classifyPrimaryImageStanding([
      row(ANNOTATED_VERDICT),
      row({ marketplace_eligibility_state: 'pending', marketplace_rejection_reason: 'decoder_failed' }),
    ], PROVENANCE_VERSION);
    expect(standing).toEqual({ ready: true, clean: false, convictedOnly: false });
  });

  it('a non-primary row neither convicts nor cleans', () => {
    const floorplan = row(CLEAN_VERDICT);
    (floorplan.source_detail as Record<string, unknown>).role = 'floorplan';
    const standing = classifyPrimaryImageStanding(
      [floorplan, row(ANNOTATED_VERDICT)], PROVENANCE_VERSION);
    expect(standing).toEqual({ ready: true, clean: false, convictedOnly: true });
  });

  it('the db helper reads the same answer through the same query', async () => {
    const db = fakeDb({
      images: [{
        id: 'img-1', stock_item_id: 'item-9', source_stage: 'uploaded_document',
        processing_status: 'ready', verification_status: 'source_supplied',
        storage_path: 'a.png',
        source_detail: {
          role: 'primary_property', provenance_version: PROVENANCE_VERSION,
          ...ANNOTATED_VERDICT,
        },
      }],
    });
    expect(await readPrimaryImageStanding(db, 'item-9', PROVENANCE_VERSION))
      .toEqual({ ready: true, clean: false, convictedOnly: true });
  });
});

// ---------------------------------------------------------------------------
// Serving: clean builder original > cleaned promotional derivative
// ---------------------------------------------------------------------------

describe('a clean original outranks a sanitized derivative, and never evicts it', () => {
  const SHA = 'a'.repeat(64);
  const derivativeCover: DisplayableImage = {
    id: 'cover-1', source_stage: 'uploaded_document',
    verification_status: 'source_supplied', processing_status: 'ready',
    position: 0, storage_path: 'cover.png',
    source_detail: {
      role: 'primary_property', role_evidence_level: 3,
      stored_sha256: SHA,
      ...ANNOTATED_VERDICT,
      sanitized_derivative: {
        transformation: 'generative_overlay_inpaint',
        sanitization_version: SANITIZATION_VERSION,
        original_image_id: 'cover-1', original_sha256: SHA,
        stock_item_id: 'item-1', organisation_id: ORG, source_reference: null,
        storage_bucket: 'builder-stock-images', storage_path: 'sanitized/cover.png',
        derivative_sha256: 'b'.repeat(64), width: 400, height: 200,
        repaired_share: 0.1, regions_removed: 2,
        model: '@cf/runwayml/stable-diffusion-v1-5-inpainting',
        generated_at: '2026-08-01T00:00:00Z', verdict: 'eligible',
      },
    },
  };
  const cleanPackageImage: DisplayableImage = {
    id: 'package-1', source_stage: 'uploaded_document',
    verification_status: 'source_supplied', processing_status: 'ready',
    position: 0, storage_path: 'package.jpg',
    source_detail: { role: 'primary_property', role_evidence_level: 3, ...CLEAN_VERDICT },
  };

  it('both are displayable, and the untouched original is the card', () => {
    expect(servesCleanOriginal(derivativeCover)).toBe(false);
    expect(servesCleanOriginal(cleanPackageImage)).toBe(true);
    expect(chooseDisplayableImage([derivativeCover, cleanPackageImage])?.id)
      .toBe('package-1');
    expect(chooseDisplayableImage([cleanPackageImage, derivativeCover])?.id)
      .toBe('package-1');
  });

  it('a property whose only picture is the derivative keeps serving it', () => {
    expect(chooseDisplayableImage([derivativeCover])?.id).toBe('cover-1');
  });
});

// ---------------------------------------------------------------------------
// The repair sweep: a clean original means NO inpainting spend at all
// ---------------------------------------------------------------------------

describe('the sanitization sweep does not repair what a clean original already answers', () => {
  const convictedRow = {
    id: 'image-1', stock_item_id: 'item-1', organisation_id: ORG,
    upload_id: 'upload-1', source_reference: 'cover',
    source_stage: 'uploaded_document', verification_status: 'source_supplied',
    processing_status: 'ready', storage_bucket: 'builder-stock-images',
    storage_path: 'org-a/item-1/cover.png',
    source_detail: {
      role: 'primary_property', role_evidence_level: 3,
      stored_sha256: 'c'.repeat(64), source_sha256: 'c'.repeat(64),
      provenance_version: PROVENANCE_VERSION,
      ...ANNOTATED_VERDICT,
    } as Record<string, unknown>,
  };
  const cleanRow = {
    id: 'image-2', stock_item_id: 'item-1', organisation_id: ORG,
    upload_id: 'upload-1', source_reference: 'package',
    source_stage: 'uploaded_document', verification_status: 'source_supplied',
    processing_status: 'ready', storage_bucket: 'builder-stock-images',
    storage_path: 'org-a/item-1/package.jpg',
    source_detail: {
      role: 'primary_property', role_evidence_level: 2,
      provenance_version: PROVENANCE_VERSION,
      ...CLEAN_VERDICT,
    } as Record<string, unknown>,
  };

  it('skips the convicted cover entirely while the clean image serves', async () => {
    const db = fakeDb({ images: [structuredClone(convictedRow), structuredClone(cleanRow)] });
    let repairs = 0;
    const outcome = await settleImageSanitization(db, ORG, {
      budget: newRepairBudget(),
      sanitize: async () => {
        repairs += 1;
        throw new Error('no repair may run while a clean original serves');
      },
    });
    expect(repairs).toBe(0);
    expect(outcome.outstanding).toBe(0);
    expect(outcome.incomplete).toBe(false);
  });

  it('and the same cover IS outstanding the moment no clean image stands', async () => {
    const db = fakeDb({ images: [structuredClone(convictedRow)] });
    const outcome = await settleImageSanitization(db, ORG, {
      budget: newRepairBudget(),
      sanitize: async () => ({
        ok: false as const, reason: 'too_much_to_rebuild' as const,
        transformation: 'deterministic_overlay_reconstruction' as const,
        model: null, detail: 'refused by the gates',
      }),
    });
    expect(outcome.outstanding).toBe(1);
  });
});
