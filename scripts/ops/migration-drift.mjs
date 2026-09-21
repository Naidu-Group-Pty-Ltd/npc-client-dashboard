#!/usr/bin/env node
/**
 * Report which merged migrations have not reached the database.
 *
 *   node scripts/ops/migration-drift.mjs --facts facts.json [--json] [--quiet-unverifiable]
 *
 * `facts.json` is what the workflow's psql probe collected — the database
 * side of the question, so this process needs no credential:
 *
 *   {
 *     "appliedVersions": ["20250124160000", ...],
 *     "existingObjects": ["table:public.urban_centre_register", ...],
 *     "probeResults":    { "20261209000000_seed_....sql": true }
 *   }
 *
 * Exit 1 when anything is `not_applied`. `unverifiable` does not fail the run
 * on its own — 800-odd historical files declare no probe and failing on them
 * would make this report the thing people switch off — but it is always
 * printed, and a file added from here on can close its own gap with one line.
 *
 * See `migrationDrift.pure.mjs` for why the ledger cannot answer this.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { objectsCreatedIn, effectProbeIn } from '../build-migration-object-index.mjs';
import { assessMigrationDrift, probeIsReadOnly } from './migrationDrift.pure.mjs';

const MIGRATIONS_DIR = 'supabase/migrations';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const has = (name) => process.argv.includes(name);

/** Every migration in the repo, with what it creates and what it claims. */
export function readRepoMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort()
    .map((file) => {
      const src = readFileSync(join(dir, file), 'utf8');
      const probe = effectProbeIn(src);
      return {
        version: file.slice(0, 14),
        file,
        objects: objectsCreatedIn(src),
        // A probe that is not a lone SELECT is refused here rather than sent to
        // the database, and the file is then judged on its objects alone.
        probe: probe && probeIsReadOnly(probe) ? probe : null,
        probeRefused: Boolean(probe) && !probeIsReadOnly(probe),
      };
    });
}

function main() {
  const factsPath = arg('--facts');
  if (!factsPath) {
    console.error('usage: node scripts/ops/migration-drift.mjs --facts <facts.json> [--json]');
    process.exit(2);
  }
  const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  const migrations = readRepoMigrations();
  const refused = migrations.filter((m) => m.probeRefused);

  const result = assessMigrationDrift({
    migrations,
    appliedVersions: facts.appliedVersions ?? [],
    existingObjects: facts.existingObjects ?? [],
    probeResults: facts.probeResults ?? {},
  });

  if (has('--json')) {
    console.log(JSON.stringify({ ...result, refusedProbes: refused.map((m) => m.file) }, null, 2));
  } else {
    const n = migrations.length;
    console.log(`Migration drift — ${n} migration(s) in the repo, `
      + `${(facts.appliedVersions ?? []).length} recorded in the ledger.\n`);
    console.log(`  effect present : ${result.effectPresent.length.toString().padStart(4)}  `
      + '(unrecorded, but what they do is already done)');
    console.log(`  unverifiable   : ${result.unverifiable.length.toString().padStart(4)}  `
      + '(create no object, declare no @effect probe)');
    console.log(`  NOT APPLIED    : ${result.notApplied.length.toString().padStart(4)}  `
      + '(merged, and the database does not carry it)');

    if (refused.length) {
      console.log('\nRefused @effect probes (not a lone SELECT — never executed):');
      for (const m of refused) console.log(`  - ${m.file}`);
    }

    if (result.notApplied.length) {
      console.log('\nNOT APPLIED — oldest first:\n');
      for (const r of result.notApplied) {
        console.log(`  ${r.file}`);
        console.log(`      ${r.why}`);
        for (const o of r.missing.slice(0, 5)) console.log(`      missing: ${o}`);
        if (r.missing.length > 5) console.log(`      …and ${r.missing.length - 5} more`);
      }
      console.log('\nApply one with the "Apply a migration" workflow, newest-last.');
    }

    if (!has('--quiet-unverifiable') && result.unverifiable.length) {
      const recent = result.unverifiable.slice(-15);
      console.log(`\nUnverifiable — the ${recent.length} most recent of `
        + `${result.unverifiable.length}. Add one line to close the gap:`);
      console.log('  -- @effect: select 1 from <table> where <the row this file writes>\n');
      for (const r of recent) console.log(`  ${r.file}`);
    }
  }

  process.exit(result.notApplied.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
