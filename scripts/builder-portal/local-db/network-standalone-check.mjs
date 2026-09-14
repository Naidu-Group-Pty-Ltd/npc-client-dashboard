#!/usr/bin/env node
/**
 * Prove the Builder Portal schema stands up WITHOUT the prime.
 *
 * The Builder Portal is being extracted to a central multi-vendor platform
 * (one Supabase project serving every workspace, `builders.aurixasystems.com.au`).
 * The claim that makes the extraction tractable is that the builder schema was
 * never tied to the clone by anything structural — this script is that claim,
 * executed rather than asserted.
 *
 * It builds a database containing NOTHING of the prime except:
 *   (a) network-owned replacements for shared services the portal genuinely
 *       uses (terms, the document-processing queue, feature flags,
 *       operational events) — these TRAVEL to the network, and
 *   (b) explicitly-labelled shims for prime objects the builder migrations
 *       name today — every shim is deleted by the Phase 2 squash, so the shim
 *       list in 02-network-standalone.sql IS the squash's edit list,
 * then replays every builder migration, and finally audits the boundary from
 * pg_constraint rather than trusting the file list.
 *
 * ## Why replay is by fixpoint, and why more than one pass now FAILS
 *
 * The corpus was not replayable in version sort order: the stock settlement
 * migrations carry August version strings (20260816140000_…) while the tables
 * they alter were created by 20260915000000_builder_stock_list_marketplace.
 * Production held all of them because they were applied in MERGE order — and
 * Mission Control's applyPrimeMigrations replays in VERSION order and halts a
 * clone's whole replay on the first failure, which stopped every clone's sync
 * at 20260816140000. 20260816130000_builder_stock_uploads_bootstrap hoists
 * the one missing prerequisite, so the corpus now applies clean in strict
 * version order. The fixpoint machinery is kept as a diagnostic, but a run
 * that NEEDS a second pass means a new ordering inversion has been introduced
 * — the exact defect that halted the fleet — so it fails the check and names
 * the deferred files.
 *
 * ## What the boundary audit asserts
 *
 * 1. Outbound: the ONLY foreign keys from a builder_* table to a non-builder
 *    table land on public.clients (builder_transactions.client_id and
 *    builder_stock_selections.client_id — entanglements E2/E3). A third
 *    outbound FK appearing here means the boundary grew and the extraction
 *    plan is stale.
 * 2. Inbound: this corpus creates exactly two FKs INTO the builder schema —
 *    transaction_case_links.builder_transaction_id (the fourth domain slot,
 *    E1, which STAYS IN THE CLONE re-pointed at the mirror) and
 *    document_processing_jobs.builder_document_version_id (added by the
 *    quarantine migration; the queue TRAVELS, so in the network this edge
 *    becomes an ordinary internal FK). The other inbound constraints measured
 *    in production (portal_terms_acceptances, cross_portal_*,
 *    aml.partner_organisations) are added by NON-builder migrations, which is
 *    exactly why they are invisible here and why the decommission migration
 *    must be written from pg_constraint against production, never from this
 *    corpus.
 * 3. No builder table references auth.users — identity columns that carry an
 *    auth.users id by convention (builder_stock_selections.selected_by_user_id)
 *    are the clone's staff and are stripped by the export transform.
 *
 * Usage:
 *   node scripts/builder-portal/local-db/network-standalone-check.mjs [--keep]
 *
 * Environment (same as reset.mjs):
 *   LOCAL_PG_HOST (default /tmp)   LOCAL_PG_PORT (default 55432)
 *   LOCAL_PG_USER (default postgres)   NETWORK_CHECK_DB (default aurixa_builder_network)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.NETWORK_CHECK_DB || 'aurixa_builder_network';
const keep = process.argv.includes('--keep');

/**
 * Builder-portal corpus: filename match, minus the one false positive.
 * 20260717000000_add_builder_invoice_current_payment is a Command Centre
 * finance feature (client_deals.builder_invoice_current_payment_id) that
 * matched the glob; builder_invoices / build_progress_payments are finance
 * tables that merely carry the prefix and they STAY in the clone.
 *
 * The filename filter is good enough for replay because every builder-portal
 * migration does carry "builder" in its name — but the REVERSE is not true of
 * the boundary: 23 non-builder-named migrations touch builder objects
 * (portal_terms_multi_portal, cross_portal_rollout_org_generalisation,
 * partner_portal_agreement_cascade, …), which is why the audit below reads
 * pg_constraint instead of trusting this list.
 */
const EXCLUDED = new Set(['20260717000000_add_builder_invoice_current_payment.sql']);

const psql = (args, options = {}) =>
  execFileSync('psql', ['-h', HOST, '-p', PORT, '-U', USER, '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8', stdio: options.stdio || 'pipe', env: { ...process.env, PGPASSWORD: '' },
  });

const query = (sql) => psql(['-d', DB, '-At', '-c', sql]).trim();

// --- 1. Fresh database + bootstrap + network fixture ------------------------
console.log(`Building ${DB} on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-f', join(root, 'scripts/builder-portal/local-db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-f', join(root, 'scripts/builder-portal/local-db/02-network-standalone.sql')]);
console.log('Bootstrap + network fixture applied.');

// --- 2. Fixpoint replay ------------------------------------------------------
const migrationsDir = join(root, 'supabase/migrations');
let pendingFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql') && /builder/i.test(name) && !EXCLUDED.has(name))
  .sort();
const corpusSize = pendingFiles.length;
const passLog = [];
let pass = 0;

while (pendingFiles.length > 0) {
  pass += 1;
  const failed = [];
  const applied = [];
  for (const name of pendingFiles) {
    try {
      psql(['-d', DB, '-q', '-f', join(migrationsDir, name)]);
      applied.push(name);
    } catch (error) {
      const message = String(error.stderr || error.message || '')
        .split('\n').find((line) => line.includes('ERROR')) || 'unknown error';
      failed.push({ name, message: message.replace(/^.*ERROR:\s*/, '') });
    }
  }
  passLog.push({ pass, applied, failed: failed.map((f) => f.name) });
  console.log(`pass ${pass}: applied ${applied.length}, deferred ${failed.length}`);
  if (applied.length === 0) {
    // No progress — what is left genuinely cannot apply against this fixture.
    console.error(`\nUNRESOLVED after pass ${pass}:`);
    for (const f of failed) console.error(`  ${f.name}\n    ${f.message}`);
    console.error(
      '\nEither a builder migration grew a new prime dependency (the boundary moved —' +
      ' update 02-network-standalone.sql and the extraction plan together), or the' +
      ' corpus gained an ordering inversion no pass can settle.',
    );
    process.exit(1);
  }
  pendingFiles = failed.map((f) => f.name);
}
console.log(`\nAll ${corpusSize} builder migrations applied in ${pass} pass(es).`);
const orderingFailures = [];
if (pass > 1) {
  const deferredEver = passLog.filter((p) => p.pass > 1).flatMap((p) => p.applied);
  console.log(`Deferred by version-order inversion (${deferredEver.length}):`);
  for (const name of deferredEver) console.log(`  ${name}`);
  orderingFailures.push(
    `corpus needed ${pass} passes — a version-order inversion is back. ` +
    `applyPrimeMigrations replays in version order and halts a clone's whole ` +
    `replay at the first deferred file; hoist the missing prerequisite ` +
    `(see 20260816130000_builder_stock_uploads_bootstrap.sql).`,
  );
}

// --- 3. Boundary audit (pg_constraint, never the file list) ------------------
const tableCount = query(
  `SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name LIKE 'builder\\_%'`,
);
console.log(`\nbuilder_* tables created: ${tableCount}`);

const outbound = query(
  `SELECT c.conrelid::regclass || '.' || a.attname || ' -> ' || c.confrelid::regclass
   FROM pg_constraint c
   JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.conrelid::regclass::text LIKE 'builder\\_%'
     AND c.confrelid::regclass::text NOT LIKE 'builder\\_%'
   ORDER BY 1`,
).split('\n').filter(Boolean);

const inbound = query(
  `SELECT c.conrelid::regclass || '.' || a.attname || ' -> ' || c.confrelid::regclass
   FROM pg_constraint c
   JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.conrelid::regclass::text NOT LIKE 'builder\\_%'
     AND c.confrelid::regclass::text LIKE 'builder\\_%'
   ORDER BY 1`,
).split('\n').filter(Boolean);

console.log('\nOutbound FKs (builder -> shim):');
for (const edge of outbound) console.log(`  ${edge}`);
console.log('Inbound FKs (shim -> builder):');
for (const edge of inbound) console.log(`  ${edge}`);

const failures = [...orderingFailures];

// Rule 1 — outbound lands on clients and nowhere else.
const outboundTargets = new Set(outbound.map((e) => e.split(' -> ')[1]));
for (const target of outboundTargets) {
  if (target !== 'clients') {
    failures.push(`outbound FK to ${target}: the boundary grew past E2/E3 (clients)`);
  }
}

// Rule 2 — the corpus creates exactly two inbound edges: the fourth case-link
// slot (stays in the clone, re-pointed at the mirror) and the document queue's
// builder column (travels; internal to the network after Phase 2).
const INBOUND_ALLOWED = [
  'transaction_case_links.builder_transaction_id',
  'document_processing_jobs.builder_document_version_id',
];
for (const edge of inbound) {
  if (!INBOUND_ALLOWED.some((allowed) => edge.startsWith(allowed))) {
    failures.push(`unexpected inbound FK from this corpus: ${edge}`);
  }
}

// Rule 3 — nothing in the builder schema references auth.users structurally.
const authRefs = query(
  `SELECT count(*) FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid::regclass::text LIKE 'builder\\_%'
     AND c.confrelid::regclass::text = 'auth.users'`,
);
if (authRefs !== '0') failures.push(`builder table carries an FK to auth.users (${authRefs})`);

if (!keep) psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

if (failures.length > 0) {
  console.error('\nBOUNDARY AUDIT FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nBoundary audit passed: the schema is standalone-ready.');
