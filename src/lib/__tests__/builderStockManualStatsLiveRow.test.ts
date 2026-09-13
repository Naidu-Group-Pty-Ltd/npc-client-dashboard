import { describe, expect, it } from 'vitest';
import { applyManualStats } from '../../../supabase/functions/_shared/builderStock/manualStats.pure';
import { describeManualStats, type BuilderStockItem } from '@/lib/builderStock';

/**
 * THE REPORTED ROW ITSELF.
 *
 * Taken verbatim from `builder_stock_items` on the prime
 * (`ef35fbd9-4fcb-493e-b4ec-ae3f78acc34c`, `LOT 324 - NEX 20 - V002.pdf`) on
 * 13 September 2026, with the override a builder would type. A fixture
 * written in this module's own vocabulary passes while production is empty —
 * the rule `SAMPLE_REPORT_DATA` taught the report catalogue the hard way — so
 * this one is the shape the database actually returns.
 */
const LIVE_ROW = {
  id: 'ef35fbd9-4fcb-493e-b4ec-ae3f78acc34c',
  lot_number: '324',
  address_line: 'Lot 324 Dapple Avenue',
  development_name: 'Palomino Estate',
  suburb: 'Armstrong Creek', state: 'VIC', postcode: null,
  bedrooms: null, bathrooms: null, car_spaces: null,
  building_size_sqm: null, land_size_sqm: 350,
  price: 863850, price_display: '$863,850 *',
  property_type: 'house',
  manual_stats: {
    values: { bedrooms: 4, bathrooms: 3, car_spaces: 2, building_size_sqm: 174 },
    recorded_at: '2026-09-13T02:30:00Z', recorded_by: 'probe',
  },
};

describe('Lot 324, the property this was reported on', () => {
  it('drew four em dashes before, and the builder’s figures after', () => {
    const before = { ...LIVE_ROW, manual_stats: null };
    expect(describeManualStats(before as unknown as BuilderStockItem).missing)
      .toEqual(['bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm']);

    const after = applyManualStats(LIVE_ROW);
    expect(after.bedrooms).toBe(4);
    expect(after.bathrooms).toBe(3);
    expect(after.car_spaces).toBe(2);
    expect(after.building_size_sqm).toBe(174);
    // The one figure the brochure DID state is untouched.
    expect(after.land_size_sqm).toBe(350);
    expect(describeManualStats(after as unknown as BuilderStockItem).missing).toEqual([]);
  });

  it('records that the document said nothing, rather than pretending it agreed', () => {
    const after = applyManualStats(LIVE_ROW) as Record<string, unknown>;
    expect(after.stated_bedrooms).toBeNull();
    expect(after.stated_building_size_sqm).toBeNull();
  });
});
