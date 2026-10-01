/**
 * The Client Details export control: the choice beside the act.
 *
 * "Choose template" is a button of its own before "Export PDF", as on the
 * Intelligence Hub, the Portfolio Performance Review, the Borrowing Capacity
 * Snapshot and both comparisons (CLIENT_DETAILS.md §12). The button said
 * "Typeset details" and the template choice sat at the foot of the
 * destinations menu. The caret keeps the three destinations.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const deliverClientDetailsPdf = vi.fn();
vi.mock('@/lib/reports/clientDetails/deliverClientDetailsPdf', () => ({
  deliverClientDetailsPdf: (...a: unknown[]) => deliverClientDetailsPdf(...a),
}));

const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('sonner', () => ({ toast }));

const { ClientDetailsDownloadButton } = await import('../ClientDetailsDownloadButton');

beforeEach(() => {
  deliverClientDetailsPdf.mockReset().mockResolvedValue({
    blob: new Blob(['x']),
    fileName: 'Client Details - Ada Lovelace - 02 Aug 2026.pdf',
    brandGaps: [],
    pageCount: 4,
  });
  Object.values(toast).forEach((fn) => fn.mockClear());
});

const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ClientDetailsDownloadButton clientId="c-1" clientName="Ada Lovelace" onAttachToEmail={vi.fn()} />
    </QueryClientProvider>,
  );

/** Radix opens a dropdown on `pointerdown`; a real pointer fires both. */
const press = (el: Element) => {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(el);
};

describe('the choice beside the act', () => {
  it('draws Choose template beside Export PDF', () => {
    setup();
    expect(screen.getByRole('button', { name: /^choose template/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^export pdf$/i })).toBeTruthy();
    expect(screen.queryByText('Typeset details')).toBeNull();
  });

  it('exports and saves the file when Export PDF is pressed', async () => {
    setup();
    press(screen.getByRole('button', { name: /^export pdf$/i }));
    await waitFor(() => expect(deliverClientDetailsPdf).toHaveBeenCalledTimes(1));
    expect(deliverClientDetailsPdf.mock.calls[0]).toEqual(['c-1', { save: true }]);
  });

  it('keeps the three destinations in the caret, and no second chooser', async () => {
    setup();
    press(screen.getByRole('button', { name: /other destinations/i }));
    expect(await screen.findByText('Download')).toBeTruthy();
    expect(screen.getByText('Attach to an email')).toBeTruthy();
    expect(screen.getByText('Send to Finance')).toBeTruthy();
    expect(screen.queryByText('Which template this comes out in')).toBeNull();
  });
});
