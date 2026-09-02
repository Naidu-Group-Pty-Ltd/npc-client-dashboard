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
    const failure = new Error(message) as Error & { code?: string };
    failure.code = (data as { code?: string } | null)?.code;
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
 * it, from which upload and by which of their users are all resolved
 * server-side from the property's own row — the two-way link is a set of
 * foreign keys the browser never gets to choose.
 */
/**
 * Supply a picture for a property on the builder's behalf.
 *
 * The same act as the Builder Portal's, performed by NPC staff, through the
 * same three shared modules — so the two surfaces cannot come to disagree
 * about what a builder-supplied image is. The record says which of them
 * supplied it, because acting for somebody is a different act from acting for
 * yourself.
 *
 * WHY STAFF NEED IT. A blank card costs a sale today, and a builder who has
 * not answered an email is not a reason to keep showing nothing: staff
 * routinely hold the marketing pack before the builder gets round to
 * uploading it.
 *
 * It writes no pointer. The picture is stored with level 1 evidence — "this
 * is that property's picture", said directly — and the settler re-decides the
 * card from the roles, as it always has.
 */
export function useSupplyStockImageForBuilder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { stockItemId: string; file: File }) => {
      const created = await invoke<{ storage_path: string; upload_url: string }>({
        operation: 'create_builder_image_upload',
        stock_item_id: input.stockItemId,
        filename: input.file.name,
      });
      const put = await fetch(created.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': input.file.type || 'application/octet-stream' },
        body: input.file,
      });
      if (!put.ok) throw new Error('The image could not be uploaded. Please try again.');
      return await invoke<{ properties: number }>({
        operation: 'supply_builder_image',
        stock_item_id: input.stockItemId,
        storage_path: created.storage_path,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: marketplaceStockKeys.root() });
    },
  });
}

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
