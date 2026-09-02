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

/**
 * THE CORROBORATION POOL IS THE ROW'S IDENTITY, NOT THE LABEL'S SUBSET OF IT.
 *
 * MEASURED AGAINST PRODUCTION, 2 SEPTEMBER 2026, the Watsons Reach stock
 * list. The row for lot 102 has no street address, so its display label reads
 * "Lot 102, Diggers Rest" — the suburb. Its own supplied brochure's first
 * page (the text below is that page, verbatim but trimmed) states "Lot 102
 * Watsons Reach Estate" beside the package prices, which is how house-and-land
 * marketing writes identity: the ESTATE, which `stockRecordLabel` includes
 * only when a row has neither lot nor address to show. Corroboration fed only
 * the label found neither "diggers" nor "rest" on the page and refused the
 * builder's own document; the fallback gate then held the property blank. The
 * row's remaining identity names now travel as hints for that one test.
 */
describe('a cover may corroborate itself by the estate the label omits', () => {
  // Verbatim from the live lot 102 brochure, page 1 (trimmed mid-sentence).
  const vgCoverPage = '*Price based on standard inclusions and facade. Image depicts '
    + 'upgrade items not included in the price. It is not the actual lot for sale. '
    + '2 1 Lot 102 Watsons Reach Estate Titles December 2026 Land - $232,500 '
    + 'Build - $364,000 TOTAL - $596,500 PICO 8 VERV Inclusions & Turnkey Pack';
  const vgLabel = 'Lot 102, Diggers Rest';
  const vgHints = ['Watsons Reach'];

  it('was refused when only the label could corroborate — the defect, kept visible', () => {
    expect(findPropertyCoverPages([vgCoverPage], vgLabel)).toEqual([]);
  });

  it('is accepted when the row\'s estate travels as a hint', () => {
    const covers = findPropertyCoverPages([vgCoverPage], vgLabel, vgHints);
    expect(covers.map((cover) => cover.page)).toEqual([1]);
  });

  it('lets the hint corroborate but never identify: another lot still refuses', () => {
    const otherLot = vgCoverPage.replace(/Lot 102/g, 'Lot 103');
    expect(findPropertyCoverPages([otherLot], vgLabel, vgHints)).toEqual([]);
  });

  it('never lets a hint excuse a page that names a second lot', () => {
    const twoLots = `${vgCoverPage} adjoining Lot 104 sold separately`;
    expect(findPropertyCoverPages([twoLots], vgLabel, vgHints)).toEqual([]);
  });

  it('leaves the lot-less full-conjunction path exactly as strict as it was', () => {
    // A label with no lot keeps the every-token rule; a hint must not soften
    // it into "some token somewhere".
    const label = 'Watsons Reach Stage 3';
    const page = 'Watsons Reach masterplan overview Package Price - $596,500 '
      + 'Land Size 350 m2';
    expect(findPropertyCoverPages([page], label, ['Diggers Rest'])).toEqual([]);
  });

  it('the hero on a hint-corroborated cover becomes primary through the one decision', () => {
    const roles = assignPdfMediaRoles({
      label: vgLabel,
      identityHints: vgHints,
      design: 'Pico 8',
      pageTexts: [vgCoverPage],
      pageOrderAuthoritative: true,
      media: [{ page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1 }],
      structuralCoverPage: null,
    });
    expect(roles[0].role).toBe('primary_property');
  });
});

/**
 * A LOT NUMBER THE EXPORTER SPLIT IS STILL THE LOT NUMBER.
 *
 * MEASURED AGAINST PRODUCTION, 2 SEPTEMBER 2026, the same Watsons Reach list.
 * The supplied brochure for lot 103 extracts its identity line as
 * "2 1 Lot 10 3 Watsons Reach Estate …" — the page a person reads says
 * "Lot 103"; the text layer broke the digits into two runs. The strict token
 * reading saw "Lot 10", failed the our-lot test, counted a foreign lot, and
 * the builder's own document was refused — while the sibling lot 102
 * brochure, typeset with its digits in one run, was read fine. How an
 * exporter split a number is typography, not evidence about the property, so
 * a run of digit tokens after Lot/Unit is read fused as well as strictly, and
 * a run is a FOREIGN lot only when neither reading is ours.
 */
describe('a lot number split across text runs is read whole', () => {
  // Verbatim from the live lot 103 brochure, page 1 (trimmed mid-sentence).
  const splitLotPage = '*Price based on standard inclusions and facade. It is not the '
    + 'actual lot for sale. 2 1 Lot 10 3 Watsons Reach Estate Titles December 2026 '
    + 'Land - $ 232,500 Build - $ 364 ,000 TOTAL - $ 596,500 PICO 8 VERV '
    + 'Inclusions & Turnkey Pack';
  const hints = ['Watsons Reach'];

  it('was refused under the strict reading — the defect, kept visible', () => {
    // Strictly, "Lot 10 3" designates lot 10: not ours, and a foreign lot.
    // The fused reading is what recovers it below.
    const covers = findPropertyCoverPages([splitLotPage], 'Lot 10, Diggers Rest', hints);
    expect(covers.map((cover) => cover.page)).toEqual([1]);
  });

  it('reads "Lot 10 3" as lot 103 on lot 103\'s own document', () => {
    const covers = findPropertyCoverPages([splitLotPage], 'Lot 103, Diggers Rest', hints);
    expect(covers.map((cover) => cover.page)).toEqual([1]);
  });

  it('still refuses a genuinely different lot, split or not', () => {
    expect(findPropertyCoverPages([splitLotPage], 'Lot 104, Diggers Rest', hints))
      .toEqual([]);
    const wholeForeign = splitLotPage.replace('Lot 10 3', 'Lot 104');
    expect(findPropertyCoverPages([wholeForeign], 'Lot 103, Diggers Rest', hints))
      .toEqual([]);
  });

  it('a fused run never excuses a second, foreign lot on the page', () => {
    const twoLots = `${splitLotPage} adjoining Lot 20 5 sold separately`;
    // "Lot 20 5" reads as 20 and 205 — neither is 103, so the page states
    // another lot and is refused.
    expect(findPropertyCoverPages([twoLots], 'Lot 103, Diggers Rest', hints))
      .toEqual([]);
  });
});
