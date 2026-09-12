/**
 * Generic Template Builder routing helper.
 *
 * Resolves a production-capable adapter for the report, resolves the best
 * matching active template, renders through HTML/WeasyPrint, and returns null
 * so callers can fall back to legacy generators whenever routing is not ready.
 */
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { compileTemplateHtmlForPdf } from '@/lib/reportTemplate/compileTemplateForPdf';
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
  /** The resolved template is a jsPDF one; the design system does not draw it. */
  | 'template_not_weasyprint'
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
  template_not_weasyprint: 'The chosen template is not drawn by the design system',
  adapter_published_no_data: 'This record published no data for the template to bind',
  template_schema_invalid: 'The template could not be read against the current schema',
  template_unbound_reconstruction: 'The template is a fixed copy of one report and cannot be reused',
  render_failed: 'The renderer could not produce the document',
  unexpected_error: 'Something went wrong preparing the document',
};

export interface TemplateBuilderRouteResult {
  fileUrl: string;
  fileName: string;
  renderer: 'weasyprint';
  templateId: string;
  source: string;
}

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
  },
): Promise<TemplateBuilderRouteResult | null> {
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
      if (resolved.engine !== 'weasyprint') {
        refuse('template_not_weasyprint',
          `${resolved.template?.name ?? resolved.template?.id} is a ${resolved.engine} template`);
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

      // Through the one compiler, not a second hand-rolled copy of it.
      //
      // This called `preloadImages` and `renderTemplateToHtml` itself, which is
      // exactly the shape `compileTemplateForPdf.ts` was written to retire —
      // and it repeated the omission that module documents. It resolved the
      // rasters (so imported pages were not blank here), but it never set
      // `fontSource: 'container'`, so the HTML carried a Google Fonts
      // `@import` from `tokens.fontFaces` and `render-template-pdf` rejected
      // every document at its resource boundary. That is why the production
      // route rendered nothing at all while the editor's preview of the same
      // template worked: the preview path already went through the compiler.
      let html: string;
      try {
        ({ html } = await compileTemplateHtmlForPdf(schema, {
          data: bindingData,
          customCss: tplRow.custom_css ?? undefined,
          title: `${tplRow.name} — ${routing.title ?? ''}`.trim(),
          cascadeMetadata: true,
        }));
      } catch (e) {
        // Guarded on its own rather than left to the outer catch: a signing or
        // compile failure for one template must fall through to the next
        // candidate adapter, and be reported as the render gate it is instead
        // of as `unexpected_error`. The route's contract is that every failure
        // is a fallback.
        refuse('render_failed',
          `compiling ${tplRow.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const safeLabel = String(routing.fileLabel ?? routing.title ?? routing.reportType ?? 'report')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 60);
      const fileName = `${routing.reportType}-${safeLabel}-${reportId.slice(0, 8)}.pdf`;

      const { data: pdfData, error: pdfErr } = await invokeSecureFunction<{
        url: string;
        fileName: string;
      }>('render-template-pdf', {
        html,
        fileName,
        templateId: tplRow.id,
        mode: 'final',
        // Which record this document IS, so the renderer can refuse to issue
        // one the report itself is not cleared to produce. This route is tried
        // BEFORE the legacy renderer, so a client-readiness gate that only the
        // legacy renderer applied was a gate on the path nobody takes first.
        // The renderer reads the verdict from the row; nothing about the
        // decision travels in this payload.
        reportId,
      });
      if (pdfErr || !pdfData?.url) {
        refuse('render_failed',
          `render-template-pdf failed for ${tplRow.id}: ${pdfErr?.message ?? 'no url returned'}`);
        continue;
      }

      return {
        fileUrl: pdfData.url,
        fileName: pdfData.fileName ?? fileName,
        renderer: 'weasyprint',
        templateId: tplRow.id,
        source: `${resolved.source}:${adapter.reportType}`,
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
