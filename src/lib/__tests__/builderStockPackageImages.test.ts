/**
 * Builder stock — the render inside a row's OWN package document.
 *
 * THE CASE THIS FILE PINS. Forty-five of the seventy live properties have no
 * cover on their Notion row, and all forty-five carry the same "Complete
 * Package Pack" link — one Google Drive folder, shared by forty-four of them.
 * The link therefore attributes NOTHING on its own, and using anything out of
 * that folder because it is "the one the row linked" would put an estate
 * masterplan of fifty other lots on a client's page.
 *
 * What makes it deterministic is that the library names its contents:
 *
 *     …/Tweed Heads Packages/Lot 43/Lot 43 - Stradbroke 180 - Property Package.pdf
 *
 * against a row called "Lot 43 — Tringa Street … [Stradbroke 180]". The folder
 * names the lot, the file names the lot AND the design, and those two together
 * are exactly one stock row. Every fixture below is the shape of that live
 * library, including the three folders it really does call "Lot 53" and the
 * three documents that really do all name lot 914.
 */
import { describe, expect, it } from 'vitest';

import {
  driveFileId, driveFolderId, isGoogleDriveHost, lotAndDesignFrom,
  parseDriveFolderListing, selectLotFolder, selectPackageDocument,
  DRIVE_FOLDER_MIME, type DriveEntry,
} from '../../../supabase/functions/_shared/builderStock/drivePackage.pure';
import {
  flattenedPageImage, parseImagePlacements, readFirstPage, selectPropertyPhotograph,
} from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';
import {
  DriveListingCache, recoverPackageImage,
} from '../../../supabase/functions/_shared/builderStock/packageImages';

/**
 * The package's own COVER PAGE, as a person reads it.
 *
 * A picture is this property's image because the document presented it on the
 * page stating this property's identity and its package information — not
 * because it is the biggest raster in the file. These fixtures are built as
 * bare page trees with no text layer, so the cover text is supplied the way
 * production reads it, through the injected reader.
 */
const coverTextFor = (label: string) => async () => [
  `${label}\nFIXED PRICE CONTRACT\n$1,307,585\nLand Size 350 m2\n4 bed 2 bath 2 car`,
];


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACKAGE_LINK = 'https://drive.google.com/drive/folders/1isIaQ8qqqDUYICn6q9fyVu_z1kl5PvId?usp=sharing';
const LOT_43_LABEL = 'Lot 43, Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]';

const folder = (id: string, name: string): DriveEntry =>
  ({ id, name, mimeType: DRIVE_FOLDER_MIME });
const pdf = (id: string, name: string): DriveEntry =>
  ({ id, name, mimeType: 'application/pdf' });

/** A folder page as Drive serves it logged out: the listing, hex-escaped. */
function driveFolderHtml(entries: DriveEntry[]): string {
  const rows = entries.map((entry) => [
    entry.id, ['parent'], entry.name, entry.mimeType, 0, null,
  ]);
  const json = JSON.stringify([rows, null, null]);
  const escaped = json.replace(/[[\]"\\/]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `<html><head><title>Tweed Heads - Google Drive</title></head><body>`
    + `<script nonce="x">window['_DRIVE_ivd'] = '${escaped}';</script></body></html>`;
}

/**
 * A JPEG: real markers, padded past the "too small to be a photograph" floor.
 *
 * The default is sized the way a real 1700×956 render is — a lossy encoding
 * carries roughly a tenth of a byte per pixel, and a picture that carries far
 * less than that is a flat decorative wash rather than a photograph, which is
 * a distinction `selectPropertyPhotograph` now makes.
 */
function jpegBytes(size = 160_000, fill = 0x42): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.fill(fill, 4, size - 2);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function concat(parts: Array<Uint8Array | string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/**
 * A package PDF shaped like the live ones: a facade render on page 1 and the
 * ESTATE MASTERPLAN on page 2. The second must never be returned.
 */
function packagePdf(page1: Uint8Array, page2: Uint8Array): Uint8Array {
  const draw1 = 'q 516 0 0 290 40 480 cm /Im0 Do Q';
  const draw2 = 'q 580 0 0 820 5 10 cm /Im1 Do Q';
  return concat([
    '%PDF-1.4\n',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
      + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n',
    `4 0 obj<</Type/XObject/Subtype/Image/Width 1700/Height 956/Filter/DCTDecode/Length ${page1.length}>>stream\n`,
    page1,
    '\nendstream\nendobj\n',
    `5 0 obj<</Length ${draw1.length}>>stream\n${draw1}\nendstream\nendobj\n`,
    '6 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
      + '/Resources<</XObject<</Im1 7 0 R>>>>/Contents 8 0 R>>endobj\n',
    `7 0 obj<</Type/XObject/Subtype/Image/Width 2000/Height 1414/Filter/DCTDecode/Length ${page2.length}>>stream\n`,
    page2,
    '\nendstream\nendobj\n',
    `8 0 obj<</Length ${draw2.length}>>stream\n${draw2}\nendstream\nendobj\n`,
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  ]);
}

/** Read a fixture's first page the way `packageImages.ts` does. */
function firstPage(bytes: Uint8Array) {
  const page = readFirstPage(bytes)!;
  let content = '';
  for (const slice of page.contents) {
    content += new TextDecoder('latin1').decode(bytes.slice(slice.start, slice.end));
  }
  return { page, placements: parseImagePlacements(content) };
}

// ---------------------------------------------------------------------------
// Reading a public folder
// ---------------------------------------------------------------------------

describe('a public Drive folder, read logged out', () => {
  it('decodes the listing the page embeds', () => {
    const entries = parseDriveFolderListing(driveFolderHtml([
      folder('f1', 'Tweed Heads Packages'),
      pdf('d1', 'Sandpiper Brochure.pdf'),
    ]));
    expect(entries).toEqual([
      { id: 'f1', name: 'Tweed Heads Packages', mimeType: DRIVE_FOLDER_MIME },
      { id: 'd1', name: 'Sandpiper Brochure.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('yields nothing for a page that carries no listing', () => {
    // What a folder that is NOT shared publicly returns: a sign-in shell.
    expect(parseDriveFolderListing('<html><body>Sign in</body></html>')).toEqual([]);
  });

  it('reads ids out of the link shapes a builder pastes', () => {
    expect(driveFolderId(PACKAGE_LINK)).toBe('1isIaQ8qqqDUYICn6q9fyVu_z1kl5PvId');
    expect(driveFileId('https://drive.google.com/file/d/1PQfyfbscQnJPUouTK85fnnAYeMceFvop/view'))
      .toBe('1PQfyfbscQnJPUouTK85fnnAYeMceFvop');
    expect(isGoogleDriveHost('drive.google.com')).toBe(true);
    // Nothing else is a package source.
    expect(driveFolderId('https://dropbox.com/drive/folders/abcdefghijkl')).toBeNull();
    expect(isGoogleDriveHost('drive.google.com.evil.test')).toBe(false);
  });

  it('reads only one folder per id, however many rows ask for it', async () => {
    let calls = 0;
    const cache = new DriveListingCache(async () => {
      calls += 1;
      return {
        bytes: new TextEncoder().encode(driveFolderHtml([folder('a', 'Lot 43')])),
        finalUrl: 'https://drive.google.com/drive/folders/root',
      };
    });
    await cache.list('root');
    await cache.list('root');
    await cache.list('root');
    // 44 live rows share one folder; this is what keeps that to one request.
    expect(calls).toBe(1);
    expect(cache.listings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Naming a property, exactly
// ---------------------------------------------------------------------------

describe('which document belongs to which property', () => {
  it('takes the lot and the design off the row itself', () => {
    expect(lotAndDesignFrom(LOT_43_LABEL)).toEqual({ lot: '43', design: 'stradbroke 180' });
    // The row writes "Dual Occ"; the document does not.
    expect(lotAndDesignFrom('Lot 51 - Tringa Street … [Echo 236 Dual Occ]'))
      .toEqual({ lot: '51', design: 'echo 236' });
    expect(lotAndDesignFrom('Lot 914 - Covella Estate, Greenbank QLD 4124'))
      .toEqual({ lot: '914', design: null });
  });

  it('matches a lot folder on equality, so Lot 5 is not Lot 51', () => {
    const entries = [folder('a', 'Lot 5'), folder('b', 'Lot 51'), folder('c', 'Lot 512')];
    expect(selectLotFolder(entries, '5')).toBe('a');
    expect(selectLotFolder(entries, '51')).toBe('b');
    expect(selectLotFolder(entries, '7')).toBeNull();
  });

  it('refuses a lot the library names twice', () => {
    // The live library really does contain three folders called "Lot 53".
    const entries = [folder('a', 'Lot 53'), folder('b', 'Lot 53'), folder('c', 'Lot 53')];
    expect(selectLotFolder(entries, '53')).toBeNull();
  });

  it('requires the document to name the lot AND the design', () => {
    const entries = [
      pdf('p1', 'Lot 43 - Stradbroke 180 - Property Package.pdf'),
      pdf('p2', 'Lot 43 - Stradbroke 197 - Property Package.pdf'),
      pdf('p3', 'Lot 43 - Echo 236 - Property Package.pdf'),
    ];
    expect(selectPackageDocument(entries, { lot: '43', design: 'stradbroke 180' })?.id).toBe('p1');
    // A row that named no design cannot pick between seven packages.
    expect(selectPackageDocument(entries, { lot: '43', design: null })).toBeNull();
    expect(selectPackageDocument(entries, { lot: '43', design: 'miami 190' })).toBeNull();
  });

  it('picks the package out of a folder whose documents all name the same lot', () => {
    /*
     * Lot 914's real folder: a package, a land contract and a rental appraisal,
     * every one of them naming lot 914. Counting names finds three and refuses
     * — which left a real builder facade off a live card. The contract and the
     * appraisal say in their own filenames what they are, so what remains is
     * exactly one package candidate.
     */
    const entries = [
      pdf('a', 'LOT 914 • COVELLA • GREENBANK QLD.pdf'),
      pdf('b', 'OTP_Land_Contract_P1_-_Rana_-_Lot_914_Covella.pdf'),
      pdf('c', 'Rental Appraisal_ Lot 914, Covella Estate, Greenbank QLD.pdf'),
    ];
    expect(selectPackageDocument(entries, { lot: '914', design: null })?.id).toBe('a');
  });

  it('still refuses when TWO documents could both be the package', () => {
    // Neither declares itself something else, so the folder has not said which.
    const entries = [
      pdf('a', 'LOT 914 • COVELLA • GREENBANK QLD.pdf'),
      pdf('b', 'Lot 914 Covella - Property Package.pdf'),
    ];
    expect(selectPackageDocument(entries, { lot: '914', design: null })).toBeNull();
  });

  it('refuses when every candidate declares itself something else', () => {
    // A contract and an appraisal and nothing else. Inventing a package out of
    // a contract is precisely what this must not do.
    const entries = [
      pdf('b', 'OTP_Land_Contract_P1_-_Rana_-_Lot_914_Covella.pdf'),
      pdf('c', 'Rental Appraisal_ Lot 914, Covella Estate, Greenbank QLD.pdf'),
    ];
    expect(selectPackageDocument(entries, { lot: '914', design: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Taking the picture out of the document
// ---------------------------------------------------------------------------

describe('the image a package leads with', () => {
  it('returns the first page and never a later one', () => {
    const render = jpegBytes(160_000, 0x11);
    const masterplan = jpegBytes(240_000, 0x22);
    const pdf = packagePdf(render, masterplan);
    const { page, placements } = firstPage(pdf);

    const chosen = selectPropertyPhotograph(page, placements)!;
    expect(chosen.image).toMatchObject({ width: 1700, height: 956, name: 'Im0' });
    const bytes = pdf.slice(chosen.image.start, chosen.image.end);
    expect(bytes.length).toBe(render.length);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
  });

  it('ignores a page-one logo', () => {
    const draw = 'q 60 0 0 40 20 780 cm /Im0 Do Q';
    const pdfBytes = concat([
      '%PDF-1.4\n',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
        + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n',
      '4 0 obj<</Type/XObject/Subtype/Image/Width 240/Height 90/Filter/DCTDecode/Length 4096>>stream\n',
      jpegBytes(),
      '\nendstream\nendobj\n',
      `5 0 obj<</Length ${draw.length}>>stream\n${draw}\nendstream\nendobj\n`,
      'trailer<</Root 1 0 R>>\n',
    ]);
    const { page, placements } = firstPage(pdfBytes);
    expect(selectPropertyPhotograph(page, placements)).toBeNull();
  });

  it('never serves a flattened page scan AS the photograph', () => {
    // What the Covella package actually is: whole pages as raw bitmaps. It is
    // not a photograph of a house, so it is not chosen — it is handed to the
    // isolation step instead, which crops the render out of it or refuses.
    const draw = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    const pdfBytes = concat([
      '%PDF-1.4\n',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
        + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n',
      '4 0 obj<</Type/XObject/Subtype/Image/Width 2480/Height 3506/ColorSpace/DeviceRGB'
        + '/BitsPerComponent 8/Filter/FlateDecode/Length 64>>stream\n',
      new Uint8Array(64),
      '\nendstream\nendobj\n',
      `5 0 obj<</Length ${draw.length}>>stream\n${draw}\nendstream\nendobj\n`,
      'trailer<</Root 1 0 R>>\n',
    ]);
    const { page, placements } = firstPage(pdfBytes);
    expect(selectPropertyPhotograph(page, placements)).toBeNull();
    expect(flattenedPageImage(page, placements)?.image.name).toBe('Im0');
  });

  it('says nothing about a file it cannot parse', () => {
    expect(readFirstPage(new TextEncoder().encode('not a pdf'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end, against the live library's shape
// ---------------------------------------------------------------------------

describe('recovering a row-linked package image', () => {
  const render = jpegBytes(160_000, 0x33);

  function library(options: { lotFolders?: DriveEntry[]; documents?: DriveEntry[] } = {}) {
    const lotFolders = options.lotFolders ?? [folder('lot43', 'Lot 43'), folder('lot42', 'Lot 42')];
    const documents = options.documents ?? [
      pdf('doc-strad', 'Lot 43 - Stradbroke 180 - Property Package.pdf'),
      pdf('doc-miami', 'Lot 43 - Miami 190 - Property Package.pdf'),
    ];
    const requested: string[] = [];
    const fetchPackage = async (url: string) => {
      requested.push(url);
      const encode = (html: string) => ({ bytes: new TextEncoder().encode(html), finalUrl: url });
      if (url.includes('/folders/1isIaQ8qqqDUYICn6q9fyVu_z1kl5PvId')) {
        return encode(driveFolderHtml([
          folder('packages', 'Tweed Heads Packages'),
          folder('images', 'Project Images'),
          pdf('brochure', 'Sandpiper Brochure.pdf'),
        ]));
      }
      if (url.includes('/folders/packages')) return encode(driveFolderHtml(lotFolders));
      if (url.includes('/folders/lot43')) return encode(driveFolderHtml(documents));
      if (url.includes('/folders/')) return encode(driveFolderHtml([]));
      if (url.includes('id=doc-strad')) {
        return { bytes: packagePdf(render, jpegBytes(240_000, 0x44)), finalUrl: url };
      }
      return { bytes: new TextEncoder().encode('<html>Sign in</html>'), finalUrl: url };
    };
    return { fetchPackage, requested };
  }

  it('walks the row\'s own folder down to its own document and takes page one', async () => {
    const { fetchPackage, requested } = library();
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      { fetchPackage, readPageTexts: coverTextFor(LOT_43_LABEL) },
    );

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.image.documentName).toBe('Lot 43 - Stradbroke 180 - Property Package.pdf');
    // The reference names the document, the page AND the object it came out
    // of, so the picture can be found again in the builder's own file.
    expect(outcome.image.reference).toBe('Lot 43 - Stradbroke 180 - Property Package.pdf#page1:Im0');
    expect(outcome.image.provenance).toMatchObject({
      page: 1, method: 'embedded_raster', resourceName: 'Im0', transformation: null,
    });
    expect(outcome.image.contentType).toBe('image/jpeg');
    expect(outcome.image.bytes.length).toBe(render.length);
    // Everything fetched stayed inside the folder the row linked.
    expect(requested.every((url) => url.startsWith('https://drive.google.com/'))).toBe(true);
    expect(requested.some((url) => url.includes('id=doc-miami'))).toBe(false);
  });

  it('refuses when the lot folder holds no document for that design', async () => {
    const { fetchPackage } = library({
      documents: [pdf('doc-other', 'Lot 43 - Bishop 258 - Property Package.pdf')],
    });
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      { fetchPackage, readPageTexts: coverTextFor(LOT_43_LABEL) },
    );
    expect(outcome.status).toBe('not_identified');
  });

  it('refuses when the library names the lot twice', async () => {
    const { fetchPackage } = library({
      lotFolders: [folder('lot43', 'Lot 43'), folder('lot43b', 'Lot 43')],
    });
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      { fetchPackage, readPageTexts: coverTextFor(LOT_43_LABEL) },
    );
    expect(outcome.status).toBe('not_identified');
  });

  it('reports a folder that needs a sign-in rather than inventing a picture', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      {
        fetchPackage: async (url: string) => ({
          bytes: new TextEncoder().encode('<html><body>Request access</body></html>'),
          finalUrl: url,
        }),
      },
    );
    expect(outcome.status).toBe('unreachable');
  });

  it('will not follow a package link off Drive', async () => {
    let called = false;
    const outcome = await recoverPackageImage(
      { packageUrl: 'https://packages.example/lot-43', label: LOT_43_LABEL },
      { fetchPackage: async () => { called = true; throw new Error('must not fetch'); } },
    );
    expect(outcome.status).toBe('not_identified');
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A LIBRARY THAT FILES BY SUBJECT INSTEAD OF BY LOT
// ---------------------------------------------------------------------------

describe('a library whose folders are document KINDS, not lots', () => {
  /*
   * FOUR LIVE CARDS. Sandpiper's library keeps one folder per lot, which is
   * what the lot search looks for. Cloverton's and Coridale's do the opposite:
   * the LINKED FOLDER is the property, and inside it are "Package", "Rental
   * Appraisal" and "Area Profile - Investment Report" — one folder per kind of
   * document. There is no lot folder to find, the root holds only an
   * estate-wide inclusions list, and the property's own package sits one level
   * down where nothing looked.
   *
   * The whole bounded subtree the lot search already walked is offered to the
   * same selector, so this reaches nothing outside the folder the row linked
   * and costs no further listing. Every rule it decides by is unchanged: one
   * document, this lot, and of a kind that can be a package.
   */
  const CLOVERTON = 'https://drive.google.com/drive/folders/cloverton60434';
  const LABEL = 'Lot 60434 - Cloverton Estate, Kalkallo VIC 3064';

  const subjectLibrary = (packageFolder: DriveEntry[]) => async (url: string) => {
    const encode = (html: string) => ({ bytes: new TextEncoder().encode(html), finalUrl: url });
    if (url.includes('/folders/cloverton60434')) {
      return encode(driveFolderHtml([
        folder('area', 'Area Profile - Investment Report'),
        folder('pack', 'Package'),
        folder('rent', 'Rental Appraisal'),
        pdf('incl', 'Victoria_Premium Inclusions List.pdf'),
      ]));
    }
    if (url.includes('/folders/pack')) return encode(driveFolderHtml(packageFolder));
    if (url.includes('/folders/')) return encode(driveFolderHtml([]));
    if (url.includes('id=doc-60434')) {
      return { bytes: packagePdf(jpegBytes(160_000, 0x33), jpegBytes(240_000, 0x44)), finalUrl: url };
    }
    return encode('<html>Sign in</html>');
  };

  it('finds the package one level down, in the folder the builder named', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: CLOVERTON, label: LABEL },
      {
        fetchPackage: subjectLibrary([pdf('doc-60434', 'Lot 60434 Cloverton, Kalkallo_140.pdf')]),
        readPageTexts: coverTextFor(LABEL),
      },
    );
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.image.documentName).toBe('Lot 60434 Cloverton, Kalkallo_140.pdf');
  });

  it('and still refuses when the subtree names the lot twice', async () => {
    // Relaxing WHERE it looks may not relax WHETHER the source said which
    // document. Two candidates is the library declining to answer.
    const outcome = await recoverPackageImage(
      { packageUrl: CLOVERTON, label: LABEL },
      {
        fetchPackage: subjectLibrary([
          pdf('doc-60434', 'Lot 60434 Cloverton, Kalkallo_140.pdf'),
          pdf('doc-60434b', 'Lot 60434 Cloverton, Kalkallo_122m2.pdf'),
        ]),
        readPageTexts: coverTextFor(LABEL),
      },
    );
    expect(outcome.status).toBe('not_identified');
  });

  it('and never reads a folder outside the one the row linked', async () => {
    const requested: string[] = [];
    const inner = subjectLibrary([pdf('doc-60434', 'Lot 60434 Cloverton, Kalkallo_140.pdf')]);
    await recoverPackageImage(
      { packageUrl: CLOVERTON, label: LABEL },
      {
        fetchPackage: async (url: string) => { requested.push(url); return await inner(url); },
        readPageTexts: coverTextFor(LABEL),
      },
    );
    const folders = requested.filter((url) => url.includes('/folders/'));
    expect(folders.every((url) =>
      ['cloverton60434', 'area', 'pack', 'rent'].some((id) => url.includes(id)))).toBe(true);
  });

  it('does not let ANOTHER property\'s folder become a second candidate', async () => {
    /*
     * The cache is shared by every row in a run — that is what keeps
     * forty-four rows pointing at one library to a handful of requests — so
     * "everything read so far" is not this property's subtree. Two Cloverton
     * rows each link their own folder and each folder holds one document naming
     * its own lot; reading the cache flat made the two look like two candidates
     * for one property, and produced no image for either.
     */
    const route = async (url: string) => {
      const encode = (html: string) => ({ bytes: new TextEncoder().encode(html), finalUrl: url });
      if (url.includes('/folders/cloverton60434')) {
        return encode(driveFolderHtml([folder('pack', 'Package')]));
      }
      if (url.includes('/folders/pack')) {
        return encode(driveFolderHtml([pdf('doc-60434', 'Lot 60434 Cloverton, Kalkallo_140.pdf')]));
      }
      if (url.includes('/folders/otherfolder')) {
        return encode(driveFolderHtml([folder('pack2', 'Package')]));
      }
      if (url.includes('/folders/pack2')) {
        return encode(driveFolderHtml([pdf('doc-60434b', 'Lot 60434 Cloverton, Kalkallo_122m2.pdf')]));
      }
      if (url.includes('/folders/')) return encode(driveFolderHtml([]));
      return { bytes: packagePdf(jpegBytes(160_000, 0x33), jpegBytes(240_000, 0x44)), finalUrl: url };
    };
    const shared = new DriveListingCache(route);
    const deps = { cache: shared, fetchPackage: route, readPageTexts: coverTextFor(LABEL) };

    const first = await recoverPackageImage(
      { packageUrl: 'https://drive.google.com/drive/folders/otherfolder', label: LABEL }, deps);
    expect(first.status).toBe('recovered');

    // The second row, through the SAME cache, must still find its own.
    const second = await recoverPackageImage({ packageUrl: CLOVERTON, label: LABEL }, deps);
    expect(second.status).toBe('recovered');
    if (second.status !== 'recovered') return;
    expect(second.image.documentName).toBe('Lot 60434 Cloverton, Kalkallo_140.pdf');
  });
});

// ---------------------------------------------------------------------------
// A DOCUMENT WE COULD NOT READ IS NOT A DOCUMENT THAT SAYS NOTHING
//
// This is the defect that emptied 44 Sandpiper Estate cards. The cover page is
// found by matching the property's label against each page's prose, so with no
// prose nothing matches and the selector returns nothing — which is
// indistinguishable, at that point, from a brochure that genuinely does not
// present this property. The reader loads pdf.js from a CDN at call time and
// answered an empty array when that import did not resolve, so every one of
// those documents reported "names no image for this property" without having
// been read at all. Production then banked that as a terminal answer.
// ---------------------------------------------------------------------------

describe('a package whose text layer cannot be read', () => {
  /** The same Drive shape the recovery tests above use, routed identically. */
  const library = () => async (url: string) => {
    const encode = (html: string) => ({ bytes: new TextEncoder().encode(html), finalUrl: url });
    if (url.includes('/folders/1isIaQ8qqqDUYICn6q9fyVu_z1kl5PvId')) {
      return encode(driveFolderHtml([
        folder('packages', 'Tweed Heads Packages'),
        folder('images', 'Project Images'),
        pdf('brochure', 'Sandpiper Brochure.pdf'),
      ]));
    }
    if (url.includes('/folders/packages')) {
      return encode(driveFolderHtml([folder('lot43', 'Lot 43')]));
    }
    if (url.includes('/folders/lot43')) {
      return encode(driveFolderHtml([
        pdf('doc-strad', 'Lot 43 - Stradbroke 180 - Property Package.pdf'),
      ]));
    }
    if (url.includes('/folders/')) return encode(driveFolderHtml([]));
    if (url.includes('id=doc-strad')) {
      return { bytes: packagePdf(jpegBytes(), jpegBytes(240_000, 0x44)), finalUrl: url };
    }
    return encode('<html>Sign in</html>');
  };

  it('is UNREACHABLE, not "this document names no image for you"', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      {
        fetchPackage: library(),
        // The reader is not available — exactly what a failed CDN import does.
        readPageTexts: async () => [],
      },
    );

    // The distinction the whole fix turns on: an operational fault is retried
    // and never written down, a finding is banked and stops us looking again.
    expect(outcome.status).toBe('unreachable');
    if (outcome.status !== 'unreachable') return;
    expect(outcome.detail).toMatch(/could not be read/i);
  });

  it('still answers not_identified when the document WAS read and names nothing', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: PACKAGE_LINK, label: LOT_43_LABEL },
      {
        fetchPackage: library(),
        // Read successfully — the pages simply belong to somebody else.
        readPageTexts: async () => [
          'Lot 99 - Someone Else\nFIXED PRICE CONTRACT\n$1,000,000\n3 bed 2 bath',
        ],
      },
    );

    expect(outcome.status).toBe('not_identified');
  });
});
