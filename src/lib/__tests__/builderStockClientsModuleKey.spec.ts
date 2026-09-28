import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE ACTIVATION DOOR ASKS FOR THE CLIENTS MODULE BY THE NAME IT IS REGISTERED UNDER.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Builder Portal Tier-0 audit,
 * phase `stock-tier0-lifecycle`): a Command Centre staff member holding Listings
 * access was refused `select_for_client` with `Not authorized for "clients"`,
 * and so was the withdrawal and the Command Centre's own list of activations.
 * The door asked `requireModulePermission(…, 'clients', …)`, and no deployment
 * registers a module called `clients`: the Clients module is `client_management`
 * (registered by migration `20260128022619`, route `/clients`), which is the key
 * `_shared/permissions.ts` maps the `clients` table to and `get-client-data`
 * gates on. `requireModulePermission` denies an unregistered module to everyone
 * but a superadmin, so no grant an administrator could make would ever open
 * the door — every one of the five activations in production was made by a
 * superadmin. The page asked the same unregistered name, so it hid the button
 * from exactly the people the server would have refused.
 */
const ROOT = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const DOOR = 'supabase/functions/builder-stock-marketplace/index.ts';
const PAGES = ['src/pages/BuilderStockProperty.tsx', 'src/components/listings/BuilderStockTab.tsx'];

const registeredModules = () => {
  const keys = new Set<string>();
  for (const file of readdirSync(join(ROOT, 'supabase/migrations'))) {
    const sql = read(`supabase/migrations/${file}`);
    if (!/INSERT INTO (?:public\.)?dashboard_modules/i.test(sql)) continue;
    for (const block of sql.matchAll(/INSERT INTO (?:public\.)?dashboard_modules[\s\S]*?;/gi)) {
      for (const row of block[0].matchAll(/\(\s*'([a-z_]+)'\s*,/g)) keys.add(row[1]);
    }
  }
  return keys;
};

/** Every module key the door's permission checks name, a constant resolved to its value. */
const doorGates = () => {
  const door = read(DOOR);
  const constants = new Map([...door.matchAll(/const ([A-Z_]+) = '([a-z_]+)';/g)].map((m) => [m[1], m[2]]));
  return [...door.matchAll(/requireModulePermission\(\s*supabase,\s*actor,\s*(?:'([a-z_]+)'|([A-Z_]+)),\s*'(can_view|can_edit)'\)/g)]
    .map((m) => m[1] ?? constants.get(m[2]) ?? `<unresolved ${m[2]}>`);
};

describe('the Builder Stock activation door and its page', () => {
  it('gates every client read and write on the registered Clients module (the measured defect)', () => {
    expect(doorGates().filter((key) => key !== 'listings')).toEqual(Array(5).fill('client_management'));
  });

  it('names only modules a migration registers', () => {
    const registered = registeredModules();
    expect(registered.has('client_management')).toBe(true);
    expect(registered.has('clients')).toBe(false);
    const gates = doorGates();
    expect(gates.length).toBeGreaterThan(5);
    for (const key of gates) expect(registered.has(key), `${key} is not a registered module`).toBe(true);
  }, 30_000);

  it('offers "select for a client" to the people the door admits', () => {
    for (const page of PAGES) {
      const source = read(page);
      expect(source, page).toContain("useModulePermissions('client_management')");
      expect(source, page).not.toContain("useModulePermissions('clients')");
    }
  });
});
