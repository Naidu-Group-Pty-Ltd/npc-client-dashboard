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
  it('NO source file names the prime, the resolver included', () => {
    // Guards the fix that made a dedicated backend reachable at all: 31 files
    // used to write the project URL into their own module scope, so
    // VITE_SUPABASE_URL moved nothing.
    //
    // `env.ts` used to be exempt here, because it legitimately held the prime
    // as the built-in fallback. That exemption is gone, and so is the
    // fallback: the Vercel project never set VITE_SUPABASE_URL, the build fell
    // through, and the deployed client dashboard served the PRIME's production
    // database. A missing variable is the normal state of a new deployment, so
    // a fallback that reaches another tenant is the failure mode rather than
    // the safety net. The prime's ref now appears nowhere under `src/`.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(rel);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
          if (read(rel).includes(FOREIGN_PROJECT_REF)) offenders.push(rel);
        }
      }
    };
    walk('src');
    expect(offenders, `files naming the prime: ${offenders.join(', ')}`).toEqual([]);
  });

  it('NO SHIPPED STATIC FILE names the prime either', () => {
    // `src/` was the whole of the rule, and `public/` is served verbatim —
    // every file in it is copied into `dist/` untouched and reachable on the
    // deployment's own domain.
    //
    // `public/lead-magnet-embed.html` hard-coded the PRIME's project URL *and*
    // the prime's anon key, so every lead captured through the embed on this
    // clone was written into the prime's database, from this clone's domain,
    // for as long as the file has existed. Exactly the defect `env.ts` carried
    // — surviving in the one directory this spec did not look at.
    //
    // A build is not the boundary: it was found by grepping `dist/`, which is
    // too late. So the rule is the source tree, and it is the whole of it.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(rel);
        } else if (read(rel).includes(FOREIGN_PROJECT_REF)) {
          offenders.push(rel);
        }
      }
    };
    walk('public');
    expect(offenders, `shipped files naming the prime: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the built-in fallback pair is THIS deployment, and the pair matches', () => {
    // The pair is what authenticates: a URL from one project with a key from
    // another authenticates to nothing. Assert both halves name the same
    // project, and that the project is ours — so an unconfigured build lands
    // here rather than anywhere else.
    const env = read(join('src', 'integrations', 'supabase', 'env.ts'));

    const url = /const FALLBACK_URL = '([^']+)'/.exec(env)?.[1] ?? '';
    expect(url, 'FALLBACK_URL not found').not.toBe('');
    expect(url).toBe(`https://${OWN_PROJECT_REF}.supabase.co`);

    const key = /const FALLBACK_ANON_KEY =\s*'([^']+)'/.exec(env)?.[1] ?? '';
    expect(key, 'FALLBACK_ANON_KEY not found').not.toBe('');
    const claimedRef = JSON.parse(
      Buffer.from(key.split('.')[1], 'base64').toString('utf8'),
    ).ref as string;
    expect(claimedRef, 'the fallback key belongs to a different project').toBe(OWN_PROJECT_REF);
  });
});
