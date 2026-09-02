import { format } from 'date-fns';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import { fetchLatestBorrowingCapacity } from '@/lib/fetchLatestBorrowingCapacity';
import { generateBorrowingCapacityPDF } from '@/components/borrowing-capacity/BorrowingCapacityPDFReport';
import { snapshotBlob } from '@/lib/reports/borrowingCapacity/deliverSnapshot';
import {
  PORTAL_REPORT_TYPE,
  publishVerdict,
  type UnifiedReport,
} from './clientReportInventory.pure';

/**
 * Putting a report the workspace already produced in front of the client.
 *
 * There are two surfaces that do this — the paper-plane on a Reports row and
 * the picker inside "Publish Report to Portal" — and this is the one thing
 * both of them call. Two copies of "what publishing means" is how one of them
 * comes to write a row the portal cannot serve.
 *
 * The rule that shapes it: **a generated report is pointed at, never copied.**
 * The PDF already sits in storage, and a second copy would double the bytes
 * and, worse, silently diverge the moment the report is regenerated. The one
 * exception is the borrowing capacity assessment, which genuinely has no
 * document until somebody asks for one — publishing renders it, and that is
 * declared as `on_publish` before the operator commits rather than discovered
 * as a failure afterwards.
 *
 * The reference is normalised through `parseStorageRef` before it is written.
 * `storageRef.ts` records four shapes these columns have been written in, two
 * of them absolute URLs and one pointing at a `/object/public/` route on a
 * bucket that is private — and the row action published whatever it found.
 * A portal row built on one of those looks healthy in every register here and
 * fails on the client's click.
 */

export interface PublishRequest {
  report: UnifiedReport;
  clientId: string;
  clientName: string;
  /** What the client sees. Defaults to the report's own name. */
  title?: string;
  /** Overrides the type derived from the report. */
  reportType?: string;
  notes?: string | null;
  /** Told about progress on the one path that renders a document. */
  onProgress?: (message: string) => void;
}

/**
 * One shape rather than a discriminated union: this project compiles with
 * `strictNullChecks: false`, where narrowing on a boolean discriminant does
 * not happen, so `if (!outcome.ok)` would not give a caller access to
 * `error`. A single interface with optional fields reads the same at every
 * call site and actually compiles.
 */
export interface PublishOutcome {
  ok: boolean;
  storagePath?: string;
  generated?: boolean;
  error?: string;
}

export async function publishReportToPortal(req: PublishRequest): Promise<PublishOutcome> {
  const { report, clientId, clientName, onProgress } = req;

  // The same verdict the picker rendered. Asking it again here is deliberate:
  // the surface decides what to OFFER, this decides what to DO, and a stale
  // list must not be able to publish something that has since become
  // unpublishable.
  const verdict = publishVerdict(report, new Map());

  let storagePath = verdict.storagePath;
  let generated = false;

  if (verdict.readiness === 'unavailable') {
    return { ok: false, error: verdict.reason };
  }

  if (verdict.readiness === 'on_publish' && report.source === 'portfolio_report') {
    // Audit item 6: a stored analysis whose PDF upload failed in the 403 era
    // has `report_data` and no file. `portfolioReviewBlob` was left waiting
    // for exactly this caller — the typeset review as bytes, rendered
    // server-side from the stored analysis, with no download side effect.
    // Rendered on each publish rather than stamped back onto the analysis
    // row: its file column is the LEGACY generator's, and
    // `deliverPortfolioReview`'s own rule is that a renderer the person did
    // not choose is never substituted under another one's name.
    onProgress?.('Producing the typeset review…');
    try {
      const { portfolioReviewBlob } = await import('./portfolio/deliverPortfolioReview');
      const review = await portfolioReviewBlob({
        variant: 'server',
        request: { reportId: report.id },
      });

      const safeName = clientName.replace(/[^a-zA-Z0-9]/g, '_');
      const dateStr = format(new Date(), 'yyyy-MM-dd_HHmmss');
      const uploadPath = `portal-reports/${clientId}/Portfolio_Analysis_${safeName}_${dateStr}.pdf`;

      onProgress?.('Uploading…');
      const uploadResult = await secureStorageUpload('client-files', uploadPath, review.blob, {
        contentType: 'application/pdf',
        upsert: true,
        resourceId: clientId,
      });
      if (!uploadResult.success) {
        return { ok: false, error: 'Failed to upload PDF: ' + (uploadResult.error ?? 'unknown error') };
      }

      storagePath = uploadResult.path || uploadPath;
      generated = true;
    } catch (err: any) {
      return { ok: false, error: 'Failed to produce the review: ' + (err?.message || 'Unknown error') };
    }
  } else if (verdict.readiness === 'on_publish') {
    onProgress?.('Generating the PDF…');
    try {
      const { latestAssessment, incomeSources, liabilities, expenses, properties, client } =
        await fetchLatestBorrowingCapacity(clientId);

      if (!latestAssessment) {
        return { ok: false, error: 'No borrowing capacity assessment found. Calculate capacity first.' };
      }

      // The only path that does not hand the file to the browser: it uploads
      // to the portal prefix instead. `snapshotBlob` keeps that contract — a
      // blob and a filename, produced with no download side effect — while
      // giving this path the same renderer as every button beside it.
      const result = await snapshotBlob({
        variant: 'server',
        request: { clientId, clientName },
        legacy: () =>
          generateBorrowingCapacityPDF({
            clientId,
            clientName,
            assessment: latestAssessment,
            incomeSources,
            liabilities,
            expenses,
            properties,
            client,
            returnBlob: true,
          }),
      });

      if (!result?.blob) return { ok: false, error: 'PDF generation failed' };

      const safeName = clientName.replace(/[^a-zA-Z0-9]/g, '_');
      const dateStr = format(new Date(), 'yyyy-MM-dd_HHmmss');
      const uploadPath = `portal-reports/${clientId}/Borrowing_Capacity_${safeName}_${dateStr}.pdf`;

      onProgress?.('Uploading…');
      const uploadResult = await secureStorageUpload('client-files', uploadPath, result.blob, {
        contentType: 'application/pdf',
        upsert: true,
        resourceId: clientId,
      });
      if (!uploadResult.success) {
        return { ok: false, error: 'Failed to upload PDF: ' + (uploadResult.error ?? 'unknown error') };
      }

      storagePath = uploadResult.path || uploadPath;
      generated = true;
    } catch (err: any) {
      return { ok: false, error: 'Failed to generate PDF: ' + (err?.message || 'Unknown error') };
    }
  }

  if (!storagePath) {
    return { ok: false, error: 'No document available to publish.' };
  }

  try {
    const { error } = await invokeSecureFunction('manage-client-data', {
      operation: 'create',
      table: 'client_portal_reports',
      clientId,
      data: {
        report_title: req.title?.trim() || report.name,
        report_type: req.reportType || PORTAL_REPORT_TYPE[report.type] || 'investment',
        storage_path: storagePath,
        notes: req.notes ?? (report.propertyAddress ? `Property: ${report.propertyAddress}` : null),
        published_at: new Date().toISOString(),
      },
    });
    if (error) throw error;
    return { ok: true, storagePath, generated };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}
