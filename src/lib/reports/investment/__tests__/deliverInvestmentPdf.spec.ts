/**
 * The investment delivery chain: template first, legacy route fallback, one
 * implementation for every surface. Behavioural, with the engines mocked —
 * what is pinned is the ORDER, the forwarding, and what publish stores.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/secureInvoke', () => ({ invokeSecureFunction: vi.fn() }));
vi.mock('@/lib/reportTemplate/templateDocument', () => ({
  tryTemplateDocument: vi.fn(),
  saveTemplateDocument: vi.fn(),
}));
vi.mock('@/lib/pdf/downloadPdf', () => ({ fetchPdfBlob: vi.fn() }));
vi.mock('@/hooks/useSecureStorage', () => ({ secureStorageUpload: vi.fn() }));

import { invokeSecureFunction } from '@/lib/secureInvoke';
import { saveTemplateDocument, tryTemplateDocument } from '@/lib/reportTemplate/templateDocument';
import { fetchPdfBlob } from '@/lib/pdf/downloadPdf';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import {
  deliverInvestmentPdf,
  produceInvestmentDocument,
  publishInvestmentPdf,
} from '@/lib/reports/investment/deliverInvestmentPdf';

const invoke = vi.mocked(invokeSecureFunction);
const tryTemplate = vi.mocked(tryTemplateDocument);
const fetchBlob = vi.mocked(fetchPdfBlob);
const upload = vi.mocked(secureStorageUpload);
const save = vi.mocked(saveTemplateDocument);

const pdfBlob = (content = '%PDF-1.7 test') => new Blob([content], { type: 'application/pdf' });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('produceInvestmentDocument', () => {
  it('the chosen/ranked template wins, and the legacy route is never asked', async () => {
    tryTemplate.mockResolvedValue({ blob: pdfBlob(), fileName: 'doc.pdf', templateId: 't-1' });

    const doc = await produceInvestmentDocument('r-1', { variant: 'briefing' });

    expect(doc.engine).toBe('template');
    expect(doc.templateId).toBe('t-1');
    expect(tryTemplate).toHaveBeenCalledWith('investment', 'r-1', { variant: 'briefing' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to the legacy route with the presentation switches forwarded', async () => {
    tryTemplate.mockResolvedValue(null);
    invoke.mockResolvedValue({ data: { fileUrl: 'https://x/y.pdf', fileName: 'legacy.pdf', renderer: 'weasyprint' }, error: null } as any);
    fetchBlob.mockResolvedValue(pdfBlob());

    const doc = await produceInvestmentDocument('r-1', {
      includeCharts: false,
      includeHeroImages: true,
      includeSparklines: false,
      designOptions: { accent: 'x' } as any,
    });

    expect(doc.engine).toBe('legacy_server');
    expect(doc.templateId).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      'render-investment-report-pdf',
      expect.objectContaining({
        reportId: 'r-1',
        includeCharts: false,
        includeHeroImages: true,
        includeSparklines: false,
        designOptions: { accent: 'x' },
      }),
      expect.objectContaining({ timeoutMs: 240_000 }),
    );
    expect(fetchBlob).toHaveBeenCalledWith('https://x/y.pdf');
  });

  it('throws the failing engine message when nothing can produce the document', async () => {
    tryTemplate.mockResolvedValue(null);
    invoke.mockResolvedValue({ data: null, error: { message: 'renderer down' } } as any);

    await expect(produceInvestmentDocument('r-1')).rejects.toThrow('renderer down');
  });

  it('an empty legacy body is a failure, not a document', async () => {
    tryTemplate.mockResolvedValue(null);
    invoke.mockResolvedValue({ data: { fileUrl: 'https://x/y.pdf', fileName: 'legacy.pdf' }, error: null } as any);
    fetchBlob.mockResolvedValue(new Blob([], { type: 'application/pdf' }));

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

    expect(published).toMatchObject({ path: 'stored/My-Doc-v2.pdf', engine: 'template', templateId: 't-1' });
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

  it('reuses the path the legacy route just persisted rather than re-uploading', async () => {
    tryTemplate.mockResolvedValue(null);
    fetchBlob.mockResolvedValue(pdfBlob());
    invoke.mockImplementation(async (fn: string) => {
      if (fn === 'render-investment-report-pdf') {
        return { data: { fileUrl: 'https://signed/x.pdf', fileName: 'x.pdf' }, error: null } as any;
      }
      if (fn === 'get-investment-reports') {
        return { data: { report: { id: 'r-1', pdf_url: 'investment-report-x.pdf' } }, error: null } as any;
      }
      throw new Error(`unexpected invoke ${fn}`);
    });

    const published = await publishInvestmentPdf('r-1');

    expect(published).toMatchObject({ path: 'investment-report-x.pdf', engine: 'legacy_server' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads when the legacy route left only an external URL behind', async () => {
    tryTemplate.mockResolvedValue(null);
    fetchBlob.mockResolvedValue(pdfBlob());
    invoke.mockImplementation(async (fn: string) => {
      if (fn === 'render-investment-report-pdf') {
        return { data: { fileUrl: 'https://api2pdf/x.pdf', fileName: 'x.pdf' }, error: null } as any;
      }
      if (fn === 'get-investment-reports') {
        return { data: { report: { id: 'r-1', pdf_url: 'https://api2pdf/x.pdf' } }, error: null } as any;
      }
      if (fn === 'manage-investment-reports') {
        return { data: { success: true }, error: null } as any;
      }
      throw new Error(`unexpected invoke ${fn}`);
    });
    upload.mockResolvedValue({ success: true, path: 'r-1_123_x.pdf' } as any);

    const published = await publishInvestmentPdf('r-1');

    expect(upload).toHaveBeenCalled();
    expect(published.path).toBe('r-1_123_x.pdf');
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
