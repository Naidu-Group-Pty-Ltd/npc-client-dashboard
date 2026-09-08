import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BROKERED_LISTINGS_OPERATIONS,
  listingsRequestUrl,
  missionControlRefusal,
  resolveListingsRoute,
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
