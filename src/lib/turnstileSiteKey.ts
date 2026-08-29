/**
 * The one place that decides which Turnstile widget this build renders.
 *
 * A Turnstile widget IS a (site key, secret) pair. The site key is public and
 * is rendered by the browser; the secret lives in the backend and is what
 * `siteverify` checks the resulting token against. A token minted by one
 * widget does not verify against another widget's secret, and — this is the
 * part that matters here — a token minted by ONE tenant's widget verifies
 * perfectly well against ANOTHER tenant's backend if both were handed the same
 * pair. Cloudflare returns the hostname it was solved on and no login handler
 * in this repository reads it.
 *
 * The site key used to be a literal in `components/auth/TurnstileWidget.tsx`,
 * and it was the PRIME's. Every deployment this repository has ever produced
 * therefore rendered the prime's widget: the same pair, shared across tenants,
 * rotated for everybody at once, with every customer hostname needing a place
 * on one widget's domain allowlist.
 *
 * ── The pairing rule, again ─────────────────────────────────────────────────
 *
 * `integrations/supabase/env.ts` already reasons about exactly this shape for
 * the Supabase URL and its anon key, and reached the conclusion this module
 * repeats: **a missing variable is the normal state of a freshly created
 * deployment, so a fallback that reaches another tenant is the failure mode
 * rather than the safety net.**
 *
 * So this repository has NO built-in site key. Unset, the widget renders as
 * unavailable and says which variable is missing, which is the honest reading:
 * a deployment whose CAPTCHA identity has not been minted yet cannot perform a
 * CAPTCHA. It is also not a regression on the state it replaces — a browser
 * holding the prime's site key against this deployment's own
 * `TURNSTILE_SECRET_KEY` is refused by `siteverify` with `invalid-input-secret`
 * and the sign-in never reaches the password check.
 *
 * Aurixa Mission Control mints this deployment's own widget and publishes its
 * site key here as `VITE_TURNSTILE_SITE_KEY` (see the clone's Turnstile
 * identity panel); `turnstileIdentity.spec.ts` asserts no site key literal
 * comes back into `src/`.
 */

import { SUPABASE_PROJECT_REF } from '@/integrations/supabase/env';

/**
 * This deployment has no widget baked in — see the header. The parameter is
 * kept on the resolver rather than removed so the prime and every clone share
 * one implementation and one set of readings.
 */
const BUILT_IN_SITE_KEY: string | null = null;

/** Which backend that built-in key is the twin of. Nothing, here. */
const BUILT_IN_BACKEND_REF: string | null = null;

/** The environment variable that carries this deployment's own site key. */
export const TURNSTILE_SITE_KEY_ENV = 'VITE_TURNSTILE_SITE_KEY';

export type TurnstileSiteKeyResolution = {
  /** The site key to render, or null when this build has none. */
  siteKey: string | null;
  source: 'env' | 'built-in' | 'unset';
  /** Operator-facing reason, present whenever `siteKey` is null. */
  warning: string | null;
};

/**
 * Resolve the site key. Exported and pure so the precedence is testable
 * without stubbing `import.meta`.
 *
 * The built-in key is used ONLY when this build talks to the backend that key
 * is the twin of. That is what makes a built-in safe to inherit: a fork
 * pointed at its own Supabase project stops using the original's widget
 * without anybody having to remember to unset anything.
 */
export function resolveTurnstileSiteKey(input: {
  configured?: string | null;
  builtInSiteKey?: string | null;
  builtInBackendRef?: string | null;
  backendRef?: string | null;
}): TurnstileSiteKeyResolution {
  const configured = typeof input.configured === 'string' ? input.configured.trim() : '';
  if (configured.length > 0) {
    return { siteKey: configured, source: 'env', warning: null };
  }

  const builtIn = input.builtInSiteKey === undefined ? BUILT_IN_SITE_KEY : input.builtInSiteKey;
  if (!builtIn) {
    return {
      siteKey: null,
      source: 'unset',
      warning: `${TURNSTILE_SITE_KEY_ENV} is not set. This deployment has no Turnstile widget of its own, and it must never render another tenant's.`,
    };
  }

  const builtInRef =
    input.builtInBackendRef === undefined ? BUILT_IN_BACKEND_REF : input.builtInBackendRef;
  const backendRef = input.backendRef === undefined ? null : input.backendRef;
  if (builtInRef && builtInRef !== backendRef) {
    return {
      siteKey: null,
      source: 'unset',
      warning: `The built-in Turnstile site key belongs to Supabase project "${builtInRef}", but this build talks to ${backendRef ? `"${backendRef}"` : 'an unrecognised project'}. A widget is a (site key, secret) pair, so set ${TURNSTILE_SITE_KEY_ENV} to this deployment's own site key.`,
    };
  }

  return { siteKey: builtIn, source: 'built-in', warning: null };
}

/**
 * Read the configured site key.
 *
 * STATIC on purpose, and this is the whole reason the feature did not work.
 *
 * Vite replaces the exact expression `import.meta.env.VITE_TURNSTILE_SITE_KEY`
 * with the value at BUILD time. A dynamic lookup — `import.meta.env[name]`,
 * which is what this function used to do — is not an expression Vite can see
 * through, so it is never replaced and reads `undefined` in a production
 * bundle however the environment is set.
 *
 * Measured: a build with `VITE_TURNSTILE_SITE_KEY` exported produced a
 * `TurnstileWidget` chunk containing ZERO occurrences of the key, while the
 * same build inlined `VITE_SUPABASE_URL` in five other chunks — those read it
 * statically. Nothing about the deployment was wrong; the read was.
 *
 * Do not refactor this back into a helper that takes the name as an argument.
 * `TURNSTILE_SITE_KEY_ENV` below is the name for MESSAGES; this is the read.
 */
function readConfiguredSiteKey(): string | undefined {
  try {
    const value = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

let resolved: TurnstileSiteKeyResolution | null = null;

/** Resolved once per module load, so the console says it once. */
export function turnstileSiteKey(): TurnstileSiteKeyResolution {
  if (!resolved) {
    resolved = resolveTurnstileSiteKey({
      configured: readConfiguredSiteKey(),
      backendRef: SUPABASE_PROJECT_REF,
    });
    if (resolved.warning) {
      console.error(`[turnstile] ${resolved.warning}`);
    }
  }
  return resolved;
}
