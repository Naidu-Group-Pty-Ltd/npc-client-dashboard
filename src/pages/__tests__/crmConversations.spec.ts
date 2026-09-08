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
const broker = readFileSync(
  join(root, 'supabase', 'functions', 'get-client-data', 'index.ts'),
  'utf8',
);

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
 * client with a GoHighLevel contact id, pausing 500ms between contacts
 * because GHL rate-limits, so its runtime grows with the tenant. A run that
 * must finish inside one request will fail again at the next size. It stops
 * while it can still answer, and the caller resumes it.
 */
describe('Audit 3 item 15 — the sync outgrows any single request', () => {
  it('the function keeps a wall-clock budget and stops before the request does', () => {
    expect(sync).toMatch(/const BUDGET_MS = [\d_]+;/);
    expect(sync).toMatch(/if \(Date\.now\(\) - startedAt > BUDGET_MS\) break;/);
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
