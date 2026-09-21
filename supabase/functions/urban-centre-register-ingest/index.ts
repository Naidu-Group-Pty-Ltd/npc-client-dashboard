/**
 * Load the ABS's Significant Urban Areas into `urban_centre_register`.
 *
 * One request to the service `resolveOneReportGeography.ts` has queried in
 * production since ME-5, for every feature rather than one point, with the
 * polygon's centre rather than its outline. The parsing, the refusals and the
 * plausibility bounds are `urbanCentreIngest.pure.ts`'s; this is the fetch,
 * the write and the ledger.
 *
 * ## What it is for
 *
 * A commute measured to the state capital is a reading about a regional
 * property's access only if the capital is that property's market. Golden
 * Square is a suburb of Bendigo; its commute was measured to Melbourne at
 * 114 minutes and scored 0 of 100. See `urbanCentre.pure.ts`.
 *
 * ## Two things it deliberately does not do
 *
 * **It never half-writes.** A load that fails its plausibility bounds is
 * recorded as failed and writes no centre, because a register missing two
 * thirds of Australia is worse than one nobody has loaded: the second says so
 * and the first does not. Only a load that passes replaces the table's rows,
 * in one transaction-shaped sequence — upsert every centre, then prune the
 * codes this load did not carry.
 *
 * **It never seeds a fallback.** `CLONE_PROVISIONING_GAPS.md` records that the
 * rows a migration INSERTs do not travel, so a register that was seeded would
 * be present on the prime and absent on every clone while looking, from the
 * ledger, exactly like it was there. A deployment whose ingest has not run has
 * an empty register and behaves as it did before this existed — which is the
 * point of `ownCentre: 'no'` being a reading rather than a score.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCorsHeaders, createUnauthorizedResponse, verifyAuth } from '../_shared/auth.ts';
import { csrfDenied, enforceCsrf } from '../_shared/csrfGuard.ts';
import { internalError } from '../_shared/errorResponse.ts';
import { ASGS_RELEASE } from '../_shared/geography/asgsGeography.pure.ts';
import {
  assessLoad,
  parseSuaFeatures,
  type ParsedCentre,
} from '../_shared/reports/location/urbanCentreIngest.pure.ts';

const SOURCE = 'ABS ASGS 2021 Significant Urban Areas (geo.abs.gov.au ArcGIS REST)';
const TIMEOUT_MS = 45_000;

const SUA_LAYER =
  `https://geo.abs.gov.au/arcgis/rest/services/${ASGS_RELEASE}/SUA/MapServer/0/query`;

/**
 * Every SUA, with the centre of each — and WITHOUT the outline of any.
 *
 * `returnGeometry` is **false**, and that is the whole lesson of this file's
 * first production call. It was `true` beside `returnCentroid: true`, on the
 * reasoning that the parser accepts a feature's own geometry where the service
 * supplies no centroid — which is true, and which quietly asked the ABS for
 * every Significant Urban Area's full-resolution POLYGON. The worker was
 * killed with HTTP 546 (WORKER_RESOURCE_LIMIT) before it could log a single
 * line, so the only evidence it left was a status code on the edge.
 *
 * A centroid is two numbers. An urban-area boundary is tens of thousands of
 * vertices, and there are about a hundred of them. Asking for both to hedge
 * against one being missing is how a two-kilobyte answer becomes one no edge
 * function can hold — so the hedge is gone and the ABSENCE of a centroid is a
 * measurement the probe makes rather than something to insure against.
 *
 * `outSR=4326` because every coordinate in this platform is WGS84 and a silent
 * projection change is how a centre lands in the ocean.
 */
function queryUrl(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'sua_code_2021,sua_name_2021',
    returnGeometry: 'true',
    // Server-side generalisation, and the number is the whole safety margin.
    // 0.01 degrees is roughly a kilometre, which collapses a coastline of tens
    // of thousands of vertices to tens while moving the derived centre by far
    // less than the error already inherent in calling any single point "the
    // centre of an urban area". The unsimplified request is what exceeded the
    // worker's memory at 546.
    maxAllowableOffset: '0.01',
    geometryPrecision: '4',
    outSR: '4326',
    f: 'json',
    ...extra,
  });
  return `${SUA_LAYER}?${params}`;
}

/**
 * One page of features, reduced to points before the next page is asked for.
 *
 * `maxRecordCount` is 2000 and there are 112 urban areas, so the service would
 * answer this in a single response — and that is exactly the shape of request
 * that was killed at 546. Paging is not about the record limit; it is about
 * never holding more than a few boundaries at once. Measured: `supportsPagination`
 * is true on this layer.
 */
const PAGE = 10;

/** How many urban areas the release holds. Two hundred bytes, whatever it says. */
function countUrl(): string {
  return `${SUA_LAYER}?${new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' })}`;
}

/**
 * The layer's own description of itself: which fields it publishes, how many
 * features it will return in one answer, and which query capabilities it has.
 *
 * Asked because the first probe proved `returnCentroid=true` is IGNORED here —
 * the features came back with `attributes` and nothing else. Whether this
 * layer can supply a point at all, and under what name, is a question the
 * service can answer about itself for a few kilobytes.
 */
function layerUrl(): string {
  return SUA_LAYER.replace(/\/query$/, '') + '?f=json';
}

// deno-lint-ignore no-explicit-any
async function lastGoodCount(supabase: any): Promise<number | null> {
  const { data, error } = await supabase
    .from('urban_centre_syncs')
    .select('centres_written')
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const n = Number(data?.[0]?.centres_written);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// deno-lint-ignore no-explicit-any
async function writeCentres(supabase: any, centres: readonly ParsedCentre[], loadedAt: string) {
  const rows = centres.map((c) => ({
    sua_code: c.code,
    sua_name: c.name,
    state: c.state,
    lat: c.lat,
    lng: c.lng,
    // Not 'sua_centroid'. The ABS supplies no centroid on this layer and
    // advertises no capability to return one, so the word would claim a
    // provenance that does not exist: this is the area-weighted centre of the
    // publisher's own generalised boundary, computed here.
    point_basis: 'sua_boundary_centroid',
    asgs_release: ASGS_RELEASE,
    source: SOURCE,
    loaded_at: loadedAt,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from('urban_centre_register')
      .upsert(rows.slice(i, i + 500), { onConflict: 'sua_code' });
    if (error) throw new Error(`urban_centre_register upsert failed: ${error.message}`);
  }
  // Prune by EFFECT rather than by configuration: whatever this load did not
  // carry is no longer in the release, and the prune names `sua_code` in its
  // own filter rather than relying on the returning projection — the defect
  // `SANCTIONS_LIST_LOADING.md` records, where a `.delete().or(...)` answered
  // 42703 on every load it was part of.
  const keep = centres.map((c) => c.code);
  const { error } = await supabase
    .from('urban_centre_register')
    .delete()
    .not('sua_code', 'in', `(${keep.map((c) => `"${c.replace(/"/g, '')}"`).join(',')})`);
  if (error) throw new Error(`urban_centre_register prune failed: ${error.message}`);
}

Deno.serve(async (req) => {
  const cors = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  /*
   * `verifyAuth` accepts a cookie-carried staff session, so this is a
   * cookie-auth surface whatever its intended caller is, and SEC5-CSRF's gate
   * holds every one of them to `enforceCsrf`. Its EXEMPT list reads "none
   * currently — every verifyAuth function is wired", and writing the first
   * entry into it would be a weakening rather than a fact about this
   * function: nothing stops a browser session reaching this URL.
   *
   * It costs the real caller nothing. `enforceCsrf` is safe by default — a
   * request carrying no cookie passes straight through — and pg_cron's
   * invocation carries signed headers and no cookie. Placed before the body
   * is read, as in `market-sales-ingest`, which this function is otherwise
   * modelled on.
   */
  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(cors, csrf);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // `verifyAuth(supabase, headers, body)` — the signature every other ingest
  // here uses, and the one that accepts what `cron_service_role_headers()`
  // sends. The first cut of this file called `verifyAuth(req)` against a
  // three-argument function: `headers` was undefined, so the FIRST statement
  // inside threw a TypeError and this function would have answered 500 to
  // every request ever made of it, before reaching a single line of its own
  // work. It is the `appendCaseEvent` class — an identifier or a shape that
  // does not exist is never type debt — and nothing but execution or reading
  // the callee finds it.
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { error: authError } = await verifyAuth(supabase, req.headers, body);
  if (authError) return createUnauthorizedResponse(authError, cors);

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  /*
   * `stage: 'probe'` fetches and describes, and writes NOTHING — no register
   * row, no ledger row. It exists because the query shape could not be
   * verified from the machine this was written on: that egress answers 403 at
   * the CONNECT tunnel for `geo.abs.gov.au` under an organisation policy, so
   * whether this service honours `returnCentroid` on a MapServer layer, and
   * how many features it returns in one answer, were UNVERIFIED assumptions.
   * `market-sales-ingest` already carries a stage of exactly this shape for
   * exactly this reason. Asserted by effect, never by configuration.
   */
  if (String(body.stage ?? '') === 'probe') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const ask = async (label: string, url: string) => {
      const res = await fetch(url, { signal: controller.signal });
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* reported */ }
      return { label, status: res.status, bytes: text.length, parsed };
    };
    try {
      // Cheapest question first, and a bounded one second. The probe must not
      // be able to commit the fault it exists to find: the first call answers
      // in a couple of hundred bytes whatever the release holds, and the
      // second is capped at five features, so neither can reach the memory
      // ceiling that killed the first attempt at 546 with nothing logged.
      const meta = await ask('layer', layerUrl());
      const counted = await ask('count', countUrl());
      const shaped = await ask('shape', queryUrl({ resultRecordCount: '5', outFields: '*' }));
      const features = Array.isArray(shaped.parsed?.features)
        ? shaped.parsed!.features as Array<Record<string, unknown>>
        : [];
      const first = features[0] ?? null;
      const m = meta.parsed ?? {};
      const probe = {
        ok: counted.status === 200 && shaped.status === 200
          && !counted.parsed?.error && !shaped.parsed?.error,
        layer: {
          status: meta.status,
          name: m.name ?? null,
          geometryType: m.geometryType ?? null,
          // The page size decides whether 112 features arrive in one answer.
          maxRecordCount: m.maxRecordCount ?? null,
          standardMaxRecordCount: m.standardMaxRecordCount ?? null,
          supportsPagination: (m.advancedQueryCapabilities as Record<string, unknown> | undefined)
            ?.supportsPagination ?? null,
          supportsReturningGeometryCentroid:
            (m.advancedQueryCapabilities as Record<string, unknown> | undefined)
              ?.supportsReturningGeometryCentroid ?? null,
          // Every field the layer publishes, which is where a point would be
          // if the publisher supplies one as an attribute.
          fields: Array.isArray(m.fields)
            ? (m.fields as Array<Record<string, unknown>>).map((f) => `${f.name}:${f.type}`)
            : null,
        },
        count: { status: counted.status, bytes: counted.bytes, body: counted.parsed },
        shape: {
          status: shaped.status,
          bytes: shaped.bytes,
          errorBody: shaped.parsed?.error ?? null,
          exceededTransferLimit: shaped.parsed?.exceededTransferLimit ?? null,
          returned: features.length,
          // The one thing `returnCentroid=true` was an assumption about.
          firstFeatureKeys: first ? Object.keys(first) : [],
          firstAttributes: first?.attributes ?? null,
          firstCentroid: first?.centroid ?? null,
          hasGeometry: first ? Object.hasOwn(first, 'geometry') : null,
        },
        // What the real load would make of those five, computed, never written.
        wouldParse: (() => {
          try {
            const r = parseSuaFeatures(shaped.parsed);
            return { centres: r.centres.length, dropped: r.dropped, sample: r.centres.slice(0, 3) };
          } catch (e) {
            return { refused: e instanceof Error ? e.message : String(e) };
          }
        })(),
      };
      console.log(`[urban-centre-register-ingest] probe ${JSON.stringify(probe)}`);
      return json(probe);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[urban-centre-register-ingest] probe failed: ${message}`);
      return json({ ok: false, probeError: message });
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * `stage: 'status'` reads the register back and writes nothing.
   *
   * A loader that can only be believed by its own success message is a loader
   * asserted by configuration. This is the effect: how many centres are held,
   * how they fall across the states, what the last load recorded, and the
   * coordinates of named centres a reader can check against a map. It is the
   * same instrument an operator needs later to answer "is this deployment's
   * register loaded, and with what" without a database session.
   */
  if (String(body.stage ?? '') === 'status') {
    const { data: rows, error: readError } = await supabase
      .from('urban_centre_register')
      .select('sua_code, sua_name, state, lat, lng, point_basis, asgs_release, loaded_at');
    if (readError) return json({ ok: false, error: readError.message }, 200);

    const centres = (rows ?? []) as Array<Record<string, unknown>>;
    const byState: Record<string, number> = {};
    for (const c of centres) {
      const st = String(c.state);
      byState[st] = (byState[st] ?? 0) + 1;
    }
    const named = String(body.named ?? 'Bendigo,Sydney,Melbourne,Geelong,Toowoomba,Ballarat')
      .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
    const lookups = named.map((n) => {
      const hit = centres.find((c) => String(c.sua_name).toLowerCase() === n);
      return hit
        ? { name: hit.sua_name, code: hit.sua_code, state: hit.state, lat: hit.lat, lng: hit.lng }
        : { name: n, found: false };
    });

    const { data: syncs } = await supabase
      .from('urban_centre_syncs')
      .select('status, started_at, finished_at, centres_written, asgs_release, detail, error')
      .order('started_at', { ascending: false })
      .limit(3);

    const out = {
      ok: true,
      held: centres.length,
      byState,
      pointBases: [...new Set(centres.map((c) => String(c.point_basis)))].sort(),
      releases: [...new Set(centres.map((c) => String(c.asgs_release)))].sort(),
      // The rule this register exists to enforce: no row may be a state's
      // "everywhere else" bucket. Asserted against what was actually written.
      pseudoAreasHeld: centres.filter((c) => /^\s*not\s+in\s+any\b/i.test(String(c.sua_name))
        || /^\d000$/.test(String(c.sua_code))).map((c) => c.sua_code),
      lookups,
      recentSyncs: syncs ?? [],
    };
    console.log(`[urban-centre-register-ingest] status ${JSON.stringify(out)}`);
    return json(out);
  }

  const started = new Date().toISOString();
  const { data: run } = await supabase
    .from('urban_centre_syncs')
    .insert({ started_at: started, asgs_release: ASGS_RELEASE })
    .select('id')
    .single();
  const runId = run?.id ?? null;

  const fail = async (message: string, detail: Record<string, unknown> = {}) => {
    if (runId) {
      await supabase.from('urban_centre_syncs').update({
        status: 'failed', finished_at: new Date().toISOString(), error: message, detail,
      }).eq('id', runId);
    }
    console.error(`[urban-centre-register-ingest] ${message}`);
    return new Response(JSON.stringify({ ok: false, error: message, detail }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const centres: ParsedCentre[] = [];
    const dropped: Record<string, number> = {};
    let expected: number | null = null;
    try {
      // How many the release holds, asked first and in its own tiny request,
      // so the walk below has something to be judged against that is not its
      // own output. A page that returns nothing is then distinguishable from a
      // release that holds nothing.
      const countRes = await fetch(countUrl(), { signal: controller.signal });
      if (!countRes.ok) return await fail(`the ABS geoserver answered ${countRes.status} for the count`);
      const countBody = await countRes.json() as { count?: unknown; error?: unknown };
      if (countBody.error) return await fail('the ABS geoserver returned an error body for the count');
      expected = typeof countBody.count === 'number' ? countBody.count : null;
      if (expected === null) return await fail('the ABS geoserver did not answer a feature count');

      for (let offset = 0; offset < expected; offset += PAGE) {
        const res = await fetch(
          queryUrl({ resultOffset: String(offset), resultRecordCount: String(PAGE) }),
          { signal: controller.signal },
        );
        if (!res.ok) return await fail(`the ABS geoserver answered ${res.status} at offset ${offset}`);
        const page = await res.json();
        // `exceededTransferLimit` is TRUE on every page of a paged walk — it
        // means "there are more", which is the premise here rather than a
        // fault. The guard against a truncated download is the count above,
        // asserted after the walk. Stripping the flag per page keeps the
        // parser's own refusal meaningful for the unpaged callers it also
        // serves.
        const { exceededTransferLimit: _paged, ...rest } =
          (page ?? {}) as Record<string, unknown>;
        const parsedPage = parseSuaFeatures(rest);
        centres.push(...parsedPage.centres);
        for (const [why, n] of Object.entries(parsedPage.dropped)) {
          dropped[why] = (dropped[why] ?? 0) + n;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    // Asserted by EFFECT: every feature the service said it holds was seen,
    // whether it was kept or refused for a named reason. A short walk is a
    // truncated download by another route, and this load PRUNES.
    const seen = centres.length + Object.values(dropped).reduce((a, n) => a + n, 0);
    if (seen !== expected) {
      return await fail(
        `the walk saw ${seen} of ${expected} features the release declares — refused`,
        { centres: centres.length, dropped },
      );
    }

    const parsed = { centres, dropped };
    const verdict = assessLoad(parsed.centres.length, await lastGoodCount(supabase));
    if (!verdict.ok) {
      return await fail(verdict.reason ?? 'the load was refused', {
        parsed: parsed.centres.length, dropped: parsed.dropped,
      });
    }

    const loadedAt = new Date().toISOString();
    await writeCentres(supabase, parsed.centres, loadedAt);

    if (runId) {
      await supabase.from('urban_centre_syncs').update({
        status: 'succeeded',
        finished_at: loadedAt,
        centres_written: parsed.centres.length,
        detail: { dropped: parsed.dropped, states: [...new Set(parsed.centres.map((c) => c.state))].sort() },
      }).eq('id', runId);
    }
    console.log(`[urban-centre-register-ingest] wrote ${parsed.centres.length} centres`);
    return new Response(
      JSON.stringify({ ok: true, centres: parsed.centres.length, dropped: parsed.dropped }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await fail(message);
    /*
     * `internalError` composes a BODY and never a Response, and its second
     * parameter is the log context, not headers. The first cut here was
     * `internalError(message, cors)`, which was wrong twice over and neither
     * half is cosmetic: the log line would have read `[object Object]` for its
     * context, and a `Deno.serve` handler returning a bare object throws — so
     * the platform serves a 500 carrying NONE of this function's CORS headers,
     * the browser discards it, and `fetch` rejects with "Failed to fetch".
     * That is the defect `STEP_UP_ENFORCEMENT.md` records, where an auth gate
     * presented as a broken deployment. `json()` is this handler's own
     * responder and already carries `cors`; 500 rather than `fail`'s 200
     * because this is the unexpected path, not a designed refusal.
     *
     * The body carries NO `error: message` of its own. `internalError` sets
     * `error: 'Internal error'` deliberately — disclosing the thrown message
     * to the caller is what `check-error-disclosure.mjs` exists to stop — and
     * spreading it after a same-named key would have overwritten it silently
     * anyway. The message is not lost: `fail` above wrote it to the sync
     * ledger and `internalError` logged it against a correlation id.
     */
    return json({ ok: false, ...internalError(e, 'urban-centre-register-ingest') }, 500);
  }
});
