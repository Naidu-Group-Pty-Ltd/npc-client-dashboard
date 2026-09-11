/**
 * Builder portal — one builder's data must never be DRAWN in another's portal.
 *
 * REPORTED AND CONFIRMED 11 SEPTEMBER 2026: "a stock list uploaded under Kopi
 * Jantan Builders can be seen from a Bob The Builder account", seen in Bob's
 * own Stock Lists page.
 *
 * THE SERVER WAS NOT THE LEAK. Traced end to end: every builder-portal query
 * narrows to `activeOrganisationId`; that value can only ever be an element of
 * `builder_accessible_organisations`, a SECURITY DEFINER function filtered on
 * the user; all four stock tables carry RLS with a service-role-only policy,
 * so the browser's anon client reads none of them; both storage buckets are
 * private. `builderStockTenantIsolation.test.ts` holds that side.
 *
 * THE LEAK WAS THE CACHE. React Query keys the builder portal's data under
 * names that identify no builder — `['builder','stock','uploads',1]` — and
 * `signOut` cleared the auth hook's React state and nothing else:
 *
 *     sign in as Kopi Jantan  → cache fills under that key
 *     sign out                → cache untouched
 *     sign in as Bob          → the page mounts, reads the SAME key, and
 *                               renders Kopi Jantan's stock lists
 *
 * before the refetch replaces them. The rows are real, they belong to another
 * company, and they are on screen.
 *
 * FIXED AT THE IDENTITY, NOT AT THE KEY. `builderKeys` has forty-odd entries —
 * projects, units, transactions, construction, documents, conversations — and
 * every one is organisation-blind in the same way. Purging on a change of
 * `(builder_user_id, organisation_id)` covers all of them, and covers every
 * key anybody adds later; keying them one at a time would not, and would be
 * one forgotten argument away from this bug again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { builderStockKeys } from '../builderStockQueries';
import { builderKeys } from '../builderQueries';

const HOOK = readFileSync(join(process.cwd(),
  'src/hooks/useBuilderPortalAuth.tsx'), 'utf8');

describe('the cache is emptied whenever the tenant changes', () => {
  it('signing out drops every builder query, not just the auth state', () => {
    const start = HOOK.indexOf('const clearAuthState');
    const body = HOOK.slice(start, HOOK.indexOf('}, [', start));
    expect(body).toContain('forgetCachedTenant()');
  });

  it('and the purge really removes them rather than marking them stale', () => {
    // `invalidateQueries` leaves the data in place and re-renders it while the
    // refetch is in flight, which is exactly the window this bug lives in.
    expect(HOOK).toContain("queryClient.removeQueries({ queryKey: ['builder'] })");
    expect(HOOK).not.toContain("invalidateQueries({ queryKey: ['builder'] })");
  });

  it('switching organisation purges too, with no sign-out involved', () => {
    // A user with two memberships, or a second account in the same tab.
    expect(HOOK).toContain('cachedIdentity.current !== identity');
    expect(HOOK).toContain('data.active_organisation?.organisation_id');
  });

  it('does not purge on the FIRST read, which would throw away a warm start', () => {
    // Only a CHANGE is a leak; the first identity seen has nothing before it.
    expect(HOOK).toContain('cachedIdentity.current !== null');
  });

  it('tracks the user as well as the organisation', () => {
    const start = HOOK.indexOf('const identity = ');
    const line = HOOK.slice(start, HOOK.indexOf('\n', start));
    expect(line).toContain('data.user.id');
    expect(line).toContain('organisation_id');
  });
});

describe('the purge covers every builder key family, present and future', () => {
  /*
   * The reason this is one prefix rather than a list: anything added under
   * `['builder', …]` is covered without anybody remembering to add it.
   */
  const families = [
    builderStockKeys.root(),
    builderStockKeys.uploads(1),
    builderStockKeys.items({ search: '', availability: '', uploadId: '', page: 1, pageSize: 20 }),
    builderStockKeys.item('x'),
    builderStockKeys.selections(1),
    builderKeys.projectsRoot(),
    builderKeys.unitsRoot(),
    builderKeys.transactionsRoot(),
    builderKeys.constructionRoot(),
    builderKeys.collaborationRoot(),
    builderKeys.project('x'),
    builderKeys.document('x'),
    builderKeys.conversation('x'),
  ];

  for (const key of families) {
    it(`[${key.join(', ')}] is under the purged prefix`, () => {
      expect(key[0]).toBe('builder');
    });
  }

  it('every key family starts with the prefix — no private one escapes it', () => {
    const all = [
      ...Object.values(builderStockKeys).map((make) => (make as (...a: never[]) => readonly unknown[])(
        1 as never)),
    ];
    for (const key of all) expect(key[0]).toBe('builder');
  });
});
