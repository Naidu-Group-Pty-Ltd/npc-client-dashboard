/**
 * ME-5 item 15 — the forward geography writer.
 *
 * `report_geography` holds a canonical suburb, SA2, remoteness and urban centre
 * for every report whose coordinate could be placed. It was populated once, by
 * hand, for the 1,114 reports that existed — and **nothing wrote a row for a
 * report created afterwards.** A derived table that only a backfill maintains
 * is correct on the day it lands and silently stale from the next one, which is
 * the failure this programme keeps finding.
 *
 * This is what maintains it. It resolves the geography for reports that have no
 * row, from the report's own stored coordinate, against the ABS ASGS 2021
 * boundaries — the same deterministic point-in-polygon the backfill used, and
 * the same pure module (`asgsGeography.pure.ts`) decides what the answer means.
 *
 * ## Four rules
 *
 * **The coordinate is the question, and the free-text address is never
 * consulted.** `ADDRESS_COMPOSITION.md` records why an address cannot prove a
 * suburb, and 183 stored reports prove it the other way by having been geocoded
 * to London, Lisbon and Washington State.
 *
 * **A failed boundary service is unresolved, never guessed.** The ArcGIS
 * endpoint reports failures as HTTP 200 with an error body, so that shape is
 * treated as transport failure and the row is written `unresolved` with
 * `boundary_service_unavailable` — a state the sweep will retry, unlike
 * `outside_australia`, which is final.
 *
 * **It never writes to `investment_reports`.** The stored report keeps exactly
 * the bytes it was written with; this is a record beside it.
 *
 * **The batch is bounded.** Each layer is a separate query, so one report costs
 * seven requests to a public service somebody else pays to run. A small batch
 * that drains over several invocations is the courteous shape, and it also
 * means a bad deploy cannot spend an afternoon of somebody's rate limit.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCorsHeaders } from '../_shared/auth.ts';
import { internalError } from '../_shared/errorResponse.ts';
import {
  ASGS_RELEASE,
  BOUNDARY_SOURCE,
  isPlausiblyAustralian,
  resolveGeography,
  type AsgsArea,
  type AsgsLookup,
  type Sa2Hierarchy,
} from '../_shared/geography/asgsGeography.pure.ts';

const corsHeaders = createCorsHeaders();
const GEO_TIMEOUT_MS = 20_000;

/** Reports resolved per invocation. Seven public queries each. */
const BATCH = 8;

/** The ASGS layers this reads, and the field each answers with. */
const LAYERS: ReadonlyArray<{ key: keyof AsgsLookup; layer: string; code: string; name: string }> = [
  { key: 'sal', layer: 'SAL', code: 'sal_code_2021', name: 'sal_name_2021' },
  { key: 'poa', layer: 'POA', code: 'poa_code_2021', name: 'poa_name_2021' },
  { key: 'sa2', layer: 'SA2', code: 'sa2_code_2021', name: 'sa2_name_2021' },
  { key: 'ra', layer: 'RA', code: 'ra_code_2021', name: 'ra_name_2021' },
  { key: 'ucl', layer: 'UCL', code: 'ucl_code_2021', name: 'ucl_name_2021' },
  { key: 'sua', layer: 'SUA', code: 'sua_code_2021', name: 'sua_name_2021' },
];

async function queryLayer(
  layer: string, codeField: string, nameField: string, lat: number, lng: number,
): Promise<AsgsArea | null> {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: `${codeField},${nameField}`,
    returnGeometry: 'false',
    f: 'json',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://geo.abs.gov.au/arcgis/rest/services/${ASGS_RELEASE}/${layer}/MapServer/0/query?${params}`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`ABS geoserver answered ${res.status} for ${layer}`);
    const body = await res.json() as {
      error?: unknown;
      features?: Array<{ attributes?: Record<string, unknown> }>;
    };
    // ArcGIS reports failures as 200 plus an error body. That is transport.
    if (body.error) throw new Error(`ABS geoserver returned an error body for ${layer}`);
    const attrs = body.features?.[0]?.attributes;
    const code = attrs?.[codeField];
    const name = attrs?.[nameField];
    if (typeof code !== 'string' || !code) return null;
    return { code, name: typeof name === 'string' && name ? name : code };
  } finally {
    clearTimeout(timer);
  }
}

/** Every layer for one point. A single failure fails the whole lookup. */
async function lookupPoint(lat: number, lng: number): Promise<AsgsLookup> {
  const empty: AsgsLookup = {
    sal: null, poa: null, sa2: null, ra: null, ucl: null, sua: null,
    salNeighbours: [], serviceFailed: true,
  };
  try {
    const areas = await Promise.all(
      LAYERS.map((l) => queryLayer(l.layer, l.code, l.name, lat, lng)),
    );
    const out: Record<string, AsgsArea | null> = {};
    LAYERS.forEach((l, i) => { out[l.key as string] = areas[i]; });
    return {
      sal: out.sal, poa: out.poa, sa2: out.sa2, ra: out.ra, ucl: out.ucl, sua: out.sua,
      // Neighbour detection needs an envelope query; the backfill's finding was
      // that it matters rarely, so it is left empty rather than approximated.
      salNeighbours: out.sal ? [out.sal] : [],
      serviceFailed: false,
    };
  } catch (_e) {
    return empty;
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Reports with no geography row yet. Never re-resolves a settled one:
    // a resolved coordinate does not change, and re-running would spend a
    // public service's budget to write the same answer.
    const { data: pending, error: readError } = await supabase
      .from('investment_reports')
      .select('id, location_intelligence')
      .not('location_intelligence', 'is', null)
      .limit(200);

    if (readError) {
      return new Response(
        JSON.stringify({ success: false, error: 'could not read reports', detail: readError.message }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: existing } = await supabase
      .from('report_geography').select('report_id').limit(5000);
    const done = new Set((existing ?? []).map((r) => r.report_id as string));

    const todo = (pending ?? []).filter((r) => !done.has(r.id as string)).slice(0, BATCH);
    const results: Array<{ reportId: string; status: string }> = [];

    for (const row of todo) {
      const li = row.location_intelligence as Record<string, unknown> | null;
      const coords = (li?.coordinates ?? null) as Record<string, unknown> | null;
      const latitude = num(coords?.lat);
      const longitude = num(coords?.lng);

      // The boundary service is only asked about a point that could be here.
      // Asking it about London wastes a request to be told what the bounding
      // box already knows.
      const worthAsking = latitude !== null && longitude !== null
        && isPlausiblyAustralian({ latitude, longitude });

      const lookup = worthAsking ? await lookupPoint(latitude, longitude) : null;

      let hierarchy: Sa2Hierarchy | null = null;
      if (lookup?.sa2) {
        const { data: meta } = await supabase
          .from('abs_sa2_meta')
          .select('sa2_code, sa2_name, sa3_name, sa4_name, gccsa_name, state_name')
          .eq('sa2_code', lookup.sa2.code).maybeSingle();
        if (meta) {
          hierarchy = {
            sa2Code: meta.sa2_code as string,
            sa2Name: meta.sa2_name as string,
            sa3Name: (meta.sa3_name as string) ?? null,
            sa4Name: (meta.sa4_name as string) ?? null,
            gccsaName: (meta.gccsa_name as string) ?? null,
            stateName: (meta.state_name as string) ?? null,
          };
        }
      }

      const resolved = resolveGeography({
        coordinate: latitude !== null && longitude !== null ? { latitude, longitude } : null,
        lookup,
        hierarchy,
        directoryMatches: [],
      });

      const { error: writeError } = await supabase.from('report_geography').upsert({
        report_id: row.id,
        latitude, longitude,
        suburb: resolved.suburb,
        locality_code: resolved.localityCode,
        postcode: resolved.postcode,
        state: resolved.state,
        sa2_code: resolved.sa2Code,
        sa2_name: resolved.sa2Name,
        sa3_name: resolved.sa3Name,
        sa4_name: resolved.sa4Name,
        gccsa_name: resolved.gccsaName,
        remoteness_area: resolved.remotenessArea,
        urban_centre: resolved.urbanCentre,
        significant_urban_area: resolved.significantUrbanArea,
        method: 'point_in_polygon',
        boundary_source: BOUNDARY_SOURCE,
        source_version: ASGS_RELEASE,
        status: resolved.status,
        flags: resolved.flags,
        notes: resolved.notes.join(' '),
      }, { onConflict: 'report_id' });

      results.push({
        reportId: row.id as string,
        status: writeError ? `write_failed: ${writeError.message}` : resolved.status,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      resolved: results.length,
      remaining: Math.max(0, (pending ?? []).filter((r) => !done.has(r.id as string)).length - results.length),
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('resolve-report-geography failed:', error);
    return new Response(
      JSON.stringify({ success: false, ...internalError(error, 'resolve-report-geography') }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
