import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';
import {
  COMMUTE_DESTINATION_UNKNOWN,
  COMMUTE_NO_ROUTE,
  resolveCbdDestination,
} from '../_shared/reports/location/cbdDestination.pure.ts';
import { projectTransportForLocationIntelligence } from '../_shared/transportReading.pure.ts';

import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { meteredFetch } from "../_shared/meteredFetch.ts";
import { assessAuPoint } from "../_shared/auGeoSanity.pure.ts";
import { buildAuGeocodeQuery } from "../_shared/auGeocodeQuery.pure.ts";
import { sourceUnavailable, isSourceUnavailable } from "../_shared/sourceUnavailable.pure.ts";
import { internalError } from '../_shared/errorResponse.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
  'Access-Control-Expose-Headers': 'x-correlation-id, x-tokens-used, x-tokens-reserved, x-tokens-estimated, x-duration-ms',
};

interface LocationIntelligenceInput {
  address: string;
  suburb?: string;
  postcode?: string;
  state?: string;
  lat?: number;
  lng?: number;
}

interface AmenityScore {
  category: string;
  count: number;
  nearest: string;
  distance: number;
  score: number;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);
  
  console.log('Location intelligence service invoked with method:', req.method);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    // SECURITY: Verify authentication
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const body = await req.json();
    const input: LocationIntelligenceInput = body;
    
    const { error: authError, userId } = await verifyAuth(supabase, req.headers, body);
    if (authError) {
      console.log('[location-intelligence-service] Auth failed:', authError);
      return createUnauthorizedResponse(authError, corsHeaders);
    }
    console.log(`[location-intelligence-service] Authenticated user: ${userId}`);
    console.log('Analyzing location intelligence for:', input.address);

    const googleMapsApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    
    if (!googleMapsApiKey) {
      // No key means no measurement, and no measurement means no data. The
      // old branch here answered with `generateMockLocationData` — invented
      // school names, an invented station, a Math.random() walk score and
      // Sydney's coordinates — as HTTP 200 `success: true`, which is how a
      // deployment with a missing credential shipped fiction into client
      // reports and reported itself healthy while doing it.
      console.warn('⚠️ GOOGLE_MAPS_API_KEY not configured — location intelligence unavailable.');
      return new Response(JSON.stringify(sourceUnavailable(
        'location-intelligence',
        'not_configured',
        'GOOGLE_MAPS_API_KEY is not configured — location intelligence is unavailable for this deployment.',
      )), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('✓ Google Maps API key found, fetching real data...');
    
    try {
      const location = await fetchLocationIntelligence(input, googleMapsApiKey);

      if (!location.resolved) {
        // Deliberately NOT the mock branch below. An address we cannot place
        // is a fact about this property; sample data is a fact about no
        // property, and the caller cannot tell them apart. Both report
        // consumers already guard on `success && data`, so this lands them in
        // the path they take when the service is unreachable — the location
        // section is absent, and `enhancedData.locationIntelligence` stays
        // undefined where the coverage flag can see it.
        console.warn('[location-intelligence-service] unresolved:', location.reason);
        return new Response(JSON.stringify({
          success: false,
          resolved: false,
          reason: location.reason,
          message: UNRESOLVED_MESSAGE[location.reason],
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log('✓ Location intelligence data fetched successfully');

      return new Response(JSON.stringify({ 
        success: true, 
        data: location.data,
        usingMockData: false 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (apiError) {
      // A provider failure is a fact about this request, and the caller can
      // retry it. Sample data is a fact about no property at all.
      console.error('❌ Google Maps API error:', apiError);
      return new Response(JSON.stringify(sourceUnavailable(
        'location-intelligence',
        'provider_error',
        `Google Maps could not be reached or answered unusably — location intelligence is unavailable for this request. (${apiError instanceof Error ? apiError.message : 'unknown error'})`,
      )), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

  } catch (error) {
    // This used to build a mock profile for a property at 'Unknown, 2000,
    // NSW' and return it 200 `success: true` — a crash dressed as data. A
    // crash is a 500.
    console.error('❌ Critical error in location intelligence service:', error);
    return new Response(JSON.stringify({
      ...internalError(error, 'location-intelligence-service'),
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

/**
 * Why an unresolved location is its own answer.
 *
 * Every figure below — the amenity counts, the nearest school, the walk
 * score, the CBD commute — is measured *from the coordinate*. A wrong
 * coordinate does not make them fail; it makes them describe somewhere else,
 * accurately, and there is nothing in the numbers for a reader to catch.
 * So the coordinate is a precondition, and when it cannot be established
 * this returns the reason instead of a profile.
 */
type UnresolvedReason = 'address_not_resolved' | 'supplied_coordinates_rejected';

const UNRESOLVED_MESSAGE: Record<UnresolvedReason, string> = {
  address_not_resolved:
    'The address could not be resolved to a location in Australia — location intelligence is unavailable for this property.',
  supplied_coordinates_rejected:
    'The supplied coordinates are not a location in Australia — location intelligence is unavailable for this property.',
};

type LocationIntelligenceResult =
  | { resolved: true; data: Record<string, unknown> }
  | { resolved: false; reason: UnresolvedReason };

async function fetchLocationIntelligence(
  input: LocationIntelligenceInput,
  apiKey: string,
): Promise<LocationIntelligenceResult> {
  let coordinates: { lat: number; lng: number } | null;
  let reason: UnresolvedReason;

  if (Number.isFinite(input.lat) && Number.isFinite(input.lng)) {
    // A supplied coordinate goes through the same gate as a fetched one.
    // These arrive from stored rows, and the stored rows are where the 183
    // out-of-country points live — trusting the caller here would let the
    // fault back in through the one door the fix did not cover.
    const verdict = assessAuPoint(input.lat as number, input.lng as number, input.state);
    coordinates = verdict.ok ? { lat: input.lat as number, lng: input.lng as number } : null;
    if (!coordinates) {
      console.warn(`[location-intelligence-service] supplied point rejected (${verdict.reason})`);
    }
    reason = 'supplied_coordinates_rejected';
  } else {
    coordinates = await geocodeAddress(input, apiKey);
    reason = 'address_not_resolved';
  }

  if (!coordinates) return { resolved: false, reason };

  console.log('Coordinates:', coordinates);

  // Fetch enhanced public transport data from dedicated service
  let publicTransportData: any = null;
  if (input.state) {
    try {
      console.log('Fetching detailed public transport data from public-transport-service...');
      // THIS deployment's own project, from the URL Supabase injects into every
      // function runtime -- never a literal.
      //
      // It was `https://<this repository's project>.supabase.co/...`, which is
      // correct in exactly one deployment and a cross-tenant call in every
      // other. A clone of this repository ships the same line and reaches back
      // into the origin project for every location lookup it serves: somebody
      // else's function, somebody else's rate limits, somebody else's bill, and
      // the clone's own `public-transport-service` never invoked at all.
      const projectUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
      if (!projectUrl) {
        throw new Error('SUPABASE_URL is unset — cannot resolve this project’s own functions');
      }
      const transportResponse = await fetch(
        `${projectUrl}/functions/v1/public-transport-service`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: coordinates.lat,
            lng: coordinates.lng,
            state: input.state,
            suburb: input.suburb
          })
        }
      );
      
      if (transportResponse.ok) {
        const transportBody = await transportResponse.json();
        // The transport service historically answered with a bare payload —
        // no `success` wrapper — so its new refusal envelope would read as a
        // payload full of undefineds here, and `transportInfo` below would
        // have preferred it over Google's real, coordinate-measured transit
        // results. An honest refusal must leave the real fallback standing.
        if (isSourceUnavailable(transportBody)) {
          console.log('Public transport service unavailable, will use Google transit data');
        } else if (transportBody?.success === true && transportBody.data) {
          // The service answers `{ success, data: { ... } }`. This used to take
          // the ENVELOPE, so `publicTransportData.stopsWithin1km.length` below
          // dereferenced undefined and threw for every location a loaded GTFS
          // feed covers — Sydney, south-east Queensland, Darwin, Alice Springs.
          publicTransportData = transportBody.data;
          console.log('✓ Public transport data fetched successfully');
        } else {
          console.warn('Public transport service returned an unrecognised body; using Google data');
        }
      } else {
        console.warn('Public transport service returned error, will use Google data');
      }
    } catch (error) {
      console.error('Error fetching public transport data:', error);
    }
  }

  // Fetch all location intelligence data in parallel
  const [
    transitData,
    schoolsData,
    healthcareData,
    shoppingData,
    recreationData,
    restaurantsData
  ] = await Promise.all([
    fetchNearbyPlaces(coordinates, 'transit_station', apiKey),
    fetchNearbyPlaces(coordinates, 'school', apiKey),
    fetchNearbyPlaces(coordinates, 'hospital', apiKey),
    fetchNearbyPlaces(coordinates, 'shopping_mall', apiKey),
    fetchNearbyPlaces(coordinates, 'park', apiKey),
    fetchNearbyPlaces(coordinates, 'restaurant', apiKey)
  ]);

  // Calculate CBD commute time. No state means no known destination, and a
  // guessed destination is what put a Perth property 82 hours from "the CBD".
  const cbdCoordinates = resolveCbdDestination(input.state);
  const commuteData = cbdCoordinates
    ? await calculateCommuteTime(coordinates, cbdCoordinates, apiKey)
    : COMMUTE_DESTINATION_UNKNOWN;

  // Calculate walk score and lifestyle score - enhanced with real transport data
  const walkScore = calculateWalkScore({
    transit: transitData,
    schools: schoolsData,
    healthcare: healthcareData,
    shopping: shoppingData,
    recreation: recreationData,
    restaurants: restaurantsData
  });

  const amenityScores = calculateAmenityScores({
    transit: transitData,
    schools: schoolsData,
    healthcare: healthcareData,
    shopping: shoppingData,
    recreation: recreationData,
    restaurants: restaurantsData
  });

  // Use the GTFS reading where a loaded feed covers the location, otherwise the
  // coordinate-measured Google Places result.
  //
  // What is deliberately NOT written here any more: `qualityScore`,
  // `serviceFrequency`, `routeCoverage`, `transportTypes`, `accessibility` and
  // `summary`. Those were the per-state template — five constants that ignored
  // the coordinate, 822 of them naming Sydney's Central Station across all
  // eight states — and the GTFS service publishes none of them, because a
  // stops file carries no mode, no frequency and no rating. Naming a field the
  // source cannot fill is how the template got written in the first place.
  const transportInfo = publicTransportData ? {
    ...projectTransportForLocationIntelligence({
      verdict: publicTransportData.verdict,
      stops: publicTransportData.stops ?? [],
      countWithinRadius: publicTransportData.stopsWithinRadius ?? 0,
      radiusMetres: publicTransportData.radiusMetres ?? 0,
      nearest: publicTransportData.nearest ?? null,
      feeds: publicTransportData.feeds ?? [],
      sources: publicTransportData.sources ?? [],
      notMeasured: publicTransportData.notMeasured ?? [],
    }),
  } : {
    nearestStation: transitData.results[0]?.name || 'N/A',
    distanceToStation: transitData.results[0]?.distance ?? null,
    stationsWithin2km: transitData.count,
    source: 'google_places',
  };

  const data = {
    coordinates,
    commute: commuteData,
    walkScore,
    amenities: amenityScores,
    transport: transportInfo,
    schools: {
      nearestSchool: schoolsData.results[0]?.name || 'N/A',
      distanceToSchool: schoolsData.results[0]?.distance || 0,
      schoolsWithin3km: schoolsData.count,
      topSchools: schoolsData.results.slice(0, 5).map((s: any) => ({
        name: s.name,
        distance: s.distance,
        rating: s.rating
      }))
    },
    healthcare: {
      nearestHospital: healthcareData.results[0]?.name || 'N/A',
      distanceToHospital: healthcareData.results[0]?.distance || 0,
      facilitiesWithin5km: healthcareData.count
    },
    lifestyle: {
      shoppingCenters: shoppingData.count,
      parks: recreationData.count,
      restaurants: restaurantsData.count,
      nearestShopping: shoppingData.results[0]?.name || 'N/A',
      nearestPark: recreationData.results[0]?.name || 'N/A'
    }
  };

  return { resolved: true, data };
}

/**
 * Resolve an address to a coordinate, or to nothing.
 *
 * **183 of the 1,112 stored reports that carry a coordinate carry one outside
 * Australia** — Blacksburg Virginia, Manhattan, Knoxville, Bristol,
 * Edinburgh, Auckland, Ottawa, Bulacan — and **64 more carry Sydney CBD to
 * four decimal places**, which is this function's old failure value. Together
 * that is 22% of the corpus. Four faults stacked, and each one produced a
 * confident, plausible, unfalsifiable answer rather than an error:
 *
 *  1. **The question had no locality.** `input.suburb`, `input.postcode` and
 *     `input.state` were all in hand and all spent elsewhere; the geocode got
 *     `input.address` alone, which for 768 of these rows is a bare street
 *     name. `Keystone Drive` is a real street in most English-speaking
 *     countries. This is the fault that caused 180 of the 183 —
 *     see `auGeocodeQuery.pure.ts` for the split.
 *  2. **The request carried no country filter.** `components=country:AU` is a
 *     filter; `region=au` is only a bias, and this had neither.
 *  3. **Nothing checked the answer.** Every property this product reports on
 *     is in Australia, which makes an unusually strong invariant available: a
 *     geocode in Edinburgh is not an unusual listing, it is a wrong answer.
 *  4. **Failure returned Sydney CBD.** Everything below then computed the
 *     schools, hospitals, parks, walk score and CBD commute *of Sydney* and
 *     returned them as the subject property's. Real Google data, correctly
 *     fetched, about a place up to 4,000km away, with nothing in the response
 *     to say so.
 *
 * Faults 1 and 2 are not alternatives. The filter alone only relocates the
 * error: `Keystone Drive` restricted to Australia resolves to some Keystone
 * Drive here, in the wrong suburb, inside the country box, past every gate.
 *
 * The gate is `assessAuPoint` — the same one `resolve-listing-coordinates`
 * applies, rather than a second bounding box written here: country bounds,
 * then the land mask (every rectangle around Australia contains sea), then
 * the record's own state when it names one.
 *
 * Unresolved returns **null**, and null means the location section is absent
 * rather than wrong. That is the trade this makes deliberately: a reader can
 * see an absent section, and cannot see a correct-looking figure measured
 * from the wrong continent.
 */
async function geocodeAddress(
  input: LocationIntelligenceInput,
  apiKey: string,
): Promise<{ lat: number; lng: number } | null> {
  // The suburb, postcode and state were already in hand — used for the CBD
  // lookup and the transport call, and withheld from the one request that
  // needed them. See `auGeocodeQuery.pure.ts` for the split that measures it.
  const address = buildAuGeocodeQuery(input);
  if (!address) {
    console.warn('[location-intelligence-service] no address to geocode');
    return null;
  }

  try {
    const params = new URLSearchParams({
      address,
      // A filter, not a bias. `region=au` alone would only have expressed a
      // preference, and this had neither.
      components: 'country:AU',
      region: 'au',
      key: apiKey,
    });
    const response = await meteredFetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`
    );

    if (!response.ok) {
      console.warn('[location-intelligence-service] geocode HTTP', response.status);
      return null;
    }

    const data = await response.json();
    const location = data?.results?.[0]?.geometry?.location;
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn('[location-intelligence-service] geocode returned no point:', data?.status ?? 'unknown');
      return null;
    }

    const verdict = assessAuPoint(lat, lng, input.state);
    if (!verdict.ok) {
      // Named rather than swallowed: `outside_australia`, `offshore` and
      // `wrong_state` are different faults with different remedies, and the
      // log is the only place anybody will see which one happened.
      console.warn(`[location-intelligence-service] geocode rejected (${verdict.reason}) for state ${input.state ?? 'unknown'}`);
      return null;
    }

    return { lat, lng };
  } catch (error) {
    console.error('Geocoding error:', error);
    return null;
  }
}

async function fetchNearbyPlaces(
  coordinates: { lat: number; lng: number },
  type: string,
  apiKey: string
) {
  try {
    const radius = type === 'school' ? 3000 : type === 'park' ? 2000 : 5000;
    const response = await meteredFetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${coordinates.lat},${coordinates.lng}&radius=${radius}&type=${type}&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch ${type} data`);
    }

    const data = await response.json();
    
    const results = (data.results || []).slice(0, 10).map((place: any) => {
      const distance = calculateDistance(
        coordinates.lat,
        coordinates.lng,
        place.geometry.location.lat,
        place.geometry.location.lng
      );

      return {
        name: place.name,
        address: place.vicinity,
        rating: place.rating || 0,
        distance: Math.round(distance * 100) / 100,
        userRatingsTotal: place.user_ratings_total || 0
      };
    });

    return {
      count: results.length,
      results: results.sort((a: any, b: any) => a.distance - b.distance)
    };
  } catch (error) {
    console.error(`Error fetching ${type}:`, error);
    return { count: 0, results: [] };
  }
}

async function calculateCommuteTime(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  apiKey: string
) {
  try {
    const response = await meteredFetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&mode=transit&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error('Distance matrix API failed');
    }

    const data = await response.json();
    
    // Better error handling for Google Maps API response structure
    if (data.rows && data.rows.length > 0 && data.rows[0].elements && data.rows[0].elements.length > 0) {
      const element = data.rows[0].elements[0];
      
      if (element.status === 'OK' && element.duration && element.distance) {
        return {
          durationMinutes: Math.round(element.duration.value / 60),
          distanceKm: Math.round(element.distance.value / 1000 * 10) / 10,
          mode: 'public_transit'
        };
      } else {
        console.warn('Distance Matrix API returned status:', element.status);
      }
    } else {
      console.warn('Distance Matrix API returned unexpected structure:', JSON.stringify(data));
    }
  } catch (error) {
    console.error('Commute calculation error:', error);
  }

  // No route was returned, so there is no commute to report.
  //
  // This used to fall through to `distance * 1.5` minutes of straight line and
  // store it as `mode: 'estimated'`: 438 of the 1,114 stored objects carry one,
  // averaging 10,125 minutes. A figure shaped like a journey with no journey
  // behind it is worse than none, because every reader downstream treats
  // `durationMinutes` as measured. Absent, not estimated.
  return COMMUTE_NO_ROUTE;
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}



function calculateWalkScore(amenities: any): number {
  let score = 0;
  
  // Transit accessibility (max 30 points), measured from the coordinate.
  //
  // This used to spend the whole 30 on `publicTransportData.qualityScore` — an
  // invented per-state constant taking five values across 1,108 stored reports.
  // The transport service no longer publishes one, and the branch is gone
  // rather than left dormant: a rating is not something a stops file can
  // support, so the only honest transit signal here is distance.
  if (amenities.transit.count > 0) {
    const nearestDistance = amenities.transit.results[0]?.distance || 999;
    if (nearestDistance < 0.5) score += 30;
    else if (nearestDistance < 1) score += 20;
    else if (nearestDistance < 2) score += 10;
  }

  // Shopping & dining (max 25 points)
  const commercialScore = Math.min(25, (amenities.shopping.count + amenities.restaurants.count / 2) * 2);
  score += commercialScore;

  // Schools & education (max 15 points)
  if (amenities.schools.count > 0) {
    score += Math.min(15, amenities.schools.count * 3);
  }

  // Healthcare (max 15 points)
  if (amenities.healthcare.count > 0) {
    score += Math.min(15, amenities.healthcare.count * 5);
  }

  // Recreation & parks (max 15 points)
  if (amenities.recreation.count > 0) {
    score += Math.min(15, amenities.recreation.count * 3);
  }

  return Math.min(100, Math.round(score));
}

function calculateAmenityScores(amenities: any): AmenityScore[] {
  const scores: AmenityScore[] = [];

  scores.push({
    category: 'Public Transport',
    count: amenities.transit.count,
    nearest: amenities.transit.results[0]?.name || 'N/A',
    distance: amenities.transit.results[0]?.distance || 0,
    score: Math.min(100, amenities.transit.count * 20)
  });

  scores.push({
    category: 'Schools',
    count: amenities.schools.count,
    nearest: amenities.schools.results[0]?.name || 'N/A',
    distance: amenities.schools.results[0]?.distance || 0,
    score: Math.min(100, amenities.schools.count * 10)
  });

  scores.push({
    category: 'Healthcare',
    count: amenities.healthcare.count,
    nearest: amenities.healthcare.results[0]?.name || 'N/A',
    distance: amenities.healthcare.results[0]?.distance || 0,
    score: Math.min(100, amenities.healthcare.count * 15)
  });

  scores.push({
    category: 'Shopping',
    count: amenities.shopping.count,
    nearest: amenities.shopping.results[0]?.name || 'N/A',
    distance: amenities.shopping.results[0]?.distance || 0,
    score: Math.min(100, amenities.shopping.count * 12)
  });

  scores.push({
    category: 'Recreation',
    count: amenities.recreation.count,
    nearest: amenities.recreation.results[0]?.name || 'N/A',
    distance: amenities.recreation.results[0]?.distance || 0,
    score: Math.min(100, amenities.recreation.count * 8)
  });

  return scores;
}
