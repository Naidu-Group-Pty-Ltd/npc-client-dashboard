/**
 * THE ACTIVATION DOOR ACTS ONLY FOR THE CLIENTS ITS CALLER MAY ACT FOR.
 *
 * Opening `builder-stock-marketplace` to the registered Clients module
 * (`builderStockClientsModuleKey.spec.ts`) let a Client Management holder in
 * for the first time — and the function runs on the service role, so nothing
 * underneath it scoped what they reached. Independent review, 28 September
 * 2026: any holder could list every activation with its client's name and the
 * Command Centre's internal notes, activate stock for any client id, withdraw
 * another agent's activation, and search the whole client directory.
 * `get-client-data` has always held the same module to a narrower rule: a
 * staff member reaches the clients they created or are assigned, a superadmin
 * every client (`_shared/clientAccess.ts`). The door now applies that rule to
 * all five operations: reads are filtered, writes on another's client answer
 * "not found".
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { clientScopeOf } from '../../../supabase/functions/_shared/clientAccess.ts';
import { readPropertyDetail } from '../../../supabase/functions/_shared/builderStock/propertyDetail.ts';

const ROOT = resolve(__dirname, '../../..');
const DOOR = readFileSync(join(ROOT, 'supabase/functions/builder-stock-marketplace/index.ts'), 'utf8');
const operation = (name: string) => {
  const start = DOOR.indexOf(`operation === '${name}'`);
  const next = DOOR.indexOf("if (operation === '", start + 20);
  return DOOR.slice(start, next === -1 ? undefined : next);
};

const STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWN = '11111111-1111-4111-8111-111111111111';
const ASSIGNED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

/** Clients with who created them and who they are assigned to. */
const CLIENTS = [
  { id: OWN, created_by: STAFF, assigned_team_user_id: null, primary_first_name: 'Own', primary_surname: 'Client' },
  { id: ASSIGNED, created_by: 'someone-else', assigned_team_user_id: STAFF, primary_first_name: 'Assigned', primary_surname: 'Client' },
  { id: OTHER, created_by: 'someone-else', assigned_team_user_id: 'another', primary_first_name: 'Other', primary_surname: 'Client' },
];

function stub({ superadmin = false, failClients = false } = {}) {
  return {
    from(table: string) {
      if (table === 'custom_users') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { role: superadmin ? 'superadmin' : 'agent' } }) }),
            in: async () => ({ data: [], error: null }),
          }),
        };
      }
      if (table === 'user_roles') return { select: () => ({ eq: async () => ({ data: [] }) }) };
      if (table === 'clients') {
        return {
          select: () => ({
            eq: (column: string, value: string) => ({
              limit: async () => failClients
                ? { data: null, error: { message: 'boom' } }
                : { data: CLIENTS.filter((c) => (c as Record<string, unknown>)[column] === value).map((c) => ({ id: c.id })), error: null },
            }),
            in: async (_column: string, ids: string[]) => ({
              data: CLIENTS.filter((c) => ids.includes(c.id)), error: null,
            }),
          }),
        };
      }
      if (table === 'builder_stock_selections') {
        const rows = [OWN, ASSIGNED, OTHER].map((client_id, i) => ({
          id: `sel-${i}`, status: 'selected', selected_at: `2026-09-2${i}T00:00:00Z`, acknowledged_at: null,
          withdrawn_at: null, selected_by_user_id: null, client_id,
        }));
        const chain = { eq: () => chain, order: () => chain, limit: async () => ({ data: rows, error: null }) };
        return { select: () => chain };
      }
      const empty = { eq: () => empty, order: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
      return { select: () => empty };
    },
  };
}

describe('the clients a staff member may act for', () => {
  it('are their own and those assigned to them', async () => {
    const scope = await clientScopeOf(stub(), { userId: STAFF });
    expect(scope && [...scope].sort()).toEqual([OWN, ASSIGNED].sort());
  });

  it('are every client for a superadmin (no scope)', async () => {
    expect(await clientScopeOf(stub({ superadmin: true }), { userId: STAFF })).toBeNull();
  });

  it('are none when the read fails, and none for nobody', async () => {
    expect(await clientScopeOf(stub({ failClients: true }), { userId: STAFF })).toEqual(new Set());
    expect(await clientScopeOf(stub(), { userId: null })).toEqual(new Set());
  });
});

describe('the property page names only the clients its reader may act for', () => {
  it('leaves another agent\'s client unnamed', async () => {
    const detail = await readPropertyDetail(stub() as never, { id: 'item', organisation_id: 'org' },
      { includeClients: true, clientScope: new Set([OWN, ASSIGNED]) });
    const named = JSON.stringify(detail);
    expect(named).toContain('Own');
    expect(named).toContain('Assigned');
    expect(named).not.toContain('Other');
  });
});

describe('every operation of the door applies the scope', () => {
  it('get_stock_item hands the property page the reader\'s scope', () => {
    expect(operation('get_stock_item')).toMatch(/clientScopeOf\(supabase, actor\)/);
    expect(operation('get_stock_item')).toMatch(/clientScope/);
  });
  it('search_clients searches only within the scope', () => {
    expect(operation('search_clients')).toMatch(/clientScopeOf\(supabase, actor\)/);
  });
  it('list_selections lists only activations for clients within the scope', () => {
    expect(operation('list_selections')).toMatch(/clientScopeOf\(supabase, actor\)/);
  });
  it('select_for_client refuses a client outside the scope as not found, before anything is written', () => {
    const op = operation('select_for_client');
    const check = op.indexOf('canAccessClient(supabase, actor, client.id)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(op.indexOf(".insert("));
  });
  it('set_selection_status refuses another\'s activation as not found, before anything is written', () => {
    const op = operation('set_selection_status');
    const check = op.indexOf('canAccessClient(supabase, actor, selection.client_id)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(op.indexOf('.update('));
  });
});
