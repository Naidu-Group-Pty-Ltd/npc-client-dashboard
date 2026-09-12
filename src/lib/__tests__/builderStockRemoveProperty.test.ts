/**
 * Builder stock — a builder can take ONE property off their list.
 *
 * THE OPERATION HAS ALWAYS EXISTED. `archive_stock_item` shipped with the
 * portal: permission gated on `delete`, activity logged, and it sets
 * `lifecycle_status` to `archived` rather than destroying a row. The client
 * hook `useArchiveBuilderStockItem` existed too. NOTHING EVER CALLED EITHER —
 * the same shape as `revoke_grant`, which the Passport register carried for
 * months with no surface. A builder whose list held a property they no longer
 * sell could remove the entire stock list, or nothing.
 *
 * THE WORD IS "REMOVE", NOT "DELETE", and that is not a euphemism — it is
 * what the server does. The row survives, archived, with any Command Centre
 * selection made against it intact, and a re-upload that still contains the
 * property brings it back. A button promising deletion would promise
 * something this deliberately does not do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const page = () => readFileSync(
  join(process.cwd(), 'src/pages/builder/BuilderStockList.tsx'), 'utf8',
);
const queries = () => readFileSync(
  join(process.cwd(), 'src/lib/builderStockQueries.ts'), 'utf8',
);
const endpoint = () => readFileSync(
  join(process.cwd(), 'supabase/functions/builder-portal-stock/index.ts'), 'utf8',
);

describe('the operation that existed and had no caller', () => {
  it('is reached from the portal now', () => {
    expect(page()).toContain('useArchiveBuilderStockItem');
    expect(page()).toContain('<RemoveProperty');
  });

  it('still goes through the one hook, not a second request', () => {
    expect(queries()).toContain("operation: 'archive_stock_item'");
    // The page never composes the request itself.
    expect(page()).not.toContain("'archive_stock_item'");
  });

  it('is reached from the ONE presentation there now is', () => {
    /*
     * This asserted TWO mounts, because the page drew a table above 1400px
     * and a stacked card list below it, both rendered with one hidden by
     * `min-[1400px]:hidden`. The rule it protected — a control on one
     * presentation only is a control a phone does not have — is now true by
     * construction: there is a single plate list, so a phone gets the same
     * markup and the same controls as a desktop, and the duplicate-DOM shape
     * that carried every accessible name twice is gone with it.
     *
     * So the count is one, AND the reason it is safe to be one is asserted:
     * no CSS-hidden second copy.
     */
    const source = page();
    expect(source.split('<RemoveProperty').length - 1).toBe(1);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/min-\[1400px\]:hidden|max-\[1399px\]:hidden/);
  });
});

describe('what the control is allowed to promise', () => {
  it('says remove, never delete, because the server archives', () => {
    const source = page();
    const start = source.indexOf('function RemoveProperty');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toMatch(/Remove property/);
    expect(body).not.toMatch(/\bDelete\b/);
    expect(body).not.toMatch(/permanently|for ?ever|cannot be undone/i);
  });

  it('asks first — a marketplace withdrawal is not a stray click', () => {
    const source = page();
    const start = source.indexOf('function RemoveProperty');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('AlertDialog');
    expect(body).toContain('AlertDialogCancel');
  });

  it('names the property it is about, so a row cannot be confused for another', () => {
    const source = page();
    const start = source.indexOf('function RemoveProperty');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('stockItemTitle(item)');
  });

  it('leaves the row alone when the server refuses', () => {
    // Including a permission refusal: `can('delete')` is the server's and the
    // page does not second-guess it, it reports what came back.
    const source = page();
    const start = source.indexOf('function RemoveProperty');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('onError');
    expect(body).toContain("variant: 'destructive'");
  });
});

describe('the server side is unchanged', () => {
  it('still gates on the delete capability', () => {
    const source = endpoint();
    const start = source.indexOf("operation === 'archive_stock_item'");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 900);
    expect(body).toContain("await can('delete')");
    expect(body).toContain('permission_denied');
  });

  it('archives rather than deletes, and records who did it', () => {
    const source = endpoint();
    const start = source.indexOf("operation === 'archive_stock_item'");
    const body = source.slice(start, start + 900);
    expect(body).toContain("lifecycle_status: 'archived'");
    expect(body).not.toMatch(/\.delete\(\)/);
    expect(body).toContain('builder_stock_item_archived');
  });
});
