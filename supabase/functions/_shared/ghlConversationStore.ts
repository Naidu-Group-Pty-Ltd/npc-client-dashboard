// Pinned to the version `_shared/ghl-rate-limiter.ts` declares, for the same
// reason every other module in this pipeline is.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { MAX_SCAN_PAGES, SCAN_PAGE, pageAll } from './postgrestPaging.pure.ts';
import { toConversationRow, toMessageRow } from './ghlConversationMap.pure.ts';

/**
 * The three database acts of a GoHighLevel conversation import, written once.
 *
 * `ghlConversationMap.pure.ts` decides what a row CONTAINS; this decides how it
 * reaches the table, which is a separate question with its own traps. Both the
 * scheduled sync and the browser-started one go through here, so a message
 * cannot be written one way by the cron and another way by a refresh.
 *
 * Three things this exists to get right in one place:
 *
 * **A batch is deduplicated before the upsert.** GHL repeats the anchor message
 * across a page boundary, and Postgres answers a second conflicting row inside
 * one statement with 21000, "ON CONFLICT DO UPDATE command cannot affect row a
 * second time" — which loses the WHOLE batch, not the duplicate.
 *
 * **A truncated held set is refused, not used.** The conversation pager stops
 * walking when a page is already held in full, so the set it is handed has to
 * be complete: a window of it makes the walk run to the bottom of the thread on
 * every tick for ever, or stop above messages it never fetched. `pageAll`
 * reports the ceiling and this refuses on it.
 *
 * **A read that failed is not a set that is empty**, so `failed` is carried
 * rather than collapsed — handing an empty held set to the pager is exactly the
 * state that re-downloads everything.
 */

type Row = Record<string, unknown>;

/** Upsert chunk: one round trip per page of messages, well inside any statement limit. */
const WRITE_CHUNK = 500;

export interface HeldMessages {
  /** Every `ghl_message_id` this conversation holds. Complete, or `failed` is set. */
  readonly ids: ReadonlySet<string>;
  /**
   * The OLDEST held message id that GHL could page from, or null.
   *
   * This is the seed for the walk into history. A `failed-…` id is minted
   * locally by the send path for a message the vendor rejected, so GHL has
   * never heard of it and it is never an anchor; nor is a message with no
   * date, which GHL cannot order against.
   */
  readonly oldestAnchor: string | null;
  readonly count: number;
  readonly failed: string | null;
}

export async function loadHeldMessageIds(
  supabase: SupabaseClient,
  localConversationId: string,
): Promise<HeldMessages> {
  const got = await pageAll<{ ghl_message_id: string | null; ghl_date_added: string | null }>((from, to) =>
    supabase
      .from('ghl_conversation_messages')
      .select('ghl_message_id, ghl_date_added')
      .eq('conversation_id', localConversationId)
      // Oldest first, so the head of the set is the anchor. ASC is NULLS LAST
      // in Postgres and `nullsFirst: false` states it rather than inheriting
      // it, because an undated row in that slot is an anchor GHL will refuse.
      .order('ghl_date_added', { ascending: true, nullsFirst: false })
      .range(from, to));

  if (got.failed) return { ids: new Set(), oldestAnchor: null, count: 0, failed: got.failed };
  if (got.truncated) {
    return {
      ids: new Set(),
      oldestAnchor: null,
      count: got.rows.length,
      failed: `held set exceeded ${MAX_SCAN_PAGES * SCAN_PAGE} rows`,
    };
  }

  const ids = new Set<string>();
  let oldestAnchor: string | null = null;
  for (const r of got.rows) {
    const id = r.ghl_message_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    ids.add(id);
    if (oldestAnchor === null && r.ghl_date_added && !id.startsWith('failed-')) oldestAnchor = id;
  }
  return { ids, oldestAnchor, count: ids.size, failed: null };
}

/**
 * Write a conversation and hand back its local id.
 *
 * Returns null on failure and NEVER throws, because one bad conversation must
 * not discard the contact's other conversations — the same guarantee
 * `mapWithConcurrency` gives one level up.
 */
export async function upsertConversation(
  supabase: SupabaseClient,
  conv: Row,
  ctx: { clientId: string | null; ghlContactId: string; syncedAtIso: string; logTag: string },
): Promise<string | null> {
  const { data, error } = await supabase
    .from('ghl_conversations')
    .upsert(
      toConversationRow(conv, {
        clientId: ctx.clientId,
        ghlContactId: ctx.ghlContactId,
        syncedAtIso: ctx.syncedAtIso,
      }),
      { onConflict: 'ghl_conversation_id' },
    )
    .select('id')
    .single();

  if (error || !data) {
    console.error(`[${ctx.logTag}] conversation upsert failed for ${String(conv.id)}: ${error?.message}`);
    return null;
  }
  return data.id as string;
}

/** How many message rows reached the table. Never throws. */
export async function writeMessages(
  supabase: SupabaseClient,
  items: readonly Row[],
  localConversationId: string,
  logTag: string,
): Promise<number> {
  const byId = new Map<string, Row>();
  for (const m of items) {
    const id = m.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    byId.set(id, m);
  }
  if (byId.size === 0) return 0;

  const rows = [...byId.values()].map((m) => toMessageRow(m, localConversationId));
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const { error } = await supabase
      .from('ghl_conversation_messages')
      .upsert(chunk, { onConflict: 'ghl_message_id', ignoreDuplicates: false });
    // 23505 is a unique violation the upsert already resolves for the conflict
    // target; anything else is a real fault and is named rather than counted.
    if (error && error.code !== '23505') {
      console.error(`[${logTag}] messages upsert failed: ${error.message}`);
      continue;
    }
    written += chunk.length;
  }
  return written;
}
