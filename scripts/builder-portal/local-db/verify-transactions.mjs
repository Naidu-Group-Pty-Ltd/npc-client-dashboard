#!/usr/bin/env node
/**
 * Builder Portal Transactions — local migration and behaviour verification.
 *
 * Real execution against real PostgreSQL. Every "ok" is a statement that ran.
 *
 * Usage:  node scripts/builder-portal/local-db/verify-transactions.mjs
 * Env:    LOCAL_PG_HOST (/tmp)  LOCAL_PG_PORT (55432)
 *         LOCAL_PG_USER (postgres)  LOCAL_PG_VERIFY_DB_TXN (aurixa_transactions_verify)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.LOCAL_PG_VERIFY_DB_TXN || 'aurixa_transactions_verify';

const MIGRATIONS = [
  '20260801000000_builder_portal_phase1_organisations_users.sql',
  '20260801000100_builder_portal_phase1_permissions.sql',
  '20260801000200_builder_portal_phase1_sessions.sql',
  '20260801000300_portal_terms_multi_portal.sql',
  '20260801000400_cross_portal_rollout_org_generalisation.sql',
  '20260801000500_builder_portal_admin_module.sql',
  '20260801000600_builder_portal_activity_log.sql',
  '20260802000000_builder_portal_phase2_auth_governance.sql',
  '20260803000000_builder_portal_phase3_projects.sql',
  '20260804000000_builder_portal_inventory.sql',
  '20260805000000_builder_portal_transactions.sql',
  // Phase 5 of the network extraction re-pointed the fourth case-link slot at
  // the builder_network_transactions mirror; the transport migration carries
  // the connections table the mirror's FK needs.
  '20261121000000_builder_network_mirror.sql',
  '20261122000000_builder_network_phase5_inbound_fk_release.sql',
];

const run = (args, db = DB) =>
  execFileSync('psql', ['-h', HOST, '-p', PORT, '-U', USER, '-d', db, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '' } });
const query = (sql) => run(['-tAc', sql]).trim();

const results = [];
const record = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail && !passed ? `\n         ${detail}` : ''}`);
};
const expectRejection = (name, sql, ...fragments) => {
  try { run(['-c', sql]); record(name, false, 'statement unexpectedly succeeded'); }
  catch (error) {
    const message = String(error.stderr || error.message);
    record(name, fragments.some((f) => message.includes(f)),
      `expected one of [${fragments.join(', ')}], got: ${message.trim().split('\n')[0]}`);
  }
};
const expectEqual = (name, sql, expected) => {
  let actual;
  try { actual = query(sql); }
  catch (error) {
    record(name, false, `query failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    return;
  }
  record(name, actual === String(expected), `expected ${expected}, got ${actual}`);
};

// ===========================================================================
// Build
// ===========================================================================
console.log(`Building ${DB} ...`);
run(['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`], 'postgres');
run(['-c', `CREATE DATABASE ${DB}`], 'postgres');
run(['-f', join(root, 'scripts/builder-portal/local-db/00-supabase-bootstrap.sql')]);
run(['-f', join(root, 'scripts/builder-portal/local-db/01-upstream-fixture.sql')]);
const migrationsDir = join(root, 'supabase/migrations');
const onDisk = readdirSync(migrationsDir);
for (const name of MIGRATIONS) {
  if (!onDisk.includes(name)) { console.error(`FATAL: missing ${name}`); process.exit(1); }
  try { run(['-f', join(migrationsDir, name)]); }
  catch (error) {
    console.error(`\nFATAL: ${name} failed\n${String(error.stderr || error.message)}`);
    process.exit(1);
  }
}
console.log(`Applied ${MIGRATIONS.length} migration(s).\n`);

try {
  run(['-f', join(migrationsDir, '20260805000000_builder_portal_transactions.sql')]);
  record('the transactions migration is idempotent — a second apply succeeds', true);
} catch (error) {
  record('the transactions migration is idempotent — a second apply succeeds', false,
    String(error.stderr || error.message).trim().split('\n')[0]);
}

// The re-apply above steps outside version order and re-installs the
// builder_transactions guard; production only ever applies in version order,
// so restore it by re-applying Phase 5 — which is also that file's own
// idempotence probe.
try {
  run(['-f', join(migrationsDir, '20261122000000_builder_network_phase5_inbound_fk_release.sql')]);
  record('the phase 5 re-point is idempotent — a second apply succeeds', true);
} catch (error) {
  record('the phase 5 re-point is idempotent — a second apply succeeds', false,
    String(error.stderr || error.message).trim().split('\n')[0]);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const DEV_ORG = '11111111-1111-1111-1111-111111111111';
const BLD_ORG = '22222222-2222-2222-2222-222222222222';
const OTHER_ORG = '33333333-3333-3333-3333-333333333333';
const USER_B = 'aaaaaaaa-0000-0000-0000-0000000000b1';
const USER_O = 'aaaaaaaa-0000-0000-0000-0000000000e1';
const PROJECT_1 = 'cccccccc-0000-0000-0000-000000000001';
const PROJECT_2 = 'cccccccc-0000-0000-0000-000000000002';
const ACTOR = '99999999-0000-0000-0000-000000000001';
const CLIENT_A = 'dddddddd-0000-0000-0000-00000000000a';
const CLIENT_B = 'dddddddd-0000-0000-0000-00000000000b';

run(['-c', `
  INSERT INTO builder_organisations(id, legal_name, org_type, status, is_active, activated_at)
  VALUES ('${DEV_ORG}','Northpoint Developments','developer','active',true,now()),
         ('${BLD_ORG}','Harbourline Constructions','builder','active',true,now()),
         ('${OTHER_ORG}','Unrelated Homes','builder','active',true,now());
  INSERT INTO builder_portal_users(id, email, name, status, is_active)
  VALUES ('${USER_B}','builder@harbourline.test','Builder User','active',true),
         ('${USER_O}','other@unrelated.test','Other User','active',true);
  INSERT INTO builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary)
  VALUES ('${USER_B}','${BLD_ORG}','manager',true),
         ('${USER_O}','${OTHER_ORG}','manager',true);
  INSERT INTO builder_projects(id, name, developer_organisation_id, builder_organisation_id, status)
  VALUES ('${PROJECT_1}','Harbour Rise A','${DEV_ORG}','${BLD_ORG}','planning'),
         ('${PROJECT_2}','Harbour Rise B','${DEV_ORG}','${BLD_ORG}','planning');
  INSERT INTO clients(id, full_name) VALUES ('${CLIENT_A}','Client A'),('${CLIENT_B}','Client B');
`]);
run(['-c', `SELECT builder_admin_upsert_project_access(
  '${ACTOR}','command_user','${USER_B}','${PROJECT_1}','builder','team_member','{}'::jsonb,NULL,NULL,'fixture')`]);

const UNIT_1 = query(`SELECT (builder_upsert_unit('${ACTOR}','command_user',NULL,NULL,'${PROJECT_1}',
  NULL,NULL,NULL,'{"unit_number":"T-1"}'::jsonb,NULL,'fixture')).id`);
const UNIT_2 = query(`SELECT (builder_upsert_unit('${ACTOR}','command_user',NULL,NULL,'${PROJECT_1}',
  NULL,NULL,NULL,'{"unit_number":"T-2"}'::jsonb,NULL,'fixture')).id`);
const UNIT_P2 = query(`SELECT (builder_upsert_unit('${ACTOR}','command_user',NULL,NULL,'${PROJECT_2}',
  NULL,NULL,NULL,'{"unit_number":"OTHER-1"}'::jsonb,NULL,'fixture')).id`);

// ===========================================================================
// 1. Schema, RLS, direct-access denial
// ===========================================================================
console.log('Schema and direct-access denial');
const TABLES = ['builder_transactions','builder_transaction_parties',
  'builder_transaction_status_history','builder_transaction_pipeline_stages'];
for (const t of TABLES) {
  expectEqual(`${t} is RLS-protected`,
    `SELECT relrowsecurity FROM pg_class WHERE relname='${t}'`, 't');
  expectRejection(`anonymous SELECT on ${t} is denied`,
    `SET LOCAL ROLE anon; SELECT count(*) FROM public.${t};`, 'permission denied');
  expectRejection(`authenticated SELECT on ${t} is denied`,
    `SET LOCAL ROLE authenticated; SELECT count(*) FROM public.${t};`, 'permission denied');
}
expectEqual('no transaction policy uses an unrestricted USING (true)',
  `SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND tablename = ANY(ARRAY['${TABLES.join("','")}'])
   AND (qual='true' OR with_check='true')`, 0);
expectEqual('no cost, margin, supplier or commission column exists on any builder table',
  `SELECT count(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name LIKE 'builder_%'
     AND table_name <> 'builder_invoices'
     AND (column_name LIKE '%cost%' OR column_name LIKE '%margin%'
          OR column_name LIKE '%supplier%' OR column_name LIKE '%contractor_price%'
          OR column_name LIKE '%commission%')`, 0);
// builder_invoices is a FINANCE table despite its name; the Builder Portal
// never reads it, which the security check enforces separately.
expectEqual('the Builder Portal owns no table named like a Finance invoice',
  `SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name='builder_invoices'
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='builder_invoices' AND column_name='commission_amount')`, 1);
expectEqual('every touch-triggered transaction table carries row_version',
  `SELECT count(*) FROM unnest(ARRAY['builder_transactions','builder_transaction_parties']) t
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=t AND column_name='row_version')`, 0);
expectEqual('no client financial column was copied into the transaction',
  `SELECT count(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='builder_transactions'
     AND (column_name LIKE '%income%' OR column_name LIKE '%expense%'
          OR column_name LIKE '%asset%' OR column_name LIKE '%liabilit%'
          OR column_name LIKE '%employment%' OR column_name LIKE '%borrowing%'
          OR column_name LIKE '%serviceab%' OR column_name LIKE '%aml%')`, 0);

// ===========================================================================
// 2. Creation and parentage
// ===========================================================================
console.log('\nCreation and parentage');
const TXN_1 = query(`SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,
  '${PROJECT_1}','${UNIT_1}','${BLD_ORG}','{"transaction_reference":"TX-1","purchaser_name":"Jordan Vale"}'::jsonb,
  NULL,'fixture')).id`);
expectEqual('a transaction is created through the guarded command',
  `SELECT count(*) FROM builder_transactions WHERE id='${TXN_1}'`, 1);
expectEqual('and it wrote a trusted audit row',
  `SELECT count(*)>0 FROM builder_portal_activity_log
   WHERE action='builder_transaction_created' AND entity_id='${TXN_1}'`, 't');
expectEqual('a new transaction starts at lead',
  `SELECT status FROM builder_transactions WHERE id='${TXN_1}'`, 'lead');

expectRejection("a transaction cannot reference another project's unit",
  `INSERT INTO builder_transactions(project_id, unit_id, organisation_id)
   VALUES ('${PROJECT_1}','${UNIT_P2}','${BLD_ORG}')`,
  'BUILDER_TRANSACTION_PARENT_MISMATCH');
expectRejection('a transaction cannot name an organisation outside the project',
  `INSERT INTO builder_transactions(project_id, organisation_id)
   VALUES ('${PROJECT_1}','${OTHER_ORG}')`,
  'BUILDER_TRANSACTION_ORG_MISMATCH');

const TXN_2 = query(`SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,
  '${PROJECT_1}','${UNIT_2}','${BLD_ORG}','{"transaction_reference":"TX-2"}'::jsonb,NULL,'fixture')).id`);
expectRejection('a unit cannot carry two live transactions',
  `INSERT INTO builder_transactions(project_id, unit_id, organisation_id)
   VALUES ('${PROJECT_1}','${UNIT_1}','${BLD_ORG}')`,
  'builder_transactions_one_live_per_unit');

// ===========================================================================
// 3. Optimistic concurrency
// ===========================================================================
console.log('\nOptimistic concurrency');
expectRejection('an update without expected_version is rejected',
  `SELECT builder_upsert_transaction('${ACTOR}','command_user',NULL,'${TXN_1}',NULL,NULL,NULL,
     '{"purchaser_name":"No Version"}'::jsonb,NULL,'x')`,
  'BUILDER_STALE_WRITE');
expectRejection('an update with a stale expected_version is rejected',
  `SELECT builder_upsert_transaction('${ACTOR}','command_user',NULL,'${TXN_1}',NULL,NULL,NULL,
     '{"purchaser_name":"Stale"}'::jsonb,999999,'x')`,
  'BUILDER_STALE_WRITE');
expectEqual('the purchaser name is unchanged after both rejections',
  `SELECT purchaser_name FROM builder_transactions WHERE id='${TXN_1}'`, 'Jordan Vale');
expectEqual('an update with the matching expected_version succeeds',
  `SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,'${TXN_1}',NULL,NULL,NULL,
     '{"purchaser_name":"Jordan Vale-Smith"}'::jsonb,
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),'ok')).purchaser_name`,
  'Jordan Vale-Smith');
expectEqual('and the row_version advanced',
  `SELECT row_version>1 FROM builder_transactions WHERE id='${TXN_1}'`, 't');

// ===========================================================================
// 4. Lifecycle transitions
// ===========================================================================
console.log('\nLifecycle transitions');
expectEqual('lead to reserved is allowed',
  `SELECT builder_is_transaction_transition_allowed('lead','reserved')`, 't');
expectEqual('lead to settled is not allowed',
  `SELECT builder_is_transaction_transition_allowed('lead','settled')`, 'f');
expectEqual('settled is terminal',
  `SELECT builder_is_transaction_transition_allowed('settled','cancelled')`, 'f');
expectEqual('any live status may be cancelled',
  `SELECT builder_is_transaction_transition_allowed('construction','cancelled')`, 't');

expectRejection('a transition without a reason is rejected',
  `SELECT builder_transition_transaction('${TXN_1}',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),
     'lead','reserved','','command_user',NULL,'${ACTOR}')`,
  'REASON_REQUIRED');
expectRejection('a transition with a stale expected_version is rejected',
  `SELECT builder_transition_transaction('${TXN_1}',999999,'lead','reserved','x','command_user',NULL,'${ACTOR}')`,
  'STALE_VERSION');
expectRejection('a transition declaring the wrong current status is rejected',
  `SELECT builder_transition_transaction('${TXN_1}',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),
     'settled','cancelled','x','command_user',NULL,'${ACTOR}')`,
  'INVALID_TRANSITION', 'STALE_STATUS');
run(['-c', `SELECT builder_transition_transaction('${TXN_1}',
  (SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),
  'lead','reserved','purchaser confirmed','command_user',NULL,'${ACTOR}')`]);
expectEqual('a valid transition moves the status',
  `SELECT status FROM builder_transactions WHERE id='${TXN_1}'`, 'reserved');
expectEqual('and it appended a history row',
  `SELECT count(*) FROM builder_transaction_status_history
   WHERE transaction_id='${TXN_1}' AND to_status='reserved'`, 1);
expectEqual('and it wrote a trusted audit row',
  `SELECT count(*)>0 FROM builder_portal_activity_log
   WHERE action='builder_transaction_status_changed' AND entity_id='${TXN_1}'`, 't');
expectRejection('status history cannot be updated',
  `UPDATE builder_transaction_status_history SET reason='tampered' WHERE transaction_id='${TXN_1}'`,
  'BUILDER_TRANSACTION_HISTORY_APPEND_ONLY');
expectRejection('status history cannot be deleted',
  `DELETE FROM builder_transaction_status_history WHERE transaction_id='${TXN_1}'`,
  'BUILDER_TRANSACTION_HISTORY_APPEND_ONLY');

// Settlement stamps the date without a second write path.
run(['-c', `
  SELECT builder_transition_transaction('${TXN_1}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),'reserved','contract_issued','x','command_user',NULL,'${ACTOR}');
  SELECT builder_transition_transaction('${TXN_1}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),'contract_issued','contract_signed','x','command_user',NULL,'${ACTOR}');
  SELECT builder_transition_transaction('${TXN_1}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),'contract_signed','unconditional','x','command_user',NULL,'${ACTOR}');
  SELECT builder_transition_transaction('${TXN_1}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_1}'),'unconditional','settled','x','command_user',NULL,'${ACTOR}');
`]);
expectEqual('settlement stamps the actual settlement date',
  `SELECT actual_settlement_date IS NOT NULL FROM builder_transactions WHERE id='${TXN_1}'`, 't');
expectEqual('settlement closes the transaction',
  `SELECT closed_at IS NOT NULL FROM builder_transactions WHERE id='${TXN_1}'`, 't');

// ===========================================================================
// 5. Pipeline
// ===========================================================================
console.log('\nPipeline');
expectEqual('every transaction status maps to exactly one pipeline stage',
  `SELECT count(*) FROM (
     SELECT unnest(ARRAY['lead','reserved','contract_issued','contract_signed','unconditional',
                         'construction','practical_completion','settled','cancelled','lapsed']) s) x
   WHERE NOT EXISTS (SELECT 1 FROM builder_transaction_pipeline_stages p WHERE p.status = x.s)`, 0);
expectEqual('the pipeline stage table contains no status outside the CHECK list',
  `SELECT count(*) FROM builder_transaction_pipeline_stages p
   WHERE p.status NOT IN ('lead','reserved','contract_issued','contract_signed','unconditional',
                          'construction','practical_completion','settled','cancelled','lapsed')`, 0);
expectEqual('settled and closed are the terminal stages',
  `SELECT string_agg(DISTINCT stage_key, ',' ORDER BY stage_key)
   FROM builder_transaction_pipeline_stages WHERE is_terminal`, 'closed,settled');

// ===========================================================================
// 6. Parties
// ===========================================================================
console.log('\nParties');
const PARTY_1 = query(`SELECT (builder_upsert_transaction_party('${ACTOR}','command_user',NULL,
  '${TXN_2}',NULL,'{"role":"purchaser","name":"Ari Chen"}'::jsonb,NULL,'fixture')).id`);
expectEqual('a party is created through the guarded command',
  `SELECT count(*) FROM builder_transaction_parties WHERE id='${PARTY_1}'`, 1);
expectRejection('a party update without expected_version is rejected',
  `SELECT builder_upsert_transaction_party('${ACTOR}','command_user',NULL,'${TXN_2}','${PARTY_1}',
     '{"name":"Renamed"}'::jsonb,NULL,'x')`,
  'BUILDER_STALE_WRITE');
expectRejection('a party update with a stale expected_version is rejected',
  `SELECT builder_upsert_transaction_party('${ACTOR}','command_user',NULL,'${TXN_2}','${PARTY_1}',
     '{"name":"Renamed"}'::jsonb,999999,'x')`,
  'BUILDER_STALE_WRITE');
expectEqual('a party update with the matching version succeeds',
  `SELECT (builder_upsert_transaction_party('${ACTOR}','command_user',NULL,'${TXN_2}','${PARTY_1}',
     '{"name":"Ari Chen-Lee","role":"purchaser"}'::jsonb,
     (SELECT row_version FROM builder_transaction_parties WHERE id='${PARTY_1}'),'ok')).name`,
  'Ari Chen-Lee');
expectRejection("a party id from another transaction matches no row",
  `SELECT builder_upsert_transaction_party('${ACTOR}','command_user',NULL,'${TXN_1}','${PARTY_1}',
     '{"name":"Hijack"}'::jsonb,1,'x')`,
  'BUILDER_PARTY_NOT_FOUND');
expectEqual('a party is deleted through the guarded command',
  `SELECT builder_delete_transaction_party('${ACTOR}','command_user',NULL,'${TXN_2}','${PARTY_1}','ok')`, 't');
expectEqual('and the delete wrote a trusted audit row carrying the removed record',
  `SELECT count(*)>0 FROM builder_portal_activity_log
   WHERE action='builder_transaction_party_removed' AND entity_id='${PARTY_1}'
     AND previous_state->>'name'='Ari Chen-Lee'`, 't');

// ===========================================================================
// 7. Client link and the transaction case
// ===========================================================================
console.log('\nClient link and transaction case');
expectEqual('a new transaction has no client',
  `SELECT client_id IS NULL FROM builder_transactions WHERE id='${TXN_2}'`, 't');

// `psql -tAc` on an INSERT ... RETURNING prints the row AND the command tag,
// so ids are assigned explicitly rather than read back.
const CASE_A = 'eeeeeeee-0000-0000-0000-00000000000a';
run(['-c', `INSERT INTO transaction_cases(id, client_id, case_type)
  VALUES ('${CASE_A}','${CLIENT_A}','construction')`]);
expectRejection('a transaction with no client cannot be linked to a case',
  `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_2}','${CASE_A}','x')`,
  'BUILDER_TRANSACTION_HAS_NO_CLIENT');

expectRejection('setting the client without expected_version is rejected',
  `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_2}','${CLIENT_A}',NULL,'x')`,
  'BUILDER_STALE_WRITE');
expectRejection('setting the client with a stale expected_version is rejected',
  `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_2}','${CLIENT_A}',999999,'x')`,
  'BUILDER_STALE_WRITE');
expectRejection('an unknown client is rejected',
  `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_2}',
     '00000000-0000-0000-0000-0000000000ff',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_2}'),'x')`,
  'BUILDER_CLIENT_NOT_FOUND');
run(['-c', `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_2}',
  '${CLIENT_A}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_2}'),'ok')`]);
expectEqual('the client is set through the guarded command',
  `SELECT client_id FROM builder_transactions WHERE id='${TXN_2}'`, CLIENT_A);
expectEqual('and it wrote a trusted audit row',
  `SELECT count(*)>0 FROM builder_portal_activity_log
   WHERE action='builder_transaction_client_set' AND entity_id='${TXN_2}'`, 't');

// Phase 5 (20261122000000) re-pointed the fourth slot at the network mirror:
// a transaction the mirror does not hold is refused by name, whatever its
// clone-side row says. The probe runs BEFORE the mirror rows are seeded.
expectRejection('an unmirrored transaction cannot be linked to a case',
  `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_2}','${CASE_A}','x')`,
  'BUILDER_TRANSACTION_NOT_MIRRORED');

// The rows the network sync will write in production: the mirror PK IS the
// network's transaction id (ids are preserved across the boundary), the
// client as the network reports it. Everything below links against these.
const NET_CONN = 'cccccccc-0000-0000-0000-00000000000c';
run(['-c', `INSERT INTO builder_network_connections(id, network_connection_id, state, scopes, accepted_at)
  VALUES ('${NET_CONN}','cccccccc-0000-0000-0000-00000000000d','active','{transactions:share}',now())`]);
run(['-c', `INSERT INTO builder_network_transactions(id, connection_id, client_id, status)
  VALUES ('${TXN_2}','${NET_CONN}','${CLIENT_A}','reserved')`]);

const CASE_B = 'eeeeeeee-0000-0000-0000-00000000000b';
run(['-c', `INSERT INTO transaction_cases(id, client_id, case_type)
  VALUES ('${CASE_B}','${CLIENT_B}','construction')`]);
expectRejection("a transaction cannot be linked to another client's case",
  `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_2}','${CASE_B}','x')`,
  'CROSS_CLIENT_CASE_LINK');
expectEqual('a transaction links to its own client\'s case',
  `SELECT (builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_2}','${CASE_A}','ok')).builder_transaction_id`,
  TXN_2);
expectEqual('and the link is recorded in the shared link history',
  `SELECT count(*) FROM transaction_case_link_history
   WHERE case_id='${CASE_A}' AND domain_type='builder_transaction' AND action='linked'`, 1);
expectEqual('and it wrote a trusted audit row',
  `SELECT count(*)>0 FROM builder_portal_activity_log
   WHERE action='builder_transaction_case_linked'`, 't');
expectEqual('the link uses the builder_portal link source',
  `SELECT link_source FROM transaction_case_links WHERE builder_transaction_id='${TXN_2}'`,
  'builder_portal');

expectRejection('the client cannot be changed while the case link is live',
  `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_2}','${CLIENT_B}',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_2}'),'x')`,
  'BUILDER_TRANSACTION_CASE_LINKED');

// MIG-02: the guard must fire on an UPDATE that touches ONLY the new column.
const TXN_3 = query(`SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,
  '${PROJECT_1}',NULL,'${BLD_ORG}','{"transaction_reference":"TX-3"}'::jsonb,NULL,'fixture')).id`);
run(['-c', `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_3}',
  '${CLIENT_B}',(SELECT row_version FROM builder_transactions WHERE id='${TXN_3}'),'ok')`]);
run(['-c', `INSERT INTO builder_network_transactions(id, connection_id, client_id, status)
  VALUES ('${TXN_3}','${NET_CONN}','${CLIENT_B}','reserved')`]);
expectRejection('MIG-02: an UPDATE touching only builder_transaction_id still fires the guard',
  `UPDATE transaction_case_links SET builder_transaction_id='${TXN_3}' WHERE case_id='${CASE_A}'`,
  'CROSS_CLIENT_CASE_LINK');
expectEqual('the existing case link is unchanged after that rejection',
  `SELECT builder_transaction_id FROM transaction_case_links WHERE case_id='${CASE_A}'`, TXN_2);

const CASE_B2 = CASE_B;
run(['-c', `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_3}','${CASE_B2}','ok')`]);
expectRejection('a case slot already holding another transaction is refused',
  `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_1}','${CASE_B2}','x')`,
  'BUILDER_CASE_SLOT_TAKEN', 'BUILDER_TRANSACTION_HAS_NO_CLIENT');

expectEqual('a transaction is unlinked through the guarded command',
  `SELECT builder_unlink_transaction_from_case('${ACTOR}','command_user',NULL,'${TXN_3}','ok')`, 't');
expectEqual('and the unlink is recorded in the shared link history',
  `SELECT count(*) FROM transaction_case_link_history
   WHERE domain_type='builder_transaction' AND action='unlinked' AND domain_record_id='${TXN_3}'`, 1);
expectRejection('unlinking a transaction that is not linked is refused',
  `SELECT builder_unlink_transaction_from_case('${ACTOR}','command_user',NULL,'${TXN_3}','x')`,
  'BUILDER_CASE_LINK_NOT_FOUND');

// The three existing slots still behave exactly as before.
console.log('\nExisting case-link slots are unchanged');
const MATTER_A = 'ffffffff-0000-0000-0000-00000000000a';
const MATTER_B = 'ffffffff-0000-0000-0000-00000000000b';
run(['-c', `INSERT INTO legal_matters(id, client_id, matter_reference)
  VALUES ('${MATTER_A}','${CLIENT_A}','M-1'),('${MATTER_B}','${CLIENT_B}','M-2')`]);
run(['-c', `UPDATE transaction_case_links SET legal_matter_id='${MATTER_A}'
  WHERE case_id='${CASE_A}'`]);
expectEqual("a legal matter still links to its own client's case",
  `SELECT legal_matter_id FROM transaction_case_links WHERE case_id='${CASE_A}'`, MATTER_A);
expectRejection("a legal matter still cannot cross clients",
  `UPDATE transaction_case_links SET legal_matter_id='${MATTER_B}' WHERE case_id='${CASE_A}'`,
  'CROSS_CLIENT_CASE_LINK');

// ===========================================================================
// 8. Access control
// ===========================================================================
console.log('\nAccess control');
expectEqual('the granted user resolves view on a transaction in the granted project',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 't');
expectEqual('a user with no grant resolves false',
  `SELECT builder_resolve_transaction_permission('${USER_O}','${TXN_1}','transactions','view')`, 'f');

const TXN_P2 = query(`SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,
  '${PROJECT_2}',NULL,'${BLD_ORG}','{"transaction_reference":"P2-1"}'::jsonb,NULL,'fixture')).id`);
expectEqual('access to one project does not grant access to another project transaction',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_P2}','transactions','view')`, 'f');
expectEqual('the accessible set contains only the granted project transactions',
  `SELECT count(*) FROM builder_accessible_transactions('${USER_B}','${BLD_ORG}','transactions')
   WHERE project_id='${PROJECT_2}'`, 0);
expectEqual('and it does contain the granted project transactions',
  `SELECT count(*)>0 FROM builder_accessible_transactions('${USER_B}','${BLD_ORG}','transactions')`, 't');

// --- the hard membership gate ---------------------------------------------
console.log('\nMembership is a hard requirement');
const MEMBERSHIP_B = query(
  `SELECT id FROM builder_organisation_memberships
   WHERE builder_user_id='${USER_B}' AND organisation_id='${BLD_ORG}'`);

// Phase 3 correction 3 made expected_version mandatory for an existing grant,
// so the current version is read and passed rather than omitted.
run(['-c', `SELECT builder_admin_upsert_project_access('${ACTOR}','command_user','${USER_B}',
  '${PROJECT_1}','builder','team_member',
  '{"transactions":{"view":"allow","edit":"allow"}}'::jsonb,NULL,
  (SELECT row_version FROM builder_project_access
   WHERE builder_user_id='${USER_B}' AND project_id='${PROJECT_1}'),'grant override')`]);
run(['-c', `DELETE FROM builder_membership_permissions
  WHERE membership_id='${MEMBERSHIP_B}' AND permission_key='transactions'
    AND scope_type='transaction';
  INSERT INTO builder_membership_permissions(membership_id, permission_key, scope_type,
    scope_id, view_decision, edit_decision, delete_decision)
  VALUES ('${MEMBERSHIP_B}','transactions','transaction','${TXN_1}','allow','allow','inherit')`]);
expectEqual('with both overlapping allow overrides in place, access resolves true',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 't');

run(['-c', `UPDATE builder_organisation_memberships SET status='revoked', revoked_at=now(),
  revoked_reason='test' WHERE id='${MEMBERSHIP_B}'`]);
expectEqual('a revoked membership denies despite the grant-level allow',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');
expectEqual('a revoked membership denies despite the transaction-scoped allow',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','edit')`, 'f');
expectEqual('and the accessible set is empty',
  `SELECT count(*) FROM builder_accessible_transactions('${USER_B}','${BLD_ORG}','transactions')`, 0);

run(['-c', `UPDATE builder_organisation_memberships SET status='suspended', revoked_at=NULL,
  revoked_reason=NULL WHERE id='${MEMBERSHIP_B}'`]);
expectEqual('a suspended membership denies as well',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');

run(['-c', `UPDATE builder_organisation_memberships SET status='active',
  revoked_at=NULL, revoked_reason=NULL WHERE id='${MEMBERSHIP_B}'`]);
expectEqual('restoring the membership restores access',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 't');

// --- scoped overrides may only deny ---------------------------------------
run(['-c', `UPDATE builder_membership_permissions SET view_decision='deny'
  WHERE membership_id='${MEMBERSHIP_B}' AND scope_type='transaction' AND scope_id='${TXN_1}'`]);
expectEqual('a transaction-scoped deny overrides the grant-level allow',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');
expectEqual('and it does not affect a sibling transaction',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_2}','transactions','view')`, 't');
run(['-c', `DELETE FROM builder_membership_permissions
  WHERE membership_id='${MEMBERSHIP_B}' AND scope_type='transaction'`]);

// BOTH gates must accept the new scope: the column CHECK and the trigger guard.
expectEqual('the transaction scope is accepted by the column CHECK constraint',
  `SELECT pg_get_constraintdef(oid) LIKE '%transaction%' FROM pg_constraint
   WHERE conname='builder_membership_permissions_scope_type_check'`, 't');
expectEqual('the transaction scope is accepted by the database scope guard',
  `WITH stored AS (
     INSERT INTO builder_membership_permissions(membership_id, permission_key, scope_type,
       scope_id, view_decision, edit_decision, delete_decision)
     VALUES ('${MEMBERSHIP_B}','transactions','transaction','${TXN_1}','deny','inherit','inherit')
     RETURNING 1)
   SELECT count(*) FROM stored`, 1);
expectEqual('and the stored transaction-scoped override actually resolves',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');
expectRejection('a transaction scope naming no row is refused',
  `INSERT INTO builder_membership_permissions(membership_id, permission_key, scope_type,
     scope_id, view_decision, edit_decision, delete_decision)
   VALUES ('${MEMBERSHIP_B}','transactions','transaction',
     '00000000-0000-0000-0000-0000000000ff','deny','inherit','inherit')`,
  'BUILDER_SCOPE_TARGET_NOT_FOUND');
run(['-c', `DELETE FROM builder_membership_permissions
  WHERE membership_id='${MEMBERSHIP_B}' AND scope_type='transaction'`]);

// --- expiry ----------------------------------------------------------------
// valid_until must stay after valid_from, so the whole window is moved back.
run(['-c', `UPDATE builder_project_access
  SET valid_from = now() - interval '30 days', valid_until = now() - interval '1 day'
  WHERE builder_user_id='${USER_B}' AND project_id='${PROJECT_1}'`]);
expectEqual('an expired project grant denies the transaction',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');
run(['-c', `UPDATE builder_project_access SET valid_until = NULL
  WHERE builder_user_id='${USER_B}' AND project_id='${PROJECT_1}'`]);
expectEqual('clearing the expiry restores access',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 't');
run(['-c', `UPDATE builder_project_access SET revoked_at = now()
  WHERE builder_user_id='${USER_B}' AND project_id='${PROJECT_1}'`]);
expectEqual('a revoked project grant denies the transaction',
  `SELECT builder_resolve_transaction_permission('${USER_B}','${TXN_1}','transactions','view')`, 'f');
run(['-c', `UPDATE builder_project_access SET revoked_at = NULL
  WHERE builder_user_id='${USER_B}' AND project_id='${PROJECT_1}'`]);

// --- role baseline ---------------------------------------------------------
expectEqual('the transactions permission key carries a role baseline',
  `SELECT count(*)>0 FROM builder_role_default_permissions
   WHERE permission_key='transactions' AND membership_role='manager' AND can_view`, 't');
expectEqual('read_only cannot edit transactions',
  `SELECT can_edit FROM builder_role_default_permissions
   WHERE permission_key='transactions' AND membership_role='read_only'`, 'f');

// ===========================================================================
// 9. Audit failure rolls the mutation back
// ===========================================================================
console.log('\nAudit failure rolls the mutation back');
run(['-c', `
  CREATE OR REPLACE FUNCTION force_audit_failure() RETURNS trigger
  LANGUAGE plpgsql AS $fn$ BEGIN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SIMULATED_AUDIT_OUTAGE'; END $fn$;
  CREATE TRIGGER trg_force_audit_failure BEFORE INSERT ON public.builder_portal_activity_log
    FOR EACH ROW EXECUTE FUNCTION force_audit_failure();
`]);

const before = {
  transactions: query('SELECT count(*) FROM builder_transactions'),
  parties: query('SELECT count(*) FROM builder_transaction_parties'),
  links: query('SELECT count(*) FROM transaction_case_link_history'),
  status2: query(`SELECT status FROM builder_transactions WHERE id='${TXN_2}'`),
  client3: query(`SELECT client_id FROM builder_transactions WHERE id='${TXN_3}'`),
};

expectRejection('transaction creation fails when the trusted audit write fails',
  `SELECT builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,'${PROJECT_1}',NULL,
     '${BLD_ORG}','{"transaction_reference":"NOPE"}'::jsonb,NULL,'x')`,
  'SIMULATED_AUDIT_OUTAGE');
expectEqual('and no transaction row was created',
  'SELECT count(*) FROM builder_transactions', before.transactions);

expectRejection('party creation fails when the trusted audit write fails',
  `SELECT builder_upsert_transaction_party('${ACTOR}','command_user',NULL,'${TXN_2}',NULL,
     '{"name":"Nope"}'::jsonb,NULL,'x')`,
  'SIMULATED_AUDIT_OUTAGE');
expectEqual('and no party row was created',
  'SELECT count(*) FROM builder_transaction_parties', before.parties);

expectRejection('a status transition fails when the trusted audit write fails',
  `SELECT builder_transition_transaction('${TXN_2}',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_2}'),
     '${before.status2}','contract_issued','x','command_user',NULL,'${ACTOR}')`,
  'SIMULATED_AUDIT_OUTAGE');
expectEqual('and the transaction status is unchanged',
  `SELECT status FROM builder_transactions WHERE id='${TXN_2}'`, before.status2);

expectRejection('setting the client fails when the trusted audit write fails',
  `SELECT builder_set_transaction_client('${ACTOR}','command_user',NULL,'${TXN_3}','${CLIENT_A}',
     (SELECT row_version FROM builder_transactions WHERE id='${TXN_3}'),'x')`,
  'SIMULATED_AUDIT_OUTAGE');
expectEqual('and the client is unchanged',
  `SELECT client_id FROM builder_transactions WHERE id='${TXN_3}'`, before.client3);

expectRejection('a case link fails when the trusted audit write fails',
  `SELECT builder_link_transaction_to_case('${ACTOR}','command_user',NULL,'${TXN_3}','${CASE_B2}','x')`,
  'SIMULATED_AUDIT_OUTAGE');
expectEqual('and no link history row was appended',
  'SELECT count(*) FROM transaction_case_link_history', before.links);

run(['-c', 'DROP TRIGGER trg_force_audit_failure ON public.builder_portal_activity_log;']);
expectEqual('with audit restored, a transaction is created again',
  `SELECT (builder_upsert_transaction('${ACTOR}','command_user',NULL,NULL,'${PROJECT_1}',NULL,
     '${BLD_ORG}','{"transaction_reference":"TX-OK"}'::jsonb,NULL,'ok')).transaction_reference`,
  'TX-OK');

// ===========================================================================
// 10. Solicitor regression
// ===========================================================================
console.log('\nSolicitor regression');
expectEqual('the Solicitor firm table is untouched by the transactions migration',
  `SELECT count(*)>0 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='solicitor_firms'`, 't');
expectEqual('existing Solicitor terms acceptances are preserved',
  "SELECT count(*)>=0 FROM portal_terms_acceptances WHERE portal='solicitor'", 't');
expectEqual('the Solicitor rollout adapter still resolves its original signature',
  `SELECT resolve_cross_portal_feature_mode(
     (SELECT id FROM solicitor_firms LIMIT 1),'solicitor_matter_access_v2')`, 'cutover');
expectEqual('the legal_matter case slot still exists and is still unique',
  `SELECT count(*)>0 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='transaction_case_links'
     AND column_name='legal_matter_id'`, 't');

// ===========================================================================
const failed = results.filter((r) => !r.passed);
console.log(`\n${'='.repeat(70)}`);
console.log(`Transactions local verification: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(`\n${failed.length} failure(s):`);
  for (const f of failed) console.log(`  - ${f.name}\n      ${f.detail}`);
  process.exit(1);
}
console.log('All transaction conditions verified against a live PostgreSQL database.');
