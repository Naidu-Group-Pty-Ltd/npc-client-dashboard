/**
 * Audit items 2, 14 and 15 — the cash-flow analysis screen.
 *
 * Read the deployed source. Each assertion is about a rule, and each rule is
 * one the screen got wrong.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..', '..');
const modal = readFileSync(
  join(root, 'src', 'components', 'reports', 'CashFlowAnalysisModal.tsx'),
  'utf8',
);
const dropdown = readFileSync(
  join(root, 'src', 'components', 'ui', 'dropdown-menu.tsx'),
  'utf8',
);
const exportMenu = readFileSync(
  join(root, 'src', 'components', 'cash-flow', 'modal', 'CashFlowExportMenu.tsx'),
  'utf8',
);

describe('item 2 — the frozen column stays frozen', () => {
  /**
   * The section bands ("Cash Deductions", "Summary") scrolled away while the
   * metric cells beside them stayed put. They carried `sticky left-0` and were
   * `colSpan={12}`, and `position: sticky` never moves an element outside its
   * containing block — a cell as wide as the row has nowhere to go. Measured
   * in Chromium: at `scrollLeft: 400` the label sat at -383px; with the label
   * in an inline-block inside the cell it sits at +17px, unmoved.
   */
  it('no longer puts sticky on a full-width cell', () => {
    expect(modal).not.toMatch(/<TableCell className="sticky left-0[^"]*" colSpan=\{12\}>/);
  });

  it('sticks the label instead, inside the cell that spans', () => {
    const labels = modal.match(
      /<span className="sticky left-0 inline-block px-4 py-3 text-xs font-bold uppercase tracking-wide text-primary">/g,
    ) ?? [];
    // Statistics, Cash Deductions, Non-Cash Deductions, Summary.
    expect(labels).toHaveLength(4);
  });

  it('keeps the band spanning the row, so the heading still reads as a band', () => {
    const bands = modal.match(/<TableCell className="bg-primary\/5 p-0" colSpan=\{12\}>/g) ?? [];
    expect(bands).toHaveLength(4);
  });
});

describe('item 14 — a failure that names itself', () => {
  /**
   * "Export → Send to Client" reported `PDF generation failed. Please try
   * again.` — `SendToClientModal`'s reading of a falsy return. The generator
   * had five ways to produce one; two logged nothing, and the refused upload
   * discarded `uploadResult.error` outright. That refusal was almost certainly
   * `Invalid upload resource`, the fault behind audit items 5, 7 and 8.
   */
  it('never returns a bare null for a fault', () => {
    const fn = modal.slice(
      modal.indexOf('const generateAndUploadCashFlowPDF'),
      modal.indexOf('}, [report, baseFinancialData, exportSingleReportPDF]);'),
    );
    expect(fn).not.toMatch(/^\s*return null;/m);
  });

  it('says which of the five faults it was', () => {
    expect(modal).toMatch(/This report could not be resolved/);
    expect(modal).toMatch(/no financial figures to render/);
    expect(modal).toMatch(/The PDF renderer produced no document/);
  });

  it('surfaces the storage refusal rather than swallowing it', () => {
    expect(modal).toMatch(/throw new Error\(uploadResult\?\.error \|\| 'The document could not be stored\.'\)/);
  });

  it('still binds the upload to its report, which is what fixed the send', () => {
    expect(modal).toMatch(/resourceId: report\.id/);
  });
});

describe('item 15 — a menu may not borrow the page scrollbar', () => {
  it('bounds the dropdown to the room it has', () => {
    expect(dropdown).toMatch(/max-h-\[var\(--radix-dropdown-menu-content-available-height\)\]/);
  });

  it('scrolls inside rather than overflowing the window', () => {
    expect(dropdown).toMatch(/overflow-y-auto rounded-md border p-1/);
    expect(dropdown).not.toMatch(/overflow-hidden rounded-md border p-1/);
  });

  it('keeps the content off the window edge', () => {
    expect(dropdown).toMatch(/collisionPadding = 8/);
    expect(dropdown).toMatch(/collisionPadding=\{collisionPadding\}/);
  });

  it('applies to the submenu too', () => {
    const bounded = dropdown.match(/max-h-\[var\(--radix-dropdown-menu-content-available-height\)\]/g) ?? [];
    expect(bounded).toHaveLength(2);
  });

  it('lets the export menu inherit it', () => {
    // Its own `overflow-hidden` would have won through tailwind-merge and left
    // the panel exactly as it was.
    expect(exportMenu).not.toMatch(/<DropdownMenuContent[^>]*overflow-hidden/);
  });
});
