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
 *    chain: chosen template → legacy WeasyPrint route.
 *
 * That chain — the person's template selection honoured first, the route
 * that has produced this document for the life of the product as the
 * fallback — was correct and lived inside one button. It lives here now, and
 * every surface (the primary download, the send, the premium button, the
 * flatten copy) asks this module, so a client receives the same document the
 * operator reviewed.
 *
 * ## Every failure is a fallback, never an error — until there is nothing
 *
 * A refused template, no selection, a stale choice: the legacy route still
 * renders (`tryTemplateDocument`'s own contract). Only when BOTH engines
 * fail does this throw, with the message in front of the person who clicked.
 *
 * ## Coverage
 *
 * Neither leg logs here: the template route writes `template_render_jobs`
 * server-side, and the legacy invoke is auto-tagged by `secureInvoke`
 * (engine `legacy_server`). A manual event would double-count.
 *
 * ## `pdf_url` has one meaning now
 *
 * "The storage path of the most recent standard-delivery document." Every
 * write goes through the `manage-investment-reports` broker (this module and
 * the legacy generator's own upload path both use it) or the legacy route's
 * internal bookkeeping — and after `publishInvestmentPdf`, the row points at
 * the exact bytes that were just published to a portal.
 */
import { invokeSecureFunction } from '@/lib/secureInvoke';
import {
  saveTemplateDocument,
  tryTemplateDocument,
} from '@/lib/reportTemplate/templateDocument';
import { fetchPdfBlob } from '@/lib/pdf/downloadPdf';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import type { PdfDesignOptions } from '@/components/reports/premiumPdfDesign';

export interface InvestmentDocument {
  blob: Blob;
  fileName: string;
  /** Which machinery produced the bytes. */
  engine: 'template' | 'legacy_server';
  /** The template that rendered it, when the template engine did. */
  templateId: string | null;
}

export interface ProduceInvestmentOptions {
  /** The report's variant (financial / briefing / snapshot), for the adapter. */
  variant?: string | null;
  /** Legacy-route presentation switches, forwarded untouched. */
  includeCharts?: boolean;
  includeHeroImages?: boolean;
  includeSparklines?: boolean;
  designOptions?: PdfDesignOptions;
}

interface LegacyRenderResponse {
  fileUrl: string;
  fileName: string;
  renderer?: string;
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

  const templated = await tryTemplateDocument('investment', reportId, {
    variant: options.variant ?? null,
  });
  if (templated) {
    return {
      blob: templated.blob,
      fileName: templated.fileName,
      engine: 'template',
      templateId: templated.templateId,
    };
  }

  const { data, error } = await invokeSecureFunction<LegacyRenderResponse>(
    'render-investment-report-pdf',
    {
      reportId,
      includeCharts: options.includeCharts ?? true,
      includeHeroImages: options.includeHeroImages ?? false,
      includeSparklines: options.includeSparklines ?? true,
      designOptions: options.designOptions,
    },
    { timeoutMs: 240_000 },
  );
  if (error || !data?.fileUrl) {
    throw new Error(error?.message || 'PDF generation failed');
  }
  const blob = await fetchPdfBlob(data.fileUrl);
  if (!blob.size) throw new Error('The rendered PDF was empty.');
  return {
    blob,
    fileName: data.fileName || `investment-report-${reportId}.pdf`,
    engine: 'legacy_server',
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

/** True for a stored storage path (as opposed to an external URL or nothing). */
const isStoragePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/^https?:\/\//i.test(value);

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
}

/**
 * Produce the document and make it a stored artefact a portal can serve.
 *
 * The legacy route persists its own render and records the path on the row,
 * so that path is reused rather than uploading the same bytes twice; a
 * template render (and the route's external-URL fallback) is uploaded here
 * and recorded through the same broker. Either way the returned path IS what
 * `pdf_url` now names.
 */
export async function publishInvestmentPdf(
  reportId: string,
  options: ProduceInvestmentOptions = {},
): Promise<PublishedInvestmentPdf> {
  const doc = await produceInvestmentDocument(reportId, options);

  if (doc.engine === 'legacy_server') {
    // The route's WeasyPrint leg has just written the persisted path to the
    // row; read it back rather than re-uploading the same document.
    try {
      const { data } = await invokeSecureFunction('get-investment-reports', {
        reportId,
        listOptions: { select: 'id, pdf_url' },
      });
      const stored = (data?.report as { pdf_url?: unknown } | undefined)?.pdf_url;
      if (isStoragePath(stored)) {
        return { path: stored, engine: doc.engine, templateId: null };
      }
    } catch {
      // Fall through to uploading the bytes we already hold.
    }
  }

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
  return { path: storedPath, engine: doc.engine, templateId: doc.templateId };
}
