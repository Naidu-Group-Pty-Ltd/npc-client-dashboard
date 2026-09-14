import type { Block } from '../templateSchema';
import { resolveBindable, resolveBindableColor } from '../bindingResolver';
import {
  absBoxStyle, fontFamilyDecl, type HtmlBlockContext,
} from './_shared.html';
import { packMarkdownPages } from '../../../../supabase/functions/_shared/reports/markdownPaging.pure';
import { resolveMarkdownBlockContent, DEFAULT_LINES_PER_PAGE } from './markdownBlockContent';

export { packMarkdownPages, DEFAULT_LINES_PER_PAGE };

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
 * ## Where the paging decision lives
 *
 * Not here. `markdownBlockContent.ts` resolves the profile, renders the
 * source and packs it into buckets, and the browser PDF renderer reads the
 * same module — so the bucket set as markup and the bucket drawn as runs are
 * one decision rather than two that agree.
 */
export function renderMarkdownBlockHtml(block: Block, ctx: HtmlBlockContext): string {
  const p = block.props as Record<string, unknown>;

  const source = resolveBindable(p.source ?? p.body, ctx);
  if (!source || !String(source).trim()) return '';

  // The bucket, the profile, the charge model and the directive context are
  // all resolved by `markdownBlockContent` — the module the browser PDF
  // renderer reads too. Two resolutions of the same block is how one surface
  // comes to draw a bucket the other's page count says does not exist.
  const content = resolveMarkdownBlockContent(block, ctx);
  const page = content?.page ?? [];
  if (!page.length) return '';

  const bodySize = Number(p.bodySize ?? 9.5);
  const lineHeight = Number(p.lineHeight ?? 1.5);
  const color = resolveBindableColor(p.color ?? 'token:text', ctx, '#1A1A1A');
  const headingColor = resolveBindableColor(p.headingColor ?? 'token:primary', ctx, '#BF9B50');
  const ruleColor = resolveBindableColor(p.ruleColor ?? 'token:border', ctx, '#E4E4E7');

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
