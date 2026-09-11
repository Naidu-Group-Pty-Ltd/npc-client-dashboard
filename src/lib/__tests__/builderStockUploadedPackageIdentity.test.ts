/**
 * Builder stock — an uploaded package was held to a stricter standard than a
 * linked one, for no reason anybody chose.
 *
 * MEASURED 11 SEPTEMBER 2026 on `LOT 27 - ZIMI - FLYER.pdf`, a fresh upload
 * that had never been sent before. One property, a large facade render on the
 * cover, and no picture on the card. The refusal the pipeline recorded — and
 * now quotes — was:
 *
 *   no page states this property's identity together with its package
 *   information — its first page reads "Lot 27 — LOT 32, 33, 34,"
 *
 * TWO THINGS WERE WRONG AND BOTH WERE WIRING.
 *
 * 1. THE UPLOAD PATH PASSED NO IDENTITY HINTS. The imported row carries
 *    `development_name: "HAVENWOOD"` and the flyer prints HAVENWOOD across the
 *    top, but the row's LABEL is "Lot 27, 49 Cockrell Rd, Mernda" — a street
 *    the document never mentions. `pageStatesIdentity` test 4 wants one
 *    corroborating token, `stockIdentityHints` exists to supply the estate,
 *    and the LINKED-document path has passed it since the Watsons Reach fix.
 *    `repairPdfUpload` and the importer's own `paginated` block passed only
 *    the label. Same for `house_design`, which feeds the design-cover rung:
 *    the linked path passes it, the upload path did not, so an uploaded
 *    package could not reach that rung at all.
 *
 * 2. THE OTHER-LOT VETO DOES NOT BELONG TO A ONE-PROPERTY DOCUMENT. Test 2 of
 *    `pageStatesIdentity` refuses a page naming any lot but ours, and for a
 *    stock list of twelve lots that is exactly right — two lots on one page is
 *    the document declining to say whose page it is, and a guess puts somebody
 *    else's house on a client's card. This flyer names lots 32, 33 and 34
 *    beside lot 27 because the estate's site plan is printed on it. With ONE
 *    property in the document there is no other property to mis-attribute to,
 *    so a second lot number is context rather than a competitor.
 *
 * Same principle, same document shape, as the sole-property branch of
 * `anchorPdfRowsToPages`. A multi-property document is untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assignPdfMediaRoles, findPropertyCoverPages,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import {
  anchorPdfRowsToPages,
} from '../../../supabase/functions/_shared/builderStock/pdfRowAnchors.pure';
import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');
const IMPORT = read('supabase/functions/_shared/builderStock/importStock.ts');
const REPAIR = read('supabase/functions/_shared/builderStock/repairSourceImages.ts');
const VERSION_PROSE = read('supabase/functions/_shared/builderStock/sourceImages.ts');

/** Page 1 of the flyer, from what production recorded plus the printed figures. */
const FLYER = [
  'HAVENWOOD',
  'Lot 27',
  'Zimi',
  'Sale Price - $699,000',
  'Land Size - 143sqm',
  'Build Size - 180sqm',
  'Turn-Key Inclusions, Front and rear landscaping, driveway + fencing',
  'LOT 32, 33, 34',
].join('\n');
const PAGES = [FLYER, 'Inclusions'];

/** The label the model's extraction produced — a street the flyer never names. */
const LABEL = 'Lot 27, 49 Cockrell Rd, Mernda';
/** What `stockIdentityHints` returns for that row. */
const HINTS = ['HAVENWOOD'];

describe('why the flyer was refused', () => {
  it('the label alone matches nothing on the page', () => {
    expect(findPropertyCoverPages(PAGES, LABEL)).toHaveLength(0);
  });

  it('and the estate hint alone is not enough — the other lots still veto', () => {
    // This is the part a hints-only fix would have missed.
    expect(findPropertyCoverPages(PAGES, LABEL, HINTS)).toHaveLength(0);
  });
});

describe('a one-property document is read the way it is written', () => {
  it('finds the cover with the estate hint and the sole-property rule', () => {
    const covers = findPropertyCoverPages(PAGES, LABEL, HINTS, true);
    expect(covers).toHaveLength(1);
    expect(covers[0].page).toBe(1);
  });

  it('elects the render on it', () => {
    const [role] = assignPdfMediaRoles({
      label: LABEL,
      identityHints: HINTS,
      soleProperty: true,
      pageTexts: PAGES,
      pageOrderAuthoritative: true,
      media: [{ name: 'Im0', page: 1, placementsOnPage: 1, pagesDrawnOn: [1], pageAreaShare: 0.39 }],
    } as never);
    expect(role.role).toBe('primary_property');
  });

  it('and refuses it without the rule, which is the before picture', () => {
    const [role] = assignPdfMediaRoles({
      label: LABEL,
      identityHints: HINTS,
      pageTexts: PAGES,
      pageOrderAuthoritative: true,
      media: [{ name: 'Im0', page: 1, placementsOnPage: 1, pagesDrawnOn: [1], pageAreaShare: 0.39 }],
    } as never);
    expect(role.role).not.toBe('primary_property');
  });

  it('anchors the row to the page carrying the render', () => {
    expect(anchorPdfRowsToPages([LABEL], PAGES, [1], true, [HINTS])).toEqual(['pdf:page1']);
  });
});

describe('a MULTI-property document is untouched', () => {
  it('still refuses a page that names another lot', () => {
    expect(findPropertyCoverPages(PAGES, LABEL, HINTS, false)).toHaveLength(0);
  });

  it('and the veto is what does it, not the hints', () => {
    // The same page with no foreign lot on it IS accepted under multi rules,
    // so the refusal above is the other-lot test and nothing else.
    const clean = [FLYER.replace('LOT 32, 33, 34', ''), 'Inclusions'];
    expect(findPropertyCoverPages(clean, LABEL, HINTS, false)).toHaveLength(1);
  });

  it('two rows in one document never get the sole-property relaxation', () => {
    const anchors = anchorPdfRowsToPages(
      [LABEL, 'Lot 32, Other Street, Mernda'], PAGES, [1], true, [HINTS, []]);
    // Neither row may claim page 1 on a document that names several lots.
    expect(anchors[0]).toBeNull();
  });
});

/*
 * THE LIMIT OF THE WAIVER, AND WHY IT IS THE RIGHT LIMIT.
 *
 * The second row in production carrying this refusal is Lot 1037 Fuchsia
 * Street, also a one-property upload. Its page reads "PACKAGE PRICE Lot 1307
 * Fuchsia Street". That is NOT the other-lot veto and the waiver must not
 * rescue it: test 1 — "the lot is stated, as a lot" — is what refuses it, and
 * test 1 is the whole discriminator. The document names lot 1307; the row says
 * lot 1037. One of the two is wrong, and electing the picture anyway would be
 * this pipeline guessing which. The product's existing answer — refuse, and
 * quote what the page actually says — is what lets the builder find the typo.
 *
 * So the sole-property rule relaxes context and never identity.
 */
describe('a sole-property document still has to name THIS property', () => {
  const FUCHSIA = [
    'PACKAGE PRICE',
    'Lot 1307 Fuchsia Street',
    'Sale Price - $640,000',
    'Land Size - 350sqm',
  ].join('\n');
  const FUCHSIA_LABEL = 'Lot 1037 Fuchsia Street, Wollert';

  it('refuses a page that states a different lot, sole property or not', () => {
    expect(findPropertyCoverPages([FUCHSIA], FUCHSIA_LABEL, [], true)).toHaveLength(0);
    expect(findPropertyCoverPages([FUCHSIA], FUCHSIA_LABEL, [], false)).toHaveLength(0);
  });

  it('and it is test 1 doing it — the same page naming OUR lot is accepted', () => {
    const ours = [FUCHSIA.replace('Lot 1307', 'Lot 1037')];
    expect(findPropertyCoverPages(ours, FUCHSIA_LABEL, [], true)).toHaveLength(1);
  });

  it('so the street name alone can never carry a contradicted lot', () => {
    // Corroboration (test 4) is plentiful here — "fuchsia", "street" both
    // appear — and it changes nothing, because test 1 returns before it.
    expect(findPropertyCoverPages([FUCHSIA], FUCHSIA_LABEL, ['Fuchsia'], true)).toHaveLength(0);
  });
});

/*
 * THE BUMP MUST NOT WITHDRAW A PICTURE, AND THIS IS WHY IT CANNOT.
 *
 * v14's entry records the thing that makes a bump dangerous: it "is the first
 * that can withdraw a picture as well as find one", because a re-derivation
 * that refuses what the old rules accepted demotes a row that was drawing a
 * card. Four uploads sit below this version and two of them are currently
 * showing a photograph, so the question is not academic.
 *
 * Every part of this change is MONOTONE — it deletes a `return false` and
 * widens a corroboration pool, and adds no new way to refuse:
 *
 *   `pageStatesIdentity`   test 2 is skipped for a sole-property document
 *   `anchorPdfRowsToPages` an ambiguous sole-property cover resolves
 *                          instead of returning null
 *   `identityHints`        can only satisfy test 4, never fail it
 *
 * So no page that qualified at 23 can fail at 24, and a picture already
 * elected re-elects. Asserted rather than argued.
 */
describe('the sole-property rule can only ever find more', () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['Lot 27, 49 Cockrell Rd, Mernda', PAGES, HINTS],
    ['Lot 27, 49 Cockrell Rd, Mernda', PAGES, []],
    ['Lot 1037 Fuchsia Street, Wollert', ['Lot 1307 Fuchsia Street PACKAGE PRICE'], []],
    ['Lot 51 - Tringa Street, Sandpiper Estate', ['Lot 51 Sandpiper Estate $640,000 350sqm'], []],
    ['Lot 324, Nex 20', ['Lot 324 Nex 20 Sale Price - $700,000 Land Size - 400sqm'], []],
    ['Lot 7', ['Lot 7 Sale Price - $500,000 Land Size - 300sqm'], []],
  ];

  it.each(CASES)('never refuses %s under the sole-property rule when it accepted it without', (
    label, pages, hints,
  ) => {
    const strict = findPropertyCoverPages(pages, label, hints, false);
    const relaxed = findPropertyCoverPages(pages, label, hints, true);
    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length);
    // And every page the strict rule found is still found.
    for (const cover of strict) {
      expect(relaxed.map((c) => c.page)).toContain(cover.page);
    }
  });
});

/*
 * A CAPABILITY CHANGE THAT DOES NOT BUMP THE VERSION REACHES NO EXISTING ROW.
 *
 * `negativeProvenanceStillStands` keeps a negative recorded at the CURRENT
 * version, and `repairSourceImages` skips any row already banked at it. The
 * flyer above is banked at 23 with its refusal recorded, so without this bump
 * the fix would apply to future uploads and leave the reported row broken for
 * ever — which is the shape of every "you already fixed this" report.
 */
describe('the bump that lets it reach the rows already refused', () => {
  it('is past the version those refusals were banked at', () => {
    expect(PROVENANCE_VERSION).toBeGreaterThan(23);
  });

  it('and sourceImages.ts records what it changed, as every bump does', () => {
    expect(VERSION_PROSE).toContain('24 STOPS A ONE-PROPERTY BROCHURE');
  });
});

describe('the wiring, so this cascades to every future upload', () => {
  it('the importer passes the estate hints, the design and the count', () => {
    expect(IMPORT).toContain('identityHintsByItemId,');
    expect(IMPORT).toContain('designByItemId,');
    expect(IMPORT).toContain('soleProperty: records.length === 1,');
  });

  it('and builds the design map from the row itself', () => {
    expect(IMPORT).toContain('designByItemId.set(itemId, record.house_design ?? null)');
  });

  it('the repair path passes the same three', () => {
    expect(REPAIR).toContain('identityHints = existing.map((item) => stockIdentityHints(recordOf(item)))');
    expect(REPAIR).toContain('const soleProperty = existing.length === 1;');
    expect(REPAIR).toContain('designByItemId: new Map(');
  });

  it('and hands the hints to the anchor rule too, not only to the roles', () => {
    expect(REPAIR).toContain(
      'anchorPdfRowsToPages(\n    labels, input.pageTexts, photoPages, input.pageOrderAuthoritative, identityHints)');
  });
});
