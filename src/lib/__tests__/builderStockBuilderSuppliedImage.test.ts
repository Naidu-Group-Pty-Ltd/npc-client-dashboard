/**
 * Builder Stock — the picture a builder hands over directly.
 *
 * WHY THIS EXISTS, MEASURED. Every image this product serves is READ out of
 * something: a column naming a URL, a brochure page naming a lot, a page
 * cover, a design brochure. That works until there is nothing to read — and on
 * the one live source, thirteen of twenty-six published properties attach no
 * document at all. The pipeline's own fallbacks then offered, for those rows,
 * a Simonds display home, an ABC Homes display home and the land developer's
 * estate marketing, and refused every one of them, correctly. Those cards were
 * blank because there was nothing to read, and no reader fixes that.
 *
 * The one party who certainly has the picture is the builder, and the product
 * gave them no way to hand it over.
 *
 * Two routes, one act. A render FOR A DESIGN serves every row of theirs
 * stating it — three uploads cover those thirteen properties and every future
 * one — and a picture FOR ONE PROPERTY is the exception and the guarantee.
 *
 * NEITHER INVENTS A LEVEL OR A STAGE, which is what these tests are mostly
 * about: a builder-supplied image is `uploaded_document` / `source_supplied`,
 * so it travels the existing ladder unchanged and is subject to every rule
 * that already governs a builder's own picture — including the promotional
 * overlay rule that refuses a facade with "$25,000 REBATE" set over it.
 */
import { describe, expect, it } from 'vitest';

import {
  designOfStoredRow,
  isBuilderSuppliedPath, propertyImageStoragePath,
} from '../../../supabase/functions/_shared/builderStock/builderSuppliedImage.pure';
import {
  PRIMARY_ROLE,
  roleFromBuilderProperty, roleFromPropertyCover,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';
import {
  builderImageReference,
} from '../../../supabase/functions/_shared/builderStock/attachBuilderImage';

const ORG = '11111111-2222-3333-4444-555555555555';

describe('the design a stored row states', () => {
  it('reads the design from the canonical field, or from where an older import left it', () => {
    expect(designOfStoredRow({ house_design: 'Urban 19' })).toBe('Urban 19');
    // Imported before the `HOUSE` column was mappable — which is every row
    // this feature was built for.
    expect(designOfStoredRow({ house_design: null, unmapped: { HOUSE: 'DK 22B' } })).toBe('DK 22B');
    // The canonical field wins where both are present.
    expect(designOfStoredRow({ house_design: 'Urban 19', unmapped: { HOUSE: 'DK 22B' } }))
      .toBe('Urban 19');
    expect(designOfStoredRow({ unmapped: { HOUSE: '   ' } })).toBeNull();
    expect(designOfStoredRow(null)).toBeNull();
  });
});

describe('what a builder supplies carries the evidence it deserves — no more', () => {
  it('a picture for THIS property is level 1: the builder said so directly', () => {
    const role = roleFromBuilderProperty({ suppliedBy: 'builder', property: 'Lot 231' });
    expect(role.role).toBe(PRIMARY_ROLE);
    expect(role.evidenceLevel).toBe(1);
    expect(role.reason).toContain('directly');
  });

  it('records who supplied it, because staff acting for a builder is a different act', () => {
    expect(roleFromBuilderProperty({ suppliedBy: 'staff', property: 'Lot 231' }).evidence)
      .toContain('on the builder\'s behalf');
    expect(roleFromBuilderProperty({ suppliedBy: 'builder', property: 'Lot 231' }).evidence)
      .toContain('supplied by the builder');
  });
});

describe('a storage path is written by this product, or it is not read', () => {
  it('names each object under the one prefix this product owns', () => {
    const property = propertyImageStoragePath({
      organisationId: ORG, stockItemId: ORG, filename: 'facade.jpg',
    });
    expect(property.startsWith(`builder-supplied/${ORG}/`)).toBe(true);
    expect(isBuilderSuppliedPath(property)).toBe(true);
  });

  it('REFUSES the withdrawn design-render prefix — nothing writes it any more', () => {
    expect(isBuilderSuppliedPath(`builder-designs/${ORG}/dk22b/render.jpg`)).toBe(false);
  });

  it('REFUSES ANYTHING ELSE — a path in a request body is a lookup key, never authority', () => {
    for (const refused of [
      '',
      null,
      '/etc/passwd',
      `builder-designs/${ORG}/../../secrets/key.jpg`,
      'stock-lists/other-org/list.xlsx',
      `builder-designs/${ORG}/dk22b`,
      'builder-designs/not-a-uuid/dk22b/render.jpg',
      'https://example.invalid/render.jpg',
    ]) {
      expect(isBuilderSuppliedPath(refused), String(refused)).toBe(false);
    }
  });
});
