/**
 * Builder stock — which page of a property's own package is its cover.
 *
 * WHAT HAPPENED. `assignPdfMediaRoles` resolved the cover as
 * `covers.length === 1 ? covers[0] : null`, so a document presenting the
 * property on more than one page was refused outright with "N pages present
 * this property as a package and the document does not say which is its
 * cover". That reads like a defensive rule and was in fact a near-total one:
 * a builder package IS a cover page and a floor plan, and both repeat the lot
 * header and the price block, so both qualify.
 *
 * MEASURED AGAINST PRODUCTION, 1 SEPTEMBER 2026. Ten brochures taken from the
 * live stock list of a builder whose 94 properties had 28 photographs between
 * them. Five were refused for exactly this; every one of the five carried its
 * facade render on page 1 and its floor plan on page 2. Across the whole
 * upload, 281 documents had been opened and 20 images taken.
 *
 * WHY RESOLVING IS SAFE, AND THIS IS THE WHOLE ARGUMENT. The refusal was
 * guarding against a document that covers two PROPERTIES handing one
 * property's photograph to the other. That guard lives upstream and not here:
 * `pageStatesIdentity` demands the page state THIS lot and REFUSES any page
 * that states another one, so a page belonging to a different property never
 * reaches the resolution at all. Every cover in the list names the same
 * property. What was being refused was not "whose house is this" but "which
 * page of this house's own package leads".
 *
 * The tie is still refused, because two pages stating equally much really have
 * not said which leads, and a blank card beats a guess.
 */
import { describe, expect, it } from 'vitest';

import {
  assignPdfMediaRoles, findPropertyCoverPages, resolvePropertyCover,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

/**
 * A page as the live brochures write it: the header, then the package block.
 * Four facts — the price, the package heading, the land size, the
 * bed/bath/car line.
 */
const coverPage = 'Lot 12022 Caspian Crescent Warralily Estate, Armstrong Creek '
  + 'Package Price - $728,750 Land Size 350 m2 3 bed 2 bath 2 car';

/**
 * The floor plan overleaf: the same header and the same price strip, and
 * nothing else the cover states. Two facts, which is enough to QUALIFY and
 * not enough to LEAD.
 */
const floorPlanPage = 'Lot 12022 Caspian Crescent Warralily Estate, Armstrong Creek '
  + 'Package Price - $728,750 MASTER ROBE ENS BATH LIN GARAGE KITCHEN '
  + 'FAMILY MEALS PORCH ENTRY';

const LABEL = 'Lot 12022, Warralily Estate, Armstrong Creek';

describe('resolvePropertyCover', () => {
  it('is the only cover, when there is only one', () => {
    const covers = findPropertyCoverPages([coverPage], LABEL);
    expect(covers).toHaveLength(1);
    expect(resolvePropertyCover(covers)?.page).toBe(1);
  });

  it('is nothing at all when no page qualifies', () => {
    expect(resolvePropertyCover([])).toBeNull();
  });

  it('is the page stating MORE of the package, not the earlier page', () => {
    const covers = findPropertyCoverPages([coverPage, floorPlanPage], LABEL);
    expect(covers.map((cover) => cover.page)).toEqual([1, 2]);
    // Exactly the shape the live brochures have: four facts against two.
    expect(covers[0].packageFacts).toHaveLength(4);
    expect(covers[1].packageFacts).toHaveLength(2);
    expect(resolvePropertyCover(covers)?.page).toBe(1);
  });

  it('reads a document that opens with its floor plan the same way', () => {
    // Position decides nothing: the evidence does.
    const covers = findPropertyCoverPages([floorPlanPage, coverPage], LABEL);
    expect(resolvePropertyCover(covers)?.page).toBe(2);
  });

  it('refuses a strict tie, because neither page has said it leads', () => {
    const covers = findPropertyCoverPages([coverPage, coverPage], LABEL);
    expect(covers).toHaveLength(2);
    expect(resolvePropertyCover(covers)).toBeNull();
  });
});

describe('the cover a document names is the one whose image becomes primary', () => {
  const media = [
    // Page 1: the facade render, drawn once, on one page.
    { page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1 },
    // Page 2: the floor plan, likewise.
    { page: 2, name: 'Im1', placementsOnPage: 1, pagesDrawnOn: 1 },
  ];

  it('takes the facade off the cover rather than refusing the document', () => {
    const roles = assignPdfMediaRoles({
      label: LABEL, design: null, pageTexts: [coverPage, floorPlanPage],
      pageOrderAuthoritative: true, media, structuralCoverPage: null,
    });

    expect(roles[0].role).toBe('primary_property');
    // Lot-specific evidence — the page named the lot, so this is level 2 and
    // outranks anything the design path could offer.
    expect(roles[0].evidenceLevel).toBe(2);
    // And the floor plan is never the property's own image.
    expect(roles[1].role).not.toBe('primary_property');
  });

  it('still refuses when the two pages state equally much', () => {
    const roles = assignPdfMediaRoles({
      label: LABEL, design: null, pageTexts: [coverPage, coverPage],
      pageOrderAuthoritative: true, media, structuralCoverPage: null,
    });

    expect(roles.some((role) => role.role === 'primary_property')).toBe(false);
    expect(String(roles[0].reason)).toContain('state equally');
  });

  it('never reaches a page that names a DIFFERENT lot', () => {
    // The guard that made resolving safe, asserted rather than assumed.
    const otherLot = coverPage.replace(/12022/g, '12044');
    const covers = findPropertyCoverPages([coverPage, otherLot], LABEL);
    expect(covers.map((cover) => cover.page)).toEqual([1]);
  });
});
