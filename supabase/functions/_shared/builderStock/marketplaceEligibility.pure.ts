/**
 * Builder stock — the FOURTH question about an image.
 *
 * Three were already asked and answered, each by its own module, and none of
 * them is this one:
 *
 *   1  PROVENANCE   did these exact bytes come out of the builder's source?
 *                   (`sourceImages.ts`, and the hashes in `source_detail`)
 *   2  OWNERSHIP    can they be tied to THIS property deterministically?
 *                   (`sourceAssets.pure.ts`, the anchors, the page tree)
 *   3  ROLE         did the source present them as its primary image?
 *                   (`sourceImageRole.pure.ts`)
 *   4  DISPLAY      is that image one to put on a marketplace card?
 *
 * ALL THREE OF THE FIRST CAN ANSWER YES AND THE FOURTH STILL BE NO. Lot 13
 * Hummock Rise and Lot 1663 Ringer Street are exactly that: the builder's own
 * bytes, of that exact property, designated by the source as its listing image
 * — and the picture is the facade under green pills reading "Completed" and
 * "SMSF", a red one reading "$25,000 Rebate", and suburb and state banners.
 * Provenance is perfect and the card is still wrong.
 *
 * SO THE ANSWER IS RECORDED SEPARATELY AND NOTHING ELSE IS TOUCHED. The role
 * stays `primary_property`, because that is what the source said and falsifying
 * it to hide the picture would put a lie in the audit trail. What changes is
 * one extra fact stored beside it, and the display rule reads both.
 *
 * IT FAILS CLOSED, AND THAT IS THE POINT OF THE THIRD STATE. There are three
 * answers and not two:
 *
 *   eligible     measured, and carries no promotional treatment
 *   ineligible   measured, and does
 *   pending      NOT measured — an encoding no decoder here reads, a file that
 *                broke one, a picture past the resource ceiling
 *
 * `pending` is not `eligible`. An unreadable container, and an image this
 * classifier cannot confidently call clean, must never be a way for a marketing
 * tile to walk past the rule: "we could not tell" and "we looked and it was
 * clean" are different facts and are stored as different values. The card shows
 * nothing either way.
 *
 * ALL THREE ARE TERMINAL FOR THE VERSION THAT PRODUCED THEM. `pending` hides
 * the picture; it is not a request to try again on the next tick. What brings a
 * pending row back is the version below moving, which is how a better decoder
 * or a better classifier reaches images that were stored before it existed.
 *
 * WHAT MAY NOT HAPPEN WHEN AN IMAGE IS REFUSED OR PENDING. Nothing may take
 * its place except another image that independently passes all four questions
 * for the same property. Not an interior, not a floorplan, not a masterplan,
 * not a location map, not another lot's facade, and none of the location or
 * search stages. Where there is no such image, the card shows nothing.
 *
 * Pure: no imports, no IO, no clock.
 */

/**
 * Bumped when the decision would change for bytes already assessed.
 *
 * DELIBERATELY NOT `PROVENANCE_VERSION`. Provenance is about where bytes came
 * from and never changes when a display rule does; tying the two would mean
 * every classifier improvement re-fetched every source, and every source
 * change re-ran every classification. They move independently, and a row
 * carries both numbers.
 *
 *   1  first release: flat coloured blocks; prominent overlay typography
 *      regardless of colour or whether anything is drawn behind it; and a
 *      contrast-normalised second pass that reports `overlay_uncertain` rather
 *      than letting faint typography read as a clean picture
 *   2  a run of ink must be wide enough to be a LINE of type before it counts
 *      as one. A single 17x12px mark — foliage against sky, in the top corner
 *      of a recovered Sandpiper facade that carries no overlay at all —
 *      convicted a clean builder photograph and hid it. Every verdict version 1
 *      recorded was reached with that mark counting, so all of them are stale.
 *
 * IT HAS A SECOND HALF IN THE DATABASE. `builder_stock_settlement_target`
 * carries the version production is being brought TO, because the sweep's cron
 * job decides in SQL whether any work is left and SQL cannot see this constant.
 * A bump ships both: this number, and a migration calling
 * `set_builder_stock_eligibility_target` with the same one. A test reads the
 * migrations and fails when they disagree — a bump that ships only this half
 * changes new imports and silently leaves every stored image on the old rules.
 */
export const MARKETPLACE_ELIGIBILITY_VERSION = 2;

/** The three answers. `pending` is the one that keeps this failing closed. */
export type MarketplaceEligibilityState = 'eligible' | 'ineligible' | 'pending';

/** Why an image the source designated may not be drawn on a card. */
export type MarketplaceRejection =
  /** Measured, and carrying promotional treatment. */
  | 'annotated_marketing_tile'
  /**
   * Measured, and NOT established as clean.
   *
   * Something with the geometry of a line of type is faintly there, against
   * surroundings quiet enough that a photograph's own detail does not explain
   * it — but not strongly enough for the strict pass, whose thresholds are
   * fitted so no real photograph trips them. Hidden rather than refused.
   */
  | 'overlay_uncertain'
  /** Not measured: no decoder here reads this container. */
  | 'decoder_unsupported'
  /** Not measured: the decoder failed, or the picture was past its ceiling. */
  | 'decoder_failed';

/** What was measured, kept so a decision can be explained without re-reading. */
export interface MarketplaceOverlaySummary {
  largestShare: number;
  totalShare: number;
  regionCount: number;
  /** Tallest overlay text as a share of the picture's height, 0 for none. */
  textHeightShare: number;
  textLineCount: number;
  /** The same for the faint pass, which produces `overlay_uncertain`. */
  faintTextHeightShare: number;
  faintTextLineCount: number;
}

export interface MarketplaceEligibility {
  state: MarketplaceEligibilityState;
  reason: MarketplaceRejection | null;
  /** False when the container could not be decoded at all. */
  measured: boolean;
  overlay: MarketplaceOverlaySummary | null;
}

/** The eligibility of an image nothing could read. NOT displayable. */
export function unmeasured(
  reason: 'decoder_unsupported' | 'decoder_failed',
): MarketplaceEligibility {
  return { state: 'pending', reason, measured: false, overlay: null };
}

/**
 * Turn an overlay measurement into the display decision.
 *
 * One rule: a picture carrying promotional treatment laid over it is not a
 * card image. What counts as promotional treatment is
 * `marketingOverlay.pure.ts`, and it names no word, colour, font or position.
 */
export function decideMarketplaceEligibility(
  overlay:
    | {
      annotated: boolean;
      uncertain?: boolean;
      largestShare: number;
      totalShare: number;
      regionCount: number;
      textHeightShare: number;
      textLineCount: number;
      faintTextHeightShare?: number;
      faintTextLineCount?: number;
    }
    | null,
): MarketplaceEligibility {
  if (!overlay) return unmeasured('decoder_failed');
  const summary: MarketplaceOverlaySummary = {
    largestShare: overlay.largestShare,
    totalShare: overlay.totalShare,
    regionCount: overlay.regionCount,
    textHeightShare: overlay.textHeightShare,
    textLineCount: overlay.textLineCount,
    faintTextHeightShare: overlay.faintTextHeightShare ?? 0,
    faintTextLineCount: overlay.faintTextLineCount ?? 0,
  };
  if (overlay.annotated) {
    return {
      state: 'ineligible', reason: 'annotated_marketing_tile', measured: true, overlay: summary,
    };
  }
  /*
   * MEASURED, AND STILL NOT ELIGIBLE.
   *
   * `eligible` means the picture was analysed under the current algorithm AND
   * there is enough evidence that it carries no prominent overlay treatment.
   * Where the faint pass found the shape of a line of type against quiet
   * surroundings, that second half does not hold — so the picture is hidden as
   * `pending`, not passed as clean and not convicted as a tile.
   *
   * `measured` stays true: the pixels WERE read. What is missing is confidence,
   * not the decode, and the two are different facts.
   */
  if (overlay.uncertain) {
    return { state: 'pending', reason: 'overlay_uncertain', measured: true, overlay: summary };
  }
  return { state: 'eligible', reason: null, measured: true, overlay: summary };
}

/**
 * The `source_detail` keys the decision contributes.
 *
 * Stored beside the role rather than replacing anything in it, so a reader can
 * always see BOTH what the source said and what the marketplace did about it.
 * `marketplace_display_eligible` stays a boolean for anything already reading
 * it, and is true ONLY for the eligible state.
 */
export function marketplaceEligibilityDetail(
  eligibility: MarketplaceEligibility,
): Record<string, unknown> {
  return {
    marketplace_display_eligible: eligibility.state === 'eligible',
    marketplace_eligibility_state: eligibility.state,
    marketplace_rejection_reason: eligibility.reason,
    marketplace_measured: eligibility.measured,
    marketplace_overlay: eligibility.overlay
      ? {
        largest_share: eligibility.overlay.largestShare,
        total_share: eligibility.overlay.totalShare,
        region_count: eligibility.overlay.regionCount,
        text_height_share: eligibility.overlay.textHeightShare,
        text_line_count: eligibility.overlay.textLineCount,
        faint_text_height_share: eligibility.overlay.faintTextHeightShare,
        faint_text_line_count: eligibility.overlay.faintTextLineCount,
      }
      : null,
    marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION,
  };
}

/**
 * The stored state, or `pending` where none was ever made.
 *
 * AN UNJUDGED IMAGE IS PENDING, WHICH IS NOT ELIGIBLE. A row written before
 * this existed has not been judged, and treating "never looked" as "looked and
 * it was fine" is precisely the fail-open this module refuses. The autonomous
 * settler brings them all through assessment; until it has, their cards show
 * nothing.
 */
export function readMarketplaceState(
  sourceDetail: Record<string, unknown> | null | undefined,
): MarketplaceEligibilityState {
  const raw = (sourceDetail ?? {}).marketplace_eligibility_state;
  if (raw === 'eligible' || raw === 'ineligible' || raw === 'pending') return raw;
  // A row written by the first shape of this feature, which stored only the
  // boolean. True still means measured-and-clean; anything else is unjudged.
  return (sourceDetail ?? {}).marketplace_display_eligible === true ? 'eligible' : 'pending';
}

/** The version the stored decision was made under. 0 when never made. */
export function readEligibilityVersion(
  sourceDetail: Record<string, unknown> | null | undefined,
): number {
  const raw = (sourceDetail ?? {}).marketplace_eligibility_version;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** May this image be drawn on a card? ONLY an explicit `eligible` may. */
export function isMarketplaceEligible(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  return readMarketplaceState(sourceDetail) === 'eligible';
}

/**
 * Does this stored decision need making again?
 *
 * ONE TEST, AND IT IS THE VERSION. A row judged under the current algorithm is
 * finished with, whichever of the three answers it reached.
 *
 * INCLUDING `pending`, WHICH IS THE PART THAT WAS WRONG. A pending row used to
 * come back on every pass, on the reasoning that a better decoder might read it
 * next time. But a better decoder arrives with a version bump, never between
 * two ticks of the same one — so the row was re-downloaded, re-decoded and
 * re-refused every five minutes for ever, while the upload's marker said its
 * eligibility work was complete. The two statements contradicted each other,
 * and the sweep could never go quiet.
 *
 * So all three states are TERMINAL FOR THE VERSION THAT PRODUCED THEM. Pending
 * still hides the picture — that has not changed and is the whole point of the
 * third state — it simply stops being a reason to do the same work again.
 * Improving a decoder or the classifier means bumping
 * `MARKETPLACE_ELIGIBILITY_VERSION` (and the database-side target beside it),
 * which is what brings every one of them back for a real second look.
 *
 * A row that has never been judged reads as version 0, so it is outstanding.
 */
export function needsEligibilityAssessment(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  return readEligibilityVersion(sourceDetail) < MARKETPLACE_ELIGIBILITY_VERSION;
}
