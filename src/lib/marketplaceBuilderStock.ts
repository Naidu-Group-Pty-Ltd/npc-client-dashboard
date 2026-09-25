/**
 * Command Centre — Builder Stock query layer for the Property Marketplace.
 *
 * Every call goes through `invokeSecureFunction`, which carries the internal
 * HttpOnly session cookie and the CSRF-safe carriers the rest of the dashboard
 * uses. Nothing here reads `builder_stock_*` directly: those tables have no
 * `authenticated` policy, on purpose — the module permission and the feature
 * flag are both enforced inside the edge function, and a direct client read
 * would bypass both.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import type { BuilderStockItem, BuilderStockSelection } from '@/lib/builderStock';
import type { MirrorSource } from '../../supabase/functions/_shared/builderStock/mirrorAvailability.pure';
import type { PropertyDetail } from '../../supabase/functions/_shared/builderStock/propertyDetail.pure';
import type { ConversationMessageView } from '../../supabase/functions/_shared/builderStock/agencyMessages.pure';

export const marketplaceStockKeys = {
  root: () => ['marketplace', 'builder-stock'] as const,
  items: (filters: MarketplaceStockFilters) =>
    ['marketplace', 'builder-stock', 'items', filters] as const,
  builders: () => ['marketplace', 'builder-stock', 'builders'] as const,
  selections: (clientId: string) =>
    ['marketplace', 'builder-stock', 'selections', clientId] as const,
  clientSearch: (search: string) =>
    ['marketplace', 'builder-stock', 'client-search', search] as const,
};

export interface MarketplaceStockFilters {
  search: string;
  organisationId: string;
  availability: string;
  state: string;
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  records: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  /**
   * What the workspace can say about the Builders Network link this mirror is
   * fed by. Absent on a deployment running ahead of the function, which
   * `readStockEmptyState` reads as `unknown` rather than as "no link".
   */
  source?: MirrorSource;
  /** Organisations holding a disclosed commercial placement on this result set. */
  promoted_organisations?: string[];
  /**
   * Whether this page is ordered by merit.
   *
   * `false` means the ranking migration has not reached this deployment, so
   * the list is real and its ORDER carries no information. Absent means a
   * deployment running ahead of the function, which the surface reads as
   * "say nothing" rather than as unranked.
   */
  ranked?: boolean;
}

export interface MarketplaceBuilder {
  id: string;
  legal_name: string;
  trading_name: string | null;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await invokeSecureFunction<T>('builder-stock-marketplace', body);
  const message = error?.message || (data as { error?: string } | null)?.error;
  if (message) {
    const failure = new Error(message) as Error & { code?: string; status?: number };
    failure.code = (data as { code?: string } | null)?.code ?? error?.code;
    failure.status = error?.status;
    throw failure;
  }
  return data as T;
}

export function useMarketplaceBuilderStock(
  filters: MarketplaceStockFilters,
  enabled: boolean,
) {
  return useQuery({
    queryKey: marketplaceStockKeys.items(filters),
    enabled,
    queryFn: () => invoke<Paginated<BuilderStockItem>>({
      operation: 'list_stock',
      search: filters.search,
      organisation_id: filters.organisationId,
      availability_status: filters.availability,
      state: filters.state,
      page: filters.page,
      page_size: filters.pageSize,
    }),
  });
}

export function useMarketplaceBuilders(enabled: boolean) {
  return useQuery({
    queryKey: marketplaceStockKeys.builders(),
    enabled,
    queryFn: () => invoke<{ records: MarketplaceBuilder[] }>({ operation: 'list_builders' }),
  });
}

export interface MarketplaceClientOption {
  id: string;
  primary_first_name: string;
  primary_surname: string;
  primary_email: string | null;
}

export function useMarketplaceClientSearch(search: string, enabled: boolean) {
  return useQuery({
    queryKey: marketplaceStockKeys.clientSearch(search),
    enabled,
    queryFn: () => invoke<{ records: MarketplaceClientOption[] }>({
      operation: 'search_clients', search,
    }),
  });
}

export function useMarketplaceStockSelections(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: marketplaceStockKeys.selections(clientId),
    enabled,
    queryFn: () => invoke<Paginated<BuilderStockSelection>>({
      operation: 'list_selections', client_id: clientId, page: 1, page_size: 50,
    }),
  });
}

/**
 * Select a builder property for a client.
 *
 * The request names only the property and the client. Which builder supplied
 * it and by which of their users are resolved server-side from the property's
 * own mirror row — the two-way link is a set of foreign keys the browser
 * never gets to choose.
 *
 * Supplying a picture on the builder's behalf used to live beside this and is
 * gone with the portal's image pipeline (network extraction Phase 7): imagery
 * is managed on the Builders Network, and the marketplace serves what the
 * network delivers.
 */
export function useSelectBuilderStockForClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { stockItemId: string; clientId: string; notes?: string }) =>
      invoke<{ record: BuilderStockSelection; already_selected?: boolean }>({
        operation: 'select_for_client',
        stock_item_id: input.stockItemId,
        client_id: input.clientId,
        notes: input.notes,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceStockKeys.root() });
    },
  });
}

export function useSetStockSelectionStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { selectionId: string; status: string }) =>
      invoke<{ record: BuilderStockSelection }>({
        operation: 'set_selection_status',
        selection_id: input.selectionId,
        status: input.status,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceStockKeys.root() });
    },
  });
}

/** A short-lived signed URL for one stored builder-stock image. */
export async function marketplaceStockImageUrl(imageId: string): Promise<string | null> {
  try {
    const result = await invoke<{ url?: string }>({ operation: 'image_url', image_id: imageId });
    return result.url ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// One property — the page a card, a map pin or a link opens.
// ---------------------------------------------------------------------------

export type {
  PropertyActivation as MarketplaceStockActivation,
  PropertyDocument as MarketplaceStockDocument,
  PropertyPhoto as MarketplaceStockPhoto,
} from '../../supabase/functions/_shared/builderStock/propertyDetail.pure';

/**
 * What `get_stock_item` answers: the card's own record, plus the property's
 * photographs and documents as the Builders Network published them, and its
 * activation record. `clients_visible` is false when the server withheld
 * client names from this reader.
 */
export interface MarketplaceStockDetail extends PropertyDetail {
  record: BuilderStockItem;
}

/** The address a builder property is opened at. One spelling, used everywhere. */
export function builderStockPropertyPath(stockItemId: string): string {
  return `/listings/builder-stock/${encodeURIComponent(stockItemId)}`;
}

export function useMarketplaceStockItem(stockItemId: string, enabled = true) {
  return useQuery({
    queryKey: [...marketplaceStockKeys.root(), 'item', stockItemId] as const,
    enabled: enabled && !!stockItemId,
    // A property that is not there is an answer, not a transient fault.
    retry: (count, error) => !/not found/i.test((error as Error)?.message ?? '') && count < 2,
    queryFn: () => invoke<MarketplaceStockDetail & { success?: boolean }>({
      operation: 'get_stock_item', stock_item_id: stockItemId,
    }),
  });
}

// ---------------------------------------------------------------------------
// The builder conversation on a property page.
// ---------------------------------------------------------------------------

export type { ConversationMessageView, DeliveryState } from '../../supabase/functions/_shared/builderStock/agencyMessages.pure';

export interface BuilderConversation {
  conversation_id: string | null;
  /** False where this workspace holds no live activation of the property. */
  open: boolean;
  /** Why it is closed, so the page names the right next step. Absent from an older function. */
  closed_reason?: 'not_connected' | 'connection_paused' | 'not_activated' | 'delisted' | null;
  can_send: boolean;
  messages: ConversationMessageView[];
}

/** How often an open conversation re-reads itself. Polling is the transport's floor. */
export const BUILDER_CONVERSATION_POLL_MS = 10_000;

/**
 * A closed conversation is checked only this often: rarely enough to cost
 * nothing, often enough that an activation made elsewhere (another user,
 * another tab) reopens it without a reload.
 */
export const BUILDER_CONVERSATION_CLOSED_POLL_MS = 60_000;

/**
 * An open conversation is re-read every few seconds; a closed one only once a
 * minute. Activating from this page also invalidates the query, so it reopens
 * at once there.
 */
export function builderConversationPollInterval(data: { open?: boolean } | undefined): number {
  return data?.open === false ? BUILDER_CONVERSATION_CLOSED_POLL_MS : BUILDER_CONVERSATION_POLL_MS;
}

const conversationKey = (stockItemId: string) =>
  [...marketplaceStockKeys.root(), 'conversation', stockItemId] as const;

/**
 * A refusal says the reader may no longer see this conversation: signed out,
 * Listings access withdrawn, or the feature switched off. Unlike a transient
 * failure, what was read before must not stay on screen after it.
 */
export function conversationAccessLost(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code } = error as { status?: number; code?: string };
  return status === 401 || status === 403 || code === 'builder_stock_disabled';
}

/**
 * A refusal is not retried: the query error is set only once retries are
 * spent, and until then the card would keep showing what the reader may no
 * longer see. Anything else is retried once, as every query in the app is.
 */
export function retryUnlessAccessLost(failureCount: number, error: unknown): boolean {
  return !conversationAccessLost(error) && failureCount < 1;
}

/**
 * The poll stops once a read is refused: every later poll would be refused
 * too, and each 403 counts towards the client's authentication breaker, so a
 * few of them could clear an otherwise valid session. Remounting the page
 * reads again.
 */
export function conversationRefetchInterval(state: { data?: { open?: boolean }; error?: unknown }): number | false {
  return conversationAccessLost(state.error) ? false : builderConversationPollInterval(state.data);
}

export function useBuilderConversation(stockItemId: string, enabled = true) {
  return useQuery({
    queryKey: conversationKey(stockItemId),
    enabled: enabled && !!stockItemId,
    queryFn: () => invoke<BuilderConversation>({
      operation: 'get_builder_conversation', stock_item_id: stockItemId,
    }),
    refetchInterval: (query) => conversationRefetchInterval(query.state),
    refetchIntervalInBackground: false,
    retry: retryUnlessAccessLost,
  });
}

/**
 * Send one message. The caller mints `clientMessageId` once per message and
 * reuses it for any repeat of the same send, so a timeout is safe to retry.
 */
export function useSendBuilderMessage(stockItemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientMessageId: string; body: string }) => invoke<{ message: ConversationMessageView | null }>({
      operation: 'send_builder_message', stock_item_id: stockItemId,
      client_message_id: input.clientMessageId, body: input.body,
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: conversationKey(stockItemId) }),
  });
}

export function useRetryBuilderMessage(stockItemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => invoke<{ message: ConversationMessageView | null }>({
      operation: 'retry_builder_message', message_id: messageId,
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: conversationKey(stockItemId) }),
  });
}

/**
 * Keeps a conversation log on its newest message: a thread longer than its
 * box opens at the end, and a message a poll brings in is not left below the
 * visible area.
 */
export function scrollLogToEnd(log: { scrollTop: number; scrollHeight: number } | null | undefined): void {
  if (log) log.scrollTop = log.scrollHeight;
}

/**
 * Where the log should move after a read. `null` before any read, or on a new
 * thread, opens at the end. A new last message follows the end. A message the
 * poll sorted ABOVE the newest one (it was written earlier and arrived late)
 * is brought into view itself, because following the end would leave it out
 * of sight with nothing saying it came. Otherwise the log stays where the
 * reader put it.
 */
export function arrivalScrollTarget(previousIds: readonly string[] | null, ids: readonly string[]): 'end' | string | null {
  if (previousIds === null) return 'end';
  const seen = new Set(previousIds);
  const arrived = ids.filter((id) => !seen.has(id));
  if (!arrived.length) return null;
  // A message that sorts above the newest one already seen is a late arrival,
  // and it wins even when the same poll also brought a new last message:
  // following the end would leave it above the reader, unseen.
  let lastSeenIndex = -1;
  ids.forEach((id, index) => { if (seen.has(id)) lastSeenIndex = index; });
  const late = arrived.find((id) => ids.indexOf(id) < lastSeenIndex);
  return late ?? 'end';
}

/** Brings one message of a log into view, by the id it is drawn with. */
export function scrollMessageIntoView(log: HTMLElement | null | undefined, messageId: string): void {
  const node = log?.querySelector?.(`[data-message-id="${CSS.escape(messageId)}"]`);
  node?.scrollIntoView?.({ block: 'nearest' });
}
