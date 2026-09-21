#!/usr/bin/env node
/**
 * Collect the database side of the migration-drift question.
 *
 *   SUPABASE_DB_URL=... node .github/scripts/migration-drift-facts.mjs > facts.json
 *
 * Three facts, and nothing else leaves the database: the versions the ledger
 * records, the objects the catalogue holds, and — for each migration that
 * declares one — whether its `@effect` probe is satisfied. No table contents,
 * no row values, only existence.
 *
 * The credential lives here rather than in `scripts/ops/migration-drift.mjs`
 * so the classifier stays pure and testable, which is the same split
 * `apply-migration.yml` already makes between the route and the decision.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { effectProbeIn } from '../../scripts/build-migration-object-index.mjs';
import { probeIsReadOnly } from '../../scripts/ops/migrationDrift.pure.mjs';

const CONN = process.env.SUPABASE_DB_URL;
if (!CONN) {
  console.error('SUPABASE_DB_URL is not set.');
  process.exit(2);
}

/** One query, tuples only, trimmed lines. */
const q = (sql) =>
  execFileSync('psql', [CONN, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const appliedVersions = q(
  'select version from supabase_migrations.schema_migrations order by version',
);

/*
 * The object catalogue, in the same `"<class>:<qualified name>"` spelling the
 * migration object index uses. Indexes and triggers are emitted BOTH qualified
 * and bare, because `CREATE INDEX foo ON t` names no schema and the extractor
 * therefore records a bare name — matching only the qualified form would read
 * every such migration as unapplied.
 */
const existingObjects = q(`
  select 'table:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p')
  union all select 'view:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v'
  union all select 'materialized_view:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='m'
  union all select 'sequence:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'
  union all select 'index:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='i'
  union all select 'index:'||c.relname            from pg_class c where c.relkind='i'
  union all select 'function:'||n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  union all select 'function:'||p.proname         from pg_proc p
  union all select 'trigger:'||t.tgname           from pg_trigger t where not t.tgisinternal
  union all select 'type:'||n.nspname||'.'||t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype in ('e','c','d')
  union all select 'schema:'||nspname             from pg_namespace
`);

const probeResults = {};
for (const file of readdirSync('supabase/migrations').filter((f) => /^\d{14}_.*\.sql$/.test(f))) {
  const probe = effectProbeIn(readFileSync(join('supabase/migrations', file), 'utf8'));
  if (!probe) continue;
  if (!probeIsReadOnly(probe)) {
    // Refused rather than run. `migration-drift.mjs` reports it by name; a
    // probe that is not a lone SELECT never reaches the connection.
    continue;
  }
  try {
    const [row] = q(`select exists(${probe})`);
    probeResults[file] = row === 't';
  } catch (err) {
    // A probe naming a table that does not exist throws, and that IS the
    // answer: the migration that would have created it has not run.
    probeResults[file] = false;
    console.error(`probe failed for ${file}: ${String(err.message ?? err).split('\n')[0]}`);
  }
}

process.stdout.write(JSON.stringify({ appliedVersions, existingObjects, probeResults }, null, 2));
