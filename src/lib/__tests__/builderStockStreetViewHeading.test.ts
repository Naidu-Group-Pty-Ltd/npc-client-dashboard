/**
 * BUILDER STOCK — STREET VIEW MUST LOOK AT THE HOUSE.
 *
 * PRODUCTION, 28 AUGUST 2026. Lot 13 Hummock Rise, Werribee was served a
 * correct, exact-address Street View still — of the street. The request sent
 * `location`, `fov` and `pitch` and no `heading`, so Google returned the
 * panorama's own stored orientation: whichever way the capture vehicle was
 * pointing when it drove past.
 *
 * Both numbers needed to fix that were already paid for — the panorama's
 * location comes back on the metadata call, the property's on the geocode — so
 * the camera can be aimed with no extra request.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  headingToProperty, metresBetween, readLatLng, MIN_HEADING_DISTANCE_METRES,
} from '../../../supabase/functions/_shared/builderStock/streetViewHeading.pure';

/** The geocode production stored for Lot 13 Hummock Rise, Werribee VIC. */
const LOT_13 = { lat: -37.91418910000001, lng: 144.6702 };

describe('the heading points from the camera at the property', () => {
  it('looks north when the property is north of the panorama', () => {
    expect(headingToProperty({ lat: -37.9150, lng: 144.6702 },
      { lat: -37.9140, lng: 144.6702 })).toBe(0);
  });

  it('looks east when the property is east of the panorama', () => {
    expect(headingToProperty({ lat: -37.9142, lng: 144.6695 },
      { lat: -37.9142, lng: 144.6705 })).toBe(90);
  });

  it('looks south when the property is south of the panorama', () => {
    expect(headingToProperty({ lat: -37.9135, lng: 144.6702 },
      { lat: -37.9145, lng: 144.6702 })).toBe(180);
  });

  it('looks west when the property is west of the panorama', () => {
    expect(headingToProperty({ lat: -37.9142, lng: 144.6710 },
      { lat: -37.9142, lng: 144.6700 })).toBe(270);
  });

  it('is always a compass bearing, never negative', () => {
    for (const dLat of [-0.001, 0, 0.001]) {
      for (const dLng of [-0.001, 0, 0.001]) {
        if (!dLat && !dLng) continue;
        const heading = headingToProperty(
          { lat: LOT_13.lat + dLat, lng: LOT_13.lng + dLng }, LOT_13);
        expect(heading).not.toBeNull();
        expect(heading as number).toBeGreaterThanOrEqual(0);
        expect(heading as number).toBeLessThan(360);
      }
    }
  });

  it('aims at Lot 13 from a camera on the road south of it', () => {
    // The house is north of the panorama, so the camera must turn to face it
    // rather than keep the vehicle's own heading down the street.
    const heading = headingToProperty(
      { lat: LOT_13.lat - 0.0002, lng: LOT_13.lng }, LOT_13);
    expect(heading).toBe(0);
  });
});

describe('it refuses rather than inventing a direction', () => {
  it('sends no heading when the panorama location is missing', () => {
    expect(headingToProperty(null, LOT_13)).toBeNull();
    expect(headingToProperty(readLatLng(undefined), LOT_13)).toBeNull();
    expect(headingToProperty(readLatLng({}), LOT_13)).toBeNull();
  });

  it('sends no heading when the camera is on top of the property', () => {
    // No meaningful bearing exists, and Google's own orientation is at least
    // a real orientation of a real panorama.
    expect(headingToProperty(LOT_13, LOT_13)).toBeNull();
    expect(metresBetween(LOT_13, LOT_13)).toBeLessThan(MIN_HEADING_DISTANCE_METRES);
  });

  it('rejects non-finite and out-of-range coordinates', () => {
    expect(readLatLng({ lat: 'x', lng: 1 })).toBeNull();
    expect(readLatLng({ lat: NaN, lng: 1 })).toBeNull();
    expect(readLatLng({ lat: 91, lng: 1 })).toBeNull();
    expect(readLatLng({ lat: -37.9, lng: 181 })).toBeNull();
    expect(readLatLng({ lat: -37.9142, lng: 144.6702 }))
      .toEqual({ lat: -37.9142, lng: 144.6702 });
  });

  it('measures a real street-width separation as usable', () => {
    const across = metresBetween(LOT_13, { lat: LOT_13.lat - 0.0002, lng: LOT_13.lng });
    expect(across).toBeGreaterThan(MIN_HEADING_DISTANCE_METRES);
    expect(across).toBeLessThan(60);
  });
});

describe('the stage sends the heading it calculated', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', '..',
      'supabase/functions/_shared/builderStock/images.ts'), 'utf8');

  it('asks for a heading toward the geocoded property', () => {
    expect(source).toContain('headingToProperty(');
    expect(source).toContain("params.set('heading'");
  });

  it('reads the panorama location from the metadata already fetched', () => {
    expect(source).toContain('readLatLng(meta?.location)');
  });

  it('omits the parameter entirely when no bearing could be found', () => {
    expect(source).toContain('if (heading !== null)');
  });

  it('leaves fov, pitch and the satellite rule alone', () => {
    expect(source).toContain("fov: '80', pitch: '0'");
    // A tile is a roof; only `streetview` may become a card.
    expect(source).toContain('staticmap');
  });
});
