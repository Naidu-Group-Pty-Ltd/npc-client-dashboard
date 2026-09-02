/**
 * Two idle dashboards asked the server 13,679 times in one day.
 *
 * Every answer was `returnedCount: 0`, every ask cost ~1.2s of database time
 * — about 4.5 database-hours a day spent saying "nothing is generating" —
 * and the only 5xx the projection returned all day were these polls hitting
 * resource limits. The cadence now adapts; this pins the shape it adapts in,
 * and that the widget actually goes through it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MAX_MS,
  nextPollDelayMs,
} from '../progressPollCadence.pure';

const WIDGET = readFileSync(
  resolve(__dirname, '../../../components/reports/ReportGenerationProgress.tsx'),
  'utf8',
);

describe('the cadence', () => {
  it('stays live while something is generating', () => {
    expect(nextPollDelayMs(0)).toBe(ACTIVE_POLL_MS);
    // A section lands roughly every 25 seconds; 3s keeps the bar moving.
    expect(ACTIVE_POLL_MS).toBe(3_000);
  });

  it('confirms a just-emptied list quickly before backing off', () => {
    for (const empties of [1, 2, 3]) {
      expect(nextPollDelayMs(empties), `${empties} empties`).toBe(ACTIVE_POLL_MS);
    }
    expect(nextPollDelayMs(4)).toBeGreaterThan(ACTIVE_POLL_MS);
  });

  it('never backs off past the ceiling, however long the idle run', () => {
    for (const empties of [6, 60, 6_000, Number.MAX_SAFE_INTEGER]) {
      expect(nextPollDelayMs(empties)).toBe(IDLE_POLL_MAX_MS);
    }
  });

  it('keeps discovery inside half a minute, because polling is the only discovery', () => {
    // Nothing announces a generation started in another tab or by the bulk
    // runner — the widget finds out only by asking. A generation runs for
    // minutes, so 30s late is invisible; 5 minutes late is a broken widget.
    expect(IDLE_POLL_MAX_MS).toBeLessThanOrEqual(30_000);
  });

  it('is monotonic — an emptier history never polls faster', () => {
    let last = 0;
    for (let empties = 0; empties <= 10; empties += 1) {
      const delay = nextPollDelayMs(empties);
      expect(delay).toBeGreaterThanOrEqual(last);
      last = delay;
    }
  });

  it('treats a nonsensical count as active rather than silent', () => {
    expect(nextPollDelayMs(Number.NaN)).toBe(ACTIVE_POLL_MS);
    expect(nextPollDelayMs(-5)).toBe(ACTIVE_POLL_MS);
  });
});

describe('the widget goes through it', () => {
  it('gates every tick on the due time and paces by emptiness', () => {
    expect(WIDGET).toMatch(/nextPollDelayMs\(/);
    expect(WIDGET).toContain('nextDueAtRef');
    expect(WIDGET).toContain('Date.now() < nextDueAtRef.current');
  });

  it('answers immediately when the tab becomes visible again', () => {
    // The person just looked; a 30s-stale answer reads as a broken widget.
    expect(WIDGET).toMatch(/if \(!document\.hidden\) \{[\s\S]{0,300}?nextDueAtRef\.current = 0/);
  });

  it('leaves the failure backoffs to their own refs', () => {
    // Transient errors and the auth breaker gate on failure; the cadence
    // paces success. Collapsing them is how a 500 comes to poll faster.
    expect(WIDGET).toContain('transientBackoffUntilRef');
    expect(WIDGET).toContain('authFailCountRef');
  });
});
