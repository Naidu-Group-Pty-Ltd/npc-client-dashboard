/**
 * BUILDER STOCK — SOURCE, THEN A VERIFIED WEB PHOTOGRAPH, THEN STREET VIEW.
 *
 * The old rule was "the builder's own image, or nothing", and it was right
 * while the only alternatives were an unverified search hit and a satellite
 * tile. Its cost was a marketplace of empty frames. The rule is now a ranking,
 * and everything worth pinning about it is a way the ranking could go wrong:
 *
 *   A FALLBACK NEVER OUTRANKS A SOURCE, including one that arrives later.
 *   FINDING A URL IS NOT VERIFYING A PROPERTY — and 439 production rows say
 *     `unverified`, so none of them may become displayable retroactively.
 *   STREET VIEW MEANS STREET VIEW; a satellite tile is a roof.
 *   NOTHING BUT THE BUILDER'S OWN FILE IS EVER "Builder supplied".
 */
import { describe, expect, it } from 'vitest';
import {
  chooseCardImage, nextImageStage, provenanceOf, rankImage,
  isVerifiedWebImage, isStreetViewImage,
  PROVENANCE_LABEL, WEB_VERIFIED_VERIFICATION,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import {
  verifyWebImageIdentity,
} from '../../../supabase/functions/_shared/builderStock/webImageIdentity.pure';

const SHA = 'a'.repeat(64);

/** A builder source row the classifier measured CLEAN. */
const cleanSource = (over: Record<string, unknown> = {}) => ({
  id: 'src-clean',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  storage_path: 'org/items/item/source/a.png',
  position: 0,
  source_detail: {
    role: 'primary_property', role_evidence_level: 1,
    stored_sha256: SHA,
    marketplace_display_eligible: true,
    marketplace_eligibility_state: 'eligible',
    marketplace_measured: true,
    marketplace_eligibility_version: 2,
  },
  ...over,
});

/** A builder source row that reaches a card only through its repair. */
const repairedSource = (over: Record<string, unknown> = {}) => ({
  id: 'src-repaired',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  storage_path: 'org/items/item/source/b.png',
  position: 1,
  source_detail: {
    role: 'primary_property', role_evidence_level: 1,
    stored_sha256: SHA,
    marketplace_display_eligible: false,
    marketplace_eligibility_state: 'ineligible',
    marketplace_rejection_reason: 'annotated_marketing_tile',
    marketplace_measured: true,
    marketplace_eligibility_version: 2,
    sanitized_derivative: {
      transformation: 'generative_overlay_inpaint',
      sanitization_version: 2,
      storage_path: 'org/items/item/source/sanitized/v2/b.png',
      derivative_sha256: 'c'.repeat(64),
      original_sha256: SHA,
      verdict: 'eligible',
      repaired_share: 0.125,
    },
  },
  ...over,
});

/** A source row stored but not yet measured — evidence that has not arrived. */
const pendingSource = () => ({
  id: 'src-pending',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  storage_path: 'org/items/item/source/c.png',
  position: 0,
  source_detail: { role: 'primary_property', role_evidence_level: 1, stored_sha256: SHA },
});

const verifiedWeb = (over: Record<string, unknown> = {}) => ({
  id: 'web-verified',
  source_stage: 'internet_search',
  verification_status: WEB_VERIFIED_VERIFICATION,
  processing_status: 'ready',
  external_url: 'https://example.test/house.jpg',
  position: 0,
  source_detail: {
    property_identity: {
      matched: ['suburb', 'street'],
      verified_at: '2026-08-27T09:00:00Z',
      stock_item_id: 'item-1',
      organisation_id: 'org-a',
    },
  },
  ...over,
});

/** Every historical row: a model reported a URL and nobody checked it. */
const unverifiedWeb = () => ({
  id: 'web-unverified',
  source_stage: 'internet_search',
  verification_status: 'unverified',
  processing_status: 'ready',
  external_url: 'https://example.test/maybe.jpg',
  position: 0,
  source_detail: { query: 'a query', title: 'Something' },
});

const streetView = () => ({
  id: 'sv-1',
  source_stage: 'google_maps',
  verification_status: 'location_derived',
  processing_status: 'ready',
  storage_path: 'org/items/item/google-streetview.jpg',
  position: 0,
  source_detail: {
    product: 'streetview', address: '13 Hummock Rise, Werribee VIC 3030',
    latitude: -37.9, longitude: 144.6,
  },
});

const satellite = () => ({
  ...streetView(),
  id: 'sat-1',
  storage_path: 'org/items/item/google-staticmap.jpg',
  source_detail: { ...streetView().source_detail, product: 'staticmap' },
});

describe('7,8,19 — the builder source wins, and a clean original wins inside it', () => {
  it('7 — a clean builder source is the card image', () => {
    const chosen = chooseCardImage([streetView(), verifiedWeb(), cleanSource()] as never);
    expect(chosen?.image.id).toBe('src-clean');
    expect(chosen?.rank).toBe(1);
    expect(chosen?.provenance).toBe('builder_supplied');
  });

  it('8 — a promotional source that was cleaned is still the card image', () => {
    const chosen = chooseCardImage([verifiedWeb(), streetView(), repairedSource()] as never);
    expect(chosen?.image.id).toBe('src-repaired');
    expect(chosen?.rank).toBe(2);
    expect(chosen?.provenance).toBe('builder_supplied');
  });

  it('19 — a clean original outranks a sanitized derivative of the same source', () => {
    const chosen = chooseCardImage([repairedSource(), cleanSource()] as never);
    expect(chosen?.image.id).toBe('src-clean');
  });

  it('18 — a builder image arriving later takes the card back from a fallback', () => {
    const before = chooseCardImage([streetView()] as never);
    expect(before?.provenance).toBe('street_view');
    const after = chooseCardImage([streetView(), verifiedWeb(), cleanSource()] as never);
    expect(after?.provenance).toBe('builder_supplied');
  });
});

describe('9,10,11,12,15,16 — which stage is worth paying for', () => {
  it('7,8 — a usable source means NO paid stage runs', () => {
    expect(nextImageStage([cleanSource()] as never,
      { sourceSettlementComplete: true })).toBe('none');
    expect(nextImageStage([repairedSource()] as never,
      { sourceSettlementComplete: true })).toBe('none');
  });

  it('9 — a source still awaiting its verdict spends NOTHING; it waits', () => {
    // The failure this prevents: paying for a search against a property that
    // is about to gain the builder's own render.
    expect(nextImageStage([pendingSource()] as never,
      { sourceSettlementComplete: true })).toBe('wait');
    // And an upload whose settlement has not finished is the same answer even
    // with no rows yet, because the rows may still be coming.
    expect(nextImageStage([] as never,
      { sourceSettlementComplete: false })).toBe('wait');
  });

  it('10 — a property with conclusively no source image goes to web search', () => {
    expect(nextImageStage([] as never, { sourceSettlementComplete: true }))
      .toBe('web_search');
  });

  it('11 — a verified web photograph means Street View is NOT bought', () => {
    expect(nextImageStage([verifiedWeb()] as never,
      { sourceSettlementComplete: true })).toBe('none');
    const chosen = chooseCardImage([verifiedWeb()] as never);
    expect(chosen?.provenance).toBe('web_sourced');
  });

  it('12 — a search that returned only unverifiable results falls to Street View', () => {
    expect(nextImageStage([unverifiedWeb()] as never,
      { sourceSettlementComplete: true })).toBe('street_view');
  });

  it('15 — Street View is selected when it is all there is', () => {
    const chosen = chooseCardImage([unverifiedWeb(), streetView()] as never);
    expect(chosen?.image.id).toBe('sv-1');
    expect(chosen?.provenance).toBe('street_view');
  });

  it('16 — no Street View coverage means no image at all', () => {
    expect(chooseCardImage([unverifiedWeb()] as never)).toBeNull();
    expect(nextImageStage([unverifiedWeb(), satellite()] as never,
      { sourceSettlementComplete: true })).toBe('none');
  });

  it('a satellite tile is location imagery and is never a card image', () => {
    expect(isStreetViewImage(satellite() as never)).toBe(false);
    expect(chooseCardImage([satellite()] as never)).toBeNull();
  });
});

describe('17 — the 439 historical rows stay non-displayable', () => {
  it('an unverified search row is refused', () => {
    expect(isVerifiedWebImage(unverifiedWeb() as never)).toBe(false);
    expect(rankImage(unverifiedWeb() as never)).toBeNull();
    expect(chooseCardImage([unverifiedWeb()] as never)).toBeNull();
  });

  it('the verification state alone is not enough without its evidence', () => {
    // A row hand-edited to the new state, or half-written, has no identity.
    expect(isVerifiedWebImage(verifiedWeb({ source_detail: {} }) as never)).toBe(false);
    expect(isVerifiedWebImage(
      verifiedWeb({ source_detail: { property_identity: { matched: [] } } }) as never,
    )).toBe(false);
    expect(isVerifiedWebImage(verifiedWeb({
      source_detail: { property_identity: { matched: ['suburb'] } },
    }) as never)).toBe(false);
  });
});

describe('20 — no fallback is ever badged Builder supplied', () => {
  it('each tier says what it actually is', () => {
    expect(provenanceOf(cleanSource() as never)).toBe('builder_supplied');
    expect(provenanceOf(repairedSource() as never)).toBe('builder_supplied');
    expect(provenanceOf(verifiedWeb() as never)).toBe('web_sourced');
    expect(provenanceOf(streetView() as never)).toBe('street_view');
    expect(provenanceOf(unverifiedWeb() as never)).toBeNull();
    expect(provenanceOf(satellite() as never)).toBeNull();
  });

  it('the labels are truthful and only one of them claims the builder', () => {
    expect(PROVENANCE_LABEL.builder_supplied).toBe('Builder supplied');
    expect(PROVENANCE_LABEL.web_sourced).toBe('Web sourced');
    expect(PROVENANCE_LABEL.street_view).toBe('Street View');
    const claimsBuilder = Object.entries(PROVENANCE_LABEL)
      .filter(([, label]) => /builder/i.test(label))
      .map(([key]) => key);
    expect(claimsBuilder).toEqual(['builder_supplied']);
  });
});

// ---------------------------------------------------------------------------
// 13, 14 and the rest of the identity rule
// ---------------------------------------------------------------------------

const LOT_13 = {
  addressLine: 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
  suburb: 'Werribee', state: 'VIC', postcode: '3030',
  developmentName: 'Harpley Estate', builderName: 'Urbane Homes',
};

describe('13,14 — a search result must be THIS property', () => {
  it('13 — another lot in the same estate is refused', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg',
      pageUrl: 'https://x.test/harpley-estate/lot-27',
      title: 'Lot 27 Hummock Rise, Werribee VIC 3030 - Harpley Estate',
    }, LOT_13);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('names_a_different_lot');
  });

  it('14 — the estate\'s own marketing page is refused however much matches', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/estate.jpg',
      pageUrl: 'https://x.test/harpley-estate/house-and-land-packages',
      title: 'House and Land Packages - Harpley Estate, Werribee VIC 3030 | Urbane Homes',
    }, LOT_13);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('generic_estate_page');
  });

  it('a floorplan, masterplan, location map or logo is refused', () => {
    for (const title of [
      'Lot 13 Hummock Rise floorplan',
      'Harpley Estate masterplan Werribee',
      'Location map - Hummock Rise Werribee VIC 3030',
      'Urbane Homes logo',
    ]) {
      const verdict = verifyWebImageIdentity({
        imageUrl: 'https://x.test/a.jpg', pageUrl: 'https://x.test/p', title,
      }, LOT_13);
      expect(verdict.ok, title).toBe(false);
      expect(verdict.reason, title).toMatch(/subject_not_a_facade/);
    }
  });

  it('an interior offered as a facade is refused', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg',
      pageUrl: 'https://x.test/lot-13-hummock-rise',
      title: 'Lot 13 Hummock Rise Werribee - kitchen and living room',
    }, LOT_13);
    expect(verdict.ok).toBe(false);
  });

  it('estate plus builder alone is not specific enough', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg',
      pageUrl: 'https://x.test/urbane/harpley',
      title: 'Urbane Homes at Harpley Estate',
    }, LOT_13);
    expect(verdict.ok).toBe(false);
  });

  it('a result with no location evidence at all is refused', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg', pageUrl: 'https://x.test/p', title: 'A nice house',
    }, LOT_13);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/no_location_evidence|identity_not_specific/);
  });

  it('the property\'s own street and suburb ARE accepted', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg',
      pageUrl: 'https://x.test/vic/werribee/hummock-rise',
      title: 'Lot 13 Hummock Rise, Werribee VIC 3030',
    }, LOT_13);
    expect(verdict.ok).toBe(true);
    expect(verdict.matched).toContain('suburb');
    expect(verdict.matched).toContain('street');
  });

  it('the same lot named explicitly inside its own estate is accepted', () => {
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://x.test/a.jpg',
      pageUrl: 'https://x.test/harpley/lot-13',
      title: 'Lot 13 at Harpley Estate, Werribee 3030',
    }, LOT_13);
    expect(verdict.ok).toBe(true);
    expect(verdict.matched).toContain('lot');
  });
});

describe('21,22 — identity is bound to the item and the organisation', () => {
  it('a verified row records which item and organisation it was verified for', () => {
    const row = verifiedWeb();
    const identity = row.source_detail.property_identity as Record<string, unknown>;
    expect(identity.stock_item_id).toBe('item-1');
    expect(identity.organisation_id).toBe('org-a');
  });

  it('the selectors are given ONE property\'s rows and rank only those', () => {
    // The scoping is the query's (`.eq('stock_item_id', …)`), and the ranking
    // never widens it: nothing here can reach a row it was not handed.
    const chosen = chooseCardImage([verifiedWeb()] as never);
    expect(chosen?.image.id).toBe('web-verified');
    expect(chooseCardImage([] as never)).toBeNull();
  });
});
