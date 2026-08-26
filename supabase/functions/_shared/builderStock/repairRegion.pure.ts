/**
 * Builder stock — a repair region somebody established, persisted on the image.
 *
 * WHAT THIS IS. `sanitizeImage.ts` already accepts a `repairRegion` — a
 * rectangle, in fractions of the picture's own width and height, that the
 * caller has identified by means other than the detector. This module is the
 * other half of that: where such a rectangle is WRITTEN DOWN, so the ordinary
 * five-minute sweep can find it and act on it without anybody running anything.
 *
 * WHY IT HAS TO BE PERSISTED AT ALL. The detector's mask builder reads lines of
 * TYPE. A promotional plate whose lettering falls below the measuring
 * resolution, or whose plate is too close to black to separate from a shadowed
 * eave, produces no mask and no conviction — the picture measures clean and is
 * served with the plate on it. The only alternatives are to move a global
 * threshold, which was measured against real clean production facades and is
 * not safe, or to record the rectangle once against those exact bytes. This is
 * the second.
 *
 * IT IS ORDINARY IMAGE METADATA AND NOTHING MORE. It is a key in the same
 * `source_detail` document the derivative, the failure and the clearance live
 * in; it names no property, no builder and no file; and any image row may carry
 * one. Nothing reads it to decide whether a card may DRAW — it decides only
 * which pixels a repair rebuilds, and the repaired result still goes back
 * through the same classifier before it may be served.
 *
 * THE ORIGIN TEST IS THE SAME ONE A DERIVATIVE GETS, and here it matters more
 * than anywhere else in this family. A derivative bound to the wrong bytes
 * shows a stale picture; a REGION applied to the wrong bytes rebuilds a
 * rectangle of somebody's house from a model's imagination. So a region names
 * the SHA-256 it was measured on, that hash is compared exactly against what
 * the row currently holds, and a region that cannot prove its origin is not a
 * region. A builder who replaces the file has replaced the premise.
 *
 * Pure: no imports, no IO, no clock.
 */

/** Where the record lives inside `source_detail`. */
export const REPAIR_REGION_KEY = 'repair_region';

/** A rectangle, as fractions of the picture's own width and height. */
export interface RepairRegionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface StoredRepairRegion extends RepairRegionBox {
  /**
   * The bytes this rectangle was measured on. Required, never inferred.
   *
   * See the header: unlike every other record in this family, a region whose
   * origin cannot be proved does not merely mislead — it rebuilds pixels.
   */
  original_sha256: string;
  /**
   * How the rectangle came to be known, in prose, for whoever reads the row
   * next. Free text and never parsed: nothing branches on it.
   */
  established_by?: string;
  recorded_at?: string;
}

/** Within the frame, the right way round, and not empty. */
function wellFormed(box: RepairRegionBox): boolean {
  for (const value of [box.left, box.top, box.right, box.bottom]) {
    if (!Number.isFinite(value)) return false;
    if (value < 0 || value > 1) return false;
  }
  return box.right > box.left && box.bottom > box.top;
}

/**
 * Read a persisted region, if it is one this code may act on.
 *
 * Fails closed in every direction. A malformed, inverted, out-of-frame or
 * unattributable rectangle is treated exactly as no rectangle at all — the
 * picture goes on being judged by the detector alone, which is the behaviour
 * every image without a region already has.
 */
export function readRepairRegion(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): RepairRegionBox | null {
  const raw = (sourceDetail ?? {})[REPAIR_REGION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<StoredRepairRegion>;

  if (typeof record.original_sha256 !== 'string' || !record.original_sha256) return null;
  if (!originalSha256 || record.original_sha256 !== originalSha256) return null;

  const box: RepairRegionBox = {
    left: Number(record.left),
    top: Number(record.top),
    right: Number(record.right),
    bottom: Number(record.bottom),
  };
  if (!wellFormed(box)) return null;

  return box;
}
