import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  arrivalScrollTarget, conversationAccessLost, scrollLogToEnd, scrollMessageIntoView, useBuilderConversation, useRetryBuilderMessage, useSendBuilderMessage,
  type ConversationMessageView, type DeliveryState,
} from '@/lib/marketplaceBuilderStock';

/**
 * The conversation with a property's builder, on its page.
 *
 * Carried over the signed Builders Network (docs/builder-portal/51). The
 * thread is read every few seconds while the page is visible — polling is the
 * whole transport on this side — and is drawn in the order it was written,
 * with the actual sender on every message. What the Command Centre sent shows
 * whether the builder has it; a message that did not arrive stays visible and
 * its writer can send it again. Each message is written with one idempotency
 * key, reused if the same send is repeated, so a timeout never doubles it.
 *
 * Writing needs Listings edit and a live activation; the server decides both
 * and says so through `can_send` / `open`.
 */

const DELIVERY_LABELS: Record<DeliveryState, string> = {
  queued: 'Sending',
  delivered: 'Delivered',
  failed: 'Not delivered',
};

/**
 * `confirmation_timeout` is not a refusal: the message reached the builder and
 * no receipt came back in time, so the builder may well hold it. It is named
 * as unconfirmed, never as "not delivered".
 */
const deliveryLabel = (state: DeliveryState, failureReason: string | null) =>
  state === 'failed' && failureReason === 'confirmation_timeout' ? 'Not confirmed' : DELIVERY_LABELS[state];

const when = (iso: string) => new Date(iso).toLocaleString('en-AU');

/**
 * Keyed by the property, so a draft and its idempotency key belong to the
 * property they were written on: moving to another property's page (even
 * without a remount of the page) starts a clean composer, and text written for
 * one builder can never be sent to another.
 */
export function BuilderStockConversation(props: { stockItemId: string; builderName: string | null }) {
  return <ConversationForProperty key={props.stockItemId} {...props} />;
}

function ConversationForProperty({
  stockItemId, builderName,
}: {
  stockItemId: string;
  builderName: string | null;
}) {
  const { toast } = useToast();
  const query = useBuilderConversation(stockItemId);
  const send = useSendBuilderMessage(stockItemId);
  const retry = useRetryBuilderMessage(stockItemId);
  const [draft, setDraft] = useState('');
  const [clientMessageId, setClientMessageId] = useState(() => crypto.randomUUID());

  // A refusal withdraws what was read: history and composer are kept only
  // through failures that say nothing about who may read it.
  const accessLost = conversationAccessLost(query.error);
  const conversation = accessLost ? undefined : query.data;
  const messages = conversation?.messages ?? [];
  const who = builderName ?? 'the builder';
  // Open at the newest message, and follow it as polls bring more in.
  const logRef = useRef<HTMLDivElement>(null);
  // Follow whatever a poll brings in, even a late message that sorts above
  // the newest one. The card is keyed by property, so a new property starts
  // with nothing seen and opens at the end.
  const seenIdsRef = useRef<string[] | null>(null);
  const idsKey = messages.map((message) => message.id).join(',');
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    const target = arrivalScrollTarget(seenIdsRef.current, ids);
    seenIdsRef.current = ids;
    if (target === 'end') scrollLogToEnd(logRef.current);
    else if (target) scrollMessageIntoView(logRef.current, target);
  }, [idsKey]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    try {
      await send.mutateAsync({ clientMessageId, body });
      setDraft('');
      setClientMessageId(crypto.randomUUID());
    } catch (error) {
      toast({
        title: 'Your message was not sent',
        description: error instanceof Error ? error.message : 'Try again shortly.',
        variant: 'destructive',
      });
    }
  };

  const sendAgain = async (messageId: string) => {
    try {
      await retry.mutateAsync(messageId);
    } catch (error) {
      toast({
        title: 'That message could not be sent again',
        description: error instanceof Error ? error.message : 'Try again shortly.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Messages with {who}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* A poll that fails after the thread was read keeps what was read:
            the history is still true, it may just be behind. */}
        {accessLost ? (
          <p className="text-sm text-muted-foreground">
            This conversation is no longer available to you.
          </p>
        ) : null}

        {query.error && conversation ? (
          <p role="status" className="text-sm text-muted-foreground">
            The conversation could not be refreshed just now, so newer messages may be missing. It will try again shortly.
          </p>
        ) : null}

        {query.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the conversation…
          </p>
        ) : query.error && !conversation && !accessLost ? (
          <p className="text-sm text-muted-foreground">
            The conversation could not be loaded just now. It will try again shortly.
          </p>
        ) : messages.length ? (
          <div ref={logRef} role="log" aria-label={`Messages with ${who}`} aria-live="polite" className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            {messages.map((message) => (
              <Message key={message.id} message={message} canRetry={!!conversation?.can_send && message.can_retry} onRetry={sendAgain} retrying={retry.isPending} />
            ))}
          </div>
        ) : conversation?.open ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {conversation.can_send
              ? `No messages yet. Anything you write here goes to ${who} about this property.`
              : 'No messages yet. You can read this conversation but cannot write to it here.'}
          </p>
        ) : null}

        {conversation && !conversation.open ? (
          <p className="text-sm text-muted-foreground">{closedCopy(conversation.closed_reason, who, messages.length > 0)}</p>
        ) : null}

        {conversation?.can_send ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Message"
              placeholder={`Write to ${who}`}
              value={draft}
              maxLength={4000}
              onChange={(event) => {
                // Different text is a different message: the key a failed send
                // is repeated under belongs to the text it was sent with.
                setDraft(event.target.value);
                setClientMessageId(crypto.randomUUID());
              }}
              disabled={send.isPending}
              rows={3}
            />
            <div className="flex justify-end">
              <Button type="button" onClick={() => void submit()} disabled={send.isPending || !draft.trim()}>
                {send.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  : <Send className="mr-2 h-4 w-4" aria-hidden />}
                Send
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Message({
  message, canRetry, onRetry, retrying,
}: {
  message: ConversationMessageView;
  /** The message's own retry flag AND whether this reader may write here now. */
  canRetry: boolean;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  const ours = message.side === 'command_centre';
  return (
    <article
      data-message-id={message.id}
      className={cn(
        'max-w-[85%] rounded-lg border px-3 py-2 text-sm',
        ours ? 'ml-auto border-primary/30 bg-primary/5' : 'mr-auto border-border bg-card',
      )}
    >
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{message.sender_display_name}</span>
        {' · '}{ours ? 'Your team' : 'Builder'}{' · '}{when(message.sent_at)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{message.body}</p>
      {message.delivery_state ? (
        <p className={cn('mt-1 flex items-center gap-2 text-xs',
          message.delivery_state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          <span>{deliveryLabel(message.delivery_state, message.failure_reason)}</span>
          {canRetry ? (
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs"
              onClick={() => onRetry(message.id)} disabled={retrying}>
              Send again
            </Button>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/** Names why a conversation is closed and what happens next — never a step that would not open it. */
function closedCopy(reason: string | null | undefined, who: string, hasHistory: boolean): string {
  switch (reason) {
    case 'connection_paused':
      return `Messages with ${who} are paused while the connection is checked. Nothing already written is lost: queued messages go out once it is restored.`;
    case 'not_connected':
      return `${who} is not connected to this workspace, so messages cannot be sent.`;
    case 'delisted':
      return `${who} no longer lists this property, so the conversation is closed. Its history stays.`;
    default:
      return hasHistory
        ? 'This property is no longer activated here, so the conversation is closed. Its history stays.'
        : `Activate this property to message ${who} about it.`;
  }
}
