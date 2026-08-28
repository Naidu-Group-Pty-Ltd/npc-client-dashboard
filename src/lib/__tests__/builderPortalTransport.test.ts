/**
 * BUILDER PORTAL — "FAILED TO FETCH" IS NOT A FINDING ABOUT THE SERVER.
 *
 * `fetch` rejects identically for an offline tab, a DNS failure, a CORS
 * refusal, and an edge worker killed mid-request on its resource limit. The
 * browser's message for all of them is "Failed to fetch", which says only that
 * THIS TAB got no answer.
 *
 * On 27 August 2026 that difference was the whole defect: a stock import was
 * killed after committing the upload and all 23 of its properties, the portal
 * announced "The stock list could not be imported / Failed to fetch", and the
 * builder imported the same list again. The wrapper now reports what is
 * actually known — the request did not answer, so the outcome is undetermined.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { invokeBuilderFunction } from '../builderPortal';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('a request that never answered', () => {
  it('is reported as undetermined, not as a failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never;

    const { data, error } = await invokeBuilderFunction('builder-portal-stock', {
      operation: 'import_url', url: 'https://example.test/list',
    });

    expect(data).toBeNull();
    expect(error?.code).toBe('transport_failed');
    // The browser's own words must not be what the builder reads, because they
    // assert something this code cannot know.
    expect(error?.message).not.toMatch(/failed to fetch/i);
    expect(error?.message).toMatch(/unknown/i);
  });

  it('separates a cancellation the caller asked for', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abort) as never;

    const { error } = await invokeBuilderFunction('builder-portal-stock', {});
    expect(error?.code).toBe('request_aborted');
  });
});

describe('a server that DID answer keeps its own words', () => {
  it('preserves the backend message and code verbatim', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'That Notion page is not publicly accessible.',
        code: 'notion_not_public' }),
    }) as never;

    const { error } = await invokeBuilderFunction('builder-portal-stock', {});

    // The server knows why; the wrapper must not overwrite it with a generic.
    expect(error?.code).toBe('notion_not_public');
    expect(error?.message).toBe('That Notion page is not publicly accessible.');
    expect(error?.status).toBe(400);
  });

  it('still reports an HTTP status when the body carries no message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 503, json: async () => null,
    }) as never;

    const { error } = await invokeBuilderFunction('builder-portal-stock', {});
    expect(error?.message).toBe('HTTP 503');
    expect(error?.status).toBe(503);
    // Not a transport failure: the server answered.
    expect(error?.code).toBeUndefined();
  });

  it('passes a success straight through', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, upload: { id: 'u1' } }),
    }) as never;

    const { data, error } = await invokeBuilderFunction<{ upload: { id: string } }>(
      'builder-portal-stock', {});
    expect(error).toBeNull();
    expect(data?.upload.id).toBe('u1');
  });
});
