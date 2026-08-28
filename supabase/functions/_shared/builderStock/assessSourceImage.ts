/**
 * Builder stock — running the marketplace display test over real bytes.
 *
 * The glue between the decoder and the decision, and the ONE place ingestion
 * calls. Every format reaches it: a Notion cover, a spreadsheet's embedded
 * media, a PDF's page raster, a DOCX hero, an HTML card's image, a linked
 * Drive package, a direct upload. They differ in how the bytes are found and
 * in nothing after that, which is why this takes bytes and knows nothing about
 * where they came from.
 *
 * IT IS ONLY EVER ASKED ABOUT A PRIMARY. An image the source did not designate
 * cannot be drawn on a card whatever it looks like, so measuring one would be
 * spending an inverse DCT to answer a question nobody asked.
 */
import { decodeThumbnailResult } from './sourceImageRaster.ts';
import { sha256Hex } from './rasterPng.ts';
import { readMarketingOverlay } from './marketingOverlay.pure.ts';
import {
  decideMarketplaceEligibility, marketplaceEligibilityDetail, unmeasured,
  type MarketplaceEligibility,
} from './marketplaceEligibility.pure.ts';
import { isPrimaryRole } from './sourceImageRole.pure.ts';

/**
 * Judge bytes the pipeline is about to store.
 *
 * NEVER THROWS AND NEVER FAILS OPEN. A decoder that cannot read a builder's
 * file must not fail their import — the bytes are stored, the provenance is
 * recorded and the role is unchanged — but it must not wave the picture
 * through either. An image that could not be measured comes back `pending`,
 * which the display rule treats as "not yet", and the eligibility version
 * brings it back for another look when the decoders grow.
 */
export async function assessMarketplaceEligibility(
  bytes: Uint8Array,
): Promise<MarketplaceEligibility> {
  try {
    const result = await decodeThumbnailResult(bytes);
    if (result.ok === false) {
      return unmeasured(
        result.reason === 'unsupported' ? 'decoder_unsupported' : 'decoder_failed');
    }
    return decideMarketplaceEligibility(readMarketingOverlay(result.thumbnail));
  } catch {
    return unmeasured('decoder_failed');
  }
}

/**
 * The `source_detail` keys to merge into a row being written, for an image
 * whose role is already known.
 *
 * A non-primary image is not measured and carries no decision: it was never a
 * candidate, and recording a display verdict for it would suggest it was.
 */
export async function eligibilityDetailFor(
  bytes: Uint8Array,
  role: unknown,
): Promise<Record<string, unknown>> {
  if (!isPrimaryRole(role)) return {};
  // The verdict names the bytes it judged, so a later re-store of different
  // bytes cannot inherit it — see `marketplaceEligibilityDetail`.
  return marketplaceEligibilityDetail(
    await assessMarketplaceEligibility(bytes), await sha256Hex(bytes));
}
