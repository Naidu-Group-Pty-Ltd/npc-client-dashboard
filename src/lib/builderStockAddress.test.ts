import { describe, expect, it } from 'vitest';
import {
  builderStockAddress,
  parseBuilderAddressLine,
} from '../../supabase/functions/_shared/builderStockAddress.pure';

/**
 * Every `address_line` below is copied verbatim from `builder_stock_items`.
 * They are the lines that were being handed to the geocoder whole.
 */
describe('parseBuilderAddressLine', () => {
  it('parses a lot with a street number', () => {
    const p = parseBuilderAddressLine('Lot 209 - 44 Satinwood Crescent Donnybrook VIC');
    expect(p).toMatchObject({
      lotNumber: '209',
      streetNumber: '44',
      streetName: 'Satinwood',
      streetType: 'Crescent',
      suburb: 'Donnybrook',
      state: 'VIC',
    });
  });

  it('parses a lot with no street number, an estate and a design name', () => {
    const p = parseBuilderAddressLine(
      'Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
    );
    expect(p).toMatchObject({
      lotNumber: '36',
      streetNumber: null,
      streetName: 'Tringa',
      streetType: 'Street',
      estate: 'Sandpiper Estate',
      suburb: 'Tweed Heads South',
      state: 'NSW',
      postcode: '2486',
      designName: 'Stradbroke 180',
    });
  });

  it('parses a dual-key line', () => {
    const p = parseBuilderAddressLine(
      'Lot 104 - Finch Road, Century Estate, Redbank Plains QLD 4301 [Dual Key 4+1]',
    );
    expect(p).toMatchObject({
      lotNumber: '104',
      streetName: 'Finch',
      streetType: 'Road',
      estate: 'Century Estate',
      suburb: 'Redbank Plains',
      state: 'QLD',
      postcode: '4301',
      designName: 'Dual Key 4+1',
    });
  });

  it('parses a unit-over-street-number line', () => {
    const p = parseBuilderAddressLine('Lot 2 - 13/15 Rose Street, Yamanto QLD 4305');
    expect(p).toMatchObject({
      lotNumber: '2',
      unitNumber: '13',
      streetNumber: '15',
      streetName: 'Rose',
      streetType: 'Street',
      suburb: 'Yamanto',
      state: 'QLD',
      postcode: '4305',
    });
  });

  it('never promotes the lot number to a street number', () => {
    // Lot 104 at "104 Finch Road" would be a different property that may well
    // exist. The lot is captured and stays captured.
    const p = parseBuilderAddressLine('Lot 104 - Finch Road, Redbank Plains QLD 4301');
    expect(p.lotNumber).toBe('104');
    expect(p.streetNumber).toBeNull();
  });

  it('takes the LAST street type, so "Grove Street" is a Street', () => {
    const p = parseBuilderAddressLine('12 Grove Street, Armadale VIC 3143');
    expect(p.streetType).toBe('Street');
    expect(p.streetName).toBe('Grove');
  });

  it('does not read a leading number as a postcode', () => {
    const p = parseBuilderAddressLine('4301 Smith Street, Yamanto QLD 4305');
    expect(p.postcode).toBe('4305');
    expect(p.suburb).toBe('Yamanto');
  });

  it('reads a bare leading number as a LOT, never as a street number', () => {
    // The corpus settles this. These two rows are the same builder writing
    // consecutive lots on one street, one with the label and one without:
    //
    //   "1730 Hornsea Street"       suburb LARA
    //   "Lot 1731 Hornsea Street"   suburb Lara, VIC 3212
    //
    // and these are numbers no Australian street has.
    for (const [line, lot] of [
      ['1730 Hornsea Street', '1730'],
      ['51352 Danube Road', '51352'],
      ['60611 Raniformis Road', '60611'],
      ['20629 Marcellus Street', '20629'],
      ['1328 Worn Road', '1328'],
    ] as Array<[string, string]>) {
      const p = parseBuilderAddressLine(line);
      expect(p.lotNumber).toBe(lot);
      expect(p.streetNumber).toBeNull();
      expect(p.streetName).toBeTruthy();
    }
  });

  it('reads the number AFTER an explicit lot as the street number', () => {
    // `Lot 209 - 44 Satinwood Crescent` says both, in that order, and only
    // this form is unambiguous.
    const p = parseBuilderAddressLine('Lot 209 - 44 Satinwood Crescent Donnybrook VIC');
    expect(p.lotNumber).toBe('209');
    expect(p.streetNumber).toBe('44');
  });

  it('treats the last comma segment as the suburb and the middle as the estate', () => {
    // "Greenfern Habitat" is an estate that never says "Estate", so position
    // decides rather than a keyword.
    const p = parseBuilderAddressLine('Lot 3 - Heidi Close, Greenfern Habitat, Brown Plains, QLD 4118');
    expect(p.streetName).toBe('Heidi');
    expect(p.streetType).toBe('Close');
    expect(p.estate).toBe('Greenfern Habitat');
    expect(p.suburb).toBe('Brown Plains');
    expect(p.postcode).toBe('4118');
  });

  it('handles an estate-only line with no street at all', () => {
    const p = parseBuilderAddressLine('Lot 2065 - Coridale, Lara, VIC 3212');
    expect(p.lotNumber).toBe('2065');
    expect(p.suburb).toBe('Lara');
    expect(p.estate).toBe('Coridale');
    expect(p.streetName).toBeNull();
  });

  it('handles a lot separated by a comma and a postcode behind a dash', () => {
    expect(parseBuilderAddressLine('Lot 817, Ribbonwood Road')).toMatchObject({
      lotNumber: '817', streetName: 'Ribbonwood', streetType: 'Road',
    });
    expect(parseBuilderAddressLine('Lot 13 - Hummock Rise, Werribee, VIC - 3030')).toMatchObject({
      lotNumber: '13', streetName: 'Hummock', streetType: 'Rise',
      suburb: 'Werribee', state: 'VIC', postcode: '3030',
    });
  });

  it('handles a line with nothing in it', () => {
    for (const line of [null, undefined, '', '   ', ',,']) {
      const p = parseBuilderAddressLine(line);
      expect(p.streetName).toBeNull();
      expect(p.suburb).toBeNull();
    }
  });

  it('leaves an unclassifiable remainder as the suburb rather than guessing', () => {
    // No street type, so there is no honest place to cut. Calling the whole
    // thing a street would send the geocoder a street that does not exist.
    const p = parseBuilderAddressLine('Armstrong Creek VIC');
    expect(p.streetName).toBeNull();
    expect(p.suburb).toBe('Armstrong Creek');
    expect(p.state).toBe('VIC');
  });
});

describe('builderStockAddress', () => {
  it('recovers a street-level query from a line that was geocoded whole', () => {
    // Before: the geocoder was asked for the entire string, lot prefix and
    // design name included, and answered with the suburb centroid.
    const { full, precision, parsed } = builderStockAddress({
      address_line: 'Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
      suburb: null,
      state: 'NSW',
      postcode: null,
    });
    expect(full).toBe('Tringa Street, Tweed Heads South NSW 2486');
    expect(precision).toBe('street');
    // The estate is kept for a reader and withheld from the query.
    expect(parsed.estate).toBe('Sandpiper Estate');
    expect(full).not.toContain('Sandpiper');
    expect(full).not.toContain('Stradbroke');
    expect(full).not.toContain('Lot');
  });

  it('reaches rooftop precision where the line carries a street number', () => {
    const { full, precision } = builderStockAddress({
      address_line: 'Lot 209 - 44 Satinwood Crescent Donnybrook VIC',
      suburb: null,
      state: 'VIC',
      postcode: null,
    });
    expect(full).toBe('44 Satinwood Crescent, Donnybrook VIC');
    expect(precision).toBe('address');
  });

  it('recovers the postcode the structured column never had', () => {
    // 93 of 124 rows carry a postcode inside the text; 2 have it in the column.
    // The postcode is what stops `Donnybrook` resolving to Western Australia.
    const { locality } = builderStockAddress({
      address_line: 'Lot 12 - Mortlock Street, Cobblebank VIC 3338',
      suburb: null,
      state: null,
      postcode: null,
    });
    expect(locality).toBe('Cobblebank VIC 3338');
  });

  it('prefers a structured column a builder actually filled in', () => {
    const { locality } = builderStockAddress({
      address_line: 'Lot 12 - Mortlock Street, Cobblebank VIC 3338',
      suburb: 'Cobblebank North',
      state: 'VIC',
      postcode: '3338',
    });
    expect(locality).toBe('Cobblebank North VIC 3338');
  });

  it('never returns a query still carrying the design name', () => {
    for (const line of [
      'Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
      'Lot 104 - Finch Road, Century Estate, Redbank Plains QLD 4301 [Dual Key 4+1]',
    ]) {
      const { full } = builderStockAddress({ address_line: line });
      expect(full).not.toMatch(/[[\]]/);
    }
  });
});
