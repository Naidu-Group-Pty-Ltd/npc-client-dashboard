/**
 * Builder stock — the house design as evidence, and everything it must refuse.
 *
 * THE PRODUCT FACT. A builder sells fewer designs than lots. Eighty-nine lots,
 * fourteen designs, one brochure per design linked from every row that sells
 * it. That brochure names the design and never the lot, so the package matcher
 * — which asks "does this page name THIS PROPERTY?" — refused it, and 63 live
 * properties carried a document that named the house and showed no picture.
 *
 * WHAT THIS ADDS, AND WHAT IT REFUSES TO ADD. A row states `house_design`, and
 * a page of the builder's own document states the same design together with
 * package information and no lot at all. That is the source naming the design,
 * not an inference from a shared URL or a spreadsheet row — which remains
 * unsafe and remains refused (case J).
 *
 * IT IS THE WEAKEST EVIDENCE THERE IS. Level 4, below every property-specific
 * level, so a document naming the lot always wins and one arriving later takes
 * the card back without this module's help (cases D and E).
 */
import { describe, expect, it } from 'vitest';

import {
  designIdentityIsDistinctive, findDesignCoverPages, findPropertyCoverPages,
  assignPdfMediaRoles,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import {
  DESIGN_EVIDENCE_LEVEL, comparePrimaryEvidence, roleFromDesignCover,
  roleFromPropertyCover,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';
import {
  normaliseHeader, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  chooseCardImage,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import type {
  DisplayableImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';

/* A page that presents one design as a package: the design, and package facts,
   and no lot designation anywhere. */
const designPage = (design: string) =>
  `${design}\n4 bed 2 bath 2 car\n$390,625\nHouse size 178 m2`;

/* A page that presents one PROPERTY as a package — it names a lot. */
const propertyPage = (lot: string, design: string) =>
  `Lot ${lot} Coridale Lara\n${design}\n4 bed 2 bath 2 car\n$745,525`;

/* `PdfMediaPlacement` is flat: page, name, and how often the document draws
   it. One placement on one page is an ordinary facade render. */
const media = (pages: number[]) => pages.map((page, index) => ({
  page,
  name: `img-${index}.jpg`,
  placementsOnPage: 1,
  pagesDrawnOn: 1,
}));

// ---------------------------------------------------------------------------
// The heading maps generically
// ---------------------------------------------------------------------------

describe('house design is a canonical field, mapped by heading like any other', () => {
  it.each([
    'Design', 'House Design', 'HOUSE DESIGN', 'home design', 'Design Name',
    'House Design Name', 'design_type',
  ])('maps %s onto house_design', (heading) => {
    const record = normaliseStockRow({ [heading]: 'Elara 18', Lot: '1219' });
    expect(record.house_design).toBe('Elara 18');
    expect(record.unmapped[heading]).toBeUndefined();
  });

  it('does NOT steal the headings property_type already owns', () => {
    // `product`, `house type` and `type` answer "house or townhouse", not
    // "which design". Taking them would change an existing column's meaning
    // for every builder already using one.
    for (const heading of ['Product', 'House Type', 'Type', 'Product Type']) {
      const record = normaliseStockRow({ [heading]: 'house', Lot: '1' });
      expect(record.house_design, `${heading} must not become a design`).toBeNull();
    }
    expect(normaliseHeader('House Design')).toBe('housedesign');
  });

  it('carries the design in the normalised record, so source_row persists it', () => {
    const record = normaliseStockRow({ 'House Design': 'Elara 18', Lot: '1219' });
    // `source_row` is the normalised record: a canonical field rides along and
    // needs no column of its own.
    expect(Object.keys(record)).toContain('house_design');
  });
});

// ---------------------------------------------------------------------------
// A — basic design match
// ---------------------------------------------------------------------------

describe('A — a single-design brochure that names the row\'s design', () => {
  it('is accepted as design-level evidence', () => {
    const covers = findDesignCoverPages([designPage('Elara 18')], 'Elara 18');
    expect(covers).toHaveLength(1);
    expect(covers[0].page).toBe(1);
  });

  it('reaches the role assignment at the design level', () => {
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: [designPage('Elara 18')],
      pageOrderAuthoritative: true,
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[0].evidenceLevel).toBe(DESIGN_EVIDENCE_LEVEL);
    // And it says what it is, without claiming a photograph of this lot.
    expect(roles[0].reason).toContain('house design');
    expect(roles[0].reason).not.toMatch(/photograph of this (lot|property)/i);
  });
});

// ---------------------------------------------------------------------------
// B / G — the wrong design
// ---------------------------------------------------------------------------

describe('B — a document naming a different design', () => {
  it('is rejected', () => {
    expect(findDesignCoverPages([designPage('Elara 21')], 'Elara 18')).toEqual([]);
  });
});

describe('G — cross-design protection', () => {
  it('an Elara 18 brochure qualifies for the Elara 18 row and not the Elara 21 row', () => {
    const pages = [designPage('Elara 18')];
    expect(findDesignCoverPages(pages, 'Elara 18')).toHaveLength(1);
    expect(findDesignCoverPages(pages, 'Elara 21')).toEqual([]);
  });

  it('and the role assignment refuses the other design outright', () => {
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1450, Lara',
      design: 'Elara 21',
      pageTexts: [designPage('Elara 18')],
      pageOrderAuthoritative: true,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });
});

// ---------------------------------------------------------------------------
// C — no design on the row
// ---------------------------------------------------------------------------

describe('C — a row with no design', () => {
  it('does not use the fallback even though the document names one', () => {
    expect(findDesignCoverPages([designPage('Elara 18')], null)).toEqual([]);
    expect(findDesignCoverPages([designPage('Elara 18')], '')).toEqual([]);

    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: null,
      pageTexts: [designPage('Elara 18')],
      pageOrderAuthoritative: true,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });
});

// ---------------------------------------------------------------------------
// D / E — lot-specific always wins, and takes the card back
// ---------------------------------------------------------------------------

describe('D — lot-specific beats design', () => {
  it('ranks a property cover above a design cover', () => {
    const property = roleFromPropertyCover({
      where: 'visible page 1', identity: 'Lot 1219', packageFacts: ['price', 'beds'],
    });
    const design = roleFromDesignCover({
      where: 'visible page 1', design: 'Elara 18', packageFacts: ['price', 'beds'],
    });
    // Lower is stronger.
    expect(comparePrimaryEvidence(property.evidenceLevel, design.evidenceLevel))
      .toBeLessThan(0);
  });

  it('the design level is weaker than EVERY property-specific level', () => {
    for (const level of [1, 2, 3] as const) {
      expect(comparePrimaryEvidence(level, DESIGN_EVIDENCE_LEVEL)).toBeLessThan(0);
    }
  });

  it('a page naming the property is preferred over the design page in one document', () => {
    // Page 1 is the design's; page 2 is this lot's own. The property path runs
    // first, so the design path never even executes.
    const pages = [designPage('Elara 18'), propertyPage('1219', 'Elara 18')];
    expect(findPropertyCoverPages(pages, 'Lot 1219 Lara Coridale')).toHaveLength(1);

    const roles = assignPdfMediaRoles({
      media: media([1, 2]),
      label: 'Lot 1219 Lara Coridale',
      design: 'Elara 18',
      pageTexts: pages,
      pageOrderAuthoritative: true,
    });
    // The hero is on the property's page, at a property-specific level.
    const primary = roles.findIndex((role) => role.role === 'primary_property');
    expect(primary).toBe(1);
    expect(roles[primary].evidenceLevel).not.toBe(DESIGN_EVIDENCE_LEVEL);
  });
});

describe('E — a stronger image arriving later takes the card', () => {
  it('chooseCardImage prefers the lot-specific row over the design row', () => {
    const base = {
      source_stage: 'uploaded_document',
      verification_status: 'source_supplied',
      processing_status: 'ready',
      storage_path: 'org/x.png',
    };
    const designRow = {
      ...base,
      id: 'design-image',
      position: 0,
      source_detail: {
        role: 'primary_property',
        role_evidence_level: DESIGN_EVIDENCE_LEVEL,
        marketplace_eligibility_state: 'eligible',
      },
    };
    const lotRow = {
      ...base,
      id: 'lot-image',
      position: 1,
      source_detail: {
        role: 'primary_property',
        role_evidence_level: 2,
        marketplace_eligibility_state: 'eligible',
      },
    };

    // Design alone: it is the card.
    expect(chooseCardImage([designRow as DisplayableImage])?.image.id).toBe('design-image');
    // Lot-specific arrives — even at a LATER position — and takes it back.
    expect(chooseCardImage([designRow, lotRow] as DisplayableImage[])?.image.id).toBe('lot-image');
  });
});

// ---------------------------------------------------------------------------
// F — legitimate reuse across lots that state the same design
// ---------------------------------------------------------------------------

describe('F — two lots stating the same design may share the render', () => {
  it('qualifies for both, because both rows independently state it', () => {
    const pages = [designPage('Elara 18')];
    for (const label of ['Lot 1219, Lara', 'Lot 1302, Lara']) {
      const roles = assignPdfMediaRoles({
        media: media([1]),
        label,
        design: 'Elara 18',
        pageTexts: pages,
        pageOrderAuthoritative: true,
      });
      expect(roles[0].role, `${label} should qualify`).toBe('primary_property');
      expect(roles[0].evidenceLevel).toBe(DESIGN_EVIDENCE_LEVEL);
    }
  });
});

// ---------------------------------------------------------------------------
// H — weak design identities
// ---------------------------------------------------------------------------

describe('H — a design that cannot name itself licenses nothing', () => {
  it.each(['18', 'Classic', 'House', 'Single Storey', 'Double Storey', 'Standard', ''])(
    'refuses %s', (design) => {
      expect(designIdentityIsDistinctive(design)).toBe(false);
      expect(findDesignCoverPages([designPage(design || 'x')], design)).toEqual([]);
    },
  );

  it.each(['Elara 18', 'Miami 190', 'Stradbroke 197', 'Hudson 21'])(
    'accepts %s', (design) => {
      expect(designIdentityIsDistinctive(design)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// I — range brochures
// ---------------------------------------------------------------------------

describe('I — a multi-design range catalogue', () => {
  const rangeCover = 'Our 2026 Range\nFourteen designs to choose from';

  it('does not take the generic cover merely because the design appears later', () => {
    const pages = [
      rangeCover,
      designPage('Elara 18'),
      designPage('Aspire 22'),
      designPage('Nova 16'),
    ];
    const covers = findDesignCoverPages(pages, 'Elara 18');
    // Exactly the design's own page — never page 1.
    expect(covers).toHaveLength(1);
    expect(covers[0].page).toBe(2);

    const roles = assignPdfMediaRoles({
      media: media([1, 2]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: pages,
      pageOrderAuthoritative: true,
    });
    // The generic cover (page 1 media) is never the primary.
    expect(roles[0].role).not.toBe('primary_property');
  });

  it('refuses when the design is presented on two pages', () => {
    const pages = [designPage('Elara 18'), designPage('Elara 18')];
    expect(findDesignCoverPages(pages, 'Elara 18')).toHaveLength(2);
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: pages,
      pageOrderAuthoritative: true,
    });
    // Two presentations is the document declining to say which is its render.
    expect(roles[0].role).not.toBe('primary_property');
  });

  it('refuses a page that names the design but states no package facts', () => {
    expect(findDesignCoverPages(['Elara 18 — see page 4'], 'Elara 18')).toEqual([]);
  });

  it('refuses a page that names a LOT, because that is some property\'s own page', () => {
    // Lot 1450's own package page mentions Elara 18. It must not become Lot
    // 1219's design render.
    expect(findDesignCoverPages([propertyPage('1450', 'Elara 18')], 'Elara 18')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J / K / L — nothing else moves
// ---------------------------------------------------------------------------

describe('J — a shared direct JPEG stays refused', () => {
  it('carries no design and no property identity, so nothing licenses it', () => {
    // A bare image link states nothing. There are no page texts at all, so
    // neither the property path nor the design path can find a cover.
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: [],
      pageOrderAuthoritative: true,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });
});

describe('K — the existing lot-specific path is unchanged', () => {
  it('still finds a property cover with no design supplied at all', () => {
    const pages = [propertyPage('1219', 'Elara 18')];
    expect(findPropertyCoverPages(pages, 'Lot 1219 Lara Coridale')).toHaveLength(1);

    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219 Lara Coridale',
      pageTexts: pages,
      pageOrderAuthoritative: true,
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[0].evidenceLevel).not.toBe(DESIGN_EVIDENCE_LEVEL);
  });

  it('and an unauthoritative page order still refuses everything', () => {
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: [designPage('Elara 18')],
      pageOrderAuthoritative: false,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });
});

describe('L — the design path writes no pointer of its own', () => {
  it('produces a role assignment only; the card is still chosen by chooseCardImage', () => {
    const roles = assignPdfMediaRoles({
      media: media([1]),
      label: 'Lot 1219, Lara',
      design: 'Elara 18',
      pageTexts: [designPage('Elara 18')],
      pageOrderAuthoritative: true,
    });
    // The assignment is evidence, not a decision: it names a role and a level
    // and nothing that resembles a primary-image pointer.
    expect(Object.keys(roles[0]).sort())
      .toEqual(['evidence', 'evidenceLevel', 'reason', 'role']);
  });
});
