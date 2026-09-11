/**
 * ME-6 — the zero-cost market-evidence inventory, as data.
 *
 * Aurixa is not buying additional property-data subscriptions at this stage, so
 * the question became: how far can an evidence-backed score be taken on
 * authoritative open data, credentials already held, and legitimate free
 * trials? This module is the answer, measured rather than assumed, on
 * 2026-09-08.
 *
 * ## Why this is code and not just a document
 *
 * Every earlier round of this programme was undone by the same thing: a source
 * that was *catalogued* was assumed to be a source that *answers*. The
 * sanctions register was complete and current and every screening refused; the
 * transport "fetchers" ignored the coordinate; the Domain v1 route had been
 * removed. A markdown table cannot be executed, so it cannot be wrong out loud.
 * These rows carry the measurement, and `zeroCostSources.spec.ts` asserts the
 * rules over them.
 *
 * ## The three findings that decide the strategy
 *
 * **1. Reachability is not licensing, and licensing is not reachability.** The
 * finest-grained open dataset in the country — Victoria's Property Sales
 * Report, median house and unit *by suburb*, quarterly, as a time series, under
 * CC BY 3.0 AU — is published for exactly this use and **cannot be fetched**.
 * `land.vic.gov.au` answers a Cloudflare interstitial (HTTP 403, "Just a
 * moment…") to a scripted client, measured from BOTH this repository's
 * development egress and the production Supabase egress via `pg_net`. Two
 * different networks, same refusal: it is the host, not us. The licence permits
 * what the transport denies.
 *
 * **2. The open data is not where the properties are.** This is the finding
 * that reframes the whole strategy. The denominator is
 * `growthPopulation.pure.ts` and nowhere else — this module states it and does
 * not define it, which is the rule that stopped 641 and 663 coexisting. Under
 * predicate `me7.pop.1` the Growth-ready corpus is **665 of 867**, and it is
 * concentrated in the two states with the *least* usable open data:
 *
 * | state | Growth-ready | share | open suburb x type median sale price |
 * | --- | ---: | ---: | --- |
 * | QLD | 338 | 50.8% | **none** — QGSO's housing theme is building approvals |
 * | WA | 137 | 20.6% | **none** — Landgate's is `Custom (Other)` licensing |
 * | VIC | 131 | 19.7% | yes, CC BY — and unreachable (finding 1) |
 * | NSW | 40 | 6.0% | raw bulk sales only; medians must be derived |
 * | SA/TAS/ACT/NT | 19 | 2.9% | partial |
 *
 * Seventy-one per cent of the corpus sits in QLD and WA, and neither publishes an
 * open suburb-level median residential sale price series at all. ABS does not
 * close it either: `RES_DWELL_ST` is *state* grain and `RPPI` is *capital city*
 * grain — checked against all 1,227 published ABS dataflows, of which none
 * carries suburb-level price.
 *
 * **3. What remains is real, and it is Demand and context — not Growth.** Rental
 * bond data, land valuations and Census/SEIFA are genuinely open, genuinely
 * reachable and genuinely useful. They do not substitute for a median sale
 * price series, and this module refuses to let them look as though they do:
 * every row states the `supplies` dimension it actually serves.
 *
 * ## The rule
 *
 * **A source is only in the zero-cost stack when licence AND reachability were
 * both measured.** `reachability` records what a real request returned and from
 * where; `licence` records what the publisher grants. Neither is inferred from
 * the other, and `acquisition` — the footing from `marketEvidence.pure.ts` —
 * is what decides whether anything derived from it may become production
 * evidence.
 */

import type { EvidenceAcquisition } from './marketEvidence.pure.ts';

export const ZERO_COST_INVENTORY_VERSION = 'me6.zerocost.1';

/** When every reachability reading in this module was taken. */
export const INVENTORY_MEASURED_ON = '2026-09-08';

/** Which scoring dimension a source can actually feed. */
export type EvidenceDimension = 'growth' | 'demand' | 'context';

/**
 * What a request to this source returned, and from where.
 *
 * `production` means the Supabase project's own egress (measured through
 * `pg_net`), which is the network a scheduled ingestion would actually run on.
 * `development` is this repository's container. They are recorded separately
 * because they disagree for some hosts and agree for others, and only the
 * production reading decides whether ingestion is possible.
 */
export type Reachability =
  | 'reachable_production'      // measured 2xx/206 from the Supabase egress
  | 'blocked_bot_challenge'     // 403 interstitial; measured from BOTH egresses
  | 'blocked_forbidden'         // plain 403 from the production egress
  | 'transport_error'           // DNS failure, HTTP/2 framing error, timeout
  | 'not_measured';

/** Geographic grain the source actually publishes at. */
export type SourceGrain = 'suburb' | 'lga' | 'sa2' | 'postcode' | 'state' | 'capital_city' | 'small_area';

export interface ZeroCostSource {
  id: string;
  jurisdiction: 'AU' | 'NSW' | 'VIC' | 'QLD' | 'SA' | 'WA' | 'TAS' | 'ACT' | 'NT';
  publisher: string;
  title: string;
  /** The dimension this can serve. Never more than it can. */
  supplies: EvidenceDimension;
  grain: SourceGrain;
  /** Does it separate houses from units/apartments? */
  dwellingSegmented: boolean;
  /** Publisher's own licence string, verbatim where one is published. */
  licence: string;
  acquisition: EvidenceAcquisition;
  /** Live API, or a file that a scheduled job must fetch and parse. */
  delivery: 'api' | 'file' | 'catalogue_api';
  reachability: Reachability;
  /** What the measurement actually returned. Evidence, not opinion. */
  measurement: string;
  /** Whether a scheduled ingestion job would be required to use it. */
  scheduledIngestionRequired: boolean;
}

/**
 * The measured inventory.
 *
 * Ordered by the corpus share of the jurisdiction it serves, because that is
 * the order in which a gap actually costs something.
 */
export const ZERO_COST_SOURCES: readonly ZeroCostSource[] = [
  // ---- QLD: 50.8% of the Growth-ready corpus (me7.pop.1), and no open price series.
  {
    id: 'qld_land_valuations',
    jurisdiction: 'QLD',
    publisher: 'Queensland Government (Resources)',
    title: 'Historical trends in land valuations',
    supplies: 'context',
    grain: 'lga',
    dwellingSegmented: false,
    licence: 'Creative Commons Attribution 3.0 Australia',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'reachable_production',
    measurement: 'data.qld.gov.au CKAN package_search answered 200 with JSON. '
      + 'A LAND valuation is not a sale price and cannot stand in for one.',
    scheduledIngestionRequired: true,
  },

  // ---- WA: 20.6%, and the one candidate is not openly licensed.
  {
    id: 'wa_landgate_residential_attributes',
    jurisdiction: 'WA',
    publisher: 'Landgate',
    title: 'Residential Property Attributes Data (LGATE-287)',
    supplies: 'context',
    grain: 'lga',
    dwellingSegmented: true,
    licence: 'Custom (Other) — not an open licence; terms not established',
    acquisition: 'licensing_unverified',
    delivery: 'file',
    reachability: 'reachable_production',
    measurement: 'catalogue.data.wa.gov.au returned 206 Partial Content '
      + '(application/vnd.ms-excel) from the production egress. Reachable; rights unverified.',
    scheduledIngestionRequired: true,
  },

  // ---- VIC: 19.7%. The best dataset in the country for this, and it is walled.
  {
    id: 'vic_property_sales_median_by_suburb',
    jurisdiction: 'VIC',
    publisher: 'Victorian Department of Transport and Planning',
    title: 'Victorian Property Sales Report — Median House / Unit by Suburb, Time Series',
    supplies: 'growth',
    grain: 'suburb',
    dwellingSegmented: true,
    licence: 'Creative Commons Attribution 3.0 Australia',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'blocked_bot_challenge',
    measurement: 'land.vic.gov.au answered 403 with a Cloudflare "Just a moment..." '
      + 'interstitial to BOTH the development egress (curl, with and without an '
      + 'identifying User-Agent) and the production Supabase egress (pg_net, request '
      + '126902/126922). Licence permits reuse; the host refuses non-browser clients.',
    scheduledIngestionRequired: true,
  },
  {
    id: 'vic_rental_report_moving_annual_by_suburb',
    jurisdiction: 'VIC',
    publisher: 'Homes Victoria / DFFH',
    title: 'Rental Report — Quarterly: Moving Annual Rents by Suburb',
    supplies: 'demand',
    grain: 'suburb',
    dwellingSegmented: true,
    licence: 'Creative Commons Attribution 3.0 Australia',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'transport_error',
    measurement: 'dffh.vic.gov.au: development egress returned an Akamai block citing '
      + '"high volume of simultaneous submissions from your network"; production egress '
      + '(pg_net 126904) failed with "Stream error in the HTTP/2 framing layer".',
    scheduledIngestionRequired: true,
  },

  // ---- NSW: 5.4%. Raw sales, openly licensed, reachable — medians must be derived.
  {
    id: 'nsw_vg_property_sales_information',
    jurisdiction: 'NSW',
    publisher: 'NSW Valuer General',
    title: 'Property Sales Information (bulk weekly/annual sales files)',
    supplies: 'growth',
    grain: 'suburb',
    dwellingSegmented: false,
    licence: 'Creative Commons Attribution',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'reachable_production',
    measurement: 'valuation.property.nsw.gov.au answered 200 from the production egress '
      + '(pg_net 126926). Individual sales, not medians: a median by suburb and dwelling '
      + 'type would be DERIVED here, and dwelling type is not a column in the sales file.',
    scheduledIngestionRequired: true,
  },

  // ---- Smaller jurisdictions.
  {
    id: 'tas_rental_bond_data',
    jurisdiction: 'TAS',
    publisher: 'Department of Justice (Tasmania)',
    title: 'Rental Bond and Rental Data (annual)',
    supplies: 'demand',
    grain: 'postcode',
    dwellingSegmented: true,
    licence: 'Creative Commons Attribution 4.0 International',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'reachable_production',
    measurement: 'Hosted on data.gov.au, which returned 206 Partial Content with a real '
      + 'XLSX payload (PK header) from the production egress (pg_net 126921).',
    scheduledIngestionRequired: true,
  },
  {
    id: 'sa_metro_median_house_sales',
    jurisdiction: 'SA',
    publisher: 'SA Department for Housing and Urban Development',
    title: 'Metro median house sales',
    supplies: 'growth',
    grain: 'suburb',
    dwellingSegmented: false,
    licence: 'Creative Commons Attribution',
    acquisition: 'open_public',
    delivery: 'file',
    reachability: 'blocked_forbidden',
    measurement: 'data.sa.gov.au file downloads answered a plain 403 from the production '
      + 'egress (pg_net 126919/126920) while its CKAN search API answered 200. The '
      + 'catalogue is open and the file host is not.',
    scheduledIngestionRequired: true,
  },
  {
    id: 'melbourne_house_prices_small_area',
    jurisdiction: 'VIC',
    publisher: 'City of Melbourne',
    title: 'House Prices by Small Area — Sale Year',
    supplies: 'growth',
    grain: 'small_area',
    dwellingSegmented: true,
    licence: 'Creative Commons Attribution 4.0 International',
    acquisition: 'open_public',
    delivery: 'api',
    reachability: 'reachable_production',
    measurement: 'Opendatasoft CSV export answered 200 from the production egress '
      + '(pg_net 126924) with header '
      + '"sale_year;small_area;type;median_price;transaction_count" — exactly the Growth '
      + 'shape. Covers ONE local government area, so it reaches almost none of the corpus.',
    scheduledIngestionRequired: false,
  },

  // ---- National context. Real, open, reachable — and never suburb grain.
  {
    id: 'abs_res_dwell_st',
    jurisdiction: 'AU',
    publisher: 'Australian Bureau of Statistics',
    title: 'RES_DWELL_ST — Residential Dwellings: Values, Mean Price and Number',
    supplies: 'context',
    grain: 'state',
    dwellingSegmented: false,
    licence: 'Creative Commons Attribution 4.0 International',
    acquisition: 'open_public',
    delivery: 'api',
    reachability: 'reachable_production',
    measurement: 'data.api.abs.gov.au SDMX answered 200. State and territory grain only — '
      + 'a benchmark, never a suburb signal.',
    scheduledIngestionRequired: false,
  },
  {
    id: 'abs_rppi',
    jurisdiction: 'AU',
    publisher: 'Australian Bureau of Statistics',
    title: 'RPPI — Residential Property Price Index',
    supplies: 'context',
    grain: 'capital_city',
    dwellingSegmented: false,
    licence: 'Creative Commons Attribution 4.0 International',
    acquisition: 'open_public',
    delivery: 'api',
    reachability: 'reachable_production',
    measurement: 'Present in the ABS dataflow catalogue (1,227 flows enumerated). '
      + 'Capital-city grain. Of all 1,227 flows, none publishes suburb-level price.',
    scheduledIngestionRequired: false,
  },
];

/** Sources that can actually be ingested today: open licence AND reachable. */
export function ingestableToday(
  sources: readonly ZeroCostSource[] = ZERO_COST_SOURCES,
): readonly ZeroCostSource[] {
  return sources.filter(
    (s) => s.acquisition === 'open_public' && s.reachability === 'reachable_production',
  );
}

/**
 * Sources blocked by transport rather than by licence.
 *
 * Kept as its own reading because the remedy is completely different: a
 * licensing gap needs a commercial conversation, a transport gap needs a
 * publisher contacted about their bot rules — and reporting one as the other
 * sends somebody to the wrong door.
 */
export function blockedByTransport(
  sources: readonly ZeroCostSource[] = ZERO_COST_SOURCES,
): readonly ZeroCostSource[] {
  return sources.filter(
    (s) => s.acquisition === 'open_public'
      && (s.reachability === 'blocked_bot_challenge'
        || s.reachability === 'blocked_forbidden'
        || s.reachability === 'transport_error'),
  );
}

/** Zero-cost sources that can serve Growth at suburb grain, today. */
export function growthCapableToday(
  sources: readonly ZeroCostSource[] = ZERO_COST_SOURCES,
): readonly ZeroCostSource[] {
  return ingestableToday(sources).filter(
    (s) => s.supplies === 'growth' && (s.grain === 'suburb' || s.grain === 'small_area'),
  );
}
