/**
 * Cloudflare's error codes, mapped to the person who can act on them.
 *
 * ## Why this file exists
 *
 * The widget used to discard the code, so every failure rendered the same
 * sentence — "check your ad/script blocker" — including the failures no visitor
 * can do anything about. The table below is the contract that stops that
 * happening again: an operator fault must never be described as something the
 * visitor can retry away, because the retry button is what tells them to keep
 * trying a thing that will fail identically for ever.
 *
 * The expectations are Cloudflare's own, from
 * developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/.
 * When that table changes, this one changes with it — not the other way round.
 */
import { describe, it, expect } from 'vitest';
import {
  TURNSTILE_FALLBACK_SITE_KEY,
  TURNSTILE_SCRIPT_UNREACHABLE,
  classifyTurnstileFault,
  resolveTurnstileSiteKey,
} from './turnstile';

describe('classifyTurnstileFault', () => {
  const OPERATOR_FAULTS = ['110100', '110110', '110200', '400020', '400070'];
  const VISITOR_RETRYABLE = ['110600', '110620', '200500'];

  it.each(OPERATOR_FAULTS)('%s is the site owner\'s to fix and cannot be retried away', (code) => {
    const fault = classifyTurnstileFault(code);
    expect(fault.owner).toBe('operator');
    expect(fault.retryable).toBe(false);
    expect(fault.code).toBe(code);
  });

  it.each(VISITOR_RETRYABLE)('%s is retryable', (code) => {
    const fault = classifyTurnstileFault(code);
    expect(fault.retryable).toBe(true);
    expect(fault.owner).toBe('visitor');
  });

  it('200100 is a clock/cache fault the visitor cannot simply retry', () => {
    const fault = classifyTurnstileFault('200100');
    expect(fault.owner).toBe('visitor');
    expect(fault.retryable).toBe(false);
    expect(fault.remedy).toMatch(/clock/i);
  });

  it('names the hostname to add for 110200, because that IS the fix', () => {
    const fault = classifyTurnstileFault('110200', 'command-centre.npcservices.com.au');
    expect(fault.remedy).toContain('command-centre.npcservices.com.au');
    expect(fault.remedy).toMatch(/Hostname Management/i);
  });

  it('still explains 110200 when no hostname is supplied', () => {
    const fault = classifyTurnstileFault('110200');
    expect(fault.remedy).toMatch(/hostname/i);
    expect(fault.remedy).not.toContain('undefined');
  });

  it('only 200500 and the unreachable-script fault mention a blocker', () => {
    // The sentence that used to be shown for everything. It is correct for the
    // iframe being blocked and for nothing else.
    const mentionsBlocker = (code: string) => /blocker/i.test(classifyTurnstileFault(code).remedy);
    expect(mentionsBlocker('200500')).toBe(true);
    expect(TURNSTILE_SCRIPT_UNREACHABLE.remedy).toMatch(/blocker/i);
    for (const code of [...OPERATOR_FAULTS, '110600', '110620', '200100', '300030', '600001']) {
      expect(mentionsBlocker(code)).toBe(false);
    }
  });

  it.each(['300030', '300031', '300020', '600001', '600999'])(
    '%s is a generic challenge failure and retryable',
    (code) => {
      const fault = classifyTurnstileFault(code);
      expect(fault.retryable).toBe(true);
      expect(fault.summary).toMatch(/did not pass/i);
    },
  );

  it('does not treat a near-miss of the generic prefixes as generic', () => {
    // Six digits starting 300/600 only. `30003` and `3000300` are not codes we
    // can read, and pretending otherwise sends somebody to the wrong remedy.
    expect(classifyTurnstileFault('30003').owner).toBe('unknown');
    expect(classifyTurnstileFault('3000300').owner).toBe('unknown');
  });

  it('keeps an undocumented code verbatim rather than guessing its owner', () => {
    const fault = classifyTurnstileFault('999999');
    expect(fault.code).toBe('999999');
    expect(fault.owner).toBe('unknown');
    expect(fault.retryable).toBe(true);
  });

  it('survives the shapes Cloudflare can actually hand a callback', () => {
    expect(classifyTurnstileFault(undefined).code).toBe('');
    expect(classifyTurnstileFault(null).code).toBe('');
    expect(classifyTurnstileFault(110200 as unknown).owner).toBe('operator');
    expect(classifyTurnstileFault('  110200  ').owner).toBe('operator');
  });

  it('every classification carries something to show and something to do', () => {
    for (const code of [...OPERATOR_FAULTS, ...VISITOR_RETRYABLE, '200100', '300030', '', 'nonsense']) {
      const fault = classifyTurnstileFault(code);
      expect(fault.summary.length).toBeGreaterThan(0);
      expect(fault.remedy.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveTurnstileSiteKey', () => {
  it('uses the configured key when a build sets one', () => {
    expect(resolveTurnstileSiteKey({ VITE_TURNSTILE_SITE_KEY: '0xTEST' })).toEqual({
      siteKey: '0xTEST',
      source: 'env',
    });
  });

  it('trims, because a trailing newline out of a dashboard is not a key', () => {
    expect(resolveTurnstileSiteKey({ VITE_TURNSTILE_SITE_KEY: ' 0xTEST\n' }).siteKey).toBe('0xTEST');
  });

  it.each([undefined, {}, { VITE_TURNSTILE_SITE_KEY: '' }, { VITE_TURNSTILE_SITE_KEY: '   ' }])(
    'falls back to the shipped key for %j, so an unset build is unchanged',
    (env) => {
      expect(resolveTurnstileSiteKey(env as Record<string, string | undefined>)).toEqual({
        siteKey: TURNSTILE_FALLBACK_SITE_KEY,
        source: 'fallback',
      });
    },
  );

  it('the shipped fallback is the key this repository has always rendered', () => {
    expect(TURNSTILE_FALLBACK_SITE_KEY).toBe('0x4AAAAAAChQyb0ZxBORhxWq');
  });
});
