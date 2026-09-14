/**
 * The presentation layer's one entry point: a validated report plus the
 * template chosen for its format, drawn in the browser.
 *
 * Resolves a production-capable adapter for the report, resolves the chosen or
 * best-matching active template, renders it through the Report Presentation
 * Renderer, and returns null so callers fall back to the standard presentation
 * whenever this is not ready.
 *
 * ## The template never becomes a second source of truth
 *
 * `adapter.buildBindingContext` produces ONE frozen payload describing the
 * report after generation, calculation, reconciliation, validation and the
 * user's own edits. Everything below binds against that payload and nothing
 * else: no calculation runs here, no geography is resolved, no model is
 * called and nothing is fetched from a source table. One validated report,
 * several approved presentations.
 *
 * ## Two renderers, chosen by the caller
 *
 * The same validated payload and the same template can be drawn two ways:
 *
 *  * `browser` — the Report Presentation Renderer (jsPDF), in this tab.
 *    Instant, free, and limited: it embeds no fonts (every face becomes
 *    Helvetica), draws no block the registry marks partial, and cannot draw
 *    text on a filled panel legibly. It is the PREVIEW.
 *  * `weasyprint` — the same template compiled to print HTML and rendered by
 *    the pinned engine through `render-template-pdf`. Every declared typeface
 *    embedded, every block the HTML renderer knows, the document stored where
 *    a portal can serve it. It is the FINAL client document, and it is asked
 *    for only by a deliberate final action (RV-1, 14 Sep 2026).
 *
 * Nothing above the renderer changes with the choice: one adapter, one frozen
 * payload, one template, the same guards. Only the last step differs.
 */
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { SUPABASE_URL } from '@/integrations/supabase/env';
import { preloadImagesWithReport } from '@/lib/reportTemplate/imagePreloader';
import { renderTemplateToBlob } from '@/lib/reportTemplate/pdfRenderer';
import { judgeBrowserProductionExport } from '@/lib/reportTemplate/browserExportGuard';
import { compileTemplateHtmlForPdf } from '@/lib/reportTemplate/compileTemplateForPdf';
import { renderFinalHtmlToPdf } from '@/lib/reportTemplate/weasyRenderClient';
import { getBlockRendererCapabilities } from '@/lib/reportTemplate/blocks';
import { parseTemplate } from '@/lib/reportTemplate/templateSchema';
import { resolveReportTemplate, type ReportVariant } from '@/lib/reportTemplate/resolveTemplate';
import { refuseUnboundReconstruction } from '@/lib/reportTemplate/rendering/productionTemplateGuard';
import { getAdapter, listAdapters, type ReportTemplateAdapter } from '@/lib/reportTemplate/adapters';
import { isSelectableTemplate } from '@/lib/reportTemplate/templateSelection';

/**
 * Why the templated document was not produced.
 *
 * The route answers `null` for eight distinct reasons and, until this existed,
 * said the same nothing for all of them: the caller fell back to the legacy
 * generator, which on the migrated formats is itself a well-typeset WeasyPrint
 * document, so "your template rendered" and "your template was skipped" looked
 * identical from the outside AND from the console. Diagnosing one refusal cost
 * a production ledger query and a round trip.
 *
 * Named here so a person can be told which gate closed, in the toast, on the
 * first attempt rather than the third.
 */
export type TemplateRouteRefusal =
  /** No production adapter claims this report type. */
  | 'no_adapter'
  /** The adapter cannot serve this record — unreadable, or nothing to draw. */
  | 'adapter_declined_record'
  /** The report type is outside the caller's allow-list (the Compass pilot). */
  | 'report_type_not_allowed'
  /** Nothing active is published for the format, and nothing was chosen. */
  | 'no_active_template'
  /**
   * The renderer cannot draw one of this template's blocks, so the document
   * would carry a placeholder panel where a client expects content.
   *
   * This used to be `template_not_weasyprint` and was decided by the
   * template's `engine` column — a fact about which service had been chosen
   * for it, not about whether it can be drawn. Compatibility is asked of the
   * renderer itself now (`judgeBrowserProductionExport`), which is the only
   * thing that actually knows.
   */
  | 'template_not_browser_renderable'
  /** The HTML renderer has no drawing for one of this template's blocks. */
  | 'template_not_renderable'
  /** The adapter loaded the record but published nothing bindable. */
  | 'adapter_published_no_data'
  /** The template's schema does not parse against the current contract. */
  | 'template_schema_invalid'
  /** A static copy of one client's report; see `productionTemplateGuard`. */
  | 'template_unbound_reconstruction'
  /** WeasyPrint, storage or the signed URL failed. */
  | 'render_failed'
  /** Anything unforeseen; the message is in the console. */
  | 'unexpected_error';

/** Human wording for a refusal, for the person who chose a template. */
export const TEMPLATE_ROUTE_REFUSAL_TEXT: Readonly<Record<TemplateRouteRefusal, string>> = {
  no_adapter: 'This report format has no design-system pipeline yet',
  adapter_declined_record: 'This record could not be read, or holds nothing this format can draw',
  report_type_not_allowed: 'This report type is not routed through the design system here',
  no_active_template: 'No active template is published for this format',
  template_not_browser_renderable: 'The chosen template uses layout blocks this renderer cannot draw yet',
  template_not_renderable: 'The chosen template uses a layout block no renderer can draw',
  adapter_published_no_data: 'This record published no data for the template to bind',
  template_schema_invalid: 'The template could not be read against the current schema',
  template_unbound_reconstruction: 'The template is a fixed copy of one report and cannot be reused',
  render_failed: 'The renderer could not produce the document',
  unexpected_error: 'Something went wrong preparing the document',
};

export type TemplateRenderer = 'browser' | 'weasyprint';

export interface TemplateBuilderRouteResult {
  /** The document itself. */
  blob: Blob;
  fileName: string;
  /**
   * What actually drew it. A literal is how telemetry comes to claim a
   * renderer the product stopped using, so this is the renderer's own
   * identifier rather than a string written here.
   */
  renderer: typeof BROWSER_PRESENTATION_RENDERER | typeof WEASYPRINT_FINAL_RENDERER;
  templateId: string;
  source: string;
  /**
   * Where the render service stored the document, when one did. A browser
   * render has none: the blob exists only in this tab until a caller stores
   * it. A final render is stored by the service and this names it, so a
   * publish reuses the bytes already on disk rather than uploading a copy.
   */
  storagePath: string | null;
}

/**
 * Named once, and imported by anything that reports which engine drew a file.
 *
 * It is NOT the same identity as the standard presentation's. Both draw in the
 * browser, and they are different renderers drawing different documents —
 * `investmentPdfDocument` composes the standard document with pdf-lib, this
 * draws a chosen template with jsPDF. Telemetry has one question to answer:
 * which renderer produced these exact bytes. One name for two answers is how
 * that question stops being answerable.
 */
export const BROWSER_PRESENTATION_RENDERER = 'browser_template_jspdf' as const;

/**
 * The final client document's renderer: the pinned WeasyPrint engine behind
 * `render-template-pdf`. Named once, here, beside the preview renderer it is
 * chosen instead of.
 */
export const WEASYPRINT_FINAL_RENDERER = 'weasyprint_final' as const;

function candidateAdapters(reportType?: string | null): ReportTemplateAdapter[] {
  const explicit = getAdapter(reportType);
  if (explicit) return [explicit];
  return listAdapters().filter((adapter) => adapter.supportsProduction);
}

/**
 * The template the person chose, when they chose one.
 *
 * Read back from the server rather than trusted from the caller: the id
 * travelled through the browser, and the row it names has to still be active
 * and still belong to this format. `manage-templates` applies its own read
 * scope on top, so a caller cannot fetch a template they may not see.
 *
 * Returns null — never throws and never substitutes — when the selection no
 * longer applies. The caller then resolves by ranking exactly as it did before
 * selections existed, which is also what the picker has already told the user
 * is happening (`status: 'unavailable'`).
 */
async function loadSelectedTemplate(
  templateId: string, reportType: string,
): Promise<any | null> {
  try {
    const { data, error } = await invokeSecureFunction('manage-templates', {
      operation: 'get',
      table: 'report_templates',
      recordId: templateId,
    });
    const row = (data as any)?.record;
    if (error || !row) {
      console.warn('[routeReportThroughTemplate] selected template unreadable', error);
      return null;
    }
    if (!isSelectableTemplate(row, reportType)) {
      console.warn(
        `[routeReportThroughTemplate] selected template ${templateId} no longer applies to `
        + `${reportType} (active=${row.is_active}, type=${row.report_type}) — falling back to ranking`,
      );
      return null;
    }
    return row;
  } catch (e) {
    console.warn('[routeReportThroughTemplate] selected template lookup failed', e);
    return null;
  }
}

export async function routeReportThroughTemplate(
  reportId: string,
  opts?: {
    agencyId?: string | null;
    userId?: string | null;
    brand?: any;
    reportType?: string | null;
    allowedReportTypes?: readonly string[];
    /**
     * The format's own sub-selection — which scenario, tier or edition of the
     * document this is. Read four times below and, until now, declared nowhere:
     * `tryRouteThroughTemplateBuilderFor` has always passed it and the property
     * has always arrived, so the omission was invisible at runtime and only a
     * type check would ever have found it.
     */
    variant?: string | null;
    /**
     * The template the person chose for this format, if they have chosen one.
     *
     * An explicit choice beats the ranking — that is the whole point of a
     * choice. It is still validated against the format and re-read from the
     * server (`loadSelectedTemplate`), and a choice that no longer applies
     * falls back to the ranking rather than failing the generation.
     */
    templateId?: string | null;
    /**
     * The caller's own reviewed data, for the adapter that documents it
     * (`payload` on `ReportTemplateAdapter`). Passed through verbatim; the
     * adapter validates it exactly as it validates a stored row.
     */
    payload?: Record<string, unknown> | null;
    /**
     * Told which gate closed, when one does. The route still answers `null` —
     * every failure is a fallback and never an error — but the caller can now
     * say *why* instead of "it could not be applied".
     */
    onRefusal?: (refusal: TemplateRouteRefusal) => void;
    /**
     * Which engine draws the document. `browser` (the default) is the preview
     * renderer in this tab; `weasyprint` is the FINAL client document, asked
     * for by a deliberate final action and never by a preview, an edit or a
     * page load. See the module header.
     */
    renderer?: TemplateRenderer;
  },
): Promise<TemplateBuilderRouteResult | null> {
  const renderer: TemplateRenderer = opts?.renderer ?? 'browser';
  // The last gate reached, so a caller hears about the furthest the route got
  // rather than about the first adapter that was not asked.
  let refusedAt: TemplateRouteRefusal = 'no_adapter';
  const refuse = (reason: TemplateRouteRefusal, detail: string): void => {
    refusedAt = reason;
    console.warn(`[routeReportThroughTemplate] ${reason}: ${detail}`);
  };
  try {
    for (const adapter of candidateAdapters(opts?.reportType)) {
      if (!adapter.supportsProduction) continue;

      const routing = await adapter.resolveRoutingContext({
        reportId,
        variant: opts?.variant ?? null,
        payload: opts?.payload ?? null,
      });
      if (!routing?.reportType) {
        refuse('adapter_declined_record',
          `${adapter.reportType} could not resolve routing for ${reportId}`);
        continue;
      }
      if (opts?.allowedReportTypes && !opts.allowedReportTypes.includes(routing.reportType.toLowerCase())) {
        refuse('report_type_not_allowed', `${routing.reportType} is outside this caller's allow-list`);
        continue;
      }

      const selected = opts?.templateId
        ? await loadSelectedTemplate(opts.templateId, routing.reportType)
        : null;

      const resolved = selected
        ? { template: selected, engine: (selected.engine ?? 'jspdf') as 'jspdf' | 'weasyprint', source: 'selected' }
        : await resolveReportTemplate({
          reportType: routing.reportType,
          variant: routing.variant as ReportVariant | null,
          agencyId: opts?.agencyId ?? null,
          userId: opts?.userId ?? null,
        });
      if (!resolved) {
        refuse('no_active_template', `nothing active is published for ${routing.reportType}`);
        continue;
      }
      const tplRow = resolved.template;
      // The same variant the routing call received: the two answers must
      // describe one document, and the adapter is the one that knows whether
      // the variant means anything for its format.
      const ctx = await adapter.buildBindingContext({
        reportId,
        variant: opts?.variant ?? null,
        brand: opts?.brand,
        payload: opts?.payload ?? null,
      });
      // Null is every adapter's way of saying "I cannot produce a document
      // from this record" — no stored projection, a conversation with no
      // answer in it, one of nine reads that errored — and its documented
      // consequence is the legacy generator.
      //
      // This read `ctx?.data ?? {}` and carried on. An unresolved binding
      // renders as the empty string rather than as a visible `{{…}}`, so the
      // refusal did not produce an error or a blank page: it produced the
      // whole document with every field empty, uploaded it, and returned it as
      // a success — which also meant the caller never fell back, because it
      // had a URL. A client would have received a report of blank tables under
      // their own letterhead. Falling through here is what makes the adapters'
      // "returns null rather than a document full of blanks" true of the
      // pipeline and not only of the adapter.
      // An empty context is refused on the same ground rather than on a
      // separate one: every adapter publishes at least `report` and `brand`,
      // so there is no record for which `{}` is the right answer, and it
      // renders identically to the null case.
      if (!ctx?.data || Object.keys(ctx.data).length === 0) {
        refuse('adapter_published_no_data',
          `${adapter.reportType} declined report ${reportId}; falling back to its legacy generator`);
        continue;
      }
      const bindingData = ctx.data;

      // Parsed inside the loop's own guard: a schema that does not satisfy the
      // current contract is this template's problem, not the request's, and it
      // used to throw past every remaining gate into the outer catch — where
      // it was indistinguishable from a network failure.
      let schema: ReturnType<typeof parseTemplate>;
      try {
        schema = parseTemplate(tplRow.schema);
      } catch (e) {
        refuse('template_schema_invalid',
          `${tplRow.name ?? tplRow.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // A template that is a static copy of one client's report will render
      // that client's report for everybody, with only the title substituted.
      // That shipped for two months; see `productionTemplateGuard`. Refusing
      // here falls back to the legacy generator, which is wrong-looking rather
      // than wrong.
      const unbound = refuseUnboundReconstruction(schema);
      if (unbound) {
        refuse('template_unbound_reconstruction',
          `refusing template ${tplRow.id} (${tplRow.name}): ${unbound.reason}`);
        continue;
      }

      /*
       * Compatibility is asked of the RENDERER, not of a column.
       *
       * The gate here used to be `engine !== 'weasyprint'`, which is a record
       * of which service a template was authored for rather than a fact about
       * whether it can be drawn. What matters to a client is that no page
       * carries a placeholder panel where content belongs, and only the block
       * registry knows that. `judgeBrowserProductionExport` refuses, names the
       * blocks for the operator, and never falls back to a render service or
       * to a raster — both of which would ship a worse document quietly.
       */
      if (renderer === 'browser') {
        const drawable = judgeBrowserProductionExport(schema);
        if (drawable.ok === false) {
          refuse('template_not_browser_renderable',
            `${tplRow.name ?? tplRow.id}: ${drawable.blockTypes.join(', ')}`);
          continue;
        }
      } else {
        // The HTML renderer draws every block the browser one does and the
        // ones it marks partial; only a type with no renderer at all is
        // refused, on the same ground: a page with a hole in it is worse than
        // the standard document.
        const undrawable = [...new Set(
          schema.pages.flatMap((p) => (p.blocks ?? []).map((b) => String((b as { type?: unknown }).type ?? '')))
            .filter((t) => t && getBlockRendererCapabilities(t).html === 'unsupported'),
        )];
        if (undrawable.length) {
          refuse('template_not_renderable', `${tplRow.name ?? tplRow.id}: ${undrawable.join(', ')}`);
          continue;
        }
      }

      const safeLabel = String(routing.fileLabel ?? routing.title ?? routing.reportType ?? 'report')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 60);
      const fileName = `${routing.reportType}-${safeLabel}-${reportId.slice(0, 8)}.pdf`;

      let blob: Blob;
      let storagePath: string | null = null;
      try {
        if (renderer === 'weasyprint') {
          /*
           * The FINAL document. The template is compiled to print HTML by the
           * same compiler every design-system render goes through — assets
           * resolved to what the engine may fetch, fonts sourced from the
           * container — and handed to the pinned engine in `final` mode, which
           * stores the PDF and answers its path. Nothing is recalculated,
           * re-narrated or re-decided here: the payload is the one built above.
           */
          const compiled = await compileTemplateHtmlForPdf(schema, { data: bindingData });
          const rendered = await renderFinalHtmlToPdf({
            html: compiled.html,
            fileName,
            mode: 'final',
            reportId,
            reportType: adapter.reportType,
            templateId: tplRow.id,
            templateName: tplRow.name ?? null,
            pageCount: schema.pages.length,
          });
          blob = rendered.blob;
          storagePath = rendered.path;
        } else {
          /*
           * Assets are resolved through the same module the HTML path uses, in
           * `inline` mode because this renderer cannot fetch: jsPDF draws from
           * the bytes it is handed. The other half of that module's rule
           * travels with it — an asset that cannot be brought inside is DROPPED
           * and named rather than carried in, so one unreachable picture thins
           * a page instead of failing the document.
           */
          const { template: prepared } = await preloadImagesWithReport(schema, {
            mode: 'inline',
            data: bindingData,
            tokens: undefined,
            supabaseUrl: SUPABASE_URL,
          });
          blob = renderTemplateToBlob(prepared, { data: bindingData });
        }
      } catch (e) {
        // Guarded on its own rather than left to the outer catch: a failure
        // drawing one template must fall through to the next candidate adapter
        // and be reported as the render gate it is. The route's contract is
        // that every failure is a fallback.
        refuse('render_failed',
          `drawing ${tplRow.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // A zero-byte document is not a document. It would save as a file that
      // opens to an error, which is worse than the standard presentation.
      if (!blob.size) {
        refuse('render_failed', `${tplRow.id} produced an empty document`);
        continue;
      }

      return {
        blob,
        fileName,
        renderer: renderer === 'weasyprint' ? WEASYPRINT_FINAL_RENDERER : BROWSER_PRESENTATION_RENDERER,
        templateId: tplRow.id,
        source: `${resolved.source}:${adapter.reportType}`,
        storagePath,
      };
    }

    opts?.onRefusal?.(refusedAt);
    return null;
  } catch (e) {
    console.warn('[routeReportThroughTemplate] unexpected error, falling back', e);
    opts?.onRefusal?.('unexpected_error');
    return null;
  }
}
