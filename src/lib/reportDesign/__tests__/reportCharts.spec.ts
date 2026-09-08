/**
 * The chart layer.
 *
 * Charts are the part of a report a reader looks at first and a test can see
 * least, so the assertions here are about the three properties that were
 * actually wrong before the port:
 *
 *  1. **No colour of their own.** Eleven hardcoded hexes made the charts a
 *     twelfth palette — unreachable from a tenant, unaudited for contrast, and
 *     with their own idea of what "risk" looks like.
 *  2. **Type that is legible on paper.** Sizes were viewBox units, which say
 *     nothing about printed size. A 9.5-unit label in a 760-unit viewBox across
 *     the 174mm measure is 6.2pt.
 *  3. **Output that is safe and deterministic.** Chart data is model-generated,
 *     and on the shared-report path attacker-influenced.
 */
/* eslint-disable no-restricted-syntax --
 * Fixture colours: hostile tenant brands used to prove the palette flows
 * through, and expected values asserted against. Not palette choices.
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_TEXT_PT,
  CHART_WIDTH,
  MAX_HEATMAP_CELLS,
  MAX_WATERFALL_ITEMS,
  MAX_WHEEL_SCORES,
  DONUT_STACK_BELOW_MM,
  chartContext,
  chartContextForSpan,
  chartFigure,
  chartPalette,
  formatAxisValue,
  minifySvg,
  ptToUnits,
  renderBars,
  renderBullet,
  renderCalendarHeatmap,
  renderDonut,
  renderGauge,
  renderHeatmap,
  renderInlineSpark,
  renderMarginSpark,
  renderMarimekko,
  renderMicroMap,
  renderPictograph,
  renderQuadrant,
  renderScoreBars,
  renderTiles,
  renderTimelineRibbon,
  renderWaterfall,
  stableId,
  svgEscape,
  unitsToPt,
  withAlpha,
} from '../charts.pure';
import { resolveReportPalette } from '../brandResolve.pure';
import { CONTRAST_FLOOR, PRINT_SEMANTIC } from '../tokens.pure';
import { contrastRatio } from '../color.pure';

const palette = resolveReportPalette();
const ctx = chartContext(palette);

/** Every chart, with arguments that produce a non-empty drawing. */
const CHARTS: Array<[string, () => string]> = [
  ['gauge', () => renderGauge(ctx, 72, { label: 'Investment score', caption: 'weighted' })],
  ['waterfall', () => renderWaterfall(ctx, [
    { label: 'Rent', value: 42_400 },
    { label: 'Expenses', value: -11_900 },
    { label: 'Interest', value: -38_600 },
    { label: 'Net', value: -8_100, total: true },
  ])],
  ['heatmap', () => renderHeatmap(ctx, [[1, 2], [3, 4]], {
    rowLabels: ['A', 'B'], colLabels: ['X', 'Y'], title: 'Growth',
  })],
  ['scoreBars', () => renderScoreBars(ctx, [80, 65, 40, 90], { labels: ['A', 'B', 'C', 'D'] })],
  ['bullet', () => renderBullet(ctx, { value: 62, target: 75, label: 'Yield', sub: 'vs target' })],
  ['marimekko', () => renderMarimekko(ctx, [
    { label: 'Owner', weight: 3, segments: [2, 1] },
    { label: 'Rented', weight: 2, segments: [1, 3] },
  ], { segmentLabels: ['House', 'Unit'] })],
  ['microMap', () => renderMicroMap(ctx, {
    suburb: 'Blackwater', state: 'QLD', postcode: '4717', neighbours: ['Bluff', 'Comet'],
  })],
  ['calendarHeatmap', () => renderCalendarHeatmap(ctx, [1, 2, 3, 4, 5, 6], { title: 'Listings' })],
  ['bars', () => renderBars(ctx, [
    { label: 'Schools', value: 8 }, { label: 'Transport', value: 4 },
  ], { title: 'Amenity', unit: '/10' })],
  ['quadrant', () => renderQuadrant(ctx, [
    { x: 4, y: 8, label: 'Subject', highlight: true }, { x: 7, y: 3, label: 'Peer' },
  ], { title: 'Risk vs return', xLabel: 'Risk', yLabel: 'Return', q1: 'Growth' })],
  ['pictograph', () => renderPictograph(ctx, 7, 10, { label: 'Owner-occupied', sub: 'per ten dwellings' })],
  ['inlineSpark', () => renderInlineSpark(ctx, [1, 2, 3, 2, 5])],
  ['marginSpark', () => renderMarginSpark(ctx, [5, 3, 4, 1])],
  ['donut', () => renderDonut(ctx, [
    { label: 'Owned', value: 60 }, { label: 'Rented', value: 40 },
  ], { title: 'Tenure' })],
  ['tiles', () => renderTiles(ctx, [
    { label: 'Median', value: '$785k', sub: 'up 4.1%', intensity: 0.8 },
  ], { title: 'Locality' })],
  ['timelineRibbon', () => renderTimelineRibbon(ctx, [
    { phase: 'existing', label: 'Hospital' }, { phase: '3-5y', label: 'Rail spur' },
  ])],
];

describe('every chart draws', () => {
  it.each(CHARTS)('%s produces well-formed SVG', (_name, render) => {
    const svg = render();
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
    // A stray `${` means a template hole; `[object Object]` means a bad interpolation.
    expect(svg).not.toContain('${');
    expect(svg).not.toContain('[object Object]');
  });

  it.each(CHARTS)('%s balances its tags', (_name, render) => {
    const svg = render();
    const opens = (svg.match(/<[a-zA-Z]/g) ?? []).length;
    const closes = (svg.match(/<\/[a-zA-Z]/g) ?? []).length + (svg.match(/\/>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it.each(CHARTS)('%s is deterministic', (_name, render) => {
    expect(render()).toBe(render());
  });
});

describe('charts have no colour of their own', () => {
  it.each(CHARTS)('%s paints only palette roles', (_name, render) => {
    const svg = render();
    const used = new Set([
      ...(svg.match(/#[0-9A-Fa-f]{6}/g) ?? []).map((h) => h.toUpperCase()),
    ]);
    const allowed = new Set(Object.values(chartPalette(palette)).flat()
      .filter((v): v is string => typeof v === 'string').map((h) => h.toUpperCase()));
    for (const hex of used) expect(allowed, `${hex} is not a palette role`).toContain(hex);
  });

  it('follows a tenant brand', () => {
    const tenant = chartContext(resolveReportPalette({ brandHex: '#00A3FF' }));
    expect(renderGauge(tenant, 50)).toContain('#00A3FF');
    expect(renderGauge(ctx, 50)).not.toContain('#00A3FF');
  });

  it('keeps the semantic three fixed whatever the tenant does', () => {
    // A chart must not be the place "risk" becomes green.
    const tenant = chartContext(resolveReportPalette({ brandHex: '#00FF00', preset: 'high_contrast' }));
    const svg = renderWaterfall(tenant, [{ label: 'Loss', value: -100 }, { label: 'Gain', value: 40 }]);
    expect(svg).toContain(PRINT_SEMANTIC.negative);
    expect(svg).toContain(PRINT_SEMANTIC.positive);
  });

  it('draws its labels in ink that clears the micro floor on its own ground', () => {
    const p = chartPalette(palette);
    for (const ink of [p.ink, p.inkMuted, p.accentDeep]) {
      expect(contrastRatio(ink, p.ground)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.micro);
      expect(contrastRatio(ink, p.groundAlt)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.micro);
    }
  });
});

describe('chart type is legible in print', () => {
  it('converts points to viewBox units and back', () => {
    const units = ptToUnits(10, CHART_WIDTH.wide);
    expect(unitsToPt(units, CHART_WIDTH.wide)).toBeCloseTo(10, 1);
  });

  it('scales with the viewBox — the same point size is more units in a wider chart', () => {
    expect(ptToUnits(10, CHART_WIDTH.wide)).toBeGreaterThan(ptToUnits(10, CHART_WIDTH.compact));
  });

  it('reproduces the defect this replaces', () => {
    // The original hardcoded 9.5 units for axis labels in a 760-unit viewBox.
    expect(unitsToPt(9.5, CHART_WIDTH.wide)).toBeLessThan(CHART_TEXT_PT.micro);
    expect(unitsToPt(9.5, CHART_WIDTH.wide)).toBeCloseTo(6.2, 1);
  });

  it.each(Object.entries(CHART_TEXT_PT))('%s (%dpt) clears the print floor', (_role, pt) => {
    expect(pt).toBeGreaterThanOrEqual(7.5);
  });

  it.each(CHARTS)('%s sets no text below the micro floor once printed', (_name, render) => {
    const svg = render();
    const vb = Number(svg.match(/viewBox="0 0 ([\d.]+)/)?.[1]);
    expect(Number.isFinite(vb)).toBe(true);
    const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    for (const size of sizes) {
      // The inline sparkline carries no text; anything else must be readable.
      expect(unitsToPt(size, vb), `${size} units in a ${vb} viewBox`).toBeGreaterThanOrEqual(7.4);
    }
  });
});

describe('a chart knows how wide it will print', () => {
  it('sizes to a grid column, not the full measure', () => {
    // A chart built for 174mm and dropped into a 38% column prints every label
    // at 38% of the size the code asked for. Seen in the first charted render.
    const col5 = chartContextForSpan(palette, 5);
    expect(col5.widthMm).toBeLessThan(chartContext(palette).widthMm);
    const svgFull = renderBars(ctx, [{ label: 'A', value: 1 }]);
    const svgCol = renderBars(col5, [{ label: 'A', value: 1 }]);
    const sizeOf = (svg: string) => Number(svg.match(/font-size="([\d.]+)"/)?.[1]);
    // A narrower printed width means MORE viewBox units per point — the drawing
    // is scaled down, so the type has to be drawn bigger to land the same size.
    expect(sizeOf(svgCol)).toBeGreaterThan(sizeOf(svgFull));
    const vb = CHART_WIDTH.wide;
    expect(unitsToPt(sizeOf(svgCol), vb, col5.widthMm))
      .toBeCloseTo(unitsToPt(sizeOf(svgFull), vb), 1);
  });

  it('narrower spans are narrower, in order', () => {
    const widths = ([4, 5, 7, 8] as const).map((s) => chartContextForSpan(palette, s).widthMm);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('stacks the donut legend under the ring in a narrow column', () => {
    // A legend row is a swatch, a label and a percentage — about 30mm of type.
    // Beside a ring in a 66mm column it printed straight through the figure.
    const narrow = chartContext(palette, DONUT_STACK_BELOW_MM - 1);
    const wide = chartContext(palette, DONUT_STACK_BELOW_MM + 1);
    const data = [{ label: 'Owner-occupied', value: 62 }, { label: 'Rented', value: 38 }];
    // The legend column starts at the left margin when stacked and beside the
    // ring when not.
    expect(renderDonut(narrow, data)).toContain('<rect x="16"');
    expect(renderDonut(wide, data)).toContain('<rect x="250"');
    // Explicit layout beats the width heuristic. Compared structurally, not
    // byte for byte: the two contexts print at different widths, so their type
    // is drawn at different unit sizes for the same point size.
    expect(renderDonut(narrow, data, { layout: 'side' })).toContain('<rect x="250"');
    expect(renderDonut(wide, data, { layout: 'stacked' })).toContain('<rect x="16"');
  });
});

describe('output safety', () => {
  const HOSTILE = '<script>alert("x")</script> & "q"';

  it('escapes tags and quotes in every label position', () => {
    const svgs = [
      renderGauge(ctx, 50, { label: HOSTILE, caption: HOSTILE }),
      renderBars(ctx, [{ label: HOSTILE, value: 1 }], { title: HOSTILE }),
      renderTiles(ctx, [{ label: HOSTILE, value: HOSTILE, sub: HOSTILE }], { title: HOSTILE }),
      renderMicroMap(ctx, { suburb: HOSTILE, state: HOSTILE, neighbours: [HOSTILE] }),
      renderDonut(ctx, [{ label: HOSTILE, value: 1 }], { title: HOSTILE, centerLabel: HOSTILE }),
      renderQuadrant(ctx, [{ x: 1, y: 1, label: HOSTILE }], { title: HOSTILE, q1: HOSTILE }),
      renderTimelineRibbon(ctx, [{ phase: 'existing', label: HOSTILE }], { title: HOSTILE }),
    ];
    for (const svg of svgs) {
      expect(svg).not.toContain('<script>');
      expect(svg).toContain('&lt;script&gt;');
    }
  });

  it('svgEscape neutralises the four characters that matter in XML', () => {
    expect(svgEscape('<&>"')).toBe('&lt;&amp;&gt;&quot;');
    expect(svgEscape(null)).toBe('');
  });

  it('refuses oversized inputs rather than rendering them', () => {
    expect(renderWaterfall(ctx, Array.from({ length: MAX_WATERFALL_ITEMS + 1 },
      (_, i) => ({ label: `x${i}`, value: 1 })))).toBe('');
    expect(renderScoreBars(ctx, Array.from({ length: MAX_WHEEL_SCORES + 1 }, () => 5))).toBe('');
    const big = Array.from({ length: 25 }, () => Array.from({ length: 25 }, () => 1));
    expect(25 * 25).toBeGreaterThan(MAX_HEATMAP_CELLS);
    expect(renderHeatmap(ctx, big)).toBe('');
  });

  it('refuses a ragged heatmap grid', () => {
    expect(renderHeatmap(ctx, [[1, 2], [3]])).toBe('');
  });

  it('returns empty rather than a broken drawing for empty data', () => {
    expect(renderBars(ctx, [])).toBe('');
    expect(renderTiles(ctx, [])).toBe('');
    expect(renderMarimekko(ctx, [])).toBe('');
    expect(renderCalendarHeatmap(ctx, [])).toBe('');
    expect(renderInlineSpark(ctx, [1])).toBe('');
    expect(renderMarginSpark(ctx, [])).toBe('');
    expect(renderDonut(ctx, [])).toBe('');
  });

  it('survives a zero-range series without dividing by zero', () => {
    expect(renderInlineSpark(ctx, [5, 5, 5])).not.toContain('NaN');
    expect(renderCalendarHeatmap(ctx, [3, 3, 3])).not.toContain('NaN');
    expect(renderHeatmap(ctx, [[2, 2], [2, 2]])).not.toContain('NaN');
    expect(renderGauge(ctx, 0, { max: 0 })).not.toContain('NaN');
  });
});

describe('defs ids are unique per drawing', () => {
  it('two gauges on one page do not share a gradient id', () => {
    // The original hardcoded `id="gauge-fill"`, so the second reference
    // resolved to the first definition.
    const a = renderGauge(ctx, 30);
    const b = renderGauge(ctx, 80);
    const idOf = (svg: string) => svg.match(/id="(gauge-[a-z0-9]+)"/)?.[1];
    expect(idOf(a)).toBeDefined();
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it('never sets the large-arc flag on the value sweep', () => {
    // The sweep is `pct` of a half circle, so it is never more than 180 degrees.
    // The original set the flag whenever pct > 0.5, drawing the arc the long way
    // round — two disconnected segments at the ends of the track.
    for (const value of [10, 49, 51, 72, 99, 100]) {
      const svg = renderGauge(ctx, value);
      const sweeps = [...svg.matchAll(/A 130 130 0 (\d) 1 /g)].map((m) => m[1]);
      // The track is a full half-circle and legitimately uses the flag; the
      // value arc must not.
      expect(sweeps.slice(1)).not.toContain('1');
    }
  });

  it('the same gauge twice keeps the same id — the hash is of content', () => {
    expect(renderGauge(ctx, 30)).toBe(renderGauge(ctx, 30));
  });

  it('stableId is deterministic and shaped for an XML id', () => {
    expect(stableId('x', 1, 'a')).toBe(stableId('x', 1, 'a'));
    expect(stableId('x', 1, 'a')).not.toBe(stableId('x', 2, 'a'));
    expect(stableId('x', 1)).toMatch(/^x-[a-z0-9]+$/);
  });
});

describe('helpers', () => {
  it.each([
    [1_500_000, 'money', '$1.5m'],
    [12_400, 'money', '$12k'],
    [-320, 'money', '$-320'],
    // 4.55 is not representable in binary and rounds down; asserting the
    // arithmetic as it is rather than as it reads.
    [4.55, 'percent', '4.5%'],
    [42, 'percent', '42%'],
    [12_400, 'plain', '12k'],
  ] as const)('formatAxisValue(%d, %s) = %s', (value, mode, expected) => {
    expect(formatAxisValue(value, mode)).toBe(expected);
  });

  it('minifySvg removes the indentation that markdown reads as a code block', () => {
    expect(minifySvg('<svg>\n    <g>\n      <rect/>\n    </g>\n  </svg>')).toBe('<svg><g><rect/></g></svg>');
  });

  it('withAlpha clamps and keeps two decimals', () => {
    expect(withAlpha('#FFFFFF', 0.5)).toBe('rgba(255,255,255,0.50)');
    expect(withAlpha('#000000', 5)).toBe('rgba(0,0,0,1.00)');
    expect(withAlpha('#000000', -1)).toBe('rgba(0,0,0,0.00)');
  });

  it('chartFigure wraps and minifies, and drops an empty chart entirely', () => {
    const fig = chartFigure(renderInlineSpark(ctx, [1, 2]), 'Trend');
    expect(fig).toContain('class="chart-figure"');
    expect(fig).toContain('<figcaption>Trend</figcaption>');
    expect(fig).not.toMatch(/\n/);
    expect(chartFigure('', 'Trend')).toBe('');
  });
});
