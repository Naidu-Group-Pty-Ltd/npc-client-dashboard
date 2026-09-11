/**
 * Builder stock — the card does not say the lot twice.
 *
 * MEASURED, 3 SEPTEMBER 2026: a single-property brochure imported an address
 * of "Lot 1731 Hornsea Street" and, correctly, a lot number of "1731". The
 * card put its own designation in front and read
 * "Lot 1731, Lot 1731 Hornsea Street".
 *
 * One rule, imported by the server label and the card title alike, because
 * two answers to "what is this property called" is how two surfaces stop
 * looking like one product.
 */
import { describe, expect, it } from 'vitest';

import {
  addressWithoutLeadingDesignation, stockRecordLabel,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { stockItemTitle } from '../builderStock';

describe('addressWithoutLeadingDesignation', () => {
  it('drops the designation the label is about to repeat', () => {
    expect(addressWithoutLeadingDesignation('Lot 1731 Hornsea Street', 'Lot', '1731'))
      .toBe('Hornsea Street');
    expect(addressWithoutLeadingDesignation('Lot 12, Smith Road', 'Lot', '12'))
      .toBe('Smith Road');
    expect(addressWithoutLeadingDesignation('LOT 8 - Kent Way', 'Lot', '8'))
      .toBe('Kent Way');
    expect(addressWithoutLeadingDesignation('Unit 3 Baker Street', 'Unit', '3'))
      .toBe('Baker Street');
  });

  it('keeps a DIFFERENT designation, because the disagreement is the information', () => {
    expect(addressWithoutLeadingDesignation('Lot 5 Smith Street', 'Lot', '1731'))
      .toBe('Lot 5 Smith Street');
    expect(addressWithoutLeadingDesignation('Lot 17 Hornsea Street', 'Lot', '1'))
      .toBe('Lot 17 Hornsea Street');
  });

  it('never touches the middle of an address', () => {
    expect(addressWithoutLeadingDesignation('3/12 Smith Street', 'Unit', '3'))
      .toBe('3/12 Smith Street');
    expect(addressWithoutLeadingDesignation('15 Kent Road, Lot 4 Estate', 'Lot', '4'))
      .toBe('15 Kent Road, Lot 4 Estate');
  });

  it('never answers an empty address', () => {
    expect(addressWithoutLeadingDesignation('Lot 1731', 'Lot', '1731')).toBe('Lot 1731');
    expect(addressWithoutLeadingDesignation('', 'Lot', '1731')).toBe('');
    expect(addressWithoutLeadingDesignation(null, 'Lot', '1731')).toBe('');
  });
});

describe('the label and the card title give one answer', () => {
  const property = {
    lot_number: '1731', unit_number: null,
    address_line: 'Lot 1731 Hornsea Street',
    suburb: 'Lara', development_name: 'Austin Estate',
    project_name: null, external_reference: null,
  };

  it('the card title says the lot once', () => {
    expect(stockItemTitle(property as never)).toBe('Lot 1731, Hornsea Street');
  });

  it('the server label says the lot once', () => {
    expect(stockRecordLabel(property as never)).toBe('Lot 1731, Hornsea Street, Lara');
  });

  it('an address that never repeated the lot is unchanged', () => {
    const plain = { ...property, address_line: '12 Hornsea Street' };
    expect(stockItemTitle(plain as never)).toBe('Lot 1731, 12 Hornsea Street');
    expect(stockRecordLabel(plain as never)).toBe('Lot 1731, 12 Hornsea Street, Lara');
  });

  it('a property with no address still names itself', () => {
    const noAddress = { ...property, address_line: null };
    expect(stockItemTitle(noAddress as never)).toBe('Lot 1731, Austin Estate');
    expect(stockRecordLabel(noAddress as never)).toBe('Lot 1731, Lara');
  });
});

/**
 * The card prints the locality on its own line directly under the title, so a
 * title carrying the suburb, state and postcode again spends a finite width
 * twice on one fact. Measured on the 10 September 2026 Notion list, `Lot 60941
 * - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]` truncated at `[4 B…`
 * — which is exactly where the two packages offered on that lot differ.
 */
describe('the title says what the locality line does not', () => {
  const card = (address_line: string, building_size_sqm: number | null = null) => ({
    address_line, unit_number: null, lot_number: null,
    development_name: null, project_name: null, external_reference: null,
    building_size_sqm,
  }) as never;

  it('drops the suburb, state and postcode the card repeats beneath it', () => {
    expect(stockItemTitle(card('Lot 60416 Russula St, Beveridge VIC 3753 (141 m2)')))
      .toBe('Lot 60416, Russula Street');
  });

  it('keeps what tells two packages on one lot apart — as ONE labelled fact', () => {
    /*
     * A house-and-land list offers one piece of land with several houses on
     * it, and those rows are different things to sell. Without a suffix both
     * cards read `Lot 60941, Cloverton Estate`.
     *
     * REPORTED, 11 SEPTEMBER 2026: printed verbatim, the list's own
     * disambiguator made the card say one thing twice and another ambiguously.
     * `3 Bed` is already drawn as an icon two lines below, and `140 m²` is the
     * HOUSE sitting directly above a row reading `286 m² land` — two unlike
     * square-metre figures on one card, neither labelled. The house size is
     * the one fact there the card does not otherwise carry, so it is what
     * survives, labelled, and the bed count goes.
     */
    expect(stockItemTitle(card('Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]', 140)))
      .toBe('Lot 60941, Cloverton Estate · 140 m² home');
    expect(stockItemTitle(card('Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]', 154)))
      .toBe('Lot 60941, Cloverton Estate · 154 m² home');
  });

  it('keeps a real design name whole, because a name beats a measurement', () => {
    expect(stockItemTitle(card('Lot 22 - Aria Estate, Tarneit VIC 3029 [Ilya 15]', 141)))
      .toBe('Lot 22, Aria Estate · Ilya 15');
  });

  it('takes the designation the line OPENED with, not whichever field parsed', () => {
    /*
     * `Lot 1 - 13/15 Rose Street` carries both: lot 1 is the row, and 13 is a
     * unit over street number 15. Reading the unit rendered the two dual-key
     * halves of that address as one title, twice.
     */
    expect(stockItemTitle(card('Lot 1 - 13/15 Rose Street, Yamanto QLD 4305')))
      .toBe('Lot 1, 13/15 Rose Street');
    expect(stockItemTitle(card('Lot 2 - 13/15 Rose Street, Yamanto QLD 4305')))
      .toBe('Lot 2, 13/15 Rose Street');
  });

  it('keeps a street number the line supplied', () => {
    expect(stockItemTitle(card('Lot 209 - 44 Satinwood Crescent Donnybrook VIC')))
      .toBe('Lot 209, 44 Satinwood Crescent');
  });

  it('names the estate where the line names no street', () => {
    expect(stockItemTitle(card('Lot 1482 - Coridale Estate, Lara 3212 VIC [184 m2] Remi 20')))
      .toBe('Lot 1482, Coridale Estate · Remi 20');
  });

  it('leaves a line that never named a lot exactly as it was', () => {
    /*
     * A bare leading number is ambiguous and the parser resolves it as a lot,
     * so composing from its parts would turn a supplied street address into a
     * street with no number. Only a line that NAMED its lot is recomposed.
     */
    expect(stockItemTitle({
      address_line: '12 Hornsea Street', unit_number: null, lot_number: '1731',
      development_name: null, project_name: null, external_reference: null,
    } as never)).toBe('Lot 1731, 12 Hornsea Street');
  });
});
