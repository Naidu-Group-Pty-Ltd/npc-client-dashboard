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
