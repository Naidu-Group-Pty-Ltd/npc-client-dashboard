import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflate, pump } from '../../../supabase/functions/_shared/builderStock/rasterPng.ts';

/**
 * A damaged stream must reject the caller, not the isolate.
 *
 * Every inflate call site already catches — "a stream we cannot inflate
 * contributes nothing" — and none of those catches ever ran for Lot 58
 * Lumina Estate, whose 17.9 MB brochure carries one truncated object
 * stream: `pump` unwound out of its read loop before `await closed` ever
 * attached a handler, the orphaned rejection tore the isolate down with no
 * catchable throw and no error written, and four package-recovery claims
 * died silently in a row. The same document elects its cover in under five
 * seconds once the rejection is one a caller can catch.
 */
describe('a truncated deflate stream', () => {
  const good = deflateSync(Buffer.from('measured, not assumed. '.repeat(400)));
  const truncated = new Uint8Array(good.subarray(0, Math.floor(good.length / 2)));

  it('rejects inflate catchably, with no orphaned rejection left behind', async () => {
    let orphans = 0;
    const count = () => { orphans += 1; };
    process.on('unhandledRejection', count);
    try {
      await expect(inflate(truncated)).rejects.toBeTruthy();
      // An orphan surfaces on a later tick; give it room to appear.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(orphans).toBe(0);
    } finally {
      process.off('unhandledRejection', count);
    }
  });

  it('leaves healthy streams exactly as they were', async () => {
    const out = await inflate(new Uint8Array(good));
    expect(new TextDecoder().decode(out)).toContain('measured, not assumed.');
  });

  it('propagates a close failure on the success path', async () => {
    // A transform that reads to done but refuses the close: `await closed`
    // must still surface it, or a swallowed close error becomes silent
    // truncation on the WRITE side.
    const transform = {
      writable: new WritableStream<BufferSource>({
        write() {/* accepted */},
        close() { throw new Error('close refused'); },
      }),
      readable: new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }),
    };
    await expect(pump(transform, new Uint8Array([1, 2, 3]))).rejects.toThrow('close refused');
  });
});

describe('the orphan guard is wired where the unwind happens', () => {
  it('closed is marked handled before the read loop can throw past it', () => {
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/builderStock/rasterPng.ts'),
      'utf8',
    );
    const body = source.slice(
      source.indexOf('export async function pump'),
      source.indexOf('sha256Hex'),
    );
    const guardAt = body.indexOf('closed.catch(');
    const loopAt = body.indexOf('for (;;)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(loopAt);
  });
});
