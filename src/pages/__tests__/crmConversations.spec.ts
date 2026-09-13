/**
 * Audit items 36, 37 and 38 — the CRM Conversations page.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const page = readFileSync(join(root, 'src', 'pages', 'Conversations.tsx'), 'utf8');
const config = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const sync = readFileSync(join(root, 'supabase', 'functions', 'sync-ghl-conversations', 'index.ts'), 'utf8');
const cron = readFileSync(
  join(root, 'supabase', 'functions', 'conversation-sync-cron', 'index.ts'),
  'utf8',
);
const broker = readFileSync(
  join(root, 'supabase', 'functions', 'get-client-data', 'index.ts'),
  'utf8',
);
const shared = (name: string) =>
  readFileSync(join(root, 'supabase', 'functions', '_shared', name), 'utf8');
const paging = shared('ghlConversationPaging.ts');
const store = shared('ghlConversationStore.ts');
const mapper = shared('ghlConversationMap.pure.ts');

describe('item 37 — the client waits as long as the server is allowed', () => {
  /**
   * "Sync could not complete. Request timed out." is the browser's own abort,
   * not an answer from the server: `invokeSecureFunction` defaults to 60s and
   * this passed no override, while the function is declared at 120. A sync
   * running its declared budget was reported as a failure at the halfway mark
   * while it carried on and finished.
   */
  it('passes a timeout at all', () => {
    expect(page).toMatch(/invokeSecureFunction\("sync-ghl-conversations",[\s\S]{0,120}?\{ timeoutMs: GHL_SYNC_TIMEOUT_MS \}/);
  });

  it('is at least the request_timeout the function declares', () => {
    const declared = config
      .split('[functions.sync-ghl-conversations]')[1]
      ?.split('[functions.')[0]
      ?.match(/request_timeout\s*=\s*(\d+)/)?.[1];
    expect(declared).toBeDefined();
    const clientMs = Number(page.match(/const GHL_SYNC_TIMEOUT_MS = ([\d_]+);/)?.[1].replace(/_/g, ''));
    expect(clientMs).toBeGreaterThanOrEqual(Number(declared) * 1000);
  });
});

describe('item 36 — 722 names must not cost 722 round trips', () => {
  it('authorises the whole id set in one call', () => {
    expect(broker).toMatch(/if \(!await canAccessAllOf\(supabase, actor, idsToFetch\)\)/);
  });

  it('no longer loops an await over the ids', () => {
    // The loop is what took the request past the browser's abort, which left
    // `clientMap` empty and rendered every conversation as "Unknown".
    expect(broker).not.toMatch(/for \(const id of idsToFetch\)/);
  });

  it('still refuses the whole request, never part of it', () => {
    // A per-id verdict would turn this broker into an id oracle.
    const gate = broker.slice(
      broker.indexOf('canAccessAllOf(supabase, actor, idsToFetch)'),
      broker.indexOf('// Handle custom table queries in list mode'),
    );
    expect(gate).toMatch(/error: 'Client not found', success: false/);
    expect(gate).toMatch(/status: 404/);
  });

  it('keeps the per-id helper for its other callers', () => {
    const helper = readFileSync(
      join(root, 'supabase', 'functions', '_shared', 'clientAccess.ts'),
      'utf8',
    );
    expect(helper).toMatch(/export async function canAccessClient\(/);
    expect(helper).toMatch(/export async function canAccessAllOf\(/);
  });
});

describe('item 38 — the inbox preview finishes cleanly', () => {
  /**
   * The truncation itself was measured correct in Chromium against the
   * compiled stylesheet: `text-overflow: ellipsis`, `white-space: nowrap`,
   * 990px of text in a 252px box, ending 17px inside the card. What was NOT
   * rendering is beside it.
   */
  it('keeps the preview truncatable', () => {
    expect(page).toMatch(/"min-w-0 truncate text-\[0\.8rem\] leading-5 transition-colors"/);
  });

  it('draws the scrollbar thumb it describes', () => {
    // `via-muted0` is not a token and compiled to nothing, so the thumb the
    // report's arrow points at was a two-stop gradient rather than three.
    expect(page).not.toMatch(/muted0/);
    expect(page).toMatch(/\[&_\[data-radix-scroll-area-thumb\]\]:via-muted\/80/);
  });
});

describe('the typo that rendered nothing, everywhere it appeared', () => {
  const TYPO = `muted${0}`;

  it('is gone from the whole of src', () => {
    // 17 occurrences across 11 files, every variant compiling to zero CSS
    // rules — so each of those elements drew no background at all.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        // A spec that names the typo in order to forbid it is not an offender.
        if (!/\.tsx?$/.test(entry.name) || /\.(spec|test)\.tsx?$/.test(entry.name)) continue;
        if (readFileSync(full, 'utf8').includes(TYPO)) offenders.push(full);
      }
    };
    walk(join(root, 'src'));
    expect(offenders).toEqual([]);
  });
});


/**
 * Audit 3 item 15 — "Request timed out" came back after the budget was raised.
 *
 * Raising it was right and could never be enough: the function walks every
 * client with a GoHighLevel contact id, so its runtime grows with the tenant.
 * A run that must finish inside one request will fail again at the next size.
 * It stops while it can still answer, and the caller resumes it.
 *
 * The walk used to pause 500ms between contacts, and that is what made the
 * budget bite so early — at 500ms a contact, 95s reaches at most 190 of the
 * prime's 776 clients. Pacing now comes from the shared GHL token bucket
 * (`ghlFetchShared`) and the contacts overlap, so the budget is consulted as
 * `mapWithConcurrency`'s `stop` predicate rather than as a `break`. The
 * CONTRACT is unchanged and is what this asserts: the same `BUDGET_MS`, still
 * measured against `startedAt`, still leaving room to answer.
 */
describe('Audit 3 item 15 — the sync outgrows any single request', () => {
  it('the function keeps a wall-clock budget and stops before the request does', () => {
    expect(sync).toMatch(/const BUDGET_MS = [\d_]+;/);
    // Asserted on the comparison, not on the statement that acts on it: a
    // `break` and a `stop` predicate are the same promise, and pinning the
    // syntax would fail a refactor that keeps the promise while forbidding
    // nothing that breaks it.
    expect(sync).toMatch(/Date\.now\(\) - startedAt > BUDGET_MS/);
    // And the budget has to reach the walk. A constant nothing consults is
    // the failure this whole describe block exists to prevent — so the
    // predicate is named once and every consumer is checked to take it,
    // rather than the literal being re-matched at each call site.
    expect(sync).toMatch(/const stop = \(\) => Date\.now\(\) - startedAt > BUDGET_MS;/);
    // The contact pool.
    expect(sync).toMatch(/\{ stop \},/);
    // And every paged walk, so a single contact's conversations and messages
    // cannot run past the moment the run has to answer.
    expect((sync.match(/^\s+stop,$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('the budget leaves room to answer inside the declared request_timeout', () => {
    const budgetMs = Number(sync.match(/const BUDGET_MS = ([\d_]+);/)![1].replace(/_/g, ''));
    const declared = Number(
      config.match(/\[functions\.sync-ghl-conversations\][\s\S]*?request_timeout\s*=\s*(\d+)/)![1],
    );
    expect(budgetMs).toBeLessThan(declared * 1000);
  });

  it('reports how far it got instead of only success or failure', () => {
    expect(sync).toMatch(/done,/);
    expect(sync).toMatch(/cursor: done \? null : nextCursor/);
  });

  it('resumes from the cursor rather than restarting the walk', () => {
    expect(sync).toMatch(/cursor = 0 \} = body/);
    expect(sync).toMatch(/targetContactIds\.slice\(startIndex\)/);
  });

  it('the client drives it to the end, with a bound so it cannot spin', () => {
    expect(page).toMatch(/const MAX_LEGS = \d+;/);
    expect(page).toMatch(/if \(data\?\.done !== false\) return/);
  });

  it('treats a server with no cursor as one complete run, not an endless loop', () => {
    // `done` absent means an older deployment; looping against it would hang.
    expect(page).toMatch(/data\?\.done !== false/);
    expect(page).toMatch(/next === null \|\| next === cursor/);
  });
});

/**
 * Audit 3 item 14 — an emailed reply left no trace in the thread.
 */
describe('Audit 3 item 14 — an emailed reply is recorded in the conversation', () => {
  it('writes the sent email into the messages table the thread reads', () => {
    expect(page).toMatch(/table: "ghl_conversation_messages"/);
    expect(page).toMatch(/direction: "outbound"/);
    expect(page).toMatch(/channel_type: "email"/);
  });

  it('marks the row as ours so it can never be mistaken for a GoHighLevel id', () => {
    expect(page).toMatch(/ghl_message_id: `local-email-\$\{idempotencyKey\}`/);
  });

  it('never fails the send over the record — the email has already gone', () => {
    expect(page).toMatch(/catch \(persistError\)/);
    expect(page).toMatch(/could not be added to the conversation history/);
  });
});

describe('the scheduled conversation sync stops sleeping too', () => {
  /*
    THE THIRD ONE, AND THE ONE THAT ACTUALLY RUNS.

    `sync-ghl-conversations` and `ghl-conversations-cron` were un-slept first;
    `conversation-sync-cron` is what pg_cron fires every ten minutes and it
    still paced itself by hand. Measured on the prime, 13 Sep 2026, five
    consecutive runs of 56 contacts: 136s, 134s, 109s, 125s, 134s. The
    `delay(500)` per contact is 28 seconds of that before a single request is
    made.
  */
  it('sleeps nowhere', () => {
    // Comments may still NAME the sleeps this replaced; code may not call one.
    const code = cron.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/await delay\(/);
    expect(code).not.toMatch(/setTimeout\(/);
  });

  it('paces through the shared bucket rather than a guess', () => {
    /*
      A fixed sleep is wrong twice over: far slower than the vendor allows
      when nothing else is calling, and not a limit at all when something is —
      two overlapping invocations each sleeping 500ms together issue four
      requests a second.

      The bucket is reached through the pager now rather than named here, so
      the assertion is that this function issues NO request of its own: one
      module holds every GHL call these two functions make, and the pace is a
      property of that module rather than of each caller remembering.
    */
    expect(cron).not.toMatch(/await fetch\(/);
    expect(cron).not.toMatch(/ghlFetchShared/);
    expect(paging).toContain("import { ghlFetchShared } from './ghl-rate-limiter.ts'");
    expect(paging).not.toMatch(/await fetch\(/);
  });

  it('keys the bucket on the account, never on a literal', () => {
    // Two GHL accounts are two buckets. One shared key would pace a token
    // against another token's traffic.
    expect(cron).toMatch(/tokenKeyFor\(_ghlCreds\.label, apiKey\)/);
  });

  it('works contacts concurrently, bounded', () => {
    expect(cron).toContain("import { mapWithConcurrency } from '../_shared/boundedConcurrency.pure.ts'");
    expect(cron).toMatch(/mapWithConcurrency\(\s*entries,\s*CONTACT_CONCURRENCY/);
    const limit = Number(cron.match(/const CONTACT_CONCURRENCY = (\d+);/)?.[1]);
    expect(limit).toBeGreaterThan(1);
  });

  it('stops starting work at a wall-clock budget', () => {
    /*
      Every boundary is re-derived from rows that already exist, so a contact
      this run did not reach is picked up by the next one — there is no cursor
      to leave stale, which is what makes stopping safe.
    */
    expect(cron).toMatch(/stop:\s*\(\)\s*=>\s*Date\.now\(\) - startedAt > opts\.deadlineMs/);
    const budget = Number(cron.match(/const BUDGET_MS = ([\d_]+);/)?.[1].replace(/_/g, ''));
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(150_000);
  });

  it('gives each band its own deadline, and they are in priority order', () => {
    /*
      Three bands need three deadlines and `stop` is a single global
      predicate, so they are three passes. The deadlines are ABSOLUTE against
      one `startedAt`, which is what lets a band that finishes early hand the
      rest of the clock to the next one instead of idling.
    */
    const at = (name: string) =>
      Number(cron.match(new RegExp(`const ${name} = ([0-9_]+);`))?.[1].replace(/_/g, ''));
    const fresh = at('FRESH_HEAD_DEADLINE_MS');
    const bootstrap = at('BOOTSTRAP_DEADLINE_MS');
    const budget = at('BUDGET_MS');
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(budget);
    expect(budget).toBeLessThan(150_000);
  });

  it('runs the three bands, and runs the fresh head first', () => {
    /*
      The inbound notification hangs off the fresh head, and an operator
      waiting on a reply is the only reader here with a clock. Bootstrap is
      the coverage gap; the stale tail is the completeness rotation.
    */
    const order = [...cron.matchAll(/runBand\((fresh|bootstrap|stale)Band,/g)].map((m) => m[1]);
    expect(order).toEqual(['fresh', 'bootstrap', 'stale']);
  });

  it('walks history on the two bands that can need it, and not on the third', () => {
    /*
      A top-down walk stops at the first page it already holds in full, which
      is correct for "what is new" and blind to everything BELOW a thread an
      earlier cap cut short.

      The FRESH head pays for it because its own upsert stamps
      `last_synced_at = now` on every conversation it touches, which puts those
      threads permanently at the back of the stale tail's ordering — the fifty
      most active threads would otherwise never reach the band that completes a
      truncated one, and they are the threads most likely to be truncated.

      BOOTSTRAP does not, and cannot need to: a conversation it has just
      discovered has an empty held set, so the top-down walk already ran to
      exhaustion and there is no anchor to seed a second one from.
    */
    expect(cron).toMatch(/runBand\(freshBand,[\s\S]{0,160}?deepProbe: true/);
    expect(cron).toMatch(/runBand\(bootstrapBand,[\s\S]{0,160}?deepProbe: false/);
    expect(cron).toMatch(/runBand\(staleBand,[\s\S]{0,160}?deepProbe: true/);
  });

  it('stamps the rotation column on every attempt, not only on success', () => {
    /*
      `last_synced_at` is what orders the stale-tail band. A conversation whose
      search was refused and which is therefore never stamped stays at the head
      of that queue for ever and blocks everything behind it — a priority
      inversion that gets worse the more often the job runs.
    */
    expect(cron).toMatch(/runBand\(staleBand,[\s\S]{0,160}?stampAttempt: true/);
    expect(cron).toMatch(/\} finally \{[\s\S]{0,900}?last_synced_at: syncedAtIso/);
  });

  it('states nullsFirst wherever the ordering decides what gets looked at', () => {
    /*
      Postgres orders DESC as NULLS FIRST, and `last_message_date` is nullable.
      "The 50 newest conversations" was in fact up to 50 rows with no message
      date at all — the opposite of what that band is for. ASC is NULLS LAST,
      and a never-stamped row is the one most in need of attention, so the
      stale tail states the other direction for the opposite reason.
    */
    expect(cron).toMatch(/order\('last_message_date', \{ ascending: false, nullsFirst: false \}\)/);
    expect(cron).toMatch(/order\('last_synced_at', \{ ascending: true, nullsFirst: true \}\)/);
    expect(store).toMatch(/order\('ghl_date_added', \{ ascending: true, nullsFirst: false \}\)/);
  });

  it('sweeps the never-seen contacts through the proved window, never an ad-hoc modulo', () => {
    /*
      `floor(now / period) % windowCount` reaches only the residues of
      `stride mod N` — at a 15-minute cadence over 6 windows it visits
      {0,1,3,4} and never 2 or 5, silently. The pure module advances by at
      most one window width per tick, so consecutive windows abut and their
      union is the whole list for any cadence.
    */
    expect(cron).toMatch(/import \{[^}]*bootstrapWindow[^}]*\} from '\.\.\/_shared\/ghlBootstrapWindow\.pure\.ts'/);
    const code = cron.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.floor\(Date\.now\(\) \/ /);
  });

  it('never pages a result set with an unbounded select', () => {
    /*
      PostgREST answers at most `max_rows` and says nothing about having
      truncated. Both of these read a set whose COMPLETENESS is the point.
    */
    expect(cron).toContain("from '../_shared/postgrestPaging.pure.ts'");
    expect(sync).toContain("from '../_shared/postgrestPaging.pure.ts'");
    expect(store).toContain("from './postgrestPaging.pure.ts'");
  });

  it('pins the client to the version the rate limiter declares', () => {
    // A floating `@2` resolves to a different SupabaseClient type and the
    // limiter's first parameter stops matching.
    const limiterPin = readFileSync(
      join(root, 'supabase', 'functions', '_shared', 'ghl-rate-limiter.ts'),
      'utf8',
    ).match(/@supabase\/supabase-js@([\d.]+)/)?.[1];
    expect(limiterPin).toBeDefined();
    for (const src of [cron, sync, paging, store]) {
      const pins = [...src.matchAll(/@supabase\/supabase-js@([\d.]+)/g)].map((m) => m[1]);
      for (const pin of pins) expect(pin).toBe(limiterPin);
    }
  });
});

describe('one conversation mapper, one conversation store', () => {
  /*
    Four copies of these mappers existed. Two call sites writing the same
    message through two copies of `mapMessageDirection` is how one message
    comes to be `inbound` on the scheduled path and `outbound` on the
    browser's refresh, with `onConflict: 'ghl_message_id'` making whichever
    ran last the winner.
  */
  it('neither sync function keeps a private copy of the mappers', () => {
    for (const src of [cron, sync]) {
      expect(src).not.toMatch(/^function mapChannelType\(/m);
      expect(src).not.toMatch(/^function mapMessageDirection\(/m);
      expect(src).not.toMatch(/^function mapContentType\(/m);
      expect(src).not.toMatch(/^function parseGhlDate\(/m);
    }
  });

  it('both write a conversation and a message through the one store', () => {
    for (const src of [cron, sync]) {
      expect(src).toContain("from '../_shared/ghlConversationStore.ts'");
      // The row shapes live in the mapper; nothing assembles one inline.
      expect(src).not.toMatch(/ghl_message_id: msg\.id/);
      expect(src).not.toMatch(/\.from\('ghl_conversation_messages'\)\s*\n\s*\.upsert/);
    }
  });

  it('deduplicates a batch before the upsert', () => {
    /*
      GHL repeats the anchor message across a page boundary, and Postgres
      answers a second conflicting row inside one statement with 21000 —
      which loses the WHOLE batch, not the duplicate.
    */
    expect(store).toMatch(/const byId = new Map<string, Row>\(\)/);
    expect(store).toMatch(/byId\.set\(id, m\)/);
  });

  it('refuses a truncated held set rather than using it', () => {
    /*
      The pager stops walking when a page is already held in full, so the set
      it is handed has to be COMPLETE. A window of it either stops the walk
      above messages it never fetched, or — worse — makes it run to the bottom
      of the thread on every tick for ever.
    */
    expect(store).toMatch(/if \(got\.truncated\) \{/);
    expect(store).toMatch(/failed: `held set exceeded/);
  });

  it('keeps the migration worker’s replay columns out of an import', () => {
    // Writing them would erase an account-to-account migration's state.
    expect(mapper).not.toMatch(/new_ghl_conversation_id:/);
    expect(mapper).not.toMatch(/new_ghl_message_id:/);
    expect(mapper).not.toMatch(/replayed_at:/);
    expect(mapper).not.toMatch(/replay_skipped_reason:/);
  });
});

describe('a walk that failed is never reported as one that finished', () => {
  /*
    `ghlFetchShared` RETURNS a non-2xx response after its retries rather than
    throwing, so the natural `break` on a bad response leaves no cursor, cuts
    no budget, and computes exhaustion. `GhlWindow` therefore carries four
    separate facts and derives `exhausted` from all of them at one place.
  */
  it('derives exhaustion once, from every fact', () => {
    expect(paging).toMatch(
      /exhausted: !flags\.failed && !flags\.stoppedOnBudget && !flags\.hitPageCap && flags\.noCursor/,
    );
    // Exactly one place may decide it. The interface DECLARES the field;
    // only `done()` may compute a value for it.
    expect((paging.match(/exhausted: [^b]/g) ?? []).length).toBe(1);
  });

  it('never reads `nextPage` on the conversation search', () => {
    /*
      That field exists only on the messages sub-endpoint. Reading it on the
      search is what made a previous worker exit after one page.
    */
    const search = paging.slice(
      paging.indexOf('export async function searchConversationsForContact'),
      paging.indexOf('function readMessagePage'),
    );
    expect(search).not.toMatch(/nextPage/);
    expect(search).toMatch(/params\.set\('startAfterId', startAfterId\)/);
    expect(search).toMatch(/params\.set\('startAfter', startAfter\)/);
  });

  it('has no short-page early exit — only the absence of a cursor ends a walk', () => {
    // A short page is not proof of exhaustion. The copy this replaces ended
    // the walk on `messages.length < 50`.
    const code = paging.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.length < GHL_MESSAGE_PAGE_LIMIT/);
    expect(code).not.toMatch(/length < 50/);
  });

  it('both callers read the failure rather than inferring it from a count', () => {
    expect(sync).toMatch(/if \(search\.failed\)/);
    expect(cron).toMatch(/if \(search\.failed\)/);
  });
});
