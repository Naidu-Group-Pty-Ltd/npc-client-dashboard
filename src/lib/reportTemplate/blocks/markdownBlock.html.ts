import type { Block } from '../templateSchema';
import { resolveBindable, resolveBindableColor } from '../bindingResolver';
import {
  absBoxStyle, fontFamilyDecl, type HtmlBlockContext,
} from './_shared.html';
import { renderMarkdown } from '../../../../supabase/functions/_shared/reports/markdown.pure';
import {
  packMarkdownPages, packNarrativePages, resolveNarrativeProfile, DEFAULT_LINES_PER_PAGE,
} from '../../../../supabase/functions/_shared/reports/markdownPaging.pure';
import { stripBakedCover } from '../../../../supabase/functions/_shared/reports/investment/narrativeClean.pure';

export { packMarkdownPages, DEFAULT_LINES_PER_PAGE };

/**
 * Model-authored Markdown, set as structure.
 *
 * ## Why this block takes source rather than HTML
 *
 * Every other block in this vocabulary escapes its body, and that is what keeps
 * a language model from injecting markup into a document a client receives. A
 * block that accepted rendered HTML would be a hole in
 * `PRODUCTION_SAFE_BLOCK_TYPES` for exactly the content least able to be
 * trusted — and the allow-list is a security boundary, not a formatting one.
 *
 * So this takes **Markdown source** and renders it here. Safety is a property
 * of the renderer rather than of the caller: `_shared/reports/markdown.pure.ts`
 * is escape-first — `escapeHtml` runs at one auditable call before any parsing —
 * so `<script>alert(1)</script>` in the source becomes `&lt;script&gt;` in the
 * page no matter who bound it or what they bound. There is no input to this
 * block that produces markup the model chose. That is why it is safe to add to
 * the allow-list, and it is the whole reason for the extra render.
 *
 * The renderer is the programme's only Markdown implementation, shared with the
 * flowing `render-report-qa-pdf` route. A second one would be a second set of
 * escaping decisions.
 *
 * ## Why it pages itself
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

/**
 * Inline styles onto the tags the renderer emits.
 *
 * No block in this vocabulary emits a `<style>` element and this is not the
 * place to be the first: a scoped stylesheet would have to survive the template
 * renderer, WeasyPrint and the browser QA harness identically, and none of that
 * is established here. Inheritance carries the body face, size, colour and
 * leading from the container; the tags below are the ones that do not inherit
 * what they need.
 *
 * The regex is safe against the content because the HTML being matched is our
 * own renderer's output and every character of model text inside it has already
 * been escaped — `<` in an answer is `&lt;` long before this runs.
 */
function styleTags(html: string, styles: Record<string, string>): string {
  let out = html;
  for (const [tag, style] of Object.entries(styles)) {
    out = out.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>`, 'g'),
      (_m, attrs) => `<${tag}${attrs ?? ''} style="${style}">`,
    );
  }
  return out;
}

export function renderMarkdownBlockHtml(block: Block, ctx: HtmlBlockContext): string {
  const p = block.props as Record<string, unknown>;

  const source = resolveBindable(p.source ?? p.body, ctx);
  if (!source || !String(source).trim()) return '';

  const pageIndex = Math.max(0, Number(p.pageIndex ?? 0));
  const linesPerPage = Math.max(1, Number(p.linesPerPage ?? DEFAULT_LINES_PER_PAGE));

  const bodySize = Number(p.bodySize ?? 9.5);
  const lineHeight = Number(p.lineHeight ?? 1.5);
  const color = resolveBindableColor(p.color ?? 'token:text', ctx, '#1A1A1A');
  const headingColor = resolveBindableColor(p.headingColor ?? 'token:primary', ctx, '#BF9B50');
  const ruleColor = resolveBindableColor(p.ruleColor ?? 'token:border', ctx, '#E4E4E7');

  // The calibrated narrative profile, resolved EXACTLY as the projection
  // resolves it (`resolveNarrativeProfile` is the single authority), so the
  // page count a master's conditionals read and the buckets this block draws
  // are the same arithmetic. The profile also carries the baked-cover strip:
  // the projection publishes the stripped source, but a master bound straight
  // at raw content must not disagree with one bound at `narrative.source`.
  const reportType = String((ctx.data as Record<string, any> | undefined)?.report?.type ?? '');
  const profile = resolveNarrativeProfile(reportType);
  const cleanSource = profile ? stripBakedCover(String(source)).text : String(source);

  const result = renderMarkdown(cleanSource, { charging: profile?.charging });
  const pages = profile
    ? packNarrativePages(result.blocks, profile, linesPerPage)
    : packMarkdownPages(result.blocks, linesPerPage);
  const page = pages[pageIndex];
  if (!page || !page.length) return '';

  const bodyFont = fontFamilyDecl(p.bodyFont, '--font-body');
  const headingFont = fontFamilyDecl(p.headingFont, '--font-heading');

  const html = styleTags(page.map((b) => b.html).join(''), {
    h2: `${headingFont}color:${headingColor};font-size:${(bodySize * 1.5).toFixed(1)}pt;`
      + 'font-weight:600;margin:0 0 6pt;line-height:1.25;',
    h3: `${headingFont}color:${headingColor};font-size:${(bodySize * 1.2).toFixed(1)}pt;`
      + 'font-weight:600;margin:8pt 0 4pt;line-height:1.3;',
    h4: `${headingFont}color:${color};font-size:${bodySize.toFixed(1)}pt;`
      + 'font-weight:700;margin:8pt 0 3pt;line-height:1.3;',
    p: 'margin:0 0 6pt;',
    ul: 'margin:0 0 6pt;padding-left:12pt;',
    ol: 'margin:0 0 6pt;padding-left:12pt;',
    li: 'margin:0 0 2pt;',
    table: `width:100%;border-collapse:collapse;margin:0 0 8pt;font-size:${(bodySize * 0.92).toFixed(1)}pt;`,
    th: `text-align:left;padding:3pt 4pt;border-bottom:0.75pt solid ${ruleColor};`
      + `color:${headingColor};font-weight:600;`,
    td: `padding:3pt 4pt;border-bottom:0.5pt solid ${ruleColor};vertical-align:top;`,
    blockquote: `margin:0 0 6pt;padding-left:8pt;border-left:1.5pt solid ${ruleColor};`,
    pre: `margin:0 0 6pt;padding:5pt;background:rgba(0,0,0,0.03);font-size:${(bodySize * 0.85).toFixed(1)}pt;`
      + 'white-space:pre-wrap;',
  });

  const box = absBoxStyle(p, { x: 40, y: 120, w: 515 });
  const container = `${box};${bodyFont}font-size:${bodySize}pt;line-height:${lineHeight};`
    + `color:${color};`;

  return `<div style="${container}">${html}</div>`;
}
