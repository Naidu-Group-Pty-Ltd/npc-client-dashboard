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
  packMarkdownPages, packNarrativePages, resolveNarrativeProfile, DEFAULT_LINES_PER_PAGE,
} from '../../../../supabase/functions/_shared/reports/markdownPaging.pure';
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
 * `widthMm` is deliberately the renderer's own default rather than derived
 * from the block's box: the projection charges the SAME directives through
 * `planningChartContext()`, whose width is that default, and `figureLines`
 * reads geometry alone — so both sides charge identical line counts whatever
 * palette each draws with. A width computed from the box would put the page
 * count and the buckets on different arithmetic.
 */
export function templateChartContext(ctx: ResolveContext): ChartContext {
  const tok = (name: string, fallback: string) => resolveBindableColor(`token:${name}`, ctx, fallback);
  const accent = tok('primary', 'darkgoldenrod');
  const ink = tok('ink', 'black');
  const muted = tok('muted', 'grey');
  const positive = tok('positive', 'seagreen');
  const caution = tok('caution', 'darkgoldenrod');
  const negative = tok('negative', 'firebrick');
  return {
    widthMm: CHART_TARGET_WIDTH_MM,
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
