/**
 * WHICH WAY THE STREET VIEW CAMERA SHOULD LOOK.
 *
 * Google's Street View still image API defaults to the panorama's own stored
 * orientation when no `heading` is given — which is the direction the capture
 * vehicle happened to be pointing, not the direction of the property. On
 * Lot 13 Hummock Rise, Werribee that produced a side-angle view of the lot:
 * a correct, exact-address photograph aimed down the street.
 *
 * The metadata call the stage already makes returns the PANORAMA's location,
 * and the geocode it already made returns the PROPERTY's location. The bearing
 * from the first to the second is the direction the camera has to face to look
 * at the house, and both numbers are already paid for — so this costs no extra
 * request.
 *
 * IT REFUSES RATHER THAN GUESSES. A missing panorama location, a non-finite
 * number, or a camera sitting essentially on top of the property gives no
 * meaningful direction, and a fabricated heading is worse than Google's
 * default: the default is at least a real orientation of a real panorama.
 * `null` means "send no heading", which preserves exactly the behaviour that
 * shipped before this existed.
 */

/** Below this the two points are the same place and no bearing is meaningful. */
export const MIN_HEADING_DISTANCE_METRES = 4;

export interface LatLng {
  lat: number;
  lng: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Metres between two coordinates. Equirectangular is ample at street scale. */
export function metresBetween(from: LatLng, to: LatLng): number {
  const earthRadius = 6_371_000;
  const meanLat = toRadians((from.lat + to.lat) / 2);
  const x = toRadians(to.lng - from.lng) * Math.cos(meanLat);
  const y = toRadians(to.lat - from.lat);
  return Math.sqrt(x * x + y * y) * earthRadius;
}

/** A finite pair, or null. Google returns these inside an untyped body. */
export function readLatLng(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The compass bearing FROM the panorama camera TO the property, 0-360.
 *
 * `null` where the inputs cannot support one, and the caller then sends no
 * heading at all rather than a made-up one.
 */
export function headingToProperty(
  panorama: LatLng | null,
  property: LatLng | null,
): number | null {
  if (!panorama || !property) return null;
  if (metresBetween(panorama, property) < MIN_HEADING_DISTANCE_METRES) return null;

  const fromLat = toRadians(panorama.lat);
  const toLat = toRadians(property.lat);
  const deltaLng = toRadians(property.lng - panorama.lng);

  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat)
    - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  if (!Number.isFinite(bearing)) return null;
  return Math.round(((bearing % 360) + 360) % 360);
}
