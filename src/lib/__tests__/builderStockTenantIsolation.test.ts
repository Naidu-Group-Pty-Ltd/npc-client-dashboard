/**
 * Builder portal — one builder must never reach another builder's stock.
 *
 * AUDITED 11 SEPTEMBER 2026 after a report that a stock list uploaded under
 * Kopi Jantan Builders could be reached from a Bob The Builder account. The
 * server chain was traced end to end and every link is scoped:
 *
 *   session cookie
 *     → `builder_portal_sessions`            (token → builder_user_id)
 *     → `builder_accessible_organisations`   (SECURITY DEFINER, WHERE
 *                                             m.builder_user_id = _user_id)
 *     → `active_organisation`                (only ever an element of that
 *                                             list — a stored selection that
 *                                             is not in it is DROPPED)
 *     → every query `.eq('organisation_id', activeOrganisationId)`
 *
 * and `builder_stock_uploads` / `_items` / `_item_images` / `_selections` all
 * have RLS on with a service-role-only policy, so the browser's anon client
 * reads nothing directly whatever it asks for. Both storage buckets
 * (`builder-stock-lists`, `builder-stock-images`) are private.
 *
 * This file is the guard that keeps that true. It is a SOURCE test on purpose:
 * the leak this class produces is a single missing `.eq`, which no unit test
 * of a helper would ever see, and which review has to catch every single time
 * for the property to hold.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENDPOINT = readFileSync(join(process.cwd(),
  'supabase/functions/builder-portal-stock/index.ts'), 'utf8');
const AUTH = readFileSync(join(process.cwd(),
  'supabase/functions/_shared/builderPortalAuth.ts'), 'utf8');

/** The tables that hold one builder's commercial data. */
const TENANT_TABLES = [
  'builder_stock_uploads',
  'builder_stock_items',
  'builder_stock_item_images',
  'builder_stock_selections',
];

/**
 * Every `.from('<table>')` in the endpoint, with the chained call text that
 * follows it, so each one can be asked whether it narrows to an organisation.
 */
function queriesAgainst(table: string): Array<{ line: number; chain: string }> {
  const found: Array<{ line: number; chain: string }> = [];
  const needle = `.from('${table}')`;
  let at = ENDPOINT.indexOf(needle);
  while (at !== -1) {
    // To the end of the statement: the chain ends at the first `;` that is not
    // inside a template/parenthesis we care about. A generous window is safer
    // than a clever parser here — a missing `.eq` is what we are looking for.
    const end = ENDPOINT.indexOf(';', at);
    found.push({
      line: ENDPOINT.slice(0, at).split('\n').length,
      chain: ENDPOINT.slice(at, end === -1 ? at + 900 : end),
    });
    at = ENDPOINT.indexOf(needle, at + needle.length);
  }
  return found;
}

/** Scoped by the session's organisation, or by an id already resolved under it. */
const isScoped = (chain: string): boolean =>
  chain.includes('activeOrganisationId')
  || chain.includes("eq('organisation_id'")
  // `.eq('id', upload.id)` / `item.id` — the row was loaded by `loadUpload` /
  // `loadItem`, both of which filter on the active organisation themselves.
  || /\.eq\('id',\s*(upload|item)\./.test(chain);

describe('every builder-portal stock query narrows to the caller’s organisation', () => {
  for (const table of TENANT_TABLES) {
    it(`${table}`, () => {
      const queries = queriesAgainst(table);
      expect(queries.length, `no query found against ${table} — has it been renamed?`)
        .toBeGreaterThan(0);
      const unscoped = queries.filter((q) => !isScoped(q.chain));
      expect(
        unscoped.map((q) => `line ${q.line}`),
        `unscoped ${table} quer${unscoped.length === 1 ? 'y' : 'ies'} — `
        + 'every one must filter on the active organisation',
      ).toEqual([]);
    });
  }
});

describe('the organisation itself is derived, never taken from the caller', () => {
  it('comes from the session, not from the request body', () => {
    expect(ENDPOINT).toContain('session.active_organisation?.organisation_id');
    // The one thing that would undo all of it.
    expect(ENDPOINT).not.toMatch(/activeOrganisationId\s*=\s*[^;]*body\./);
  });

  it('is only ever one the server says the user may reach', () => {
    // A stored selection is honoured ONLY if it is in the accessible list, and
    // the fallback picks from that same list. Neither branch can name an
    // organisation the user has no membership in.
    expect(AUTH).toContain('organisations.find((organisation) => organisation.organisation_id === stored)');
    expect(AUTH).toContain('organisations.find((organisation) => organisation.is_primary)');
  });

  it('reads the accessible set through the scoped database function', () => {
    expect(AUTH).toContain("supabase.rpc('builder_accessible_organisations'");
    expect(AUTH).toContain('_user_id: userId');
  });

  it('refuses outright when the user has no membership at all', () => {
    expect(AUTH).toContain("code: 'no_membership'");
  });
});

describe('a stock list is resolved by id AND organisation, never by id alone', () => {
  it('loadUpload scopes', () => {
    const start = ENDPOINT.indexOf('const loadUpload');
    const body = ENDPOINT.slice(start, ENDPOINT.indexOf('};', start));
    expect(body).toContain("eq('organisation_id', activeOrganisationId)");
  });

  it('loadItem scopes', () => {
    const start = ENDPOINT.indexOf('const loadItem');
    const body = ENDPOINT.slice(start, ENDPOINT.indexOf('};', start));
    expect(body).toContain("eq('organisation_id', activeOrganisationId)");
  });

  it('and a signed image URL is minted only for the caller’s own image', () => {
    const start = ENDPOINT.indexOf("operation === 'image_url'");
    const body = ENDPOINT.slice(start, start + 1200);
    expect(body).toContain("eq('organisation_id', activeOrganisationId)");
    // The lookup must happen BEFORE anything is signed.
    expect(body.indexOf("eq('organisation_id'"))
      .toBeLessThan(body.indexOf('createSignedUrl'));
  });
});
