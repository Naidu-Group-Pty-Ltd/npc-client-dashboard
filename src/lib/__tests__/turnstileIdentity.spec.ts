/**
 * Turnstile identity: this deployment must never render another tenant's
 * CAPTCHA widget.
 *
 * A widget is a (site key, secret) pair, and the prime's site key was a
 * literal in `components/auth/TurnstileWidget.tsx` — inherited verbatim when
 * this repository was mirrored from `npc-property-dashbord`. Sharing it is the
 * same class of fault `backendIsolation.spec.ts` guards: one credential, one
 * rotation, one domain allowlist, spanning tenants that are supposed to be
 * separate. `siteverify` does report the hostname a token was solved on, and
 * no login handler in this repository reads it.
 *
 * The rule: there is no safe default for "whose widget". An unset variable is
 * a question, so the widget fails closed instead of borrowing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveTurnstileSiteKey, TURNSTILE_SITE_KEY_ENV } from '../turnstileSiteKey';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

/** The prime's widget. It must not appear in this repository's source. */
const FOREIGN_SITE_KEY = '0x4AAAAAAChQyb0ZxBORhxWq';

/**
 * Any Turnstile site key, not just the one we know about — a second borrowed
 * key would be exactly as wrong and would not be caught by naming the first.
 * Cloudflare mints them as `0x4AAAA…`, 22-24 chars after the prefix.
 */
const SITE_KEY_SHAPE = /0x4[A-Za-z0-9_-]{18,}/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no Turnstile site key is hardcoded under src/', () => {
  const files = walk(SRC).filter((f) => f !== join(__dirname, 'turnstileIdentity.spec.ts'));

  it('scans a plausible number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never names the prime's site key", () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), `${relative(REPO_ROOT, file)} names the prime's Turnstile site key`).not.toContain(
        FOREIGN_SITE_KEY,
      );
    }
  });

  it('never inlines any site key', () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), `${relative(REPO_ROOT, file)} inlines a Turnstile site key`).not.toMatch(
        SITE_KEY_SHAPE,
      );
    }
  });
});

describe('resolveTurnstileSiteKey precedence', () => {
  it('uses the configured key when one is set', () => {
    const r = resolveTurnstileSiteKey({ configured: '0x4AAAAAAtenantOwnKey11' });
    expect(r).toEqual({ siteKey: '0x4AAAAAAtenantOwnKey11', source: 'env', warning: null });
  });

  it('trims a configured key and ignores a blank one', () => {
    expect(resolveTurnstileSiteKey({ configured: '  0x4key  ' }).siteKey).toBe('0x4key');
    expect(resolveTurnstileSiteKey({ configured: '   ' }).siteKey).toBeNull();
  });

  it('resolves to nothing when unset, and names the variable', () => {
    const r = resolveTurnstileSiteKey({});
    expect(r.siteKey).toBeNull();
    expect(r.source).toBe('unset');
    expect(r.warning).toContain(TURNSTILE_SITE_KEY_ENV);
  });

  it('never borrows a built-in key belonging to a different backend', () => {
    const r = resolveTurnstileSiteKey({
      builtInSiteKey: FOREIGN_SITE_KEY,
      builtInBackendRef: 'dduzbchuswwbefdunfct',
      backendRef: 'plisdzywzleljorrphxv',
    });
    expect(r.siteKey).toBeNull();
    expect(r.source).toBe('unset');
    expect(r.warning).toContain('dduzbchuswwbefdunfct');
  });

  it('will not use a built-in key when the backend cannot be identified', () => {
    const r = resolveTurnstileSiteKey({
      builtInSiteKey: FOREIGN_SITE_KEY,
      builtInBackendRef: 'dduzbchuswwbefdunfct',
      backendRef: null,
    });
    expect(r.siteKey).toBeNull();
  });

  it('uses a built-in key only for the backend it is the twin of', () => {
    const r = resolveTurnstileSiteKey({
      builtInSiteKey: '0x4AAAAAAownWidget12345',
      builtInBackendRef: 'plisdzywzleljorrphxv',
      backendRef: 'plisdzywzleljorrphxv',
    });
    expect(r).toEqual({ siteKey: '0x4AAAAAAownWidget12345', source: 'built-in', warning: null });
  });

  it('this repository ships no built-in key at all', () => {
    // The clone's own reading: even pointed at its own backend, nothing is
    // borrowed — Mission Control publishes the key.
    const r = resolveTurnstileSiteKey({ backendRef: 'plisdzywzleljorrphxv' });
    expect(r.siteKey).toBeNull();
    expect(r.source).toBe('unset');
  });
});
