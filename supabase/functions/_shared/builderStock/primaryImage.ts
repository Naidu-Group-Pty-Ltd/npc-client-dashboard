/**
 * Builder stock — which image the marketplace card shows.
 *
 * ONE RULE, AND IT IS NOT A RANKING.
 *
 *   A Builder Stock property may display the image the BUILDER SUPPLIED, or no
 *   image at all.
 *
 * Nothing else qualifies. Not a Street View of the street, not a satellite
 * still of the lot, not a search result that might be the development — none
 * of them is a photograph of the property, and a card that shows one is
 * telling a client something untrue about a house they are being asked to buy.
 * The honest alternative to a builder's photograph is an empty frame, so an
 * empty frame is what the card gets.
 *
 * WHAT THIS REPLACES. The earlier rule was a priority list: source-supplied
 * first, then `google_maps`, then `internet_search`. It meant every property
 * whose builder gave us nothing still showed a picture — badged "Location
 * imagery", which reads as a photograph of the property to everyone who is not
 * reading the badge.
 *
 * The other two stages are still WRITTEN. They are provenance, they are how a
 * support question about a missing image gets answered, and the three-stage
 * schema is unchanged. They are simply never chosen.
 *
 * It lives apart from `images.ts` so it can be exercised directly: `images.ts`
 * reaches for Google and Perplexity and cannot be loaded outside the edge
 * runtime, and a rule nothing can test is a rule that drifts.
 */
import {
  comparePrimaryEvidence, isPrimaryRole, readStoredEvidenceLevel, readStoredRole,
} from './sourceImageRole.pure.ts';
import {
  isMarketplaceEligible, needsEligibilityAssessment,
} from './marketplaceEligibility.pure.ts';
import {
  servableClearanceFor, servableDerivativeFor,
} from './sanitizedDerivative.pure.ts';

/** The stage whose provenance is the builder's own document. */
export const SOURCE_SUPPLIED_STAGE = 'uploaded_document';
/** And the only verification that means "the builder gave us this". */
export const SOURCE_SUPPLIED_VERIFICATION = 'source_supplied';

/** The shape the rule needs. Anything else about an image is irrelevant here. */
export interface DisplayableImage {
  id: string;
  source_stage: string;
  verification_status?: string | null;
  processing_status?: string | null;
  position?: number | null;
  storage_path?: string | null;
  external_url?: string | null;
  /** Carries `role`: what the SOURCE presented this image as. */
  source_detail?: Record<string, unknown> | null;
}

/**
 * May this image be shown on a Builder Stock card?
 *
 * FIVE conditions, every time: the builder's own stage, the verification that
 * says so, a stage that actually completed, bytes to serve — and the role the
 * source gave it.
 *
 * THE ROLE IS THE ONE THAT WAS MISSING, and its absence is the whole defect.
 * The first four say "these exact bytes came out of the builder's source",
 * which was true of the bedroom render that Lot 537 Kirramingly Avenue showed
 * on its card. Only the fifth says "and the source presented this image as THIS
 * property's listing image", which was not true of it and is the only thing
 * that makes the badge "Builder supplied" mean what a client reads it to mean.
 *
 * An image with no recorded role is `unknown`, and `unknown` is never
 * displayable — including every row written before roles existed. Those are
 * demoted and re-derived by `reprocess_source_images` rather than trusted.
 */
export function isDisplayableSourceImage(image: DisplayableImage): boolean {
  return image.source_stage === SOURCE_SUPPLIED_STAGE
    && image.verification_status === SOURCE_SUPPLIED_VERIFICATION
    && image.processing_status === 'ready'
    && !!(image.storage_path || image.external_url)
    && isPrimaryRole(readStoredRole(image.source_detail))
    // And the sixth: the source designating it is not the same as it being a
    // picture to draw. A facade under a "$25,000 Rebate" ribbon passes all
    // five above. See `marketplaceEligibility.pure.ts`.
    //
    // OR THE SAME PHOTOGRAPH WITH THE RIBBON TAKEN OFF. A servable derivative
    // is that image's own pixels with the laid-over graphic removed and the
    // result re-measured by the same classifier that refused the original — so
    // it satisfies the display rule rather than bypassing it. It is NOT another
    // image: the record names the exact original by id and by SHA-256, and a
    // row whose object has since changed stops resolving one. See
    // `sanitizedDerivative.pure.ts`.
    //
    // OR THE SAME PHOTOGRAPH WITH NOTHING WRONG WITH IT. A clearance is the
    // precise inspection's finding that the coarse classifier convicted this
    // picture for a feature of the HOUSE — Lot 537 Kirramingly's white garage
    // door — and that there is no promotional treatment on it at all. It
    // serves the ORIGINAL, unaltered, because nothing needed changing. See
    // `overlayClearance.pure.ts`.
    && (isMarketplaceEligible(image.source_detail)
      || !!servableDerivativeFor(image.source_detail)
      || !!servableClearanceFor(image.source_detail));
}

/**
 * The card's image, from a property's images. Null means "show no image".
 *
 * There is normally exactly one candidate, because at most one image per
 * property can carry `primary_property`. Where a source supplies MORE than
 * one, the strength of the source's own evidence decides first — see
 * `comparePrimaryEvidence`.
 *
 * THE CASE THAT ADDED THAT STEP. A builder keeps a marketing tile in the row's
 * page-cover slot: the property's own facade with "$25,000 Rebate", "VIC" and
 * "LARA" set over it in coloured pills, or "Completed" and "SMSF". It is exact
 * builder-supplied imagery of that exact property, so it is correctly
 * `primary_property` on LEVEL 3 — a structural container designating one
 * image. Where the same property ALSO carries the clean original in a field
 * the builder named for it, that is LEVEL 1, and the level is the only thing
 * that distinguishes them: same property, same provenance, same role. Ordering
 * by `position` picked whichever the reader enumerated first.
 *
 * ORDERING IS NOT WHAT REFUSES A MARKETING TILE — the display gate above is,
 * through `isMarketplaceEligible`. An earlier version of this rule kept the
 * tile whenever the source designated nothing better, and that was wrong: a
 * facade under a status ribbon is not a card image however impeccable its
 * provenance. Ordering only decides between candidates that have ALREADY
 * passed the gate.
 *
 * `position` and then the id remain the tie-break, so re-running enrichment
 * cannot silently swap a card's picture.
 */
export function chooseDisplayableImage<T extends DisplayableImage>(images: T[]): T | null {
  const displayable = (images ?? []).filter(isDisplayableSourceImage);
  if (!displayable.length) return null;

  return [...displayable].sort((a, b) =>
    comparePrimaryEvidence(
      readStoredEvidenceLevel(a.source_detail), readStoredEvidenceLevel(b.source_detail))
    || (a.position ?? 0) - (b.position ?? 0)
    || String(a.id).localeCompare(String(b.id)))[0];
}

/**
 * Settle a property's `primary_image_id`.
 *
 * Returns the id chosen, or null when the builder supplied nothing — and in
 * that case the column is CLEARED rather than left pointing at whatever it
 * pointed at before. A stale pointer to a Street View is the defect; leaving
 * it in place because "nothing new was found" would preserve it.
 */
export async function chooseAndStorePrimaryImage(
  db: any,
  stockItemId: string,
): Promise<string | null> {
  const { data: images } = await db
    .from('builder_stock_item_images')
    .select('id, source_stage, verification_status, processing_status, position, storage_path, external_url, source_detail')
    .eq('stock_item_id', stockItemId);

  const primary = chooseDisplayableImage((images ?? []) as DisplayableImage[]);

  await db.from('builder_stock_items')
    .update({ primary_image_id: primary?.id ?? null })
    .eq('id', stockItemId);

  return primary?.id ?? null;
}

/**
 * Is this image still waiting for a display verdict?
 *
 * Only asked of images that could BE a card's picture. Anything else has no
 * verdict by design, and treating its absence as "unassessed" would freeze
 * every item that happens to hold a floorplan.
 */
function awaitingVerdict(image: DisplayableImage): boolean {
  if (image.source_stage !== SOURCE_SUPPLIED_STAGE) return false;
  if (image.verification_status !== SOURCE_SUPPLIED_VERIFICATION) return false;
  if (image.processing_status !== 'ready') return false;
  if (!isPrimaryRole(readStoredRole(image.source_detail))) return false;
  return needsEligibilityAssessment(image.source_detail);
}

/**
 * Apply the rule to every property an organisation holds — EXCEPT the ones
 * whose evidence is not in yet.
 *
 * Run at the end of a repair so that properties the repair never touched are
 * settled too: an item whose builder supplied nothing must END the run with no
 * primary image, not with the one it had before the rule changed.
 *
 * AN ITEM WHOSE IMAGES HAVE NOT ALL BEEN JUDGED IS SKIPPED ENTIRELY, and that
 * is the part that had to be added. The display rule fails closed, so an image
 * with no verdict is not displayable — which means this function, run over an
 * organisation whose eligibility backfill has not finished, would look at a
 * perfectly clean builder photograph, see no verdict, conclude the property has
 * nothing to show, and CLEAR its pointer. The backfill would then write
 * `eligible` onto an image nothing points at any more.
 *
 * Deciding per ITEM rather than per upload is what the schema requires: one
 * property's images can come from several uploads, so "this upload settled" is
 * not the same statement as "this property's candidates have all been judged".
 * Only the second one licenses a write.
 *
 * `skipped` is reported rather than swallowed: a caller that keeps seeing a
 * non-zero count is being told its backfill has not converged.
 */
export async function enforceStrictPrimaryImages(
  db: any,
  organisationId: string,
): Promise<{ inspected: number; cleared: number; corrected: number; skipped: number }> {
  const outcome = { inspected: 0, cleared: 0, corrected: 0, skipped: 0 };

  const { data: items } = await db
    .from('builder_stock_items')
    .select('id, primary_image_id')
    .eq('organisation_id', organisationId)
    .eq('lifecycle_status', 'active')
    .limit(20000);
  if (!items?.length) return outcome;

  const { data: images } = await db
    .from('builder_stock_item_images')
    .select('id, stock_item_id, source_stage, verification_status, processing_status, position, storage_path, external_url, source_detail')
    .eq('organisation_id', organisationId)
    .limit(200000);

  const byItem = new Map<string, DisplayableImage[]>();
  for (const image of (images ?? []) as Array<DisplayableImage & { stock_item_id: string }>) {
    const bucket = byItem.get(image.stock_item_id) ?? [];
    bucket.push(image);
    byItem.set(image.stock_item_id, bucket);
  }

  for (const item of items as Array<{ id: string; primary_image_id: string | null }>) {
    outcome.inspected += 1;
    const candidates = byItem.get(item.id) ?? [];

    // The evidence is not all in. Leave the pointer exactly as it is — right or
    // wrong — because clearing it now would lose a picture the backfill is
    // about to approve, and there is no signal here to tell the two apart.
    if (candidates.some(awaitingVerdict)) {
      outcome.skipped += 1;
      continue;
    }

    const chosen = chooseDisplayableImage(candidates);
    const next = chosen?.id ?? null;
    if (next === item.primary_image_id) continue;

    await db.from('builder_stock_items')
      .update({ primary_image_id: next })
      .eq('id', item.id);
    if (next === null) outcome.cleared += 1;
    else outcome.corrected += 1;
  }
  return outcome;
}
