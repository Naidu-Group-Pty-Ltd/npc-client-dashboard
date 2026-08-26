import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';

import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { meteredFetch } from "../_shared/meteredFetch.ts";
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
      console.warn('⚠️ Google Maps API key not configured. Using mock data.');
      const mockData = generateMockLocationData(input);
      return new Response(JSON.stringify({ 
        success: true, 
        data: mockData,
        usingMockData: true,
        message: 'Using sample data - Configure GOOGLE_MAPS_API_KEY for real data'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('✓ Google Maps API key found, fetching real data...');
    
    try {
      const locationData = await fetchLocationIntelligence(input, googleMapsApiKey);
      console.log('✓ Location intelligence data fetched successfully');
      
      return new Response(JSON.stringify({ 
        success: true, 
        data: locationData,
        usingMockData: false 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (apiError) {
      console.error('❌ Google Maps API error:', apiError);
      console.log('Falling back to mock data due to API error');
      
      const mockData = generateMockLocationData(input);
      return new Response(JSON.stringify({ 
        success: true, 
        data: mockData,
        usingMockData: true,
        message: 'Google Maps API error - using sample data',
        error: apiError instanceof Error ? apiError.message : 'Unknown API error'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

  } catch (error) {
    console.error('❌ Critical error in location intelligence service:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to analyze location';
    
    // Return mock data on critical error
    try {
      const mockData = generateMockLocationData({ address: 'Unknown', postcode: '2000', state: 'NSW' });
      return new Response(JSON.stringify({ 
        success: true,
        data: mockData,
        usingMockData: true,
        error: errorMessage,
        message: 'Error occurred - using sample data'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response(JSON.stringify({ 
        error: errorMessage,
        success: false 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
});

async function fetchLocationIntelligence(input: LocationIntelligenceInput, apiKey: string) {
  let coordinates: { lat: number; lng: number };

  // Get coordinates from address if not provided
  if (!input.lat || !input.lng) {
    coordinates = await geocodeAddress(input.address, apiKey);
  } else {
    coordinates = { lat: input.lat, lng: input.lng };
  }

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
        publicTransportData = await transportResponse.json();
        console.log('✓ Public transport data fetched successfully');
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

  // Calculate CBD commute time (using Sydney as default)
  const cbdCoordinates = getCBDCoordinates(input.state || 'NSW');
  const commuteData = await calculateCommuteTime(coordinates, cbdCoordinates, apiKey);

  // Calculate walk score and lifestyle score - enhanced with real transport data
  const walkScore = calculateWalkScore({
    transit: transitData,
    schools: schoolsData,
    healthcare: healthcareData,
    shopping: shoppingData,
    recreation: recreationData,
    restaurants: restaurantsData
  }, publicTransportData);

  const amenityScores = calculateAmenityScores({
    transit: transitData,
    schools: schoolsData,
    healthcare: healthcareData,
    shopping: shoppingData,
    recreation: recreationData,
    restaurants: restaurantsData
  });

  // Use enhanced public transport data if available, otherwise fall back to Google data
  const transportInfo = publicTransportData ? {
    nearestStop: publicTransportData.nearestStop,
    distanceToStop: publicTransportData.distanceToStop,
    stopsWithin1km: publicTransportData.stopsWithin1km.length,
    transportTypes: publicTransportData.transportTypes,
    routeCoverage: publicTransportData.routeCoverage,
    serviceFrequency: publicTransportData.serviceFrequency,
    accessibility: publicTransportData.accessibility,
    realTimeAlerts: publicTransportData.realTimeAlerts,
    qualityScore: publicTransportData.qualityScore,
    summary: publicTransportData.summary,
    detailedStops: publicTransportData.stopsWithin1km
  } : {
    nearestStation: transitData.results[0]?.name || 'N/A',
    distanceToStation: transitData.results[0]?.distance || 0,
    stationsWithin2km: transitData.count
  };

  return {
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
}

async function geocodeAddress(address: string, apiKey: string) {
  try {
    const encodedAddress = encodeURIComponent(address);
    const response = await meteredFetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`
    );

    if (!response.ok) {
      throw new Error('Geocoding failed');
    }

    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      const location = data.results[0].geometry.location;
      return { lat: location.lat, lng: location.lng };
    }
  } catch (error) {
    console.error('Geocoding error:', error);
  }

  // Return default Sydney coordinates if geocoding fails
  return { lat: -33.8688, lng: 151.2093 };
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

  // Return estimated data based on distance
  const distance = calculateDistance(origin.lat, origin.lng, destination.lat, destination.lng);
  return {
    durationMinutes: Math.round(distance * 1.5), // Rough estimate
    distanceKm: Math.round(distance * 10) / 10,
    mode: 'estimated'
  };
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

function getCBDCoordinates(state: string) {
  const cbdLocations: { [key: string]: { lat: number; lng: number } } = {
    'NSW': { lat: -33.8688, lng: 151.2093 }, // Sydney
    'VIC': { lat: -37.8136, lng: 144.9631 }, // Melbourne
    'QLD': { lat: -27.4698, lng: 153.0251 }, // Brisbane
    'WA': { lat: -31.9505, lng: 115.8605 }, // Perth
    'SA': { lat: -34.9285, lng: 138.6007 }, // Adelaide
    'TAS': { lat: -42.8821, lng: 147.3272 }, // Hobart
    'NT': { lat: -12.4634, lng: 130.8456 }, // Darwin
    'ACT': { lat: -35.2809, lng: 149.1300 }  // Canberra
  };

  return cbdLocations[state.toUpperCase()] || cbdLocations['NSW'];
}

function calculateWalkScore(amenities: any, publicTransportData?: any): number {
  let score = 0;
  
  // Transit accessibility (max 30 points) - enhanced with real transport data
  if (publicTransportData && publicTransportData.qualityScore) {
    // Use the detailed transport quality score for more accurate walk score
    score += (publicTransportData.qualityScore / 100) * 30;
  } else if (amenities.transit.count > 0) {
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

function generateMockLocationData(input: LocationIntelligenceInput) {
  return {
    coordinates: { lat: -33.8688, lng: 151.2093 },
    commute: {
      durationMinutes: Math.floor(Math.random() * 30) + 20,
      distanceKm: Math.floor(Math.random() * 20) + 5,
      mode: 'estimated'
    },
    walkScore: Math.floor(Math.random() * 40) + 60,
    amenities: [
      { category: 'Public Transport', count: 3, nearest: 'Train Station', distance: 0.8, score: 85 },
      { category: 'Schools', count: 5, nearest: 'Primary School', distance: 1.2, score: 80 },
      { category: 'Healthcare', count: 2, nearest: 'Medical Centre', distance: 1.5, score: 70 },
      { category: 'Shopping', count: 4, nearest: 'Shopping Centre', distance: 2.1, score: 75 },
      { category: 'Recreation', count: 6, nearest: 'Park', distance: 0.5, score: 90 }
    ],
    transport: {
      nearestStation: 'Central Station',
      distanceToStation: 0.8,
      stationsWithin2km: 3
    },
    schools: {
      nearestSchool: 'Local Primary School',
      distanceToSchool: 1.2,
      schoolsWithin3km: 5,
      topSchools: [
        { name: 'Primary School A', distance: 1.2, rating: 4.5 },
        { name: 'High School B', distance: 2.3, rating: 4.3 },
        { name: 'Private College C', distance: 2.8, rating: 4.7 }
      ]
    },
    healthcare: {
      nearestHospital: 'Community Hospital',
      distanceToHospital: 3.2,
      facilitiesWithin5km: 2
    },
    lifestyle: {
      shoppingCenters: 4,
      parks: 6,
      restaurants: 15,
      nearestShopping: 'Local Shopping Centre',
      nearestPark: 'Community Park'
    }
  };
}