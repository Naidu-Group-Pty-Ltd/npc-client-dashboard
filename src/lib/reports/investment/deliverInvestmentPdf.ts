/**
 * Getting the Investment report into someone's hands — download, send, or
 * portal — as ONE document, produced ONE way.
 *
 * ## What this replaces
 *
 * The audit (F11/F12) measured the highest-volume format delivering three
 * different artefacts depending on which control was pressed:
 *
 *  * the report page's PRIMARY "Download" saved the markdown as a `.txt`;
 *  * "Send to Client" published whatever `pdf_url` held — written by the
 *    legacy server route *or* the browser html2canvas generator, whichever
 *    ran last — or minted a fresh browser raster on the spot;
 *  * only `PremiumPdfButton`, low in a collapsible panel, produced the real
 *    chain: chosen template → a render service.
 *
 * That chain — the person's template selection honoured first, a standard
 * document as the fallback — was correct and lived inside one button. It
 * lives here now, and every surface (the primary download, the send, the
 * premium button, the flatten copy) asks this module, so a client receives
 * the same document the operator reviewed.
 *
 * ## One report, two presentations
 *
 * The record is read once and checked for client readiness once, and only
 * then is a presentation chosen: the template the person selected for this
 * format, or the standard one. Both draw the SAME validated report, both draw
 * it in this browser, and neither is a second version of the document — which
 * is why the readiness gate sits above both rather than inside either.
 *
 * ## Every failure is a fallback, never an error — until there is nothing
 *
 * A refused template, no selection, a stale choice, a template carrying a
 * block this renderer cannot draw: the standard presentation still renders
 * (`tryTemplateDocument`'s own contract). Only when neither can produce the
 * document does this throw, with the message in front of the person who
 * clicked. A report that is not client-ready is the one exception: it is
 * refused rather than fallen back from, because the defect is in the report.
 *
 * ## Coverage
 *
 * Both presentations are drawn here, so neither leaves a server-side trace to
 * be counted: `engine` on the returned document is what a render event
 * records, and it names the renderer that actually drew the bytes rather than
 * a service that no longer runs.
 *
 * ## `pdf_url` has one meaning now
 *
 * "The storage path of the most recent standard-delivery document." Every
 * write goes through the `manage-investment-reports` broker, and after
 * `publishInvestmentPdf` the row points at the exact bytes that were just
 * published to a portal — because nothing else persists a render any more.
 */
import { invokeSecureFunction } from '@/lib/secureInvoke';
import {
  saveTemplateDocument,
  tryTemplateDocument,
} from '@/lib/reportTemplate/templateDocument';
import { BROWSER_PRESENTATION_RENDERER } from '@/lib/reportTemplate/routeReportThroughTemplate';
import {
  generateInvestmentPdfBlob,
  BROWSER_PDF_RENDERER,
} from '@/lib/reports/investment/investmentPdfDocument';
import {
  loadInvestmentReportForPdf,
  projectRowForPdf,
} from '@/lib/reports/investment/investmentPdfSource';
import { assertInvestmentReportClientReady } from '@/lib/reports/investment/clientReadiness';
import {
  applyPresentationOptionsToContent,
  resolvePresentationOptions,
  type InvestmentPresentationOptions,
} from '@/lib/reports/investment/presentationOptions';
import { loadInvestmentHeroImages } from '@/lib/reports/investment/investmentHeroImages';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import type { PdfDesignOptions } from '@/components/reports/premiumPdfDesign';

export interface InvestmentDocument {
  blob: Blob;
  fileName: string;
  /**
   * Which renderer produced these exact bytes.
   *
   * Two browser renderers, two identities, because they draw two different
   * documents: `browser_pdf_lib` is the standard presentation composed with
   * pdf-lib, `browser_template_jspdf` is a chosen template drawn by the Report
   * Presentation Renderer. Neither is a render service — `legacy_server` and
   * `premium_weasyprint` named one that no longer runs, and a telemetry value
   * naming a retired service is worse than none, because it is read as
   * evidence.
   */
  engine: typeof BROWSER_PRESENTATION_RENDERER | typeof BROWSER_PDF_RENDERER;
  /** The template that rendered it, when the template engine did. */
  templateId: string | null;
}

export interface ProduceInvestmentOptions extends Partial<InvestmentPresentationOptions> {
  /** The report's variant (financial / briefing / snapshot), for the adapter. */
  variant?: string | null;
  designOptions?: PdfDesignOptions;
}


/**
 * The document, template-first.
 *
 * Throws only when no engine could produce it; the message is the one the
 * failing engine gave.
 */
export async function produceInvestmentDocument(
  reportId: string,
  options: ProduceInvestmentOptions = {},
): Promise<InvestmentDocument> {
  if (!reportId) throw new Error('A report is required to produce the document.');

  /*
   * The record is read ONCE, before a presentation is chosen, and the
   * client-readiness gate is applied to it.
   *
   * That gate used to live inside `render-template-pdf` and
   * `render-investment-report-pdf` — two render services, both now off this
   * path. Applying it here restores it to the template route and extends it to
   * the standard one, which never had it: a report that asserts a governed
   * fact it does not hold is refused whichever presentation it would have come
   * out in, because the defect is in the report and not in the layout.
   *
   * The read is not wasted on the template path: `tryTemplateDocument`'s
   * adapter reads the same row again, and one extra call is the price of a
   * gate that cannot be skipped by choosing a template.
   */
  const row = await loadInvestmentReportForPdf(reportId);
  assertInvestmentReportClientReady(row);

  /*
   * The five controls, resolved once and applied once.
   *
   * Two of them — Sources and Scoring — decide what the report CONTAINS, and
   * the other three decide what is DRAWN. The content rules are applied to the
   * report's own Markdown here, above the choice of presentation, so a chosen
   * template and the standard document agree about which sections belong in
   * this client's copy. They were inside the standard generator before, which
   * meant a report delivered through a template carried its source notes and
   * its scoring sections however the switches were set. See
   * `presentationOptions.ts` for why the two kinds are kept apart.
   *
   * Nothing here recalculates, re-scores or re-narrates anything. A section
   * that is not included is not printed; every figure in every section that IS
   * printed is the figure the record holds.
   */
  const presentation = resolvePresentationOptions(options);
  const presentedRow = {
    ...row,
    report_content: applyPresentationOptionsToContent(
      typeof row.report_content === 'string' ? row.report_content : '',
      presentation,
    ),
  };

  const heroImages = presentation.includeHeroImages
    ? await loadInvestmentHeroImages(reportId)
    : [];

  const templated = await tryTemplateDocument('investment', reportId, {
    variant: options.variant ?? null,
    // The SAME payload the standard presentation would draw. The adapter reads
    // the record itself for everything else; this is the one thing the
    // operator's switches changed, so it is the one thing that travels.
    payload: { reportContent: presentedRow.report_content },
  });
  if (templated) {
    return {
      blob: templated.blob,
      fileName: templated.fileName,
      engine: BROWSER_PRESENTATION_RENDERER,
      templateId: templated.templateId,
    };
  }

  // The standard document, drawn HERE.
  //
  // This used to POST to `render-investment-report-pdf`, which composed HTML
  // and handed it to WeasyPrint on Cloud Run. The drawing is now
  // `investmentPdfDocument` — the same pdf-lib implementation that produced
  // 263 of the 275 Investment PDFs this product has delivered — so the
  // document reaches a client without leaving the browser and Supabase.
  //
  // The projection is shared with `ClientPDFGenerator` rather than repeated,
  // because it is where stored financials are healed and an historic row's
  // overrides are overlaid. One transform, one set of numbers.
  const { report, reportTier } = projectRowForPdf(presentedRow);
  const drawn = await generateInvestmentPdfBlob({
    report,
    reportTier,
    presentation,
    heroImages,
  });
  if (!drawn.blob.size) throw new Error('The rendered PDF was empty.');
  return {
    blob: drawn.blob,
    fileName: drawn.fileName,
    engine: drawn.renderer,
    templateId: null,
  };
}

/** Produce and save to the browser's downloads. */
export async function deliverInvestmentPdf(
  reportId: string,
  options: ProduceInvestmentOptions = {},
): Promise<InvestmentDocument> {
  const doc = await produceInvestmentDocument(reportId, options);
  saveTemplateDocument({ blob: doc.blob, fileName: doc.fileName, templateId: doc.templateId ?? '' });
  return doc;
}

const STORAGE_BUCKET = 'investment-reports';


/**
 * Record the published path on the row, through the one broker every client
 * write uses. Best-effort: the document is already published; failing the
 * caller over bookkeeping would un-send nothing.
 */
async function rememberInvestmentPdfPath(reportId: string, path: string): Promise<void> {
  try {
    await invokeSecureFunction('manage-investment-reports', {
      action: 'update',
      reportId,
      data: { pdf_url: path },
    });
  } catch (err) {
    console.warn('[deliverInvestmentPdf] could not record pdf_url:', err);
  }
}

export interface PublishedInvestmentPdf {
  /** Path in the `investment-reports` bucket — what a portal row stores. */
  path: string;
  engine: InvestmentDocument['engine'];
  templateId: string | null;
  /**
   * The bytes that were stored.
   *
   * Carried back so a caller that both publishes and hands the file to the
   * person can do it from ONE render. The alternative is producing the
   * document twice, or downloading back what was just uploaded — and the
   * second copy is the one that can differ.
   */
  blob: Blob;
  fileName: string;
}

/**
 * Produce the document and make it a stored artefact a portal can serve.
 *
 * Every document is uploaded here and recorded through the same broker, and
 * the returned path IS what `pdf_url` names.
 *
 * There used to be a shortcut: the server route persisted its own render and
 * wrote the path to the row, so this read it back rather than uploading the
 * same bytes twice. Nothing persists a render behind our back any more — the
 * document is drawn in this browser and exists only as a Blob until it is
 * stored — so the shortcut is gone rather than left to return a stale path
 * from whichever render happened to run last.
 */
export async function publishInvestmentPdf(
  reportId: string,
  options: ProduceInvestmentOptions = {},
): Promise<PublishedInvestmentPdf> {
  const doc = await produceInvestmentDocument(reportId, options);

  const safeName = doc.fileName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const path = `${reportId}_${Date.now()}_${safeName}`;
  const upload = await secureStorageUpload(STORAGE_BUCKET, path, doc.blob, {
    contentType: 'application/pdf',
    upsert: true,
    resourceId: reportId,
  });
  if (!upload.success) {
    throw new Error(upload.error || 'The document rendered but could not be stored.');
  }
  const storedPath = upload.path || path;
  await rememberInvestmentPdfPath(reportId, storedPath);
  return {
    path: storedPath,
    engine: doc.engine,
    templateId: doc.templateId,
    blob: doc.blob,
    fileName: doc.fileName,
  };
}
