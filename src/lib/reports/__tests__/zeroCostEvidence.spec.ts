/**
 * ME-6 zero-cost strategy — the acquisition footing, and the measured inventory.
 *
 * Two things are pinned here, and they fail for different reasons.
 *
 * The ACQUISITION rules are a contract: a trial measure must never acquire a
 * production right, and the default must be the conservative one. Those tests
 * fail when somebody widens the rule.
 *
 * The INVENTORY rules are about honesty: every row must carry a real
 * measurement, and no row may claim to supply a dimension its grain cannot
 * support. Those tests fail when somebody adds a source they have not measured
 * — which is the exact failure this programme has hit repeatedly, most
 * expensively when a complete sanctions register sat behind a load that had
 * never once succeeded.
 */
import { describe, it, expect } from 'vitest';
import {
  acquisitionOf,
  acquisitionLicensingConflict,
  mayEnterProductionEvidence,
  mayEnterShadowBacktest,
  mayReachClientReport,
  type EvidenceAcquisition,
  type EvidencePoint,
} from '@/lib/reports/market/marketEvidence.pure';
import {
  ZERO_COST_SOURCES,
  ZERO_COST_INVENTORY_VERSION,
  INVENTORY_MEASURED_ON,
  ingestableToday,
  blockedByTransport,
  growthCapableToday,
} from '@/lib/reports/market/zeroCostSources.pure';

const point = (over: Partial<EvidencePoint<number>> = {}): EvidencePoint<number> => ({
  value: 1,
  level: 'suburb',
  areaName: 'Traralgon',
  dwellingType: 'house',
  dwellingTypeMatched: true,
  provider: 'abs_res_dwell',
  asOf: '2026-Q2',
  sampleSize: null,
  periodsAvailable: null,
  method: 'observed',
  sourceNote: null,
  ...over,
});

describe('ME-6 — evidence acquisition footing', () => {
  it('defaults to licensing_unverified when no footing is declared', () => {
    expect(acquisitionOf(point())).toBe('licensing_unverified');
  });

  it('an undeclared footing is not production evidence', () => {
    expect(mayEnterProductionEvidence(point())).toBe(false);
  });

  it('admits only open_public and existing_licensed to production evidence', () => {
    const admitted: EvidenceAcquisition[] = ['open_public', 'existing_licensed'];
    const refused: EvidenceAcquisition[] = [
      'trial_shadow_only', 'commercial_upgrade_required', 'licensing_unverified',
    ];
    for (const a of admitted) {
      expect(mayEnterProductionEvidence(point({ acquisition: a })), a).toBe(true);
    }
    for (const a of refused) {
      expect(mayEnterProductionEvidence(point({ acquisition: a })), a).toBe(false);
    }
  });

  it('a trial measure may be shadow-scored but never becomes production evidence', () => {
    const trial = point({ acquisition: 'trial_shadow_only' });
    expect(mayEnterShadowBacktest(trial)).toBe(true);
    expect(mayEnterProductionEvidence(trial)).toBe(false);
  });

  it('refuses a shadow backtest only for a source that was never obtained', () => {
    expect(mayEnterShadowBacktest(point({ acquisition: 'commercial_upgrade_required' }))).toBe(false);
    expect(mayEnterShadowBacktest(point({ acquisition: 'licensing_unverified' }))).toBe(true);
  });

  it('refuses the combination that would let trial data reach a client', () => {
    for (const l of ['open', 'licensed_for_client_reports'] as const) {
      const conflict = acquisitionLicensingConflict(
        point({ acquisition: 'trial_shadow_only', licensingStatus: l }),
      );
      expect(conflict, l).not.toBeNull();
      expect(conflict).toMatch(/trial/i);
    }
  });

  it('refuses any licensing claim on a source behind an unpurchased upgrade', () => {
    expect(
      acquisitionLicensingConflict(
        point({ acquisition: 'commercial_upgrade_required', licensingStatus: 'internal_only' }),
      ),
    ).not.toBeNull();
  });

  it('allows the honest combinations', () => {
    expect(acquisitionLicensingConflict(
      point({ acquisition: 'open_public', licensingStatus: 'open' }),
    )).toBeNull();
    expect(acquisitionLicensingConflict(
      point({ acquisition: 'trial_shadow_only', licensingStatus: 'internal_only' }),
    )).toBeNull();
    expect(acquisitionLicensingConflict(
      point({ acquisition: 'commercial_upgrade_required' }),
    )).toBeNull();
  });

  it('leaves mayReachClientReport exactly as it was — no existing caller changes', () => {
    // The acquisition axis is additive. A point that declares only licensing
    // behaves identically to before this module existed.
    expect(mayReachClientReport(point())).toBe(false);
    expect(mayReachClientReport(point({ licensingStatus: 'open' }))).toBe(true);
    expect(mayReachClientReport(point({ licensingStatus: 'internal_only' }))).toBe(false);
  });
});

describe('ME-6 — the measured zero-cost inventory', () => {
  it('is versioned and carries the date its readings were taken', () => {
    expect(ZERO_COST_INVENTORY_VERSION).toBe('me6.zerocost.1');
    expect(INVENTORY_MEASURED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('every source carries a real measurement, never an assumption', () => {
    for (const s of ZERO_COST_SOURCES) {
      expect(s.measurement.length, s.id).toBeGreaterThan(40);
      expect(s.reachability, s.id).not.toBe('not_measured');
    }
  });

  it('no source claims to supply Growth at a grain coarser than a suburb', () => {
    // A state mean price is context. Letting it read as Growth is precisely how
    // an "evidence-backed" score comes to rest on nothing about the suburb.
    const coarse = ['state', 'capital_city', 'lga', 'sa2', 'postcode'];
    for (const s of ZERO_COST_SOURCES) {
      if (coarse.includes(s.grain)) expect(s.supplies, s.id).not.toBe('growth');
    }
  });

  it('separates a licensing block from a transport block', () => {
    // Both look like "no data" and they send an operator to opposite remedies.
    for (const s of blockedByTransport()) {
      expect(s.acquisition, s.id).toBe('open_public');
      expect(s.reachability, s.id).not.toBe('reachable_production');
    }
    for (const s of ingestableToday()) {
      expect(s.reachability, s.id).toBe('reachable_production');
      expect(s.acquisition, s.id).toBe('open_public');
    }
  });

  it('records Victoria as openly licensed AND unreachable, not as absent', () => {
    const vic = ZERO_COST_SOURCES.find((s) => s.id === 'vic_property_sales_median_by_suburb');
    expect(vic).toBeDefined();
    expect(vic!.acquisition).toBe('open_public');
    expect(vic!.supplies).toBe('growth');
    expect(vic!.grain).toBe('suburb');
    expect(vic!.dwellingSegmented).toBe(true);
    expect(vic!.reachability).toBe('blocked_bot_challenge');
    // The measurement must name BOTH egresses, because one refusal proves nothing.
    expect(vic!.measurement).toMatch(/production/i);
    expect(vic!.measurement).toMatch(/development/i);
  });

  it('does not pretend the zero-cost stack covers Growth for the corpus', () => {
    // The whole point of the exercise: QLD (50.8%) and WA (20.6%) publish no
    // open suburb-level median sale price, so nothing here can reach them.
    const growth = growthCapableToday();
    for (const s of growth) {
      expect(['QLD', 'WA'], `${s.id} must not claim to cover QLD/WA Growth`)
        .not.toContain(s.jurisdiction);
    }
  });

  it('never records an unverified licence as open', () => {
    for (const s of ZERO_COST_SOURCES) {
      if (/custom \(other\)|not an open licence|not established/i.test(s.licence)) {
        expect(s.acquisition, s.id).not.toBe('open_public');
      }
    }
  });
});
