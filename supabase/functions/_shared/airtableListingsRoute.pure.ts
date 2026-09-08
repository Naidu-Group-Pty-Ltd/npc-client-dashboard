/**
 * Where a Listings & Overview Airtable read goes, and what it carries.
 *
 * ## Why a deployment might not hold the token at all
 *
 * The Listings and Overview pages are built from one table — `Property Intake
 * Master` in the `NPC Emails` base — and every clone shows the SAME
 * marketplace, so every clone needs the same token and the same base id. The
 * fleet-wide answer was to forward all six `AIRTABLE_*` names to every clone.
 *
 * An Airtable personal access token carries its whole scope: a set of BASES
 * and a set of PERMISSIONS, fixed when it was minted. Nothing in the
 * credential narrows it to one table. So a forwarded token on a tenant's
 * Supabase project reaches every base its scope admits — and if that scope
 * includes `data.records:write`, it can rewrite the shared intake table every
 * other clone reads. Airtable has no per-tenant sub-credential to mint.
 *
 * The credential therefore stops travelling and the CALL travels instead:
 * Mission Control holds the one token and the one base id, and runs the read
 * on a tenant's behalf, authenticated by the Mission Control key the clone
 * already has. The prime is the account holder and still reads Airtable
 * directly.
 *
 * ## The three rules
 *
 * **The direct route requires the vendor token and nothing else decides it.**
 * A deployment holding `AIRTABLE_TOKEN` is one entitled to spend it — that is
 * the prime, and any future deployment given its own Airtable account.
 *
 * **A brokered read must NOT be metered here.** Mission Control writes the
 * usage row because Mission Control made the vendor call. Metering at both
 * ends bills the tenant twice, which this platform's own rule names as worse
 * than not billing at all. `meter` is what carries that.
 *
 * **A brokered route holds no base id, structurally.** The `broker` branch of
 * `ListingsRoute` has no `baseId` field, so `listingsRequestUrl` cannot put
 * one in a brokered URL even by mistake. Mission Control's own rule is that
 * the base is its and the caller never names one; this is the clone-side half
 * of that rule, enforced by the type rather than by a comment.
 *
 * Pure: no Deno, so the frontend tests import it too.
 */

/** The read operations Mission Control brokers. Both ends name them explicitly. */
export const BROKERED_LISTINGS_OPERATIONS = ['tables', 'records', 'selftest'] as const;
export type BrokeredListingsOperation = (typeof BROKERED_LISTINGS_OPERATIONS)[number];

export const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

export type ListingsQuery = {
  readonly table?: string;
  readonly pageSize?: number;
  readonly offset?: string;
  readonly sortField?: string;
  readonly sortDirection?: 'asc' | 'desc';
};

export type ListingsRoute =
  | {
      via: 'direct';
      /** Only the direct route knows a base id, because only it holds the token. */
      baseId: string;
      headers: Record<string, string>;
      /** The credential to redact from any error text on this route. */
      secret: string;
      /** Direct reads spend the vendor token here, so they are metered here. */
      meter: true;
    }
  | {
      via: 'broker';
      missionControlUrl: string;
      headers: Record<string, string>;
      secret: string;
      /** Mission Control meters the vendor call it makes. Never both. */
      meter: false;
    }
  | { via: 'unconfigured'; why: string };

export function resolveListingsRoute(input: {
  airtableToken: string | null | undefined;
  airtableBaseId: string | null | undefined;
  missionControlUrl: string | null | undefined;
  cloneApiKey: string | null | undefined;
}): ListingsRoute {
  const token = (input.airtableToken ?? '').trim();
  const baseId = (input.airtableBaseId ?? '').trim();

  if (token && baseId) {
    return {
      via: 'direct',
      baseId,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      secret: token,
      meter: true,
    };
  }

  /*
   * A token with no base id is a misconfiguration and never a reason to
   * broker: brokering it would silently read a DIFFERENT base from the one
   * this deployment was set up for, and produce a plausible marketplace of
   * somebody else's listings. Say so instead.
   */
  if (token && !baseId) {
    return {
      via: 'unconfigured',
      why: 'AIRTABLE_TOKEN is set but AIRTABLE_BASE_ID is not, so this deployment cannot say which base to read',
    };
  }

  const mcUrl = (input.missionControlUrl ?? '').trim().replace(/\/+$/, '');
  const cloneKey = (input.cloneApiKey ?? '').trim();
  if (!mcUrl || !cloneKey) {
    return {
      via: 'unconfigured',
      why:
        'the Listings pipeline needs either AIRTABLE_TOKEN and AIRTABLE_BASE_ID, or ' +
        'MISSION_CONTROL_URL and MISSION_CONTROL_CLONE_API_KEY to reach the broker',
    };
  }

  return {
    via: 'broker',
    missionControlUrl: mcUrl,
    headers: { 'x-clone-api-key': cloneKey, Accept: 'application/json' },
    secret: cloneKey,
    meter: false,
  };
}

/** The five parameters both ends carry, and nothing else. */
function appendQuery(url: URL, q: ListingsQuery, includeTable: boolean): void {
  if (includeTable && q.table) url.searchParams.set('table', q.table);
  if (q.pageSize !== undefined) url.searchParams.set('pageSize', String(q.pageSize));
  if (q.offset) url.searchParams.set('offset', q.offset);
  if (q.sortField) {
    url.searchParams.set('sortField', q.sortField);
    url.searchParams.set('sortDirection', q.sortDirection ?? 'desc');
  }
}

/**
 * The URL for one read on this route.
 *
 * On the DIRECT route this is Airtable's own shape — the base id from the
 * route, the table in the path, and Airtable's `sort[0][field]` spelling. On
 * the BROKER route it is Mission Control's, and there is no base id to put in
 * it because the route does not carry one.
 */
export function listingsRequestUrl(
  route: ListingsRoute,
  operation: BrokeredListingsOperation,
  table: string,
  q: ListingsQuery = {},
): string {
  if (route.via === 'unconfigured') {
    throw new Error(`listingsRequestUrl called on an unconfigured route: ${route.why}`);
  }

  if (route.via === 'broker') {
    const url = new URL(`${route.missionControlUrl}/api/public/listings/${operation}`);
    appendQuery(url, { ...q, table }, true);
    return url.toString();
  }

  if (operation === 'tables') {
    return `${AIRTABLE_API_BASE}/meta/bases/${encodeURIComponent(route.baseId)}/tables`;
  }
  const url = new URL(
    `${AIRTABLE_API_BASE}/${encodeURIComponent(route.baseId)}/${encodeURIComponent(table)}`,
  );
  url.searchParams.set('pageSize', String(q.pageSize ?? 100));
  if (q.offset) url.searchParams.set('offset', q.offset);
  if (q.sortField) {
    url.searchParams.set('sort[0][field]', q.sortField);
    url.searchParams.set('sort[0][direction]', q.sortDirection ?? 'desc');
  }
  return url.toString();
}

/**
 * Whether an answer came from Mission Control refusing, rather than Airtable.
 *
 * Read from the header Mission Control sets on its OWN refusals and never on
 * what it relays. Both ends can answer 401/403/429 with similar JSON and they
 * send an operator to opposite remedies — "fix the clone's Mission Control
 * key" versus "fix the Airtable token" — so this is read from the header
 * rather than guessed from a body.
 */
export function missionControlRefusal(headers: Headers): string | null {
  return headers.get('x-mission-control-refusal');
}
