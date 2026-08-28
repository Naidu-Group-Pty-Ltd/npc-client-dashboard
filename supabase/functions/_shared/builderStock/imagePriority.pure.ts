/**
 * Builder stock — WHICH PICTURE A CARD DRAWS, and in what order of preference.
 *
 * THE RULE THIS REPLACES was "the builder's own image, or nothing":
 * `chooseDisplayableImage` filtered to stage-1 source rows and returned null
 * for everything else. That was deliberate and it was right while the only
 * alternatives were an unverified search hit and a satellite tile — neither of
 * which is a photograph of the property, and both of which were being written
 * anyway. The cost was a marketplace of empty frames whenever a builder's
 * source carried no usable render.
 *
 * The rule is now a PRIORITY, and the ranking is the whole of it:
 *
 *   1  the builder's own file, measured clean or cleared
 *   2  the builder's own file with a promotional graphic rebuilt out of it
 *   3  a web-search photograph VERIFIED to be this exact property
 *   4  Street View of this exact address
 *   5  nothing
 *
 * FOUR THINGS THIS MODULE WILL NOT DO, and each is a defect it exists to
 * prevent rather than a preference:
 *
 * A FALLBACK NEVER OUTRANKS A SOURCE. Not a better-looking one, not a newer
 * one, not a higher-confidence one. If the builder supplied a usable picture
 * of the property, that is the picture — which is also what stops the
 * expensive stages from being worth running at all (`images.ts`).
 *
 * FINDING A URL IS NOT VERIFYING A PROPERTY. Every `internet_search` row this
 * system has ever written carries `verification_status: 'unverified'`, and
 * 439 of them exist in production. Those are candidates a model reported; not
 * one of them has been checked against the address. So displayability requires
 * a POSITIVE verification state that no historical row can have — see
 * `WEB_VERIFIED_VERIFICATION` — and the absence of one is never displayable.
 *
 * STREET VIEW IS OF AN ADDRESS, AND ONLY IF IT IS STREET VIEW. The existing
 * Google stage falls back from a Street View still to a satellite tile of the
 * same point. A satellite tile is not a photograph of a house and this ranking
 * does not treat it as one: `product` must say `streetview`.
 *
 * AND NOTHING HERE IS "BUILDER SUPPLIED" EXCEPT THE BUILDER'S OWN FILE. The
 * badge is derived from the same decision that picked the image, so the card
 * cannot say one thing while the ranking did another. See `provenanceOf`.
 *
 * Pure: no IO, no clock, no database.
 */
import {
  SOURCE_SUPPLIED_STAGE, SOURCE_SUPPLIED_VERIFICATION,
  chooseDisplayableImage, isDisplayableSourceImage, servesCleanOriginal,
  type DisplayableImage,
} from './primaryImage.ts';

/** Where a web-search image lives. Unchanged; its VERIFICATION is what is new. */
export const WEB_SEARCH_STAGE = 'internet_search';

/**
 * The verification a web-search row must carry to be shown.
 *
 * DELIBERATELY NOT `verified`, and not any value already in the table. Every
 * historical row is `unverified`; a value they might plausibly have been given
 * by some earlier code path would make this rule retroactive, and the one
 * thing it must never be is retroactive. A row reaches this state only by
 * passing `verifiedWebIdentity`, which is written at the moment the identity
 * evidence is recorded.
 */
export const WEB_VERIFIED_VERIFICATION = 'property_identity_verified';

/** Where location imagery lives, and the only product of it that is a photograph. */
export const STREET_VIEW_STAGE = 'google_maps';
export const STREET_VIEW_PRODUCT = 'streetview';

/** What a card may honestly say about where its picture came from. */
export type ImageProvenance = 'builder_supplied' | 'web_sourced' | 'street_view';

export interface RankedImage<T extends DisplayableImage = DisplayableImage> {
  image: T;
  /** 1 = clean source … 4 = Street View. Lower wins. */
  rank: number;
  provenance: ImageProvenance;
}

/**
 * Does this row carry a web-search result whose identity was actually checked?
 *
 * Every clause is a separate way the old `unverified` rows fail, and they fail
 * on the FIRST one: the verification state itself. The rest guard a row that
 * has the state but not the evidence behind it — which is what a partial write
 * or a hand-edited row looks like.
 */
export function isVerifiedWebImage(image: DisplayableImage): boolean {
  if (image.source_stage !== WEB_SEARCH_STAGE) return false;
  if (image.verification_status !== WEB_VERIFIED_VERIFICATION) return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;

  const detail = (image.source_detail ?? {}) as Record<string, unknown>;
  const identity = detail.property_identity as Record<string, unknown> | undefined;
  if (!identity || typeof identity !== 'object') return false;
  // The evidence that was actually matched, and what it was matched against.
  // A verification that cannot say what it checked is not one.
  if (!Array.isArray(identity.matched) || !identity.matched.length) return false;
  if (typeof identity.verified_at !== 'string' || !identity.verified_at) return false;
  return true;
}

/**
 * Is this a Street View still of the property's own address?
 *
 * `product` is the discriminator and it is checked positively: the same stage
 * also stores `staticmap` satellite tiles, which are location imagery and are
 * not a photograph of a house. A row with no product recorded is not treated
 * as Street View.
 */
export function isStreetViewImage(image: DisplayableImage): boolean {
  if (image.source_stage !== STREET_VIEW_STAGE) return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;
  const detail = (image.source_detail ?? {}) as Record<string, unknown>;
  if (detail.product !== STREET_VIEW_PRODUCT) return false;
  // Bound to a geocode of this property's address, not to a place name.
  return typeof detail.address === 'string' && !!detail.address
    && Number.isFinite(Number(detail.latitude))
    && Number.isFinite(Number(detail.longitude));
}

/**
 * Rank one row, or refuse it.
 *
 * The source tiers are decided by the EXISTING rules
 * (`isDisplayableSourceImage`, `servesCleanOriginal`) rather than by anything
 * restated here, so provenance, role and eligibility keep exactly the meaning
 * they already had.
 */
export function rankImage<T extends DisplayableImage>(image: T): RankedImage<T> | null {
  if (isDisplayableSourceImage(image)) {
    return {
      image,
      rank: servesCleanOriginal(image) ? 1 : 2,
      provenance: 'builder_supplied',
    };
  }
  if (isVerifiedWebImage(image)) return { image, rank: 3, provenance: 'web_sourced' };
  if (isStreetViewImage(image)) return { image, rank: 4, provenance: 'street_view' };
  return null;
}

/**
 * The picture this property shows, and what the card may say about it.
 *
 * Ties inside a tier are broken exactly as they always were — the source
 * evidence level first, then position, then id — by delegating tier 1/2 to
 * `chooseDisplayableImage`. A fallback tier has no evidence level to compare,
 * so position and id decide, which is stable and is all that is available.
 */
export function chooseCardImage<T extends DisplayableImage>(
  images: T[],
): RankedImage<T> | null {
  const ranked = (images ?? []).map(rankImage).filter(Boolean) as Array<RankedImage<T>>;
  if (!ranked.length) return null;

  const best = Math.min(...ranked.map((entry) => entry.rank));

  // Tiers 1 and 2 are the builder's own rows, and their ordering is the one
  // this programme already proved — including that a clean original outranks a
  // sanitized derivative of the same source.
  if (best <= 2) {
    const chosen = chooseDisplayableImage(ranked
      .filter((entry) => entry.rank <= 2)
      .map((entry) => entry.image));
    if (!chosen) return null;
    return {
      image: chosen,
      rank: servesCleanOriginal(chosen) ? 1 : 2,
      provenance: 'builder_supplied',
    };
  }

  return ranked
    .filter((entry) => entry.rank === best)
    .sort((a, b) =>
      (a.image.position ?? 0) - (b.image.position ?? 0)
      || String(a.image.id).localeCompare(String(b.image.id)))[0];
}

/** What the card says. Derived from the choice, never recorded beside it. */
export function provenanceOf(image: DisplayableImage): ImageProvenance | null {
  return rankImage(image)?.provenance ?? null;
}

/** The human label for a provenance. One place, so no surface can invent one. */
export const PROVENANCE_LABEL: Record<ImageProvenance, string> = {
  builder_supplied: 'Builder supplied',
  web_sourced: 'Web sourced',
  street_view: 'Street View',
};

/**
 * WHICH EXPENSIVE STAGE, IF ANY, THIS PROPERTY STILL NEEDS.
 *
 * The ordering rule that stops all three from being run and ranked afterwards:
 * a property with a usable source picture needs neither of the paid stages,
 * and one with a verified web photograph does not need Street View.
 *
 * `pending` is the case that must not be got wrong. A source image whose
 * display verdict has not been measured yet is EVIDENCE THAT HAS NOT ARRIVED,
 * not evidence of absence — spending a search on it is how a builder's own
 * render loses to a stock photo of somebody else's estate. So it answers
 * `wait`, and the caller tries again rather than paying.
 */
export type NextImageStage = 'none' | 'wait' | 'web_search' | 'street_view';

export function nextImageStage(
  images: DisplayableImage[],
  options: { sourceSettlementComplete: boolean },
): NextImageStage {
  const rows = images ?? [];
  if (rows.some((image) => isDisplayableSourceImage(image))) return 'none';

  /*
   * A source row that is still on its way to a verdict — stored but not yet
   * measured, or measured and now being repaired. Either way the question
   * "does this property have a picture of its own?" is unanswered.
   */
  const sourcePending = rows.some((image) =>
    image.source_stage === SOURCE_SUPPLIED_STAGE
    && image.verification_status === SOURCE_SUPPLIED_VERIFICATION
    && image.processing_status !== 'failed'
    && !isDisplayableSourceImage(image));
  if (sourcePending || !options.sourceSettlementComplete) return 'wait';

  /*
   * A STAGE THAT RAN AND FOUND NOTHING HAS BEEN TRIED.
   *
   * This used to count a stage as attempted only where it had left a `ready`
   * row, so a search that returned nothing — or returned only candidates the
   * identity check refused — read as a stage never run, and the ladder asked
   * for it again instead of moving down. Lot 1663 Ringer Street spent both of
   * its passes on `web_search`, was marked `failed`, and left the queue with
   * Street View NEVER ATTEMPTED; Lot 3 Yamanto and Lot 1342 Austin Estate the
   * same. All three showed blank on the live Marketplace with an untried stage
   * behind them. Any row for a stage is now the record that it ran.
   */
  if (rows.some((image) => isVerifiedWebImage(image))) return 'none';
  if (!rows.some((image) => image.source_stage === WEB_SEARCH_STAGE)) return 'web_search';

  if (rows.some((image) => isStreetViewImage(image))) return 'none';
  if (!rows.some((image) => image.source_stage === STREET_VIEW_STAGE)) return 'street_view';

  // Every stage has been tried and none produced a displayable picture.
  return 'none';
}
