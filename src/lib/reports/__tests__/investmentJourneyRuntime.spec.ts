import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The Investment report reaches a client without leaving the browser and
 * Supabase.
 *
 * Both presentations are drawn here now — the standard document by
 * `investmentPdfDocument`, a chosen template by the Report Presentation
 * Renderer — so nothing on this journey posts a document to a render service
 * to be drawn. That is the property this pins, and it is pinned by SCANNING
 * rather than by trusting: the two render functions still exist, the Template
 * Builder still calls one of them for its own editor preview and export
 * pipeline, and the difference between "still in the repository" and "on a
 * client's path" is exactly what a reader cannot see from a grep.
 */

const ROOT = resolve(__dirname, '../../../..');

/** Comments are stripped: one may quote a name in order to forbid it. */
const codeOf = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Every module a client's Investment document is produced by, from the
 * surface that asks to the bytes that come back.
 */
const INVESTMENT_JOURNEY = [
  'src/lib/reports/investment/deliverInvestmentPdf.ts',
  'src/lib/reports/investment/investmentPdfDocument.ts',
  'src/lib/reports/investment/investmentPdfSource.ts',
  'src/lib/reports/investment/clientReadiness.ts',
  'src/lib/reportTemplate/templateDocument.ts',
  'src/lib/reportTemplate/compassRoute.ts',
  'src/lib/reportTemplate/routeReportThroughTemplate.ts',
  'src/lib/reportTemplate/pdfRenderer.ts',
  'src/components/reports/PixelPerfectPDFGenerator.tsx',
  'src/components/clients/ClientReportsTab.tsx',
];

/** Anything that would take the document out of this browser to be drawn. */
const RENDER_SERVICES = [
  'render-investment-report-pdf',
  'render-template-pdf',
  'WEASYPRINT_SERVICE_URL',
  '.run.app',
];

describe('the Investment journey draws its own documents', () => {
  it.each(INVESTMENT_JOURNEY)('%s reaches no render service', (rel) => {
    const code = codeOf(rel);
    for (const service of RENDER_SERVICES) {
      expect(code, `${rel} still reaches ${service}`).not.toContain(service);
    }
  });

  /**
   * The surfaces that MAY still reach one, named so that the list above is a
   * decision rather than an omission. Template Builder is an authoring tool,
   * not a step in the production report journey; its preview and its export
   * pipeline are an operator looking at their own draft.
   */
  it('and the only callers left are Template Builder’s own', () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/'render-investment-report-pdf'|'render-template-pdf'/.test(code)) {
          callers.push(full.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(callers.sort()).toEqual([
      // The Builder's "export this template" pipeline.
      'src/components/templateBuilder/ExportPipelineDialog.tsx',
      // The Builder's in-editor PDF preview, and its one client.
      'src/lib/reportTemplate/weasyPreview.ts',
      'src/lib/reportTemplate/weasyRenderClient.ts',
      // Telemetry: names the functions to tag a render event's engine.
      'src/lib/secureInvoke.ts',
    ]);
  });
});
