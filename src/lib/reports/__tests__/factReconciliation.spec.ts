/**
 * Pins the fact reconciliation rule: a fact is contradicted only when the
 * recorded value NEVER appears in the prose in that fact's vocabulary and a
 * different value appears repeatedly. Comparative prose about other
 * properties must never trip it — a disclosure surface earns trust by what
 * it does not cry wolf about.
 */
import { describe, expect, it } from 'vitest';

import {
  factFindingToFlag,
  reconcileFacts,
} from '../../../../supabase/functions/_shared/reports/investment/factReconciliation.pure';

describe('counted facts (bedrooms, bathrooms, car spaces)', () => {
  it('flags a count the prose repeats against a record it never states', () => {
    const text = 'This 4-bedroom residence offers generous living. The 4 bedroom layout suits families.';
    const findings = reconcileFacts(text, { bedrooms: 3 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fact: 'bedrooms', expected: 3, found: 4, occurrences: 2 });
    expect(findings[0].snippet).toContain('4-bedroom');
  });

  it('comparative prose beside the correct count is not a contradiction', () => {
    const text = 'This 3 bedroom home competes with 4-bedroom stock nearby; 4-bedroom sales set the ceiling.';
    expect(reconcileFacts(text, { bedrooms: 3 })).toHaveLength(0);
  });

  it('a single divergent mention is not a finding', () => {
    const text = 'Demand for 4-bedroom homes is strong in the area.';
    expect(reconcileFacts(text, { bedrooms: 3 })).toHaveLength(0);
  });

  it('word-form numbers are outside the vocabulary and never judged', () => {
    const text = 'This four-bedroom residence is exceptional. A four bedroom plan.';
    expect(reconcileFacts(text, { bedrooms: 3 })).toHaveLength(0);
  });

  it('bathrooms and car spaces use the same rule', () => {
    const text = 'Featuring 3 bathrooms and a double garage. All 3 bathrooms are renovated. 2 car spaces plus 2 car spaces on title.';
    const findings = reconcileFacts(text, { bathrooms: 2, carSpaces: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fact: 'bathrooms', expected: 2, found: 3 });
  });
});

describe('weekly rent', () => {
  it('flags a repeated rent the record never supports', () => {
    const text = 'Expected rent of $780 per week. At $780/week the yield is strong.';
    const findings = reconcileFacts(text, { weeklyRent: 739 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fact: 'weeklyRent', expected: 739, found: 780 });
  });

  it('a mention within 5% matches the record', () => {
    const text = 'Currently achieving $745 per week; comparable homes ask $780 per week and $780 per week again.';
    expect(reconcileFacts(text, { weeklyRent: 739 })).toHaveLength(0);
  });
});

describe('purchase price (context-anchored)', () => {
  it('flags a repeated context-anchored price that contradicts the record', () => {
    const text = [
      'The purchase price of $1,250,000 positions this asset well.',
      'At an asking price of $1,250,000 the entry point is competitive.',
    ].join(' ');
    const findings = reconcileFacts(text, { purchasePrice: 1_190_000 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fact: 'purchasePrice', expected: 1_190_000, found: 1_250_000 });
  });

  it('a million-suffixed mention of the recorded price matches', () => {
    const text = 'Purchase price of $1.19 million. Listed price around $1.19 million.';
    expect(reconcileFacts(text, { purchasePrice: 1_190_000 })).toHaveLength(0);
  });

  it('deposit and duty figures near the price context cannot outvote the stated price', () => {
    const text = 'The purchase price of $1,190,000 requires a deposit of $238,000; stamp duty on the purchase is $47,737.';
    expect(reconcileFacts(text, { purchasePrice: 1_190_000 })).toHaveLength(0);
  });

  it('money with no price context is never judged', () => {
    const text = 'Median house values reached $1,300,000 this year. Nearby sales hit $1,300,000.';
    expect(reconcileFacts(text, { purchasePrice: 1_190_000 })).toHaveLength(0);
  });
});

describe('land size (context-anchored)', () => {
  it('flags a repeated land size that contradicts the record', () => {
    const text = 'Set on a 702 sqm block. The 702 sqm land parcel allows future expansion.';
    const findings = reconcileFacts(text, { landSizeSqm: 650 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fact: 'landSizeSqm', expected: 650, found: 702 });
  });

  it('building areas in sqm are not land mentions', () => {
    const text = 'Offering 180 sqm of internal living and 180 sqm under roof.';
    expect(reconcileFacts(text, { landSizeSqm: 650 })).toHaveLength(0);
  });
});

describe('edges', () => {
  it('empty prose and absent facts produce nothing', () => {
    expect(reconcileFacts('', { bedrooms: 3 })).toHaveLength(0);
    expect(reconcileFacts('A 4 bedroom home. A 4 bedroom home.', {})).toHaveLength(0);
  });

  it('a finding converts to the validation_flags vocabulary', () => {
    const [finding] = reconcileFacts('A 4-bedroom home. The 4 bedroom plan.', { bedrooms: 3 });
    const flag = factFindingToFlag(finding);
    expect(flag.type).toBe('fact');
    expect(flag.severity).toBe('warning');
    expect(flag.field).toBe('bedrooms');
    expect(flag.message).toContain('bedroom count');
    expect(flag.message).toContain('4');
    expect(flag.message).toContain('3');
    expect(flag.value.snippet).toBeTruthy();
  });
});
