/**
 * Backend isolation: this deployment's automation must never target another
 * deployment's Supabase project.
 *
 * This repository is a mirror of `npc-property-dashbord`, and it inherited that
 * repo's CI verbatim — including the prime's project ref written in as the
 * DEFAULT target. Three places named it:
 *
 *   - `supabase/config.toml`'s `project_id`, which `rotate-internal-edge-secret`
 *     and `aml-sanctions-refresh` both read to resolve what to act on;
 *   - `deploy-supabase-functions.yml`, twice, as
 *     `vars.SUPABASE_PROJECT_REF || '<prime ref>'` — and that workflow runs on
 *     every push to `main`, so with a `SUPABASE_ACCESS_TOKEN` present it would
 *     have deployed this repo's edge functions into the PRIME's production;
 *   - `apply-migration.yml`, the same way, for migrations.
 *
 * Nothing was ever deployed — the repo has no `SUPABASE_ACCESS_TOKEN`, so the
 * run on 19 Aug 2026 errored with "nothing was deployed" — but the protection
 * was an absent credential rather than a correct target. Adding the secret,
 * which is the obvious thing to do when wiring this repo up, would have been
 * enough on its own.
 *
 * The rule: there is no safe default for "which project". An unset variable is
 * a question, so the workflows fail closed instead of guessing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The prime's project. This repository must not act on it. */
const FOREIGN_PROJECT_REF = 'dduzbchuswwbefdunfct';
/** This deployment's own. */
const OWN_PROJECT_REF = 'plisdzywzleljorrphxv';

const WORKFLOW_DIR = '.github/workflows';
const workflows = readdirSync(join(REPO_ROOT, WORKFLOW_DIR))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ name: f, body: read(join(WORKFLOW_DIR, f)) }));

describe('supabase/config.toml names this deployment, not another', () => {
  const config = read('supabase/config.toml');

  it('declares our own project_id', () => {
    expect(config).toMatch(new RegExp(`^project_id\\s*=\\s*"${OWN_PROJECT_REF}"`, 'm'));
  });

  it('never declares the prime as the target', () => {
    expect(config).not.toMatch(new RegExp(`^project_id\\s*=\\s*"${FOREIGN_PROJECT_REF}"`, 'm'));
  });
});

describe('no workflow can act on a foreign project', () => {
  it('no workflow defaults PROJECT_REF to the prime', () => {
    for (const { name, body } of workflows) {
      // `vars.X || '<prime>'` — the exact shape that made this reachable.
      expect(body, `${name} defaults a project ref to the prime`).not.toMatch(
        new RegExp(`\\|\\|\\s*'${FOREIGN_PROJECT_REF}'`),
      );
    }
  });

  it('no workflow passes the prime to --project-ref', () => {
    for (const { name, body } of workflows) {
      expect(body, `${name} passes the prime to --project-ref`).not.toContain(
        `--project-ref ${FOREIGN_PROJECT_REF}`,
      );
    }
  });

  it('the two project-targeting workflows fail closed on an unset ref', () => {
    for (const name of ['deploy-supabase-functions.yml', 'apply-migration.yml']) {
      const body = workflows.find((w) => w.name === name)?.body ?? '';
      expect(body, `${name} not found`).not.toBe('');
      expect(body, `${name} reads the variable`).toContain('vars.SUPABASE_PROJECT_REF');
      // An empty ref must stop the job rather than reach the CLI as ''.
      expect(body, `${name} has no empty-ref guard`).toMatch(
        /if \[ -z "\$\{PROJECT_REF:-\}" \]; then/,
      );
    }
  });
});

describe('no checked-in CLI state points at another project', () => {
  it('supabase/.temp is not committed', () => {
    // It was, and it held {"ref":"dduzbchuswwbefdunfct"} — the supabase CLI's
    // link file, naming the PRIME. Any bare `supabase ...` run in this repo
    // would have defaulted to the prime's project regardless of config.toml.
    const tracked = execSync('git ls-files supabase/.temp', { cwd: REPO_ROOT })
      .toString().trim();
    expect(tracked, `tracked CLI state: ${tracked}`).toBe('');
  });

  it('no tracked file outside tests names the prime as a project ref', () => {
    const hits = execSync(
      `git grep -l '"ref":"${FOREIGN_PROJECT_REF}"' -- . ':!*__tests__*' || true`,
      { cwd: REPO_ROOT },
    ).toString().trim();
    expect(hits, `files naming the prime as a ref: ${hits}`).toBe('');
  });
});

describe('the app itself resolves its project from one place', () => {
  it('no source file outside the resolver hardcodes a project URL', () => {
    // Guards the fix that made a dedicated backend reachable at all: 31 files
    // used to write the project URL into their own module scope, so
    // VITE_SUPABASE_URL moved nothing.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(rel);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
          if (rel.endsWith(join('integrations', 'supabase', 'env.ts'))) continue;
          if (read(rel).includes(`${FOREIGN_PROJECT_REF}.supabase.co`)) offenders.push(rel);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});
