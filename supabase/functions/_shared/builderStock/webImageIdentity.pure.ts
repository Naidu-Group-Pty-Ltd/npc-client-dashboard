/**
 * Builder stock — IS THIS SEARCH RESULT A PICTURE OF THIS PROPERTY?
 *
 * A model reporting a URL is a lead, not an answer. Production holds 439
 * `internet_search` rows and not one of them has ever been checked against the
 * property it was found for; that is exactly why they were never displayable.
 * Making them displayable requires answering the question they never answered.
 *
 * WHAT COUNTS AS EVIDENCE. Only what the property itself states — its street
 * address, its lot, its estate, its suburb, its state, its postcode, its
 * builder and its design name — matched against what the search returned about
 * the page it came from. Nothing here looks at the picture; this decides
 * IDENTITY, not quality.
 *
 * THE ASYMMETRY IS THE POINT. A miss is cheap: the property shows Street View
 * instead. A false accept puts another lot's house on a client's card under a
 * badge that says where it came from, and the client cannot tell. So the bar
 * is deliberately high, ambiguity is refused, and the specific ways a search
 * goes wrong on new estates are refused BY NAME:
 *
 *   - another lot in the same estate (the estate matches; the lot does not)
 *   - a different house design at the same address
 *   - the estate's own marketing photography, which matches everything
 *   - a floorplan, masterplan, site plan or location map
 *   - a logo or a brand lockup
 *   - an interior offered as a facade
 *
 * Pure: no IO, no clock, no network.
 */

export interface PropertyIdentity {
  addressLine?: string | null;
  lotNumber?: string | null;
  unitNumber?: string | null;
  developmentName?: string | null;
  projectName?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  builderName?: string | null;
  designName?: string | null;
}

export interface WebImageCandidate {
  imageUrl: string;
  pageUrl?: string | null;
  title?: string | null;
  /** Any text the provider returned about the page. Never the image itself. */
  snippet?: string | null;
}

export interface IdentityVerdict {
  ok: boolean;
  /** Which pieces of the property's own identity were found. */
  matched: string[];
  /** Why it was refused, for the record. Never shown to a client. */
  reason?: string;
}

const norm = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Words that mean "this is not a photograph of the finished house".
 *
 * Matched against the page title and URL, which is where these announce
 * themselves. A floorplan is the single most common thing a property search
 * returns and it is never a card image.
 */
const NOT_A_FACADE = [
  'floorplan', 'floor plan', 'siteplan', 'site plan', 'masterplan', 'master plan',
  'estate plan', 'lot plan', 'subdivision', 'location map', 'locality map',
  'logo', 'brochure cover', 'price list', 'pricelist',
  'kitchen', 'bathroom', 'bedroom', 'ensuite', 'interior', 'living room',
];

/**
 * Pages that describe a WHOLE estate rather than one property.
 *
 * These are the generic marketing pictures: they match the estate, the suburb
 * and the builder perfectly, and they are of no particular house. Matching
 * more identity fields does not make them more specific, which is why they are
 * refused on their own terms rather than by the score below.
 */
const GENERIC_ESTATE = [
  'house and land packages', 'house & land packages', 'display homes',
  'display village', 'our estates', 'estate overview', 'land for sale',
  'new home designs', 'home designs', 'about the estate', 'masterplanned',
];

/** The lot a page is about, if it names one at all. */
export function lotsNamedIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\blot\s*#?\s*(\d{1,5})\b/gi)) out.push(match[1]);
  return out;
}

/**
 * Decide whether a candidate may represent this property.
 *
 * Requires, all at once: no disqualifying subject; not a generic estate page;
 * the SUBURB (a property's coarsest true location) present; and either the
 * street address or the lot-within-estate pinned exactly. Estate + builder
 * alone is never enough — that is the generic-marketing case.
 */
export function verifyWebImageIdentity(
  candidate: WebImageCandidate,
  identity: PropertyIdentity,
): IdentityVerdict {
  const haystack = norm([
    candidate.pageUrl, candidate.title, candidate.snippet, candidate.imageUrl,
  ].filter(Boolean).join(' '));
  if (!haystack) return { ok: false, matched: [], reason: 'nothing_to_match' };

  for (const banned of NOT_A_FACADE) {
    if (haystack.includes(norm(banned))) {
      return { ok: false, matched: [], reason: `subject_not_a_facade:${banned}` };
    }
  }
  for (const generic of GENERIC_ESTATE) {
    if (haystack.includes(norm(generic))) {
      return { ok: false, matched: [], reason: 'generic_estate_page' };
    }
  }

  const matched: string[] = [];
  const has = (value: unknown, label: string): boolean => {
    const needle = norm(value);
    if (!needle || needle.length < 3) return false;
    if (!haystack.includes(needle)) return false;
    matched.push(label);
    return true;
  };

  const suburb = has(identity.suburb, 'suburb');
  has(identity.state, 'state');
  const postcode = has(identity.postcode, 'postcode');
  const estate = has(identity.developmentName ?? identity.projectName, 'development');
  has(identity.builderName, 'builder');
  const design = has(identity.designName, 'design');

  /*
   * THE STREET, TAKEN OUT OF THE ADDRESS LINE. The stored line is
   * "Lot 13 - Hummock Rise, Werribee, VIC - 3030"; the part that identifies a
   * place on the ground is "hummock rise".
   */
  const street = norm((identity.addressLine ?? '')
    .replace(/^\s*(?:lot|unit)\s*#?\s*[\w/]+\s*[-,]?\s*/i, '')
    .split(',')[0]);
  const streetMatched = street.length >= 4 && haystack.includes(street);
  if (streetMatched) matched.push('street');

  /*
   * THE LOT NUMBER, AND THE ONE FAILURE MODE IT EXISTS TO CATCH. A page that
   * names lots and does not name THIS one is a page about a different lot in
   * the same estate — the single most likely wrong answer on a new estate, and
   * the one that looks most convincing because everything else matches.
   */
  const lot = norm(identity.lotNumber ?? identity.unitNumber)
    || (norm(identity.addressLine).match(/^lot\s+(\d{1,5})\b/)?.[1] ?? '');
  const named = lotsNamedIn(haystack);
  let lotMatched = false;
  if (lot) {
    if (named.length && !named.includes(lot)) {
      return { ok: false, matched, reason: 'names_a_different_lot' };
    }
    if (named.includes(lot)) { matched.push('lot'); lotMatched = true; }
  }

  if (!suburb && !postcode) {
    return { ok: false, matched, reason: 'no_location_evidence' };
  }
  // The property has to be pinned, not merely plausible: its own street, or
  // its own lot inside the named estate, or its design at its own location.
  const pinned = streetMatched || (lotMatched && estate) || (design && (suburb || postcode));
  if (!pinned) return { ok: false, matched, reason: 'identity_not_specific_enough' };

  return { ok: true, matched };
}
