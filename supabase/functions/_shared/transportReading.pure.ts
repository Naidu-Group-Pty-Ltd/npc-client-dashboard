/**
 * What public transport is near a property, from the stops actually loaded.
 *
 * The service in front of this replaced audit §24's clearest fabricator: eight
 * per-state "fetchers" that ignored the coordinate and returned a hard-coded
 * landmark, so every NSW property was 450m from Central Station whatever its
 * position. It has answered `sourceUnavailable` since that removal; this is
 * the reading that finally has something real to say.
 *
 * ## The rule that governs an empty answer
 *
 * **A stop found is a fact about the area. No stop found is a fact about the
 * FEEDS.** `transport_stops` holds four networks — Greater Sydney and
 * regional NSW, South East Queensland, Darwin and Alice Springs — and nothing
 * else. A Perth property is not badly served by public transport; it is
 * outside every feed this platform has loaded, and saying "no stops nearby"
 * about it would be exactly the confident-answer-against-nothing failure this
 * programme has removed twice already (the sanctions register, the PEP
 * index).
 *
 * So the two are different answers and are never collapsed:
 *
 *  - inside a loaded network, nothing within the walk radius → a real finding,
 *    reported with the nearest stop and its distance;
 *  - outside every loaded network → `no_data_for_location`, naming the
 *    networks that ARE held so a reader can see why.
 *
 * Coverage is decided by MEASUREMENT rather than by a state name: a stop
 * within `COVERAGE_RADIUS_M` means a loaded feed reaches here. Deciding it
 * from `state` would claim coverage for all of NSW when the feed is Sydney
 * and the regional coach network, and would deny it to a border property that
 * a neighbouring network genuinely serves.
 *
 * ## Mode and frequency are absent, and say so
 *
 * A stop's mode lives in `routes.txt`, reachable only through
 * `stop_times.txt` — 399 MB uncompressed for NSW alone — so `route_type` is
 * NULL on every row loaded and this reading omits mode rather than guessing
 * one from a stop's name. Frequency is absent for the same reason. A reader
 * is told what is missing; nothing here invents it.
 */

/** Metres. Roughly a 20-minute walk, and the band the reading leads with. */
export const NEARBY_RADIUS_M = 1_600;

/**
 * Metres. Past this from every loaded stop, the coordinate is treated as
 * outside the loaded networks rather than as a place with no transport.
 *
 * 50 km is deliberately generous — far larger than any gap inside a served
 * network, and far smaller than the distance from an uncovered capital to the
 * nearest loaded one (Perth to the closest Alice Springs stop is ~1,900 km).
 */
export const COVERAGE_RADIUS_M = 50_000;

/** How many individual stops the reading names. */
export const MAX_NAMED_STOPS = 8;

/**
 * GTFS `location_type` values that are a place a passenger can board or a
 * station they would recognise. 2 (entrance), 3 (generic node) and 4
 * (boarding area) are structural points inside a station, not destinations,
 * and naming them would list "Wynyard Station Entrance 4" as a nearby stop.
 */
export const BOARDABLE_LOCATION_TYPES: readonly (number | null)[] = [null, 0, 1];

export interface StoredStop {
  readonly feed: string;
  readonly stop_id: string;
  readonly stop_name: string;
  readonly lat: number;
  readonly lon: number;
  readonly location_type: number | null;
  readonly parent_station: string | null;
  readonly route_type: number | null;
  readonly source_label: string;
}

export interface NearbyStop {
  readonly stopId: string;
  readonly name: string;
  readonly metres: number;
  readonly feed: string;
  /**
   * GTFS route_type where the feed established it, otherwise null. Null means
   * NOT ESTABLISHED and is rendered as an absence, never as "bus".
   */
  readonly routeType: number | null;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine on a spherical earth: at the scales this reports (metres to a few
 * kilometres) the error against the ellipsoid is well under a metre, and the
 * figure is rounded to the metre anyway.
 */
export function haversineMetres(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A latitude/longitude window that certainly contains everything within
 * `metres` of the point, for the indexed query that precedes the exact
 * distance test.
 *
 * It over-selects on purpose — a box always contains its inscribed circle —
 * because the box is a cheap filter and `haversineMetres` is the authority.
 * Longitude degrees shrink with latitude, so the longitude half-width is
 * divided by cos(lat); near the poles that diverges, and the clamp keeps it
 * finite. Australia never approaches the pole, so the clamp is a guard rather
 * than a working path.
 */
export function boundingBox(lat: number, lon: number, metres: number): {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
} {
  const degLat = metres / 111_320;
  const cos = Math.max(0.01, Math.cos(lat * Math.PI / 180));
  const degLon = metres / (111_320 * cos);
  return {
    minLat: lat - degLat,
    maxLat: lat + degLat,
    minLon: lon - degLon,
    maxLon: lon + degLon,
  };
}

export type TransportVerdict =
  /** Stops were found within the walk radius. */
  | 'stops_nearby'
  /** A loaded network reaches here, but nothing is within the walk radius. */
  | 'none_within_radius'
  /** No loaded network reaches here. Not a statement about the area. */
  | 'outside_loaded_networks';

export interface TransportReading {
  readonly verdict: TransportVerdict;
  /** Named stops, nearest first. Empty unless the verdict is `stops_nearby`. */
  readonly stops: NearbyStop[];
  /** How many boardable stops fell inside the walk radius. */
  readonly countWithinRadius: number;
  readonly radiusMetres: number;
  /**
   * The closest boardable stop in any loaded feed, however far. Present for
   * `none_within_radius` so the reading says something concrete rather than
   * only "nothing found"; null when nothing is loaded near enough to matter.
   */
  readonly nearest: NearbyStop | null;
  /** Feeds that contributed a stop to this reading. */
  readonly feeds: string[];
  /** Attribution for every feed that contributed. */
  readonly sources: string[];
  /**
   * What this reading cannot say, in words a report can print. Always
   * populated: mode and frequency are absent for every feed loaded.
   */
  readonly notMeasured: string[];
}

/** Stops a passenger could actually board at or would recognise as a station. */
export function boardable(stops: readonly StoredStop[]): StoredStop[] {
  return stops.filter((s) => BOARDABLE_LOCATION_TYPES.includes(s.location_type));
}

/**
 * Collapse a station and its platforms into the one place a reader would
 * name, keyed by the feed's OWN `parent_station`.
 *
 * This is not a tidy-up; without it the reading is wrong. Measured within
 * 1.6 km of the Parramatta test coordinate, `transport_stops` holds THIRTEEN
 * rows all carrying `parent_station: 215020` — "Parramatta Station, Platform
 * 1" through "Platform 4", "Stand A1", "Stand A2", "Stand B1" through "Stand
 * B3", "Darcy St", two "KAR Fizwilliam St" and a "TXI Fizwilliam St". "Church
 * Street Light Rail" is three rows and "Westfield Parramatta, Argyle St" is
 * two at an identical coordinate. A nearest-eight over the rows lists six
 * platforms of one station and calls them six stops, and a count reports
 * thirteen places where there is one.
 *
 * Grouping is by `parent_station ?? stop_id`, which is the publisher saying
 * these are one facility rather than us guessing it from names or distances —
 * the same reason `listingImage`'s asset key is trusted only inside one
 * listing. The group takes the STATION's name where the group contains one
 * (`location_type` 1), because "Parramatta Station" is what a reader knows
 * and "Parramatta Station, Stand B3" is an implementation detail, and it
 * takes the distance of its nearest member.
 */
export function groupToPlaces(stops: readonly StoredStop[]): StoredStop[] {
  const groups = new Map<string, StoredStop[]>();
  for (const s of stops) {
    const key = `${s.feed} ${s.parent_station ?? s.stop_id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s); else groups.set(key, [s]);
  }
  const out: StoredStop[] = [];
  for (const [, members] of groups) {
    const station = members.find((m) => m.location_type === 1);
    // The representative keeps the group's identity; the caller re-measures
    // distance across all members so a platform nearer than its station is
    // not reported as further away than it is.
    out.push(station ?? members[0]);
  }
  return out;
}

/**
 * The reading, from stops already fetched for a window around the point.
 *
 * `candidates` must be every boardable stop within `COVERAGE_RADIUS_M`; the
 * caller does the indexed box query and this does the exact distances, so the
 * distance rule lives in one place and is the same for the walk radius and
 * for the coverage test.
 */
export function readTransport(
  lat: number,
  lon: number,
  candidates: readonly StoredStop[],
  radiusMetres: number = NEARBY_RADIUS_M,
): TransportReading {
  const notMeasured = [
    'Mode of transport (train, bus, tram, ferry) is not published per stop in the feeds loaded '
    + 'and is not inferred from a stop name.',
    'Service frequency is not measured: it requires the timetable file, which is 399 MB uncompressed '
    + 'for the NSW feed alone.',
  ];

  // One place per station, not one per platform — see `groupToPlaces`. The
  // distance is the nearest MEMBER's, so a platform closer than its station
  // entrance is not reported as further away than it is.
  const usable = boardable(candidates);
  const nearestByGroup = new Map<string, number>();
  for (const s of usable) {
    const key = `${s.feed} ${s.parent_station ?? s.stop_id}`;
    const d = haversineMetres(lat, lon, s.lat, s.lon);
    const best = nearestByGroup.get(key);
    if (best === undefined || d < best) nearestByGroup.set(key, d);
  }

  const measured = groupToPlaces(usable)
    .map((s) => ({
      stopId: s.parent_station ?? s.stop_id,
      name: s.stop_name,
      metres: Math.round(nearestByGroup.get(`${s.feed} ${s.parent_station ?? s.stop_id}`) ?? Infinity),
      feed: s.feed,
      routeType: s.route_type,
      sourceLabel: s.source_label,
    }))
    .sort((a, b) => a.metres - b.metres);

  if (measured.length === 0) {
    // Nothing within the coverage radius at all. This says the loaded feeds
    // do not reach here, and deliberately says nothing about the area.
    return {
      verdict: 'outside_loaded_networks',
      stops: [],
      countWithinRadius: 0,
      radiusMetres,
      nearest: null,
      feeds: [],
      sources: [],
      notMeasured,
    };
  }

  const within = measured.filter((s) => s.metres <= radiusMetres);
  const strip = ({ sourceLabel: _ignored, ...rest }: typeof measured[number]): NearbyStop => rest;

  if (within.length === 0) {
    return {
      verdict: 'none_within_radius',
      stops: [],
      countWithinRadius: 0,
      radiusMetres,
      nearest: strip(measured[0]),
      feeds: [measured[0].feed],
      sources: [measured[0].sourceLabel],
      notMeasured,
    };
  }

  const named = within.slice(0, MAX_NAMED_STOPS);
  return {
    verdict: 'stops_nearby',
    stops: named.map(strip),
    countWithinRadius: within.length,
    radiusMetres,
    nearest: strip(within[0]),
    feeds: [...new Set(within.map((s) => s.feed))].sort(),
    sources: [...new Set(within.map((s) => s.sourceLabel))].sort(),
    notMeasured,
  };
}

/**
 * ME-5 items 14–15 — what a stored `location_intelligence.transport` may hold.
 *
 * The block used to be written from a per-state template: five constants that
 * ignored the coordinate, 822 of them naming Sydney's "Central Station" 450 m
 * away across all eight states and territories. Its keys — `qualityScore`,
 * `serviceFrequency`, `routeCoverage`, `transportTypes`, `accessibility`,
 * `summary` — are the fields a GTFS stops file cannot fill, which is exactly
 * why they came to be invented. **Naming a field the source cannot answer is
 * how a template gets written**, so this projection does not name them.
 *
 * The consuming edge function also read the transport service's whole
 * `{ success, data }` envelope as if it were the payload, so
 * `publicTransportData.stopsWithin1km.length` dereferenced undefined and threw
 * for every location a loaded feed covers. Taking a `TransportReading` rather
 * than an untyped body is what stops that recurring.
 */
export interface StoredTransportBlock {
  readonly nearestStation: string;
  /** Kilometres to the nearest boardable stop, or null when none was found. */
  readonly distanceToStation: number | null;
  readonly stopsWithin1km: number;
  readonly radiusMetres: number;
  readonly detailedStops: NearbyStop[];
  readonly verdict: TransportVerdict;
  readonly feeds: string[];
  readonly sources: string[];
  readonly notMeasured: string[];
  readonly source: 'gtfs';
}

/** Field names the template wrote that no stops feed can support. */
export const TEMPLATE_ONLY_TRANSPORT_FIELDS: readonly string[] = [
  'qualityScore', 'serviceFrequency', 'routeCoverage', 'transportTypes',
  'accessibility', 'realTimeAlerts', 'summary', 'distanceToStop', 'nearestStop',
];

/** Project a measured reading onto the block a report stores. */
export function projectTransportForLocationIntelligence(
  reading: TransportReading,
): StoredTransportBlock {
  return {
    nearestStation: reading.nearest?.name ?? 'N/A',
    distanceToStation: typeof reading.nearest?.metres === 'number'
      ? Math.round(reading.nearest.metres / 100) / 10
      : null,
    stopsWithin1km: reading.countWithinRadius,
    radiusMetres: reading.radiusMetres,
    detailedStops: reading.stops,
    verdict: reading.verdict,
    feeds: reading.feeds,
    sources: reading.sources,
    notMeasured: reading.notMeasured,
    source: 'gtfs',
  };
}

/**
 * ME-5 item 8 — a stop from another jurisdiction's feed is not local service.
 *
 * Reconstructing the transport reading for all 931 placed historical reports
 * against the 185,177 loaded stops turned up a trap that the verdict alone
 * cannot express. `nsw_sydney` is Transport for NSW's WHOLE bundle, not
 * Sydney's, and it carries the interstate rail and coach network — so a
 * Docklands property finds "Melbourne (Southern Cross) Station" 225 m away,
 * a Wodonga property finds NSW border-town buses, and a Lyneham property
 * finds NSW school services in Canberra.
 *
 * Every one of those is a real stop at a real distance. None of them measures
 * the network the property's residents actually use, because Victoria's and
 * the ACT's own feeds are not loaded. Measured:
 *
 * | state | reports with a stop within 1.6 km | in-jurisdiction | interstate only |
 * | --- | ---: | ---: | ---: |
 * | QLD | 221 | 221 | 0 |
 * | NSW | 123 | 123 | 0 |
 * | VIC | 6 | **0** | **6** |
 * | ACT | 4 | **0** | **4** |
 * | SA | 1 | **0** | **1** |
 *
 * So 344 of 931 carry a genuine local reading, and 11 would have been given a
 * misleading one — worse than the honest `outside_loaded_networks`, because a
 * Docklands property with trams every three minutes would have been reported
 * as having a single stop nearby.
 *
 * **A reading counts only where the feed's own jurisdiction contains the
 * property.** The rule lives here rather than at a call site because both the
 * live service and any backtest have to apply it identically.
 */
export const FEED_JURISDICTION: Readonly<Record<string, string>> = {
  nsw_sydney: 'NSW',
  qld_seq: 'QLD',
  nt_darwin: 'NT',
  nt_alice: 'NT',
};

/**
 * Do the feeds behind a reading actually cover the property's own jurisdiction?
 *
 * `null` for an unknown state — not knowing where a property is is a reason to
 * withhold the reading, never a reason to accept it.
 */
export function readingIsInJurisdiction(
  feeds: readonly string[],
  state: string | null | undefined,
): boolean {
  if (!state || !state.trim()) return false;
  const st = state.trim().toUpperCase();
  return feeds.some((feed) => FEED_JURISDICTION[feed] === st);
}
