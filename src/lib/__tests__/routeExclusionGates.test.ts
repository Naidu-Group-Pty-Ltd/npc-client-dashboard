/**
 * The build-time half of client-facing mode, pinned against the runtime half.
 *
 * `App.tsx` drops a page's chunk by folding a `__EXCLUDE_*__` literal, while
 * the navigation filter and `ClientFacingGate` decide the same question from
 * `CLIENT_FACING_HIDDEN_PATHS` and the deployment's allowances. Those are two
 * mechanisms answering one question, and they have already disagreed once: the
 * chunk was dropped while the runtime believed the page was on, so the route
 * resolved to an element with nothing behind it and `/integrations` drew a
 * blank content area.
 *
 * So this asserts the two are wired to the same facts — every gate App.tsx uses
 * is defined in vite.config.ts, every one is derived from a path the hidden
 * list actually names, and the placeholder renders something.
 *
 * Clone-only: `npc-property-dashbord` carries no such gates. A cascade writes
 * the prime's paths and never deletes a file only this repository has.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_FACING_HIDDEN_PATHS } from '../clientFacing';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const appSource = read('src/App.tsx');
const viteSource = read('vite.config.ts');

/** `__EXCLUDE_X__: JSON.stringify(EXCLUDED("/path"))` → [name, path]. */
const definedGates = [
  ...viteSource.matchAll(/(__EXCLUDE_[A-Z_]+__):\s*JSON\.stringify\(EXCLUDED\("([^"]+)"\)\)/g),
].map(([, name, path]) => ({ name, path }));

/** `const Page = __EXCLUDE_X__` — the gates App.tsx actually folds. */
const usedGates = [...appSource.matchAll(/^const \w+ = (__EXCLUDE_[A-Z_]+__)$/gm)].map(
  ([, name]) => name,
);

describe('route exclusion gates', () => {
  it('vite.config.ts defines at least one, and App.tsx uses at least one', () => {
    // Guards the regexes themselves: a rename that silently matched nothing
    // would make every assertion below vacuously true.
    expect(definedGates.length).toBeGreaterThan(0);
    expect(usedGates.length).toBeGreaterThan(0);
  });

  it('every gate App.tsx folds is one vite.config.ts defines', () => {
    const defined = new Set(definedGates.map((gate) => gate.name));
    for (const name of usedGates) {
      expect(defined, name).toContain(name);
    }
  });

  it('every defined gate is used, so a dropped chunk always has a route', () => {
    const used = new Set(usedGates);
    for (const { name } of definedGates) {
      expect(used, name).toContain(name);
    }
  });

  it('every gate is derived from a path the hidden list names', () => {
    // An exclusion keyed on a path the list does not hide would take a page out
    // of the build while the navigation went on linking to it.
    for (const { name, path } of definedGates) {
      expect(CLIENT_FACING_HIDDEN_PATHS, `${name} → ${path}`).toContain(path);
    }
  });

  it('each gate is declared, so TypeScript sees a constant rather than a global', () => {
    const declarations = read('src/client-facing.d.ts');
    for (const { name } of definedGates) {
      expect(declarations, name).toContain(`declare const ${name}: boolean;`);
    }
  });
});

describe('the excluded-route placeholder', () => {
  it('renders the deployment notice rather than nothing', () => {
    // `() => null` is what drew the blank page. A route element that renders
    // nothing cannot be told apart from a page that failed to load.
    expect(appSource).toContain('const RouteExcludedFromBuild = () => <NotOnThisDeployment />;');
    expect(appSource).not.toContain('const RouteExcludedFromBuild = () => null');
  });

  it('takes the notice from the route gate, so both screens are one component', () => {
    expect(appSource).toContain(
      'import { NotOnThisDeployment } from "@/components/auth/ClientFacingGate";',
    );
  });
});
