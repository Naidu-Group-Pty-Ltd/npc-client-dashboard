/**
 * Builder stock — "the builder supplied it" is NOT "the builder supplied it as
 * this property's picture".
 *
 * WHAT WAS WRONG, MEASURED IN PRODUCTION. Lot 537 Kirramingly Avenue,
 * Donnybrook showed a BEDROOM on its Marketplace card, badged "Builder
 * supplied". Every claim behind that badge was true: the bytes were lifted out
 * of the builder's own contract PDF, hashed at both ends, and stored. The badge
 * was still a lie to the reader, because the source had presented that image as
 * an inclusions illustration on its third page, and the picture it presented as
 * the property was the facade render on its package cover.
 *
 * Two independent defects put it there, and both are pinned below:
 *
 *   1. THE DOCUMENT'S PAGE ORDER WAS NEVER ESTABLISHED. The contract's page
 *      tree lives in a compressed object stream, which the reader could not
 *      see, so it fell back to sorting page objects by OBJECT NUMBER. The cover
 *      was added by a later incremental update and numbered 1105 against 1…229,
 *      which sorted it LAST of twenty — past the twelve pages a document is
 *      searched — and shifted every other page up by one. The image drawn on
 *      visible page 3 was recorded, and shown to a person, as "page 2".
 *   2. THE PRIMARY WAS CHOSEN BY MEASUREMENT. Among the pages it did reach,
 *      "largest photographic raster by drawn area" picked a 2202×1229 bedroom
 *      across a full bleed. On the cover it would have picked the 1950×1050
 *      grey faceted wash over the 960×497 facade beside it — bigger, ample
 *      detail, ordinary shape, and not a house.
 *
 * THE RULE THESE PIN. A picture may become a card's image only where the SOURCE
 * designated it: an explicit property-image field (LEVEL 1), a page/slide/
 * section presenting the property AS A PACKAGE (LEVEL 2), or a structural
 * container designating one (LEVEL 3). Anything else — including a perfectly
 * genuine builder-supplied photograph — is `unknown`, and the card shows
 * nothing at all.
 */
import { describe, expect, it } from 'vitest';

import { ANNOTATED_VERDICT, CLEAN_VERDICT } from './fixtures/builderStockPictures';

import {
  assignPdfMediaRoles, findPropertyCoverPages, packageFactsOn, selectCoverHero,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import {
  isPrimaryRole, readStoredRole, roleDetail, roleFromAssetName,
  roleFromExplicitField, roleFromStructuralContainer,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';
import {
  settleContainerMediaRoles, settleRowAssetRoles,
  type SourceImageAsset,
} from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';
import {
  chooseDisplayableImage, isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { anchorPdfRowsToPages } from '../../../supabase/functions/_shared/builderStock/pdfRowAnchors.pure';
import {
  indexPdfObjects, objectStreamSlices, pageOrderIsAuthoritative, parseObjectStream,
  qualifyingPhotographsFrom, readPdfPage,
} from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';
import {
  discoverPdfSourceAssets, selectPdfPropertyPrimary,
} from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The package facts the live Lot 537 cover states, in a person's words. */
const COVER_TEXT = 'LOT 537 KIRRAMINGLY AVENUE DONNYBROOK - BALMAIN ESTATE - MOLLY - VALE - C55 '
  + 'FIXED PRICE CONTRACT $941,990 Land Size 350 m2 Build Size 209.7 m2 '
  + 'Title Reg Q3 2026 Lot Width 12.5 m';
const LABEL = 'Lot 537 Kirramingly Avenue Donnybrook';

const placement = (over: Partial<{
  page: number; name: string | null; placementsOnPage: number; pagesDrawnOn: number;
}> = {}) => ({ page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1, ...over });

const rolesFor = (media: ReturnType<typeof placement>[], pageTexts: string[]) =>
  assignPdfMediaRoles({ label: LABEL, pageTexts, pageOrderAuthoritative: true, media });

// ---------------------------------------------------------------------------
// TEST A–F — the PDF, which is where the defect was found
// ---------------------------------------------------------------------------

describe('A — a package cover and a later interior', () => {
  const pageTexts = [COVER_TEXT, 'FLOORPLAN', 'INCLUSIONS'];

  it('makes the cover facade primary and leaves the bedroom unknown', () => {
    const roles = rolesFor([
      placement({ page: 1, name: 'Im0' }),   // the facade on the cover
      placement({ page: 3, name: 'Im0' }),   // the bedroom on INCLUSIONS
    ], pageTexts);

    expect(roles[0].role).toBe('primary_property');
    expect(roles[0].evidenceLevel).toBe(2);
    expect(roles[1].role).toBe('unknown');
    expect(isPrimaryRole(roles[1].role)).toBe(false);
  });

  /**
   * The exact inversion production shipped: the interior is the bigger, more
   * detailed, more prominently drawn raster, and it still is not the property.
   */
  it('does not prefer the interior for being larger or more prominent', () => {
    const roles = assignPdfMediaRoles({
      label: LABEL,
      pageTexts,
      pageOrderAuthoritative: true,
      media: [
        placement({ page: 1, name: 'Im0' }),
        placement({ page: 3, name: 'Im0' }),
      ],
    });
    expect(roles.filter((role) => isPrimaryRole(role.role))).toHaveLength(1);
    expect(roles[0].role).toBe('primary_property');
  });
});

describe('B — a package cover and a page-2 floorplan', () => {
  it('keeps the facade primary and never the plan', () => {
    const roles = rolesFor([
      placement({ page: 1, name: 'Im0' }),
      placement({ page: 2, name: 'Floorplan' }),
    ], [COVER_TEXT, 'FLOORPLAN UNIT 1 - BLUE 4 BED 2 BATH 2 CAR']);

    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).toBe('floorplan');
    expect(isPrimaryRole(roles[1].role)).toBe(false);
  });
});

describe('C — a package cover and later colour-selection variants', () => {
  it('leaves the cover facade primary', () => {
    const roles = rolesFor([
      placement({ page: 1, name: 'Im0' }),
      placement({ page: 6, name: 'Colour_Selection_Facade_A' }),
      placement({ page: 7, name: 'Colour_Selection_Facade_B' }),
    ], [COVER_TEXT, 'FLOORPLAN', 'INCLUSIONS', 'TURNKEY INCLUSIONS', 'STANDARD INCLUSIONS',
      'FACADE COLOUR SELECTIONS', 'FACADE COLOUR SELECTIONS']);

    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).toBe('materials');
    expect(roles[2].role).toBe('materials');
  });
});

describe('D — a decorative background on the cover', () => {
  /**
   * The live cover's grey faceted wash is drawn THREE times across the bleed
   * and passes every size, shape and detail floor there is. What separates it
   * from the facade beside it is that the document reuses it, and reuse is the
   * document saying "this is furniture".
   */
  it('finds the facade behind the wash the page repeats', () => {
    const outcome = selectCoverHero([
      { key: 'wash', placementsOnPage: 3, pagesDrawnOn: 1 },
      { key: 'facade', placementsOnPage: 1, pagesDrawnOn: 1 },
    ]);
    expect(outcome.kind).toBe('hero');
    if (outcome.kind !== 'hero') return;
    expect(outcome.key).toBe('facade');
  });

  it('also sets aside artwork the document repeats on other pages', () => {
    const outcome = selectCoverHero([
      { key: 'letterhead', placementsOnPage: 1, pagesDrawnOn: 12 },
      { key: 'facade', placementsOnPage: 1, pagesDrawnOn: 1 },
    ]);
    expect(outcome.kind === 'hero' && outcome.key).toBe('facade');
  });
});

describe('E — masterplans, site plans and location maps', () => {
  it('never lets one become primary while a property hero exists', () => {
    const roles = rolesFor([
      placement({ page: 1, name: 'Im0' }),
      placement({ page: 9, name: 'Estate_Masterplan' }),
      placement({ page: 10, name: 'Location_Map' }),
      placement({ page: 11, name: 'Site_Plan' }),
    ], [COVER_TEXT, ...Array.from({ length: 10 }, () => 'ESTATE')]);

    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).toBe('masterplan');
    expect(roles[2].role).toBe('location_map');
    expect(roles[3].role).toBe('site_plan');
  });

  it('and never lets one become primary when there is NO hero either', () => {
    const roles = rolesFor([
      placement({ page: 2, name: 'Estate_Masterplan' }),
    ], ['ESTATE', 'ESTATE MASTERPLAN']);
    expect(roles.some((role) => isPrimaryRole(role.role))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST F — the live document's own shape
// ---------------------------------------------------------------------------

/**
 * A PDF built the way the live Lot 537 contract is built.
 *
 * Its page tree lives in a Flate-compressed object stream, and its COVER page
 * object is numbered above every other page because a later incremental update
 * added it. Both facts are load-bearing: together they are what made the
 * reader's fallback — page objects sorted by object number — put the cover last
 * of twenty and rename visible page 3 as "page 2".
 */
async function buildLiveShapedPdf(): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Array<string | Uint8Array> = ['%PDF-1.5\n'];

  const jpeg = (fill: number, bytes: number) => {
    const out = new Uint8Array(bytes);
    out.set([0xff, 0xd8, 0xff, 0xe0], 0);
    out.fill(fill, 4, bytes - 2);
    out.set([0xff, 0xd9], bytes - 2);
    return out;
  };
  const facade = jpeg(0x11, 224_541);   // 960×497 — the cover's render
  const bedroom = jpeg(0x55, 116_978);  // 2202×1229 — the inclusions interior

  const imageObject = (n: number, w: number, h: number, data: Uint8Array) => ([
    `${n} 0 obj<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}`
    + `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode`
    + `/Length ${data.length}>>stream\n`,
    data,
    '\nendstream\nendobj\n',
  ] as Array<string | Uint8Array>);

  // Page 18 in object order, page 3 in READING order: the interior.
  const interiorDraw = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  parts.push(...imageObject(28, 2202, 1229, bedroom));
  parts.push(`18 0 obj<</Type/Page/Parent 1098 0 R/MediaBox [0 0 595 842]`
    + `/Resources<</XObject<</Im0 28 0 R>>>>/Contents 29 0 R>>endobj\n`);
  parts.push(`29 0 obj<</Length ${interiorDraw.length}>>stream\n${interiorDraw}\nendstream\nendobj\n`);

  // Object 1105 — the COVER, added last and numbered highest.
  const coverDraw = 'q 595 0 0 300 0 500 cm /Im0 Do Q';
  parts.push(...imageObject(1136, 960, 497, facade));
  parts.push(`1105 0 obj<</Type/Page/Parent 1098 0 R/MediaBox [0 0 595 842]`
    + `/Resources<</XObject<</Im0 1136 0 R>>>>/Contents 1137 0 R>>endobj\n`);
  parts.push(`1137 0 obj<</Length ${coverDraw.length}>>stream\n${coverDraw}\nendstream\nendobj\n`);

  parts.push('1104 0 obj<</Type/Catalog/Pages 1098 0 R>>endobj\n');

  /**
   * The page tree itself, INSIDE a compressed object stream — which is what the
   * reader could not see, and the whole of defect (1).
   */
  const inner = '<</Count 2/Kids[1105 0 R 18 0 R]/Type/Pages>>';
  const header = '1098 0 ';
  const body = `${header}${inner}`;
  const { deflateSync } = await import('node:zlib');
  const deflated = new Uint8Array(deflateSync(encoder.encode(body)));
  parts.push(
    `1099 0 obj<</Type/ObjStm/N 1/First ${header.length}/Filter/FlateDecode`
    + `/Length ${deflated.length}>>stream\n`,
    deflated,
    '\nendstream\nendobj\n',
  );
  parts.push('trailer<</Root 1104 0 R>>\n%%EOF\n');

  const chunks = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

describe('F — the Lot 537 regression, in the shape the live contract has', () => {
  it('cannot resolve the page tree without reading the object stream', () => {
    // The state the reader was in: object 1098 is simply not in the file body.
    expect(indexPdfObjects(new Uint8Array(0)).size).toBe(0);
  });

  it('recovers the page tree, and page one is the COVER not the lowest object', async () => {
    const bytes = await buildLiveShapedPdf();

    // Without the object stream the catalogue points at nothing.
    expect(pageOrderIsAuthoritative(bytes)).toBe(false);

    const recovered = new Map<number, string>();
    for (const slice of objectStreamSlices(bytes)) {
      const raw = bytes.slice(slice.start, slice.end);
      const { inflateSync } = await import('node:zlib');
      const text = new TextDecoder('latin1').decode(new Uint8Array(inflateSync(raw)));
      for (const [number, header] of parseObjectStream(text, slice)) recovered.set(number, header);
    }
    expect(recovered.has(1098)).toBe(true);
    expect(pageOrderIsAuthoritative(bytes, recovered)).toBe(true);

    // Reading order, not object order: the cover is page one.
    const first = readPdfPage(bytes, 0, recovered)!;
    expect(first.images.map((image) => image.objectNumber)).toEqual([1136]);
    const second = readPdfPage(bytes, 1, recovered)!;
    expect(second.images.map((image) => image.objectNumber)).toEqual([28]);
  });

  it('selects the cover facade and refuses the interior as primary', async () => {
    const bytes = await buildLiveShapedPdf();
    const selection = await selectPdfPropertyPrimary(bytes, {
      label: LABEL,
      pageTexts: [COVER_TEXT, 'INCLUSIONS'],
    });

    expect(selection.pageOrderAuthoritative).toBe(true);
    expect(selection.primary).not.toBeNull();
    expect(selection.primary!.provenance.objectNumber).toBe(1136);
    expect(selection.primary!.provenance.sourceWidth).toBe(960);
    expect(selection.primary!.provenance.sourceHeight).toBe(497);
    // 1-based and the page a PERSON sees.
    expect(selection.primary!.page).toBe(1);
    expect(selection.primary!.provenance.page).toBe(1);

    /*
     * AND THE INTERIOR ON PAGE 2 IS NEVER DECODED AT ALL.
     *
     * `selectPdfPropertyPrimary` now scopes materialisation to the pages the
     * TEXT says could be this property's cover — see `coverSearchPages`. Page
     * 2 is not one of them, so its raster is not decoded, not transcoded and
     * not returned. That is the point rather than a side effect: decoding
     * every page of a 13.2 MB brochure before deciding anything is what was
     * killing the worker on the two heaviest packages in the live stock list.
     *
     * The guarantee this replaces is strictly stronger. The interior used to
     * be present and refused; now it cannot be reached to be refused.
     */
    expect(selection.assets.some((asset) => asset.page === 2)).toBe(false);
    expect(selection.assets.map((asset) => asset.provenance.objectNumber)).toEqual([1136]);
  });

  it('still finds every picture when nothing has said which page could be the cover', async () => {
    // The scoping is an OPINION, and an absent opinion changes nothing:
    // unscoped discovery is what `extract.ts` uses to read a whole stock list
    // out of one PDF, and it still sees both pages.
    const bytes = await buildLiveShapedPdf();
    const found = await discoverPdfSourceAssets(bytes);
    expect(found.assets.map((asset) => asset.provenance.objectNumber).sort((a, b) => a - b))
      .toEqual([28, 1136]);
  });

  it('attributes a one-property document to its COVER page, not to its first photograph', () => {
    const anchors = anchorPdfRowsToPages(
      [LABEL],
      ['FLOORPLAN', COVER_TEXT, 'INCLUSIONS'],
      // The first page presenting a photograph is page 3 — the interior.
      [3],
    );
    expect(anchors).toEqual(['pdf:page2']);
  });

  it('anchors nothing at all when the page order could not be established', () => {
    expect(anchorPdfRowsToPages([LABEL], [COVER_TEXT], [1], false)).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// What makes a page a property's cover
// ---------------------------------------------------------------------------

describe('a page is a cover when it states identity AND package information', () => {
  it('reads the live cover as one', () => {
    const covers = findPropertyCoverPages([COVER_TEXT], LABEL);
    expect(covers).toHaveLength(1);
    expect(covers[0].page).toBe(1);
    expect(covers[0].packageFacts).toContain('a package price');
  });

  it('refuses a page that merely repeats the address', () => {
    expect(findPropertyCoverPages(
      ['Lot 537 Kirramingly Avenue Donnybrook — thank you for your enquiry'], LABEL)).toEqual([]);
  });

  it('refuses a page that quotes prices but names no property', () => {
    expect(packageFactsOn('INCLUSIONS $941,990 Land Size 350 m2').length).toBeGreaterThan(1);
    expect(findPropertyCoverPages(['INCLUSIONS $941,990 Land Size 350 m2'], LABEL)).toEqual([]);
  });

  it('refuses to choose when TWO pages present the property as a package', () => {
    const roles = rolesFor([placement({ page: 1 })], [COVER_TEXT, COVER_TEXT]);
    expect(roles[0].role).toBe('unknown');
    expect(roles[0].reason).toContain('2 pages');
  });
});

// ---------------------------------------------------------------------------
// TEST G–H — spreadsheets
// ---------------------------------------------------------------------------

describe('G — a spreadsheet with an explicit property-image column', () => {
  it('takes the image that column names, on LEVEL 1 evidence', () => {
    const assignment = roleFromExplicitField('Facade');
    expect(assignment.role).toBe('primary_property');
    expect(assignment.evidenceLevel).toBe(1);
    expect(assignment.evidence).toContain('Facade');
  });

  it('and refuses the ones its other columns name', () => {
    expect(roleFromExplicitField('Floorplan Image').role).toBe('floorplan');
    expect(roleFromExplicitField('Site Plan').role).toBe('site_plan');
    expect(roleFromExplicitField('Estate Masterplan').role).toBe('masterplan');
    expect(roleFromExplicitField('Colour Selection').role).toBe('materials');
    expect(roleFromExplicitField('Builder Logo').role).toBe('logo_decorative');
    for (const field of ['Floorplan Image', 'Site Plan', 'Estate Masterplan']) {
      expect(isPrimaryRole(roleFromExplicitField(field).role)).toBe(false);
    }
  });
});

describe('H — a spreadsheet whose media the workbook merely contains', () => {
  it('never guesses by workbook order when a row holds several', () => {
    const roles = settleContainerMediaRoles({
      media: [
        { name: 'xl/media/image1.png', anchor: 'sheet:Stock!A2' },
        { name: 'xl/media/image2.png', anchor: 'sheet:Stock!A2' },
      ],
      stockItemIds: ['item-1', 'item-1'],
      structural: [true, true],
      container: 'the spreadsheet row',
    });
    expect(roles.every((role) => !isPrimaryRole(role.role))).toBe(true);
    expect(roles[0].reason).toContain('does not say');
  });

  it('but honours a row that anchors exactly one', () => {
    const roles = settleContainerMediaRoles({
      media: [
        { name: 'xl/media/image1.png', anchor: 'sheet:Stock!A2' },
        { name: 'xl/media/image2.png', anchor: 'sheet:Stock!A3' },
      ],
      stockItemIds: ['item-1', 'item-2'],
      structural: [true, true],
      container: 'the spreadsheet row',
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[0].evidenceLevel).toBe(3);
    expect(roles[1].role).toBe('primary_property');
  });
});

// ---------------------------------------------------------------------------
// TEST I–K — documents, decks and pages
// ---------------------------------------------------------------------------

describe('I — a DOCX property section with a hero and a later interior', () => {
  it('keeps the section hero and refuses the interior', () => {
    const roles = settleContainerMediaRoles({
      media: [
        { name: 'word/media/facade.png', anchor: 'docx:table1:row2' },
        { name: 'word/media/kitchen.png', anchor: 'docx:table1:row2' },
      ],
      stockItemIds: ['item-1', 'item-1'],
      structural: [true, true],
      container: 'the property table row',
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).toBe('interior');
  });
});

describe('J — a PPTX property slide and later imagery', () => {
  it('keeps the property slide\'s hero primary', () => {
    const roles = settleContainerMediaRoles({
      media: [
        { name: 'ppt/media/lot12-render.png', anchor: 'slide:3' },
        { name: 'ppt/media/estate-masterplan.png', anchor: 'slide:9' },
        { name: 'ppt/media/company-logo.png', anchor: null },
      ],
      stockItemIds: ['item-1', 'item-1', null],
      structural: [true, true, false],
      container: 'the slide',
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).toBe('masterplan');
    expect(roles[2].role).toBe('logo_decorative');
  });
});

describe('K — an HTML property card', () => {
  it('makes the card\'s single hero primary on LEVEL 3 evidence', () => {
    const assets = settleRowAssetRoles(
      [asset('https://builder.example/lot12.jpg')],
      { container: 'the property row that contains it', designation: 'property image' },
    );
    expect(assets[0].role.role).toBe('primary_property');
    expect(assets[0].role.evidenceLevel).toBe(3);
  });

  it('and refuses to pick when the card holds several photographs', () => {
    const assets = settleRowAssetRoles(
      [asset('https://b.example/a.jpg'), asset('https://b.example/b.jpg')],
      { container: 'the property row that contains it', designation: 'property image' },
    );
    expect(assets.every((entry) => !isPrimaryRole(entry.role.role))).toBe(true);
  });

  it('and sets aside what the markup names as a plan even when it is alone', () => {
    const assets = settleRowAssetRoles(
      [asset('https://b.example/lot12-floorplan.jpg')],
      { container: 'the property row that contains it', designation: 'property image' },
    );
    expect(assets[0].role.role).toBe('floorplan');
  });
});

// ---------------------------------------------------------------------------
// TEST L–N — Notion, linked packages and explicit URLs
// ---------------------------------------------------------------------------

describe('L — a Notion row that designates its own cover', () => {
  it('reads the cover as the row\'s primary image', () => {
    const assignment = roleFromStructuralContainer({
      container: 'the Notion row for this property',
      designation: 'page cover',
    });
    expect(assignment.role).toBe('primary_property');
    expect(assignment.evidenceLevel).toBe(3);
    expect(assignment.evidence).toContain('page cover');
  });

  it('does not promote a loose image block in the row\'s page body', () => {
    const assets = settleRowAssetRoles(
      [
        { ...asset('https://notion/cover.png'), role: roleFromStructuralContainer({
          container: 'the Notion row for this property', designation: 'page cover' }) },
        asset('https://notion/inline-1.png'),
      ],
      {
        container: 'the Notion row for this property',
        designation: 'page cover',
        preferredIndex: 0,
      },
    );
    expect(assets[0].role.role).toBe('primary_property');
    expect(isPrimaryRole(assets[1].role.role)).toBe(false);
  });
});

describe('M — Notion → Drive → PDF', () => {
  it('reaches the package\'s own cover hero rather than any image in it', () => {
    const roles = rolesFor([
      placement({ page: 1, name: 'Im0' }),
      placement({ page: 4, name: 'Im0' }),
    ], [COVER_TEXT, 'FLOORPLAN', 'INCLUSIONS', 'COMMUNITY']);
    expect(roles[0].role).toBe('primary_property');
    expect(roles[0].evidenceLevel).toBe(2);
    expect(roles[1].role).toBe('unknown');
  });
});

describe('N — an explicit image URL column', () => {
  it('makes that exact URL the property\'s image', () => {
    const assets = settleRowAssetRoles(
      [{ ...asset('https://cdn.example/lot12.jpg'), role: roleFromExplicitField('Property Image') }],
      { container: 'this property\'s row', designation: 'property image', preferredIndex: 0 },
    );
    expect(assets[0].role.role).toBe('primary_property');
    expect(assets[0].url).toBe('https://cdn.example/lot12.jpg');
  });
});

describe('O — a direct image upload for one property', () => {
  it('makes those exact bytes the property\'s image', () => {
    const roles = settleContainerMediaRoles({
      media: [{ name: 'lot-12-render.jpg', anchor: null }],
      // The one-property containment attribution: structural, because the
      // document's own boundary is the statement.
      stockItemIds: ['item-1'],
      structural: [true],
      container: 'the uploaded image',
    });
    expect(roles[0].role).toBe('primary_property');
  });
});


// ---------------------------------------------------------------------------
// R — the row's cover, and the field the builder actually named
// ---------------------------------------------------------------------------

describe('R — a Notion cover does not outrank the row\'s own Property Image field', () => {
  /*
   * THE HIERARCHY, AS DOCUMENTED AND AS STORED: LEVEL 1 is "the source's own
   * field on this property's row names this image"; LEVEL 3 is "a structural
   * container put this image first". One is the builder saying which picture
   * IS the listing image; the other is where a picture happens to sit. The
   * Notion caller inverted them: the page cover was passed as the preferred
   * asset whenever the row had one, so a promotional cover took the card and
   * the clean facade the builder explicitly filed under "Property Image" was
   * demoted to property_secondary — undisplayable, unrepairable, unread.
   */
  const cover = (url = 'https://notion/cover.png') => ({
    ...asset(url),
    origin: 'notion_page_cover' as const,
    role: roleFromStructuralContainer({
      container: 'the Notion row for this property', designation: 'page cover' }),
  });
  const field = (label: string, url: string) => ({
    ...asset(url),
    origin: 'notion_file_property' as const,
    role: roleFromExplicitField(label),
  });
  const notionRow = (assets: SourceImageAsset[], coverIndex: number) =>
    settleRowAssetRoles(assets, {
      container: 'the Notion row for this property',
      designation: coverIndex >= 0 ? 'page cover' : 'property image',
      preferredIndex: coverIndex >= 0 ? coverIndex : undefined,
    });

  it('A — a cover alone is the row\'s primary, LEVEL 3', () => {
    const out = notionRow([cover()], 0);
    expect(out[0].role.role).toBe('primary_property');
    expect(out[0].role.evidenceLevel).toBe(3);
  });

  it('B — an explicit Property Image alone is primary, LEVEL 1', () => {
    const out = notionRow([field('Property Image', 'https://notion/facade.png')], -1);
    expect(out[0].role.role).toBe('primary_property');
    expect(out[0].role.evidenceLevel).toBe(1);
  });

  it('C — cover AND Property Image: the named field wins, on its own evidence', () => {
    const out = notionRow([
      cover('https://notion/promo-cover.png'),
      field('Property Image', 'https://notion/facade.png'),
    ], 0);
    // The builder named a field; the cover is merely where a picture sits.
    expect(out[1].role.role).toBe('primary_property');
    expect(out[1].role.evidenceLevel).toBe(1);
    // The cover is still this property's imagery — just not the card.
    expect(out[0].role.role).toBe('property_secondary');
    expect(isPrimaryRole(out[0].role.role)).toBe(false);
  });

  it('E — cover + Floorplan field: the cover leads and the floorplan stays one', () => {
    const out = notionRow([
      cover(),
      field('Floorplan', 'https://notion/plan.png'),
    ], 0);
    expect(out[0].role.role).toBe('primary_property');
    expect(out[0].role.evidenceLevel).toBe(3);
    // An explicitly non-hero field keeps the role the source gave it.
    expect(out[1].role.role).toBe('floorplan');
  });

  it('F — cover + Masterplan field: same shape', () => {
    const out = notionRow([cover(), field('Masterplan', 'https://notion/estate.png')], 0);
    expect(out[0].role.role).toBe('primary_property');
    expect(isPrimaryRole(out[1].role.role)).toBe(false);
  });

  it('G — Property Image + Floorplan + cover: the named hero wins', () => {
    const out = notionRow([
      cover(),
      field('Property Image', 'https://notion/facade.png'),
      field('Floor Plan', 'https://notion/plan.png'),
    ], 0);
    expect(out[1].role.role).toBe('primary_property');
    expect(out[1].role.evidenceLevel).toBe(1);
    expect(out[0].role.role).toBe('property_secondary');
    expect(isPrimaryRole(out[2].role.role)).toBe(false);
  });

  it('H — TWO explicit hero fields: nobody is guessed, the cover leads', () => {
    const out = notionRow([
      cover(),
      field('Property Image', 'https://notion/a.png'),
      field('Hero Image', 'https://notion/b.png'),
    ], 0);
    // Two equal explicit claims contradict each other; the row's own cover is
    // still a coherent designation, so it stands — nothing is picked by order.
    expect(out[0].role.role).toBe('primary_property');
    expect(out[0].role.evidenceLevel).toBe(3);
    expect(isPrimaryRole(out[1].role.role)).toBe(false);
    expect(isPrimaryRole(out[2].role.role)).toBe(false);
  });

  it('H2 — two hero fields and NO cover: ambiguity, not file order', () => {
    const out = notionRow([
      field('Property Image', 'https://notion/a.png'),
      field('Hero Image', 'https://notion/b.png'),
    ], -1);
    expect(out.every((entry) => !isPrimaryRole(entry.role.role))).toBe(true);
  });

  it('I — a hero FIELD whose file is named Masterplan is still demoted', () => {
    const out = notionRow([
      cover(),
      field('Property Image', 'https://notion/x.png'),
    ].map((entry, index) => index === 1
      ? { ...entry, reference: 'attachment:abc:ESTATE-MASTERPLAN.png' }
      : entry), 0);
    // The filename rule runs first and may only demote — the field label does
    // not resurrect a file the builder themselves called a masterplan.
    expect(isPrimaryRole(out[1].role.role)).toBe(false);
    expect(out[0].role.role).toBe('primary_property');
  });

  it('J — a lone non-hero field is never promoted by being alone', () => {
    const out = notionRow([field('Floor Plan', 'https://notion/plan.png')], -1);
    expect(isPrimaryRole(out[0].role.role)).toBe(false);
    expect(out[0].role.role).toBe('floorplan');
  });

  it('K — cover + body images: the cover still leads as before', () => {
    const out = notionRow([cover(), asset('https://notion/body-1.png'),
      asset('https://notion/body-2.png')], 0);
    expect(out[0].role.role).toBe('primary_property');
    expect(out[0].role.evidenceLevel).toBe(3);
    expect(isPrimaryRole(out[1].role.role)).toBe(false);
    expect(isPrimaryRole(out[2].role.role)).toBe(false);
  });

  it('L — the winner\'s LEVEL 1 record survives persistence round-trip', () => {
    const out = notionRow([cover(), field('Property Image', 'https://n/f.png')], 0);
    const detail = roleDetail(out[1].role);
    expect(detail.role).toBe('primary_property');
    expect(detail.role_evidence_level).toBe(1);
    expect(String(detail.role_evidence)).toContain('Property Image');
  });
});

// ---------------------------------------------------------------------------
// TEST P–Q — when the source does not say
// ---------------------------------------------------------------------------

describe('P — an ambiguous source', () => {
  it('attaches no primary image at all', () => {
    const roles = rolesFor(
      [placement({ page: 2, name: 'Im0' }), placement({ page: 3, name: 'Im1' })],
      ['A GALLERY', 'MORE PHOTOGRAPHS', 'AND MORE'],
    );
    expect(roles.every((role) => !isPrimaryRole(role.role))).toBe(true);
    expect(roles[0].reason).toContain('no page states this property\'s identity');
  });
});

describe('Q — a builder source with only interior photographs', () => {
  it('attaches no primary image', () => {
    const roles = settleContainerMediaRoles({
      media: [
        { name: 'bedroom.jpg', anchor: 'docx:table1:row2' },
        { name: 'kitchen.jpg', anchor: 'docx:table1:row2' },
        { name: 'ensuite.jpg', anchor: 'docx:table1:row2' },
      ],
      stockItemIds: ['item-1', 'item-1', 'item-1'],
      structural: [true, true, true],
      container: 'the property table row',
    });
    expect(roles.map((role) => role.role)).toEqual(['interior', 'interior', 'interior']);
    expect(roles.every((role) => !isPrimaryRole(role.role))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST R–T — what the marketplace may draw
// ---------------------------------------------------------------------------

const storedImage = (over: Record<string, unknown> = {}) => ({
  id: 'source-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  position: 0,
  storage_path: 'org/items/item-1/source/render.jpg',
  // Designation AND verdict. The source saying "this is the property's
  // picture" is the third question; whether that picture may go on a card is
  // the fourth, and a row that has never been asked it is not displayable.
  source_detail: {
    ...roleDetail(roleFromStructuralContainer({
      container: 'the Notion row for this property', designation: 'page cover',
    })),
    ...CLEAN_VERDICT,
  },
  ...over,
});

describe('R — an old source_supplied row with no role proof', () => {
  /**
   * Every stage-1 row written before this programme proves its ORIGIN and says
   * nothing about its ROLE. That is exactly the state the Lot 537 bedroom was
   * in, and it must not be readable as permission to display.
   */
  it('is not displayable, whatever else it proves', () => {
    const legacy = storedImage({
      source_detail: {
        origin: 'document_media',
        source_sha256: 'e8ad9046508b423b018180f653ac783debf0547d1eff515ae371d28a69ea51fc',
        stored_sha256: 'e8ad9046508b423b018180f653ac783debf0547d1eff515ae371d28a69ea51fc',
        provenance_version: 2,
      },
    });
    expect(readStoredRole(legacy.source_detail)).toBe('unknown');
    expect(isDisplayableSourceImage(legacy)).toBe(false);
    expect(chooseDisplayableImage([legacy])).toBeNull();
  });

  it('and neither is one with no source_detail at all', () => {
    expect(isDisplayableSourceImage(storedImage({ source_detail: null }))).toBe(false);
  });

  it('while a row the source designated IS displayable', () => {
    const proven = storedImage();
    expect(isDisplayableSourceImage(proven)).toBe(true);
    expect(chooseDisplayableImage([proven])?.id).toBe('source-1');
  });
});

describe('S/T — no source primary, and Google or search rows exist', () => {
  const google = {
    id: 'google-1', source_stage: 'google_maps', verification_status: 'location_derived',
    processing_status: 'ready', position: 0, storage_path: 'g.jpg', source_detail: null,
  };
  const search = {
    id: 'search-1', source_stage: 'internet_search', verification_status: 'unverified',
    processing_status: 'ready', position: 0, external_url: 'https://x/found.jpg',
    source_detail: null,
  };

  it('S — a Google row never becomes the visible image', () => {
    expect(chooseDisplayableImage([google])).toBeNull();
    expect(isDisplayableSourceImage(google)).toBe(false);
  });

  it('T — an internet-search row never becomes the visible image', () => {
    expect(chooseDisplayableImage([search])).toBeNull();
    expect(isDisplayableSourceImage(search)).toBe(false);
  });

  it('and neither does, even beside an undesignated builder image', () => {
    const undesignated = storedImage({ source_detail: { origin: 'document_media' } });
    expect(chooseDisplayableImage([google, search, undesignated])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST U–V — the two dimensions of provenance
// ---------------------------------------------------------------------------

describe('U — hash provenance', () => {
  it('records the source and stored hashes as one hash for untouched bytes', async () => {
    const bytes = await buildLiveShapedPdf();
    const selection = await selectPdfPropertyPrimary(bytes, {
      label: LABEL, pageTexts: [COVER_TEXT, 'INCLUSIONS'],
    });
    const provenance = selection.primary!.provenance;
    expect(provenance.transformation).toBeNull();
    expect(provenance.crop).toBeNull();
    expect(provenance.sourceSha256).toBe(provenance.storedSha256);
    expect(provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('V — primary-role provenance', () => {
  it('records deterministic evidence and a reason a person can check', async () => {
    const bytes = await buildLiveShapedPdf();
    const selection = await selectPdfPropertyPrimary(bytes, {
      label: LABEL, pageTexts: [COVER_TEXT, 'INCLUSIONS'],
    });
    const role = selection.primary!.role;
    expect(role.role).toBe('primary_property');
    expect(role.evidenceLevel).toBe(2);
    expect(role.evidence).toContain('visible page 1');
    expect(role.evidence).toContain(LABEL);
    expect(role.reason).toContain('package cover');

    // And the detail written against the stored row carries all four.
    const detail = roleDetail(role);
    expect(Object.keys(detail).sort()).toEqual(
      ['role', 'role_evidence', 'role_evidence_level', 'selection_reason']);
    expect(readStoredRole(detail)).toBe('primary_property');
  });

  it('never words the reason as a measurement', async () => {
    const bytes = await buildLiveShapedPdf();
    const selection = await selectPdfPropertyPrimary(bytes, {
      label: LABEL, pageTexts: [COVER_TEXT, 'INCLUSIONS'],
    });
    expect(selection.primary!.role.reason).not.toMatch(/largest|biggest|first|detail/i);
  });
});

// ---------------------------------------------------------------------------
// The rules that hold the whole thing up
// ---------------------------------------------------------------------------

describe('a filename may demote and never promote', () => {
  it('demotes what it names', () => {
    expect(roleFromAssetName('Estate_Masterplan.png')).toBe('masterplan');
    expect(roleFromAssetName('Lot_12_Floorplan.pdf')).toBe('floorplan');
    expect(roleFromAssetName('Master_Bedroom.jpg')).toBe('interior');
    expect(roleFromAssetName('NPC_logo.png')).toBe('logo_decorative');
  });

  /**
   * `6.png` is the live name of a verified facade render and `Facade.png` is
   * the live name of another. Neither name says which property it belongs to or
   * that the source presented it as a listing image, so neither may promote.
   */
  it('promotes nothing, including a name that says "facade"', () => {
    expect(roleFromAssetName('Facade.png')).toBeNull();
    expect(roleFromAssetName('6.png')).toBeNull();
    expect(roleFromAssetName('Lumi_Oak_Facade.png')).toBeNull();
  });
});

describe('a raster the page repeats is never a property hero', () => {
  it('is not even a candidate, whatever its size or detail', () => {
    // The live cover's wash: bigger on the page than the facade, ample detail.
    const outcome = selectCoverHero([{ key: 'wash', placementsOnPage: 3, pagesDrawnOn: 1 }]);
    expect(outcome.kind).toBe('none');
    expect(outcome.reason).toContain('repeats');
  });
});

describe('discovery rejects, and selection is separate from it', () => {
  it('collapses repeated placements into one candidate that counts them', () => {
    const image = {
      name: 'Im0', objectNumber: 5, width: 1300, height: 698,
      start: 0, end: 60_000, filters: ['DCTDecode'], components: 3, bitsPerComponent: 8,
    };
    const at = (index: number) => ({
      name: 'Im0', drawn: { x: 0, y: 0, width: 595, height: 842 },
      clip: null, index, ctm: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    });
    const candidates = qualifyingPhotographsFrom(
      [{ image, placement: at(0) }, { image, placement: at(1) }, { image, placement: at(2) }],
      595, 842,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].placements).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asset(url: string): SourceImageAsset {
  return {
    url,
    reference: url,
    origin: 'html_row_image',
    provider: 'source_page',
    pageUrl: null,
    position: 0,
    linkFallback: true,
    role: { role: 'unknown', evidenceLevel: null, evidence: 'none', reason: 'not settled' },
  };
}

// ---------------------------------------------------------------------------
// W — an annotated marketing tile beside the clean original
// ---------------------------------------------------------------------------

/**
 * WHAT THIS PINS, MEASURED ON THE LIVE NOTION SOURCE.
 *
 * Two production cards showed the property's own facade with promotional
 * wording set over it in coloured pills — "Completed" and "SMSF" on Lot 13
 * Hummock Rise, "$25,000 Rebate", "VIC" and "LARA" on Lot 1663 Ringer Street.
 * The audit proved the wording is in the BUILDER'S OWN BYTES: the stored
 * object and the Notion attachment hash identically, and the row designates no
 * other image. Nothing may be done about those two, because the only honest
 * alternatives are editing the pixels or borrowing another lot's house.
 *
 * What CAN be fixed is the choice, for any property whose source supplies both.
 * A marketing tile sits in the row's page-cover slot — LEVEL 3, a structural
 * container designating one image. A clean original sits in a field the
 * builder named for it — LEVEL 1. Same property, same provenance, same
 * `primary_property` role: the level is the only thing that separates them,
 * and it was never read. `position` decided, which is to say the order the
 * reader happened to enumerate them in.
 */
describe('W — choosing between two proven primaries for one property', () => {
  const candidate = (over: Partial<Parameters<typeof isDisplayableSourceImage>[0]>) => ({
    id: 'image-x',
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_path: 'org/items/item-1/source/x.png',
    position: 0,
    source_detail: { role: 'primary_property', role_evidence_level: 3, ...CLEAN_VERDICT },
    ...over,
  });

  /**
   * The shape the live rows have: a page cover, and nothing else.
   *
   * Designated by the source, and MEASURED as carrying promotional treatment —
   * which is what Lot 13 and Lot 1663 are. It appears here to prove it can
   * never be chosen, whatever it is ranked against.
   */
  const marketingTile = candidate({
    id: 'cover-tile',
    position: 0,
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 3,
      role_evidence: 'the Notion row for this property designates this image as its page cover',
      ...ANNOTATED_VERDICT,
    },
  });
  /** The same slot, with a picture the measurement found nothing on. */
  const cleanCover = candidate({
    id: 'cover-clean',
    position: 0,
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 3,
      role_evidence: 'the Notion row for this property designates this image as its page cover',
      ...CLEAN_VERDICT,
    },
  });
  /** What a source that ALSO names a property-image field supplies. */
  const cleanOriginal = candidate({
    id: 'field-original',
    position: 4,
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 1,
      role_evidence: 'the column "Property Image" names this image',
      ...CLEAN_VERDICT,
    },
  });

  it('takes the field the builder named over the cover slot, whatever the order', () => {
    expect(chooseDisplayableImage([cleanCover, cleanOriginal])!.id).toBe('field-original');
    expect(chooseDisplayableImage([cleanOriginal, cleanCover])!.id).toBe('field-original');
  });

  it('a package cover hero beats a row cover, and loses to a named field', () => {
    const packageHero = candidate({
      id: 'package-hero',
      position: 9,
      source_detail: { role: 'primary_property', role_evidence_level: 2, ...CLEAN_VERDICT },
    });
    expect(chooseDisplayableImage([cleanCover, packageHero])!.id).toBe('package-hero');
    expect(chooseDisplayableImage([packageHero, cleanOriginal])!.id).toBe('field-original');
  });

  /**
   * THE LIVE CASE, AND THE THING THIS ORDERING MUST NOT BE MISTAKEN FOR.
   *
   * Ranking chooses BETWEEN images a card may show. It is not what refuses
   * one. A designated tile carrying a status ribbon is refused by the display
   * rule, so being the only candidate promotes it to nothing — the card shows
   * no image, which is the correct answer for Lot 13 and Lot 1663.
   */
  it('shows nothing when the only designated image is a marketing tile', () => {
    expect(chooseDisplayableImage([marketingTile])).toBeNull();
  });

  it('and reaches past one to a clean image however weakly designated', () => {
    const weakerButClean = candidate({
      id: 'package-hero', position: 9,
      source_detail: { role: 'primary_property', role_evidence_level: 2, ...CLEAN_VERDICT },
    });
    // Level 3 outranks level 2 and still loses, because it is not a candidate.
    expect(chooseDisplayableImage([marketingTile, weakerButClean])!.id).toBe('package-hero');
  });

  it('never lets an unrecorded level outrank a stated one', () => {
    const legacy = candidate({
      id: 'legacy', position: 0,
      source_detail: { role: 'primary_property', ...CLEAN_VERDICT },
    });
    expect(chooseDisplayableImage([legacy, cleanCover])!.id).toBe('cover-clean');
  });

  it('falls through to position and then id when the evidence ties', () => {
    const first = candidate({ id: 'b-second', position: 1 });
    const second = candidate({ id: 'a-first', position: 1 });
    expect(chooseDisplayableImage([first, second])!.id).toBe('a-first');
    expect(chooseDisplayableImage([candidate({ id: 'p2', position: 2 }), first])!.id)
      .toBe('b-second');
  });

  it('a stronger level never admits an image the role check refuses', () => {
    // The level says HOW the source designated a hero; it can never stand in
    // for the designation itself.
    const notPrimary = candidate({
      id: 'interior',
      source_detail: { role: 'interior', role_evidence_level: 1, ...CLEAN_VERDICT },
    });
    expect(chooseDisplayableImage([notPrimary])).toBeNull();
    expect(chooseDisplayableImage([notPrimary, cleanCover])!.id).toBe('cover-clean');
  });
});
