/**
 * Builder stock — the house's area is written as many ways as the land's.
 *
 * MEASURED 11 SEPTEMBER 2026 over twenty header spellings a real builder's
 * spreadsheet uses: all eleven LAND spellings mapped, and TEN OF TWENTY build
 * spellings did not. The plainest one is the one that bit — `Build (sqm)`
 * normalises to `buildsqm`, and while `land sqm` was listed, `build sqm`
 * never was. A sheet with `Land (sqm)` beside `Build (sqm)` therefore
 * imported the land and silently dropped the house into `unmapped`, where
 * nothing reads it.
 *
 * In production: 244 of 1,007 properties carry a land size and no building
 * size — 24% — and `building_size_sqm` is what the card prints as
 * "180 m² home", so those cards lost a line and nobody was told.
 *
 * THE UNIT IS THE TRAP, and it is why this is a cross-product rather than a
 * list of examples. `normaliseHeader` strips punctuation but keeps letters,
 * so one unit is three distinct keys:
 *
 *     "m²"   → "m"      "m2"  → "m2"      "sq m" → "sqm"
 *
 * Every base word needs every unit spelled out. A test that checked a handful
 * of spellings is exactly what let ten of them through, so this one generates
 * the whole grid and holds LAND and BUILD to the same standard.
 */
import { describe, expect, it } from 'vitest';

import {
  normaliseHeader, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

/** How a spreadsheet writes an area unit, and what the normaliser makes of it. */
const UNITS = ['', ' (sqm)', ' sqm', ' sq m', ' m2', ' (m2)', ' m²', ' (m²)'];

/** The words a builder's sheet uses for each of the two areas. */
const LAND_WORDS = ['Land', 'Land Size', 'Land Area', 'Block Size', 'Lot Size'];
const BUILD_WORDS = [
  'Build', 'Build Size', 'Build Area',
  'Building', 'Building Size', 'Building Area',
  'House', 'House Size', 'House Area',
  'Home', 'Home Size', 'Home Area',
  'Floor Area', 'Internal Area', 'Living Area',
];

const mapsTo = (field: 'land_size_sqm' | 'building_size_sqm', header: string): boolean => {
  const record = normaliseStockRow({
    Lot: '27', Suburb: 'Mernda', [header]: '180',
  } as never);
  return !!record && (record as Record<string, unknown>)[field] === 180;
};

/**
 * Bare words this table deliberately does not read as an area, each for a
 * reason the module records:
 *
 *   Build     `BUILD` beside `LAND` on a stock list is the build PRICE —
 *             "Build Price" sits on 684 live rows.
 *   House     aliased to `house_design`, deliberately and with its own test:
 *             a sheet names the design in a column called plainly `HOUSE`,
 *             beside `HOUSE m2` and `HOUSE $`.
 *   Building  /  Home   no measured sheet uses either alone for an area, and
 *             guessing is what wrote a $428,000 land price into 26 properties'
 *             land SIZE.
 *
 * Only the BARE word is excluded. Every one of them with a unit attached must
 * still map, and the grid below checks that.
 */
const DELIBERATELY_UNMAPPED = new Set(['Build', 'Building', 'House', 'Home']);

describe('the unit really is three different keys', () => {
  it('m², m2 and sq m do not normalise alike', () => {
    expect(normaliseHeader('Build Size m²')).toBe('buildsizem');
    expect(normaliseHeader('Build Size m2')).toBe('buildsizem2');
    expect(normaliseHeader('Build Size sq m')).toBe('buildsizesqm');
    // Which is why a list of base words is not enough on its own.
    expect(new Set([
      normaliseHeader('Build Size m²'),
      normaliseHeader('Build Size m2'),
      normaliseHeader('Build Size sq m'),
    ]).size).toBe(3);
  });

  it('and the header that started this maps now', () => {
    expect(normaliseHeader('Build (sqm)')).toBe('buildsqm');
    expect(mapsTo('building_size_sqm', 'Build (sqm)')).toBe(true);
  });
});

describe('every land spelling maps', () => {
  for (const word of LAND_WORDS) {
    for (const unit of UNITS) {
      const header = `${word}${unit}`;
      it(`"${header}"`, () => {
        expect(mapsTo('land_size_sqm', header)).toBe(true);
      });
    }
  }
});

describe('every build spelling maps, to the SAME standard', () => {
  /*
   * The cross-product, not a sample. Ten of twenty hand-picked spellings were
   * missing when this was checked by example; generating the grid is what
   * makes "we support the obvious ones" a fact rather than a belief.
   */
  for (const word of BUILD_WORDS) {
    for (const unit of UNITS) {
      const header = `${word}${unit}`;
      it(`"${header}"`, () => {
        expect(mapsTo('building_size_sqm', header))
          .toBe(!DELIBERATELY_UNMAPPED.has(header));
      });
    }
  }
});

describe('a sheet that states both keeps both', () => {
  it('imports the land AND the house, which is what was lost', () => {
    const record = normaliseStockRow({
      Lot: '27', Address: 'Cockrell Rd', Suburb: 'Mernda', State: 'VIC',
      Price: '699000', 'Land (sqm)': '143', 'Build (sqm)': '180',
      'House Design': 'Zimi', Estate: 'Havenwood',
    } as never);
    expect(record?.land_size_sqm).toBe(143);
    expect(record?.building_size_sqm).toBe(180);
    // And nothing about it is left sitting in `unmapped`.
    expect(Object.keys(record?.unmapped ?? {})).not.toContain('Build (sqm)');
  });
});

describe('what this must NOT start claiming', () => {
  it('leaves a bare "Living" alone', () => {
    /*
     * 39 live rows carry it. It means a living-area size on some sheets and a
     * room count on others, and the `HOUSE $` collapse recorded in this
     * module's own header is what this table costs when it guesses.
     */
    const record = normaliseStockRow({ Lot: '27', Suburb: 'Mernda', Living: '180' } as never);
    expect(record?.building_size_sqm).toBeNull();
    expect(Object.keys(record?.unmapped ?? {})).toContain('Living');
  });

  it('still never reads a PRICE column as an area', () => {
    // The measured disaster this table already survived once: 26 properties
    // published a 428,000 m² block because `LAND $` collapsed onto `land`.
    const record = normaliseStockRow({
      Lot: '27', Suburb: 'Mernda', 'LAND $': '428000', 'HOUSE $': '362000',
    } as never);
    expect(record?.land_size_sqm).toBeNull();
    expect(record?.building_size_sqm).toBeNull();
  });
});
