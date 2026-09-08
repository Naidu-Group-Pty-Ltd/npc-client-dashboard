import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AIRTABLE_RECORD_ID,
  BROKERED_LISTINGS_OPERATIONS,
  listingsRequestUrl,
  MAX_RECORD_IDS,
  missionControlRefusal,
  recordIdFormula,
  refuseRecordIds,
  resolveListingsRoute,
  resolveWritebackRoute,
  writebackRequestUrl,
} from '../../../supabase/functions/_shared/airtableListingsRoute.pure.ts';

const src = readFileSync('supabase/functions/_shared/airtableListingsRoute.pure.ts', 'utf8');

const MC = { missionControlUrl: 'https://mc.example', cloneApiKey: 'ck_live' };

describe('the direct route belongs to a deployment that holds the token', () => {
  it('is taken when the token AND the base id are both present', () => {
    const r = resolveListingsRoute({
      airtableToken: 'pat123',
      airtableBaseId: 'appNPC',
      ...MC,
    });
    expect(r.via).toBe('direct');
    if (r.via !== 'direct') throw new Error('unreachable');
    expect(r.baseId).toBe('appNPC');
    expect(r.meter).toBe(true);
  });

  it('wins over the broker even when both are configured', () => {
    // Holding the vendor token IS the entitlement to spend it.
    const r = resolveListingsRoute({ airtableToken: 'pat', airtableBaseId: 'app', ...MC });
    expect(r.via).toBe('direct');
  });
});

describe('a token with no base id is unconfigured, and never brokered', () => {
  it('refuses rather than silently reading Mission Control base', () => {
    // Brokering here would return a plausible marketplace of somebody else's
    // listings, which is worse than an empty page because it looks like data.
    const r = resolveListingsRoute({ airtableToken: 'pat', airtableBaseId: '', ...MC });
    expect(r.via).toBe('unconfigured');
    if (r.via !== 'unconfigured') throw new Error('unreachable');
    expect(r.why).toContain('AIRTABLE_BASE_ID');
  });
});

describe('the brokered route carries no base id at all', () => {
  const r = resolveListingsRoute({ airtableToken: '', airtableBaseId: '', ...MC });

  it('is taken when the deployment holds no token', () => {
    expect(r.via).toBe('broker');
  });

  it('has no baseId field to leak, structurally', () => {
    expect(Object.keys(r)).not.toContain('baseId');
  });

  it('builds a Mission Control URL and never an Airtable one', () => {
    const url = listingsRequestUrl(r, 'records', 'Property Intake Master', { pageSize: 100 });
    expect(url.startsWith('https://mc.example/api/public/listings/records')).toBe(true);
    expect(url).not.toContain('api.airtable.com');
  });

  it('never puts a base id in a brokered URL', () => {
    const url = listingsRequestUrl(r, 'records', 'Property Intake Master', {});
    expect(url).not.toMatch(/base/i);
  });

  it('is NOT metered here — Mission Control meters the call it makes', () => {
    if (r.via !== 'broker') throw new Error('unreachable');
    expect(r.meter).toBe(false);
  });

  it('authenticates with the clone key and never an Airtable bearer', () => {
    if (r.via !== 'broker') throw new Error('unreachable');
    expect(r.headers['x-clone-api-key']).toBe('ck_live');
    expect(Object.keys(r.headers)).not.toContain('Authorization');
  });
});

describe('metering is never both ends', () => {
  it('exactly one route meters, and it is the one that spends the vendor token', () => {
    const direct = resolveListingsRoute({ airtableToken: 't', airtableBaseId: 'b', ...MC });
    const broker = resolveListingsRoute({ airtableToken: '', airtableBaseId: '', ...MC });
    const meters = [direct, broker].filter((r) => r.via !== 'unconfigured' && r.meter);
    expect(meters).toHaveLength(1);
    expect(meters[0].via).toBe('direct');
  });
});

describe('unconfigured is a named state, never a silent unauthenticated call', () => {
  it('names both halves when neither is present', () => {
    const r = resolveListingsRoute({
      airtableToken: '',
      airtableBaseId: '',
      missionControlUrl: '',
      cloneApiKey: '',
    });
    expect(r.via).toBe('unconfigured');
    if (r.via !== 'unconfigured') throw new Error('unreachable');
    expect(r.why).toContain('AIRTABLE_TOKEN');
    expect(r.why).toContain('MISSION_CONTROL_URL');
  });

  it('throws rather than building a URL on an unconfigured route', () => {
    const r = resolveListingsRoute({
      airtableToken: '',
      airtableBaseId: '',
      missionControlUrl: '',
      cloneApiKey: '',
    });
    expect(() => listingsRequestUrl(r, 'records', 'T')).toThrow(/unconfigured/);
  });
});

describe('the direct URL keeps Airtable own spelling', () => {
  const r = resolveListingsRoute({ airtableToken: 'p', airtableBaseId: 'appX', ...MC });

  it('uses sort[0][field], which is what Airtable accepts', () => {
    const url = listingsRequestUrl(r, 'records', 'Intake', { sortField: 'Created', sortDirection: 'desc' });
    expect(decodeURIComponent(url)).toContain('sort[0][field]=Created');
  });

  it('reads the schema from the meta endpoint for this base', () => {
    expect(listingsRequestUrl(r, 'tables', 'ignored')).toBe(
      'https://api.airtable.com/v0/meta/bases/appX/tables',
    );
  });
});

describe('who refused is read from a header, never guessed from a body', () => {
  it('names Mission Control refusal when the header is set', () => {
    const h = new Headers({ 'x-mission-control-refusal': 'table_not_allowed' });
    expect(missionControlRefusal(h)).toBe('table_not_allowed');
  });

  it('is null for a relayed vendor answer', () => {
    expect(missionControlRefusal(new Headers({ 'content-type': 'application/json' }))).toBeNull();
  });
});

describe('the module stays pure and coupling-free', () => {
  it('names the three brokered operations and no path a caller supplies', () => {
    expect([...BROKERED_LISTINGS_OPERATIONS]).toEqual(['tables', 'records', 'selftest']);
  });

  it('imports nothing at all', () => {
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it('never reads Deno.env — the caller passes what it read', () => {
    expect(src).not.toContain('Deno.env');
  });
});

/* -------------------------------------------------------------------------- */
/* Adoption: the two consumers must actually go through the route.            */
/* -------------------------------------------------------------------------- */

/**
 * A source file with its comments stripped.
 *
 * Every source-level assertion below is about what the code DOES. These
 * functions explain in their own comments what they no longer do — the old
 * `api.airtable.com` URL, the old `pageSize=${listingIds.length}` — and a scan
 * that reads an explanation as a violation is one people satisfy by deleting
 * the explanation.
 */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const proxy = readFileSync('supabase/functions/airtable-proxy/index.ts', 'utf8');
const cache = readFileSync('supabase/functions/listings-cache/index.ts', 'utf8');

describe('neither consumer reaches Airtable directly any more', () => {
  it('airtable-proxy builds every URL from the route', () => {
    // A surviving literal would be a path that still needs the token and so
    // still fails on a clone — the exact half-adoption this change exists to
    // remove.
    expect(proxy).not.toContain('api.airtable.com');
    expect(proxy).toContain('listingsRequestUrl');
  });

  it('listings-cache builds every URL from the route', () => {
    expect(cache).not.toContain('api.airtable.com');
    expect(cache).toContain('listingsRequestUrl');
  });

  it('neither builds an Airtable bearer header of its own', () => {
    // The credential belongs to the route, which is the only place that knows
    // whether this deployment is entitled to spend one.
    for (const src of [proxy, cache]) {
      expect(src).not.toMatch(/Bearer \$\{\s*(token|config\.token)\s*\}/);
    }
  });
});

describe('a brokered read is not metered at the clone', () => {
  it('airtable-proxy logs usage only on the metered route', () => {
    // Mission Control writes the usage row for a call Mission Control made.
    // Metering at both ends bills the tenant twice.
    const idx = proxy.indexOf('logApiUsage(supabase, {');
    expect(idx).toBeGreaterThan(-1);
    const before = proxy.slice(Math.max(0, idx - 600), idx);
    expect(before).toContain('if (route.meter)');
  });

  it('listings-cache meters nothing at all, so there is nothing to guard', () => {
    expect(cache).not.toContain('logApiUsage');
  });
});

describe('an unconfigured deployment says which half is missing', () => {
  it('both consumers carry the reason out rather than a bare refusal', () => {
    for (const src of [proxy, cache]) {
      expect(src).toMatch(/route\.via === 'unconfigured'/);
      expect(src).toContain('route.why');
    }
  });
});

const images = readFileSync('supabase/functions/listing-images/index.ts', 'utf8');
const enrichment = readFileSync('supabase/functions/listing-enrichment/index.ts', 'utf8');
const autoReport = readFileSync('supabase/functions/auto-report-sync/index.ts', 'utf8');

const ID_A = 'recAAAAAAAAAAAAAA';
const ID_B = 'recBBBBBBBBBBBBBB';

/**
 * Reading the photograph columns is what puts pictures on a listing, and it is
 * the one read expressed in Airtable as a formula.
 *
 * A clone held no Airtable token and `listing-images` still built a direct
 * Airtable URL, so `airtableConfig()` returned null and the sweep refused
 * before it began: a marketplace with no photographs on any card. Brokering it
 * meant admitting the read WITHOUT admitting a query language, which is what
 * `recordIds` is — the caller names rows, this module composes the formula.
 */
describe('a read may name rows, never ask a question', () => {
  it('accepts Airtable record ids and rejects anything that could be an expression', () => {
    expect(AIRTABLE_RECORD_ID.test(ID_A)).toBe(true);
    for (const bad of ["rec'),RECORD_ID()='x", 'recSHORT', 'tblAAAAAAAAAAAAAA', 'rec AAAAAAAAAAAAA']) {
      expect(AIRTABLE_RECORD_ID.test(bad)).toBe(false);
    }
  });

  it('refuses an empty, oversized or malformed set rather than filtering it', () => {
    // Silently dropping one would fingerprint that listing as having no
    // photographs and re-arm its schedule having done nothing.
    expect(refuseRecordIds([])).toBeTruthy();
    expect(refuseRecordIds(Array(MAX_RECORD_IDS + 1).fill(ID_A))).toBeTruthy();
    expect(refuseRecordIds([ID_A, 'nope'])).toBeTruthy();
    expect(refuseRecordIds([ID_A, ID_B])).toBeNull();
  });

  it('composes the formula only from checked ids', () => {
    expect(recordIdFormula([ID_A, ID_B])).toBe(
      `OR(RECORD_ID()='${ID_A}',RECORD_ID()='${ID_B}')`,
    );
    expect(() => recordIdFormula(["'"])).toThrow();
  });

  it('sends IDS on the brokered route and a FORMULA on the direct one', () => {
    const broker = new URL(
      listingsRequestUrl(resolveListingsRoute({ ...MC, airtableToken: null, airtableBaseId: null }), 'records', 'Intake', {
        recordIds: [ID_A, ID_B],
      }),
    );
    // Nothing Mission Control could mistake for a query.
    expect(broker.searchParams.get('recordIds')).toBe(`${ID_A},${ID_B}`);
    expect(broker.searchParams.get('filterByFormula')).toBeNull();

    const direct = new URL(
      listingsRequestUrl(
        resolveListingsRoute({ airtableToken: 'pat', airtableBaseId: 'appNPC', ...MC }),
        'records',
        'Intake',
        { recordIds: [ID_A, ID_B] },
      ),
    );
    // The deployment holding the token writes its own formula.
    expect(direct.searchParams.get('filterByFormula')).toBe(recordIdFormula([ID_A, ID_B]));
    expect(direct.searchParams.get('recordIds')).toBeNull();
  });

  it('refuses to build a URL from ids it has not checked, on either route', () => {
    for (const route of [
      resolveListingsRoute({ ...MC, airtableToken: null, airtableBaseId: null }),
      resolveListingsRoute({ airtableToken: 'pat', airtableBaseId: 'app', ...MC }),
    ]) {
      expect(() => listingsRequestUrl(route, 'records', 'Intake', { recordIds: ["'"] })).toThrow();
    }
  });
});

/**
 * The write-back is the other half, and it does NOT travel.
 *
 * `listing-images` publishes signed URLs into its own bucket, and
 * `listing-enrichment` writes resolved field values — into a table every
 * deployment reads. From a clone those URLs point at storage no other reader
 * can open, so the act is wrong there for a reason that has nothing to do with
 * secrecy, and the broker must never grow a write operation to carry it.
 */
describe('the write-back never leaves the account holder', () => {
  it('is direct where the token is held', () => {
    const w = resolveWritebackRoute({ airtableToken: 'pat', airtableBaseId: 'appNPC' });
    expect(w.via).toBe('direct');
    if (w.via !== 'direct') throw new Error('unreachable');
    expect(writebackRequestUrl(w, 'Intake')).toBe('https://api.airtable.com/v0/appNPC/Intake');
  });

  it('is refused everywhere else, and there is no brokered branch to fall to', () => {
    for (const input of [
      { airtableToken: null, airtableBaseId: null },
      { airtableToken: 'pat', airtableBaseId: null },
      { airtableToken: null, airtableBaseId: 'appNPC' },
    ]) {
      const w = resolveWritebackRoute(input);
      expect(w.via).toBe('refused');
      if (w.via !== 'refused') throw new Error('unreachable');
      // The refusal names the RULE. "Not configured" would send an operator
      // looking for a setting that must never exist on a clone.
      expect(w.why).toMatch(/shared record|does not hold/);
      expect(() => writebackRequestUrl(w, 'Intake')).toThrow();
    }
  });

  it('the type carries no broker option at all', () => {
    expect(src).not.toMatch(/WritebackRoute[\s\S]{0,400}via: 'broker'/);
  });
});

describe('every Airtable reader in the pipeline goes through the router', () => {
  it('none of the five names api.airtable.com itself', () => {
    for (const [name, source] of [
      ['airtable-proxy', proxy],
      ['listings-cache', cache],
      ['listing-images', images],
      ['listing-enrichment', enrichment],
      ['auto-report-sync', autoReport],
    ] as const) {
      expect(codeOf(source), name).not.toContain('api.airtable.com');
    }
  });

  it('none of them builds an Airtable bearer header of its own', () => {
    for (const source of [proxy, cache, images, enrichment, autoReport]) {
      expect(codeOf(source)).not.toMatch(/Authorization: `Bearer \$\{[^}]*[Tt]oken/);
    }
  });

  it('the two writers refuse rather than reporting a missing setting', () => {
    for (const source of [images, enrichment]) {
      expect(source).toContain('resolveWritebackRoute');
      expect(source).toMatch(/via === 'refused'/);
    }
  });

  it('listing-images chunks a sweep larger than one read may name', () => {
    // A sweep can claim 120; the old code sent `pageSize=${listingIds.length}`,
    // which Airtable rejects above 100.
    expect(images).toContain('MAX_RECORD_IDS');
    expect(codeOf(images)).not.toMatch(/pageSize=\$\{listingIds\.length\}/);
  });

  it('a brokered refusal is told apart from a vendor one at every reader', () => {
    for (const source of [images, autoReport]) {
      expect(source).toContain('x-mission-control-refusal');
    }
  });
});

/**
 * When a brokered read fails, the clone must be able to say WHICH END refused.
 *
 * Mission Control and Airtable both answer 401, 403 and 429, and the remedies
 * are opposite: one is fixed in Mission Control's environment, the other on
 * this deployment. `x-mission-control-refusal` is set on Mission Control's OWN
 * refusals and never on what it relays, so the header's ABSENCE is what
 * identifies a vendor answer.
 *
 * Measured 8 Sep 2026 on NPC Test — the first brokered read the fleet ever
 * made. It failed and `listings_cache_sync.last_error` read `airtable_401`,
 * which happened to be TRUE (Mission Control had made the call and Airtable
 * refused its token). But it was true by luck: the same six characters would
 * have been written had Mission Control rejected the clone's key, and an
 * operator reading that row had nothing to tell the two apart.
 */
describe('a failed read names the end that refused', () => {
  const withHeader = new Headers({ 'x-mission-control-refusal': 'unauthorized' });
  const without = new Headers();

  it('reads the header rather than guessing from the body', () => {
    expect(missionControlRefusal(withHeader)).toBe('unauthorized');
    expect(missionControlRefusal(without)).toBeNull();
  });

  it('every consumer that can take the brokered route reads it', () => {
    // `listing-enrichment` is deliberately absent: its only Airtable call is
    // the write-back, which is never brokered, so there is no second end for
    // it to distinguish.
    for (const [name, source] of [
      ['airtable-proxy', proxy],
      ['listings-cache', cache],
      ['listing-images', images],
      ['auto-report-sync', autoReport],
    ] as const) {
      expect(codeOf(source), name).toMatch(
        /missionControlRefusal|x-mission-control-refusal/,
      );
    }
  });

  it('listings-cache carries the distinction out to the sync row', () => {
    // The sync row is the only record an operator sees for a cron-driven read,
    // so a warning in a log the fleet page does not show is not enough.
    expect(codeOf(cache)).toMatch(/mission_control_\$\{refusal\}/);
    expect(codeOf(cache)).toMatch(/airtable_\$\{response\.status\}/);
  });

  it('airtable-proxy labels the SERVICE it reports, rather than always saying Airtable', () => {
    expect(codeOf(proxy)).toMatch(/redactUpstreamError\([^)]*service\)/);
    expect(codeOf(proxy)).not.toMatch(/redactUpstreamError\([^)]*'Airtable'\)/);
  });
});
