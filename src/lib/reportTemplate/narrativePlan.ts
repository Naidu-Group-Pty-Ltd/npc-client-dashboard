/**
 * The narrative pre-pass: one geometry and one page count per narrative run,
 * derived from the template before its first page is evaluated.
 *
 * ## Why a pre-pass and not the block
 *
 * A master carries the same source on forty conditional pages, each holding
 * one bucket at a different `pageIndex`. The bucket boundaries depend on the
 * first page's box AND the continuation pages' box, and no single instance
 * can see both — so every instance is handed the SAME geometry, computed here
 * from the template as a whole (`narrativeGeometry.pure.ts` says why a
 * boundary that differs between two instances prints a line twice or not at
 * all).
 *
 * ## Why the page count is the renderer's and not the projection's
 *
 * The projection publishes `narrative.pages` without a template in hand —
 * it cannot know whether the document will be set in Noto Serif over 459pt
 * or Inter over 509pt — and the masters gate their continuation pages on
 * that number. With the geometry known, the true count is known, and the
 * renderer overrides the estimate before the conditionals are evaluated: a
 * page the geometry needs is drawn, a page it does not need is not, and the
 * "Not the whole report" notice fires on the count that is actually true.
 * Nothing about this is stored; the projection's estimate still serves
 * every surface that has no template.
 *
 * The pre-pass memoises through `narrativeBuckets`, so the render it makes
 * to count is the render every instance then draws from.
 */
import type { ReportTemplate } from './templateSchema';
import { resolveBindable, type ResolveContext } from './bindingResolver';
import { resolveNarrativeProfile } from '../../../supabase/functions/_shared/reports/markdownPaging.pure';
import {
  narrativeGeometry, type NarrativeBox, type NarrativeGeometry, type PageSize,
} from '../../../supabase/functions/_shared/reports/narrativeGeometry.pure';
import { stripBakedCover } from '../../../supabase/functions/_shared/reports/investment/narrativeClean.pure';
import {
  NARRATIVE_GEOMETRY_KEY, narrativeBindingKey, narrativeBuckets, narrativeChartContext,
} from './blocks/markdownBlockContent';

export interface NarrativePlan {
  /** Geometry per source binding, as the blocks are written (`{{narrative.source}}`). */
  geometry: Record<string, NarrativeGeometry>;
  /** Bucket counts per data path (`narrative` → `narrative.pages`). */
  pages: Record<string, number>;
}

/** A `{{x.y.source}}` binding names the namespace whose `pages` the masters gate on. */
const SOURCE_BINDING = /^\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.source\s*\}\}$/;

/**
 * The body face a markdown block sets, resolved to a family list. A
 * `token:body` prop is the template's own `fonts.body`; a literal is itself;
 * nothing at all inherits the body token, exactly as the rendered container
 * does through `--font-body`.
 */
function bodyFace(prop: unknown, tokens: ResolveContext['tokens']): string | null {
  const fonts = (tokens as { fonts?: Record<string, unknown> } | undefined)?.fonts ?? {};
  const raw = String(prop ?? '').trim();
  if (raw.startsWith('token:')) {
    const key = raw.slice(6).replace(/[^a-zA-Z0-9_-]/g, '');
    const face = fonts[key];
    return typeof face === 'string' ? face : null;
  }
  if (raw) return raw;
  return typeof fonts.body === 'string' ? fonts.body : null;
}

interface Instance {
  box: NarrativeBox;
  page: PageSize;
  index: number;
}

export function planNarrative(template: ReportTemplate, ctxBase: ResolveContext): NarrativePlan | null {
  const data = (ctxBase.data ?? {}) as Record<string, unknown>;
  const reportType = String((data.report as { type?: unknown } | undefined)?.type ?? '');
  const profile = resolveNarrativeProfile(reportType);
  if (!profile?.geometryAware) return null;

  const runs = new Map<string, { first?: Instance; cont?: Instance }>();
  for (const page of template.pages) {
    for (const block of page.blocks) {
      if (block.type !== 'markdown-block') continue;
      const p = block.props as Record<string, unknown>;
      const key = narrativeBindingKey(p);
      if (!key) continue;
      const index = Math.max(0, Number(p.pageIndex ?? 0) || 0);
      const box: NarrativeBox = {
        x: Number(p.x ?? 0) || 0,
        y: Number(p.y ?? 0) || 0,
        width: Number(p.width ?? page.size.width) || page.size.width,
        bodyPt: Number(p.bodySize ?? 9.5) || 9.5,
        lineHeight: Number(p.lineHeight ?? 1.5) || 1.5,
        face: bodyFace(p.bodyFont, ctxBase.tokens),
      };
      const instance: Instance = { box, page: { width: page.size.width, height: page.size.height }, index };
      const run = runs.get(key) ?? {};
      if (index === 0) run.first = run.first ?? instance;
      else if (!run.cont || index < run.cont.index) run.cont = instance;
      runs.set(key, run);
    }
  }
  if (!runs.size) return null;

  const geometry: Record<string, NarrativeGeometry> = {};
  const pages: Record<string, number> = {};
  for (const [key, run] of runs) {
    const first = run.first ?? run.cont;
    if (!first) continue;
    const g = narrativeGeometry(first.box, run.cont?.box ?? null, first.page);
    geometry[key] = g;
    const namespace = SOURCE_BINDING.exec(key)?.[1];
    if (!namespace) continue;
    const source = resolveBindable(key, ctxBase);
    if (!source || !String(source).trim()) continue;
    const clean = stripBakedCover(String(source)).text;
    if (!clean.trim()) continue;
    pages[namespace] = narrativeBuckets(clean, g, narrativeChartContext(ctxBase, g)).length;
  }
  return { geometry, pages };
}

/**
 * The context the render proceeds with: the geometry filed for the blocks,
 * and each run's true page count written over the projection's estimate at
 * `<namespace>.pages`. The caller's data is copied along the path, never
 * mutated.
 */
export function applyNarrativePlan(ctxBase: ResolveContext, plan: NarrativePlan | null): ResolveContext {
  if (!plan) return ctxBase;
  const data = { ...((ctxBase.data ?? {}) as Record<string, unknown>) };
  for (const [namespace, count] of Object.entries(plan.pages)) {
    const parts = namespace.split('.');
    let cursor: Record<string, unknown> = data;
    for (const part of parts) {
      const existing = cursor[part];
      const next = { ...((existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>) };
      cursor[part] = next;
      cursor = next;
    }
    cursor.pages = count;
  }
  const out = { ...ctxBase, data } as ResolveContext & Record<string, unknown>;
  out[NARRATIVE_GEOMETRY_KEY] = plan.geometry;
  return out;
}
