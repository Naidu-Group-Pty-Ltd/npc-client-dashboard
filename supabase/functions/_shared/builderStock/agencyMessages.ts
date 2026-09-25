/**
 * The read behind a property page's conversation with its builder.
 *
 * The connection is the one `builder_network_post_message` would write over:
 * the builder's ACTIVE connection carrying `stock:publish`, newest first — so
 * the page reads exactly the conversation a send would write into. It is
 * open while this workspace holds a live activation of the property; a
 * withdrawn one leaves the history readable and the conversation closed.
 */
import {
  projectConversationMessages,
  type ConversationMessageView,
} from './agencyMessages.pure.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

/**
 * Why a conversation is closed, so the page names the next step rather than
 * guessing it: an activated property whose ROUTE is paused must not be told
 * to activate. Null while it is open.
 */
export type ConversationClosedReason = 'not_connected' | 'connection_paused' | 'not_activated' | 'delisted';

export type BuilderConversationRead =
  | {
    ok: true; conversation_id: string | null; open: boolean;
    closed_reason: ConversationClosedReason | null; messages: ConversationMessageView[];
  }
  | { ok: false };

export async function readBuilderConversation(
  supabase: Client,
  args: { stockItemId: string; organisationId: string; viewerUserId: string },
): Promise<BuilderConversationRead> {
  // The write route: the builder's active connection, whatever its grant.
  // It decides only whether a new message could be written now; history is
  // read from every conversation this property has held with this builder,
  // so a revoked connection, or one replaced by a new relationship, never
  // hides what was said.
  const { data: connection, error: connectionError } = await supabase
    .from('builder_network_connections')
    .select('id, scopes, identity_mismatch_since')
    .eq('builder_organisation_id', args.organisationId)
    .eq('state', 'active')
    .order('accepted_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (connectionError) return { ok: false };

  const [{ data: selection, error: selectionError }, { data: conversations, error: conversationError }] =
    await Promise.all([
      supabase.from('builder_stock_selections').select('id')
        .eq('stock_item_id', args.stockItemId).eq('organisation_id', args.organisationId)
        .neq('status', 'withdrawn').limit(1).maybeSingle(),
      supabase.from('builder_network_conversations').select('id, connection_id')
        .eq('stock_item_id', args.stockItemId).eq('builder_organisation_id', args.organisationId),
    ]);
  if (selectionError || conversationError) return { ok: false };

  const route = (connection ?? null) as { id: string; scopes?: string[] | null; identity_mismatch_since?: string | null } | null;
  const paused = !!route && (!(route.scopes ?? []).includes('stock:publish') || !!route.identity_mismatch_since);
  const open = !!route && !!selection && !paused;
  // No live activation outranks a paused route: restoring the route alone
  // would not open it, so the activation is the step to name.
  const closed_reason: ConversationClosedReason | null = open ? null
    : !route ? 'not_connected'
    : !selection ? 'not_activated' : 'connection_paused';

  const threads = ((conversations ?? []) as Array<{ id: string; connection_id: string }>);
  const current = route ? threads.find((c) => c.connection_id === route.id) ?? null : null;
  if (!threads.length) return { ok: true, conversation_id: null, open, closed_reason, messages: [] };

  // The window is the newest 500 by ARRIVAL here, drawn in the order the
  // messages were written. By arrival, not by time written: a message written
  // earlier that arrives late is among the newest arrivals, so it is drawn in
  // its place, and it leaves the window only once 500 newer ones have come,
  // exactly as every other message does.
  const { data: messages, error: messagesError } = await supabase
    .from('builder_network_messages')
    .select('id, conversation_id, side, sender_user_id, sender_display_name, body, sent_at, delivery_state, delivered_at, failure_reason')
    .in('conversation_id', threads.map((c) => c.id))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);
  if (messagesError) return { ok: false };

  const rows = (messages ?? []) as Record<string, unknown>[];
  const inCurrent = new Set(rows.filter((row) => current && row.conversation_id === current.id).map((row) => String(row.id)));
  return {
    ok: true,
    conversation_id: current ? String(current.id) : String(threads[0].id),
    open,
    closed_reason,
    // A message in an earlier relationship's thread cannot be sent again:
    // retrying writes over the route it was written on, which is gone.
    messages: projectConversationMessages(rows, args.viewerUserId)
      .map((message) => (inCurrent.has(message.id) ? message : { ...message, can_retry: false })),
  };
}
