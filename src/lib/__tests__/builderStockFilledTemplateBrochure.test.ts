/**
 * Builder Stock — the brochure a builder produced by FILLING A TEMPLATE, and
 * the two places its facts were hiding.
 *
 * Measured on the Luxton stock list: of thirteen rows carrying a brochure
 * link, eight resolved a primary image and five did not. Three of the five
 * failed for one reason and it was not a rule being too strict — the readers
 * were looking in the wrong places.
 *
 *   THE TEXT. `getTextContent` reads what a page DRAWS. A brochure filled from
 *   an InDesign/Acrobat template draws its LABELS and carries its VALUES in
 *   AcroForm fields, so page 2 of Lot 231 read as "Land Price Land Size House
 *   Price Total Size" with not one number in it, and the lot number "231"
 *   appeared on no page of a nineteen-page document about Lot 231.
 *   `pageStatesIdentity` cannot match a lot the reader never handed it, so the
 *   cover was never designated and the card stayed blank.
 *
 *   THE PICTURE. The facade render is inside the appearance stream of a form
 *   field the builder named `Facade image` — `/Annots`, not `/Contents`, and
 *   not in the page's `/Resources /XObject` either. Every reader here walked
 *   the content stream and the forms it draws, found no raster at all on the
 *   page, and refused. The render was a 2000x1250 JPEG one dictionary away.
 *
 * Both fixes are DETERMINISTIC and neither invents anything: the field values
 * are appended as page text and judged by the same identity and package rules
 * as text that was set, and the appearance is descended exactly as a drawn
 * form XObject is, under the matrix that maps it onto the widget's rectangle.
 * After them the same thirteen rows resolve eleven, and every one of the
 * eleven is the property's own facade render.
 *
 * What these tests pin is the honesty of both: text nobody is shown never
 * becomes page text, an annotation that is not a form field is not the
 * document speaking, and a document with no AcroForm comes back byte for byte
 * as it did before.
 */
import { describe, expect, it } from 'vitest';

import {
  fieldTextByPage,
} from '../../../supabase/functions/_shared/builderStock/pdfText';
import {
  readPdfPage, widgetBaseMatrix,
} from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';

// ---------------------------------------------------------------------------
// The text a filled template carries in its fields
// ---------------------------------------------------------------------------

/** A stand-in for the reader's document proxy: pages, each with annotations. */
function readerFor(pages: unknown[][]) {
  return {
    numPages: pages.length,
    getPage: (index: number) => Promise.resolve({
      getAnnotations: () => Promise.resolve(pages[index - 1] ?? []),
    }),
  };
}

const FIELD = (over: Record<string, unknown> = {}) => ({
  subtype: 'Widget', hidden: false, noView: false, fieldType: 'Tx', ...over,
});

describe('a filled template states its facts in fields, and they are page text', () => {
  it('reads the value of every visible field, on the page that carries it', async () => {
    const values = await fieldTextByPage(readerFor([
      [
        FIELD({ fieldName: 'Land Estate Name', fieldValue: 'Winterset Lodge ' }),
        FIELD({ fieldName: 'Site Address', fieldValue: 'Lot 231 Stakes Boulevard, Manor Lakes VIC 3024' }),
      ],
      [
        FIELD({ fieldName: 'Price', fieldValue: '$776,100' }),
        FIELD({ fieldName: 'Land Size', fieldValue: '501m2' }),
      ],
    ]), 2);

    expect(values[0]).toEqual([
      'Winterset Lodge',
      'Lot 231 Stakes Boulevard, Manor Lakes VIC 3024',
    ]);
    expect(values[1]).toEqual(['$776,100', '501m2']);
  });

  it('ONLY THE VALUE — a field NAME is the template author\'s word, not the page\'s', async () => {
    const values = await fieldTextByPage(readerFor([
      [FIELD({ fieldName: 'Land Price', fieldValue: '$405,100' })],
    ]), 1);
    // The page already draws "Land Price" itself. Adding it again would be
    // this reader writing words into somebody's document.
    expect(values[0]).toEqual(['$405,100']);
    expect(values[0].join(' ')).not.toContain('Land Price');
  });

  it('A HIDDEN FIELD IS NOT ON THE PAGE — neither hidden nor no-view is read', async () => {
    const values = await fieldTextByPage(readerFor([
      [
        FIELD({ fieldValue: 'Lot 231 Stakes Boulevard' }),
        FIELD({ hidden: true, fieldValue: 'Lot 999 Working Copy' }),
        FIELD({ noView: true, fieldValue: 'Lot 998 Print Only' }),
      ],
    ]), 1);
    expect(values[0]).toEqual(['Lot 231 Stakes Boulevard']);
  });

  it('an annotation that is not a Widget is a reader\'s remark, never the document\'s', async () => {
    const values = await fieldTextByPage(readerFor([
      [
        { subtype: 'FreeText', fieldValue: 'check this lot number' },
        { subtype: 'Popup', fieldValue: 'Lot 404' },
        FIELD({ fieldValue: '$776,100' }),
      ],
    ]), 1);
    expect(values[0]).toEqual(['$776,100']);
  });

  it('a multi-select answers with a list, and anything that is not text is left alone', async () => {
    const values = await fieldTextByPage(readerFor([
      [
        FIELD({ fieldType: 'Ch', fieldValue: ['04', '02'] }),
        FIELD({ fieldValue: 3 }),
        FIELD({ fieldValue: null }),
        FIELD({ fieldValue: { toString: () => 'Lot 1' } }),
      ],
    ]), 1);
    expect(values[0]).toEqual(['04', '02']);
  });

  it('one value stated by two fields is stated once', async () => {
    const values = await fieldTextByPage(readerFor([
      [
        FIELD({ fieldName: 'Site Address', fieldValue: 'Lot 516 Comb Street' }),
        FIELD({ fieldName: 'Site Address Repeat', fieldValue: 'Lot 516 Comb Street' }),
      ],
    ]), 1);
    expect(values[0]).toEqual(['Lot 516 Comb Street']);
  });

  it('A DOCUMENT WITH NO FIELDS IS UNCHANGED — every page contributes nothing', async () => {
    const values = await fieldTextByPage(readerFor([[], [], []]), 3);
    expect(values).toEqual([[], [], []]);
  });

  it('and no fault in the fields can cost a document its text', async () => {
    // A reader build with no annotation support at all.
    const noSupport = {
      numPages: 2,
      getPage: () => Promise.resolve({} as Record<string, never>),
    };
    await expect(fieldTextByPage(noSupport, 2)).resolves.toEqual([[], []]);

    // One page that throws, between two that do not.
    const oneBadPage = {
      numPages: 3,
      getPage: (index: number) => (index === 2
        ? Promise.reject(new Error('page 2 is damaged'))
        : Promise.resolve({
          getAnnotations: () => Promise.resolve([FIELD({ fieldValue: `page ${index}` })]),
        })),
    };
    await expect(fieldTextByPage(oneBadPage, 3)).resolves.toEqual([
      ['page 1'], [], ['page 3'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The picture a filled template carries in a field's appearance
// ---------------------------------------------------------------------------

/**
 * A minimal PDF with one page, one image, and one widget annotation whose
 * normal appearance draws it.
 *
 * Written out by hand rather than fixtured, so what the parser is being asked
 * to read is visible in this file: `/Annots` behind an INDIRECT reference to
 * an array, which is how Adobe's own exporter writes it and which is the exact
 * shape that made the first version of this reader see no widgets at all.
 */
function pdfWithWidgetImage(options: {
  flags?: number;
  rect?: [number, number, number, number];
  bbox?: [number, number, number, number];
  matrix?: [number, number, number, number, number, number];
  appearanceKey?: string;
} = {}): Uint8Array {
  const {
    flags = 4,
    rect = [10, 20, 210, 145],
    bbox = [0, 0, 2000, 1250],
    matrix = [1, 0, 0, 1, 0, 0],
    appearanceKey = 'N',
  } = options;

  // A stream body whose length is what the dictionary says. The bytes are not
  // a real JPEG; nothing in this test decodes them.
  const imageBody = 'X'.repeat(4096);
  const appearanceBody = 'q 2000 0 0 1250 0 0 cm /Im0 Do Q';
  const pageBody = 'q 1 0 0 1 0 0 cm Q';

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [ 6 0 R ] >> >>',
    '<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595 842 ] /Resources << >> '
      + '/Contents 4 0 R /Annots 5 0 R >>',
    `<< /Length ${pageBody.length} >>\nstream\n${pageBody}\nendstream`,
    '[ 6 0 R ]',
    `<< /Type /Annot /Subtype /Widget /FT /Btn /T (Facade image) /F ${flags} `
      + `/Rect [ ${rect.join(' ')} ] /AP << /${appearanceKey} 7 0 R >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [ ${bbox.join(' ')} ] `
      + `/Matrix [ ${matrix.join(' ')} ] /Resources << /XObject << /Im0 8 0 R >> >> `
      + `/Length ${appearanceBody.length} >>\nstream\n${appearanceBody}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 2000 /Height 1250 /ColorSpace /DeviceRGB '
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBody.length} >>`
      + `\nstream\n${imageBody}\nendstream`,
  ];

  let body = '%PDF-1.7\n';
  objects.forEach((object, index) => {
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  body += 'trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF\n';
  return new TextEncoder().encode(body);
}

describe('a page shows its widget annotations, and their pictures are on the page', () => {
  it('finds the appearance of a visible widget, with its rectangle and box', () => {
    const page = readPdfPage(pdfWithWidgetImage(), 0);
    expect(page).not.toBeNull();
    expect(page!.widgets).toHaveLength(1);

    const widget = page!.widgets[0];
    // Named for the field, so a provenance record can say where it came from.
    expect(widget.form.name).toBe('Facade image');
    expect(widget.rect).toEqual({ x: 10, y: 20, width: 200, height: 125 });
    expect(widget.bbox).toEqual({ x: 0, y: 0, width: 2000, height: 1250 });
    // And the picture inside it is the appearance's own resource.
    expect(widget.form.images.map((image) => [image.width, image.height]))
      .toEqual([[2000, 1250]]);
  });

  it('A HIDDEN OR NO-VIEW WIDGET IS NOT ON THE PAGE', () => {
    // `/F` bit 2 is Hidden, bit 6 is NoView. A template's working fields are
    // exactly the ones set that way, and a picture nobody is shown must never
    // become a property's photograph.
    expect(readPdfPage(pdfWithWidgetImage({ flags: 2 }), 0)!.widgets).toEqual([]);
    expect(readPdfPage(pdfWithWidgetImage({ flags: 32 }), 0)!.widgets).toEqual([]);
    expect(readPdfPage(pdfWithWidgetImage({ flags: 4 }), 0)!.widgets).toHaveLength(1);
  });

  it('ONLY THE NORMAL APPEARANCE — the down and rollover states are not the page', () => {
    for (const key of ['D', 'R']) {
      expect(readPdfPage(pdfWithWidgetImage({ appearanceKey: key }), 0)!.widgets).toEqual([]);
    }
  });

  it('maps the appearance onto the rectangle the page shows it in', () => {
    const page = readPdfPage(pdfWithWidgetImage(), 0)!;
    const [a, b, c, d, e, f] = widgetBaseMatrix(page.widgets[0]);
    // A 2000x1250 box fitted into a 200x125 rectangle at (10, 20).
    expect(a).toBeCloseTo(0.1, 6);
    expect(d).toBeCloseTo(0.1, 6);
    expect(b).toBe(0);
    expect(c).toBe(0);
    expect(e).toBeCloseTo(10, 6);
    expect(f).toBeCloseTo(20, 6);
  });

  it('honours the appearance\'s own matrix before fitting it', () => {
    // Rotated a quarter turn: the transformed box is 1250 wide by 2000 tall,
    // so the fit scales differently on each axis and the result still lands
    // exactly on the rectangle.
    const page = readPdfPage(pdfWithWidgetImage({
      matrix: [0, 1, -1, 0, 0, 0],
      rect: [0, 0, 125, 200],
    }), 0)!;
    const widget = page.widgets[0];
    const matrix = widgetBaseMatrix(widget);
    const corner = (x: number, y: number) => [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5],
    ];
    const corners = [corner(0, 0), corner(2000, 0), corner(0, 1250), corner(2000, 1250)];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(125, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(200, 6);
  });

  it('a degenerate appearance is placed rather than divided by zero', () => {
    const page = readPdfPage(pdfWithWidgetImage({ bbox: [0, 0, 0, 0] }), 0);
    // A zero box cannot be a widget at all — it is rejected before placement,
    // so nothing downstream is handed a picture with no position.
    expect(page!.widgets).toEqual([]);
    // And the fallback itself never produces a non-finite matrix.
    const placed = widgetBaseMatrix({
      form: {
        name: 'x', objectNumber: 1, start: 0, end: 0, flate: false,
        matrix: [0, 0, 0, 0, 0, 0], images: [], forms: [],
      },
      rect: { x: 5, y: 7, width: 10, height: 10 },
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(placed.every(Number.isFinite)).toBe(true);
  });

  it('a page with no annotations carries no widgets, and reads exactly as before', () => {
    const withAnnots = new TextDecoder().decode(pdfWithWidgetImage());
    const withoutAnnots = new TextEncoder().encode(
      withAnnots.replace('/Annots 5 0 R ', ''),
    );
    const page = readPdfPage(withoutAnnots, 0);
    expect(page).not.toBeNull();
    expect(page!.widgets).toEqual([]);
    expect(page!.images).toEqual([]);
  });
});
