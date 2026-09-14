/**
 * What a `markdown-block` draws — resolved once, for both renderers.
 *
 * The HTML renderer and the browser PDF renderer must draw the SAME bucket of
 * the SAME parse for the same block: a master declares a fixed run of pages
 * each carrying one source at a different `pageIndex`, and each conditional on
 * that bucket existing. If the two sides resolved the profile, the charge
 * model or the directive context differently, one of them would lose the end
 * of a section while the other's page count said it was there — the exact
 * drift `markdownBlock.html.ts`'s header exists to prevent, now prevented by
 * there being one resolution rather than two agreeing ones.
 *
 * What each renderer still owns is how the result is PAINTED: HTML sets it as
 * flowing markup, jsPDF draws it as runs.
 */
import type { Block } from '../templateSchema';
import { resolveBindable, resolveBindableColor, type ResolveContext } from '../bindingResolver';
import {
  renderMarkdown, type MarkdownBlock,
} from '../../../../supabase/functions/_shared/reports/markdown.pure';
import {
  packMarkdownPages, packNarrativeGeometry, packNarrativePages, resolveNarrativeProfile, DEFAULT_LINES_PER_PAGE,
} from '../../../../supabase/functions/_shared/reports/markdownPaging.pure';
import type { NarrativeGeometry } from '../../../../supabase/functions/_shared/reports/narrativeGeometry.pure';
import { stripBakedCover } from '../../../../supabase/functions/_shared/reports/investment/narrativeClean.pure';
import { vizDirectiveRenderer } from '../../../../supabase/functions/_shared/reports/vizFigures.pure';
import { CHART_TARGET_WIDTH_MM, type ChartContext } from '../../../../supabase/functions/_shared/reportDesign/charts.pure';

export { DEFAULT_LINES_PER_PAGE };

/**
 * The template's palette, as a chart context.
 *
 * CSS keywords as fallbacks, the `planningChartContext` convention: every
 * family master defines these tokens, so a keyword only paints where a
 * template is missing its palette — and a keyword is visibly not a palette
 * decision, which also keeps the hex-literal ratchet honest.
 *
 * `widthMm` defaults to the renderer's own width rather than the block's box
 * because the profile path charges the SAME directives the projection charges
 * through `planningChartContext()`, whose width is that default — so both
 * sides charge identical line counts whatever palette each draws with. The
 * geometry path passes the block's real measure instead (`narrativeChartContext`),
 * and its count is computed by the renderer's own pre-pass at that same
 * measure, so the two arithmetics never meet.
 */
export function templateChartContext(ctx: ResolveContext, widthMm: number = CHART_TARGET_WIDTH_MM): ChartContext {
  const tok = (name: string, fallback: string) => resolveBindableColor(`token:${name}`, ctx, fallback);
  const accent = tok('primary', 'darkgoldenrod');
  const ink = tok('ink', 'black');
  const muted = tok('muted', 'grey');
  const positive = tok('positive', 'seagreen');
  const caution = tok('caution', 'darkgoldenrod');
  const negative = tok('negative', 'firebrick');
  return {
    widthMm,
    palette: {
      ground: tok('surface', 'white'),
      groundAlt: tok('panel', 'gainsboro'),
      rule: tok('line', 'silver'),
      ink,
      inkMuted: muted,
      accent,
      accentDeep: tok('accentInk', accent),
      positive,
      caution,
      negative,
      informative: tok('info', accent),
      series: [accent, tok('accentInk', accent), muted, positive, caution, negative],
    },
  };
}

/**
 * ## Why a markdown block pages itself
 *
 * A family master declares every block's height when the template is built.
 * This content has no shape until it is read: across the 565 stored answers the
 * body runs 2,193 characters at the median and 33,377 at the longest, which is
 * about one page and about thirteen.
 *
 * The block therefore renders the whole source, packs the resulting blocks into
 * buckets of `linesPerPage`, and emits bucket `pageIndex`. A master declares a
 * fixed run of pages, each carrying the same source at a different `pageIndex`,
 * and each conditional on that bucket existing — and a conditional page that
 * does not render costs nothing, because `visiblePages` filters before layout.
 * A median answer therefore produces a short document and the longest produces
 * a long one, from one set of masters. This is the Client Details Form pattern.
 *
 * Packing never splits a Markdown block across pages. A table that is taller
 * than one page therefore overflows its bucket rather than being cut in half,
 * which is the lesser of the two wrongs: a split table loses its header and
 * reads as two different tables.
 */
export interface MarkdownBlockContent {
  /** The blocks belonging to this block's `pageIndex`; empty draws nothing. */
  page: readonly MarkdownBlock[];
  /** How many buckets the whole source produced. */
  pageCount: number;
  pageIndex: number;
  linesPerPage: number;
}

/**
 * ## Packing by the template's own geometry
 *
 * The profile's calibrated budgets are one family's arithmetic. When the
 * renderer has the template in hand it derives, once per narrative run, the
 * geometry every instance of that run must pack with — measure, body size,
 * leading, face, and the line capacity of the first and the continuation
 * boxes against the master's own content bottom (`narrativeGeometry.pure.ts`)
 * — and publishes it on the context under `NARRATIVE_GEOMETRY_KEY`, keyed by
 * the block's source binding. An instance that finds its geometry there packs
 * with it; one that does not (a block rendered on its own, a format whose
 * profile is not geometry-aware) packs exactly as before.
 *
 * The buckets are memoised on (source, geometry, palette): a master carries
 * forty instances of the same run and each used to render the whole source
 * again, and the renderer's own pre-pass needs the count before the first
 * page is drawn. One render serves them all.
 */
export const NARRATIVE_GEOMETRY_KEY = '_narrativeGeometry';

export type NarrativeGeometryByBinding = Readonly<Record<string, NarrativeGeometry>>;

/** The binding a markdown block draws, as written — the key its geometry is filed under. */
export function narrativeBindingKey(props: Record<string, unknown>): string {
  return String(props.source ?? props.body ?? '').trim();
}

export function geometryForBlock(block: Block, ctx: ResolveContext): NarrativeGeometry | null {
  const map = (ctx as unknown as Record<string, unknown>)[NARRATIVE_GEOMETRY_KEY] as NarrativeGeometryByBinding | undefined;
  const key = narrativeBindingKey(block.props as Record<string, unknown>);
  return (map && key && map[key]) || null;
}

const MM_PER_PT = 25.4 / 72;
const BUCKET_MEMO = new Map<string, MarkdownBlock[][]>();
const BUCKET_MEMO_LIMIT = 8;

/** The buckets of one source at one geometry, drawn in one palette — memoised. */
export function narrativeBuckets(
  cleanSource: string,
  geometry: NarrativeGeometry,
  chart: ChartContext,
): MarkdownBlock[][] {
  const key = JSON.stringify([geometry, chart]) + '\u0000' + cleanSource;
  const hit = BUCKET_MEMO.get(key);
  if (hit) return hit;
  const blocks = renderMarkdown(cleanSource, {
    geometry,
    renderDirective: vizDirectiveRenderer(chart, geometry),
  }).blocks;
  const pages = packNarrativeGeometry(blocks, geometry);
  if (BUCKET_MEMO.size >= BUCKET_MEMO_LIMIT) {
    const oldest = BUCKET_MEMO.keys().next().value;
    if (oldest !== undefined) BUCKET_MEMO.delete(oldest);
  }
  BUCKET_MEMO.set(key, pages);
  return pages;
}

export function forgetNarrativeBuckets(): void {
  BUCKET_MEMO.clear();
}

/** The chart context a block draws its figures in: the template's palette at the block's own measure. */
export function narrativeChartContext(ctx: ResolveContext, geometry: NarrativeGeometry): ChartContext {
  return templateChartContext(ctx, geometry.widthPt * MM_PER_PT);
}

/** Resolve the packed bucket this block instance is responsible for. */
export function resolveMarkdownBlockContent(
  block: Block, ctx: ResolveContext,
): MarkdownBlockContent | null {
  const p = block.props as Record<string, unknown>;
  const source = resolveBindable(p.source ?? p.body, ctx);
  if (!source || !String(source).trim()) return null;

  const pageIndex = Math.max(0, Number(p.pageIndex ?? 0));
  const linesPerPage = Math.max(1, Number(p.linesPerPage ?? DEFAULT_LINES_PER_PAGE));

  // The calibrated narrative profile, resolved EXACTLY as the projection
  // resolves it (`resolveNarrativeProfile` is the single authority). The
  // profile also carries the baked-cover strip: the projection publishes the
  // stripped source, but a master bound straight at raw content must not
  // disagree with one bound at `narrative.source`.
  const reportType = String((ctx.data as Record<string, any> | undefined)?.report?.type ?? '');
  const profile = resolveNarrativeProfile(reportType);
  const cleanSource = profile ? stripBakedCover(String(source)).text : String(source);

  // The template's own geometry, when the renderer published one for this
  // run. It outranks a hand-tuned `linesPerPage`: that tuning existed to
  // correct a constant model, and the geometry is the page it was correcting
  // towards.
  const geometry = profile?.geometryAware ? geometryForBlock(block, ctx) : null;
  if (geometry) {
    const pages = narrativeBuckets(cleanSource, geometry, narrativeChartContext(ctx, geometry));
    return {
      page: pages[pageIndex] ?? [],
      pageCount: pages.length,
      pageIndex,
      linesPerPage: geometry.contLines,
    };
  }

  const result = renderMarkdown(cleanSource, {
    charging: profile?.charging,
    renderDirective: vizDirectiveRenderer(templateChartContext(ctx)),
  });
  const pages = profile
    ? packNarrativePages(result.blocks, profile, linesPerPage)
    : packMarkdownPages(result.blocks, linesPerPage);

  return {
    page: pages[pageIndex] ?? [],
    pageCount: pages.length,
    pageIndex,
    linesPerPage,
  };
}
