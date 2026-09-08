/**
 * BUILDER STOCK — "NO IMAGE YET" WAS THREE DIFFERENT ANSWERS IN ONE SENTENCE.
 *
 * THE REPORT, VERBATIM: "if there its running on the backend. There needs to
 * be some kind of indication to let the users know that its running on the
 * backend please wait or some kind of progress bar."
 *
 * PRODUCTION, 4 SEPTEMBER 2026. Three properties on one screen of the Stock
 * List, all three reading "No image yet":
 *
 *   Lot 5629 The Grove   a package recovery RUNNING, started 03:21
 *   Lot 521 Timbarra     four documents read at v13, none presents a cover
 *   Lot 123 Solara       three read, one of them an image rather than a package
 *
 * Only the first was worth waiting for and only the last two could be acted
 * on, and the page said the same six characters about all three. So the
 * reasonable conclusion — that the product had stopped — was the wrong one,
 * and the reasonable response to it was to upload the list again. That
 * happened twice that morning, and re-uploading is what destroyed a repaired
 * photograph a few hours earlier.
 *
 * Estates and lot numbers are the live file's.
 */
import { describe, expect, it } from 'vitest';

import {
  countArrivingUploads, countWorkingImages, stockImageProgress, uploadIsArriving,
  STOCK_IMAGE_PROGRESS_DETAIL, STOCK_IMAGE_PROGRESS_LABEL,
  type StockImageProgress,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';

describe('what a property can say about its picture', () => {
  it('says nothing is owed once the card has one', () => {
    expect(stockImageProgress({
      hasImage: true, sourceDocuments: 0, workStage: 'source',
    })).toBe('drawn');
  });

  it('says the engine is still working while a stage is outstanding', () => {
    // Lot 5629 The Grove, mid package recovery.
    expect(stockImageProgress({
      hasImage: false, sourceDocuments: 4, workStage: 'sanitization',
    })).toBe('working');
  });

  it('separates a read that found nothing from a row with nothing to read', () => {
    // Lot 521 Timbarra: four documents, every one inspected, no cover.
    expect(stockImageProgress({
      hasImage: false, sourceDocuments: 4, workStage: 'settled',
    })).toBe('none_found');

    // A row whose stock list attaches no document at all.
    expect(stockImageProgress({
      hasImage: false, sourceDocuments: 0, workStage: 'settled',
    })).toBe('no_document');
  });

  it('treats a stage it does not recognise as work, never as finished', () => {
    /*
     * The conservative side. A stage this module has not been taught about is
     * one the engine may still act on, and "no picture is coming" about a row
     * that is about to be photographed is the wrong half to be wrong on.
     */
    expect(stockImageProgress({
      hasImage: false, sourceDocuments: 1, workStage: 'a_stage_added_later',
    })).toBe('working');
  });

  it('does not invent progress for a server that sends no stage', () => {
    // The field arrived with this change. Older projections must read exactly
    // as they did — finished — rather than promising every pictureless row.
    for (const workStage of [undefined, null, '']) {
      expect(stockImageProgress({ hasImage: false, sourceDocuments: 2, workStage }))
        .toBe('none_found');
    }
  });

  it('counts only the properties that are actually being worked', () => {
    const page = [
      { hasImage: true, sourceDocuments: 1, workStage: 'settled' },
      { hasImage: false, sourceDocuments: 4, workStage: 'sanitization' },
      { hasImage: false, sourceDocuments: 4, workStage: 'eligibility' },
      { hasImage: false, sourceDocuments: 4, workStage: 'settled' },
      { hasImage: false, sourceDocuments: 0, workStage: 'settled' },
    ];

    expect(countWorkingImages(page)).toBe(2);
  });

  it('stops counting once the page has settled, so the polling can stop', () => {
    expect(countWorkingImages([
      { hasImage: true, sourceDocuments: 1, workStage: 'settled' },
      { hasImage: false, sourceDocuments: 0, workStage: 'settled' },
    ])).toBe(0);
  });
});

/*
 * A SECOND WAIT, ONE LEVEL UP.
 *
 * A replacement stock list writes its new properties STAGED — invisible until
 * their imagery has been looked for, which is what stops a marketplace
 * filling with blank cards mid-import. The cost is a window in which a file
 * that detected 125 rows lists 95, and nothing on the page accounts for the
 * other thirty. That window is exactly where somebody concludes the import
 * dropped their rows and uploads the file again.
 */
describe('stock lists still bringing properties in', () => {
  it('counts a list that is still being read or still finding images', () => {
    expect(countArrivingUploads([
      { status: 'parsing' },
      { status: 'enriching' },
      { status: 'complete' },
    ])).toBe(2);
  });

  it('never counts a list the builder deleted', () => {
    // Its rows are archived; nothing is arriving from it and saying otherwise
    // would leave the banner up for ever.
    expect(countArrivingUploads([
      { status: 'enriching', deleted_at: '2026-09-04T03:26:11Z' },
    ])).toBe(0);
  });

  it('stops counting once every list has finished, so the polling stops', () => {
    expect(countArrivingUploads([
      { status: 'complete' },
      { status: 'partially_complete' },
      { status: 'failed' },
    ])).toBe(0);
  });

  it('treats a status it does not recognise as finished', () => {
    /*
     * The opposite lean to a row's stage, and deliberately so: this one drives
     * an indefinite poll and a banner with no count behind it, so an unknown
     * value must not be able to leave either running for ever.
     */
    expect(uploadIsArriving('a_status_added_later')).toBe(false);
    expect(uploadIsArriving(null)).toBe(false);
    expect(uploadIsArriving(undefined)).toBe(false);
  });
});

describe('the words each state gets', () => {
  const states: StockImageProgress[] = ['drawn', 'working', 'no_document', 'none_found'];

  it('gives every state a label and a detail', () => {
    for (const state of states) {
      expect(STOCK_IMAGE_PROGRESS_LABEL[state]).toBeTruthy();
      expect(STOCK_IMAGE_PROGRESS_DETAIL[state]).toBeTruthy();
    }
  });

  it('never says a pipeline stage out loud', () => {
    /*
     * "sanitization", "eligibility" and "fallback" are this repository's
     * vocabulary. A builder waiting on a photograph is owed the fact that it
     * is coming, not a term they would have to look up — the same rule the AML
     * surfaces keep, where a test refuses database vocabulary in a rendered
     * field.
     */
    const shown = [
      ...Object.values(STOCK_IMAGE_PROGRESS_LABEL),
      ...Object.values(STOCK_IMAGE_PROGRESS_DETAIL),
    ].join(' ').toLowerCase();

    for (const term of ['sanitization', 'eligibility', 'fallback', 'settled', 'provenance']) {
      expect(shown).not.toContain(term);
    }
  });

  it('tells a person what to do where there is something to do', () => {
    // The two finished states are the ones somebody can act on, so each names
    // the act. A status nobody can act on is just an apology.
    expect(STOCK_IMAGE_PROGRESS_DETAIL.no_document).toMatch(/add a link/i);
    expect(STOCK_IMAGE_PROGRESS_DETAIL.none_found).toMatch(/add a picture/i);
    // And the one that needs no action says so instead of asking for one.
    expect(STOCK_IMAGE_PROGRESS_DETAIL.working).toMatch(/on its own/i);
  });
});
