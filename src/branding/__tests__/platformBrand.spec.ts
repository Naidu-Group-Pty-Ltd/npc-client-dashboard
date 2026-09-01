import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLATFORM_APPLE_TOUCH_ICON,
  PLATFORM_FAVICON,
  appleTouchIconFor,
  faviconFor,
} from '../platformBrand';

const indexHtml = readFileSync(join(__dirname, '..', '..', '..', 'index.html'), 'utf8');

describe('an unbranded clone still shows whose platform it is', () => {
  it('falls back to the Aurixa mark when nothing is configured', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(faviconFor(empty)).toBe(PLATFORM_FAVICON);
    }
  });

  it('uses the tenant mark when there is one', () => {
    expect(faviconFor('https://cdn.example.com/logo.png')).toBe(
      'https://cdn.example.com/logo.png',
    );
  });

  it('never returns null — an unbranded clone is an Aurixa deployment', () => {
    // The defect this replaces was an early `return`, which left the previous
    // tenant's mark on the tab after their favicon was cleared.
    expect(faviconFor(null)).toBeTruthy();
    expect(appleTouchIconFor(null)).toBeTruthy();
  });
});

describe('the static declaration and the runtime default agree', () => {
  it('index.html declares the same icon the provider falls back to', () => {
    // They are painted at different moments — the static link before
    // hydration, the provider after — so a mismatch is a visible flicker from
    // one mark to another on every load of an unbranded clone.
    expect(indexHtml).toContain(`href="${PLATFORM_FAVICON}"`);
  });

  it('index.html declares the same apple-touch tile', () => {
    expect(indexHtml).toContain(`href="${PLATFORM_APPLE_TOUCH_ICON}"`);
  });

  it('the platform mark is an Aurixa asset, not a scaffold leftover', () => {
    expect(PLATFORM_FAVICON).toMatch(/^\/brand\/aurixa-/);
    expect(indexHtml).not.toMatch(/rel="icon"[^>]*href="\/favicon\.ico"/);
  });
});
