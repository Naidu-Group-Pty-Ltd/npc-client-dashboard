/**
 * Which of a property's stored photographs a client report may carry.
 *
 * ## Why this exists
 *
 * Five of the fifty Investment Compass masters were designed to carry the
 * property's own photographs — a cover hero on three, full-page plates on five —
 * and bind them as `property.images.N`. The binding was written "forward-looking"
 * on purpose (`platePage`'s header): the day an adapter carries photographs,
 * every plate fills itself with no template change. No adapter ever did, so
 * every report that came from a listing printed its cover with no picture on it
 * while the listing's photographs sat in the image library, stored, signed,
 * de-duplicated and classified.
 *
 * Hero Image Studio is not that path. Its placements are read by the standard
 * presentation alone, onto a figures page after the body, and only when the
 * operator switches them on; the template-drawn document — the one a client
 * receives — never read them.
 *
 * ## The rule: the gallery's own judgement, tightened for a document
 *
 * A marketplace gallery and a client's report answer different questions, and
 * they differ in what an absence costs:
 *
 *  - A gallery must never blank a card, so `bandOf` DEMOTES and never filters:
 *    a floor plan, a graphic or a photograph other listings also hold keeps a
 *    place at the back (`docs/listings/IMAGE_LIBRARY.md`).
 *  - A report has a designed absence. Every photo slot is conditional, and an
 *    unfilled one prints nothing at all. So the cost of leaving a picture out
 *    is a cover without a photograph, and the cost of putting the wrong one in
 *    is somebody else's house on a client's document. The second is the one to
 *    refuse.
 *
 * So a report takes, in the gallery's own order and after its de-duplication:
 *
 *  1. **Positive evidence that it is a photograph** — `visual_kind = 'photo'`,
 *     the server's own verdict on the pixels. An image nobody has looked at yet
 *     can be a floor plan behind an opaque Google Drive id; 6 of 16 sampled
 *     heroes once were. Where the analysis has not run, nothing is taken.
 *  2. **Nothing the gallery would demote** — `bandOf` must say `standard`: not
 *     a graphic, not chrome, not a thumbnail, and not a photograph another
 *     listing also holds, which is how a stock render led seventeen listings.
 *     If the reuse reading cannot be taken at all, nothing is taken either,
 *     because "unique" cannot be read from a failure.
 *  3. **Enough pixels to print** — a picture known to be under
 *     `MIN_PRINT_LONG_EDGE_PX` on its long side is set at the size of a page
 *     plate by these masters and prints soft. Unknown dimensions are not
 *     evidence of either, and pass.
 *
 * Duplicate intake RECORDS of one property share every photograph, so rule 2
 * leaves such a property with none. That is the conservative side on purpose,
 * and it is recorded rather than worked around: telling a duplicate record from
 * a stock render needs the other listing's address, which the reuse reading
 * does not carry.
 *
 * Pure: no fetch, no storage, no clock. The edge function reads the rows and
 * signs what this returns.
 */
import { bandOf, selectListingGallery } from './listingImageSelection.pure.ts';

/** The most photographs any master binds (`six_with_bleed`: a cover and five plates). */
export const REPORT_PHOTOGRAPH_LIMIT = 6;

/**
 * Below this on its long edge, a photograph is known to print soft at plate size.
 *
 * A plate is drawn to the page (≈ 210 mm) or inset to the margin (≈ 175 mm). At
 * 1,000 px that is ~120–145 dpi: the web rendition a listing portal serves
 * (1,024 px is the common one) still reads as a photograph on paper, and the
 * 640–800 px strip renditions below it read as a screen grab.
 */
export const MIN_PRINT_LONG_EDGE_PX = 1000;

/** The `listing_images` columns this reads. Every one exists (`20260817000000`, `20260923000000`). */
export const REPORT_PHOTOGRAPH_COLUMNS =
  'listing_id, image_identity, storage_path, position, status, width, height, bytes, checksum, source_url, visual_kind, visual_signature';

export interface StoredListingPhotograph {
  listing_id: string;
  image_identity: string;
  storage_path: string | null;
  position: number | null;
  status: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  checksum: string | null;
  source_url: string | null;
  visual_kind: string | null;
  visual_signature: string | null;
}

/** One row of `listing_image_reuse(p_listing_ids)`. */
export interface ListingImageReuseRow {
  listing_id: string;
  image_identity: string;
  checksum_listings: number | null;
  signature_listings: number | null;
}

export interface ReportPhotograph {
  storagePath: string;
  width: number | null;
  height: number | null;
}

/**
 * How many listings hold each photograph, keyed `${listing_id}:${image_identity}`.
 *
 * Whichever measure saw it on more listings wins — the checksum catches an
 * identical file, the signature the same picture re-encoded. The same reading
 * `listing-images` takes for the marketplace.
 */
export function sharedListingCounts(rows: readonly ListingImageReuseRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const shared = Math.max(Number(row.checksum_listings) || 1, Number(row.signature_listings) || 1);
    out.set(`${row.listing_id}:${row.image_identity}`, shared);
  }
  return out;
}

const knownPositive = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The photographs a report may carry, lead first.
 *
 * `reuse` is null when the reuse reading could not be taken, and then nothing
 * is returned (rule 2).
 */
export function photographsForReport(
  rows: readonly StoredListingPhotograph[] | null | undefined,
  reuse: ReadonlyMap<string, number> | null,
  limit = REPORT_PHOTOGRAPH_LIMIT,
): ReportPhotograph[] {
  if (!reuse || !rows?.length) return [];
  // The gallery ranks by the order it is handed, which the marketplace's query
  // makes the editorial order. Sorted here as well, so this rule does not
  // depend on its caller's ORDER BY: position 0 is the agent's hero shot.
  const byPosition = [...rows].sort((a, b) =>
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  const candidates = byPosition
    .filter((row) => row.status === 'stored' && Boolean(row.storage_path) && row.visual_kind === 'photo')
    .map((row) => ({
      // The selector reasons about the source, never the storage path: the path
      // is a digest of the identity, which is what differs between two copies.
      url: row.source_url ?? row.storage_path ?? row.image_identity,
      position: row.position,
      checksum: row.checksum,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      kind: 'photo' as const,
      signature: row.visual_signature,
      sharedListings: reuse.get(`${row.listing_id}:${row.image_identity}`) ?? null,
      row,
    }));
  if (!candidates.length) return [];

  return selectListingGallery(candidates).images
    .filter((image) => bandOf(image) === 'standard')
    .filter((image) => {
      const { width, height } = image.row;
      return !(knownPositive(width) && knownPositive(height) && Math.max(width, height) < MIN_PRINT_LONG_EDGE_PX);
    })
    .slice(0, Math.max(0, limit))
    .map((image) => ({
      storagePath: image.row.storage_path as string,
      width: image.row.width,
      height: image.row.height,
    }));
}
