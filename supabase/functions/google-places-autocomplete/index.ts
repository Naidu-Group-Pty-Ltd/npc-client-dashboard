import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createCorsHeaders } from "../_shared/auth.ts";
import { enforceJsonBodyLimit } from '../_shared/requestSecurity.ts';
import {
  enforceIpQuota,
  enforceKeyQuota,
  fetchWithTimeout,
  getClientIp,
  killSwitchActive,
  redactError,
  sanitizeShortText,
} from "../_shared/publicAbuseControls.ts";
import { clientHttpStatusFor, clientStatusFor, consumeGoogleDailyCap } from '../_shared/googleMapsDailyCaps.ts';

// WP-10 — Google Places autocomplete abuse controls.
//   * Per-IP + per-session + global daily quotas.
//   * Input cap + control-char reject.
//   * Response projection (only fields callers actually need).
//   * Timeout + circuit breaker + redacted upstream errors.
//   * Kill switch: GOOGLE_PLACES_KILL_SWITCH.

const CIRCUIT_SCOPE = 'google_places';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const j = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  if (killSwitchActive('GOOGLE_PLACES_KILL_SWITCH')) {
    return j({ error: 'temporarily_unavailable', success: false }, 503);
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: circuitOpen, error: circuitReadError } = await supabase.rpc('provider_circuit_is_open', { p_scope: CIRCUIT_SCOPE });
    if (circuitReadError) return j({ error: 'temporarily_unavailable', success: false }, 503);
    if (circuitOpen === true) return j({ error: 'temporarily_unavailable', success: false }, 503);
    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) return j({ error: 'Places service not configured', success: false }, 500);

    // WP-24: bounded. Every field below is sanitised, but the READ was not —
    // `req.json()` takes whatever is sent, and nothing authenticates this
    // endpoint. 8 KiB is far beyond an autocomplete fragment.
    const __bounded = await enforceJsonBodyLimit<Record<string, unknown>>(req, 8 * 1024);
    if (!__bounded.ok) return __bounded.error;
    const body = __bounded.value ?? {};
    const input = sanitizeShortText(body.input, 120);
    const sessionToken = sanitizeShortText(body.sessionToken, 64);

    if (!input || input.length < 3) return j({ success: true, predictions: [] });

    const ip = getClientIp(req);

    // Atomic quotas — layered.
    const ipCheck = await enforceIpQuota(supabase, ip, 'google_places', { limit: 30, windowMs: 60_000 });
    if (!ipCheck.ok) return j({ error: 'rate_limited', success: false }, 429);
    if (sessionToken) {
      const sess = await enforceKeyQuota(supabase, sessionToken, 'google_places_session', { limit: 60, windowMs: 60_000 });
      if (!sess.ok) return j({ error: 'rate_limited', success: false }, 429);
    }
    // Autocomplete is its own Google billing SKU at its own price, so it has
    // its own allowance. It used to share one `google_places` bucket with the
    // Nearby Search a report's amenity lookups make, which meant a busy address
    // field could spend the budget a client's report needed.
    //
    // The IP and session quotas above are abuse control and are unchanged; this
    // is the spending ceiling, and it fails closed when the shared counter
    // cannot be reached. Autocomplete then degrades to "no suggestions", which
    // is still a form an operator can type into.
    const globalCheck = await consumeGoogleDailyCap(supabase, 'placesAutocomplete');
    if (!globalCheck.ok) {
      // The exact reason goes to the log; the caller is told only whether this
      // is an exhausted allowance (which clears tomorrow) or unavailability
      // (which does not). Reporting a kill switch or an unreachable counter as
      // "daily quota exceeded" sends an operator away to wait for a state that
      // waiting will not change.
      console.warn(`[google-places-autocomplete] not attempted (${globalCheck.reason})`);
      return j(
        { error: clientStatusFor(globalCheck.reason), success: false },
        clientHttpStatusFor(globalCheck.reason),
      );
    }

    const params = new URLSearchParams({
      input,
      types: 'address',
      components: 'country:au',
      key: apiKey,
      ...(sessionToken ? { sessiontoken: sessionToken } : {}),
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`,
        {},
        5000,
      );
    } catch (e) {
      const { error: circuitWriteError } = await supabase.rpc('provider_circuit_record_failure', { p_scope: CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      if (circuitWriteError) return j({ error: 'temporarily_unavailable', success: false }, 503);
      console.warn('[google-places-autocomplete] upstream timeout/abort', redactError(e));
      return j({ error: 'upstream_timeout', success: false }, 504);
    }

    const data = await response.json().catch(() => ({}));

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      const { error: circuitWriteError } = await supabase.rpc('provider_circuit_record_failure', { p_scope: CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      if (circuitWriteError) return j({ error: 'temporarily_unavailable', success: false }, 503);
      console.error('Google Places API error:', data.status);
      return j({ error: 'upstream_error', success: false }, 502);
    }

    const { error: circuitResetError } = await supabase.rpc('provider_circuit_record_success', { p_scope: CIRCUIT_SCOPE });
    if (circuitResetError) return j({ error: 'temporarily_unavailable', success: false }, 503);

    // Response projection — never leak arbitrary provider fields.
    const predictions = (data.predictions || []).slice(0, 10).map((p: Record<string, unknown>) => ({
      placeId: String(p.place_id ?? '').slice(0, 200),
      description: String(p.description ?? '').slice(0, 300),
      mainText: String((p.structured_formatting as Record<string, unknown>)?.main_text ?? '').slice(0, 200),
      secondaryText: String((p.structured_formatting as Record<string, unknown>)?.secondary_text ?? '').slice(0, 200),
    }));

    return j({ success: true, predictions });
  } catch (error) {
    console.error('Places autocomplete error:', error);
    return j({ error: redactError(error), success: false }, 500);
  }
});
