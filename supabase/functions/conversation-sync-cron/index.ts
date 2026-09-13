// Pinned to the version `_shared/ghl-rate-limiter.ts` declares. A floating
// `@2` resolves to a different SupabaseClient type and the limiter's first
// parameter stops matching.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { getEffectiveGhlCredentials } from '../_shared/ghl-account.ts';
import { insertTargetedNotification } from '../_shared/notify.ts';
import { internalError } from '../_shared/errorResponse.ts';
import { ghlFetchShared, tokenKeyFor } from '../_shared/ghl-rate-limiter.ts';
import { mapWithConcurrency } from '../_shared/boundedConcurrency.pure.ts';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

/*
 * THE THIRD CONVERSATION SYNC, AND THE ONE THAT ACTUALLY RUNS.
 *
 * `sync-ghl-conversations` and `ghl-conversations-cron` were unpaced and are
 * not; this one runs every ten minutes and was still sleeping its way
 * through the work. Measured on the prime, 13 Sep 2026, five consecutive runs: 56
 * contacts in 136s, 134s, 109s, 125s, 134s — against a wall clock it shares
 * with nothing. `delay(500)` per contact is 28 seconds of the first number
 * before a single request is made, and `delay(300)` per conversation adds
 * more.
 *
 * A fixed sleep is wrong twice over. It is far slower than the vendor allows
 * when nothing else is calling, and it is not a limit at all when something
 * is: two invocations that overlap each sleep 500ms and together issue four
 * requests a second. `ghlFetchShared` reserves a slot in a Postgres token
 * bucket instead, so the pacing is real, shared across isolates, and reads
 * GHL's own `Retry-After` on a 429.
 */
const CONTACT_CONCURRENCY = 6;
// Against the ~150s an Edge Function gets, leaving room for the notification
// work and the final write.
const BUDGET_MS = 110_000;

Deno.serve(async (req) => {
  // This function is called by pg_cron — no auth needed
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
    'Access-Control-Expose-Headers': 'x-correlation-id, x-tokens-used, x-tokens-reserved, x-tokens-estimated, x-duration-ms',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      console.error('[conversation-sync-cron] Missing supabase configuration');
      return new Response(JSON.stringify({ error: 'Missing configuration' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const _ghlCreds = await getEffectiveGhlCredentials(supabase);
    const apiKey = _ghlCreds.apiKey;
    const locationId = _ghlCreds.locationId;
    console.log(`[conversation-sync-cron] Using GHL account: ${_ghlCreds.label}`);

    if (!apiKey || !locationId) {
      console.error('[conversation-sync-cron] Missing GHL configuration');
      return new Response(JSON.stringify({ error: 'Missing GHL configuration' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ghlHeaders = {
      'Authorization': `Bearer ${apiKey}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
    };

    // Get conversations updated in last 30 minutes (stale window)
    // Fetch ALL clients with GHL contact IDs but only sync recent ones
    const { data: recentConvos } = await supabase
      .from('ghl_conversations')
      .select('id, ghl_conversation_id, ghl_contact_id, client_id, last_synced_at')
      .order('last_message_date', { ascending: false })
      .limit(50);

    // Also get clients who might have NEW conversations not yet in DB
    const { data: clients } = await supabase
      .from('clients')
      .select('id, ghl_contact_id')
      .not('ghl_contact_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(30);

    const contactsToSync = new Map<string, string | null>();

    // Add recent conversation contacts
    for (const conv of (recentConvos || [])) {
      if (conv.ghl_contact_id && !contactsToSync.has(conv.ghl_contact_id)) {
        contactsToSync.set(conv.ghl_contact_id, conv.client_id);
      }
    }

    // Add recent clients
    for (const client of (clients || [])) {
      if (client.ghl_contact_id && !contactsToSync.has(client.ghl_contact_id)) {
        contactsToSync.set(client.ghl_contact_id, client.id);
      }
    }

    console.log(`[conversation-sync-cron] Syncing ${contactsToSync.size} contacts`);

    let totalMessages = 0;
    let totalConversations = 0;

    const startedAt = Date.now();
    // Keyed on the ACCOUNT LABEL, not on a hardcoded name: two GHL accounts
    // are two buckets, and sharing one key between them would pace a token
    // against another token's traffic.
    const tokenKey = tokenKeyFor(_ghlCreds.label, apiKey);

    const outcome = await mapWithConcurrency(
      [...contactsToSync],
      CONTACT_CONCURRENCY,
      async ([ghlContactId, clientId]) => {
      try {
        const searchParams = new URLSearchParams({
          locationId,
          contactId: ghlContactId,
        });

        const convRes = await ghlFetchShared(
          supabase,
          tokenKey,
          `${GHL_API_BASE}/conversations/search?${searchParams}`,
          { method: 'GET', headers: ghlHeaders },
          { logTag: 'conversation-sync-cron' },
        );

        if (!convRes.ok) {
          console.warn(`[conversation-sync-cron] Search failed for ${ghlContactId}: ${convRes.status}`);
          return;
        }

        const convData = await convRes.json();
        const conversations = convData.conversations || [];

        for (const conv of conversations) {
          const ghlConvId = conv.id;
          const channelType = mapChannelType(conv.type);

          const { data: upsertedConv, error: convError } = await supabase
            .from('ghl_conversations')
            .upsert({
              ghl_conversation_id: ghlConvId,
              client_id: clientId,
              ghl_contact_id: ghlContactId,
              channel_type: channelType,
              last_message_body: conv.lastMessageBody || conv.snippet || null,
              last_message_date: parseGhlDate(conv.lastMessageDate || conv.dateUpdated),
              last_message_direction: conv.lastMessageDirection || (conv.lastMessageType === 1 ? 'inbound' : 'outbound'),
              unread_count: conv.unreadCount || 0,
              last_synced_at: new Date().toISOString(),
            }, { onConflict: 'ghl_conversation_id' })
            .select('id')
            .single();

          if (convError) {
            console.error(`[conversation-sync-cron] Conv upsert failed:`, convError.message);
            continue;
          }

          totalConversations++;

          // Fetch only latest messages (1 page). No sleep: the next slot is
          // reserved from the shared bucket, which is a real limit rather
          // than a guess about how busy the rest of the fleet is.
          const msgRes = await ghlFetchShared(
            supabase,
            tokenKey,
            `${GHL_API_BASE}/conversations/${ghlConvId}/messages?limit=20`,
            { method: 'GET', headers: ghlHeaders },
            { logTag: 'conversation-sync-cron' },
          );

          if (!msgRes.ok) continue;

          const msgData = await msgRes.json();
          let messages: any[] = [];
          if (msgData.messages?.messages && Array.isArray(msgData.messages.messages)) {
            messages = msgData.messages.messages;
          } else if (Array.isArray(msgData.messages)) {
            messages = msgData.messages;
          }

          if (messages.length > 0) {
            const messageRows = messages.map((msg: any) => ({
              conversation_id: upsertedConv.id,
              ghl_message_id: msg.id,
              direction: (() => {
                const dir = msg.direction;
                if (dir === 'inbound' || dir === 1 || dir === '1') return 'inbound';
                if (dir === 'outbound' || dir === 2 || dir === '2') return 'outbound';
                if (msg.incoming === true) return 'inbound';
                if (msg.incoming === false) return 'outbound';
                if (msg.userId) return 'outbound';
                return 'outbound';
              })(),
              channel_type: mapChannelType(msg.messageType || msg.source),
              body: msg.body || msg.message || msg.text || null,
              content_type: (msg.contentType || '').includes('image') ? 'image' : 'text',
              attachment_urls: msg.attachments?.map((a: any) => a.url).filter(Boolean) || null,
              sender_name: msg.contactName || msg.userName || null,
              sender_number: msg.from || msg.phone || null,
              recipient_number: msg.to || null,
              message_status: msg.status || 'sent',
              ghl_date_added: parseGhlDate(msg.dateAdded || msg.createdAt),
            }));

            const { error: insertError } = await supabase
              .from('ghl_conversation_messages')
              .upsert(messageRows, { onConflict: 'ghl_message_id', ignoreDuplicates: false });

            if (insertError && insertError.code !== '23505') {
              console.error(`[conversation-sync-cron] Messages upsert error:`, insertError.message);
            }

            totalMessages += messages.length;

            // Check for new inbound messages that need notifications
            const latestInbound = messages.filter((m: any) => {
              const dir = m.direction;
              return dir === 'inbound' || dir === 1 || dir === '1' || m.incoming === true;
            });

            for (const msg of latestInbound) {
              // Only create notification if message is recent (last 30 min)
              const msgDate = new Date(msg.dateAdded || msg.createdAt);
              const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
              if (msgDate > thirtyMinAgo) {
                // Check if notification already exists for this message
                const { data: existing } = await supabase
                  .from('notifications')
                  .select('id')
                  .eq('type', 'conversation_reply')
                  .eq('entity_id', clientId || upsertedConv.id)
                  .gte('created_at', thirtyMinAgo.toISOString())
                  .limit(1);

                if (!existing || existing.length === 0) {
                  let clientName = msg.contactName || 'Unknown Contact';
                  if (clientId) {
                    const { data: clientRow } = await supabase
                      .from('clients')
                      .select('primary_first_name, primary_surname')
                      .eq('id', clientId)
                      .maybeSingle();
                    if (clientRow) {
                      clientName = [clientRow.primary_first_name, clientRow.primary_surname].filter(Boolean).join(' ') || clientName;
                    }
                  }

                  const preview = (msg.body || msg.message || '(Attachment)').substring(0, 100);
                  const channelLabel = channelType.toUpperCase();

                  await insertTargetedNotification(supabase, {
                    moduleKey: 'conversations',
                    notification: {
                      type: 'conversation_reply',
                      title: `New ${channelLabel} from ${clientName}`,
                      message: preview,
                      entity_id: clientId || upsertedConv.id,
                    },
                  });

                  console.log(`[conversation-sync-cron] 📬 Notification for inbound from ${clientName}`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`[conversation-sync-cron] Error for contact ${ghlContactId}:`, err);
      }
      },
      // Stop STARTING contacts at the budget; whatever is already in flight
      // finishes and is kept. The set is re-derived from the database on the
      // next tick, so a contact this run did not reach is simply picked up
      // then — there is no cursor to leave stale.
      { stop: () => Date.now() - startedAt > BUDGET_MS },
    );

    if (outcome.startedCount < contactsToSync.size) {
      console.log(
        `[conversation-sync-cron] budget reached — ${outcome.startedCount} of ` +
          `${contactsToSync.size} contacts this tick, the rest resume next run`,
      );
    }

    console.log(`[conversation-sync-cron] ✅ Complete: ${totalConversations} convos, ${totalMessages} messages`);

    return new Response(JSON.stringify({
      success: true,
      conversations_synced: totalConversations,
      messages_synced: totalMessages,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[conversation-sync-cron] Error:', error);
    return new Response(JSON.stringify(internalError(error, 'conversation-sync-cron')), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function parseGhlDate(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'number' || /^\d{10,13}$/.test(String(val))) {
    const num = Number(val);
    const ms = num > 1e12 ? num : num * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function mapChannelType(ghlType: string | number | undefined): string {
  if (!ghlType) return 'sms';
  const typeStr = String(ghlType).toLowerCase();
  const mapping: Record<string, string> = {
    'sms': 'sms', '1': 'sms', 'phone': 'sms', 'type_phone': 'sms',
    'email': 'email', '2': 'email', 'type_email': 'email',
    'whatsapp': 'whatsapp', '3': 'whatsapp', 'type_whatsapp': 'whatsapp',
    'fb': 'facebook', 'facebook': 'facebook', '4': 'facebook',
    'ig': 'instagram', 'instagram': 'instagram', '5': 'instagram',
    'live_chat': 'live_chat', 'livechat': 'live_chat', '6': 'live_chat',
  };
  return mapping[typeStr] || typeStr;
}
