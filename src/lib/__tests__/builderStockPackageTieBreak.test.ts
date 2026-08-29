/**
 * BUILDER STOCK — WHEN THE LIBRARY NAMES A PROPERTY TWICE, THE BUILDER HAS
 * USUALLY ALREADY SAID WHICH FILE IS THE PACKAGE.
 *
 * PRODUCTION, 29 AUGUST 2026. Lot 209, 44 Satinwood Crescent Donnybrook shipped
 * a Street View of the street while the builder's own property package sat one
 * link away. Its Drive folder, read verbatim:
 *
 *     DH022 Preliminary Specification_260723.pdf                     reference
 *     Interior Design_Wanderwell_NordicLightColours.pdf              candidate
 *     Lot 209, 44 Satinwood Crescent Donnybrook VIC .pdf             candidate
 *     Lot 209, 44 Satinwood Crescent Donnybrook VIC _Inclusions.pdf  reference
 *     Lot 209, 44 Satinwood Crescent Donnybrook VIC _package.pdf     candidate
 *     POS VIC_ Certificate - Copy of Plan - PS917279N.pdf            candidate
 *
 * THREE documents name the property. The kind table removes the Inclusions,
 * leaving TWO candidates — so `named.length !== 1` and `packages.length !== 1`,
 * both tests decline, and `selectPackageDocument` returned null. The stored
 * verdict read "That folder names no document for this exact property", which
 * is the one thing the folder demonstrably does.
 *
 * The tie is broken by the only fact that is not a guess: one of the files is
 * called `_package`.
 *
 * WHAT THIS MUST NOT BECOME. The rule that already governs this module is that
 * inventing a package out of a contract is worse than showing no picture, and
 * that stands. The tie-break runs only after both existing tests have declined,
 * so a folder that already resolved resolves to the SAME document; it still
 * demands the document name this exact lot; it still refuses a contract, an
 * appraisal or a reference; and two files both claiming the word is still the
 * library declining to say which.
 */
import { describe, expect, it } from 'vitest';

import {
  driveDocumentKind, selectPackageDocument,
} from '../../../supabase/functions/_shared/builderStock/drivePackage.pure';

const PDF = 'application/pdf';
const doc = (name: string) => ({ id: name, name, mimeType: PDF });

/** Verbatim from live Drive folder 1o5dxZgUoMBHMT_elxYC9-xoWsjYa2iY5. */
const LOT_209_FOLDER = [
  doc('DH022 Preliminary Specification_260723.pdf'),
  doc('Interior Design_Wanderwell_NordicLightColours.pdf'),
  doc('Lot 209, 44 Satinwood Crescent Donnybrook VIC .pdf'),
  doc('Lot 209, 44 Satinwood Crescent Donnybrook VIC _Inclusions.pdf'),
  doc('Lot 209, 44 Satinwood Crescent Donnybrook VIC _package.pdf'),
  doc('POS VIC_ Certificate - Copy of Plan - PS917279N.pdf'),
];

describe('the reported case', () => {
  it('the folder does name the property, three times over', () => {
    const naming = LOT_209_FOLDER.filter((entry) => /lot 209/i.test(entry.name));
    expect(naming).toHaveLength(3);
  });

  it('picks the file the builder called the package', () => {
    const picked = selectPackageDocument(LOT_209_FOLDER, { lot: '209', design: null });
    expect(picked?.name).toBe('Lot 209, 44 Satinwood Crescent Donnybrook VIC _package.pdf');
  });
});

describe('what the tie-break may not do', () => {
  it('a contract is never promoted, even alone with the package word absent', () => {
    // Rose Street's real folder: one document, and it is a contract.
    const folder = [
      doc('Combined REIQ Contract - Rosebud Designs - Lot 1 - 13-15 Rose St Yamanto v3.pdf'),
      doc('Yamanto_Investment_Report.pdf'),
    ];
    expect(driveDocumentKind(folder[0].name)).toBe('contract');
    // `named` is 1, so the pre-existing path returns it — unchanged behaviour,
    // and the cover check downstream is what refuses a contract's pages.
    expect(selectPackageDocument(folder, { lot: '1', design: null })?.name)
      .toBe(folder[0].name);
  });

  it('two members of the family both marked is still a refusal', () => {
    const folder = [
      doc('Lot 12 Somewhere Street.pdf'),
      doc('Lot 12 Somewhere Street package.pdf'),
      doc('Lot 12 Somewhere Street package.pdf '),
    ];
    expect(selectPackageDocument(folder, { lot: '12', design: null })).toBeNull();
  });

  it('COVELLA: the word alone never decides — the bare file is that library\'s package', () => {
    /*
     * The rule that was written here first — "one candidate contains the word
     * package" — would have taken the second file. In the real Covella folder
     * the package is the BARE-named one, so that rule fixes Satinwood by
     * breaking Covella. Neither name is the other plus a marker, so nothing
     * has been marked and the refusal stands.
     */
    const folder = [
      doc('LOT 914 • COVELLA • GREENBANK QLD.pdf'),
      doc('Lot 914 Covella Estate - Property Package.pdf'),
    ];
    expect(selectPackageDocument(folder, { lot: '914', design: null })).toBeNull();
  });

  it('the marker only counts against a document of the same family', () => {
    // Same lot, unrelated base names — one carries the word, and it still
    // decides nothing.
    const folder = [
      doc('Lot 77 Riverbank Drive.pdf'),
      doc('Lot 77 Something Entirely Different package.pdf'),
    ];
    expect(selectPackageDocument(folder, { lot: '77', design: null })).toBeNull();
  });

  it('a package belonging to another lot is never taken', () => {
    const folder = [
      doc('Lot 210, 46 Satinwood Crescent Donnybrook VIC _package.pdf'),
      doc('Lot 211, 48 Satinwood Crescent Donnybrook VIC _package.pdf'),
    ];
    expect(selectPackageDocument(folder, { lot: '209', design: null })).toBeNull();
  });

  it('an appraisal carrying the word package is still an appraisal', () => {
    const folder = [
      doc('Rental Appraisal Lot 104, Finch Road package.pdf'),
      doc('Something Else Lot 104.pdf'),
    ];
    expect(driveDocumentKind(folder[0].name)).toBe('appraisal');
    // The appraisal is excluded from `packages`, so it can never be the
    // tie-break's answer; the remaining candidate is chosen by the rule that
    // already existed.
    expect(selectPackageDocument(folder, { lot: '104', design: null })?.name)
      .toBe('Something Else Lot 104.pdf');
  });

  it('a folder naming the property once is decided exactly as before', () => {
    const folder = [
      doc('Lot 51 - Bishop 258 - Property Package.pdf'),
      doc('Lot 52 - Bishop 258 - Property Package.pdf'),
    ];
    expect(selectPackageDocument(folder, { lot: '51', design: null })?.name)
      .toBe('Lot 51 - Bishop 258 - Property Package.pdf');
  });

  it('nothing naming the property is still nothing', () => {
    expect(selectPackageDocument(LOT_209_FOLDER, { lot: '999', design: null })).toBeNull();
  });
});
