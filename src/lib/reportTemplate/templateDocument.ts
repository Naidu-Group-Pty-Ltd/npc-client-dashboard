/**
 * "Is there an activated template for this document?" — asked once, the same
 * way, by every format's delivery path.
 *
 * ## What this is for
 *
 * Nine adapters can turn a stored record into a templated PDF, and for a year
 * exactly one surface could ask for one: `PremiumPdfButton`, for Compass
 * investment reports. Every other format's fifty masters could be designed,
 * previewed, seeded and activated, and no button in the product would ever
 * render one. This is the call that closes that gap, and it belongs in the
 * `deliver*` modules rather than in the buttons because that is where every
 * surface for a format already meets — the download, the email attachment, the
 * blob a broker portal uploads.
 *
 * ## It is inert until somebody activates a template
 *
 * `resolveReportTemplate` matches only *active* `report_templates` rows, so on
 * a deployment with nothing activated this costs one lookup and answers null,
 * and the format's existing route runs exactly as it does today. That is the
 * designed switch, and it is what every adapter's `legacyFallback` text
 * promises: "the legacy generator remains the default until a template is
 * activated for this report type".
 *
 * ## Every failure is a fallback, never an error
 *
 * A refused adapter, no active template, a render that failed, a signed URL
 * that would not fetch: all of them answer `null`, because the caller's next
 * line is the route that has produced this document for the life of the
 * product. A templated document is an improvement on a working path, so it may
 * never be the reason somebody cannot get their file.
 */
import { toast } from 'sonner';
import { tryRouteThroughTemplateBuilderFor } from './compassRoute';
import {
  TEMPLATE_ROUTE_REFUSAL_TEXT,
  type TemplateRouteRefusal,
} from './routeReportThroughTemplate';
import {
  fetchTemplateSelections,
  normaliseReportType,
  selectionsByFormat,
} from './templateSelection';

export interface TemplateDocument {
  blob: Blob;
  fileName: string;
  /** Which template rendered it, for the caller that wants to say. */
  templateId: string;
}

/**
 * The template this person chose for this format, if they chose one.
 *
 * ## Why this is looked up here rather than passed in
 *
 * The picker lists **every** format the adapter registry knows, and its own
 * words are "a choice is kept for every report of that format until it is
 * changed here". Only `PremiumPdfButton` ever passed the chosen id, so on the
 * other eight formats a selection was stored, displayed as selected, and then
 * ignored by the thing it was a choice about — the UI promising something the
 * generator did not do, which is worse than not offering the choice.
 *
 * Threading the id through eight `deliver*` signatures would have fixed the
 * surfaces that remembered to pass it and left the same hole open for the
 * email, attachment and portal paths that do not use the picker's hook. Asking
 * here means the choice is honoured wherever a document is produced, which is
 * what the picker says happens.
 *
 * Not cached: a person who changes their template and generates again expects
 * the new one, and one edge call against a download that already takes seconds
 * is the cheaper side of that trade. A failed read answers null and the format
 * resolves by ranking, exactly as it did before selections existed.
 */
async function selectedTemplateFor(reportType: string): Promise<string | null> {
  try {
    const rows = await fetchTemplateSelections();
    const key = normaliseReportType(reportType);
    return selectionsByFormat(rows).get(key)?.template_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this person has chosen a template for the format.
 *
 * For the callers that bypass the template path on purpose (the capacity
 * report's analysis refresh) and owe the person a notice only when there is a
 * choice being bypassed.
 */
export async function hasTemplateSelection(reportType: string): Promise<boolean> {
  return (await selectedTemplateFor(reportType)) !== null;
}

/**
 * Save it the way a browser saves files, for a caller that has no `deliver*`
 * module of its own to do it.
 *
 * The revoke is on a delay rather than in a `finally`, because Safari cancels
 * an in-flight download when the URL disappears underneath it — the same
 * reason every `deliver*` module in the programme delays its own.
 */
export function saveTemplateDocument(doc: TemplateDocument): void {
  const url = URL.createObjectURL(doc.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The person chose a template and this document was not produced with it.
 *
 * Said out loud, once, at the moment it happens — the same rule the picker
 * keeps for a stale selection (`unavailable`, never a silent fallback). Before
 * this notice, every fall-through was invisible: the migrated formats' own
 * composers produce a perfectly typeset document, so "your choice was ignored"
 * and "your choice was honoured" looked identical from the outside, and the
 * only way to find out was to notice the design was not the one you picked.
 *
 * The document still downloads either way — the notice is a warning beside a
 * working file, never an error in place of one.
 */
export function notifySelectionNotUsed(detail?: string): void {
  toast.warning('Your chosen template was not used for this document', {
    description: `${detail ?? 'It could not be applied to this record'}. `
      + 'The document was produced with the standard layout instead.',
  });
}

/**
 * The templated document for this record, or null to carry on as before.
 *
 * `reportId` is nullable for the callers that may not have one — a Borrowing
 * Capacity Snapshot can be asked for without naming an assessment, and there is
 * no stored record for an adapter to read in that case.
 */
export async function tryTemplateDocument(
  reportType: string,
  reportId: string | null | undefined,
  opts?: {
    variant?: string | null;
    /**
     * The caller's own reviewed data, for the one adapter contract that takes
     * it (the 10 Year Cash Flow — see `payload` on `ReportTemplateAdapter`).
     */
    payload?: Record<string, unknown> | null;
  },
): Promise<TemplateDocument | null> {
  /*
   * No record, no template — but say so when a choice is being dropped.
   *
   * This returned null before reading the selection at all, so a format whose
   * caller had no id skipped the template path in complete silence: the legacy
   * composer produced a well-typeset document and nothing anywhere said the
   * chosen template had not been used. Every Borrowing Capacity surface in the
   * product builds its request as `{ clientId, clientName }` with no
   * `assessmentId`, so that format's selector was inert on every download —
   * which is how it was reported: "the template selector isn't working".
   *
   * The notice is the same one every other fall-through gets, and it is still
   * a warning beside a working file rather than an error in place of one.
   */
  if (!reportId) {
    if (await hasTemplateSelection(reportType)) {
      notifySelectionNotUsed('This document was produced without naming a saved record');
    }
    return null;
  }

  const selectedId = await selectedTemplateFor(reportType);
  // Which gate closed, when one does — so the notice below names the cause
  // rather than saying the same thing for every one of them.
  let refusal: TemplateRouteRefusal | null = null;
  try {
    const routed = await tryRouteThroughTemplateBuilderFor(reportType, reportId, {
      variant: opts?.variant ?? null,
      onRefusal: (reason) => { refusal = reason; },
      // The person's own answer to "which template does this format come out
      // in", honoured here so that every surface gets it rather than only the
      // ones that remembered to ask. See `selectedTemplateFor`.
      templateId: selectedId,
      payload: opts?.payload ?? null,
    });
    if (!routed?.blob) {
      if (selectedId) {
        notifySelectionNotUsed(refusal ? TEMPLATE_ROUTE_REFUSAL_TEXT[refusal] : undefined);
      }
      return null;
    }

    // The route fell back to the ranking — the choice went stale between the
    // picker and the download, or names a template this record cannot use.
    // The resolved template still renders, so the document is delivered; the
    // difference is that this one is said out loud.
    if (selectedId && routed.templateId !== selectedId) {
      toast.warning('Your chosen template no longer applies', {
        description: 'This document was produced with the default template for the format. '
          + 'Open the template chooser to pick another.',
      });
    }

    /*
     * The document is here. It used to be a signed URL this fetched back from
     * the storage bucket a render service had written it to — one more hop, one
     * more thing to be unreachable, and a second place that had to agree the
     * file was not empty. The renderer runs in this tab now, so the blob it
     * produced is the blob that is delivered, and the emptiness check lives
     * once, beside the render.
     */
    return { blob: routed.blob, fileName: routed.fileName, templateId: routed.templateId };
  } catch {
    if (selectedId) notifySelectionNotUsed();
    return null;
  }
}
