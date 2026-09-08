/**
 * Read-only reachability probe for market-evidence sources.
 *
 * ## What this is for
 *
 * Two questions could not be answered from outside the deployment, and both
 * gate the Canonical Market Evidence work (audit §47-§51):
 *
 *  1. **Is a market-data credential present in this project's environment?**
 *     `integration_configs` holds an empty row, `update-integration-secret`
 *     writes the environment rather than that table, and the audit log that
 *     would have recorded a change was itself broken (§50). Only the runtime
 *     can see `Deno.env`.
 *  2. **Does the Supabase egress reach the government sources that refuse this
 *     repository's tooling?** `land.vic.gov.au` answers 403 and the NSW Valuer
 *     General 502 from the development egress, exactly as directory.gov.au and
 *     aph.gov.au did during the PEP work — where the answer turned out to be
 *     that the two egresses differ.
 *
 * ## Four rules
 *
 * **Nothing is written.** No table, no report, no score. This function exists
 * to answer questions, and a diagnostic that mutates is a diagnostic nobody
 * dares run.
 *
 * **A credential is never returned, logged or echoed** — only whether a name is
 * SET. Not its length, not a prefix, not a masked form: a length is a hint and
 * a prefix identifies the issuer.
 *
 * **Targets come from this module, never from the request.** A probe that took
 * a URL from the caller would be server-side request forgery in a function
 * holding the service-role key. The body selects a target by NAME from
 * {@link TARGETS} and nothing else.
 *
 * **A failure is classified, not summarised.** "Unavailable" sent the last
 * investigation to the wrong remedy twice; credential-absent, credential-
 * invalid, scope-missing, package-not-entitled, route-not-found, rate-limited
 * and reachable are different findings with different owners.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from "../_shared/auth.ts";
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { internalError } from "../_shared/errorResponse.ts";

/**
 * Credential names to report presence for. Presence only — never a value.
 *
 * Both providers are listed under their CURRENT and LEGACY shapes, because the
 * repository models each as a single API key while both APIs in fact want
 * OAuth2 client credentials (§51, §52). Which names exist is the evidence that
 * settles whether an integration was configured, half-configured, or
 * configured against a contract the vendor has since replaced.
 */
const CREDENTIAL_NAMES = [
  // Domain: legacy X-Api-Key, then the client-credentials pair.
  "DOMAIN_API_KEY",
  "DOMAIN_CLIENT_ID",
  "DOMAIN_CLIENT_SECRET",
  // Cotality/CoreLogic: legacy single key, then the client-credentials pair.
  "COTALITY_API_KEY",
  "COTALITY_CLIENT_ID",
  "COTALITY_CLIENT_SECRET",
  "COTALITY_BASE_URL",
  // PropTrack is REA Group's data arm — the LICENSED route to
  // realestate.com.au's data. Scraping the consumer site is refused by REA's
  // own robots.txt in as many words, so it is not a route this platform takes.
  "PROPTRACK_API_KEY",
  "PROPTRACK_BASE_URL",
  // Pricefinder (sales evidence) and SQM Research (vacancy, stock on market)
  // — the only declared source for a vacancy rate at suburb grain.
  "PRICEFINDER_API_KEY",
  "SQM_RESEARCH_API_KEY",
] as const;

/**
 * How a provider stands, before any network call.
 *
 * `licensing_unverified` is deliberately its own state and not a failure: a
 * provider can be perfectly reachable and correctly credentialled and still be
 * unusable in a client-facing report, because redistribution rights are a
 * commercial fact rather than a technical one. Cotality's own scoping
 * document leaves those questions open, so nothing may assume them.
 */
type ProviderStatus =
  | "configured_and_testable"
  | "credential_absent"
  | "authentication_implementation_obsolete"
  | "entitlement_unavailable"
  | "licensing_unverified";

interface Target {
  /** How the caller names it. */
  id: string;
  url: string;
  /** Bytes to request; a range keeps a probe cheap against a large file. */
  rangeBytes?: number;
  note: string;
}

/**
 * The only URLs this function will ever request.
 *
 * WA's SLIP platform is deliberately absent: its licence bars commercial
 * republication, so the platform does not fetch it at all.
 */
const TARGETS: readonly Target[] = [
  {
    id: "domain_v2_suburb_performance",
    url:
      "https://api.domain.com.au/v2/suburbPerformanceStatistics/NSW/Bowral/2576" +
      "?propertyCategory=house&chronologicalSpan=12&tPlusFrom=1&tPlusTo=12",
    note: "Domain Properties & Locations — the v2 route the repo does not yet call.",
  },
  {
    id: "domain_v1_suburb_performance",
    url:
      "https://api.domain.com.au/v1/suburbPerformanceStatistics/NSW/Bowral" +
      "?propertyCategory=house&chronologicalSpan=12&tPlusFrom=1&tPlusTo=12",
    note: "The v1 route domain-data-service calls today.",
  },
  {
    // Cotality/CoreLogic suburb statistics — branch 4 of the scoping spec
    // ("Market Trends / Suburb Stats"). The host is the default configured in
    // cotality-service; COTALITY_BASE_URL overrides it at runtime, and that is
    // SERVER configuration rather than caller input, so it cannot be used to
    // point this function at an arbitrary host.
    id: "cotality_suburb_statistics",
    url: "https://api.corelogic.asia/property/au/v2/statistics/locality/1234",
    note: "Cotality Market Trends / Suburb Statistics — the branch-4 endpoint shape.",
  },
  {
    id: "proptrack_market_api",
    url:
      "https://data.proptrack.com/api/v2/market/sale/historic-median-sale-price" +
      "?suburb=Bowral&state=NSW&postcode=2576&propertyTypes=house&frequency=monthly",
    note: "PropTrack (REA Group) historic median sale price — the licensed realestate.com.au route.",
  },
  {
    id: "vic_data_catalogue",
    url: "https://discover.data.vic.gov.au/api/3/action/package_search?q=median+house+suburb&rows=1",
    rangeBytes: 2048,
    note: "Victorian open-data CATALOGUE. Reachable where the file host is not.",
  },
  {
    id: "qld_statistician",
    url: "https://www.qgso.qld.gov.au/",
    rangeBytes: 2048,
    note: "Queensland Government Statistician — median sales by suburb publisher.",
  },
  {
    id: "vic_median_house_by_suburb",
    url: "https://www.land.vic.gov.au/__data/assets/excel_doc/0032/756581/houses-by-suburb-2014-2024.xlsx",
    rangeBytes: 2048,
    note: "Victorian Property Sales Report, median house by suburb 2014-2024. CC-BY 4.0.",
  },
  {
    id: "nsw_valuer_general_psi",
    url: "https://www.valuation.property.nsw.gov.au/embed/propertySalesInformation",
    rangeBytes: 2048,
    note: "NSW Valuer General bulk property sales index page.",
  },
  {
    id: "sa_data_portal",
    url: "https://data.sa.gov.au/data/api/3/action/package_search?q=metro+median+house+sales&rows=1",
    rangeBytes: 2048,
    note: "data.sa.gov.au CKAN — metro median house sales.",
  },
  {
    id: "abs_res_dwell",
    url: "https://data.api.abs.gov.au/rest/data/ABS,RES_DWELL,/all?startPeriod=2026-Q1",
    rangeBytes: 2048,
    note: "ABS RES_DWELL — regional benchmark/context layer.",
  },
];

/** What a probe outcome means, in the operator's terms. */
type Verdict =
  | "reachable"
  | "credential_absent"
  | "credential_invalid_or_scope_missing"
  | "not_entitled"
  | "route_not_found"
  | "rate_limited"
  | "blocked_by_origin"
  | "server_error"
  | "unreachable";

function classify(status: number, hasCredential: boolean): Verdict {
  if (status >= 200 && status < 300) return "reachable";
  if (status === 401) return hasCredential ? "credential_invalid_or_scope_missing" : "credential_absent";
  if (status === 403) return hasCredential ? "not_entitled" : "blocked_by_origin";
  if (status === 404) return "route_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unreachable";
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const body = await req.json().catch(() => ({}));
    const { error: authError } = await verifyAuth(supabase, req.headers, body);
    if (authError) return createUnauthorizedResponse(authError, corsHeaders);

    // Presence only. Never a value, never a length, never a prefix.
    const credentials: Record<string, boolean> = {};
    for (const name of CREDENTIAL_NAMES) {
      credentials[name] = Boolean(Deno.env.get(name)?.trim());
    }
    const hasDomainKey = credentials.DOMAIN_API_KEY === true;
    const hasDomainOAuth =
      credentials.DOMAIN_CLIENT_ID === true && credentials.DOMAIN_CLIENT_SECRET === true;

    // A caller may narrow to some targets BY NAME. It can never supply a URL.
    const requested: unknown = (body as Record<string, unknown>)?.targets;
    const wanted = Array.isArray(requested)
      ? TARGETS.filter((t) => requested.includes(t.id))
      : TARGETS;

    const results = [];
    for (const target of wanted) {
      const isDomain = target.id.startsWith("domain_");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (target.rangeBytes) headers["Range"] = `bytes=0-${target.rangeBytes - 1}`;
      // Send whichever Domain credential exists. Legacy key and OAuth bearer are
      // both attempted so the response distinguishes "wrong scheme" from
      // "wrong credential" — neither is echoed back.
      if (isDomain && hasDomainKey) headers["X-Api-Key"] = Deno.env.get("DOMAIN_API_KEY")!;

      const startedAt = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const response = await fetch(target.url, {
          method: "GET",
          headers,
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timer);
        const text = await response.text();
        results.push({
          id: target.id,
          note: target.note,
          status: response.status,
          verdict: classify(response.status, isDomain ? hasDomainKey || hasDomainOAuth : true),
          contentType: response.headers.get("content-type"),
          contentLength: response.headers.get("content-length"),
          bytesRead: text.length,
          // Bounded, and only ever the provider's own diagnostic text.
          bodyPreview: text.slice(0, 400),
          elapsedMs: Date.now() - startedAt,
        });
      } catch (cause) {
        results.push({
          id: target.id,
          note: target.note,
          status: 0,
          verdict: "unreachable" as Verdict,
          error: cause instanceof Error ? cause.message : String(cause),
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    // Classify each provider from what is configured, before the network says
    // anything. A provider with no credential cannot be distinguished from one
    // with a bad credential by its 401 alone, which is why presence is read
    // from the environment rather than inferred from a status code.
    const hasCotalityKey = credentials.COTALITY_API_KEY === true;
    const hasCotalityOAuth =
      credentials.COTALITY_CLIENT_ID === true && credentials.COTALITY_CLIENT_SECRET === true;

    const providers = {
      domain: {
        status: (hasDomainOAuth
          ? "configured_and_testable"
          : hasDomainKey
            ? "authentication_implementation_obsolete"
            : "credential_absent") as ProviderStatus,
        authScheme: hasDomainOAuth ? "oauth_client_credentials" : hasDomainKey ? "api_key_legacy" : "none",
        // v1 answers 404 "No Matching Route"; the live contract is v2 with a
        // {postcode} segment and a Bearer token (§51).
        repositoryImplementation: "v1 + X-Api-Key (obsolete)",
        licensingStatus: "not_assessed",
      },
      cotality: {
        status: (hasCotalityOAuth
          ? "configured_and_testable"
          : hasCotalityKey
            ? "authentication_implementation_obsolete"
            : "credential_absent") as ProviderStatus,
        authScheme: hasCotalityOAuth ? "oauth_client_credentials" : hasCotalityKey ? "api_key_legacy" : "none",
        // Every branch resolver is a stub: there is no fetch to Cotality
        // anywhere in cotality-service, so a credential alone changes nothing.
        repositoryImplementation: "scaffolding only — no outbound call exists",
        // A production gate, never a development blocker. Cotality's own
        // scoping spec leaves cache duration, redistribution rights for
        // client-facing PDFs, and the right to persist derived metrics open.
        licensingStatus: "unverified",
      },
    };

    return json({
      probe: "market-source-probe",
      readOnly: true,
      probedAt: new Date().toISOString(),
      credentialsPresent: credentials,
      providers,
      results,
    });
  } catch (cause) {
    // Never hand a caught error back to the caller: a Postgres message carries
    // table, column and constraint names, and this function holds the
    // service-role key. `internalError` logs the detail against a correlation
    // id and returns only that id.
    return json(internalError(cause, "market-source-probe"), 500);
  }
});
