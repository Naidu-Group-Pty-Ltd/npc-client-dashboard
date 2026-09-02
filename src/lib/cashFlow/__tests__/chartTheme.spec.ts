/**
 * Two lines on one chart must not be the same colour.
 *
 * The Cash Flow trends chart drew Property Value from `--primary` and Rental
 * Income from `--warning`. In the light theme those differ. In the dark theme
 * — which is what this product ships — `--primary`, `--warning` and `--chart-1`
 * are all `43 74% 49%`, so the two series were one gold line and the legend
 * named a colour that appeared twice.
 *
 * That is not something reading the code shows you: both sides are semantic
 * tokens, both are correct in isolation, and the collision lives in a
 * stylesheet. So the assertion is made against the stylesheet, for every theme
 * it defines.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROPERTY_TOKENS,
  SERIES_TOKENS,
  TREND_SERIES,
  YIELD_SERIES,
  resolveChartTheme,
  toCssColor,
} from '../chartTheme';

const TOKENS = readFileSync(
  path.resolve(__dirname, '../../../styles/tokens.css'),
  'utf8',
);

/**
 * The custom properties in force for a theme.
 *
 * `.dark` overrides `:root`, and anything it does not redefine is inherited —
 * which is the whole reason the collision existed: the `--chart-*` scale is
 * defined once and `--primary` is redefined to one of its values.
 */
function themeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const values: Record<string, string> = {};
  const blocks = [...TOKENS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of blocks) {
    const isDark = /\.dark\b/.test(selector);
    const isRoot = /:root\b/.test(selector) && !isDark;
    if (!(isRoot || (theme === 'dark' && isDark))) continue;
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      values[name] = value.trim();
    }
  }
  return values;
}

describe('the stylesheet this is asserted against', () => {
  it('defines the tokens the charts use, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = themeTokens(theme);
      for (const name of [...Object.values(SERIES_TOKENS), ...PROPERTY_TOKENS]) {
        expect(tokens[name], `${name} is not defined for the ${theme} theme`).toBeTruthy();
      }
    }
  });

  it('still has the collision the series assignment had to route around', () => {
    // If this ever stops being true the constraint has relaxed, not vanished —
    // and the test above is what proves the assignment is still safe.
    const dark = themeTokens('dark');
    expect(dark['--primary']).toBe(dark['--warning']);
  });
});

/** The series that share one chart, and therefore may not share a colour. */
function clashesWithin(theme: 'light' | 'dark', group: readonly (keyof typeof SERIES_TOKENS)[]) {
  const tokens = themeTokens(theme);
  const byColour = new Map<string, string[]>();
  for (const series of group) {
    const name = SERIES_TOKENS[series];
    const colour = tokens[name];
    byColour.set(colour, [...(byColour.get(colour) ?? []), `${series} (${name})`]);
  }
  return [...byColour.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([colour, names]) => `${colour}: ${names.join(' + ')}`);
}

describe('no two lines on one chart share a colour', () => {
  it.each(['light', 'dark'] as const)('on the trends chart, %s theme', (theme) => {
    expect(clashesWithin(theme, TREND_SERIES), 'two series would draw as one line').toEqual([]);
  });

  it.each(['light', 'dark'] as const)('on the yield chart, %s theme', (theme) => {
    expect(clashesWithin(theme, YIELD_SERIES), 'two series would draw as one line').toEqual([]);
  });
});

describe('no two compared properties share a colour', () => {
  it.each(['light', 'dark'] as const)('in the %s theme', (theme) => {
    const tokens = themeTokens(theme);
    const colours = PROPERTY_TOKENS.map((name) => tokens[name]);
    expect(new Set(colours).size, `${colours.join(', ')}`).toBe(PROPERTY_TOKENS.length);
  });

  it('never uses --chart-1, which is --primary by another name', () => {
    expect(PROPERTY_TOKENS).not.toContain('--chart-1');
    expect(themeTokens('dark')['--chart-1']).toBe(themeTokens('dark')['--primary']);
  });
});

describe('turning a token into a colour', () => {
  it('wraps a bare triple, which is how the tokens are stored', () => {
    // Recharts writes colours into SVG presentation attributes, where `var()`
    // is not resolved — so a bare `43 74% 49%` has to become `hsl(43 74% 49%)`
    // before it reaches an attribute.
    expect(toCssColor('43 74% 49%', '#000')).toBe('hsl(43 74% 49%)');
  });

  it('passes through anything that is already a colour', () => {
    expect(toCssColor('#ff0000', '#000')).toBe('#ff0000');
    expect(toCssColor('rgb(1, 2, 3)', '#000')).toBe('rgb(1, 2, 3)');
    expect(toCssColor('hsl(0 0% 0%)', '#000')).toBe('hsl(0 0% 0%)');
  });

  it('falls back on an empty token rather than emitting hsl()', () => {
    expect(toCssColor('', '#abcdef')).toBe('#abcdef');
    expect(toCssColor('   ', '#abcdef')).toBe('#abcdef');
  });
});

describe('with no document to read', () => {
  it('returns a complete palette rather than nothing', () => {
    // A chart drawn during a test render or before hydration still needs every
    // colour; an undefined stroke is an invisible line.
    const theme = resolveChartTheme(null);
    expect(theme.surface).toBeTruthy();
    expect(theme.grid).toBeTruthy();
    expect(theme.tick).toBeTruthy();
    expect(theme.property).toHaveLength(PROPERTY_TOKENS.length);
    for (const colour of Object.values(theme.series)) expect(colour).toBeTruthy();
  });

  it('gives the fallbacks distinct series colours too', () => {
    const { series } = resolveChartTheme(null);
    const distinct = new Set([
      series.propertyValue, series.equity, series.loanBalance,
      series.rentalIncome, series.cashFlow,
    ]);
    expect(distinct.size).toBe(5);
  });
});
