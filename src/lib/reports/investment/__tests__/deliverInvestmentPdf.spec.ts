/**
 * The investment delivery chain: template first, the browser's own renderer
 * behind it, one implementation for every surface. Behavioural, with the
 * engines mocked — what is pinned is the ORDER and what publish stores.
 *
 * RC-3.1 replaced the second engine. It was `render-investment-report-pdf`,
 * which composed HTML and handed it to WeasyPrint on Cloud Run; it is
 * `generateInvestmentPdfBlob` now, the pdf-lib implementation that has drawn
 * almost every Investment PDF this product has delivered. The contract around
 * it — template wins, something always draws, the result names its engine, one
 * upload through one broker — is unchanged, and that is what these pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/secureInvoke', () => ({ invokeSecureFunction: vi.fn() }));
vi.mock('@/lib/reportTemplate/templateDocument', () => ({
  tryTemplateDocument: vi.fn(),
  saveTemplateDocument: vi.fn(),
}));
vi.mock('@/lib/reports/investment/investmentPdfDocument', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/reports/investment/investmentPdfDocument',
  );
  return { ...actual, generateInvestmentPdfBlob: vi.fn() };
});
vi.mock('@/lib/reports/investment/investmentPdfSource', () => ({
  loadInvestmentReportForPdf: vi.fn(),
  projectRowForPdf: vi.fn(() => ({ report: { id: 'r-1' }, reportTier: 'compass' })),
}));
vi.mock('@/hooks/useSecureStorage', () => ({ secureStorageUpload: vi.fn() }));

import { invokeSecureFunction } from '@/lib/secureInvoke';
import { saveTemplateDocument, tryTemplateDocument } from '@/lib/reportTemplate/templateDocument';
import {
  generateInvestmentPdfBlob,
  BROWSER_PDF_RENDERER,
} from '@/lib/reports/investment/investmentPdfDocument';
// Two browser renderers, two identities: telemetry has to answer WHICH one
// produced these exact bytes, and one name for both answers ends that.
import { BROWSER_PRESENTATION_RENDERER } from '@/lib/reportTemplate/routeReportThroughTemplate';
import { loadInvestmentReportForPdf } from '@/lib/reports/investment/investmentPdfSource';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import {
  deliverInvestmentPdf,
  produceInvestmentDocument,
  publishInvestmentPdf,
} from '@/lib/reports/investment/deliverInvestmentPdf';

const invoke = vi.mocked(invokeSecureFunction);
const tryTemplate = vi.mocked(tryTemplateDocument);
const draw = vi.mocked(generateInvestmentPdfBlob);
const loadRow = vi.mocked(loadInvestmentReportForPdf);
const upload = vi.mocked(secureStorageUpload);
const save = vi.mocked(saveTemplateDocument);

const pdfBlob = (content = '%PDF-1.7 test') => new Blob([content], { type: 'application/pdf' });

beforeEach(() => {
  vi.resetAllMocks();
  /*
   * The record is read ONCE, before a presentation is chosen, because the
   * client-readiness gate and the two content rules both apply above that
   * choice. Every test here therefore needs a row — a template-path test that
   * supplied none used to pass by never reading one.
   */
  loadRow.mockResolvedValue({
    id: 'r-1',
    report_content: '# 1. Summary\n\nThe property was purchased for $700,000.\n',
    validation_flags: [],
  } as never);
});

describe('produceInvestmentDocument', () => {
  it('the chosen/ranked template wins, and nothing else is drawn', async () => {
    tryTemplate.mockResolvedValue({ blob: pdfBlob(), fileName: 'doc.pdf', templateId: 't-1' });

    const doc = await produceInvestmentDocument('r-1', { variant: 'briefing' });

    expect(doc.engine).toBe(BROWSER_PRESENTATION_RENDERER);
    expect(doc.templateId).toBe('t-1');
    // The route is handed the report's presented content — the record's own
    // Markdown with the operator's content rules already applied — so the
    // template draws the same sections the standard presentation would.
    expect(tryTemplate).toHaveBeenCalledWith('investment', 'r-1', {
      variant: 'briefing',
      payload: { reportContent: expect.stringContaining('$700,000') },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
  });

  it('draws the standard document in the browser when no template applies', async () => {
    tryTemplate.mockResolvedValue(null);
    draw.mockResolvedValue({
      blob: pdfBlob(), fileName: 'r-1_Cowra_NSW_1.pdf',
      suburb: 'Cowra', state: 'NSW', renderer: BROWSER_PDF_RENDERER,
    });

    const doc = await produceInvestmentDocument('r-1');

    expect(doc.engine).toBe(BROWSER_PDF_RENDERER);
    expect(doc.templateId).toBeNull();
    expect(doc.fileName).toBe('r-1_Cowra_NSW_1.pdf');
    // The row is read through the broker, and the drawing happens here — no
    // render route is invoked at all.
    expect(loadRow).toHaveBeenCalledWith('r-1');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a report that cannot be read is an error, not an empty document', async () => {
    tryTemplate.mockResolvedValue(null);
    loadRow.mockRejectedValue(new Error('The report could not be read.'));

    await expect(produceInvestmentDocument('r-1')).rejects.toThrow(/could not be read/i);
    expect(draw).not.toHaveBeenCalled();
  });

  it('an empty drawing is a failure, not a document', async () => {
    tryTemplate.mockResolvedValue(null);
    loadRow.mockResolvedValue({ id: 'r-1' } as any);
    draw.mockResolvedValue({
      blob: new Blob([], { type: 'application/pdf' }), fileName: 'x.pdf',
      suburb: '', state: '', renderer: BROWSER_PDF_RENDERER,
    });

    await expect(produceInvestmentDocument('r-1')).rejects.toThrow(/empty/i);
  });

  it('refuses to run without a report id', async () => {
    await expect(produceInvestmentDocument('')).rejects.toThrow(/report is required/i);
    expect(tryTemplate).not.toHaveBeenCalled();
  });
});

describe('deliverInvestmentPdf', () => {
  it('produces and saves the same bytes', async () => {
    const blob = pdfBlob();
    tryTemplate.mockResolvedValue({ blob, fileName: 'doc.pdf', templateId: 't-1' });

    await deliverInvestmentPdf('r-1');

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ blob, fileName: 'doc.pdf' }));
  });
});

describe('publishInvestmentPdf', () => {
  it('uploads a template document and records the path through the broker', async () => {
    tryTemplate.mockResolvedValue({ blob: pdfBlob(), fileName: 'My Doc (v2).pdf', templateId: 't-1' });
    upload.mockResolvedValue({ success: true, path: 'stored/My-Doc-v2.pdf' } as any);
    invoke.mockResolvedValue({ data: { success: true }, error: null } as any);

    const published = await publishInvestmentPdf('r-1');

    expect(published).toMatchObject({ path: 'stored/My-Doc-v2.pdf', engine: BROWSER_PRESENTATION_RENDERER, templateId: 't-1' });
    expect(upload).toHaveBeenCalledWith(
      'investment-reports',
      expect.stringContaining('r-1_'),
      expect.any(Blob),
      expect.objectContaining({ contentType: 'application/pdf', upsert: true, resourceId: 'r-1' }),
    );
    expect(invoke).toHaveBeenCalledWith('manage-investment-reports', expect.objectContaining({
      action: 'update',
      reportId: 'r-1',
      data: { pdf_url: 'stored/My-Doc-v2.pdf' },
    }));
  });

  it('uploads a browser-drawn document too — there is no persisted path to reuse', async () => {
    // The shortcut this replaces read `pdf_url` back, because the server route
    // had already written it. Nothing writes a render behind our back now, so
    // reading it back could only return whichever render happened to run last.
    tryTemplate.mockResolvedValue(null);
    loadRow.mockResolvedValue({ id: 'r-1' } as any);
    draw.mockResolvedValue({
      blob: pdfBlob(), fileName: 'r-1_Cowra_NSW_1.pdf',
      suburb: 'Cowra', state: 'NSW', renderer: BROWSER_PDF_RENDERER,
    });
    upload.mockResolvedValue({ success: true, path: 'r-1_123_r-1_Cowra_NSW_1.pdf' } as any);
    invoke.mockResolvedValue({ data: { success: true }, error: null } as any);

    const published = await publishInvestmentPdf('r-1');

    expect(published).toMatchObject({
      path: 'r-1_123_r-1_Cowra_NSW_1.pdf', engine: BROWSER_PDF_RENDERER,
    });
    expect(upload).toHaveBeenCalled();
    // One write, through the one broker every client write uses.
    expect(invoke).toHaveBeenCalledWith('manage-investment-reports', expect.objectContaining({
      action: 'update',
      reportId: 'r-1',
      data: { pdf_url: 'r-1_123_r-1_Cowra_NSW_1.pdf' },
    }));
  });

  it('a failed upload is an error the caller hears about', async () => {
    tryTemplate.mockResolvedValue({ blob: pdfBlob(), fileName: 'doc.pdf', templateId: 't-1' });
    upload.mockResolvedValue({ success: false, error: 'bucket said no' } as any);

    await expect(publishInvestmentPdf('r-1')).rejects.toThrow('bucket said no');
  });

  it('bookkeeping failure never fails a published document', async () => {
    tryTemplate.mockResolvedValue({ blob: pdfBlob(), fileName: 'doc.pdf', templateId: 't-1' });
    upload.mockResolvedValue({ success: true, path: 'p.pdf' } as any);
    invoke.mockRejectedValue(new Error('broker down'));

    const published = await publishInvestmentPdf('r-1');
    expect(published.path).toBe('p.pdf');
  });
});
