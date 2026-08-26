/**
 * Builder stock — a phase that cannot run is a phase whose work never finishes.
 *
 * Both failures these pin happened in production within an hour of each other.
 *
 * ALL THREE PHASES IN ONE TICK exceeded the edge worker's CPU allowance and
 * returned 546 with nothing written — a Drive listing, a multi-megabyte PDF
 * download, a text and raster extraction, THEN the eligibility sweep, THEN
 * full-resolution overlay repairs. Every tick did the same work and died the
 * same way, so a reopened queue of 26 packages made no progress at all.
 *
 * STRICT PRIORITY, the first fix, starved everything behind the first phase
 * with work. Provenance is one upload of seventy rows settled four at a time,
 * so it held every tick — and discovered twenty-six builder primaries that
 * could not be DRAWN, because the eligibility sweep that judges a newly stored
 * picture never got a tick. "Images found, none displayed" is the same blank
 * card by another route.
 */
import { describe, expect, it } from 'vitest';

import {
  SETTLEMENT_PHASES, choosePhase,
} from '../../../supabase/functions/_shared/builderStock/settlementPhase.pure';

const PERIOD = 5 * 60 * 1000;
/** The phases a run of consecutive ticks actually does. */
const overTicks = (candidates: Parameters<typeof choosePhase>[0], ticks: number) =>
  Array.from({ length: ticks }, (_, i) => choosePhase(candidates, i * PERIOD, PERIOD));

describe('one phase per tick', () => {
  it('never asks a tick to do more than one', () => {
    const all = [{ needsProvenance: true, needsEligibility: true, needsSanitization: true }];
    for (const phase of overTicks(all, 12)) {
      expect(SETTLEMENT_PHASES).toContain(phase);
    }
  });
});

describe('and no phase can starve', () => {
  it('gives every outstanding phase a turn', () => {
    const all = [{ needsProvenance: true, needsEligibility: true, needsSanitization: true }];
    const seen = new Set(overTicks(all, 9));
    expect([...seen].sort()).toEqual([...SETTLEMENT_PHASES].sort());
  });

  it('reaches eligibility even while provenance still has work', () => {
    /*
     * THE EXACT PRODUCTION FAILURE. Provenance has work for hours; under strict
     * priority eligibility waits for all of it, and every picture provenance
     * discovers stays undrawable in the meantime.
     */
    const both = [{ needsProvenance: true, needsEligibility: true }];
    expect(overTicks(both, 6)).toContain('eligibility');
  });

  it('reaches sanitization even while the two before it have work', () => {
    const all = [{ needsProvenance: true, needsEligibility: true, needsSanitization: true }];
    expect(overTicks(all, 9)).toContain('sanitization');
  });

  it('does not spend ticks on a phase with nothing outstanding', () => {
    const onlyRepairs = [{ needsSanitization: true }];
    expect(new Set(overTicks(onlyRepairs, 6))).toEqual(new Set(['sanitization']));
  });

  it('splits ticks evenly between two outstanding phases', () => {
    const two = [{ needsProvenance: true, needsSanitization: true }];
    const phases = overTicks(two, 8);
    expect(phases.filter((p) => p === 'provenance')).toHaveLength(4);
    expect(phases.filter((p) => p === 'sanitization')).toHaveLength(4);
  });

  it('reads work across the whole candidate set, not just the first', () => {
    const spread = [{ needsProvenance: true }, { needsEligibility: true }];
    expect(new Set(overTicks(spread, 6))).toEqual(new Set(['provenance', 'eligibility']));
  });
});

describe('and it is defined on the edges', () => {
  it('answers provenance when there is nothing to do', () => {
    expect(choosePhase([], 0, PERIOD)).toBe('provenance');
    expect(choosePhase([{}], 12345, PERIOD)).toBe('provenance');
  });

  it('never returns a phase that has no work, whatever the clock says', () => {
    const only = [{ needsEligibility: true }];
    for (const now of [0, 1, -1, 1e12, Number.MAX_SAFE_INTEGER]) {
      expect(choosePhase(only, now, PERIOD)).toBe('eligibility');
    }
  });

  it('falls back to the first outstanding phase on a nonsense clock', () => {
    const all = [{ needsProvenance: true, needsSanitization: true }];
    expect(choosePhase(all, Number.NaN, PERIOD)).toBe('provenance');
    expect(choosePhase(all, 0, 0)).toBe('provenance');
  });
});
