/**
 * The narrative pre-pass: one geometry per run, one true page count, and both
 * renderers on it.
 *
 * A master carries the same source on a run of conditional pages, each
 * gated on `narrative.pages > n` and each drawing one bucket. The projection
 * publishes that count without a template in hand; the renderer knows the
 * template, computes the geometry every instance must pack with, and writes
 * the count that is actually true over the estimate before the first
 * conditional is read.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplateToHtml } from '../htmlRenderer';
import { applyNarrativePlan, planNarrative } from '../narrativePlan';
import { parseTemplate } from '../templateSchema';
import {
  NARRATIVE_GEOMETRY_KEY, forgetNarrativeBuckets, narrativeBuckets, narrativeChartContext, resolveMarkdownBlockContent,
} from '../blocks/markdownBlockContent';
import type { NarrativeGeometry } from '../../../../supabase/functions/_shared/reports/narrativeGeometry.pure';
import { stripBakedCover } from '../../../../supabase/functions/_shared/reports/investment/narrativeClean.pure';
import { renderMarkdownBlockHtml } from '../blocks/markdownBlock.html';

const PARA = 'The property sits within an established residential pocket rather than in the immediate town centre, '
  + 'giving it a balanced blend of convenience and traditional house-and-yard living, with mature streetscapes. ';
/** About twenty pages of prose at a 9.5pt Noto Serif measure. */
const LONG = Array.from({ length: 70 }, (_, i) => `## Section ${i + 1}\n\n${PARA.repeat(6)}\n\n- One point\n- Another point\n`).join('\n');

const RUN = 12;
const markdown = (pageIndex: number, y: number) => ({
  id: `md-${pageIndex}`,
  type: 'markdown-block',
  props: {
    source: '{{narrative.source}}', pageIndex, linesPerPage: 34,
    bodySize: 9.5, bodyFont: 'token:body', headingFont: 'token:heading', lineHeight: 1.55,
    x: 68, y, width: 459,
  },
});
const page = (id: string, blocks: unknown[], conditional?: string) => ({
  id, name: id, size: { width: 595, height: 842 }, ...(conditional ? { conditional } : {}), blocks,
});

const template = () => ({
  version: 1,
  name: 'Narrative probe',
  tokens: {
    colors: { ink: '#111', surface: '#fff', primary: '#2F4858', text: '#111', muted: '#666', border: '#ddd', line: '#ccc', bg: '#eee', panel: '#f4f4f4' },
    fonts: { body: 'Noto Serif, serif', heading: 'Noto Serif, serif' },
    spacing: {},
  },
  slots: {},
  pages: [
    page('cover', [{ id: 'c', type: 'text-block', props: { x: 40, y: 200, width: 500, body: 'Cover' } }]),
    page('report-1', [markdown(0, 199)], 'narrative && narrative.source'),
    ...Array.from({ length: RUN - 1 }, (_, i) => page(`report-${i + 2}`, [markdown(i + 1, 114)], `narrative && narrative.pages > ${i + 1}`)),
    page('cut', [{ id: 'n', type: 'text-block', props: { x: 68, y: 114, width: 459, body: 'Not the whole report' } }], `narrative && narrative.pages > ${RUN}`),
  ],
});

const data = (source: string, estimate: number) => ({
  report: { type: 'investment' },
  narrative: { source, pages: estimate },
});

const pagesOf = (html: string) => html.match(/class="tpl-page tpl-page-\d+"/g) ?? [];

describe('planNarrative', () => {
  it('derives one geometry per run from the first and continuation boxes, and the true page count', () => {
    forgetNarrativeBuckets();
    const tpl = parseTemplate(template());
    const ctx = { data: data(LONG, 1), tokens: tpl.tokens };
    const plan = planNarrative(tpl, ctx);
    expect(plan).not.toBeNull();
    const g = plan!.geometry['{{narrative.source}}'];
    expect(g.bodyPt).toBe(9.5);
    expect(g.widthPt).toBe(459);
    expect(g.firstPageLines).toBeLessThan(g.contLines);
    // The projection said one page; the geometry knows better.
    expect(plan!.pages.narrative).toBeGreaterThan(5);
  });

  it('does nothing for a format that is not on a geometry-aware profile', () => {
    const tpl = parseTemplate(template());
    expect(planNarrative(tpl, { data: { report: { type: 'qa' }, narrative: { source: LONG } }, tokens: tpl.tokens })).toBeNull();
  });

  it('writes the count over the estimate without touching the caller\'s data', () => {
    const tpl = parseTemplate(template());
    const input = data(LONG, 1);
    const ctx = { data: input, tokens: tpl.tokens };
    const out = applyNarrativePlan(ctx, planNarrative(tpl, ctx));
    expect((out.data as { narrative: { pages: number } }).narrative.pages).toBeGreaterThan(5);
    expect(input.narrative.pages).toBe(1);
    expect((out as unknown as Record<string, unknown>)[NARRATIVE_GEOMETRY_KEY]).toBeDefined();
  });
});

describe('the render draws what the geometry counts', () => {
  it('draws exactly the pages the buckets fill, whatever the projection estimated', () => {
    forgetNarrativeBuckets();
    const tpl = template();
    const low = renderTemplateToHtml(tpl, { data: data(LONG, 1) });
    const high = renderTemplateToHtml(tpl, { data: data(LONG, 40) });
    expect(pagesOf(low.html)).toHaveLength(pagesOf(high.html).length);
    // The cover plus exactly the pages the geometry counted.
    const parsed = parseTemplate(tpl);
    const seed = { data: data(LONG, 1), tokens: parsed.tokens };
    const counted = planNarrative(parsed, seed)!.pages.narrative;
    expect(counted).toBeGreaterThan(RUN);
    // The template reserves RUN pages for the run; past that the cut notice is drawn.
    expect(pagesOf(low.html)).toHaveLength(1 + RUN + 1);
    expect(low.html).toContain('Not the whole report');
  });

  it('every instance packs the SAME buckets — no line is drawn twice or lost between pages', () => {
    forgetNarrativeBuckets();
    const tpl = parseTemplate(template());
    const seed = { data: data(LONG, 1), tokens: tpl.tokens };
    const ctx = applyNarrativePlan(seed, planNarrative(tpl, seed));
    const instances = tpl.pages.flatMap((p) => p.blocks).filter((b) => b.type === 'markdown-block');
    const contents = instances.map((b) => resolveMarkdownBlockContent(b, ctx)!);
    const counts = new Set(contents.map((c) => c.pageCount));
    expect(counts.size).toBe(1);
    // Concatenating every bucket gives the memoised run's blocks once, in order.
    const drawn = contents.flatMap((c) => c.page.map((b) => b.html));
    const g = (ctx as unknown as Record<string, unknown>)[NARRATIVE_GEOMETRY_KEY] as Record<string, NarrativeGeometry>;
    const run = narrativeBuckets(stripBakedCover(LONG).text, g['{{narrative.source}}'], narrativeChartContext(ctx, g['{{narrative.source}}']));
    expect(run.length).toBe(counts.values().next().value);
    // The instances cover the first RUN buckets of the run, in order, exactly once.
    expect(drawn).toEqual(run.slice(0, instances.length).flat().map((b) => b.html));
  });

  it('the cut notice fires only on the true count', () => {
    forgetNarrativeBuckets();
    const tpl = template();
    // A source short enough for one page: the estimate says 41, the geometry says 1.
    const { html } = renderTemplateToHtml(tpl, { data: data(PARA.repeat(3), 41) });
    expect(html).not.toContain('Not the whole report');
    expect(pagesOf(html)).toHaveLength(2);
  });

  it('the block draws the compact figure at the compact width with the block\'s own margins', () => {
    forgetNarrativeBuckets();
    const tpl = parseTemplate(template());
    const source = `${PARA}\n\n{{gauge: value=72 max=100 label="Location & Property Fit" caption="A home in a stable regional township"}}\n\n${PARA}`;
    const seed = { data: data(source, 1), tokens: tpl.tokens };
    const ctx = applyNarrativePlan(seed, planNarrative(tpl, seed));
    const block = tpl.pages[1].blocks[0];
    const html = renderMarkdownBlockHtml(block, { ...ctx, page: { width: 595, height: 842 }, pageIndex: 0, pages: [], slots: {} } as never);
    expect(html).toContain('<figure class="chart-figure chart-compact" style="margin:6pt 0 8pt;width:60.5%;">');
    expect(html).toContain('<img class="chart-img"');
    expect(html).toContain('style="display:block;width:100%;height:auto;"');
  });
});
