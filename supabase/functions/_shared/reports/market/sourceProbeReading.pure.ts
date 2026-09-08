/**
 * ME-5.1 — reading `market-source-probe`'s answer.
 *
 * ## Why this is a module rather than a switch in a component
 *
 * The probe's whole design principle is that **a failure is classified, not
 * summarised**: `credential_absent`, `credential_invalid_or_scope_missing`,
 * `not_entitled`, `route_not_found`, `rate_limited`, `blocked_by_origin`,
 * `server_error` and `unreachable` are eight different findings with different
 * owners, and "unavailable" sent this investigation to the wrong remedy twice
 * (§51, §52).
 *
 * That principle only survives if the *reading* of a verdict is one
 * implementation. The probe classifies on the server; a person reads the answer
 * on the Integrations page. Two copies of "what does `not_entitled` mean and
 * whose problem is it" is exactly how a commercial question comes to be handed
 * to an engineer.
 *
 * ## Three rules
 *
 * **A credential is presence only.** Nothing here accepts, formats, truncates
 * or masks a value: the input is `Record<string, boolean>`, so there is no
 * value in scope to leak. A length is a hint and a prefix identifies the
 * issuer, which is why the probe never sends either.
 *
 * **An unrecognised verdict is its own reading, never a default.** A provider
 * gateway can answer something the classifier has not seen, and rendering that
 * as "reachable" or as "absent" would be a fabricated finding. `describeVerdict`
 * returns an explicit unrecognised reading with the engineer as owner.
 *
 * **Owner is part of the finding.** Every verdict names who can act on it —
 * `commercial` (Aurixa's negotiation), `operator` (a credential to set),
 * `engineering` (code to change), or `vendor` (their side). A diagnostic that
 * says what is wrong without saying whose it is gets routed by guesswork.
 */

/** The classifier's vocabulary, mirrored from `market-source-probe`. */
export const PROBE_VERDICTS = [
  'reachable',
  'credential_absent',
  'credential_invalid_or_scope_missing',
  'not_entitled',
  'route_not_found',
  'rate_limited',
  'blocked_by_origin',
  'server_error',
  'unreachable',
] as const;

export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

/** Who can act on a finding. */
export type FindingOwner = 'commercial' | 'operator' | 'engineering' | 'vendor' | 'unassigned';

/** How a verdict reads, and how it should be drawn. */
export type ReadingTone = 'positive' | 'neutral' | 'attention' | 'blocked';

export interface VerdictReading {
  verdict: string;
  label: string;
  /** What the status code actually established. */
  meaning: string;
  owner: FindingOwner;
  /** The single next step, or null where the verdict IS the answer. */
  nextAction: string | null;
  tone: ReadingTone;
  recognised: boolean;
}

const READINGS: Readonly<Record<ProbeVerdict, Omit<VerdictReading, 'verdict' | 'recognised'>>> = {
  reachable: {
    label: 'Reachable',
    meaning: 'The endpoint answered 2xx. This says the route exists and the request was accepted — it does not say the payload carries the measures the scoring engine needs.',
    owner: 'engineering',
    nextAction: 'Qualify the payload: geographic level actually returned, dwelling type matched, sample size, period covered, history depth.',
    tone: 'positive',
  },
  credential_absent: {
    label: 'No credential set',
    meaning: 'The endpoint answered 401 and no credential name for this provider is set in the runtime environment. Nothing was sent, so nothing was rejected.',
    owner: 'operator',
    nextAction: 'Set the provider credential on this page. Until then this row cannot say anything about entitlement.',
    tone: 'neutral',
  },
  credential_invalid_or_scope_missing: {
    label: 'Credential rejected, or scope missing',
    meaning: 'A credential was sent and the endpoint answered 401. The gateway does not distinguish a wrong credential from a missing scope, so this reading deliberately names both.',
    owner: 'operator',
    nextAction: 'Confirm the credential and that the account holds the named scope. Do not assume which of the two it is.',
    tone: 'attention',
  },
  not_entitled: {
    label: 'Not entitled',
    meaning: 'A credential was sent and the endpoint answered 403. The credential is recognised; the account is not entitled to this endpoint.',
    owner: 'commercial',
    nextAction: 'Entitlement is a property of the provider account, not of this code. It is added to the account, never worked around here.',
    tone: 'blocked',
  },
  route_not_found: {
    label: 'Route does not exist',
    meaning: 'The endpoint answered 404. That is a routing answer given before any credential question arises — the path this repository calls is not a path the provider serves.',
    owner: 'engineering',
    nextAction: 'Correct the route. A credential cannot fix a 404, and a valid key against a dead route returns null exactly like no key at all.',
    tone: 'blocked',
  },
  rate_limited: {
    label: 'Rate limited',
    meaning: 'The endpoint answered 429. The route and the credential are both fine; the call rate is not.',
    owner: 'engineering',
    nextAction: 'Establish whether the limit is per key or per tenant — this platform forwards the prime’s keys to every clone, so a per-key limit is a fleet-wide ceiling.',
    tone: 'attention',
  },
  blocked_by_origin: {
    label: 'Blocked at the origin',
    meaning: 'The endpoint answered 403 with no credential sent. The refusal is about where the request came from rather than about who made it.',
    owner: 'engineering',
    nextAction: 'Compare against the same target from another egress before concluding anything: two egresses have already turned out to differ in this programme.',
    tone: 'attention',
  },
  server_error: {
    label: 'Provider error',
    meaning: 'The endpoint answered 5xx. Nothing about this deployment’s credential or entitlement was established.',
    owner: 'vendor',
    nextAction: 'Re-run before drawing any conclusion. A 5xx is not evidence about a credential.',
    tone: 'attention',
  },
  unreachable: {
    label: 'Unreachable',
    meaning: 'No HTTP answer at all — a timeout, a DNS failure or a refused connection. The request did not reach a gateway.',
    owner: 'engineering',
    nextAction: 'Establish whether the host resolves from this runtime at all. An unreachable host and an unauthorised one are opposite findings.',
    tone: 'blocked',
  },
};

/**
 * Read one verdict.
 *
 * An unrecognised value is returned as an explicit unrecognised reading — never
 * coerced onto a known one, because a fabricated finding here routes a real
 * problem to the wrong person.
 */
export function describeVerdict(verdict: string): VerdictReading {
  const known = (READINGS as Record<string, Omit<VerdictReading, 'verdict' | 'recognised'>>)[verdict];
  if (known) return { verdict, recognised: true, ...known };
  return {
    verdict,
    label: 'Unrecognised verdict',
    meaning: `The probe returned "${verdict}", which this reading does not know. It is shown verbatim rather than mapped onto a verdict it may not be.`,
    owner: 'engineering',
    nextAction: 'Add the verdict to the classifier’s reading, or correct the classifier. Do not interpret it from its name.',
    tone: 'attention',
    recognised: false,
  };
}

/** How a provider stands before any network call, mirrored from the probe. */
export const PROVIDER_STATUS_READING: Readonly<Record<string, { label: string; meaning: string; owner: FindingOwner; tone: ReadingTone }>> = {
  configured_and_testable: {
    label: 'Configured — testable',
    meaning: 'The credential shape the provider’s current contract wants is present. The network result below is meaningful.',
    owner: 'engineering',
    tone: 'positive',
  },
  credential_absent: {
    label: 'No credential',
    meaning: 'No credential name for this provider is set. Every network row below is a statement about an unauthenticated request.',
    owner: 'operator',
    tone: 'neutral',
  },
  authentication_implementation_obsolete: {
    label: 'Credential present, scheme obsolete',
    meaning: 'A credential is set under the legacy shape while the provider’s current contract wants another. Setting a key does not make the call work.',
    owner: 'engineering',
    tone: 'attention',
  },
  entitlement_unavailable: {
    label: 'Not entitled',
    meaning: 'The account does not hold the endpoint. Entitlement is added to the account, never worked around in code.',
    owner: 'commercial',
    tone: 'blocked',
  },
  licensing_unverified: {
    label: 'Licensing unverified',
    meaning: 'Reachable and correctly credentialled is not usable: redistribution rights for a client-facing PDF, permitted cache duration and the right to persist a derived metric are commercial facts and none is settled.',
    owner: 'commercial',
    tone: 'attention',
  },
};

export interface ProviderCredentialGroup {
  provider: string;
  label: string;
  /** Credential NAMES only, with whether each is set. Never a value. */
  names: ReadonlyArray<{ name: string; set: boolean }>;
  /** True when at least one name for this provider is set. */
  anySet: boolean;
}

/** Which credential names belong to which provider, for grouping alone. */
const PROVIDER_PREFIX: ReadonlyArray<{ provider: string; label: string; prefix: string }> = [
  { provider: 'domain', label: 'Domain', prefix: 'DOMAIN_' },
  { provider: 'cotality', label: 'Cotality (CoreLogic)', prefix: 'COTALITY_' },
  { provider: 'proptrack', label: 'PropTrack', prefix: 'PROPTRACK_' },
  { provider: 'pricefinder', label: 'Pricefinder', prefix: 'PRICEFINDER_' },
  { provider: 'sqm_research', label: 'SQM Research', prefix: 'SQM_RESEARCH_' },
];

/**
 * Group the probe's presence block by provider.
 *
 * Takes booleans, so no credential value is ever in scope. A name matching no
 * declared prefix is kept under `other` rather than dropped — a name the probe
 * reports and this reading cannot place is a finding, not noise.
 */
export function groupCredentialPresence(
  present: Readonly<Record<string, boolean>>,
): ReadonlyArray<ProviderCredentialGroup> {
  const groups: ProviderCredentialGroup[] = [];
  const placed = new Set<string>();

  for (const { provider, label, prefix } of PROVIDER_PREFIX) {
    const names = Object.keys(present)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((name) => {
        placed.add(name);
        return { name, set: present[name] === true };
      });
    if (names.length === 0) continue;
    groups.push({ provider, label, names, anySet: names.some((n) => n.set) });
  }

  const unplaced = Object.keys(present).filter((n) => !placed.has(n)).sort();
  if (unplaced.length > 0) {
    const names = unplaced.map((name) => ({ name, set: present[name] === true }));
    groups.push({ provider: 'other', label: 'Other declared names', names, anySet: names.some((n) => n.set) });
  }

  return groups;
}

/** The one-line state of the whole probe, for a heading. */
export function summariseProbe(
  present: Readonly<Record<string, boolean>>,
): { anyCredentialSet: boolean; setCount: number; declaredCount: number; reading: string } {
  const names = Object.keys(present);
  const setCount = names.filter((n) => present[n] === true).length;
  return {
    anyCredentialSet: setCount > 0,
    setCount,
    declaredCount: names.length,
    reading: setCount === 0
      ? 'No market-data credential is set in this deployment’s runtime. Every network row below describes an unauthenticated request, so none of them can establish entitlement.'
      : `${setCount} of ${names.length} declared credential names are set. Presence is not entitlement and not a licence.`,
  };
}
