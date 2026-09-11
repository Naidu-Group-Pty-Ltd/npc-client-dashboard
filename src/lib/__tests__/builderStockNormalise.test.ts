/**
 * Builder stock normalisation — the rules that must not drift.
 *
 * These tests exist for one class of defect: a stock list that imports as
 * something the file did not say. Every case below is a value the pipeline
 * could plausibly invent — a price it rounded, a status it assumed, two
 * properties it merged — and the assertion is that it does not.
 */
import { describe, expect, it } from 'vitest';
import {
  coerceAvailability, coerceNumber, coercePrice, coercePropertyType, coerceState,
  fieldForHeader, geocodableAddress, identifiesAProperty, normaliseStockRow,
  stockMatchKeys,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  keyRowsByHeader, parseDelimited,
} from '../../../supabase/functions/_shared/builderStock/table.pure';
import {
  classifyStockFile, isAcceptableStockStoragePath, safeObjectName,
  stockFileAcceptAttribute,
} from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';

describe('header aliasing', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(fieldForHeader('Land Size (m2)')).toBe('land_size_sqm');
    expect(fieldForHeader('land_size_m2')).toBe('land_size_sqm');
    expect(fieldForHeader('LANDSIZEM2')).toBe('land_size_sqm');
  });

  it('recognises its own canonical names, which is what a model returns', () => {
    expect(fieldForHeader('building_size_sqm')).toBe('building_size_sqm');
    expect(fieldForHeader('external_reference')).toBe('external_reference');
    expect(fieldForHeader('availability_status')).toBe('availability_status');
  });

  it('returns null for a heading it does not know rather than guessing', () => {
    expect(fieldForHeader('Deposit Required')).toBeNull();
    expect(fieldForHeader('Commission %')).toBeNull();
  });

  /*
   * THE LIVE MASTER STOCKLIST'S OWN HEADINGS, VERBATIM. Measured on the
   * 6 September 2026 upload: 81 of 81 rows carried `Package Price - V002` and
   * `BED // BATH // CAR`, every value landed in `unmapped`, and every card
   * read "Price not stated" with no bedroom in sight — while three rows showed
   * a STALE price a V001 sheet had written before the suffix appeared.
   */
  it('a heading may carry the sheet\'s own version suffix', () => {
    expect(fieldForHeader('Package Price - V002')).toBe('price');
    expect(fieldForHeader('Package Price - V003')).toBe('price');
    expect(fieldForHeader('Status V2')).toBe('availability_status');
  });

  it('the version strip lands only on a KNOWN alias, never on a guess', () => {
    // Components of the package price have no field on purpose — see the
    // alias table — and versioning them must not change that.
    expect(fieldForHeader('Build Price - V002')).toBeNull();
    expect(fieldForHeader('Land Price')).toBeNull();
    // A version in the MIDDLE of a heading is part of the heading.
    expect(fieldForHeader('[VG] MASTER STOCKLIST - V002 Contract Type')).toBeNull();
    // A document-link column is not the property's image, versioned or not.
    expect(fieldForHeader('Brochure V002')).toBeNull();
  });

  it('recognises the combined BED // BATH // CAR column', () => {
    expect(fieldForHeader('BED // BATH // CAR')).toBe('bed_bath_car');
    expect(fieldForHeader('Beds/Baths/Cars')).toBe('bed_bath_car');
  });
});

describe('the combined BED // BATH // CAR value', () => {
  it('parses the three counts in stated order', () => {
    const record = normaliseStockRow({ Lot: '927', 'BED // BATH // CAR': '3 / 2 / 2' });
    expect(record?.bedrooms).toBe(3);
    expect(record?.bathrooms).toBe(2);
    expect(record?.car_spaces).toBe(2);
    expect(record?.unmapped['BED // BATH // CAR']).toBeUndefined();
  });

  it('writes NOTHING unless exactly three counts parse', () => {
    // "3 / 2" has not said which of the three it dropped; a partial write
    // would put the bathrooms in the car spaces.
    for (const value of ['3 / 2', '3 / 2 / 2 / 1', 'TBA', '3 / two / 2', '3 / / 2']) {
      const record = normaliseStockRow({ Lot: '1', 'BED // BATH // CAR': value });
      expect(record?.bedrooms, `"${value}" must not set bedrooms`).toBeNull();
      expect(record?.bathrooms, `"${value}" must not set bathrooms`).toBeNull();
      expect(record?.car_spaces, `"${value}" must not set car spaces`).toBeNull();
    }
  });

  it('an unreadable cell stays VISIBLE as unplaced', () => {
    // The first version of the parser consumed the cell and wrote nothing
    // anywhere, so 32 live rows' counts vanished with no audit trail and the
    // failing shapes had to be recovered from the sheet itself. ("TBA" is
    // not this: `text()` reads it as not-stated before any parser runs.)
    const record = normaliseStockRow({ Lot: '1', 'BED // BATH // CAR': '3 / two / 2' });
    expect(record?.unmapped['BED // BATH // CAR']).toBe('3 / two / 2');
  });

  it('reads the doubled-slash typo the live sheet writes on 15 rows', () => {
    // "3 / 2/ / 2" — the heading's own // style leaking into a value. A
    // doubled slash contributes an EMPTY part, not a value, so it is
    // dropped before the exactly-three rule is applied.
    const record = normaliseStockRow({ Lot: '606', 'BED // BATH // CAR': '3 / 2/ / 2' });
    expect(record?.bedrooms).toBe(3);
    expect(record?.bathrooms).toBe(2);
    expect(record?.car_spaces).toBe(2);
  });

  it('sums a dual-occupancy cell per position, and never invents the missing one', () => {
    // Verbatim from the live sheet (11 rows): two dwellings, counts in the
    // heading's bed/bath/car order. Both lines state beds and baths; only
    // Nest 1 states a car — so the car count is UNSTATED for the package,
    // not zero, and the card omits it rather than guessing.
    const record = normaliseStockRow({
      Lot: '324', 'BED // BATH // CAR': 'Nest 1 = 3 + 2 + 1\nNest 2 = 1 + 1',
    });
    expect(record?.bedrooms).toBe(4);
    expect(record?.bathrooms).toBe(3);
    expect(record?.car_spaces).toBeNull();
  });

  it('sums the car spaces too once every dwelling states them', () => {
    const record = normaliseStockRow({
      Lot: '1', 'BED // BATH // CAR': 'Nest 1 = 3 + 2 + 2\nNest 2 = 1 + 1 + 1',
    });
    expect(record?.bedrooms).toBe(4);
    expect(record?.bathrooms).toBe(3);
    expect(record?.car_spaces).toBe(3);
  });

  it('refuses a dual-occupancy cell with an unreadable line, whole', () => {
    const record = normaliseStockRow({
      Lot: '1', 'BED // BATH // CAR': 'Nest 1 = 3 + 2 + 1\nNest 2 = one + 1',
    });
    expect(record?.bedrooms).toBeNull();
    expect(record?.bathrooms).toBeNull();
    expect(record?.car_spaces).toBeNull();
  });

  it('reads the Notion list\'s labelled Configuration column', () => {
    // Verbatim from the live Notion stock list: the heading is
    // "Configuration" and every count names itself.
    const record = normaliseStockRow({
      Property: 'Lot 12 Example St', Configuration: '4 Bed 2 Bath 2 Car',
    });
    expect(record?.bedrooms).toBe(4);
    expect(record?.bathrooms).toBe(2);
    expect(record?.car_spaces).toBe(2);
  });

  it('sums a labelled dual occupancy by label, cars included', () => {
    // Also verbatim: two dwellings joined by "+", every count labelled — so
    // unlike the positional Nest form, the car total IS stated and is
    // summed.
    const record = normaliseStockRow({
      Property: 'Lot 9 Example St',
      Configuration: '3 Bed 2 Bath 1 Car + 2 Bed 1 Bath 1 Car',
    });
    expect(record?.bedrooms).toBe(5);
    expect(record?.bathrooms).toBe(3);
    expect(record?.car_spaces).toBe(2);
  });

  it('a label the cell never uses stays null, and a street name is not a car', () => {
    const record = normaliseStockRow({
      Property: 'Lot 9 Example St', Configuration: '4 Bed 2 Bath',
    });
    expect(record?.bedrooms).toBe(4);
    expect(record?.bathrooms).toBe(2);
    expect(record?.car_spaces).toBeNull();
    // "2 Carrara" must not read as two car spaces: the label words are an
    // explicit list with a word boundary, not a prefix match.
    const street = normaliseStockRow({
      Property: 'Lot 9', Configuration: '2 Carrara',
    });
    expect(street?.car_spaces).toBeNull();
  });

  it('a dedicated column beats the combined one, whichever side it sits on', () => {
    const before = normaliseStockRow({ Lot: '1', Beds: '4', 'BED // BATH // CAR': '3 / 2 / 2' });
    expect(before?.bedrooms).toBe(4);
    expect(before?.bathrooms).toBe(2);
    const after = normaliseStockRow({ Lot: '1', 'BED // BATH // CAR': '3 / 2 / 2', Beds: '4' });
    expect(after?.bedrooms).toBe(4);
    expect(after?.bathrooms).toBe(2);
  });

  it('the versioned package price reaches the record as the price', () => {
    const record = normaliseStockRow({
      Lot: '927',
      'Package Price - V002': '$780,050',
      'Land Price': '$423,500',
      'Build Price - V002': '$356,550',
    });
    expect(record?.price).toBe(780050);
    // A bare figure needs no display string — see `coercePrice`.
    expect(record?.price_display).toBeNull();
    // The components stay in the audit record, visibly unplaced.
    expect(record?.unmapped['Land Price']).toBe('$423,500');
    expect(record?.unmapped['Build Price - V002']).toBe('$356,550');
  });
});

describe('coercion never invents', () => {
  it('keeps the wording of a price that is not a bare number', () => {
    expect(coercePrice('From $749,000')).toEqual({ price: 749000, display: 'From $749,000' });
    expect(coercePrice('$749,000')).toEqual({ price: 749000, display: null });
    expect(coercePrice('POA')).toEqual({ price: null, display: 'POA' });
  });

  it('reads a number out of a messy cell', () => {
    expect(coerceNumber('$1,250,000')).toBe(1250000);
    expect(coerceNumber('3.5')).toBe(3.5);
    expect(coerceNumber('2 + 1')).toBe(2);
    expect(coerceNumber('n/a')).toBeNull();
  });

  it('treats spreadsheet placeholders as silence, not as values', () => {
    const record = normaliseStockRow({ Address: '12 Wattle St', Suburb: 'N/A', Price: '-' });
    expect(record?.suburb).toBeNull();
    expect(record?.price).toBeNull();
  });

  it('defaults availability to unknown rather than to available', () => {
    expect(coerceAvailability('')).toBe('unknown');
    expect(coerceAvailability('Held pending finance')).toBe('on_hold');
    expect(coerceAvailability('SOLD')).toBe('sold');
    expect(coerceAvailability('Released')).toBe('available');
    // A word the table does not know must not become live inventory.
    expect(coerceAvailability('Stage 4 pending council')).toBe('unknown');
  });

  it('normalises states and refuses anything that is not one', () => {
    expect(coerceState('New South Wales')).toBe('NSW');
    expect(coerceState('qld')).toBe('QLD');
    expect(coerceState('Auckland')).toBeNull();
  });

  it('maps property types onto the stored vocabulary', () => {
    expect(coercePropertyType('House & Land Package')).toBe('house_and_land');
    expect(coercePropertyType('Townhome')).toBe('townhouse');
    expect(coercePropertyType('Vacant Land')).toBe('land');
    expect(coercePropertyType('Something else entirely')).toBe('other');
  });

  it('drops an area that is a unit error rather than storing it', () => {
    const record = normaliseStockRow({ Lot: '12', 'Land Size': '4000000' });
    expect(record?.land_size_sqm).toBeNull();
  });
});

describe('rows that are not properties', () => {
  it('drops a totals line', () => {
    expect(normaliseStockRow({ Notes: 'TOTAL', Price: '12,000,000' })).toBeNull();
  });

  it('drops a blank row', () => {
    expect(normaliseStockRow({ Lot: '', Address: '   ' })).toBeNull();
  });

  it('keeps a thin row that still names a property', () => {
    const record = normaliseStockRow({ Lot: '108', Estate: 'Riverbend' });
    expect(record).not.toBeNull();
    expect(identifiesAProperty(record!)).toBe(true);
  });
});

describe('duplicate matching is conservative', () => {
  it('uses the builder reference when there is one', () => {
    const record = normaliseStockRow({ 'Stock Ref': 'RB-108', Suburb: 'Riverbend' })!;
    expect(stockMatchKeys(record).reference).toBe('rb-108');
  });

  it('requires BOTH halves of development + unit', () => {
    const withUnit = normaliseStockRow({ Estate: 'Riverbend', Lot: '108' })!;
    // The design rides along and is empty where the row names none; the two
    // halves this is about are still both required.
    expect(stockMatchKeys(withUnit).developmentUnit)
      .toEqual({ development: 'riverbend', unit: '108', design: '' });

    const withoutUnit = normaliseStockRow({ Estate: 'Riverbend', Suburb: 'Tarneit' })!;
    expect(stockMatchKeys(withoutUnit).developmentUnit).toBeNull();
  });

  it('never matches on address alone — two townhouses share one', () => {
    const record = normaliseStockRow({ Address: '12 Wattle St', Suburb: 'Tarneit' })!;
    const keys = stockMatchKeys(record);
    expect(keys.reference).toBeNull();
    expect(keys.developmentUnit).toBeNull();
  });
});

describe('geocodable address', () => {
  it('refuses to hand a suburb alone to a location lookup', () => {
    expect(geocodableAddress({
      address_line: null, suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    })).toBeNull();
  });

  it('builds a full line when there is a street address', () => {
    expect(geocodableAddress({
      address_line: '12 Wattle St', suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    })).toBe('12 Wattle St, Tarneit, VIC, 3029, Australia');
  });
});

describe('delimited parsing', () => {
  it('honours RFC-4180 quoting', () => {
    const rows = parseDelimited('a,b\n"x, y","he said ""hi"""');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });

  it('sniffs a tab-separated export', () => {
    const rows = parseDelimited('Lot\tPrice\n108\t749000');
    expect(rows[1]).toEqual(['108', '749000']);
  });
});

describe('header row detection', () => {
  it('skips the title rows real stock lists open with', () => {
    const matrix = [
      ['ACME HOMES — STOCK LIST MARCH'],
      [],
      ['Lot', 'Address', 'Suburb', 'Beds', 'Price', 'Status'],
      ['108', '12 Wattle St', 'Tarneit', '4', '$749,000', 'Available'],
    ];
    const keyed = keyRowsByHeader(matrix);
    expect(keyed?.headerRowIndex).toBe(2);
    expect(keyed?.rows).toHaveLength(1);
    expect(keyed?.rows[0].Address).toBe('12 Wattle St');
  });

  it('returns null when nothing looks like a stock table', () => {
    expect(keyRowsByHeader([
      ['Dear Sir or Madam'],
      ['Please find attached our latest release.'],
    ])).toBeNull();
  });

  it('keys a full row end to end', () => {
    const keyed = keyRowsByHeader([
      ['Lot', 'Address', 'Suburb', 'State', 'Postcode', 'Beds', 'Bath', 'Car', 'Land Size (m2)', 'Price', 'Status'],
      ['108', '12 Wattle St', 'Tarneit', 'VIC', '3029', '4', '2', '2', '448', 'From $749,000', 'Available'],
    ])!;
    const record = normaliseStockRow(keyed.rows[0])!;
    expect(record.lot_number).toBe('108');
    expect(record.suburb).toBe('Tarneit');
    expect(record.state).toBe('VIC');
    expect(record.postcode).toBe('3029');
    expect(record.bedrooms).toBe(4);
    expect(record.land_size_sqm).toBe(448);
    expect(record.price).toBe(749000);
    expect(record.price_display).toBe('From $749,000');
    expect(record.availability_status).toBe('available');
  });
});

describe('file classification is not PDF-only', () => {
  it('routes each supported family to its reader', () => {
    expect(classifyStockFile('stock.csv', 'text/csv').kind).toBe('delimited');
    expect(classifyStockFile('stock.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').kind).toBe('spreadsheet');
    expect(classifyStockFile('stock.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document').kind).toBe('word');
    expect(classifyStockFile('stock.pdf', 'application/pdf').kind).toBe('pdf');
    expect(classifyStockFile('stock.jpg', 'image/jpeg').kind).toBe('image');
  });

  it('breaks the legacy Office tie with the extension', () => {
    expect(classifyStockFile('stock.xls', null, 'ambiguous_legacy_office_container').kind)
      .toBe('spreadsheet');
    expect(classifyStockFile('stock.doc', null, 'ambiguous_legacy_office_container').kind)
      .toBe('word');
  });

  it('falls back to the extension when the bytes say nothing', () => {
    expect(classifyStockFile('stock.tsv', null, 'unknown_content_signature').kind)
      .toBe('delimited');
  });

  it('refuses an executable and an unknown type', () => {
    expect(classifyStockFile('payload.exe', null, 'executable_signature').kind).toBe('unsupported');
    expect(classifyStockFile('archive.zip', null, 'unsupported_or_ambiguous_zip').kind)
      .toBe('unsupported');
  });

  it('offers the picker exactly what it can read', () => {
    const accept = stockFileAcceptAttribute();
    for (const extension of ['.csv', '.xlsx', '.xls', '.docx', '.doc', '.pdf', '.jpg', '.png']) {
      expect(accept).toContain(extension);
    }
  });
});

describe('storage paths are treated as hostile', () => {
  it('rejects traversal and anything outside the prefix', () => {
    expect(isAcceptableStockStoragePath('stock-lists/org/id/file.csv')).toBe(true);
    expect(isAcceptableStockStoragePath('stock-lists/../secrets')).toBe(false);
    expect(isAcceptableStockStoragePath('/stock-lists/file.csv')).toBe(false);
    expect(isAcceptableStockStoragePath('documents/file.csv')).toBe(false);
    expect(isAcceptableStockStoragePath(null)).toBe(false);
  });

  it('strips a filename down to something safe', () => {
    expect(safeObjectName('March Stock List (final)/../.xlsx')).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(safeObjectName('list.csv')).toBe('list.csv');
  });
});

describe('the geocoder is never handed the line whole', () => {
  it('drops the lot prefix and the floor area a Notion list writes', () => {
    /*
     * PRODUCTION, 10 SEPTEMBER 2026. This is the one property of nineteen
     * that answered "that address could not be located", and the question it
     * was asked was the whole line with `Lot 60913` still on the front and
     * `(178 m2)` still on the back.
     */
    expect(geocodableAddress({
      address_line: 'Lot 60913 Basalt St, Beveridge, VIC 3753 (178 m2)',
      suburb: null, state: 'VIC', postcode: null,
    })).toBe('Basalt Street, Beveridge, VIC, 3753, Australia');
  });

  it('keeps a supplied street number that opens the line', () => {
    /*
     * THE GUARD ON THE ABOVE. A bare leading number is ambiguous and the
     * parser resolves it as a LOT on measured evidence, because for a PIN
     * that is the safe direction. Composing from its parts here would turn a
     * supplied `12 Wattle St` into `Wattle Street` and throw away a rooftop
     * this function already had, so an unprefixed line is asked as supplied.
     */
    expect(geocodableAddress({
      address_line: '12 Wattle St', suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    })).toBe('12 Wattle St, Tarneit, VIC, 3029, Australia');
  });

  it('takes the suburb and postcode off the line when no column holds them', () => {
    expect(geocodableAddress({
      address_line: 'Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
      suburb: null, state: null, postcode: null,
    })).toBe('Tringa Street, Tweed Heads South, NSW, 2486, Australia');
  });

  it('lets a column the builder typed win over the line', () => {
    expect(geocodableAddress({
      address_line: 'Lot 60913 Basalt St, Beveridge, VIC 3753 (178 m2)',
      suburb: 'Wallan', state: 'VIC', postcode: '3756',
    })).toBe('Basalt Street, Wallan, VIC, 3756, Australia');
  });
});
