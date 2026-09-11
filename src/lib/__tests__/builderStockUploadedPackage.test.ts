/**
 * Builder stock — when the stock list IS the brochure.
 *
 * MEASURED 11 SEPTEMBER 2026. A builder uploaded
 * `Lot 1037 Wollert Rise - VANTA 20 - V002.pdf` (10,239,959 bytes), the
 * importer built one property from it, the extractor pulled two page-1
 * rasters out of it and stored them — and the Stock List told them:
 *
 *     "No brochure on this row"
 *     "This stock list attaches no brochure or plan to this property."
 *
 * So they uploaded it again. The second file was byte-identical to the first
 * (`sha256 be95c902…`, same 10,239,959 bytes), so nothing could change, and
 * the page said the same thing.
 *
 * THE COUNT ASKED THE WRONG RECORD. `source_documents` comes from
 * `rowSourceBranches(row.source_row.unmapped)` — the LINKS a spreadsheet row
 * carries in its cells. A stock list uploaded as a package PDF carries none:
 * `unmapped` is `{}`. Zero links was read as zero documents, and the one
 * statement on the page that is supposed to be the builder's to act on was
 * false.
 *
 * AND THE SAME BLINDNESS HID THE REASON. `stockDocumentNotes` reads branch
 * records, and branches exist only for links. The election's actual finding —
 * "no page states this property's identity together with its package
 * information" — sits on the image rows as `selection_reason` and reached no
 * screen. The row is `Lot 1037 Fuchsia Street`, taken from the file's NAME,
 * while the document's own cover states a different lot. One sentence turns
 * that into a thirty-second correction instead of a re-upload.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_STOCK_DOCUMENT_NOTES, stockImageProgress, stockPackageDocuments,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  assignPdfMediaRoles,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

const ENDPOINT = readFileSync(join(process.cwd(),
  'supabase/functions/builder-portal-stock/index.ts'), 'utf8');

const PACKAGE = 'Lot 1037 Wollert Rise - VANTA 20 - V002.pdf';
const REFUSAL =
  "no page states this property's identity together with its package information";

/** An image as production stored it, out of the uploaded package. */
const fromPackage = (over: Record<string, unknown> = {}) => ({
  id: 'img',
  processing_status: 'ready',
  source_detail: {
    page: 1,
    role: 'unknown',
    role_evidence: 'none',
    origin: 'document_media',
    method: 'embedded_raster',
    filename: PACKAGE,
    structural: true,
    source_width: 1280,
    source_height: 720,
    selection_reason: REFUSAL,
    provenance_version: 23,
    ...over,
  },
});

/** The ladder's own marker rows: a stage ran and stored nothing. */
const ladderMarker = () => ({
  id: 'marker', processing_status: 'unavailable', source_detail: null,
});

describe('a property built out of an uploaded package HAS a document', () => {
  it('counts the package its own images came out of', () => {
    const images = [fromPackage(), fromPackage({ source_width: 1819, source_height: 1223 })];
    expect(stockPackageDocuments(images).documents).toEqual([PACKAGE]);
  });

  it('counts it ONCE however many images came out of it', () => {
    const images = Array.from({ length: 6 }, () => fromPackage());
    expect(stockPackageDocuments(images).documents).toHaveLength(1);
  });

  it('so the page stops saying the stock list attaches nothing', () => {
    // The exact production reading: settled, no picture, no linked documents,
    // one uploaded package. `no_document` is the state that was false.
    const packages = stockPackageDocuments([fromPackage(), fromPackage()]);
    expect(stockImageProgress({
      hasImage: false,
      workStage: 'settled',
      sourceDocuments: 0 + packages.documents.length,
    })).not.toBe('no_document');
  });

  it('and still says so where there genuinely is no document', () => {
    expect(stockPackageDocuments([]).documents).toEqual([]);
    expect(stockImageProgress({
      hasImage: false, workStage: 'settled', sourceDocuments: 0,
    })).toBe('no_document');
  });
});

describe('what the document said reaches the builder', () => {
  it('surfaces the election’s recorded reason, naming the file', () => {
    const [note, ...rest] = stockPackageDocuments([fromPackage(), fromPackage()]).notes;
    expect(rest).toHaveLength(0);
    expect(note.document).toBe(PACKAGE);
    expect(note.detail).toContain(REFUSAL);
  });

  it('says nothing about a document that DID name a picture', () => {
    const images = [
      fromPackage({ role: 'primary_property', role_evidence: 'cover' }),
      fromPackage({ role: 'floorplan' }),
    ];
    const result = stockPackageDocuments(images);
    // Still a document the property has — just not a complaint.
    expect(result.documents).toEqual([PACKAGE]);
    expect(result.notes).toEqual([]);
  });

  it('never invents one where the election recorded no reason', () => {
    expect(stockPackageDocuments([fromPackage({ selection_reason: '' })]).notes).toEqual([]);
  });

  it('never surfaces a mechanism, asserted rather than trusted', () => {
    const forbidden = [
      /crash/i, /memory/i, /\bCPU\b/i, /timed? ?out/i, /timeout/i, /worker/i,
      /isolate/i, /retry|retries|attempt/i, /\b\d+ ?MB\b/i, /exception/i, /5\d\d\b/,
    ];
    for (const note of stockPackageDocuments([fromPackage()]).notes) {
      for (const pattern of forbidden) {
        expect(note.detail, `detail must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('is bounded, because this lands in a status line', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      fromPackage({ filename: `Package ${i}.pdf` }));
    expect(stockPackageDocuments(many).notes.length).toBeLessThanOrEqual(MAX_STOCK_DOCUMENT_NOTES);
    expect(stockPackageDocuments(many, 2).notes).toHaveLength(2);
    expect(stockPackageDocuments(many, 0).notes).toEqual([]);
  });
});

describe('the refusal names what the document actually is', () => {
  /*
   * The half that makes it a thirty-second correction rather than another
   * upload. Without it the builder is told their document states no identity
   * and has no way to learn WHOSE identity it states instead.
   */
  const PAGE_ONE = [
    'Build Land Lot Size',
    'FULL TURNKEY INCLUSIONS',
    'NEX 20',
    '$927,340 *',
    'PACKAGE PRICELot 1307 Fuchsia Street,',
    'Wollert (Wollert Rise)',
  ].join('\n');

  it('quotes the cover on the refusal an uploaded package records', () => {
    const refusal = assignPdfMediaRoles({
      label: 'Lot 1037 Fuchsia Street',
      pageTexts: [PAGE_ONE],
      pageOrderAuthoritative: true,
      media: [{ name: 'Im2', page: 1, pagesDrawnOn: [1], pageAreaShare: 0.48 }],
    } as never)[0];
    expect(refusal.reason).toContain('no page states this property');
    // The line that tells them the row says 1037 and the document says 1307.
    expect(refusal.reason).toContain('Lot 1307 Fuchsia Street');
  });

  it('says only what it refused where there is nothing to quote', () => {
    const refusal = assignPdfMediaRoles({
      label: 'Lot 1037 Fuchsia Street',
      pageTexts: ['   '],
      pageOrderAuthoritative: true,
      media: [{ name: 'Im2', page: 1, pagesDrawnOn: [1], pageAreaShare: 0.48 }],
    } as never)[0];
    expect(refusal.reason).not.toContain('first page reads');
  });

  it('is the SAME quote the linked-document path uses', () => {
    // Two implementations of "what does the cover say" is how two screens come
    // to quote different things about one file.
    const election = readFileSync(join(process.cwd(),
      'supabase/functions/_shared/builderStock/pdfElection.ts'), 'utf8');
    expect(election).toContain("export { coverIdentityQuote } from './pdfPrimaryImage.pure.ts'");
    expect(election).not.toMatch(/export function coverIdentityQuote/);
  });
});

describe('what is NOT a package document', () => {
  it('ignores the ladder’s own marker rows', () => {
    // Four of the six rows on the live property are these: a stage ran, stored
    // nothing, and left a row saying so. They name no document.
    expect(stockPackageDocuments([ladderMarker(), ladderMarker()]))
      .toEqual({ documents: [], notes: [] });
  });

  it('ignores anything that did not come out of a document', () => {
    const web = { id: 'w', source_detail: { origin: 'web_search', filename: 'x.jpg' } };
    expect(stockPackageDocuments([web]).documents).toEqual([]);
  });

  it('survives anything at all in that column', () => {
    for (const junk of [null, undefined, 'nope', 7, {}, [null], [{ source_detail: 'x' }]]) {
      expect(stockPackageDocuments(junk)).toEqual({ documents: [], notes: [] });
    }
  });
});

describe('the projection asks both questions', () => {
  it('falls back to the package only where the row attaches no link', () => {
    /*
     * EITHER/OR, NEVER A SUM. A row that DOES carry links had its images
     * extracted from those links, so adding the package reading would count
     * one brochure twice. The package count answers only the case the link
     * count cannot see.
     */
    expect(ENDPOINT).toContain("source_documents: (documentsByItem.get(String(item.id)) ?? 0)");
    expect(ENDPOINT).toContain('|| (packagesByItem.get(String(item.id))?.documents.length ?? 0)');
    expect(ENDPOINT).not.toContain('+ (packagesByItem.get(String(item.id))?.documents.length');
  });

  it('carries both kinds of note, still bounded', () => {
    expect(ENDPOINT).toContain('...(packagesByItem.get(String(item.id))?.notes ?? [])');
    expect(ENDPOINT).toContain('].slice(0, MAX_STOCK_DOCUMENT_NOTES)');
  });
});
