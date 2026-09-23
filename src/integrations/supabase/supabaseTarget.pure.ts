/**
 * Which Supabase project a build talks to — the decision, with no environment
 * in it.
 *
 * Split out of `env.ts` so the two halves can answer to different rules.
 * `env.ts` keeps the reads, and those must be STATIC (see its header): a read
 * the bundler cannot see through is `undefined` in every production build.
 * This module keeps the judgement — the pairing rule — and the one value that
 * differs from deployment to deployment, so nothing here reads `import.meta`
 * and nothing here has to be written twice.
 *
 * ── Why the per-deployment value lives in its own file ───────────────────────
 *
 * Every deployment of this codebase carries this file, and every copy of it
 * names a different project. The cascade that carries shared code from this
 * repository to its clones must therefore never write it: it is a protected
 * path on a mirror, and on any other clone the copy here names a project that
 * is not the clone's own, which is what `backendIdentityHold` holds back.
 * Mission Control's provisioning is the one writer — it rewrites the pair
 * below for a new clone, in whichever of this file or `env.ts` declares it.
 *
 * Keeping it here is what lets `env.ts` carry no per-deployment value at all,
 * so the prime's copy and a clone's can be the same file. While the pair lived
 * in `env.ts`, the file holding the reads was also a file no cascade could
 * deliver — protected on a mirror, held everywhere else — so the prime's
 * broken reads and a clone's corrected ones could only ever be reconciled by
 * hand, one repository at a time.
 */

/**
 * THIS deployment's own project.
 *
 * It is the path a build takes when nobody configured it — the ordinary state
 * of a repository build, a CI run, or a new deployment — so it has to be the
 * deployment's own. `src/lib/__tests__/shippedBackendIdentity.spec.ts` is what
 * keeps it so, on this repository and on every clone.
 *
 * The project is named here as a URL and a key and nowhere in prose. Those two
 * are exactly what provisioning rewrites for a new clone, so a sentence naming
 * the project would survive the rewrite and be false on every clone it
 * reached.
 *
 * ── Why the fallback is THIS deployment's own project ───────────────────────
 *
 * It used to be the prime's, so that introducing this resolver was a no-op
 * upstream: a build with no Supabase variables behaved exactly as it did when
 * the values were inlined. That reasoning was right for the change and wrong
 * for this repository, and production proved it — the Vercel project never had
 * `VITE_SUPABASE_URL` set, so the deployed client dashboard fell through to
 * the prime and served the PRIME's production database. Signing in there
 * authenticated against the prime's real staff accounts.
 *
 * A missing variable is the normal state of a freshly created deployment, so a
 * fallback that reaches another tenant's data is not a safety net; it is the
 * failure mode waiting to happen. **A clone must never be able to reach the
 * prime's backend, configured or not.** The built-in pair is therefore this
 * deployment's own project, asserted on every CI run by
 * `shippedBackendIdentity.spec.ts`.
 *
 * The pairing rule in `env.ts` still holds, and still matters more here: a
 * half-configured environment falls back to BOTH built-ins rather than mixing,
 * so a partially-set deployment lands on its own project rather than on a
 * URL from one tenant with a key from another.
 *
 * (This history moved here from `env.ts` on 23 Sep 2026, with the pair it
 * is about: `env.ts` is the same file on every deployment now and names no
 * project.)
 */
export const FALLBACK_URL = 'https://plisdzywzleljorrphxv.supabase.co';
export const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsaXNkenl3emxlbGpvcnJwaHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTI3NzcsImV4cCI6MjEwMjY2ODc3N30.bGxsWwZxPHUih_u6YtzPwsIeG_b-KtwYz7U33OTqbWk';

/** The `ref` sub-domain of a Supabase project URL, or null if it is not one. */
export function projectRefFromUrl(url: string): string | null {
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i.exec(url.trim());
  return match ? match[1] : null;
}

/** The `ref` claim of a Supabase anon JWT, or null if it cannot be read. */
export function projectRefFromAnonKey(key: string): string | null {
  try {
    const payload = key.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const ref = (JSON.parse(json) as { ref?: unknown }).ref;
    return typeof ref === 'string' ? ref : null;
  } catch {
    return null;
  }
}

/** What a build resolved, and whether it came from the environment. */
export type SupabaseTarget = {
  url: string;
  anonKey: string;
  source: 'env' | 'fallback';
  warning: string | null;
};

/**
 * Resolve the pair. Exported and pure so the precedence is unit-testable
 * without stubbing `import.meta`.
 */
export function resolveSupabaseTarget(input: {
  url?: string;
  anonKey?: string;
  fallbackUrl?: string;
  fallbackAnonKey?: string;
}): SupabaseTarget {
  const fallbackUrl = input.fallbackUrl ?? FALLBACK_URL;
  const fallbackAnonKey = input.fallbackAnonKey ?? FALLBACK_ANON_KEY;
  const { url, anonKey } = input;

  if (url && anonKey) {
    const urlRef = projectRefFromUrl(url);
    const keyRef = projectRefFromAnonKey(anonKey);
    // A mismatch is always a configuration error, never a runtime one — say so
    // here rather than letting every request fail with an opaque 401.
    const warning =
      urlRef && keyRef && urlRef !== keyRef
        ? `Supabase misconfiguration: VITE_SUPABASE_URL names project "${urlRef}" but the publishable key belongs to "${keyRef}". Requests will be rejected until they match.`
        : null;
    return { url, anonKey, source: 'env', warning };
  }

  if (url || anonKey) {
    return {
      url: fallbackUrl,
      anonKey: fallbackAnonKey,
      source: 'fallback',
      warning: `Supabase is half-configured: ${url ? 'VITE_SUPABASE_URL is set but no publishable key is' : 'a publishable key is set but VITE_SUPABASE_URL is not'}. The URL and key are a matched pair, so BOTH built-in defaults are being used instead of mixing them.`,
    };
  }

  return { url: fallbackUrl, anonKey: fallbackAnonKey, source: 'fallback', warning: null };
}
