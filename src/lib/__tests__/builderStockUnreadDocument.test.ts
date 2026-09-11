/**
 * Builder stock — "we never read it" is not "it has no picture".
 *
 * THE REPORT, VERBATIM: the card said "No picture in the documents" with the
 * tooltip "Every document on this row was read and none of them presents a
 * photograph of this property" — about six brochures that each hold a facade
 * render this same extractor elects in about a second. Every one of those
 * statements was false. The worker had died reading them, and the failure was
 * reported as the builder's document being empty.
 *
 * The operator's rule for the fix: a genuine inspected exhaustion may say "no
 * picture in the supplied documents"; an operational retirement must say
 * something else entirely — and neither may ever expose a crash, a memory
 * error, a CPU limit or a retry count to the front end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  STOCK_IMAGE_PROGRESS_BADGE, STOCK_IMAGE_PROGRESS_DETAIL, STOCK_IMAGE_PROGRESS_LABEL,
  stockImageProgress, unreadDocumentCount,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';

const settled = { hasImage: false, sourceDocuments: 3, workStage: 'settled' };

describe('the four states a pictureless row can honestly be in', () => {
  it('a row still being worked says so', () => {
    expect(stockImageProgress({ ...settled, workStage: 'source' })).toBe('working');
  });

  it('a row with no documents names the act that would fix it', () => {
    expect(stockImageProgress({ ...settled, sourceDocuments: 0 })).toBe('no_document');
  });

  it('documents READ and empty is the only state that may claim so', () => {
    expect(stockImageProgress({ ...settled, unreadDocuments: 0 })).toBe('none_found');
  });

  it('a document OUR processing failed on is its own state, never "no picture"', () => {
    expect(stockImageProgress({ ...settled, unprocessedDocuments: 1 })).toBe('unreadable');
  });

  it('a document that could not be REACHED is a different state again', () => {
    // The one failure on this list a builder can act on, so it must not be
    // worded like the one they cannot.
    expect(stockImageProgress({ ...settled, unreachableDocuments: 1 }))
      .toBe('source_unavailable');
  });

  it('our own failure outranks a dead link, because ours asks nothing of them', () => {
    expect(stockImageProgress({
      ...settled, unprocessedDocuments: 1, unreachableDocuments: 1,
    })).toBe('unreadable');
  });

  it('one unread document among several outranks the others being empty', () => {
    // The row has NOT established that its documents name no picture while one
    // of them has never been opened.
    expect(stockImageProgress({ ...settled, sourceDocuments: 4, unprocessedDocuments: 1 }))
      .toBe('unreadable');
  });
});

describe('what those states are allowed to say out loud', () => {
  it('the unread state never claims the documents were checked', () => {
    const detail = STOCK_IMAGE_PROGRESS_DETAIL.unreadable;
    expect(detail).not.toMatch(/was read|were read|none of them presents/i);
    expect(STOCK_IMAGE_PROGRESS_LABEL.unreadable).not.toMatch(/no picture/i);
  });

  it('and never names a mechanism, a limit or a count', () => {
    // The operator's condition, asserted as a rule rather than trusted: none
    // of this pipeline's vocabulary may reach a builder's screen.
    const forbidden = [
      /crash/i, /memory/i, /\bCPU\b/i, /timed? ?out/i, /timeout/i, /worker/i,
      /isolate/i, /retry|retries|attempt/i, /\b\d+ ?MB\b/i, /resource limit/i,
      /exception/i, /stack/i, /5\d\d\b/,
    ];
    for (const [state, text] of Object.entries(STOCK_IMAGE_PROGRESS_DETAIL)) {
      for (const pattern of forbidden) {
        expect(text, `${state} detail must not match ${pattern}`).not.toMatch(pattern);
      }
    }
    for (const [state, text] of Object.entries(STOCK_IMAGE_PROGRESS_LABEL)) {
      for (const pattern of forbidden) {
        expect(text, `${state} label must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('OUR failure promises no retry and sends nobody to check their link', () => {
    /*
     * The first version of this state said "retried automatically" and "check
     * the link still opens" in one breath. Both were wrong: the retry is a
     * promise about our own release schedule, and the link is fine — sending
     * the builder to inspect a document that was never the problem is the
     * softer version of the lie this state exists to end.
     */
    const detail = STOCK_IMAGE_PROGRESS_DETAIL.unreadable;
    expect(detail).not.toMatch(/automatic|retr(y|ied|ies)/i);
    expect(detail).not.toMatch(/check the link|shared|moved|deleted/i);
  });

  it('and the dead-link state DOES point at the link, because that one is theirs', () => {
    const detail = STOCK_IMAGE_PROGRESS_DETAIL.source_unavailable;
    expect(detail).toMatch(/link/i);
    // But it never claims the document was read and found wanting.
    expect(detail).not.toMatch(/was read|were read|none of them presents/i);
  });

  it('neither failure state is worded as a finding about the document', () => {
    for (const state of ['unreadable', 'source_unavailable'] as const) {
      expect(STOCK_IMAGE_PROGRESS_LABEL[state]).not.toMatch(/no picture in/i);
    }
  });

  /*
   * REPORTED, 11 SEPTEMBER 2026: the Images column drew `No picture in the s…`
   * — a status that states nothing. The column is 15% of a table that renders
   * only at 1400px and up, which leaves 154px of text; that label wants 207px
   * and the dead-link one wants 220px.
   */
  it('says every state in a width the chip actually has', () => {
    // Measured in a browser against the built stylesheet at 154px. Held as a
    // character budget because a test cannot lay out text, and because the
    // two that overran did so by 35% and 43% — not by a rounding error.
    const BUDGET = 26;
    for (const [state, text] of Object.entries(STOCK_IMAGE_PROGRESS_BADGE)) {
      expect(text.length, `${state} badge is too long for the column`)
        .toBeLessThanOrEqual(BUDGET);
    }
  });

  it('shortens only the two that could not fit, and keeps the other four', () => {
    const shortened = (Object.keys(STOCK_IMAGE_PROGRESS_BADGE) as Array<
      keyof typeof STOCK_IMAGE_PROGRESS_BADGE>)
      .filter((state) => STOCK_IMAGE_PROGRESS_BADGE[state] !== STOCK_IMAGE_PROGRESS_LABEL[state]);
    expect(shortened.sort()).toEqual(['none_found', 'source_unavailable']);
  });

  it('keeps the six states tellable apart in the short form too', () => {
    const spoken = Object.values(STOCK_IMAGE_PROGRESS_BADGE);
    expect(new Set(spoken).size).toBe(spoken.length);
  });

  it('holds the short form to the same rules as the long one', () => {
    // A chip is not a licence to say something the sentence may not.
    expect(STOCK_IMAGE_PROGRESS_BADGE.unreadable).not.toMatch(/no picture/i);
    for (const state of ['unreadable', 'source_unavailable'] as const) {
      expect(STOCK_IMAGE_PROGRESS_BADGE[state]).not.toMatch(/no picture in/i);
    }
    // The dead link still points at the link; the inspected state still reads
    // as a finding. Shortening may not collapse them into one another.
    expect(STOCK_IMAGE_PROGRESS_BADGE.source_unavailable).toMatch(/link/i);
    expect(STOCK_IMAGE_PROGRESS_BADGE.none_found).toMatch(/no picture/i);
  });

  it('never loses the full sentence — the chip carries it as its name', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/builder/BuilderStockList.tsx'), 'utf8',
    );
    expect(source).toContain('STOCK_IMAGE_PROGRESS_BADGE[progress]');
    expect(source).toContain('<span className="sr-only">{STOCK_IMAGE_PROGRESS_LABEL[progress]}</span>');
  });

  it('the inspected state keeps its claim, because there it is true', () => {
    expect(STOCK_IMAGE_PROGRESS_DETAIL.none_found).toMatch(/was read|were read/i);
  });
});

describe('counting unread documents from stored provenance', () => {
  const branch = (over: Record<string, unknown>) => ({
    package_reference: 'https://drive.google.com/file/d/x/view',
    source_anchor: null, provenance_version: 23, ...over,
  });

  it('counts a killed branch as OURS — the shape the six were left in', () => {
    const stored = { branches: { a: branch({ result: 'package_recovery_attempt', attempts: 4 }) } };
    expect(unreadDocumentCount(stored)).toEqual({ unprocessed: 1, unreachable: 0 });
  });

  it('a STAMPED operational retirement is ours', () => {
    const stored = { branches: {
      a: branch({
        result: 'no_deterministic_image', exhaustion: 'operational', runtime_version: 1,
      }),
    } };
    expect(unreadDocumentCount(stored)).toEqual({ unprocessed: 1, unreachable: 0 });
  });

  it('an UNSTAMPED operational retirement is the link\'s', () => {
    // Both kinds are `operational`; the stamp is the only honest separator,
    // and it is the same field the runtime re-arm keys on — so the screen and
    // the queue cannot disagree about which documents are ours to fix.
    const stored = { branches: {
      a: branch({ result: 'no_deterministic_image', exhaustion: 'operational' }),
    } };
    expect(unreadDocumentCount(stored)).toEqual({ unprocessed: 0, unreachable: 1 });
  });

  it('does NOT count a document that answered, as either', () => {
    const stored = { branches: {
      a: branch({ result: 'no_deterministic_image', exhaustion: 'inspected' }),
      b: branch({ result: 'no_deterministic_image', exhaustion: 'inspected' }),
    } };
    expect(unreadDocumentCount(stored)).toEqual({ unprocessed: 0, unreachable: 0 });
  });

  it('is silent on anything it does not recognise rather than guessing', () => {
    for (const input of [null, {}, { branches: null }, 'nonsense']) {
      expect(unreadDocumentCount(input)).toEqual({ unprocessed: 0, unreachable: 0 });
    }
  });
});
