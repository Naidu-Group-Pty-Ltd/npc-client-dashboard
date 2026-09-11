/**
 * Builder stock — telling a builder WHY a document named no picture.
 *
 * MEASURED, 11 SEPTEMBER 2026. `Lot 1037 Wollert Rise · Vanta 20` shows no
 * photograph. Its linked brochure downloads fine, opens fine, and contains a
 * clean 1280×720 facade render. The election read it, saw that the cover
 * reads `NEX 20 — Lot 1307 Fuchsia Street, Wollert (Wollert Rise)`, and
 * refused it — correctly, because putting that render on a Vanta 20 listing
 * shows a buyer the wrong house. The document is a second copy of the sibling
 * row's brochure; the render inside the two is byte-identical.
 *
 * THE DEFECT WAS NOT THE REFUSAL. It was that the refusal was recorded and
 * never shown. `negativeProvenance.pure.ts` has always marked `detail` as
 * "safe to surface", and no screen surfaced it — so a brochure for the wrong
 * property and a brochure with no photograph in it both read "No picture
 * found", and the one person who could correct the sheet was told nothing.
 * That is what makes it recur: for this builder, and for every builder who
 * joins, until somebody happens to open the PDF by hand.
 *
 * The rule that keeps it safe is the one `unreadDocumentCount` already set:
 * an `inspected` answer is knowledge about the BUILDER'S document and travels;
 * an `operational` one is knowledge about US and never does.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_STOCK_DOCUMENT_NOTES, stockDocumentNotes,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  coverIdentityQuote,
} from '../../../supabase/functions/_shared/builderStock/pdfElection';

/** The Vanta 20 row's stored provenance, as production holds it. */
const WOLLERT_1037 = {
  branches: {
    'https://drive.google.com/file/d/1rE8rvWHNN1KDtJvO_0bP2i8-TZyeS3O0/view?usp=drive_link': {
      result: 'no_deterministic_image',
      exhaustion: 'inspected',
      detail: "That document does not present a page as this property's package cover, "
        + 'so it names no image for it.',
      provenance_version: 23,
    },
    'https://drive.google.com/file/d/1uWKLewLJbpsC4b_46rmu943S2pxTyDzU/view?usp=drive_link': {
      result: 'no_deterministic_image',
      exhaustion: 'inspected',
      detail: 'That link is an image rather than a package document, so it presents '
        + "no page as this property's package cover.",
      provenance_version: 23,
    },
  },
};

describe('stockDocumentNotes — the builder is told what their document said', () => {
  it('surfaces the recorded reason for the row that is actually broken', () => {
    const notes = stockDocumentNotes(WOLLERT_1037);
    expect(notes).toHaveLength(2);
    expect(notes[0].detail).toContain('does not present a page');
    expect(notes[1].detail).toContain('is an image rather than a package document');
  });

  it('reports the reason VERBATIM and composes nothing of its own', () => {
    const recorded = Object.values(WOLLERT_1037.branches).map((b) => b.detail);
    const surfaced = stockDocumentNotes(WOLLERT_1037).map((n) => n.detail);
    expect(surfaced).toEqual(recorded);
  });

  it('says nothing at all where nothing was recorded', () => {
    for (const empty of [null, undefined, {}, { branches: {} }, { branches: null }, 'nope', 7]) {
      expect(stockDocumentNotes(empty)).toEqual([]);
    }
  });
});

describe('what may NOT leave the server', () => {
  /*
   * The gate. An `operational` refusal is a fact about our own processing — a
   * kill, a ceiling, a timeout — and a builder can do nothing with it except
   * go and check a file that was never the problem. That has always been true
   * of the counts; it stays true of the words.
   */
  const OURS = {
    branches: {
      'https://drive.google.com/file/d/ours/view': {
        result: 'no_deterministic_image',
        exhaustion: 'operational',
        detail: 'The worker ran out of memory reading that document after 3 attempts.',
        runtime_version: 3,
      },
      'https://drive.google.com/file/d/gone/view': {
        result: 'no_deterministic_image',
        exhaustion: 'operational',
        detail: 'That link could not be opened.',
      },
      'https://drive.google.com/file/d/running/view': {
        result: 'package_recovery_attempt',
        detail: 'A recovery is in flight.',
      },
    },
  };

  it('never surfaces an operational reason, whoever the failure belonged to', () => {
    expect(stockDocumentNotes(OURS)).toEqual([]);
  });

  it('never surfaces a mechanism, asserted rather than trusted', () => {
    // The same forbidden vocabulary the progress labels are held to.
    const forbidden = [
      /crash/i, /memory/i, /\bCPU\b/i, /timed? ?out/i, /timeout/i, /worker/i,
      /isolate/i, /retry|retries|attempt/i, /\b\d+ ?MB\b/i, /resource limit/i,
      /exception/i, /stack/i, /5\d\d\b/,
    ];
    const mixed = { branches: { ...OURS.branches, ...WOLLERT_1037.branches } };
    for (const note of stockDocumentNotes(mixed)) {
      for (const pattern of forbidden) {
        expect(note.detail, `surfaced detail must not match ${pattern}`).not.toMatch(pattern);
        expect(note.document, `surfaced document must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('lets an inspected finding through even when an operational one sits beside it', () => {
    const mixed = { branches: { ...OURS.branches, ...WOLLERT_1037.branches } };
    expect(stockDocumentNotes(mixed)).toHaveLength(2);
  });
});

describe('a status line, not a log', () => {
  const many = {
    branches: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `https://drive.google.com/file/d/doc${i}/view`,
        { result: 'no_deterministic_image', exhaustion: 'inspected', detail: `Reason ${i}.` },
      ]),
    ),
  };

  it('is bounded, because a row can link many documents', () => {
    expect(stockDocumentNotes(many)).toHaveLength(MAX_STOCK_DOCUMENT_NOTES);
    expect(MAX_STOCK_DOCUMENT_NOTES).toBeLessThanOrEqual(6);
  });

  it('honours a caller that wants fewer, and never a negative', () => {
    expect(stockDocumentNotes(many, 2)).toHaveLength(2);
    expect(stockDocumentNotes(many, 0)).toEqual([]);
    expect(stockDocumentNotes(many, -3)).toEqual([]);
  });
});

describe('naming the document a person would recognise', () => {
  const noteFor = (url: string) => stockDocumentNotes({
    branches: { [url]: { result: 'no_deterministic_image', exhaustion: 'inspected', detail: 'x' } },
  })[0].document;

  it('uses the file name where the link carries one', () => {
    expect(noteFor('https://example.com/files/Lot%20318%20Thornhill.pdf'))
      .toBe('Lot 318 Thornhill.pdf');
  });

  it('never prints a Drive id, because that names nothing to a reader', () => {
    const drive = noteFor('https://drive.google.com/file/d/1rE8rvWHNN1KDtJvO_0bP2i8-TZyeS3O0/view');
    expect(drive).not.toContain('1rE8rvWHNN1KDtJvO_0bP2i8-TZyeS3O0');
    expect(drive).toBe('A document on drive.google.com');
  });

  it('still points at something when the link is not a URL at all', () => {
    expect(noteFor('not a link')).toBe('A linked document');
  });
});

/*
 * And the other half: a refusal that says only "this is not that property's
 * cover" cannot tell a builder whether the brochure has no photograph in it
 * or is simply the wrong file. Quoting the cover is what makes it obvious.
 */
describe('coverIdentityQuote — the refusal names what the document is', () => {
  /** Page 1 of the real brochure, as the pipeline\'s own reader returns it. */
  const WOLLERT_COVER = [
    'Build Land Lot Size',
    'FULL TURNKEY INCLUSIONS',
    '\u221A Front & rear landscaping,',
    'driveway, and fencing',
    'NEX 20',
    '$927,340 *',
    'PACKAGE PRICELot 1307 Fuchsia Street,',
    'Wollert (Wollert Rise)',
    'Titled Land 477,440',
  ].join('\n');

  it('picks the lines that actually identify the package', () => {
    // The lot is what separates this document from the row it is attached to.
    expect(coverIdentityQuote(WOLLERT_COVER)).toContain('Lot 1307 Fuchsia Street');
  });

  it('is bounded, because this lands in a status line', () => {
    expect(coverIdentityQuote(WOLLERT_COVER).length).toBeLessThanOrEqual(120);
    const long = coverIdentityQuote(
      Array.from({ length: 40 }, (_, i) => `Lot ${i} Somewhere Street`).join('\n'));
    expect(long.length).toBeLessThanOrEqual(120);
  });

  it('strips control characters, because it is somebody else\u2019s file', () => {
    const quote = coverIdentityQuote('Lot 12\u0007\u0000 Rose Street');
    expect(/[\u0000-\u001f\u007f]/.test(quote)).toBe(false);
    expect(quote).toContain('Rose');
  });

  it('falls back to the first real lines rather than inventing one', () => {
    expect(coverIdentityQuote('Aurora Homes\nPricing Schedule 2026'))
      .toBe('Aurora Homes \u2014 Pricing Schedule 2026');
  });

  it('says nothing when there is nothing to quote', () => {
    for (const empty of ['', '   ', '\n\n', null, undefined]) {
      expect(coverIdentityQuote(empty as string)).toBe('');
    }
  });
});
