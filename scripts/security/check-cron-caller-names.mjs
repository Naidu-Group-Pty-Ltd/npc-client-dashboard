#!/usr/bin/env node
/**
 * A scheduled job and the function it calls must agree on who is calling.
 *
 * `public.cron_invoke_signed_function(fn, body, caller)` signs an HMAC over
 * (method, path, timestamp, nonce, CALLER, key id, body hash) and sends the
 * caller in `X-Internal-Caller`. The receiving Edge Function passes an
 * allow-list to `verifySignedInternal` / `requireHumanOrSignedInternal`, and a
 * caller name outside that list is refused 401.
 *
 * Nothing anywhere checked that the two spellings match, and three scheduled
 * workers on the prime had therefore never once run:
 *
 *   - `bulk-generation-resume-3min` (every 3 minutes) signed as `pg_cron`
 *     while `resume-bulk-generation` accepted only
 *     `bulk-generation-resume-cron`. ~480 refusals a day; one bulk report job
 *     sat `processing` from 2026-05-15 because nothing could ever close it.
 *   - `market-qa-digest-runner-hourly` signed an internal request to a
 *     function that reads `x-cron-secret` and nothing else — and
 *     `cron_signed_internal_headers` does not send that header, so it could
 *     never be satisfied. `market_qa_digests` held zero rows.
 *   - `cleanup-stale-calls-hourly` signed an internal request to a function
 *     that requires an admin user's JWT.
 *
 * Every one of those reported as a healthy pg_cron run, because pg_cron
 * reports on the SQL that QUEUED the HTTP call and never on the call — the
 * same rule `docs/aml/SCREENING_EXECUTION.md` records. This check reads the
 * two ends out of the repository and fails when they disagree, so the class
 * cannot come back silently.
 *
 * What is judged: the last `cron.schedule` for each job name across the
 * migrations in filename order (which is the order they apply), and only
 * bodies that call `cron_invoke_signed_function`. A job scheduled with
 * `net.http_post` directly carries its own headers and is out of scope.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FUNCTIONS = join(ROOT, 'supabase', 'functions');

/** The default third argument of `cron_invoke_signed_function`. */
const DEFAULT_CALLER = 'pg_cron';

/**
 * Split a call's argument list on top-level commas.
 *
 * `jsonb_build_object('source','cron')` is one argument containing a comma, so
 * splitting on `,` naively reads the caller as `'cron'` and the check passes
 * on a job that is broken.
 */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = ch === "'" && text[i + 1] === "'" ? quote : null;
      continue;
    }
    if (ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Read the balanced argument text of `name(` starting at `open`. */
function balancedArgs(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { args: source.slice(open + 1, i), end: i };
    }
  }
  return null;
}

const unquote = (s) => {
  const m = /^'((?:[^']|'')*)'$/.exec(s.trim());
  return m ? m[1].replace(/''/g, "'") : null;
};

/**
 * Every `cron.schedule` / `cron.unschedule` in one migration, in source order.
 *
 * A dollar-quoted body (`$job$ … $job$`) is what carries the invocation, and
 * its tag varies by author, so the body is taken from the balanced argument
 * list rather than by matching a fixed tag.
 */
function readSchedulingOps(sql) {
  const ops = [];
  const re = /cron\.(schedule|unschedule)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const bal = balancedArgs(sql, re.lastIndex - 1);
    if (!bal) continue;
    const args = splitArgs(bal.args);
    const kind = m[1].toLowerCase();
    const name = unquote(args[0] ?? '');
    // `cron.unschedule(jobid) FROM cron.job WHERE jobname = '…'` is the other
    // spelling, and it names the job in the predicate rather than the call.
    if (kind === 'unschedule' && !name) {
      const tail = sql.slice(bal.end, bal.end + 400);
      const byName = /jobname\s*=\s*'([^']+)'/i.exec(tail);
      if (byName) ops.push({ kind, name: byName[1] });
      continue;
    }
    if (!name) continue;
    ops.push({ kind, name, body: kind === 'schedule' ? (args[2] ?? '') : '' });
  }
  return ops;
}

/** The `(target, caller)` pairs a scheduled body signs. */
function invocationsIn(body) {
  const found = [];
  const re = /cron_invoke_signed_function\s*\(/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const bal = balancedArgs(body, re.lastIndex - 1);
    if (!bal) continue;
    const args = splitArgs(bal.args);
    const target = unquote(args[0] ?? '');
    if (!target) continue;
    const callerArg = args[2];
    // An omitted third argument takes the function's own default.
    const caller = callerArg === undefined ? DEFAULT_CALLER : unquote(callerArg);
    found.push({ target, caller, callerLiteral: callerArg !== undefined });
  }
  return found;
}

/**
 * The caller names one Edge Function will accept.
 *
 * Three helpers verify a signed internal request and they spell the allow-list
 * three ways, which is part of why the two ends drifted unnoticed:
 *
 *   verifySignedInternal(sb, req, raw, ['pg_cron'])              // 4th arg, array
 *   requireHumanOrSignedInternal(sb, req, raw, ['a','b'], body)  // 4th arg, array
 *   verifyInternal(sb, req, raw, { allowedCallers: ['pg_cron'] })// 4th arg, object
 *   verifyInternal(sb, req, raw)                                 // no list: any caller
 *
 * An identifier in the 4th position is resolved against a `const NAME = [...]`
 * in the same file. Every list in the file is unioned, because a function may
 * verify on more than one branch and any of them admitting the caller is
 * enough. `verifyInternal` with no `allowedCallers` accepts every caller
 * (`enforceCallerAllowlist` returns null when the set is empty), so it is a
 * wildcard rather than an empty list — reading it as empty would fail every
 * job that calls the dispatcher.
 */
function acceptedCallers(source) {
  const accepted = new Set();
  let verifies = false;
  let wildcard = false;
  const re = /(?:verifySignedInternal|requireHumanOrSignedInternal|verifyInternal)\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const bal = balancedArgs(source, re.lastIndex - 1);
    if (!bal) continue;
    verifies = true;
    const args = splitArgs(bal.args);
    let listText = (args[3] ?? '').trim();
    if (!listText) { wildcard = true; continue; }
    if (listText.startsWith('{')) {
      // Options object: only `allowedCallers` narrows the caller.
      const opt = /allowedCallers\s*:\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/.exec(listText);
      if (!opt) { wildcard = true; continue; }
      listText = opt[1];
    }
    if (/^[A-Za-z_$][\w$]*$/.test(listText)) {
      const decl = new RegExp(`\\b${listText}\\s*(?::[^=]+)?=\\s*(\\[[^\\]]*\\])`).exec(source);
      if (!decl) { wildcard = true; continue; }
      listText = decl[1];
    }
    const names = [...listText.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (!names.length) { wildcard = true; continue; }
    for (const n of names) accepted.add(n);
  }
  return { verifies, accepted, wildcard };
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/** Last writer wins, exactly as the migrations apply. */
const live = new Map();
for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const op of readSchedulingOps(sql)) {
    if (op.kind === 'unschedule') { live.delete(op.name); continue; }
    const invocations = invocationsIn(op.body);
    if (!invocations.length) { live.delete(op.name); continue; }
    live.set(op.name, { file, invocations });
  }
}

const failures = [];
let checked = 0;

for (const [jobname, { file, invocations }] of [...live.entries()].sort()) {
  for (const inv of invocations) {
    checked += 1;
    const where = `${jobname} (${file})`;
    const entry = join(FUNCTIONS, inv.target, 'index.ts');
    if (!existsSync(entry)) {
      failures.push(
        `${where}\n  schedules '${inv.target}', which this repository does not contain.`,
      );
      continue;
    }
    const { verifies, accepted, wildcard } = acceptedCallers(readFileSync(entry, 'utf8'));
    if (!verifies) {
      failures.push(
        `${where}\n  signs an internal request to '${inv.target}', which never verifies one.\n` +
        `  cron_signed_internal_headers sends no x-cron-secret and no user JWT, so a\n` +
        `  function gated on either can never be reached by this job. Give it a\n` +
        `  verifySignedInternal branch, or schedule it with net.http_post and its own headers.`,
      );
      continue;
    }
    if (wildcard) continue; // a branch accepts any caller; nothing to compare
    if (!accepted.has(inv.caller)) {
      failures.push(
        `${where}\n  signs as '${inv.caller}'${inv.callerLiteral ? '' : ' (the omitted argument\'s default)'}` +
        ` but '${inv.target}' accepts only ${[...accepted].map((c) => `'${c}'`).join(', ')}.\n` +
        `  Every invocation is refused 401 while pg_cron reports the run as successful.`,
      );
    }
  }
}

if (failures.length) {
  console.error(`Cron caller-name check FAILED (${failures.length} of ${checked} scheduled invocations):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error('A scheduled job and the function it calls must agree on the caller name.');
  process.exit(1);
}

console.log(`Cron caller-name check passed (${checked} scheduled invocations across ${live.size} jobs).`);
