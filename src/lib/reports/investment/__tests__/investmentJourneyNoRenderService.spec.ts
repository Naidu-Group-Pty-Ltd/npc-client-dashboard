import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Investment client-PDF journey reaches no render service and no Cloud Run.
 *
 * Asked of the MODULE GRAPH rather than of a directory: `deliverInvestmentPdf`
 * is the one contract every surface calls, so walking its imports answers the
 * question a `grep src/` cannot — the repository still holds WeasyPrint clients
 * and a Cloud Run export dialog, and the point is that nothing on this journey
 * can reach them.
 *
 * Template Builder is in the same repository and keeps its own preview and
 * export paths (`weasyPreview`, `weasyRenderClient`, `ExportPipelineDialog`).
 * A client PDF must never require opening it, so those modules appearing in
 * this closure would itself be the defect.
 */
const ROOT = path.resolve(__dirname, '../../../../..');
const SRC = path.join(ROOT, 'src');

const ENTRY_POINTS = [
  'src/lib/reports/investment/deliverInvestmentPdf.ts',
  'src/components/reports/PremiumPdfButton.tsx',
];

/**
 * INVOKED, not mentioned.
 *
 * The discriminator has to be the call shape rather than the name: the shared
 * broker `secureInvoke.ts` is on this path and legitimately COMPARES against
 * both route names inside its render-coverage telemetry — classifying a call
 * somebody else makes is the opposite of making one, and a test that cannot
 * tell the two apart would have to be silenced to pass, which is how a guard
 * stops guarding.
 */
const FORBIDDEN_ROUTES = ['render-template-pdf', 'render-investment-report-pdf'];
const callsRoute = (src: string, route: string): boolean =>
  new RegExp(
    String.raw`(?:invokeSecureFunction|functions\s*\.\s*invoke|invokeFunction)\s*(?:<[^>]*>)?\s*\(\s*['"\`]`
    + route.replace(/[-]/g, '\\-') + String.raw`['"\`]`,
  ).test(src);
/** A Cloud Run host, or the variable that names one, reached from a request. */
const CLOUD_RUN = /(?:fetch|axios|request)\s*\([^)]{0,200}?(?:\.run\.app|WEASYPRINT_SERVICE_URL)/;

const FORBIDDEN_MODULES = [
  'reportTemplate/weasyPreview',
  'reportTemplate/weasyRenderClient',
  'templateBuilder/',
];

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.d.ts'];

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package, not our source
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTS) {
    const candidate = base.endsWith('.ts') || base.endsWith('.tsx') ? base : base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function closureOf(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => path.join(ROOT, e));
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const next = resolveSpecifier(m[1], file);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
  }
  return seen;
}

describe('the Investment client-PDF journey', () => {
  const closure = closureOf(ENTRY_POINTS);

  it('reaches a real module graph', () => {
    expect(closure.size).toBeGreaterThan(20);
    expect([...closure].some((f) => f.endsWith('investmentPdfDocument.ts'))).toBe(true);
    expect([...closure].some((f) => f.endsWith('pdfRenderer.ts'))).toBe(true);
  });

  it('invokes no render service and requests no Cloud Run host', () => {
    const offenders: string[] = [];
    for (const file of closure) {
      const src = fs.readFileSync(file, 'utf8');
      for (const route of FORBIDDEN_ROUTES) {
        if (callsRoute(src, route)) offenders.push(`${path.relative(ROOT, file)} invokes ${route}`);
      }
      if (CLOUD_RUN.test(src)) offenders.push(`${path.relative(ROOT, file)} requests a Cloud Run host`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The discriminator above is only trustworthy if it can still see a real
   * call, so it is exercised against one: Template Builder's export dialog
   * genuinely posts to `render-template-pdf` and is NOT on this journey.
   */
  it('would still recognise a real invocation', () => {
    const dialog = fs.readFileSync(
      path.join(ROOT, 'src/components/templateBuilder/ExportPipelineDialog.tsx'), 'utf8',
    );
    expect(callsRoute(dialog, 'render-template-pdf')).toBe(true);
    expect([...closure].map((f) => path.relative(ROOT, f)))
      .not.toContain('src/components/templateBuilder/ExportPipelineDialog.tsx');
  });

  it('never pulls in Template Builder or a WeasyPrint client', () => {
    const offenders = [...closure]
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => FORBIDDEN_MODULES.some((m) => rel.includes(m)));
    expect(offenders).toEqual([]);
  });
});
