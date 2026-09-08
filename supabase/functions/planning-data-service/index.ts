import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { sourceUnavailable } from '../_shared/sourceUnavailable.pure.ts';
import { internalError } from '../_shared/errorResponse.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { PlanningDataRequest, PUBLIC_SERVICE_MAX_BODY_BYTES } from '../_shared/publicServiceSchemas.ts';
import { assessAuPoint, normaliseAuState } from '../_shared/auGeoSanity.pure.ts';
import {
  ACT_ZONING_LICENCE, ACT_ZONING_SOURCE,
  buildActZoningQuery, buildNswDaRequest, buildNswZoningQuery,
  buildQldInstrumentQuery, buildQldParcelQuery, buildTasZoningQuery,
  buildVicZoningQuery,
  NSW_DA_LICENCE, NSW_DA_SOURCE,
  parseActZoning, parseNswZoning, parseQldInstrument, parseQldParcel,
  parseTasZoning, parseVicZoning,
  QLD_INSTRUMENT_LAYERS, QLD_STATE_PLANNING_SOURCE,
  SA_NT_NOTE, VERIFICATION_INSTRUMENT, WA_LICENCE_NOTE,
  type DevelopmentInstrumentReading, type ParcelReading, type ParseOutcome,
  type PlanningJurisdiction, type ZoningReading,
} from '../_shared/planning/planningSources.pure.ts';
import { deriveZoneFamily, ZONE_FAMILY_LABEL } from '../_shared/planning/zoneFamily.pure.ts';
import {
  councilNameCandidates, resolveCouncilName, summariseDaRows,
  type NswDaRow,
} from '../_shared/planning/developmentActivity.pure.ts';

/**
 * Property planning data — zoning, parcel and development intelligence from
 * each jurisdiction's OWN planning services, at the property's coordinate.
 *
 * The design rules come from `docs/reports/ZONING_BY_JURISDICTION.md`, where
 * every endpoint below was verified by execution (2026-09-06):
 *
 *  - **The router is the services themselves.** No bounding boxes decide the
 *    jurisdiction (rectangles put Chile in WA once): the integrated layers
 *    are asked in parallel and the one whose polygon contains the point
 *    answers — the state hint only orders preference when two boundary
 *    layers both claim a point. The answering layer's own LGA/state fields
 *    are what the response asserts.
 *  - **Cells, not a blanket.** Zoning, parcel, state development instruments
 *    and DA activity are separate questions with separate sources, and each
 *    cell that cannot be filled says WHY (`not_served`, `licence_restricted`,
 *    `not_integrated`, `none_at_point`, `unavailable`) — WA's data exists
 *    and is licence-barred from a commercial PDF, which is a different
 *    sentence from QLD having no state zoning layer at all.
 *  - **A failed read is never cached and never reads as an absence.** Only
 *    responses whose every attempted cell settled (ok, or a definite
 *    empty/absence) are cached; a transport failure answers `unavailable`
 *    and the next request retries.
 *  - **The layer is indicative; the certificate is the instrument.** Every
 *    response carries the jurisdiction's verification instrument (s10.7 in
 *    NSW, planning and development certificate in QLD, …) so the report can
 *    say what settles the question.
 */

const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_HOURS = 7 * 24;
const DA_WINDOW_DAYS = 183;
const DA_PAGE_SIZE = 100;
const DA_MAX_PAGES = 3;

type Cell<T> =
  | ({ status: 'ok' } & T)
  | { status: 'none_at_point' | 'not_served' | 'licence_restricted' | 'not_integrated' | 'unavailable'; note: string };

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, message: 'unparseable JSON body' };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run one zoning/parcel probe and fold transport failure into the outcome. */
async function probe<T>(url: string, parse: (body: unknown) => ParseOutcome<T>): Promise<ParseOutcome<T>> {
  const res = await fetchJson(url);
  if (!res.ok) return { kind: 'error', message: res.message };
  return parse(res.body);
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const __parsed = await parseJsonBody(req, PlanningDataRequest, corsHeaders, PUBLIC_SERVICE_MAX_BODY_BYTES);
    if (!__parsed.ok) return __parsed.response;
    const input = __parsed.data;

    // Internal callers authenticate by header; the strict schema means the
    // body can never carry a session token, so none is forwarded.
    const { error: authError, userId } = await verifyAuth(supabase, req.headers, {});
    if (authError) return createUnauthorizedResponse(authError, corsHeaders);
    console.log(`[planning-data-service] authenticated: ${userId}`, { lat: input.latitude, lng: input.longitude, state: input.state ?? null });

    const lat = input.latitude;
    const lng = input.longitude;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // The same gate every coordinate consumer uses: a point that could not
    // be an Australian property is refused, never looked up abroad.
    const verdict = assessAuPoint(lat, lng, input.state ?? null);
    if (!verdict.ok) {
      return json(sourceUnavailable(
        'planning-data',
        'no_data_for_location',
        `The coordinate fails the Australia gate (${verdict.reason}) — planning data is unavailable rather than looked up in the wrong jurisdiction.`,
      ));
    }

    // ── Cache ────────────────────────────────────────────────────────────
    const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600 * 1000).toISOString();
    const { data: cached } = await supabase
      .from('planning_data_cache')
      .select('data, fetched_at')
      .eq('cache_key', cacheKey)
      .eq('data_quality', 'live')
      .gte('fetched_at', cutoff)
      .maybeSingle();
    if (cached?.data) {
      console.log('[planning-data-service] cache hit', { cacheKey });
      return json({ success: true, data: cached.data, cached: true });
    }

    // ── The probes are the router ────────────────────────────────────────
    const hint = normaliseAuState(input.state ?? null);
    const [nsw, vic, tas, act, qldParcel] = await Promise.all([
      probe(buildNswZoningQuery(lng, lat), parseNswZoning),
      probe(buildVicZoningQuery(lng, lat), parseVicZoning),
      probe(buildTasZoningQuery(lng, lat), parseTasZoning),
      probe(buildActZoningQuery(lng, lat), parseActZoning),
      probe(buildQldParcelQuery(lng, lat), parseQldParcel),
    ]);

    const zoningByJurisdiction: Array<[PlanningJurisdiction, ParseOutcome<ZoningReading>]> = [
      ['NSW', nsw], ['VIC', vic], ['TAS', tas], ['ACT', act],
    ];
    const okZoning = zoningByJurisdiction.filter(([, o]) => o.kind === 'ok');
    const hinted = okZoning.find(([j]) => j === hint);
    const zoningHit = (hinted ?? okZoning[0]) ?? null;
    const parcelHit = qldParcel.kind === 'ok' ? qldParcel.reading : null;

    const jurisdiction: PlanningJurisdiction | null =
      zoningHit ? zoningHit[0] : parcelHit ? 'QLD' : (hint as PlanningJurisdiction | null);

    // ── Assemble the cells ───────────────────────────────────────────────
    let zoningCell: Cell<ZoningReading & { zoneFamily: string | null }>;
    let parcelCell: Cell<ParcelReading>;
    let instrumentsCell: Cell<{ instruments: DevelopmentInstrumentReading[]; source: string }>;
    let activityCell: Cell<{ summary: ReturnType<typeof summariseDaRows>; source: string; licence: string }>;
    let anyTransportFailure = false;

    if (zoningHit) {
      const [, outcome] = zoningHit;
      const reading = (outcome as { kind: 'ok'; reading: ZoningReading }).reading;
      const family = deriveZoneFamily(reading.jurisdiction, reading.zoneCode, reading.zoneLabel);
      zoningCell = { status: 'ok', ...reading, zoneFamily: family ? ZONE_FAMILY_LABEL[family] : null };
    } else if (jurisdiction === 'QLD') {
      zoningCell = {
        status: 'not_served',
        note: 'Queensland sets zoning in each council planning scheme; no state-wide zoning layer exists. The zone must be read from the council scheme — the planning and development certificate is the instrument.',
      };
    } else if (jurisdiction === 'WA') {
      zoningCell = { status: 'licence_restricted', note: WA_LICENCE_NOTE };
    } else if (jurisdiction === 'SA' || jurisdiction === 'NT') {
      zoningCell = { status: 'not_integrated', note: SA_NT_NOTE };
    } else if (zoningByJurisdiction.some(([, o]) => o.kind === 'error')) {
      anyTransportFailure = true;
      const failures = zoningByJurisdiction.filter(([, o]) => o.kind === 'error')
        .map(([j, o]) => `${j}: ${(o as { message: string }).message}`).join('; ');
      zoningCell = { status: 'unavailable', note: `zoning layers could not be read (${failures})` };
    } else {
      zoningCell = {
        status: 'not_integrated',
        note: 'No integrated planning layer covers this point (integrated: NSW, VIC, QLD cadastre, TAS, ACT). Verify with the local planning authority.',
      };
    }

    if (parcelHit) {
      parcelCell = { status: 'ok', ...parcelHit };
    } else if (jurisdiction === 'QLD' && qldParcel.kind === 'error') {
      anyTransportFailure = true;
      parcelCell = { status: 'unavailable', note: `the Queensland cadastre could not be read (${qldParcel.message})` };
    } else if (jurisdiction === 'WA') {
      parcelCell = { status: 'licence_restricted', note: WA_LICENCE_NOTE };
    } else if (jurisdiction === 'SA' || jurisdiction === 'NT') {
      parcelCell = { status: 'not_integrated', note: SA_NT_NOTE };
    } else {
      parcelCell = {
        status: 'not_integrated',
        note: 'No parcel attributes are integrated for this jurisdiction yet (Queensland’s Land Parcel Property Framework is; NSW publishes only a computed polygon area, which must not wear a surveyed label).',
      };
    }

    if (jurisdiction === 'QLD') {
      const results = await Promise.all(
        QLD_INSTRUMENT_LAYERS.map(async ({ layer, kind }) => ({
          kind,
          outcome: await probe(buildQldInstrumentQuery(layer, lng, lat), (b) => parseQldInstrument(kind, b)),
        })),
      );
      if (results.some((r) => r.outcome.kind === 'error')) {
        anyTransportFailure = true;
        instrumentsCell = { status: 'unavailable', note: 'one or more StatePlanning layers could not be read' };
      } else {
        const instruments = results.flatMap((r) => (r.outcome.kind === 'ok' ? r.outcome.reading : []));
        instrumentsCell = instruments.length > 0
          ? { status: 'ok', instruments, source: QLD_STATE_PLANNING_SOURCE }
          : {
              status: 'none_at_point',
              note: 'The property lies inside no declared priority development area, state development area, coordinated project or infrastructure designation (Queensland StatePlanning layers, checked at the coordinate).',
            };
      }
    } else {
      instrumentsCell = {
        status: 'not_integrated',
        note: 'State development-instrument layers are integrated for Queensland only so far.',
      };
    }

    if (jurisdiction === 'NSW' && zoningCell.status === 'ok' && zoningCell.lga) {
      const to = new Date();
      const from = new Date(to.getTime() - DA_WINDOW_DAYS * 24 * 3600 * 1000);
      const toIso = to.toISOString().slice(0, 10);
      const fromIso = from.toISOString().slice(0, 10);
      const candidates = councilNameCandidates(zoningCell.lga);

      const rows: NswDaRow[] = [];
      let totalCount = 0;
      let daFailed: string | null = null;
      for (let page = 1; page <= DA_MAX_PAGES; page++) {
        const reqSpec = buildNswDaRequest(candidates, fromIso, toIso, DA_PAGE_SIZE, page);
        const res = await fetchJson(reqSpec.url, reqSpec.headers);
        if (!res.ok) { daFailed = res.message; break; }
        const body = res.body as { TotalCount?: number; Application?: NswDaRow[] };
        totalCount = typeof body?.TotalCount === 'number' ? body.TotalCount : totalCount;
        const pageRows = Array.isArray(body?.Application) ? body.Application : [];
        rows.push(...pageRows);
        if (rows.length >= totalCount || pageRows.length === 0) break;
      }

      if (daFailed) {
        anyTransportFailure = true;
        activityCell = { status: 'unavailable', note: `the NSW Online DA register could not be read (${daFailed})` };
      } else if (rows.length === 0) {
        activityCell = {
          status: 'none_at_point',
          note: `The NSW Online DA register returned no applications for this council in the last ${DA_WINDOW_DAYS} days — either none were lodged, or the register names this council in a form the lookup did not offer.`,
        };
      } else {
        const answeredNames = [...new Set(rows.map((r) => String(r.Council?.CouncilName ?? '')).filter((n) => n !== ''))];
        const resolved = resolveCouncilName(zoningCell.lga, answeredNames);
        if (resolved.resolved === null) {
          activityCell = {
            status: 'unavailable',
            note: `the DA register answered for ${answeredNames.join('; ') || 'no named council'}, which does not match LGA "${zoningCell.lga}" — refusing rather than reporting another council's applications (${resolved.reason})`,
          };
        } else {
          activityCell = {
            status: 'ok',
            summary: summariseDaRows(rows, resolved.resolved, fromIso, toIso, totalCount),
            source: NSW_DA_SOURCE,
            licence: NSW_DA_LICENCE,
          };
        }
      }
    } else if (jurisdiction === 'NSW') {
      activityCell = { status: 'unavailable', note: 'DA activity needs the council from the zoning answer, which is missing on this response.' };
    } else {
      activityCell = {
        status: 'not_served',
        note: 'No state-wide development-application feed exists for this jurisdiction (NSW’s Online DA API is the only one published); council DA registers are per-council.',
      };
    }

    const data = {
      jurisdiction,
      coordinate: { latitude: lat, longitude: lng },
      zoning: zoningCell,
      parcel: parcelCell,
      developmentInstruments: instrumentsCell,
      developmentActivity: activityCell,
      verification: jurisdiction
        ? `A spatial layer is indicative; what settles the question is ${VERIFICATION_INSTRUMENT[jurisdiction]}.`
        : 'A spatial layer is indicative; verify with the relevant council or planning authority.',
      fetchedAt: new Date().toISOString(),
    };

    // Only a response whose every attempted cell settled is worth keeping:
    // an outage cached is an outage served for a week as though it were a fact.
    if (!anyTransportFailure) {
      const { error: cacheError } = await supabase.from('planning_data_cache').upsert({
        cache_key: cacheKey,
        latitude: lat,
        longitude: lng,
        jurisdiction,
        data,
        data_quality: 'live',
        fetched_at: new Date().toISOString(),
      }, { onConflict: 'cache_key' });
      if (cacheError) console.warn('[planning-data-service] cache write failed (answer still served):', cacheError.message);
    }

    return json({ success: true, data });
  } catch (error) {
    console.error('❌ planning-data-service failed:', error);
    return new Response(JSON.stringify({ success: false, ...internalError(error, 'planning-data-service') }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
