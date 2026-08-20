/**
 * Builder stock — a PDF's prose, one string per VISIBLE page.
 *
 * ONE implementation, because two callers need the same page numbering and a
 * disagreement between them is invisible. `extract.ts` reads a directly
 * uploaded PDF's text to find its properties; `packageImages.ts` reads a linked
 * package's text to find the page that presents the property as a package. If
 * those two numbered pages differently, a brochure uploaded through the portal
 * and the same brochure reached through a Notion row's link would attach
 * different pictures to the same house.
 *
 * `mergePages: false` is not an option here, it is the point: the page is the
 * only structure a PDF offers, and the merged string throws it away.
 *
 * pdf.js takes OWNERSHIP of the array it is handed and leaves the buffer
 * detached, which is why it is given its own copy — reading the text used to
 * empty the very bytes the photographs are then read out of.
 */

/**
 * The outcome of trying, which is NOT the same as the outcome of reading.
 *
 * This used to return `string[]` and an empty array on any failure, and that
 * one collapse cost 44 properties their photographs. The reader imports pdf.js
 * from a CDN at call time; when that import does not resolve in the edge
 * runtime the catch returned `[]`, the package path found no page it could read
 * as a property's cover, and answered `not_identified` — "we read the document
 * and it names no image for this property". It had read nothing at all.
 *
 * "This document has no text" and "we could not extract text from this
 * document" lead to opposite handling: the first is a finding a caller may act
 * on and record, the second is an operational fault that must be retried and
 * must never be written down as a verdict. So the caller is told which it got.
 */
export type PdfPageTextResult =
  | { ok: true; pages: string[] }
  | { ok: false; reason: string };

/**
 * The reader, loaded on demand. Its own function so the module's real types can
 * be inferred rather than restated — a hand-written signature here would be a
 * second opinion about a third-party API, and the narrower of the two wins.
 */
function loadPdfReader() {
  return import('https://esm.sh/unpdf@0.12.1');
}

/** Read every visible page's text, and say plainly if that could not be done. */
export async function readPdfPageTextResult(bytes: Uint8Array): Promise<PdfPageTextResult> {
  let reader: Awaited<ReturnType<typeof loadPdfReader>>;
  try {
    reader = await loadPdfReader();
  } catch (error) {
    // The reader itself is not here. Nothing has been learned about the PDF.
    return {
      ok: false,
      reason: `pdf text reader unavailable: ${String(
        (error as { message?: string })?.message ?? error).slice(0, 160)}`,
    };
  }

  try {
    const pdf = await reader.getDocumentProxy(bytes.slice());
    const { text } = await reader.extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [String(text ?? '')])
      .map((page) => String(page ?? ''));
    /*
     * Zero pages is not a document with nothing to say — a PDF always has
     * pages — so it is the reader failing quietly rather than the document
     * being empty. A scanned brochure with no text layer lands here too, and
     * "we cannot read this" is the honest answer for it as well.
     */
    if (!pages.length) return { ok: false, reason: 'pdf text reader returned no pages' };
    return { ok: true, pages };
  } catch (error) {
    return {
      ok: false,
      reason: `pdf text extraction failed: ${String(
        (error as { message?: string })?.message ?? error).slice(0, 160)}`,
    };
  }
}

/**
 * The text of each page, or an empty array.
 *
 * Kept for `extract.ts`, which already treats an empty result as a hard error
 * and raises `pdf_text_extraction_failed` — so the distinction above is one it
 * has always made for itself.
 */
export async function readPdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const result = await readPdfPageTextResult(bytes);
  return result.ok ? result.pages : [];
}
