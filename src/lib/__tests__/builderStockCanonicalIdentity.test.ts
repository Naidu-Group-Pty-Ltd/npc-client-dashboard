/**
 * BUILDER STOCK — A PROPERTY THE LADDER CANNOT NAME IS A PROPERTY IT CANNOT
 * PHOTOGRAPH.
 *
 * PRODUCTION, 30 AUGUST 2026. A 119-property stock list imported cleanly, the
 * cutover published it, the scheduler ran, every property was claimed, and
 * every property advanced through source, eligibility, sanitization and
 * fallback. Not one image was produced. The state machine turned perfectly and
 * delivered nothing.
 *
 *     lot_number        89 of 89
 *     development_name  89 of 89
 *     land_size_sqm     89 of 89
 *     address_line       3 of 89   <-
 *     suburb             3 of 89   <-
 *
 * `geocodableAddress` refused without an `address_line`, so stage 3 had
 * nothing to geocode and stage 2 nothing to identify. The properties reached
 * the bottom of the ladder and found it had no rungs.
 *
 * THE DEFECT IS NOT THE SOURCE. An address was only ever TAKEN from a column,
 * never COMPOSED — and a great many stock lists do not have such a column:
 * they carry the lot in one, the estate in another and the suburb in a third,
 * which is the ordinary shape of a builder's spreadsheet. A Notion database
 * happened to carry its title as a full address line, so the gap never showed.
 *
 * Invented estates, lots and headings throughout.
 */
import { describe, expect, it } from 'vitest';

import { composeAddressLine } from '../../../supabase/functions/_shared/builderStock/canonicalIdentity.pure';
import { repairStoredIdentity } from '../../../supabase/functions/_shared/builderStock/storedIdentityRepair.pure';
import {
  fieldForHeader, geocodableAddress, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const bare = {
  address_line: null, suburb: null, state: null, postcode: null,
  lot_number: null, unit_number: null, development_name: null, project_name: null,
};

describe('the split-column shape every spreadsheet has', () => {
  it('composes a findable line from a lot and a named estate', () => {
    expect(composeAddressLine({ ...bare, lot_number: '605', development_name: 'Sample Rise' }))
      .toEqual({ line: 'Lot 605 Sample Rise', parts: ['lot_number', 'development_name'] });
  });

  it('does not repeat a prefix the builder already wrote', () => {
    expect(composeAddressLine({ ...bare, lot_number: 'Lot 605', development_name: 'Sample Rise' })
      ?.line).toBe('Lot 605 Sample Rise');
  });

  it('a unit qualifies the place where there is one', () => {
    expect(composeAddressLine({ ...bare, unit_number: '4', development_name: 'Sample Rise' })
      ?.line).toBe('Unit 4 Sample Rise');
  });

  it('a project stands in for an estate', () => {
    expect(composeAddressLine({ ...bare, lot_number: '7', project_name: 'Stage 12' })
      ?.line).toBe('Lot 7 Stage 12');
  });

  it('NEVER overwrites what the builder actually wrote', () => {
    expect(composeAddressLine({
      ...bare, address_line: '12 Wattle St', lot_number: '605', development_name: 'Sample Rise',
    })).toBeNull();
  });
});

describe('what it refuses to compose', () => {
  it('a bare lot number names nothing a geocoder can find', () => {
    expect(composeAddressLine({ ...bare, lot_number: '605' })).toBeNull();
  });

  it('a suburb is not a place to compose FROM — it is the next part of the line', () => {
    /*
     * The guard `geocodableAddress` has always had: a lookup handed nothing
     * but a suburb returns a picture of somewhere else in it. Composing the
     * suburb as the "place" and then joining the suburb to it would be
     * circular, and would quietly delete that guard.
     */
    expect(composeAddressLine({ ...bare, suburb: 'Tarneit' })).toBeNull();
    expect(geocodableAddress({
      address_line: null, suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    })).toBeNull();
  });

  it('an empty record composes nothing', () => {
    expect(composeAddressLine(bare)).toBeNull();
  });
});

describe('the ladder can name the property now, and only there', () => {
  const split = {
    address_line: null, suburb: 'Northfield', state: null, postcode: null,
    lot_number: '605', unit_number: null,
    development_name: 'Sample Rise', project_name: null,
  };

  it('geocodes a split-column property that used to be unreachable', () => {
    expect(geocodableAddress(split)).toBe('Lot 605 Sample Rise, Northfield, Australia');
  });

  it('a supplied address is used exactly as supplied', () => {
    expect(geocodableAddress({ ...split, address_line: '12 Wattle St' }))
      .toBe('12 Wattle St, Northfield, Australia');
  });

  it('still refuses a place with nothing beside it', () => {
    // One part is a place, and a picture of a place is not a picture of a
    // property. Two parts remains the floor.
    expect(geocodableAddress({ ...split, suburb: null })).toBeNull();
  });

  it('the composition is confined to geocoding and touches nothing else', () => {
    /*
     * THE HAZARD THIS AVOIDS. Composing into `address_line` at normalisation
     * leaked a synthesised string into `stockRecordLabel`, which is the text a
     * package document is searched for — and a real test caught it, the cover
     * match failing on a package that had matched before. Property identity,
     * duplicate matching and document search all read `address_line`, so it
     * stays exactly what the source gave.
     */
    const row = normaliseStockRow({
      'Lot #': '605',
      Estate: 'Sample Rise',
      Location: 'Northfield',
    });
    expect(row).not.toBeNull();
    expect(row!.address_line).toBeNull();
    expect(row!.lot_number).toBe('605');
    expect(row!.development_name).toBe('Sample Rise');
    // And the ladder can still name it.
    expect(geocodableAddress(row!)).toBe('Lot 605 Sample Rise, Northfield, Australia');
  });
});

describe('the alias gap that emptied the locality', () => {
  it('`location` is a suburb heading, and was not one', () => {
    // 86 of 89 properties carried no locality at all because of this one
    // missing alias, which starves the whole fallback ladder.
    expect(fieldForHeader('Location')).toBe('suburb');
    expect(fieldForHeader('Area')).toBe('suburb');
    // The headings it already knew still map.
    expect(fieldForHeader('Suburb')).toBe('suburb');
    expect(fieldForHeader('Town')).toBe('suburb');
  });

  it('a heading it does not know still lands in unmapped rather than guessing', () => {
    expect(fieldForHeader('Finance Clause Available')).toBeNull();
  });
});

describe('a property stored before the mapping improved still recovers', () => {
  /** What the import persisted: the columns it could place, and those it could not. */
  const storedRow = {
    address_line: null, suburb: null, development_name: 'Sample Rise',
    unmapped: { 'Location': 'Northfield', 'Finance Clause': 'Yes', 'Deposit': '1000' },
  };

  it('fills a field the CURRENT alias table can map', () => {
    const { patch, recovered } = repairStoredIdentity(
      { ...bare, lot_number: '605', development_name: 'Sample Rise' }, storedRow);
    expect(patch.suburb).toBe('Northfield');
    expect(recovered).toContain('suburb');
  });

  it('synthesises nothing — every value came out of a column', () => {
    const { patch } = repairStoredIdentity({ ...bare }, storedRow);
    for (const value of Object.values(patch)) {
      expect(Object.values(storedRow.unmapped)).toContain(value);
    }
  });

  it('never writes over what the import already resolved', () => {
    const { patch, recovered } = repairStoredIdentity(
      { ...bare, suburb: 'Somewhere Else' }, storedRow);
    expect(patch.suburb).toBeUndefined();
    expect(recovered).not.toContain('suburb');
  });

  it('a heading it still cannot place is left alone', () => {
    const { patch } = repairStoredIdentity({ ...bare }, storedRow);
    expect(Object.values(patch)).not.toContain('Yes');
    expect(Object.values(patch)).not.toContain('1000');
  });

  it('nothing stored, nothing recovered — and no crash', () => {
    expect(repairStoredIdentity({ ...bare }, null)).toEqual({ patch: {}, recovered: [] });
    expect(repairStoredIdentity({ ...bare }, { unmapped: 'not an object' } as never))
      .toEqual({ patch: {}, recovered: [] });
  });

  it('and then the ladder can name it', () => {
    const item = { ...bare, lot_number: '605', development_name: 'Sample Rise' };
    const { patch } = repairStoredIdentity(item, storedRow);
    expect(geocodableAddress({ ...item, ...patch }))
      .toBe('Lot 605 Sample Rise, Northfield, Australia');
  });
});

describe('it runs inside the claim, for every source, and never fails a stage', () => {
  const machine = () => readSource(
    'supabase/functions/_shared/builderStock/settleItemImages.ts');

  it('every claimed property is repaired before its stage runs', () => {
    const body = machine();
    expect(body).toContain('await ensureCanonicalIdentity(db, item.id);');
    expect(body.indexOf('await ensureCanonicalIdentity(db, item.id);'))
      .toBeLessThan(body.indexOf("if (stage === 'source')"));
  });

  it('it is best effort — nothing it cannot do stops the ladder', () => {
    const body = machine();
    expect(body).toContain("if (typeof db?.from !== 'function') return;");
    expect(body).toContain('canonical identity could not be repaired');
    expect(body).toContain('canonical identity could not be written');
  });

  it('the stage machine still imports no module that decides what a picture IS', () => {
    // The repair is an identity module, not an image one — which is why it is
    // its own file rather than reaching into the normaliser from here.
    const body = machine();
    for (const decision of [
      'drivePackage', 'streetViewHeading', 'imagePriority', 'webImageIdentity',
      'sanitizeImage', 'normalise.pure',
    ]) {
      expect(body).not.toContain(decision);
    }
  });

  it('nothing in any of it names a source, a builder or a spreadsheet', () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const relative of [
      'supabase/functions/_shared/builderStock/canonicalIdentity.pure.ts',
      'supabase/functions/_shared/builderStock/storedIdentityRepair.pure.ts',
    ]) {
      const code = strip(readSource(relative));
      for (const forbidden of [
        'google', 'notion', 'sheets', 'csv', 'xlsx', 'gid', 'spreadsheet',
      ]) {
        expect(code.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

function readSource(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
