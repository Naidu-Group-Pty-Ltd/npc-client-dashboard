import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { verifyAuth, createForbiddenResponse, createUnauthorizedResponse, createCorsHeaders } from '../_shared/auth.ts';
import { requireModulePermission } from '../_shared/authz.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import {
  enforceActorQuota,
  enforceIpQuota,
  fetchWithTimeout,
  getClientIp,
  killSwitchActive,
  redactError,
} from '../_shared/publicAbuseControls.ts';
import { clientHttpStatusFor, clientStatusFor, consumeGoogleDailyCap } from '../_shared/googleMapsDailyCaps.ts';

// Server-side Google Street View proxy. The browser never sees the server key.
// Returns coverage metadata plus a base64 static preview when imagery exists.

const MAX_WIDTH = 640;
const MAX_HEIGHT = 400;
const CIRCUIT_SCOPE = 'google_street_view';

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const j = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const { error: authError, userId, authMethod } = await verifyAuth(supabase, req.headers, body as { session_token?: string });
    if (authError || !userId) return createUnauthorizedResponse(authError || 'Authentication required', corsHeaders);
    const permission = await requireModulePermission(supabase, { userId, authMethod }, 'listings', 'can_view');
    if (!permission.ok) return createForbiddenResponse(permission.error || 'Listings access required', corsHeaders);

    const lat = numeric((body as { lat?: unknown }).lat);
    const lng = numeric((body as { lng?: unknown }).lng);
    const heading = numeric((body as { heading?: unknown }).heading) ?? 0;

    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return j({ error: 'invalid_location', success: false }, 400);
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) return j({ error: 'street_view_not_configured', success: false }, 500);
    const actorQuota = await enforceActorQuota(supabase, userId, CIRCUIT_SCOPE, { limit: 30, windowMs: 60_000 });
    const ipQuota = await enforceIpQuota(supabase, getClientIp(req), CIRCUIT_SCOPE, { limit: 60, windowMs: 60_000 });
    if (!actorQuota.ok || !ipQuota.ok) return j({ error: 'rate_limited', success: false }, 429);
    if (killSwitchActive('GOOGLE_STREET_VIEW_KILL_SWITCH')) {
      return j({ error: 'temporarily_unavailable', success: false }, 503);
    }

    // A circuit breaker reports whether GOOGLE is failing. If our own circuit
    // store cannot be read, that says nothing about Google — treating it as
    // "open" converts a local database gap into a total outage of the feature,
    // which is exactly what happened here: the provider_circuit_* migration
    // (20260724000000) was never applied, so every read errored and every
    // request 503'd. Fail closed on a genuinely open circuit; fail open on an
    // unreadable one, and log so the gap is visible.
    const { data: circuitOpen, error: circuitReadError } = await supabase.rpc('provider_circuit_is_open', { p_scope: CIRCUIT_SCOPE });
    if (circuitReadError) {
      console.warn('[street-view] circuit state unreadable, proceeding:', circuitReadError.message);
    } else if (circuitOpen === true) {
      return j({ error: 'temporarily_unavailable', success: false }, 503);
    }

    const location = `${lat},${lng}`;

    // Metadata is FREE and is counted with the imagery anyway — a deliberate
    // over-count, because a second counter for a SKU that costs nothing buys
    // nothing and over-counting spend is the safe direction. One unit per
    // request either way, which is what keeps the ceiling honest.
    const metadataQuota = await consumeGoogleDailyCap(supabase, 'streetView');
    if (!metadataQuota.ok) {
      console.warn(`[street-view] metadata not attempted (${metadataQuota.reason})`);
      return j(
        { error: clientStatusFor(metadataQuota.reason), success: false },
        clientHttpStatusFor(metadataQuota.reason),
      );
    }

    const metaResponse = await fetchWithTimeout(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(location)}&key=${apiKey}`,
      {},
      6000,
    );
    const meta = await metaResponse.json().catch(() => ({}));

    if (meta.status !== 'OK') {
      if (meta.status !== 'ZERO_RESULTS') {
        await supabase.rpc('provider_circuit_record_failure', { p_scope: CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      }
      return j({ success: true, available: false, status: String(meta.status ?? 'UNKNOWN') });
    }

    const params = new URLSearchParams({
      size: `${MAX_WIDTH}x${MAX_HEIGHT}`,
      location,
      fov: '80',
      heading: String(((heading % 360) + 360) % 360),
      pitch: '0',
      return_error_code: 'true',
      key: apiKey,
    });

    const imageQuota = await consumeGoogleDailyCap(supabase, 'streetView');
    if (!imageQuota.ok) {
      console.warn(`[street-view] image not attempted (${imageQuota.reason})`);
      return j(
        { error: clientStatusFor(imageQuota.reason), success: false },
        clientHttpStatusFor(imageQuota.reason),
      );
    }
    const imageResponse = await fetchWithTimeout(`https://maps.googleapis.com/maps/api/streetview?${params.toString()}`, {}, 6000);
    if (!imageResponse.ok) {
      await supabase.rpc('provider_circuit_record_failure', { p_scope: CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      return j({ success: true, available: false, status: `image_${imageResponse.status}` });
    }
    await supabase.rpc('provider_circuit_record_success', { p_scope: CIRCUIT_SCOPE });

    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    return j({
      success: true,
      available: true,
      imageDataUrl: `data:image/jpeg;base64,${base64}`,
      panoramaDate: typeof meta.date === 'string' ? meta.date : null,
      copyright: typeof meta.copyright === 'string' ? meta.copyright.slice(0, 200) : null,
    });
  } catch (error) {
    console.error('[street-view] error', redactError(error));
    return j({ error: 'internal_error', success: false }, 500);
  }
});
