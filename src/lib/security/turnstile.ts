/**
 * Turnstile: which sitekey a build renders, and what Cloudflare's failure means.
 *
 * ── What went wrong ──────────────────────────────────────────────────────────
 *
 * `TurnstileWidget` asked Cloudflare for a challenge, and when Cloudflare
 * refused it threw the reason away:
 *
 *     'error-callback': () => { setUnavailable(true); onErrorRef.current?.(); }
 *
 * Cloudflare passes the error code as that callback's first argument — the
 * shipping `api.js` calls it as `cbError(String(code))` — and every one of the
 * eleven documented codes rendered the same sentence on the page:
 *
 *     "The security check could not load … check your ad/script blocker."
 *
 * That sentence is right for exactly one of them (200500, the iframe could not
 * load). For 110200 it is actively misleading: the widget loaded perfectly and
 * Cloudflare refused the HOSTNAME, which no visitor can fix and no amount of
 * disabling an ad blocker will change. The Sign In button stays disabled until
 * the widget produces a token, so the whole login page is unusable while it
 * blames the visitor's browser for the site owner's configuration.
 *
 * A failure nobody can name is a failure nobody can fix. So the code is
 * classified here, shown on the page, and logged.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * The table below is Cloudflare's, not ours
 * (developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/).
 * An UNDOCUMENTED code resolves to `unknown` and is still displayed verbatim —
 * guessing an owner for a code we cannot read would send somebody to the wrong
 * remedy, which is the defect this module exists to end.
 *
 * ── Why the sitekey is configurable ──────────────────────────────────────────
 *
 * It was a literal in the component, so the bundle could only ever be served
 * from a hostname that one Cloudflare widget already listed. Turnstile does not
 * accept wildcards and covers only a listed hostname and its SUBdomains, so
 * per-deployment hostnames (`<project>-<hash>-<team>.vercel.app` are siblings,
 * not subdomains) can never be allow-listed. Such a build cannot log anybody
 * in, and cannot be fixed without a code change.
 *
 * The prime's key stays the fallback, exactly as `integrations/supabase/env.ts`
 * keeps the prime's project: a build that sets nothing behaves as it always has.
 */

/** The sitekey this repository has always shipped. */
export const TURNSTILE_FALLBACK_SITE_KEY = '0x4AAAAAAChQyb0ZxBORhxWq';

export interface ResolvedTurnstileSiteKey {
  siteKey: string;
  source: 'env' | 'fallback';
}

/**
 * Resolve the sitekey from an environment map. Pure so the precedence is
 * testable without a bundler.
 */
export function resolveTurnstileSiteKey(
  env: Record<string, string | undefined> | undefined,
): ResolvedTurnstileSiteKey {
  const configured = env?.VITE_TURNSTILE_SITE_KEY;
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  if (trimmed.length > 0) return { siteKey: trimmed, source: 'env' };
  return { siteKey: TURNSTILE_FALLBACK_SITE_KEY, source: 'fallback' };
}

function readViteEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as { env?: Record<string, string | undefined> })?.env;
  } catch {
    return undefined;
  }
}

/** The sitekey this build renders. */
export const TURNSTILE_SITE_KEY = resolveTurnstileSiteKey(readViteEnv()).siteKey;

/**
 * Who can act on the failure.
 *
 * `operator` means nothing the visitor does will help — the widget, the key or
 * the hostname list has to change in the Cloudflare dashboard.
 */
export type TurnstileFaultOwner = 'operator' | 'visitor' | 'unknown';

export interface TurnstileFault {
  /** Cloudflare's code, verbatim. Empty when the failure preceded any code. */
  code: string;
  owner: TurnstileFaultOwner;
  /** Whether trying again can succeed without someone changing configuration. */
  retryable: boolean;
  /** What happened, in one sentence, for whoever is looking at the page. */
  summary: string;
  /** What the person who can fix it should do. */
  remedy: string;
}

/**
 * The script never arrived, so Cloudflare never got the chance to report a
 * code. Distinct from 200500 (the script ran and its iframe was blocked), and
 * the one case where "check your ad blocker" is the correct advice.
 */
export const TURNSTILE_SCRIPT_UNREACHABLE: TurnstileFault = {
  code: '',
  owner: 'visitor',
  retryable: true,
  summary: 'The security check could not load, so sign-in is unavailable.',
  remedy:
    'Check your connection, or any ad/script blocker for challenges.cloudflare.com.',
};

interface FaultTemplate {
  owner: TurnstileFaultOwner;
  retryable: boolean;
  summary: string;
  remedy: string | ((hostname: string | undefined) => string);
}

/** Cloudflare's documented client-side codes. */
const DOCUMENTED: Record<string, FaultTemplate> = {
  '110100': {
    owner: 'operator',
    retryable: false,
    summary: 'The security check is misconfigured for this site.',
    remedy: 'Invalid sitekey — verify it against the widget in the Cloudflare dashboard.',
  },
  '110110': {
    owner: 'operator',
    retryable: false,
    summary: 'The security check is misconfigured for this site.',
    remedy: 'Sitekey not found — check its spelling against the Cloudflare dashboard.',
  },
  '400020': {
    owner: 'operator',
    retryable: false,
    summary: 'The security check is misconfigured for this site.',
    remedy: 'Invalid sitekey — verify it against the widget in the Cloudflare dashboard.',
  },
  '400070': {
    owner: 'operator',
    retryable: false,
    summary: 'The security check is turned off for this site.',
    remedy: 'The sitekey is disabled — re-enable the widget in the Cloudflare dashboard.',
  },
  '110200': {
    owner: 'operator',
    retryable: false,
    summary: "This site's web address is not authorised for the security check.",
    remedy: (hostname) =>
      `Add ${hostname ? `${hostname} ` : 'this hostname '}to the widget's allowed hostnames ` +
      '(Cloudflare dashboard → Turnstile → the widget → Hostname Management). ' +
      'Turnstile covers a listed hostname and its subdomains only; wildcards are not accepted.',
  },
  '110600': {
    owner: 'visitor',
    retryable: true,
    summary: 'The security check timed out before it finished.',
    remedy: "Try again. If it keeps happening, check this device's clock is correct.",
  },
  '110620': {
    owner: 'visitor',
    retryable: true,
    summary: 'The security check was not completed in time.',
    remedy: 'Try again and complete the check when it appears.',
  },
  '200100': {
    owner: 'visitor',
    retryable: false,
    summary: 'The security check could not verify this device.',
    remedy:
      "This device's clock is wrong, or a proxy cached the check. Correct the clock, then reload.",
  },
  '200500': {
    owner: 'visitor',
    retryable: true,
    summary: 'The security check could not load, so sign-in is unavailable.',
    remedy:
      'Check your connection, or any ad/script blocker for challenges.cloudflare.com.',
  },
};

/** 300*** and 600*** are Cloudflare's generic challenge failures. */
const GENERIC_FAILURE = /^(?:300|600)\d{3}$/;

const GENERIC: FaultTemplate = {
  owner: 'visitor',
  retryable: true,
  summary: 'The security check did not pass.',
  remedy: 'Try again. If it keeps failing, try a different network or browser.',
};

const UNKNOWN: FaultTemplate = {
  owner: 'unknown',
  retryable: true,
  summary: 'The security check failed.',
  remedy: 'Try again. Quote the error code below if you report this.',
};

/**
 * Classify the code Cloudflare passed to `error-callback`.
 *
 * `hostname` is supplied by the caller rather than read from `location`, so
 * this stays pure — and so the 110200 remedy can name the exact hostname that
 * has to be added, which is the whole content of that fix.
 */
export function classifyTurnstileFault(code: unknown, hostname?: string): TurnstileFault {
  const normalised =
    typeof code === 'string' ? code.trim() : code === null || code === undefined ? '' : String(code).trim();

  const template =
    DOCUMENTED[normalised] ?? (GENERIC_FAILURE.test(normalised) ? GENERIC : UNKNOWN);

  return {
    code: normalised,
    owner: template.owner,
    retryable: template.retryable,
    summary: template.summary,
    remedy: typeof template.remedy === 'function' ? template.remedy(hostname) : template.remedy,
  };
}
