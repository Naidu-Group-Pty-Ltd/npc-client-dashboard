/**
 * BUILDER STOCK — EXHAUST THE BUILDER'S OWN SOURCE BEFORE PAYING FOR A FALLBACK.
 *
 * LIVE MARKETPLACE, 28 AUGUST 2026. Four cards showed a Street View of a road,
 * a roundabout, or nothing at all, while the builder's own linked package held
 * the house. The folders below are the production listings, verbatim.
 *
 *   Lot 13 Hummock Rise   Display Home - 13 Hummock Rise Werribee/
 *                             Property Photos/  Kaye_7341_HR.jpg … 38 photos
 *                             Package - 13 Hummock Rise Werribee (995).pdf
 *                         Victoria_Premium Inclusions List.pdf
 *
 *   Lot 1663 Ringer St    (178 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf
 *                         (207 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf
 *                         Contract of Sale (Draft) - Lot 1663, …pdf
 *
 *   Lot 1/2/3 Yamanto     Aerial Photo 1.jpg, Aerial Photo 2.jpg, Lot Plans.jpg,
 *                         Master Plan.jpg, Stage Plan.jpg, + contract/disclosure
 *                         (ONE folder shared by three lots)
 *
 * Lot 13 failed twice over: `selectPackageDocument` considers only
 * `application/pdf`, so thirty-eight photographs were never candidates, and it
 * requires the token "lot 13" while every file is named by street address.
 * Lot 1663 had two packages naming the lot and was refused as ambiguous — while
 * the row carries `building_size_sqm: 178` and one candidate is "(178 SqM)".
 * Yamanto has no facade at all, and must stay blank.
 */
import { describe, expect, it } from 'vitest';
import {
  isPackageImage, isNonFacadeImageName, streetAddressFrom, namesThisProperty,
  buildingSizeFrom, selectByBuildingSize, namedPackageCandidates,
  selectNamedDocument, selectPropertyPhotograph, selectPackageDocument,
  type DriveEntry, type ScopedEntry,
} from '../../../supabase/functions/_shared/builderStock/drivePackage.pure';

const PDF = 'application/pdf';
const DIR = 'application/vnd.google-apps.folder';
const JPG = 'image/jpeg';
const f = (name: string, mimeType: string, id = name): DriveEntry => ({ id, name, mimeType });

const LOT_13_LABEL = 'Lot 13 - Hummock Rise, Werribee, VIC - 3030';
const LOT_1663_LABEL = 'Lot 1663 - Ringer Street, Lara, VIC 3212';
const LOT_3_LABEL = 'Lot 3 - 13/15 Rose Street, Yamanto QLD 4305';

const id13 = { lot: '13', street: streetAddressFrom(LOT_13_LABEL) };
const id1663 = { lot: '1663', street: streetAddressFrom(LOT_1663_LABEL) };

describe('a street address is the source naming the property', () => {
  it('reads the street from the row, not the lot number', () => {
    expect(streetAddressFrom(LOT_13_LABEL)).toEqual({ number: '13', street: 'hummock rise' });
  });

  it('uses the lot number as the street number on a house-and-land row', () => {
    // "Lot 1663 - Ringer Street, Lara" states no separate number because the
    // estate has not issued one; the lot IS the number, and the builder's own
    // files say "Lot 1663, Ringer Street".
    expect(streetAddressFrom(LOT_1663_LABEL))
      .toEqual({ number: '1663', street: 'ringer street' });
  });

  it('prefers a real street number over the lot when the row states one', () => {
    // "Lot 3 - 13/15 Rose Street" is lot 3 at number 15, not 3 Rose Street.
    expect(streetAddressFrom(LOT_3_LABEL))
      .toEqual({ number: '15', street: 'rose street' });
  });

  it('cannot match a different number on the same street', () => {
    const id = { lot: null, street: streetAddressFrom(LOT_1663_LABEL) };
    expect(namesThisProperty('Lot 1664, Ringer Street, Lara.pdf', id)).toBe(false);
    expect(namesThisProperty('Lot 1663, Ringer Street, Lara.pdf', id)).toBe(true);
  });

  it('matches the builder folder that states the address', () => {
    expect(namesThisProperty('Display Home - 13 Hummock Rise Werribee', id13)).toBe(true);
    expect(namesThisProperty('Package - 13 Hummock Rise Werribee (995).pdf', id13)).toBe(true);
  });

  it('still matches a lot token where the builder uses one', () => {
    expect(namesThisProperty('Lot 43 - Stradbroke 180 - Property Package.pdf',
      { lot: '43', street: null })).toBe(true);
  });

  it('does not match a different house on the same street', () => {
    expect(namesThisProperty('Display Home - 15 Hummock Rise Werribee', id13)).toBe(false);
    expect(namesThisProperty('Victoria_Premium Inclusions List.pdf', id13)).toBe(false);
  });
});

describe('Lot 13 — thirty-eight photographs the old rule could not see', () => {
  const photos = Array.from({ length: 38 }, (_, i) => f(`Kaye_${7341 + i}_HR.jpg`, JPG));
  const scoped: ScopedEntry[] = [
    { entry: f('Display Home - 13 Hummock Rise Werribee', DIR), path: [] },
    { entry: f('Victoria_Premium Inclusions List.pdf', PDF), path: [] },
    { entry: f('Property Photos', DIR), path: ['Display Home - 13 Hummock Rise Werribee'] },
    ...photos.map((entry) => ({
      entry,
      path: ['Display Home - 13 Hummock Rise Werribee', 'Property Photos'],
    })),
  ];

  it('the old lot-token document rule finds nothing, as production showed', () => {
    expect(selectPackageDocument(
      scoped.map((s) => s.entry), { lot: '13', design: null })).toBeNull();
  });

  it('recovers a photograph the builder filed under this exact property', () => {
    const found = selectPropertyPhotograph(scoped, id13);
    expect(found).not.toBeNull();
    expect(found!.entry.name).toBe('Kaye_7341_HR.jpg');
    expect(found!.path).toContain('Display Home - 13 Hummock Rise Werribee');
  });

  it('is deterministic — the same folder always yields the same photograph', () => {
    const a = selectPropertyPhotograph(scoped, id13);
    const b = selectPropertyPhotograph(scoped.slice().reverse(), id13);
    expect(a!.entry.id).toBe(b!.entry.id);
  });

  it('also matches the street-addressed package document', () => {
    expect(selectNamedDocument([
      f('Package - 13 Hummock Rise Werribee (995).pdf', PDF),
      f('Victoria_Premium Inclusions List.pdf', PDF),
    ], id13, null)?.name).toBe('Package - 13 Hummock Rise Werribee (995).pdf');
  });
});

describe('Lot 1663 — the row already said which of the two packages it is', () => {
  const entries = [
    f('(178 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf', PDF),
    f('(207 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf', PDF),
    f('Contract of Sale (Draft) - Lot 1663, Ringer Street, Lara, VIC 3212.pdf', PDF),
  ];

  it('the old rule refused, because two packages named the lot', () => {
    expect(selectPackageDocument(entries, { lot: '1663', design: null })).toBeNull();
  });

  it('the contract is not a package candidate', () => {
    expect(namedPackageCandidates(entries, id1663).map((e) => e.name))
      .toEqual([entries[0].name, entries[1].name]);
  });

  it('reads the size a file name states', () => {
    expect(buildingSizeFrom('(178 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf')).toBe(178);
    expect(buildingSizeFrom('Contract of Sale (Draft) - Lot 1663…pdf')).toBeNull();
  });

  it('selects the 178 SqM package for a 178 m² property', () => {
    expect(selectNamedDocument(entries, id1663, 178)?.name)
      .toBe('(178 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf');
  });

  it('selects the 207 SqM package for a 207 m² property', () => {
    expect(selectNamedDocument(entries, id1663, 207)?.name)
      .toBe('(207 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf');
  });

  it('refuses when the row states a size no candidate carries', () => {
    expect(selectNamedDocument(entries, id1663, 999)).toBeNull();
  });

  it('refuses when the row states no size at all', () => {
    expect(selectNamedDocument(entries, id1663, null)).toBeNull();
    expect(selectByBuildingSize(entries, undefined)).toBeNull();
  });
});

describe('Yamanto — a shared folder of plans must stay blank', () => {
  const scoped: ScopedEntry[] = [
    'Aerial Photo 1.jpg', 'Aerial Photo 2.jpg', 'Lot Plans.jpg',
    'Master Plan.jpg', 'Stage Plan.jpg',
  ].map((name) => ({ entry: f(name, JPG), path: [] }));

  const id3 = { lot: '3', street: streetAddressFrom(LOT_3_LABEL) };

  it('rejects aerials and plans by what the builder called them', () => {
    for (const { entry } of scoped) expect(isNonFacadeImageName(entry.name)).toBe(true);
    expect(isNonFacadeImageName('Kaye_7341_HR.jpg')).toBe(false);
  });

  it('finds no photograph for Lot 3, which is the correct answer', () => {
    expect(selectPropertyPhotograph(scoped, id3)).toBeNull();
  });

  it('finds no package document for Lot 3 either', () => {
    expect(selectNamedDocument([
      f('Combined REIQ Contract - Rosebud Designs - Lot 1 - 13-15 Rose St Yamanto v3.pdf', PDF),
      f('Signed Seller Disclosure Statement - Form-2 - … for LOT 1.pdf', PDF),
      f('Yamanto_Investment_Report.pdf', PDF),
    ], id3, null)).toBeNull();
  });
});

describe('a shared library cannot leak one lot’s photograph onto another', () => {
  it('an unattributed photograph in a shared folder is never taken', () => {
    // No ancestor folder names any property: three lots share this folder.
    const shared: ScopedEntry[] = [{ entry: f('IMG_0001.jpg', JPG), path: ['Yamanto'] }];
    expect(selectPropertyPhotograph(shared, { lot: '3', street: null })).toBeNull();
  });

  it('a photograph filed under a DIFFERENT lot is never taken', () => {
    const other: ScopedEntry[] = [
      { entry: f('IMG_0001.jpg', JPG), path: ['Lot 51', 'Property Photos'] },
    ];
    expect(selectPropertyPhotograph(other, { lot: '52', street: null })).toBeNull();
    expect(selectPropertyPhotograph(other, { lot: '51', street: null })).not.toBeNull();
  });

  it('a plans folder is rejected even when it names the property', () => {
    const plans: ScopedEntry[] = [
      { entry: f('sheet1.jpg', JPG), path: ['Lot 51', 'Site Plans'] },
    ];
    expect(selectPropertyPhotograph(plans, { lot: '51', street: null })).toBeNull();
  });

  it('accepts only the image types the pipeline can store', () => {
    expect(isPackageImage(f('a.jpg', JPG))).toBe(true);
    expect(isPackageImage(f('a.png', 'image/png'))).toBe(true);
    expect(isPackageImage(f('a.webp', 'image/webp'))).toBe(true);
    expect(isPackageImage(f('a.pdf', PDF))).toBe(false);
    expect(isPackageImage(f('a.heic', 'image/heic'))).toBe(false);
  });
});

describe('nothing that already worked is allowed to change', () => {
  it('the Sandpiper lot+design selection is untouched', () => {
    const entries = [f('Lot 43 - Stradbroke 180 - Property Package.pdf', PDF)];
    expect(selectPackageDocument(entries, { lot: '43', design: 'stradbroke 180' })?.name)
      .toBe('Lot 43 - Stradbroke 180 - Property Package.pdf');
  });

  it('two package candidates with no disambiguator is still a refusal', () => {
    const entries = [
      f('Lot 43 - Stradbroke 180 - Property Package.pdf', PDF),
      f('Lot 43 - Miami 190 - Property Package.pdf', PDF),
    ];
    expect(selectPackageDocument(entries, { lot: '43', design: null })).toBeNull();
    expect(selectNamedDocument(entries, { lot: '43', street: null }, null)).toBeNull();
  });
});

/**
 * WIDENING WHICH NAMES COUNT MUST NOT WIDEN WHICH DOCUMENTS COUNT.
 *
 * Caught by the existing suite while building this: the new selector asked only
 * "does this name the property" and would have handed a Stradbroke 180 row the
 * "Lot 43 - Bishop 258" package, because both name Lot 43 truthfully. Seven
 * Sandpiper rows share that lot. The design is what separates them and it is
 * never dropped.
 */
describe('the house design is never dropped when identity widens', () => {
  const bishop = f('Lot 43 - Bishop 258 - Property Package.pdf', PDF);
  const stradbroke = f('Lot 43 - Stradbroke 180 - Property Package.pdf', PDF);

  it('does not give a Stradbroke row the Bishop package', () => {
    expect(selectNamedDocument([bishop],
      { lot: '43', street: null, design: 'stradbroke 180' }, null)).toBeNull();
  });

  it('gives the Stradbroke row its own package', () => {
    expect(selectNamedDocument([bishop, stradbroke],
      { lot: '43', street: null, design: 'stradbroke 180' }, null)?.name)
      .toBe(stradbroke.name);
  });

  it('a size disambiguator cannot override the design either', () => {
    // Even with a size that matches, a package for another design is not this
    // row's package.
    expect(selectNamedDocument([f('Lot 43 - Bishop 258 - 178 SqM.pdf', PDF)],
      { lot: '43', street: null, design: 'stradbroke 180' }, 178)).toBeNull();
  });

  it('a row with no design still matches on the property alone', () => {
    expect(selectNamedDocument([stradbroke],
      { lot: '43', street: null, design: null }, null)?.name).toBe(stradbroke.name);
  });
});
