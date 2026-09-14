#!/usr/bin/env node
/**
 * Builder Portal → Builders Network — the extraction manifest.
 *
 * Phase 0's last deliverable, and the one that is re-run before every phase
 * that moves or deletes anything (docs/builder-portal/45-network-extraction-plan.md
 * §7, and the rule "re-measure before every destructive phase": the dataset
 * grows while we work — stock-list upload testing is live — and two snapshots
 * forty minutes apart have already disagreed by an order of magnitude once).
 *
 * It measures, in one read-only pass against a live database:
 *
 *   1. every builder table's EXACT row count, discovered from the catalogue;
 *   2. the storage corpus — objects and bytes per bucket, plus both
 *      directions of the row↔object cross-check;
 *   3. the six entanglements (E1–E6), sized by live rows;
 *   4. the FK boundary in both directions with its delete rules, which is
 *      what the Phase 7 decommission migration is written FROM;
 *   5. the soft-delete debris Phase 4 must reconcile BEFORE copying;
 *   6. the columns the export transform has to strip, sized.
 *
 * and writes a JSON manifest that a later run can be diffed against.
 *
 * ## The rule this script is built around
 *
 * **A reading that failed is never rendered as zero.** Every number here is
 * either a value that was actually read, or `null` carrying the reason it
 * could not be. This is not defensive decoration — it is the whole point. A
 * manifest is consulted immediately before Phase 4 copies data and Phase 7
 * deletes it, both irreversible; a table whose count silently failed and
 * printed `0` reads exactly like a table that is genuinely empty, and the
 * difference between those two is somebody's production data. The platform
 * has shipped that defect before under three different names — `aml.cases`
 * answering 42703 into a discarded error, a failed Places lookup persisted as
 * `count: 0`, an unresolved rent printing `0.00%` — and the rule that came out
 * of each is the same one: absent is never zero.
 *
 * Its corollary is that this script may not name a column it has not
 * confirmed exists. Eighteen call sites across five edge functions once
 * selected `aml.cases.tenant_id`, a column that table has never had, and
 * twelve handlers then reported "Case not found" about a case the operator had
 * open. So every measurement declares the (table, column) pairs it needs,
 * `measure()` checks them against `information_schema` first, and a missing
 * one yields `column_absent` — a loud, specific null — rather than a crash or
 * a zero. That is also what lets this script keep running across the phases:
 * the schema is deliberately changing underneath it.
 *
 * ## Two further properties worth knowing
 *
 * **The session is read-only by construction**, not by discipline:
 * `default_transaction_read_only=on` is set through PGOPTIONS, so the script
 * cannot write to the database it is pointed at whatever SQL it issues. It is
 * run against production by hand, minutes before destructive work.
 *
 * **Nothing is enumerated from a filename.** Tables, buckets, boundary edges
 * and entanglements are all discovered from the catalogue, because the
 * boundary does not follow the file names in either direction: 23
 * non-builder-named migrations touch builder objects, and one builder-named
 * migration (`20260717000000_add_builder_invoice_current_payment`) is a
 * Command Centre finance feature whose tables stay in the clone. An edge this
 * script finds and cannot classify is reported as UNCLASSIFIED and raises a
 * warning — a new entanglement means the extraction plan is stale, and that
 * must be loud rather than absorbed.
 *
 * Usage:
 *   node scripts/builder-portal/extraction-manifest.mjs [options]
 *
 *   --db-url <url>     Postgres connection string. Falls back to
 *                      BUILDER_MANIFEST_DB_URL, SUPABASE_DB_URL, DATABASE_URL.
 *                      For the local harness: --local (uses reset.mjs's cluster).
 *   --local            shorthand for the local-db harness cluster
 *   --phase <label>    the phase this manifest precedes, e.g. `4`
 *   --out <path>       manifest destination (default:
 *                      docs/builder-portal/manifests/<utc>-phase-<label>.json)
 *   --compare <path>   diff against an earlier manifest; `latest` picks the
 *                      newest already in the manifest directory
 *   --fail-on-drift    exit non-zero when the boundary or the table set has
 *                      moved since --compare (for CI or a pre-phase gate).
 *                      Row counts MOVING is not drift — the corpus growing is
 *                      the thing being measured, and failing on it would make
 *                      the gate fire on every healthy run. Drift is the SHAPE
 *                      moving: a table or view appearing or going, a boundary
 *                      edge appearing or going, or a migration landing between
 *                      the two manifests (caught by the schema fingerprint).
 *                      Those are what make the extraction plan stale.
 *   --no-storage       skip the storage section
 *   --no-write         report only, write nothing
 *   --json             print the manifest JSON instead of the report
 *
 * Exit codes: 0 measured cleanly · 1 a measurement failed, an edge is
 * unclassified, or --fail-on-drift saw drift · 2 could not connect.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const MANIFEST_DIR = join(root, 'docs/builder-portal/manifests');
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1] : fallback;
};

const phaseLabel = option('phase', 'unlabelled');
const wantStorage = !flag('no-storage');
const wantWrite = !flag('no-write');
const asJson = flag('json');
const failOnDrift = flag('fail-on-drift');
const compareArg = option('compare');

// The local harness cluster, so the script can be exercised without pointing
// it at production. reset.mjs / network-standalone-check.mjs own these values.
const LOCAL_URL = `postgresql://${process.env.LOCAL_PG_USER || 'postgres'}@localhost/`
  + `${process.env.LOCAL_PG_DB || 'aurixa_local'}`;

const dbUrl = flag('local')
  ? null // handled as host/port/socket below
  : option('db-url')
    || process.env.BUILDER_MANIFEST_DB_URL
    || process.env.SUPABASE_DB_URL
    || process.env.DATABASE_URL
    || null;

if (!flag('local') && !dbUrl) {
  console.error(
    'No database connection. Pass --db-url <postgres url>, set one of\n'
    + '  BUILDER_MANIFEST_DB_URL / SUPABASE_DB_URL / DATABASE_URL,\n'
    + '  or pass --local to measure the local-db harness cluster.\n\n'
    + 'This manifest reads pg_constraint and storage.objects, so it needs a\n'
    + 'Postgres connection — a service-role key over PostgREST cannot reach\n'
    + 'either, and a manifest missing the boundary is a manifest Phase 7\n'
    + 'cannot be written from.',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Transport
//
// psql rather than a driver, because `pg` is not a dependency of this repo and
// every other script in scripts/builder-portal/ already shells out this way.
// Each query returns ONE json document, which removes delimiter handling
// entirely — bucket ids, constraint names and error text can all contain
// whatever they like.
// ---------------------------------------------------------------------------
const localArgs = ['-h', process.env.LOCAL_PG_HOST || '/tmp',
  '-p', process.env.LOCAL_PG_PORT || '55432',
  '-U', process.env.LOCAL_PG_USER || 'postgres',
  '-d', process.env.LOCAL_PG_DB || 'aurixa_local'];

const connArgs = flag('local') ? localArgs : [dbUrl];

const runSql = (sql) => execFileSync('psql', [...connArgs, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
  encoding: 'utf8',
  stdio: 'pipe',
  env: {
    ...process.env,
    // Structurally read-only: the script cannot write, whatever it asks for.
    PGOPTIONS: `${process.env.PGOPTIONS || ''} -c default_transaction_read_only=on`.trim(),
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '15',
  },
});

/** The error line psql actually reported, without the noise around it. */
const pgError = (error) => String(error.stderr || error.message || '')
  .split('\n').map((l) => l.trim())
  .find((l) => l.startsWith('ERROR:') || l.startsWith('psql:') || l.includes('FATAL'))
  ?.replace(/^.*?(ERROR|FATAL):\s*/, '') || 'unknown error';

/**
 * A query returning a json array.
 *
 * The subquery alias is `manifest_row` rather than something short on purpose.
 * `json_agg(t) FROM (...) t` resolves `t` to a COLUMN named `t` when the inner
 * query has one, and aggregates that column instead of the row — silently,
 * with no error, returning a plausible array of the wrong thing. The
 * introspection query below selects `table_name AS t`, so this read as a list
 * of table names and every column lookup missed. Keep the alias unique.
 */
const jsonRows = (inner) => {
  const out = runSql(
    `SELECT coalesce(json_agg(manifest_row), '[]'::json)::text FROM (${inner}) manifest_row`,
  ).trim();
  return JSON.parse(out || '[]');
};

/** A query returning one scalar, as text. */
const scalar = (sql) => runSql(sql).trim();

/**
 * Quote an identifier the way Postgres does. Every identifier this script
 * interpolates comes from the catalogue rather than from a user, but composing
 * SQL by concatenation without quoting is a habit that is only ever one
 * refactor away from being wrong.
 */
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// Readings
//
// Every number in this manifest is one of these two shapes, and the report and
// the diff both refuse to treat the second as a value. `unmeasured` is why a
// failed read can never be mistaken for an empty table.
// ---------------------------------------------------------------------------
const reading = (value, extra = {}) => ({ value, measured: true, ...extra });
const unmeasured = (reason, detail) => ({
  value: null, measured: false, reason, ...(detail ? { detail } : {}),
});
const isMeasured = (r) => Boolean(r && r.measured && r.value !== null);

/**
 * A read the manifest cannot be built without. The boundary is the clearest
 * case: if pg_constraint cannot be read, the honest outcome is no manifest at
 * all. A document that reported an empty boundary because the read failed
 * would be a decommission migration that drops no constraints.
 */
const required = (what, run) => {
  try {
    return run();
  } catch (error) {
    console.error(`Could not read ${what}: ${pgError(error)}`);
    console.error('No manifest written — this is a structural read, and an absent'
      + ' boundary or table list must never be reported as an empty one.');
    process.exit(2);
  }
};

const warnings = [];
const failures = [];
const warn = (message) => { warnings.push(message); };
const fail = (message) => { failures.push(message); };

// ---------------------------------------------------------------------------
// Connect, and confirm this is a database the manifest is about
// ---------------------------------------------------------------------------
let identity;
try {
  identity = jsonRows(`
    SELECT current_database() AS database,
           current_user       AS role,
           version()          AS server,
           inet_server_addr()::text AS server_addr,
           current_setting('transaction_read_only') AS read_only`)[0];
} catch (error) {
  console.error(`Could not connect: ${pgError(error)}`);
  console.error('(The connection string is never printed, by design.)');
  process.exit(2);
}

if (identity.read_only !== 'on') {
  // Belt and braces: if PGOPTIONS did not take, stop rather than run a
  // production sweep from a writable session.
  console.error('Refusing to run: the session is not read-only. PGOPTIONS did not apply.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Catalogue introspection
//
// One pull of every column in the schemas that can hold builder data, so no
// later measurement has to guess whether a column exists. This is the
// `aml.cases.tenant_id` lesson made mechanical.
// ---------------------------------------------------------------------------
const columnRows = required('the column catalogue', () => jsonRows(`
  SELECT table_schema AS schema_name, table_name AS table_name, column_name AS column_name
  FROM information_schema.columns
  WHERE table_schema IN ('public', 'aml', 'storage')`));

const columnSet = new Set(columnRows.map((r) => `${r.schema_name}.${r.table_name}.${r.column_name}`));
const tableSet = new Set(columnRows.map((r) => `${r.schema_name}.${r.table_name}`));
const hasColumn = (qualified) => columnSet.has(qualified);
const hasTable = (qualified) => tableSet.has(qualified);

/**
 * Run a measurement only when every column it names exists. A missing one is
 * reported as exactly that, against exactly that name.
 */
const measure = (requires, run) => {
  const missing = requires.filter((q) => !hasColumn(q));
  if (missing.length > 0) return unmeasured('column_absent', missing.join(', '));
  try {
    return reading(run());
  } catch (error) {
    const detail = pgError(error);
    fail(`measurement failed (${requires[0] || 'query'}): ${detail}`);
    return unmeasured('query_failed', detail);
  }
};

const count = (sql) => {
  const value = scalar(sql);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`non-numeric count: ${value}`);
  return n;
};

// ---------------------------------------------------------------------------
// 1. Tables
//
// Discovered, never listed. Exact counts, never `reltuples` — a planner
// estimate in a document that authorises deletion is the same failure as a
// zero that was never read.
//
// Disposition comes from the extraction plan and is the reason this section is
// more than a row count: it says what MOVES. Two builder-prefixed tables do
// not travel, and reporting them as part of the corpus would put Command
// Centre data on the migration list.
// ---------------------------------------------------------------------------
/**
 * Two different kinds of "does not travel", and collapsing them is a defect.
 *
 * NOT_THE_PORTALS are tables that merely WEAR the prefix and belong to another
 * feature entirely. They are excluded from the corpus AND from the boundary,
 * because their foreign keys are ordinary Command Centre relationships — not
 * crossings of anything. Reported as unclassified boundary edges (which is
 * what happened before this distinction existed) they would put two Finance
 * constraints into a decommission migration.
 *
 * STAYS_IN_CLONE are portal tables the clone deliberately keeps. They are part
 * of the corpus and their edges are real entanglements — builder_stock_selections
 * is E3 — they simply are not copied to the network.
 */
const NOT_THE_PORTALS = {
  builder_invoices:
    'Command Centre finance, not the portal — builder_invoices / build_progress_payments '
    + 'carry commission data and merely wear the prefix (doc 44).',
};

const STAYS_IN_CLONE = {
  builder_stock_selections:
    'The Command Centre selection record; the clone keeps it, re-pointed at the '
    + 'builder_network_stock_items mirror (E3).',
};

const dispositionOf = (name) => (NOT_THE_PORTALS[name] ? 'not_the_portals'
  : STAYS_IN_CLONE[name] ? 'stays_in_clone' : 'travels');
const noteFor = (name) => NOT_THE_PORTALS[name] || STAYS_IN_CLONE[name] || null;

/** SQL fragment excluding the not-the-portal's tables from a boundary side. */
const notThePortalsSql = (alias) => Object.keys(NOT_THE_PORTALS).length === 0 ? 'true'
  : `${alias}.relname NOT IN (${Object.keys(NOT_THE_PORTALS).map((n) => `'${n}'`).join(', ')})`;

let tables = [];
try {
  // query_to_xml keeps this to one round trip while still counting exactly.
  tables = jsonRows(`
    SELECT c.relname AS name,
           (xpath('/row/n/text()',
                  query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname),
                               false, true, ''))
           )[1]::text::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'builder\\_%'
    ORDER BY c.relname
  `).map((r) => ({
    name: r.name,
    rows: reading(Number(r.rows)),
    disposition: dispositionOf(r.name),
    ...(noteFor(r.name) ? { note: noteFor(r.name) } : {}),
  }));
} catch (error) {
  // The batch counts every table in one statement, so one unreadable table
  // takes the whole set down. Fall back to counting individually, which keeps
  // the tables that CAN be read and names the ones that cannot.
  warn(`batch count failed (${pgError(error)}); counting tables individually`);
  const names = jsonRows(`
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'builder\\_%'
    ORDER BY 1`).map((r) => r.name);
  tables = names.map((name) => {
    let rows;
    try {
      rows = reading(count(`SELECT count(*) FROM public.${ident(name)}`));
    } catch (inner) {
      const detail = pgError(inner);
      fail(`could not count public.${name}: ${detail}`);
      rows = unmeasured('query_failed', detail);
    }
    return {
      name,
      rows,
      disposition: dispositionOf(name),
      ...(noteFor(name) ? { note: noteFor(name) } : {}),
    };
  });
}

// Views carry no rows and are recreated by the Phase 2 squash rather than
// copied — but they must be REPORTED, or this section's table count disagrees
// with builder:db:network-check's (which counts information_schema.tables, and
// therefore counts the view too) and nobody can say why. The squash has to
// recreate every one of these.
const views = required('the builder views', () => jsonRows(`
  SELECT c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND c.relname LIKE 'builder\\_%'
  ORDER BY 1`)).map((r) => r.name);

const travellingTables = tables.filter((t) => t.disposition === 'travels');
const totalRows = (set) => (set.every((t) => isMeasured(t.rows))
  ? reading(set.reduce((sum, t) => sum + t.rows.value, 0))
  : unmeasured('incomplete', `${set.filter((t) => !isMeasured(t.rows)).length} table(s) unread`));

// A shape fingerprint, so two manifests can be told apart as "same schema,
// more rows" or "the schema moved under us" without reading either in full.
const shapeRows = required('the builder column shapes', () => jsonRows(`
  SELECT c.table_name AS table_name, c.column_name AS column_name, c.data_type AS data_type
  FROM information_schema.columns c
  WHERE c.table_schema='public' AND c.table_name LIKE 'builder\\_%'
  ORDER BY 1,2`));
const schemaFingerprint = createHash('sha256')
  .update(shapeRows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`).join('\n'))
  .digest('hex');

// ---------------------------------------------------------------------------
// 2. Storage
//
// Buckets are discovered two ways and unioned: what storage.buckets declares,
// and what the builder rows actually NAME in a storage_bucket column. A bucket
// that rows reference but storage.buckets does not hold is a real finding, and
// it is invisible to either half alone.
// ---------------------------------------------------------------------------
let storage = null;
if (wantStorage) {
  const bucketColumnTables = shapeRows
    .filter((r) => r.column_name === 'storage_bucket')
    .map((r) => r.table_name);

  let declared = [];
  let referenced = [];
  try {
    declared = jsonRows(
      `SELECT id FROM storage.buckets WHERE id LIKE 'builder%' ORDER BY 1`,
    ).map((r) => r.id);
  } catch (error) {
    warn(`could not read storage.buckets: ${pgError(error)}`);
  }
  if (bucketColumnTables.length > 0) {
    const union = bucketColumnTables
      .map((t) => `SELECT DISTINCT storage_bucket AS id FROM public.${t} WHERE storage_bucket IS NOT NULL`)
      .join(' UNION ');
    try {
      referenced = jsonRows(`SELECT id FROM (${union}) b ORDER BY 1`).map((r) => r.id);
    } catch (error) {
      warn(`could not read referenced bucket names: ${pgError(error)}`);
    }
  }

  const buckets = [...new Set([...declared, ...referenced])].sort();
  const undeclared = referenced.filter((b) => !declared.includes(b));
  for (const bucket of undeclared) {
    warn(`bucket "${bucket}" is named by builder rows but absent from storage.buckets`);
  }

  const perBucket = buckets.map((bucket) => {
    if (!hasTable('storage.objects')) {
      return { bucket, objects: unmeasured('table_absent', 'storage.objects'), bytes: unmeasured('table_absent') };
    }
    const literal = bucket.replace(/'/g, "''");
    const row = (() => {
      try {
        return jsonRows(`
          SELECT count(*) AS objects,
                 coalesce(sum((o.metadata->>'size')::bigint), 0) AS bytes,
                 count(*) FILTER (WHERE o.metadata->>'size' IS NULL) AS size_unknown,
                 max(o.created_at)::text AS newest_object
          FROM storage.objects o WHERE o.bucket_id = '${literal}'`)[0];
      } catch (error) {
        fail(`storage measurement failed for ${bucket}: ${pgError(error)}`);
        return null;
      }
    })();
    if (!row) {
      return { bucket, objects: unmeasured('query_failed'), bytes: unmeasured('query_failed') };
    }
    // An object whose metadata carries no size contributes nothing to the sum.
    // Saying how many of those there are is the byte-level form of the same
    // rule: the total is a floor, not a fact, whenever this is non-zero.
    if (Number(row.size_unknown) > 0) {
      warn(`${bucket}: ${row.size_unknown} object(s) carry no size in metadata — `
        + 'the byte total for this bucket is a floor');
    }
    return {
      bucket,
      declared: declared.includes(bucket),
      objects: reading(Number(row.objects)),
      bytes: reading(Number(row.bytes)),
      size_unknown: reading(Number(row.size_unknown)),
      newest_object: row.newest_object,
    };
  });

  const allSized = perBucket.every((b) => isMeasured(b.bytes));
  storage = {
    buckets: perBucket,
    total_objects: perBucket.every((b) => isMeasured(b.objects))
      ? reading(perBucket.reduce((s, b) => s + b.objects.value, 0))
      : unmeasured('incomplete'),
    total_bytes: allSized
      ? reading(perBucket.reduce((s, b) => s + b.bytes.value, 0))
      : unmeasured('incomplete'),
    undeclared_buckets: undeclared,
  };
}

// ---------------------------------------------------------------------------
// 3. The boundary — from pg_constraint, in both directions, with delete rules
//
// This section is what the Phase 7 decommission migration is written from.
// The delete rule is the load-bearing part: seven of the nine inbound edges
// measured in production CASCADE, five of them from cross_portal_* tables the
// Solicitor cutover also lives in, so dropping builder_organisations without
// dropping those constraints first takes another portal's state with it.
// ---------------------------------------------------------------------------
const DELETE_RULE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

const edgeQuery = (direction) => `
  SELECT n.nspname   AS from_schema,
         cl.relname  AS from_table,
         a.attname   AS column,
         fn.nspname  AS to_schema,
         fcl.relname AS to_table,
         c.confdeltype::text AS delete_rule,
         c.conname   AS constraint_name
  FROM pg_constraint c
  JOIN pg_class cl      ON cl.oid = c.conrelid
  JOIN pg_namespace n   ON n.oid = cl.relnamespace
  JOIN pg_class fcl     ON fcl.oid = c.confrelid
  JOIN pg_namespace fn  ON fn.oid = fcl.relnamespace
  JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
  JOIN pg_attribute a   ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.contype = 'f'
    -- A table that merely wears the prefix is not one side of this boundary.
    AND ${notThePortalsSql('cl')} AND ${notThePortalsSql('fcl')}
    AND ${direction === 'inbound'
      ? `fcl.relname LIKE 'builder\\_%' AND fn.nspname = 'public'
         AND NOT (cl.relname LIKE 'builder\\_%' AND n.nspname = 'public')`
      : `cl.relname LIKE 'builder\\_%' AND n.nspname = 'public'
         AND NOT (fcl.relname LIKE 'builder\\_%' AND fn.nspname = 'public')`}
  ORDER BY 1, 2, 3`;

const decorate = (rows) => rows.map((r) => ({
  ...r,
  delete_rule: DELETE_RULE[r.delete_rule] || r.delete_rule,
  ref: `${r.from_schema}.${r.from_table}.${r.column}`,
}));

const inbound = decorate(required('the inbound boundary', () => jsonRows(edgeQuery('inbound'))));
const outbound = decorate(required('the outbound boundary', () => jsonRows(edgeQuery('outbound'))));
const cascading = inbound.filter((e) => e.delete_rule === 'CASCADE');

// ---------------------------------------------------------------------------
// 4. The entanglements
//
// Derived from the edges above rather than listed, so an entanglement added
// next week appears here without anyone remembering to add it. Each is sized
// by its LIVE rows — the count of rows where the crossing column is actually
// set — because that, not the constraint's existence, is what Phase 4 and
// Phase 5 have to move.
// ---------------------------------------------------------------------------
const CLASSIFIED = {
  'public.transaction_case_links.builder_transaction_id': {
    code: 'E1',
    what: 'The fourth case-link slot. Stays in the clone, re-pointed at the mirror.',
  },
  'public.builder_transactions.client_id': {
    code: 'E2',
    what: 'Becomes connection_id + a random per-(connection, client) remote_client_ref.',
  },
  'public.builder_stock_selections.client_id': {
    code: 'E3',
    what: 'Stock marketplace. The selection stays in the clone; the item becomes a mirror row.',
  },
  'aml.partner_organisations.builder_organisation_id': {
    code: 'E4',
    what: 'Compliance Passport. Loses its FK, becomes an opaque remote id + a connection id.',
  },
  'public.portal_terms_acceptances.builder_user_id': {
    code: 'E5',
    what: 'Terms. MIG-01 is one-way: delete builder rows, keep the column as dead.',
  },
  'public.document_processing_jobs.builder_document_version_id': {
    code: '—',
    travels: true,
    what: 'The document queue travels with the portal, so this edge becomes internal to the network.',
  },
};
const E6 = /^public\.cross_portal_[a-z_]+\.builder_organisation_id$/;

const entanglements = [...inbound, ...outbound].map((edge) => {
  const known = CLASSIFIED[edge.ref] || (E6.test(edge.ref)
    ? { code: 'E6', what: 'Release-control plane. Branches are deleted, not migrated.' }
    : null);

  if (!known) {
    // A crossing this plan does not name means the boundary grew. That is a
    // finding about the plan, not a number to fold into a total.
    fail(`UNCLASSIFIED boundary edge: ${edge.ref} -> ${edge.to_schema}.${edge.to_table} `
      + `(${edge.delete_rule}). The extraction plan's entanglement list is stale.`);
  }

  const qualified = `${edge.from_schema}.${edge.from_table}.${edge.column}`;
  const live = measure([qualified], () => count(
    `SELECT count(*) FROM ${ident(edge.from_schema)}.${ident(edge.from_table)}`
    + ` WHERE ${ident(edge.column)} IS NOT NULL`,
  ));

  return {
    code: known?.code ?? 'UNCLASSIFIED',
    ref: edge.ref,
    targets: `${edge.to_schema}.${edge.to_table}`,
    delete_rule: edge.delete_rule,
    constraint_name: edge.constraint_name,
    live_rows: live,
    ...(known?.travels ? { travels_with_the_portal: true } : {}),
    ...(known?.what ? { what: known.what } : {}),
  };
}).sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref));

// ---------------------------------------------------------------------------
// 5. Debris — what Phase 4 reconciles BEFORE copying
//
// "Don't import someone else's mess into a fresh database." Each shape is
// measured and named separately rather than summed into one "orphans" number,
// because they are reconciled differently and one of them is not debris at
// all: an image row with no stock_item_id is BY DESIGN — media a document
// carries that cannot be attributed to one property is kept against the
// upload rather than discarded. A single total would quietly propose deleting
// it.
// ---------------------------------------------------------------------------
const U = 'public.builder_stock_uploads';
const I = 'public.builder_stock_items';
const M = 'public.builder_stock_item_images';

const debris = {
  uploads_total: measure([`${U}.id`], () => count(`SELECT count(*) FROM ${U}`)),
  uploads_live: measure([`${U}.deleted_at`], () =>
    count(`SELECT count(*) FROM ${U} WHERE deleted_at IS NULL`)),
  uploads_soft_deleted: measure([`${U}.deleted_at`], () =>
    count(`SELECT count(*) FROM ${U} WHERE deleted_at IS NOT NULL`)),

  items_total: measure([`${I}.id`], () => count(`SELECT count(*) FROM ${I}`)),
  items_archived: measure([`${I}.lifecycle_status`], () =>
    count(`SELECT count(*) FROM ${I} WHERE lifecycle_status = 'archived'`)),
  items_from_a_deleted_upload: measure([`${I}.upload_id`, `${U}.deleted_at`], () => count(`
    SELECT count(*) FROM ${I} i JOIN ${U} u ON u.id = i.upload_id
    WHERE u.deleted_at IS NOT NULL`)),
  items_with_no_image: measure([`${I}.id`, `${M}.stock_item_id`], () => count(`
    SELECT count(*) FROM ${I} i
    WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.stock_item_id = i.id)`)),
  // A dangling primary_image_id is deliberately NOT measured here. It cannot
  // occur: builder_stock_items_primary_image_fk is ON DELETE SET NULL, so
  // removing the image clears the pointer, and builder_enforce_stock_primary_image()
  // refuses an insert or update naming an image that is not this item's. A
  // measurement that is structurally always zero is worse than no measurement,
  // because a column of zeroes reads as assurance that something was checked.

  images_total: measure([`${M}.id`], () => count(`SELECT count(*) FROM ${M}`)),
  images_held_against_an_upload_only: measure([`${M}.stock_item_id`, `${M}.upload_id`], () => count(`
    SELECT count(*) FROM ${M} WHERE stock_item_id IS NULL AND upload_id IS NOT NULL`)),
  images_attached_to_nothing: measure([`${M}.stock_item_id`, `${M}.upload_id`], () => count(`
    SELECT count(*) FROM ${M} WHERE stock_item_id IS NULL AND upload_id IS NULL`)),
  images_from_a_deleted_upload: measure([`${M}.upload_id`, `${U}.deleted_at`], () => count(`
    SELECT count(*) FROM ${M} m JOIN ${U} u ON u.id = m.upload_id
    WHERE u.deleted_at IS NOT NULL`)),
};

// Both directions of the row↔object cross-check. A stored row naming an object
// that is gone is a broken picture; an object no row names is bytes the move
// would carry for nothing. Neither is visible from one side.
if (hasTable('storage.objects') && hasColumn(`${M}.storage_path`) && hasColumn(`${M}.storage_bucket`)) {
  debris.image_rows_with_no_storage_object = measure(
    [`${M}.storage_path`, `${M}.storage_bucket`], () => count(`
      SELECT count(*) FROM ${M} m
      WHERE m.storage_path IS NOT NULL AND m.storage_bucket IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM storage.objects o
                        WHERE o.bucket_id = m.storage_bucket AND o.name = m.storage_path)`),
  );
  // Scoped to the buckets the image rows THEMSELVES name, rather than to a
  // bucket id written here. Naming it would make this measure silently report
  // zero the day the bucket is renamed — and zero is the reading that means
  // "nothing to clean up".
  debris.storage_objects_no_image_row_names = measure(
    [`${M}.storage_path`, `${M}.storage_bucket`], () => count(`
      SELECT count(*) FROM storage.objects o
      WHERE o.bucket_id IN (SELECT DISTINCT storage_bucket FROM ${M}
                            WHERE storage_bucket IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM ${M} m
                        WHERE m.storage_bucket = o.bucket_id AND m.storage_path = o.name)`),
  );
} else {
  debris.image_rows_with_no_storage_object = unmeasured('table_absent', 'storage.objects or the image storage columns');
  debris.storage_objects_no_image_row_names = unmeasured('table_absent', 'storage.objects or the image storage columns');
}

// ---------------------------------------------------------------------------
// 6. The export transform, sized
//
// Columns the plan says must not travel. selected_by_user_id holds an
// auth.users id BY CONVENTION with no foreign key, which is exactly why no
// constraint-based sweep finds it and why it is named explicitly here.
// ---------------------------------------------------------------------------
const S = 'public.builder_stock_selections';
const stripped = {
  'builder_stock_selections.selected_by_user_id': {
    why: 'A Command Centre auth.users id, carried by convention with no FK. Stripped at export.',
    rows: measure([`${S}.selected_by_user_id`], () =>
      count(`SELECT count(*) FROM ${S} WHERE selected_by_user_id IS NOT NULL`)),
  },
  'builder_stock_selections.internal_notes': {
    why: 'Command Centre only; never returned to the portal and never sent to the network.',
    rows: measure([`${S}.internal_notes`], () =>
      count(`SELECT count(*) FROM ${S} WHERE internal_notes IS NOT NULL`)),
  },
  'builder_stock_selections.client_id': {
    why: 'Client PII boundary (E3). Stays in the clone; the network sees a label at most.',
    rows: measure([`${S}.client_id`], () =>
      count(`SELECT count(*) FROM ${S} WHERE client_id IS NOT NULL`)),
  },
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
const git = (args, fallback = null) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { return fallback; }
};

const projectRef = (() => {
  if (flag('local')) return 'local-harness';
  const match = /(?:@|\/\/)(?:db\.)?([a-z0-9]{20})\./.exec(dbUrl || '');
  return match ? match[1] : null;
})();

const manifest = {
  manifest_schema_version: SCHEMA_VERSION,
  provenance: {
    measured_at: new Date().toISOString(),
    phase_this_precedes: phaseLabel,
    database: identity.database,
    supabase_project_ref: projectRef,
    server: (identity.server || '').split(' on ')[0],
    role: identity.role,
    session_read_only: true,
    repo_head: git(['rev-parse', 'HEAD']),
    repo_branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    repo_dirty: git(['status', '--porcelain']) !== '',
    schema_fingerprint: schemaFingerprint,
  },
  summary: {
    builder_tables: tables.length,
    builder_views: views.length,
    tables_travelling: travellingTables.length,
    rows_travelling: totalRows(travellingTables),
    rows_all_builder_tables: totalRows(tables),
    storage_objects: storage?.total_objects ?? unmeasured('skipped', '--no-storage'),
    storage_bytes: storage?.total_bytes ?? unmeasured('skipped', '--no-storage'),
    inbound_edges: inbound.length,
    inbound_cascading: cascading.length,
    outbound_edges: outbound.length,
  },
  tables,
  views,
  storage,
  boundary: { inbound, outbound, cascading_inbound: cascading.map((e) => e.ref) },
  entanglements,
  debris,
  export_transform_strips: stripped,
  warnings,
  failures,
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const bytes = (n) => {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
const show = (r, format = (v) => v.toLocaleString('en-AU')) =>
  (isMeasured(r) ? format(r.value) : `— (${r?.reason || 'not measured'})`);
const pad = (s, width) => String(s).padEnd(width);
const padLeft = (s, width) => String(s).padStart(width);

if (asJson) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  const p = manifest.provenance;
  console.log('Builder Portal — extraction manifest');
  console.log(`  measured      ${p.measured_at}`);
  console.log(`  database      ${p.database}${p.supabase_project_ref ? ` (${p.supabase_project_ref})` : ''}`);
  console.log(`  repo          ${String(p.repo_head).slice(0, 9)} on ${p.repo_branch}${p.repo_dirty ? ' (dirty)' : ''}`);
  console.log(`  schema        ${p.schema_fingerprint.slice(0, 16)}…`);
  console.log(`  precedes      phase ${p.phase_this_precedes}`);

  console.log('\nCorpus');
  const staying = tables.filter((t) => t.disposition === 'stays_in_clone').length;
  const foreign = tables.filter((t) => t.disposition === 'not_the_portals').length;
  console.log(`  ${padLeft(manifest.summary.builder_tables, 7)}  builder-prefixed tables`
    + ` (${manifest.summary.tables_travelling} travel`
    + `${staying ? `, ${staying} stay in the clone` : ''}`
    + `${foreign ? `, ${foreign} not the portal's` : ''})`);
  console.log(`  ${padLeft(show(manifest.summary.rows_travelling), 7)}  rows that travel`);
  console.log(`  ${padLeft(show(manifest.summary.rows_all_builder_tables), 7)}  rows in all builder-prefixed tables`);

  const populated = tables.filter((t) => isMeasured(t.rows) && t.rows.value > 0);
  const unread = tables.filter((t) => !isMeasured(t.rows));
  if (populated.length > 0) {
    console.log('\n  Tables holding rows:');
    for (const t of populated.sort((a, b) => b.rows.value - a.rows.value)) {
      console.log(`    ${pad(t.name, 44)} ${padLeft(t.rows.value.toLocaleString('en-AU'), 9)}`
        + `${t.disposition === 'stays_in_clone' ? '   [stays in the clone]'
          : t.disposition === 'not_the_portals' ? "   [not the portal's]" : ''}`);
    }
  }
  console.log(`  ${tables.length - populated.length - unread.length} table(s) measured empty`
    + `${unread.length > 0 ? `, ${unread.length} COULD NOT BE READ` : ''}.`);
  for (const t of unread) console.log(`    ${pad(t.name, 44)} — ${t.rows.reason}`);
  if (views.length > 0) {
    console.log(`\n  ${views.length} view(s) — no rows, recreated by the squash rather than copied:`);
    for (const v of views) console.log(`    ${v}`);
  }

  if (storage) {
    console.log('\nStorage');
    for (const b of storage.buckets) {
      console.log(`    ${pad(b.bucket, 30)} ${padLeft(show(b.objects), 8)} objects  `
        + `${padLeft(show(b.bytes, bytes), 10)}${b.declared === false ? '   [not in storage.buckets]' : ''}`);
    }
    console.log(`    ${pad('total', 30)} ${padLeft(show(storage.total_objects), 8)} objects  `
      + `${padLeft(show(storage.total_bytes, bytes), 10)}`);
  }

  console.log('\nBoundary (from pg_constraint)');
  console.log(`  outbound  ${outbound.length}  (builder → the rest of the clone)`);
  for (const e of outbound) console.log(`    ${pad(e.ref, 52)} → ${e.to_schema}.${e.to_table}  ${e.delete_rule}`);
  console.log(`  inbound   ${inbound.length}`
    + (cascading.length > 0
      ? `  (${cascading.length} CASCADE — drop these constraints before any table)` : ''));
  for (const e of inbound) {
    console.log(`    ${pad(e.ref, 52)} → ${e.to_table}  ${e.delete_rule}`
      + `${e.delete_rule === 'CASCADE' ? '  ⚠' : ''}`);
  }

  console.log('\nEntanglements');
  if (entanglements.length === 0) console.log('  none crossing this database.');
  for (const e of entanglements) {
    console.log(`  ${pad(e.code, 14)} ${pad(e.ref, 52)} ${padLeft(show(e.live_rows), 7)} live`);
  }

  console.log('\nReconcile before copying (Phase 4)');
  for (const [key, value] of Object.entries(debris)) {
    console.log(`  ${pad(key, 46)} ${padLeft(show(value), 9)}`);
  }

  console.log('\nStripped at export');
  for (const [key, value] of Object.entries(stripped)) {
    console.log(`  ${pad(key, 46)} ${padLeft(show(value.rows), 9)}`);
  }
}

// ---------------------------------------------------------------------------
// Compare
//
// A delta is only ever computed between two readings that were both actually
// taken. Comparing a null against a number would manufacture a movement, which
// is the same defect as reporting the null as zero.
// ---------------------------------------------------------------------------
let drifted = false;
if (compareArg) {
  const priorPath = compareArg === 'latest'
    ? (() => {
      if (!existsSync(MANIFEST_DIR)) return null;
      const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json')).sort();
      return files.length ? join(MANIFEST_DIR, files[files.length - 1]) : null;
    })()
    : compareArg;

  if (!priorPath || !existsSync(priorPath)) {
    warn(`--compare: no manifest found at ${priorPath || 'the manifest directory'}`);
  } else {
    const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
    console.log(`\nAgainst ${priorPath.replace(root, '')} (${prior.provenance?.measured_at})`);

    if (prior.provenance?.schema_fingerprint !== schemaFingerprint) {
      console.log('  SCHEMA MOVED — a migration landed between these two manifests.');
      drifted = true;
    }

    const priorTables = new Map((prior.tables || []).map((t) => [t.name, t]));
    const added = tables.filter((t) => !priorTables.has(t.name)).map((t) => t.name);
    const removed = (prior.tables || []).filter((t) => !tables.some((c) => c.name === t.name)).map((t) => t.name);
    const viewsAdded = views.filter((v) => !(prior.views || []).includes(v));
    const viewsRemoved = (prior.views || []).filter((v) => !views.includes(v));
    if (viewsAdded.length) { console.log(`  views added:    ${viewsAdded.join(', ')}`); drifted = true; }
    if (viewsRemoved.length) { console.log(`  views removed:  ${viewsRemoved.join(', ')}`); drifted = true; }
    if (added.length) { console.log(`  tables added:   ${added.join(', ')}`); drifted = true; }
    if (removed.length) { console.log(`  tables removed: ${removed.join(', ')}`); drifted = true; }

    const moved = [];
    for (const t of tables) {
      const before = priorTables.get(t.name);
      if (!before) continue;
      if (!isMeasured(t.rows) || !isMeasured(before.rows)) {
        if (isMeasured(t.rows) !== isMeasured(before.rows)) {
          console.log(`  ${pad(t.name, 44)} not comparable (one side unmeasured)`);
        }
        continue;
      }
      const delta = t.rows.value - before.rows.value;
      if (delta !== 0) moved.push({ name: t.name, delta, now: t.rows.value, was: before.rows.value });
    }
    if (moved.length === 0) {
      console.log('  no row counts moved.');
    } else {
      console.log('  row counts moved:');
      for (const m of moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
        console.log(`    ${pad(m.name, 44)} ${padLeft(m.was.toLocaleString('en-AU'), 9)}`
          + ` → ${padLeft(m.now.toLocaleString('en-AU'), 9)}  ${m.delta > 0 ? '+' : ''}${m.delta.toLocaleString('en-AU')}`);
      }
    }

    const priorEdges = new Set([...(prior.boundary?.inbound || []), ...(prior.boundary?.outbound || [])]
      .map((e) => `${e.ref} -> ${e.to_schema}.${e.to_table} (${e.delete_rule})`));
    const nowEdges = new Set([...inbound, ...outbound]
      .map((e) => `${e.ref} -> ${e.to_schema}.${e.to_table} (${e.delete_rule})`));
    const newEdges = [...nowEdges].filter((e) => !priorEdges.has(e));
    const goneEdges = [...priorEdges].filter((e) => !nowEdges.has(e));
    if (newEdges.length || goneEdges.length) {
      drifted = true;
      console.log('  BOUNDARY MOVED:');
      for (const e of newEdges) console.log(`    + ${e}`);
      for (const e of goneEdges) console.log(`    - ${e}`);
      console.log('    The extraction plan and the decommission migration are both written'
        + ' from this boundary. Update them together.');
    }

    if (storage && prior.storage && isMeasured(storage.total_bytes) && isMeasured(prior.storage.total_bytes)) {
      const delta = storage.total_bytes.value - prior.storage.total_bytes.value;
      console.log(`  storage ${bytes(prior.storage.total_bytes.value)} → ${bytes(storage.total_bytes.value)}`
        + `  (${delta >= 0 ? '+' : '-'}${bytes(Math.abs(delta))})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
if (wantWrite) {
  const stamp = manifest.provenance.measured_at.replace(/[:.]/g, '-');
  const outPath = option('out') || join(MANIFEST_DIR, `${stamp}-phase-${phaseLabel}.json`);
  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!asJson) console.log(`\nManifest written: ${outPath.replace(root, '')}`);
}

if (warnings.length && !asJson) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  warn  ${w}`);
}
if (failures.length) {
  console.error(`\n${failures.length} failure(s) — this manifest is INCOMPLETE and must not be`
    + ' used to authorise a copy or a delete:');
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
if (drifted && failOnDrift) {
  console.error('\nDrift since the compared manifest, and --fail-on-drift was set.');
  process.exit(1);
}
if (!asJson) console.log('\nMeasured cleanly.');
