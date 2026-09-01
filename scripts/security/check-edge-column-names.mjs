#!/usr/bin/env node
/**
 * An Edge Function may not name a column its table does not have.
 *
 * ## Why this exists
 *
 * PostgREST answers `42703` for a column that does not exist. Almost every call
 * site in this repository destructures `{ data }` and throws the `error` away,
 * so a mistyped column does not read as an error — it reads as **no rows**. A
 * table without the column and a row without a value answer identically, which
 * is why this class survives review, survives testing against an empty
 * database, and is only ever found by reading the schema.
 *
 * `CLAUDE.md` already records what one instance cost: eighteen call sites named
 * `aml.cases.tenant_id`, a column that table has never had, and twelve handlers
 * then reported "Case not found" about a case the operator had open.
 *
 * A sweep for the same shape across `supabase/functions/` found **fifty-eight
 * more**, in eighteen functions. Among them:
 *
 *   - `secure-storage` selected `investment_reports.client_id, created_by`
 *     (they are `client_property_id` and `generated_by`), so every human upload
 *     to that bucket was refused 403 — which reached an adviser as
 *     "PDF generation failed. Please try again.";
 *   - `dispatch-marketing-reports` selected a contact name and email off
 *     `ghl_client_opportunities`, which has neither, so the scheduled dispatch
 *     resolved no recipients at all;
 *   - `market-updates-embed-backfill` selected `market_updates.summary`
 *     (it is `ai_summary`), so it had never embedded a single update;
 *   - `agent-insights-runner` filtered `client_deals.assigned_user_id`, which
 *     does not exist, so no stale-deal or settlement insight was ever raised;
 *   - three authorisation fallbacks read `custom_users.role_display` (it is
 *     `role`) and therefore could never grant.
 *
 * Every one of those reported as normal, empty operation.
 *
 * ## What this checks
 *
 * Literal column lists only — `.select('a, b')`, and `.insert({ a: … })` /
 * `.update({ … })` / `.upsert({ … })` with an inline object. A payload built in
 * a variable, an interpolated select or an embedded resource (`a, b(c)`) is not
 * a set of names this can read, and is skipped rather than guessed at.
 *
 * Columns are resolved by `lib/supabaseSchema.mjs` as the UNION of the
 * generated types and the migrations, so a column added since the types were
 * last regenerated is not reported as missing.
 *
 * A table neither source has heard of is skipped: it may be a view, another
 * schema, or a table this repository does not define.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { knownColumns } from './lib/supabaseSchema.mjs';

const root = resolve(process.cwd());
const FUNCTIONS = join(root, 'supabase/functions');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Identifiers bound to a non-public schema.
 *
 * `const aml = admin.schema("aml")` makes `aml.from(…)` a different schema
 * entirely, and the generated public types describe none of its tables — so
 * judging those against `public` would report every column of every aml table
 * as missing.
 */
function schemaHandles(source) {
  const handles = new Set();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.schema\(/g)) {
    handles.add(m[1]);
  }
  return handles;
}

/**
 * `.from('table')…​.select('a, b')` where the select belongs to the SAME chain.
 *
 * The gap may contain neither a `;` (a new statement) nor another `.from(` — a
 * sibling query inside a `Promise.all([…])` array is separated by a comma, not
 * a semicolon, and attributing its select to the previous table reports
 * nonsense.
 */
const SELECT = /([A-Za-z_$][\w$]*)\s*\.from\(\s*(['"`])([a-z0-9_]+)\2\s*\)((?:(?!\.from\()[^;]){0,200}?)\.select\(\s*(['"`])([^'"`]*)\5/g;
const WRITE = /([A-Za-z_$][\w$]*)\s*\.from\(\s*(['"`])([a-z0-9_]+)\2\s*\)\s*\.(insert|update|upsert)\(\s*\{([^{}]*)\}/g;

const findings = [];

for (const file of walk(FUNCTIONS)) {
  const source = readFileSync(file, 'utf8');
  const handles = schemaHandles(source);
  const where = (index) => `${relative(root, file)}:${source.slice(0, index).split('\n').length}`;

  for (const m of source.matchAll(SELECT)) {
    const [, receiver, , table, , , selection] = m;
    if (handles.has(receiver)) continue;
    // `*`, an embedded resource and any interpolated list are not literal names.
    if (selection.includes('*') || selection.includes('(') || selection.includes('${')) continue;
    const columns = knownColumns(table);
    if (!columns) continue;
    const named = selection.split(',').map((c) => c.trim()).filter(Boolean);
    const missing = named.filter((c) => !columns.includes(c));
    if (missing.length) findings.push(`${where(m.index)} select ${table} → ${missing.join(', ')}`);
  }

  for (const m of source.matchAll(WRITE)) {
    const [, receiver, , table, op, body] = m;
    if (handles.has(receiver)) continue;
    if (body.includes('...')) continue; // a spread is not a literal key set
    const columns = knownColumns(table);
    if (!columns) continue;
    const keys = [...body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/gi)].map((k) => k[1]);
    const missing = keys.filter((k) => !columns.includes(k));
    if (missing.length) findings.push(`${where(m.index)} ${op} ${table} → ${missing.join(', ')}`);
  }
}

if (findings.length) {
  console.error(
    'Edge Function column names FAILED — these name columns their table does not have.\n' +
    'PostgREST answers 42703 and the discarded error reads as "no rows", so this is invisible at runtime.\n' +
    'Check the column against src/integrations/supabase/types.ts and supabase/migrations/.\n- ' +
    findings.join('\n- '),
  );
  process.exit(1);
}
console.log('Edge Function column-name check passed (no select or write names a column its table lacks).');
