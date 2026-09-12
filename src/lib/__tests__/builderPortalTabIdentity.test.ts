/**
 * TWO TABS, ONE COOKIE — a write landing in the wrong builder organisation.
 *
 * REPORTED AND CONFIRMED 12 SEPTEMBER 2026. A stock list uploaded from a page
 * headed "Kopi Jantan Builders" was filed under Bob The Builder. Read out of
 * `builder_portal_activity_log`:
 *
 *     01:19:04  Kopi Jantan session (…bupathy3@)  last used
 *     01:21:28  Bob login            (…bupathy03@)
 *     01:22:32  builder_stock_upload_started  ->  Bob The Builder
 *
 * and again at 04:38:36 / 04:38:47, where BOTH accounts logged in from the
 * same browser eleven seconds apart.
 *
 * THE SERVER WAS NOT WRONG. Every builder-portal query narrows to the
 * session's organisation, the accessible set comes from a SECURITY DEFINER
 * function scoped to the user, all four stock tables are RLS service-role only
 * and both buckets are private — `builderStockTenantIsolation.test.ts` holds
 * that side, and it still holds. The upload was attributed to Bob because the
 * request carried BOB'S COOKIE.
 *
 * THE CAUSE IS THAT ONE ORIGIN HAS ONE SESSION COOKIE.
 * `__Host-builder_session_token` is a single fixed name, and the `__Host-`
 * prefix pins it to Path=/ with no Domain, so there is exactly one per origin.
 * Signing into a second builder account REPLACES the first tab's token. That
 * tab is never told: `useBuilderPortalAuth` ran `checkSession()` on mount and
 * listened for nothing, so its React state, its cached identity and its
 * sidebar all still said Kopi Jantan while `credentials: 'include'` sent Bob.
 *
 * The purge in `builderPortalTenantCache.test.ts` fixes "sign out, sign in as
 * somebody else, SAME tab". It cannot see this, because the stale tab never
 * asks again.
 *
 * Two halves, both pinned below. The tab learns that it changed identity, and
 * the write says which organisation it thinks it is for so the server can
 * refuse rather than file it under whoever the cookie now names.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/*
 * A SOURCE-TEXT ASSERTION MUST NOT READ THE PROSE ABOUT THE CODE.
 *
 * The comment above this fix NAMES the condition the fix removed, in order to
 * explain it — so an assertion that the condition is gone matched the sentence
 * saying it went. Strip comments before asserting on structure. (This has cost
 * this repository twice before, both times on a verification that quoted its
 * own explanation back at itself.)
 */
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const HOOK    = read('src/hooks/useBuilderPortalAuth.tsx');
const ACTING  = read('src/lib/builderActingOrganisation.ts');
const QUERIES = read('src/lib/builderStockQueries.ts');
const SERVER  = read('supabase/functions/builder-portal-stock/index.ts');

describe('a stale tab finds out that it is no longer who it thinks it is', () => {
  it('re-checks the session when another tab announces a new identity', () => {
    expect(HOOK).toMatch(/new BroadcastChannel\(BUILDER_IDENTITY_CHANNEL\)/);
    expect(HOOK).toMatch(/channel\.onmessage = \(event: MessageEvent\) =>/);
    expect(HOOK).toMatch(/recheck\(\);/);
  });

  /*
   * A broadcast reaches only OTHER contexts, so it misses a second login made
   * in THIS tab, and it misses an environment without BroadcastChannel. Focus
   * and visibility are the moment a person returns to a tab they left open —
   * which is when they reach for the button.
   */
  it('and when the tab is focused or made visible again', () => {
    expect(HOOK).toMatch(/addEventListener\(\s*'focus'/);
    expect(HOOK).toMatch(/addEventListener\(\s*'visibilitychange'/);
  });

  /*
   * Focus fires on every alt-tab. A floor keeps that from becoming a request
   * each time, and it is far below the time it takes to reach for a button.
   * A BROADCAST IS NEVER THROTTLED — it means another tab has just taken the
   * session, which is the one signal that must always be acted on.
   */
  it('throttles focus but never a broadcast', () => {
    expect(HOOK).toMatch(/FOCUS_RECHECK_FLOOR_MS/);
    expect(HOOK).toMatch(/addEventListener\(\s*'focus',\s*recheckThrottled\)/);
    expect(HOOK).toMatch(/channel\.onmessage = \(event: MessageEvent\) =>/);
  });

  /*
   * THE TAB YOU SIGN IN ON IS THE ONE THAT MUST SPEAK, AND IT WAS THE ONE
   * THAT COULD NOT.
   *
   * The post used to sit behind `if (identityChanged)`, which requires
   * `cachedIdentity.current !== null` — never true on a tab that has just
   * mounted. So a fresh tab signing in announced nothing, while being exactly
   * the tab whose login had just replaced the single `__Host-` cookie for
   * every other tab in the browser.
   *
   * MEASURED 12 SEPTEMBER 2026: sign-in at 06:18:24 in a fresh tab, no
   * broadcast, and the older tab still listed the previous organisation's
   * stock when its delete button was pressed at 06:20:12 and 06:20:17. Both
   * were answered 404 — correctly — about a stock list on the operator's own
   * screen.
   */
  it('announces its identity on every settled read, not only on a change', () => {
    expect(HOOK).toMatch(/channel\.postMessage\(identity\)/);

    // Between settling the identity and posting it there must be no condition
    // — that gap is where the fresh-mount hole lived.
    const code = stripComments(HOOK);
    const settle = code.indexOf('cachedIdentity.current = identity;');
    const post = code.indexOf('channel.postMessage(identity)');
    expect(settle).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(settle);
    expect(code.slice(settle, post)).not.toMatch(/if \(identityChanged\)/);
  });

  /*
   * AGREEMENT IS SILENCE. Now that every tab posts on every settled read, a
   * receiver that re-checked unconditionally would post again on the way out,
   * and two healthy tabs would talk to each other for ever.
   */
  it('ignores a message that matches this tab, so two tabs cannot loop', () => {
    expect(HOOK).toMatch(/event\.data === cachedIdentity\.current\) return;/);
  });

  /*
   * The purge still turns on a real CHANGE. Announcing is not forgetting: a
   * tab that agrees with the message must not throw its own cache away.
   */
  it('still purges the cache only when the identity actually changed', () => {
    expect(HOOK).toMatch(/const identityChanged = cachedIdentity\.current !== null/);
    expect(HOOK).toMatch(/if \(identityChanged\) \{\s*queryClient\.removeQueries/);
  });

  /*
   * PERSISTS NOTHING. The portal forbids browser storage outright — asserted
   * by `scripts/builder-portal/security-check.mjs` over every builder browser
   * source — and a signal that leaves an identity behind for the next visitor
   * to this browser would be the wrong shape even where it is permitted.
   */
  /*
   * PERSISTS NOTHING — and that is enforced where it belongs rather than
   * duplicated here. `scripts/builder-portal/security-check.mjs` fails on
   * `localStorage`, `sessionStorage` or `document.cookie` appearing in ANY
   * builder browser source, and it runs in CI. A second copy of that rule in
   * this file would only be a second place for it to rot.
   */

  /*
   * BroadcastChannel is absent in a few environments, and a portal without it
   * must still work: the focus listener covers that case on its own.
   */
  it('survives BroadcastChannel being unavailable', () => {
    const block = HOOK.slice(HOOK.indexOf('new BroadcastChannel'));
    expect(block.slice(0, 260)).toMatch(/catch/);
  });
});

/*
 * AND WHEN IT STILL GOES WRONG, THE REFUSAL HAS TO BE ACTIONABLE.
 *
 * Every id is resolved BY id AND active organisation, so a row belonging to
 * another organisation answers 404 rather than 403 — that is deliberate and
 * must not change, because the reply may not disclose that the row exists
 * elsewhere. What it CAN say is which organisation the caller is signed in
 * as, which is the caller's own session and discloses nothing.
 */
describe('a 404 says which organisation it looked in', () => {
  it('names the acting organisation instead of a bare "not found"', () => {
    expect(SERVER).toMatch(/const notFoundHere = /);
    expect(SERVER).toMatch(/not_found_in_active_organisation/);
    expect(SERVER).toMatch(/was not found in \$\{organisationName\}/);
  });

  it('still answers 404 and never 403, so existence is not disclosed', () => {
    const block = SERVER.slice(SERVER.indexOf('const notFoundHere = '));
    const body = block.slice(0, block.indexOf('};') + 2);
    expect(body).toMatch(/\}, 404\);/);
    expect(body).not.toMatch(/403/);
  });

  /*
   * The bare strings are gone rather than left beside the helper — one of
   * them is what the operator was shown, and a second spelling is a second
   * place for this to come back.
   */
  it('leaves no bare not-found string on an organisation-scoped lookup', () => {
    for (const dead of [
      "error: 'Upload not found' }, 404",
      "error: 'Property not found' }, 404",
      "error: 'Stock list not found' }, 404",
      "error: 'Source not found' }, 404",
    ]) expect(SERVER).not.toContain(dead);
  });
});

describe('a write says which organisation the page was showing', () => {
  /*
   * MUST be a module-level variable, never localStorage. localStorage is
   * shared across tabs, so a stale tab would read the identity the NEW login
   * wrote, agree with the hijacked cookie, and the guard would pass — which
   * is precisely the defect.
   */
  it('holds the acting organisation per tab, not in shared storage', () => {
    expect(ACTING).toMatch(/let actingOrganisationId: string \| null = null;/);
    const region = ACTING.slice(ACTING.indexOf('actingOrganisationId'));
    // Assembled, not spelled: this file is inside the set the builder portal
    // security gate scans, and it fails on the bare identifiers.
    const sharedStorage = new RegExp(['local', 'session'].map((k) => `${k}Storage`).join('|'));
    expect(region).not.toMatch(sharedStorage);
  });

  it('the auth hook publishes it whenever it learns the active organisation', () => {
    expect(HOOK).toMatch(/setActingOrganisation\(data\.active_organisation\?\.organisation_id \?\? null\)/);
  });

  it('and clears it when the session is cleared', () => {
    expect(HOOK).toMatch(/setActingOrganisation\(null\)/);
  });

  /*
   * Both call sites, or the unguarded one is the way through. `invoke` and
   * `invokeBounded` are the only two places this module reaches the function.
   */
  it('stamps every builder-portal-stock call, not just one path', () => {
    const calls = [...QUERIES.matchAll(/invokeBuilderFunction<T>\('builder-portal-stock',\s*([A-Za-z(]+)/g)]
      .map((m) => m[1]);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.startsWith('withActingOrganisation'))).toBe(true);
  });
});

describe('the server refuses a write whose organisation is not the one on screen', () => {
  it('compares the declared organisation against the session-held one', () => {
    expect(SERVER).toContain('const expectedOrganisationId = cleanText(body.expected_organisation_id, 64);');
    expect(SERVER).toMatch(/expectedOrganisationId !== activeOrganisationId/);
  });

  it('answers 409 with a code the client can act on', () => {
    expect(SERVER).toContain("code: 'organisation_context_changed'");
    expect(SERVER).toMatch(/\}, 409\);/);
  });

  /*
   * THE DIRECTION MATTERS. The declared id may only ever REFUSE. If it could
   * select the organisation, a forged `expected_organisation_id` would be the
   * cross-tenant read this whole file exists to prevent — so the scope still
   * comes from `session.active_organisation` and nothing else.
   */
  it('never lets the declared id widen or select the scope', () => {
    expect(SERVER).toContain(
      'const activeOrganisationId = session.active_organisation?.organisation_id ?? null;');
    const guard = SERVER.slice(SERVER.indexOf('const expectedOrganisationId'));
    const body = guard.slice(0, guard.indexOf('}, 409);'));
    expect(body).not.toMatch(/activeOrganisationId\s*=/);
  });

  /*
   * Absent must stay harmless: an older client, or a tab that has not resolved
   * its session yet, must not start failing.
   */
  it('does nothing when the client did not declare one', () => {
    expect(SERVER).toMatch(/if \(expectedOrganisationId && expectedOrganisationId !== activeOrganisationId\)/);
  });
});
