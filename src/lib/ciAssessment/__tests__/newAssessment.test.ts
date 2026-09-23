/**
 * What "New assessment" creates.
 *
 * It used to create an "Untitled assessment" on the click and ask the
 * questions afterwards, which is where the list of untitled drafts came from.
 * These pin what it creates now that it asks first: a named record, filed under
 * the right segment, filled from the register property it concerns.
 */

import { describe, expect, it } from 'vitest';
import { defaultTitle, planNewAssessment, segmentFor } from '../newAssessment';
import { buildCommercialPrefill, commercialOption, linkFor, registerLinkOf } from '../registerProperty';
import type { CommercialProperty } from '@/hooks/useCommercialProperties';

const PROPERTY = {
  id: '6b0f4c1e-9a55-4e3c-9c1b-2f6f1d2b7a10', user_id: 'u1', address: '45 Industrial Drive', suburb: 'Wetherill Park',
  state: 'NSW', postcode: '2164', asset_class: 'industrial', tenure: 'freehold', gst_treatment: 'going_concern',
  purchase_price: 6_100_000, nla_sqm: 4_200, site_area_sqm: 8_000, outgoings_recoverable: {}, industrial_specs: {},
  created_at: '', updated_at: '',
} as unknown as CommercialProperty;

describe('the segment an assessment is filed under', () => {
  it('follows a type that names one', () => {
    expect(segmentFor('industrial_investment', 'commercial', false)).toBe('industrial');
    expect(segmentFor('owner_occupied_commercial', 'industrial', true)).toBe('commercial');
  });

  it('takes the choice, then the building, for a type that fits either', () => {
    expect(segmentFor('refinance', 'industrial', false)).toBe('industrial');
    expect(segmentFor('refinance', null, true)).toBe('industrial');
    expect(segmentFor('refinance', null, null)).toBe('commercial');
  });
});

describe('the record it creates', () => {
  it('keeps the name the operator typed', () => {
    const plan = planNewAssessment({ title: '  45 Industrial Drive — acquisition ', assessmentType: 'industrial_investment', segmentChoice: null });
    expect(plan.title).toBe('45 Industrial Drive — acquisition');
    expect(plan.segment).toBe('industrial');
    expect(plan.payload.property.classification).toBe('industrial');
  });

  it('names itself after the building when nobody names it', () => {
    expect(defaultTitle('refinance', '45 Industrial Drive')).toBe('45 Industrial Drive — refinance');
    expect(defaultTitle('commercial_investment', null)).toBe('Untitled assessment');
  });

  it('files a refinance of an industrial building as industrial, down to its classification', () => {
    const option = commercialOption(PROPERTY);
    const plan = planNewAssessment({
      title: '',
      assessmentType: 'refinance',
      segmentChoice: null,
      property: { prefill: buildCommercialPrefill(PROPERTY), link: linkFor(option), industrial: option.industrial },
    });
    expect(plan.segment).toBe('industrial');
    expect(plan.payload.property.classification).toBe('industrial');
    expect(plan.payload.property.address).toBe('45 Industrial Drive');
    expect(plan.payload.property.purchasePrice).toBe(6_100_000);
    expect(registerLinkOf(plan.payload)?.propertyId).toBe(PROPERTY.id);
    expect(plan.applied.length).toBeGreaterThan(0);
    expect(plan.title).toBe('45 Industrial Drive — refinance');
  });
});
