/**
 * BUILDER STOCK — SOME OF A SOURCE BEING UNREADABLE IS NOT THE SOURCE BEING
 * UNREADABLE.
 *
 * A Google Sheets import asks two questions, and they have nothing to do with
 * each other:
 *
 *     CAN WE READ THE PROPERTY ROWS?          the requested gid's CSV
 *     CAN WE ALSO RECOVER THE LINK TARGETS?   the workbook export
 *
 * A document shared so that anyone with the link may view it answers the first
 * and can still refuse the second — measured on a live builder list, `gviz`
 * 200 and every `export?format=…` 401. Treating those as one question has two
 * bad answers available and this takes neither: failing the upload over
 * optional metadata, or telling a builder to go and change their Drive
 * sharing before the product will work.
 *
 * THE RULE. Rows readable is a successful import. Link targets unreadable is a
 * NON-BLOCKING SOURCE-ACCESS ERROR: recorded on the upload, shown in the
 * portal, and never a reason to stop. Image processing continues on whatever
 * sources ARE available, and the ladder falls through to verified web imagery
 * and Street View exactly as it does for a property whose builder supplied
 * nothing.
 *
 * AND UNAVAILABLE IS TERMINAL. "There may have been a brochure URL we could
 * not reach" is not pending work — nothing the system can do will turn it into
 * a URL — so it must never leave a property waiting. Zero recovered links is
 * zero stage 1 branches, which is the same arithmetic as a row that carries no
 * links at all.
 *
 * Pure: no IO, no clock, no network.
 */
import type { HyperlinkAvailability } from './sheetHyperlinks.pure.ts';

/**
 * The machine-readable condition. Behaviour keys on this and never on the
 * sentence below it, which is free to be reworded for tone.
 */
export const SOURCE_LINKS_UNAVAILABLE = 'google_sheets_source_links_unavailable';

export interface SourceAccessNotice {
  code: typeof SOURCE_LINKS_UNAVAILABLE;
  /** What the builder reads. Says all three things, in this order. */
  message: string;
  /** Which of the recoverable-from-public-source failures it was. */
  detail: { reason: HyperlinkAvailability };
}

/**
 * The one sentence the builder sees.
 *
 * It must say three things, because leaving any of them out sends somebody to
 * the wrong remedy: that some linked information could not be reached, that
 * the stock list imported anyway, and that image processing is carrying on by
 * itself. It deliberately does NOT ask anyone to change a sharing setting —
 * the rows were readable, so the link the builder pasted was sufficient, and
 * demanding a Drive change for optional metadata is the behaviour this exists
 * to prevent.
 */
const MESSAGE =
  'Some linked files in this Google Sheet could not be accessed, so a few '
  + 'builder-supplied documents may be unavailable. Your stock list imported '
  + 'successfully and image processing is continuing with the other sources '
  + 'available for each property.';

/**
 * Does this reading of a source warrant telling the builder?
 *
 * Only the three that are facts about ACCESS. `resolved` and `none_present`
 * are facts about the spreadsheet — the links were read, or the tab genuinely
 * has none — and there is nothing to report about either.
 */
export function sourceAccessNoticeFor(
  availability: HyperlinkAvailability | null | undefined,
): SourceAccessNotice | null {
  if (!availability) return null;
  if (availability === 'resolved' || availability === 'none_present') return null;
  return { code: SOURCE_LINKS_UNAVAILABLE, message: MESSAGE, detail: { reason: availability } };
}

/**
 * Is this upload's recorded error the non-blocking kind?
 *
 * The portal needs to tell a source-access notice from a real failure, and the
 * status is what separates them: a failed upload has `status = 'failed'` and
 * imported nothing. This never sets that — an upload carrying this code has
 * its rows, and saying otherwise would make a builder re-upload a list that
 * is already in.
 */
export function isNonBlockingSourceNotice(code: string | null | undefined): boolean {
  return code === SOURCE_LINKS_UNAVAILABLE;
}
