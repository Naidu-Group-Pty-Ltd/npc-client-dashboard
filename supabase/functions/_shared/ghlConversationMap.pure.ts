/**
 * One shape for a GoHighLevel conversation and message row.
 *
 * ## Why this is a module
 *
 * These four mappers exist in FOUR copies today — `conversation-sync-cron`,
 * `sync-ghl-conversations`, `one-time-bulk-conversation-sync` and
 * `ghl-migrate-conversations-worker` — and the first two are about to share
 * one pager. Two call sites writing the same message through two copies of
 * `mapMessageDirection` is how the same message comes to be `inbound` on the
 * scheduled path and `outbound` on the browser's refresh, with the upsert's
 * `onConflict: 'ghl_message_id'` making whichever ran last the winner.
 *
 * The cron's and the browser's copies are unified here. The migration
 * worker's is deliberately left alone — it writes account-to-account
 * migration rows with their own replay columns — and `one-time-bulk` is a
 * one-shot tool. Naming them is the point: a fifth copy should not appear by
 * accident.
 *
 * ## The rule that makes this file load-bearing
 *
 * `check-edge-column-names.mjs` judges only a LITERAL column list at a call
 * site. A row assembled in a mapper module is invisible to it, so the column
 * set has to be pinned by a test instead — `ghlConversationMap.test.ts` does
 * that. Naming a column the table does not have answers 42703, PostgREST
 * hands that back as `data: null`, and the discarded error reads exactly like
 * a row that was not there.
 *
 * Every key below was checked against the LIVE tables on 13 Sep 2026
 * (`information_schema.columns` on the prime's own database, not the generated
 * types and not the migrations):
 *   ghl_conversations         — 16 columns
 *   ghl_conversation_messages — 18 columns
 *
 * The distinction matters here more than usual, because
 * `20260723150000_conversation_message_delivery_safety.sql` adds
 * `available_channels` to the first and `client_request_id` / `error_message`
 * to the second, and **that migration has never been applied to any database
 * in the fleet** — it is absent from `supabase_migrations.schema_migrations` on
 * the prime and the columns are absent from both live tables. So "named by a
 * migration" is not evidence a column exists, and nothing here writes one.
 * `message_type` is named by two send paths and by no migration at all.
 *
 * Pure: no imports, no Deno globals, no network. Parses under Deno and under
 * vitest (which reaches it by relative path from src/, because vitest's
 * `include` is `src/**` and never sees `supabase/functions/**`).
 */

/** Channel values the `channel_type` columns accept; `sms` is the column default. */
export type GhlChannel = string;

/**
 * A GHL timestamp as an ISO string.
 *
 * GHL sends three shapes for the same field — an ISO string, a number of
 * milliseconds, and a STRING of digits — and the digit-string is the one a
 * naive `new Date(val)` gets wrong: `new Date("1731022800000")` is Invalid
 * Date, not a timestamp. Seconds-vs-milliseconds is decided by magnitude
 * against 1e12, which separates them until the year 33658.
 */
export function parseGhlDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number' || /^\d{10,13}$/.test(String(val))) {
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    const ms = num > 1e12 ? num : num * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(val));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * GHL's channel vocabulary onto ours.
 *
 * Lifted verbatim from `conversation-sync-cron`, which is the copy the live
 * path has been writing with. An unrecognised value passes THROUGH rather
 * than collapsing to `sms`: a new GHL channel should arrive in the column as
 * itself and be visible, not be silently recorded as a text message.
 */
export function mapChannelType(ghlType: unknown): GhlChannel {
  if (ghlType === null || ghlType === undefined || ghlType === '') return 'sms';
  const typeStr = String(ghlType).toLowerCase();
  const mapping: Record<string, string> = {
    'sms': 'sms', '1': 'sms', 'phone': 'sms', 'type_phone': 'sms',
    'email': 'email', '2': 'email', 'type_email': 'email',
    'whatsapp': 'whatsapp', '3': 'whatsapp', 'type_whatsapp': 'whatsapp',
    'fb': 'facebook', 'facebook': 'facebook', '4': 'facebook', 'type_facebook': 'facebook',
    'ig': 'instagram', 'instagram': 'instagram', '5': 'instagram', 'type_instagram': 'instagram',
    'live_chat': 'live_chat', 'livechat': 'live_chat', '6': 'live_chat', 'type_live_chat': 'live_chat',
  };
  return mapping[typeStr] || typeStr;
}

/**
 * Which way a message went.
 *
 * The ladder is verbatim from the live cron, including its final
 * `return 'outbound'`. GHL sends `direction` as a word, as a number and as a
 * numeric string, sends `incoming` as a boolean on some channels, and sends
 * neither on others — where only `userId` distinguishes a staff reply. The
 * order matters: an explicit `direction` outranks an inferred `incoming`,
 * which outranks the presence of a `userId`.
 */
export function mapMessageDirection(
  msg: { direction?: unknown; incoming?: unknown; userId?: unknown },
): 'inbound' | 'outbound' {
  const dir = msg.direction;
  if (dir === 'inbound' || dir === 1 || dir === '1') return 'inbound';
  if (dir === 'outbound' || dir === 2 || dir === '2') return 'outbound';
  if (msg.incoming === true) return 'inbound';
  if (msg.incoming === false) return 'outbound';
  if (msg.userId) return 'outbound';
  return 'outbound';
}

/** `image` when the vendor's content type says so, else the column default. */
export function mapContentType(val: unknown): 'text' | 'image' {
  return String(val ?? '').includes('image') ? 'image' : 'text';
}

/**
 * A `ghl_conversations` row.
 *
 * EXACTLY these eleven keys and no others.
 *
 * `conversation_status` and `assigned_to` ARE written, because they are GHL's
 * own facts about the thread and nothing else in the product sets them — no
 * surface lets a person archive or assign a conversation locally, so a sync
 * cannot overwrite a human's decision. They were written by
 * `sync-ghl-conversations` and `one-time-bulk-conversation-sync` and NOT by
 * the cron, which is precisely the divergence one mapper exists to end: the
 * same thread's status depended on which path last touched it.
 *
 * `new_ghl_conversation_id` and `replayed_at` are deliberately absent. They are
 * the migration worker's account-to-account replay bookkeeping, and an import
 * that wrote them would erase a migration's state.
 *
 * `last_message_direction` takes the CRON's parenthesisation, because the other
 * copy's was wrong. `sync-ghl-conversations` wrote
 * `conv.lastMessageDirection || conv.lastMessageType === 1 ? 'inbound' : 'outbound'`,
 * and `||` binds looser than `===`, so the whole condition is
 * `(direction || (type === 1))` — any truthy `lastMessageDirection`, the string
 * `'outbound'` included, selected `'inbound'`. Every thread that path touched
 * recorded its last message as incoming.
 */
export function toConversationRow(
  conv: Record<string, unknown>,
  ctx: { clientId: string | null; ghlContactId: string; syncedAtIso: string },
): Record<string, unknown> {
  return {
    ghl_conversation_id: conv.id,
    client_id: ctx.clientId,
    ghl_contact_id: ctx.ghlContactId,
    channel_type: mapChannelType(conv.type),
    last_message_body: conv.lastMessageBody ?? conv.snippet ?? null,
    last_message_date: parseGhlDate(conv.lastMessageDate ?? conv.dateUpdated),
    last_message_direction:
      (conv.lastMessageDirection as string | undefined) ??
      (conv.lastMessageType === 1 ? 'inbound' : 'outbound'),
    unread_count: conv.unreadCount ?? 0,
    conversation_status: conv.starred ? 'starred' : (conv.deleted ? 'archived' : 'open'),
    assigned_to: (conv.assignedTo as string | undefined) ?? null,
    last_synced_at: ctx.syncedAtIso,
  };
}

/**
 * A `ghl_conversation_messages` row.
 *
 * EXACTLY these twelve keys. `new_ghl_message_id`, `replayed_at` and
 * `replay_skipped_reason` exist on the table and belong to the migration
 * worker; an import must not touch them.
 */
export function toMessageRow(
  msg: Record<string, unknown>,
  localConversationId: string,
): Record<string, unknown> {
  const attachments = Array.isArray(msg.attachments)
    ? (msg.attachments as Array<Record<string, unknown>>)
        .map((a) => a?.url)
        .filter(Boolean)
    : null;
  return {
    conversation_id: localConversationId,
    ghl_message_id: msg.id,
    direction: mapMessageDirection(msg as { direction?: unknown; incoming?: unknown; userId?: unknown }),
    channel_type: mapChannelType(msg.messageType ?? msg.source),
    body: msg.body ?? msg.message ?? msg.text ?? null,
    content_type: mapContentType(msg.contentType),
    attachment_urls: attachments && attachments.length > 0 ? attachments : null,
    sender_name: msg.contactName ?? msg.userName ?? null,
    sender_number: msg.from ?? msg.phone ?? null,
    recipient_number: msg.to ?? null,
    message_status: msg.status ?? 'sent',
    ghl_date_added: parseGhlDate(msg.dateAdded ?? msg.createdAt),
  };
}

/** The exact key sets, exported so a test can pin them against the tables. */
export const CONVERSATION_ROW_KEYS = [
  'ghl_conversation_id',
  'client_id',
  'ghl_contact_id',
  'channel_type',
  'last_message_body',
  'last_message_date',
  'last_message_direction',
  'unread_count',
  'conversation_status',
  'assigned_to',
  'last_synced_at',
] as const;

export const MESSAGE_ROW_KEYS = [
  'conversation_id',
  'ghl_message_id',
  'direction',
  'channel_type',
  'body',
  'content_type',
  'attachment_urls',
  'sender_name',
  'sender_number',
  'recipient_number',
  'message_status',
  'ghl_date_added',
] as const;
