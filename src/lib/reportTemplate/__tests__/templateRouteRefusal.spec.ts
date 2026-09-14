/**
 * A refusal names the gate that closed.
 *
 * ## Why this exists
 *
 * `routeReportThroughTemplate` answers `null` for eight distinct reasons, and
 * every one of them is a fallback to the format's own composer — which, on the
 * migrated formats, is itself a well-typeset WeasyPrint document. So "your
 * template rendered" and "your template was skipped" looked identical from the
 * outside, and identical in the console: the only surviving evidence of which
 * gate had closed was a query against `template_render_jobs` in production,
 * and the answer to "why didn't my template apply?" cost a round trip every
 * time.
 *
 * Naming the refusal turns that into one click. The route still returns `null`
 * — every failure is a fallback and never an error, which is the rule that
 * keeps a templated document from being the reason somebody cannot get their
 * file — but the caller can now say which gate, and `tryTemplateDocument` puts
 * it in the toast the person is already reading.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEMPLATE_ROUTE_REFUSAL_TEXT,
  type TemplateRouteRefusal,
} from '@/lib/reportTemplate/routeReportThroughTemplate';

const ROOT = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Every gate the route can close at. */
const REASONS: TemplateRouteRefusal[] = [
  'no_adapter',
  'adapter_declined_record',
  'report_type_not_allowed',
  'no_active_template',
  'template_not_browser_renderable',
  'adapter_published_no_data',
  'template_schema_invalid',
  'template_unbound_reconstruction',
  'render_failed',
  'unexpected_error',
];

describe('every refusal has words a person can read', () => {
  it.each(REASONS)('%s', (reason) => {
    const text = TEMPLATE_ROUTE_REFUSAL_TEXT[reason];
    expect(text, `${reason} has no wording`).toBeTruthy();
    // Written for the person who chose a template, not for the log: no snake
    // case, no identifiers, and a real sentence.
    expect(text).not.toMatch(/_/);
    expect(text.length).toBeGreaterThan(20);
  });

  it('has no wording for a reason the route cannot produce', () => {
    expect(Object.keys(TEMPLATE_ROUTE_REFUSAL_TEXT).sort()).toEqual([...REASONS].sort());
  });
});

describe('the route reports the gate it closed at', () => {
  const code = stripComments(read('src/lib/reportTemplate/routeReportThroughTemplate.ts'));

  it.each(REASONS.filter((r) => r !== 'no_adapter'))('records %s', (reason) => {
    // `no_adapter` is the initial value and is reported by the shim, which
    // refuses before the route is entered at all.
    expect(code, `${reason} is never recorded, so it can never be told`)
      .toContain(`'${reason}'`);
  });

  it('tells the caller once, on the way out — never throws instead', () => {
    // The contract every caller depends on: a refusal is a fallback, so the
    // route returns null and the next line is the legacy generator.
    expect(code).toMatch(/opts\?\.onRefusal\?\.\(refusedAt\)/);
    expect(code).toMatch(/opts\?\.onRefusal\?\.\('unexpected_error'\)/);
  });

  it('parses the template inside its own guard, not past every other one', () => {
    // `parseTemplate` used to throw straight into the outer catch, where an
    // unreadable schema was indistinguishable from a network failure.
    expect(code).toMatch(/try\s*\{\s*schema = parseTemplate\(tplRow\.schema\);/);
  });
});

describe('the person is told which gate closed', () => {
  const code = stripComments(read('src/lib/reportTemplate/templateDocument.ts'));

  it('puts the reason in the notice, for every format at once', () => {
    expect(code).toContain('onRefusal');
    expect(code).toMatch(/TEMPLATE_ROUTE_REFUSAL_TEXT\[refusal\]/);
  });

  it('still only speaks when a template was actually chosen', () => {
    // Somebody who never chose one is not owed a warning about a choice.
    expect(code).toMatch(/if \(selectedId\) \{\s*notifySelectionNotUsed/);
  });
});
