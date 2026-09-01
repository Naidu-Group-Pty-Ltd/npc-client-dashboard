/**
 * Audit item 16 — "93 Bimbadeen Avenue" appeared five times in the cash-flow
 * comparison picker while every other address appeared once.
 *
 * The reporter's reading was that the list captures every report kind rather
 * than the Compass one, and the rows bear it out exactly: that address has one
 * completed report of each variant — snapshot, briefing, strategic, financial,
 * compass.
 *
 * Filtering by variant fixes neither half. Measured over `investment_reports`
 * on 2026-08-31:
 *
 *   listed by the picker today        1,169
 *   …carrying financial_calculations    185
 *   …distinct properties among those     98
 *   compass reports, completed        1,106  (963 carry NO figures)
 *   compass reports, 10 Chester St       20
 *
 * So a variant filter would still show one address twenty times, and would
 * drop the single property whose only report with figures is not a Compass.
 */
import { describe, expect, it } from 'vitest';

import {
  comparisonCandidates,
  dedupeByProperty,
  hasComparableFigures,
  propertyKey,
} from '../comparisonCandidates.pure';

const report = (
  id: string,
  address: string | null,
  financial_calculations: unknown = { annualCashFlow: -1000 },
) => ({ id, property_address: address, financial_calculations });

describe('a comparison needs figures', () => {
  it.each([
    ['an object with keys', { annualCashFlow: -1000 }, true],
    ['an empty object', {}, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a string', 'not figures', false],
    ['an empty array', [], false],
  ])('%s → %s', (_label, figures, expected) => {
    // Built inline rather than through the helper: passing `undefined` to a
    // parameter with a default gets the default, which would quietly test the
    // wrong thing.
    expect(hasComparableFigures({
      id: 'a',
      property_address: '1 Test St',
      financial_calculations: figures,
    })).toBe(expected);
  });

  it('treats an absent key the same as an undefined one', () => {
    expect(hasComparableFigures({ id: 'a', property_address: '1 Test St' })).toBe(false);
  });

  it('drops the 984 entries that cannot be compared against', () => {
    // The row looks identical to a usable one, and choosing it compares
    // against nothing: `financial_calculations || {}` at the two consuming
    // call sites is exactly how that stayed invisible.
    const fetched = [
      report('compass-with', '10 Chester Street'),
      report('compass-without', '99 Empty Road', {}),
      report('never-generated', '98 Null Road', null),
    ];
    expect(comparisonCandidates(fetched).map((r) => r.id)).toEqual(['compass-with']);
  });
});

describe('it is a property picker, not a report picker', () => {
  it('shows 93 Bimbadeen Avenue once, not five times', () => {
    const address = '93 Bimbadeen Avenue, Banora Point NSW 2486';
    const fetched = [
      report('snapshot', address),
      report('briefing', address),
      report('strategic', address),
      report('financial', address),
      report('compass', address),
      report('other', '28 Bligh Street, Muswellbrook NSW 2333'),
    ];
    const offered = comparisonCandidates(fetched);
    expect(offered).toHaveLength(2);
    expect(offered.map((r) => r.property_address)).toEqual([
      address,
      '28 Bligh Street, Muswellbrook NSW 2333',
    ]);
  });

  it('keeps the newest, because the caller fetches newest first', () => {
    // Ordering is `created_at` descending in the query, and dedupe preserves
    // input order — so "most recent" is a property of the fetch rather than a
    // second sort here.
    const fetched = [
      report('newest', '10 Chester Street'),
      report('older', '10 Chester Street'),
      report('oldest', '10 Chester Street'),
    ];
    expect(comparisonCandidates(fetched).map((r) => r.id)).toEqual(['newest']);
  });

  it('treats spacing and case as the same property', () => {
    expect(propertyKey('  10  Chester   Street ')).toBe(propertyKey('10 Chester Street'));
    expect(propertyKey('10 CHESTER STREET')).toBe(propertyKey('10 chester street'));
    const fetched = [report('a', '10 Chester Street'), report('b', '10 CHESTER  STREET')];
    expect(dedupeByProperty(fetched)).toHaveLength(1);
  });

  it('offers no row it could not label', () => {
    // An address-less report draws a blank entry and cannot be grouped.
    expect(dedupeByProperty([report('a', null), report('b', '  ')])).toHaveLength(0);
  });
});

describe('what it must not do', () => {
  it('never filters on report variant', () => {
    // 98 distinct properties have figures; only 97 of them via a Compass
    // report. Filtering on the variant loses one property that has perfectly
    // good numbers, and leaves the twenty-rows-per-address case untouched.
    const fetched = [
      report('snapshot-only', '5 Whistlesong Court', { annualCashFlow: 1 }),
    ];
    expect(comparisonCandidates(fetched).map((r) => r.id)).toEqual(['snapshot-only']);
  });

  it('excludes the report already open, and only that one', () => {
    const fetched = [report('open', '1 A St'), report('other', '2 B St')];
    expect(comparisonCandidates(fetched, 'open').map((r) => r.id)).toEqual(['other']);
    expect(comparisonCandidates(fetched, null)).toHaveLength(2);
  });

  it('never mutates what it was given', () => {
    const fetched = [report('b', '2 B St'), report('a', '1 A St')];
    const before = fetched.map((r) => r.id);
    comparisonCandidates(fetched);
    expect(fetched.map((r) => r.id)).toEqual(before);
  });
});
