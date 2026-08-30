/**
 * Builder stock lists — the normalisation layer.
 *
 * Every builder sends a different spreadsheet. This module maps whatever a
 * file happened to call a column onto the fixed set of fields
 * `builder_stock_items` holds, and refuses to do anything else.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a value that is not in the file does
 * not appear in the output. There is no inference, no default price, no
 * assumed state, no "probably a house". A missing optional field is `null`,
 * and a row that carries nothing identifying is dropped rather than imported
 * as an empty property.
 *
 * Pure: no IO, no clock, and its one import is another pure module. It is
 * loaded by the edge function under Deno and by `src/lib/__tests__` under
 * vitest, which is why it has an explicit `.pure.ts` name and no `@/` alias
 * anywhere.
 */
import { SOURCE_ANCHOR_HEADER } from './sourceAssets.pure.ts';
import { composeAddressLine } from './canonicalIdentity.pure.ts';

export type StockPropertyType =
  | 'house' | 'townhouse' | 'apartment' | 'duplex' | 'land' | 'terrace'
  | 'house_and_land' | 'other';

export type StockAvailability =
  | 'available' | 'on_hold' | 'reserved' | 'contracted' | 'sold' | 'settled'
  | 'withdrawn' | 'unknown';

/** The canonical shape. Mirrors the columns of `builder_stock_items`. */
export interface NormalisedStockRecord {
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  unit_number: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  property_type: StockPropertyType | null;
  land_size_sqm: number | null;
  building_size_sqm: number | null;
  price: number | null;
  /** Verbatim, when the file said something a number cannot hold ("POA"). */
  price_display: string | null;
  availability_status: StockAvailability;
  expected_completion: string | null;
  description: string | null;
  /** Image URLs the file itself carried. Provenance stage 1. */
  image_urls: string[];
  /**
   * The HEADER each of those URLs sat under, verbatim.
   *
   * The column name is LEVEL 1 evidence about what the image is FOR — a row's
   * "Facade" column names the property's listing image and its "Floorplan"
   * column names something that must never reach a card — so throwing it away
   * at normalisation threw away the only thing that could tell them apart.
   * Keyed by URL rather than positional so the dedupe above cannot misalign it.
   */
  image_url_fields: Record<string, string>;
  /**
   * WHICH ROW OF THE SOURCE THIS IS — a Notion block id, a sheet and row, a
   * table row. Set only when the source stated it, and it is what ties the
   * builder's own render to this property rather than to the one beside it.
   */
  source_anchor: string | null;
  /** Every column we could not place, kept for the audit record. */
  unmapped: Record<string, string>;
}

/** Canonical field names a header can map onto. */
type FieldKey =
  | 'external_reference' | 'development_name' | 'project_name' | 'address_line'
  | 'suburb' | 'state' | 'postcode' | 'lot_number' | 'unit_number'
  | 'bedrooms' | 'bathrooms' | 'car_spaces' | 'property_type'
  | 'land_size_sqm' | 'building_size_sqm' | 'price' | 'availability_status'
  | 'expected_completion' | 'description' | 'image_url' | 'builder_name';

/**
 * Header text is compared with punctuation, spacing and case removed, so
 * "Land Size (m2)", "land_size_m2" and "LANDSIZEM2" are one key.
 */
export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The alias table. Deliberately explicit rather than fuzzy: a header this
 * table does not know lands in `unmapped`, which is visible in the audit
 * record, and adding it here is a one-line change. Guessing would eventually
 * map "Deposit" onto `price`.
 */
const HEADER_ALIASES: Record<string, FieldKey> = {};

function alias(field: FieldKey, ...headers: string[]): void {
  for (const header of headers) HEADER_ALIASES[normaliseHeader(header)] = field;
}

alias('external_reference',
  'reference', 'ref', 'stock ref', 'stock reference', 'stock id', 'stock code',
  'property id', 'property ref', 'listing id', 'listing reference', 'id',
  'item code', 'sku', 'package id', 'package code', 'external id', 'external reference');

alias('development_name',
  'development', 'development name', 'estate', 'estate name', 'community',
  'community name', 'subdivision',
  // Notion's own label for the estate column on a database view.
  'estate tag');

alias('project_name',
  'project', 'project name', 'stage', 'stage name', 'release', 'release name',
  'building', 'building name');

alias('address_line',
  'address', 'street address', 'property address', 'full address', 'address line',
  'address line 1', 'street', 'site address',
  // A Notion database's TITLE column is what names the row, and on a stock
  // list that is the lot and its address ("Lot 60434 - Cloverton Estate,
  // Kalkallo VIC 3064"). Without this every row from a Notion collection
  // carries nothing identifying and `identifiesAProperty` drops all of them.
  'deal', 'listing', 'property');

alias('suburb',
  'suburb', 'city', 'town', 'locality', 'suburb town',
  // `location` is one of the commonest headings a builder gives the suburb
  // column, and its absence here is why 86 of 89 properties on one import
  // carried no locality at all — which starves the whole fallback ladder.
  'location', 'suburb location', 'area');
alias('state', 'state', 'st', 'state territory', 'region');
alias('postcode', 'postcode', 'post code', 'postal code', 'zip', 'zip code');

alias('lot_number', 'lot', 'lot no', 'lot number', 'lot #', 'lotno');
alias('unit_number',
  'unit', 'unit no', 'unit number', 'apartment', 'apartment number', 'apt',
  'townhouse number', 'house number', 'dwelling', 'dwelling number');

alias('bedrooms', 'bed', 'beds', 'bedroom', 'bedrooms', 'br', 'no of bedrooms');
alias('bathrooms', 'bath', 'baths', 'bathroom', 'bathrooms', 'ba', 'no of bathrooms');
alias('car_spaces',
  'car', 'cars', 'car space', 'car spaces', 'garage', 'garages', 'parking',
  'parking spaces', 'carports');

alias('property_type',
  'type', 'property type', 'dwelling type', 'product', 'product type',
  'house type', 'stock type');

// The unit is written six ways — "(m2)", "m²", "sqm", "sq m" — and the header
// normaliser strips the punctuation but not the letters, so each spelling is a
// distinct key and has to be listed.
alias('land_size_sqm',
  'land', 'land size', 'land area', 'land size sqm', 'land size m2',
  'land size m²', 'land m2', 'land m²', 'land sqm', 'land sq m',
  'block size', 'block size m2', 'lot size', 'lot size m2', 'land area sqm',
  'land area m2', 'land area m²');

alias('building_size_sqm',
  'build size', 'build size m2', 'building size', 'building size sqm',
  'building size m2', 'house size', 'house size m2', 'floor area',
  'floor area m2', 'floor area sqm', 'internal area', 'internal area sqm',
  'living area', 'build area', 'home size', 'building area sqm',
  'building area m2', 'house area');

alias('price',
  'price', 'total price', 'list price', 'package price', 'asking price',
  'sale price', 'price from', 'full price', 'purchase price', 'amount');

alias('availability_status',
  'status', 'availability', 'available', 'sales status', 'stock status',
  'availability status', 'package status', 'lot status', 'property status');

alias('expected_completion',
  'completion', 'expected completion', 'completion date', 'est completion',
  'estimated completion', 'titles', 'titled', 'handover', 'handover date',
  'settlement', 'ready date');

alias('description',
  'description', 'notes', 'comments', 'details', 'features', 'inclusions',
  'remarks');

/**
 * Columns that carry an image FOR THE PROPERTY.
 *
 * Every one of these names the row's own picture, which is what makes a hit
 * LEVEL 1 primary evidence in `sourceImageRole.pure.ts`. A column naming
 * something else — "Floorplan", "Site Plan", "Masterplan" — is deliberately
 * absent: it would be mapped here, read as the property's image, and printed on
 * a client's card.
 */
alias('image_url',
  'image', 'images', 'image url', 'image urls', 'photo', 'photos', 'photo url',
  'render', 'renders', 'facade image', 'picture', 'facade', 'facade url',
  'hero image', 'primary image', 'property image', 'listing image',
  'render url', 'photo urls', 'image link');

alias('builder_name',
  'builder', 'builder name', 'developer', 'developer name', 'vendor', 'supplier');

/**
 * Every canonical field also answers to its own name. A model extracting from
 * prose returns these keys directly, and it would be absurd for the alias
 * table to recognise "Land Size (m2)" but not `land_size_sqm`.
 */
for (const field of [
  'external_reference', 'development_name', 'project_name', 'address_line',
  'suburb', 'state', 'postcode', 'lot_number', 'unit_number', 'bedrooms',
  'bathrooms', 'car_spaces', 'property_type', 'land_size_sqm',
  'building_size_sqm', 'price', 'availability_status', 'expected_completion',
  'description', 'image_url', 'builder_name',
] as FieldKey[]) {
  alias(field, field);
}

/** The field a header maps onto, or null when we do not recognise it. */
export function fieldForHeader(raw: unknown): string | null {
  return HEADER_ALIASES[normaliseHeader(raw)] ?? null;
}

// ---------------------------------------------------------------------------
// Coercion. Each returns null rather than a guess.
// ---------------------------------------------------------------------------

function text(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  // Spreadsheets are full of these. They mean "not stated", not a value.
  if (/^(n\/?a|nil|none|tbc|tba|-{1,3}|\.|unknown|null)$/i.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

/**
 * A number, from whatever a spreadsheet cell contains. "$749,000" is 749000;
 * "3.5" is 3.5; "3+1" is 3 (the leading figure, which is what a "3+1 garage"
 * column means); "POA" is null.
 */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value, 60);
  if (raw === null) return null;
  const match = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Price, plus what the file literally said.
 *
 * The display string is kept whenever the cell was not a bare number, because
 * "From $749,000" and "$749,000" are different claims and the second must not
 * be printed for the first.
 */
export function coercePrice(value: unknown): { price: number | null; display: string | null } {
  const raw = text(value, 120);
  if (raw === null) return { price: null, display: null };
  const numeric = coerceNumber(raw);
  const bare = /^\$?\s*\d[\d,]*(\.\d+)?$/.test(raw);
  if (numeric === null) return { price: null, display: raw };
  return { price: numeric, display: bare ? null : raw };
}

const STATES: Record<string, string> = {
  nsw: 'NSW', newsouthwales: 'NSW',
  vic: 'VIC', victoria: 'VIC',
  qld: 'QLD', queensland: 'QLD',
  sa: 'SA', southaustralia: 'SA',
  wa: 'WA', westernaustralia: 'WA',
  tas: 'TAS', tasmania: 'TAS',
  nt: 'NT', northernterritory: 'NT',
  act: 'ACT', australiancapitalterritory: 'ACT',
};

export function coerceState(value: unknown): string | null {
  const raw = text(value, 60);
  if (raw === null) return null;
  return STATES[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

export function coercePostcode(value: unknown): string | null {
  const raw = text(value, 20);
  if (raw === null) return null;
  const match = raw.match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

const PROPERTY_TYPES: Array<[RegExp, StockPropertyType]> = [
  [/house\s*(&|and|\+)\s*land|h\s*&\s*l|hl\s*package|package/i, 'house_and_land'],
  [/townhouse|town\s*home|villa/i, 'townhouse'],
  [/apartment|unit\b|flat|residence/i, 'apartment'],
  [/duplex|dual\s*occ/i, 'duplex'],
  [/terrace/i, 'terrace'],
  [/land\s*only|vacant\s*land|^land$|allotment/i, 'land'],
  [/house|home|detached/i, 'house'],
];

export function coercePropertyType(value: unknown): StockPropertyType | null {
  const raw = text(value, 80);
  if (raw === null) return null;
  for (const [pattern, mapped] of PROPERTY_TYPES) {
    if (pattern.test(raw)) return mapped;
  }
  return 'other';
}

const AVAILABILITY: Array<[RegExp, StockAvailability]> = [
  [/under\s*offer|on\s*hold|holding|held/i, 'on_hold'],
  [/reserved|deposit\s*(taken|paid)|eoi/i, 'reserved'],
  [/exchanged|contracted|under\s*contract|conditional/i, 'contracted'],
  [/settled|completed/i, 'settled'],
  [/sold|unavailable|not\s*available/i, 'sold'],
  [/withdrawn|removed|off\s*market|cancelled/i, 'withdrawn'],
  [/available|active|for\s*sale|released|open|current|in\s*stock|yes/i, 'available'],
];

/**
 * Availability. Defaults to `unknown` and NOT to `available` — a row whose
 * status column we could not read must not behave like live inventory.
 */
export function coerceAvailability(value: unknown): StockAvailability {
  const raw = text(value, 80);
  if (raw === null) return 'unknown';
  for (const [pattern, mapped] of AVAILABILITY) {
    if (pattern.test(raw)) return mapped;
  }
  return 'unknown';
}

function coerceUrls(value: unknown): string[] {
  const raw = text(value, 4000);
  if (raw === null) return [];
  const out: string[] = [];
  for (const candidate of raw.split(/[\s,;|]+/)) {
    if (/^https?:\/\/\S+$/i.test(candidate) && candidate.length <= 2000) out.push(candidate);
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Row → record
// ---------------------------------------------------------------------------

/** Empty record, so every caller starts from "nothing is known". */
export function emptyStockRecord(): NormalisedStockRecord {
  return {
    external_reference: null, development_name: null, project_name: null,
    address_line: null, suburb: null, state: null, postcode: null,
    lot_number: null, unit_number: null, bedrooms: null, bathrooms: null,
    car_spaces: null, property_type: null, land_size_sqm: null,
    building_size_sqm: null, price: null, price_display: null,
    availability_status: 'unknown', expected_completion: null, description: null,
    image_urls: [], image_url_fields: {}, source_anchor: null, unmapped: {},
  };
}

/**
 * Normalise one raw row, keyed by whatever headers the file used.
 *
 * Returns null when the row identifies no property. That test is deliberately
 * low — a reference, an address, a suburb, or a lot/unit is enough — because
 * dropping a real row is worse than importing a thin one; but a row of totals
 * or a blank separator line carries none of them and must not become a
 * property.
 */
export function normaliseStockRow(
  row: Record<string, unknown>,
): NormalisedStockRecord | null {
  const record = emptyStockRecord();
  let sawAnything = false;

  for (const [header, value] of Object.entries(row)) {
    const field = fieldForHeader(header);
    const raw = text(value, 4000);
    if (raw === null) continue;

    /**
     * The reserved anchor column, lifted off the row rather than filed.
     *
     * It is NOT evidence that the row describes a property — a row carrying
     * nothing but its own identity is still an empty row — so it deliberately
     * does not set `sawAnything`, and it never lands in `unmapped`, where it
     * would be shown to a builder as a column we failed to understand.
     */
    if (normaliseHeader(header) === normaliseHeader(SOURCE_ANCHOR_HEADER)) {
      record.source_anchor = raw.slice(0, 200);
      continue;
    }

    sawAnything = true;

    if (field === null) {
      // Kept, not dropped: the audit record shows what the file carried that
      // we did not place, which is how the alias table grows.
      const key = String(header).slice(0, 80);
      if (Object.keys(record.unmapped).length < 40) record.unmapped[key] = raw.slice(0, 300);
      continue;
    }

    switch (field) {
      case 'external_reference': record.external_reference = text(value, 120); break;
      case 'development_name': record.development_name = text(value, 200); break;
      case 'project_name': record.project_name = text(value, 200); break;
      case 'address_line': record.address_line = text(value, 300); break;
      case 'suburb': record.suburb = text(value, 120); break;
      case 'state': record.state = coerceState(value); break;
      case 'postcode': record.postcode = coercePostcode(value); break;
      case 'lot_number': record.lot_number = text(value, 40); break;
      case 'unit_number': record.unit_number = text(value, 40); break;
      case 'bedrooms': record.bedrooms = clampCount(coerceNumber(value)); break;
      case 'bathrooms': record.bathrooms = clampCount(coerceNumber(value)); break;
      case 'car_spaces': record.car_spaces = clampCount(coerceNumber(value)); break;
      case 'property_type': record.property_type = coercePropertyType(value); break;
      case 'land_size_sqm': record.land_size_sqm = clampArea(coerceNumber(value)); break;
      case 'building_size_sqm': record.building_size_sqm = clampArea(coerceNumber(value)); break;
      case 'price': {
        const priced = coercePrice(value);
        record.price = priced.price;
        record.price_display = priced.display;
        break;
      }
      case 'availability_status': record.availability_status = coerceAvailability(value); break;
      case 'expected_completion': record.expected_completion = text(value, 120); break;
      case 'description': record.description = text(value, 4000); break;
      case 'image_url': {
        const urls = coerceUrls(value);
        record.image_urls.push(...urls);
        // The source's own heading, so the role can be read off it later.
        for (const url of urls) record.image_url_fields[url] ??= String(header ?? '').trim().slice(0, 120);
        break;
      }
      case 'builder_name':
        // Recorded for the audit trail only. Who supplied the stock is the
        // authenticated organisation, never a name in a spreadsheet cell.
        record.unmapped['builder_name_as_stated'] = text(value, 200) ?? '';
        break;
    }
  }

  if (!sawAnything) return null;
  if (!identifiesAProperty(record)) return null;
  record.image_urls = Array.from(new Set(record.image_urls)).slice(0, 12);
  for (const url of Object.keys(record.image_url_fields)) {
    if (!record.image_urls.includes(url)) delete record.image_url_fields[url];
  }
  return record;
}

function clampCount(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 20) return null;
  return Math.round(value * 10) / 10;
}

function clampArea(value: number | null): number | null {
  if (value === null || value < 0) return null;
  // A "land size" of 400,000 m² in a residential stock list is a unit error,
  // not a property. Keeping it would print nonsense on a client's page.
  if (value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

/** True when the row names something a person could go and look at. */
export function identifiesAProperty(record: NormalisedStockRecord): boolean {
  return !!(record.external_reference
    || record.address_line
    || record.suburb
    || record.lot_number
    || record.unit_number
    || (record.development_name && (record.price !== null || record.property_type)));
}

// ---------------------------------------------------------------------------
// Duplicate matching
// ---------------------------------------------------------------------------

export interface StockMatchKeys {
  /** organisation + the builder's own reference. */
  reference: string | null;
  /** organisation + development + lot/unit. Both halves required. */
  developmentUnit: { development: string; unit: string } | null;
  /**
   * organisation + the SOURCE'S OWN ID FOR THIS ROW.
   *
   * The strongest of the three, and the only one the live list carries. It is
   * matched FIRST and it is the only key guarded by an identity check — see
   * `stockIdentity.pure.ts` — because an anchor names a row rather than a
   * property, and a row can be edited or re-used for the next lot.
   */
  anchor: string | null;
}

/**
 * The three keys an import may match an existing row on, and no others.
 *
 * Address is deliberately absent. Two townhouses share one street address, and
 * merging them loses a property — the conservative failure is a duplicate row
 * a person can archive, not a silent merge nobody sees.
 *
 * THE ANCHOR IS THE STRONGEST AND IT IS WHY THIS LIST GREW. The two older keys
 * need a builder reference, or a development AND a lot/unit column; the live
 * Notion list carries none of them on any row — the lot lives inside the title
 * — so both were null for all twenty-three properties and every re-import
 * inserted a fresh set instead of updating. Eight uploads, `updated` zero every
 * time, and the marketplace's imagery left on rows the operator then archived.
 *
 * It is also the only key that names a ROW rather than a property, which is
 * exactly why it may never be trusted on its own: the importer pairs it with
 * `sameProperty` from `stockIdentity.pure.ts` before carrying anything forward.
 */
export function stockMatchKeys(record: NormalisedStockRecord): StockMatchKeys {
  const reference = record.external_reference
    ? record.external_reference.trim().toLowerCase()
    : null;

  const development = (record.development_name ?? record.project_name ?? '').trim().toLowerCase();
  const unit = (record.unit_number ?? record.lot_number ?? '').trim().toLowerCase();

  const anchor = record.source_anchor ? record.source_anchor.trim() : null;

  return {
    reference: reference || null,
    developmentUnit: development && unit ? { development, unit } : null,
    anchor: anchor || null,
  };
}

/**
 * A fingerprint of everything a row SAID, for re-finding the property it
 * already became.
 *
 * This is NOT a third matching key for the importer, and it must never become
 * one: two genuinely different lots can agree on every value a thin file
 * carries, and merging them would be a defect nobody can see. It exists for
 * re-reading a source whose properties are already imported — attaching an
 * image to the property this exact row produced — where the alternative is
 * matching nothing at all.
 *
 * The live Notion list is exactly that case: not one of its seventy rows
 * carries a reference, a lot column or a unit column (the lot is inside the
 * title, "Lot 60434 - Cloverton Estate…"), so both of the importer's keys are
 * null for every row and a repair that used them would find nobody.
 */
export function stockRowFingerprint(record: Partial<NormalisedStockRecord>): string {
  const part = (value: unknown) =>
    String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [
    part(record.external_reference),
    part(record.address_line),
    part(record.development_name),
    part(record.project_name),
    part(record.suburb),
    part(record.postcode),
    part(record.lot_number),
    part(record.unit_number),
    part(record.price),
    part(record.land_size_sqm),
    part(record.building_size_sqm),
    part(record.property_type),
  ].join('|');
}

/**
 * The fields a label is built from.
 *
 * Named as its own type so a STORED ROW can be labelled too: the columns carry
 * these names, and the identity rules in `stockIdentity.pure.ts` need the same
 * label from both sides of a re-import. Widening the parameter only — every
 * existing caller passes a whole record and is unaffected.
 */
export type StockLabelFields = Pick<NormalisedStockRecord,
  'unit_number' | 'lot_number' | 'address_line' | 'suburb'
  | 'development_name' | 'external_reference'>;

/** A short human label for a record, for logs and the import summary. */
export function stockRecordLabel(record: StockLabelFields): string {
  const parts: string[] = [];
  if (record.unit_number) parts.push(`Unit ${record.unit_number}`);
  else if (record.lot_number) parts.push(`Lot ${record.lot_number}`);
  if (record.address_line) parts.push(record.address_line);
  if (record.suburb) parts.push(record.suburb);
  if (!parts.length && record.development_name) parts.push(record.development_name);
  if (!parts.length && record.external_reference) parts.push(record.external_reference);
  return parts.join(', ').slice(0, 200) || 'Unnamed property';
}

/**
 * A single-line address for the image-enrichment stages. Returns null when
 * there is not enough to geocode — an enrichment run against "Suburb" alone
 * would return a picture of somewhere else.
 */
/**
 * IS THERE A BUILDING AT THIS ADDRESS TO PHOTOGRAPH?
 *
 * A Street View still is a picture of whatever stands at a point on the
 * ground. For a completed dwelling that is the house. For a lot in a new
 * estate it is dirt, a road, or the paddock the estate has not been built on
 * yet — and that is not "no picture available", it is a picture of the wrong
 * thing, presented to a client as their property.
 *
 * PRODUCTION, 30 AUGUST 2026: a house-and-land package whose brochure shows a
 * finished render was served a Street View of an empty rural road outside the
 * estate. 58 cards were in that state.
 *
 * The signal is already here and needs no new field: a property the source
 * gave a REAL STREET ADDRESS is an addressed, built or building dwelling; one
 * whose line had to be COMPOSED from a lot number and an estate name is, by
 * construction, a lot in an estate. `composeAddressLine` returns non-null
 * only in the second case, which is exactly the test.
 *
 * It does not touch stage 2. A web search identifies a property by name, and
 * the builder's own render of the design on this lot is a legitimate and
 * useful reference picture — it is what the brochure itself shows. This
 * governs stage 3 alone, where the camera photographs the ground.
 */
export function hasPhotographableStreetAddress(record: {
  address_line: string | null;
}): boolean {
  return !!record.address_line?.trim();
}

export function geocodableAddress(record: {
  address_line: string | null; suburb: string | null;
  state: string | null; postcode: string | null;
  lot_number?: string | null; unit_number?: string | null;
  development_name?: string | null; project_name?: string | null;
}): string | null {
  /*
   * A LINE THE SOURCE DID NOT GIVE US, BUILT FROM WHAT IT DID.
   *
   * This used to refuse outright without an `address_line`, and a great many
   * stock lists do not have one: they carry the lot in one column, the estate
   * in another and the suburb in a third, which is the ordinary shape of a
   * builder's spreadsheet. Measured on one import — 89 properties, 89 lot
   * numbers, 89 estates, THREE addresses — every property was claimed, every
   * stage advanced, and stages 2 and 3 had nothing to identify or geocode. The
   * ladder ran to the bottom and found it had no rungs.
   *
   * COMPOSED HERE AND NOWHERE ELSE, WHICH IS THE POINT. `address_line` stays
   * exactly what the builder wrote — so property identity, duplicate matching
   * and the label a package document is searched for are all untouched. This
   * function is the one place that asks "can the fallback ladder name this
   * property", so it is the one place that may answer from the parts.
   *
   * NOTHING IS INVENTED, and it stays conservative: a bare lot number names
   * nothing a geocoder can find, so a composition needs a NAMED PLACE — an
   * estate or a project — and a row with only a number still returns null.
   */
  const line = record.address_line?.trim()
    || composeAddressLine(record as never)?.line
    || null;
  if (!line) return null;

  const parts = [line, record.suburb, record.state, record.postcode]
    .filter((part): part is string => !!part && !!part.trim());
  // Still two parts: a place on its own is a suburb, and a picture of "the
  // suburb" is a picture of somewhere else.
  if (parts.length < 2) return null;
  return `${parts.join(', ')}, Australia`;
}
