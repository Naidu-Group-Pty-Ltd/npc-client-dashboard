import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPdfDecodeSlot } from '../../../supabase/functions/_shared/builderStock/pdfDecodeSlot.pure';

/**
 * One document decode at a time per isolate.
 *
 * The settler fans out on purpose — several invocations a minute, one claimed
 * property each — and the invocations share an isolate with one memory
 * ceiling. Five linked-package properties in flight meant five brochures'
 * decode buffers at once, and the worker died 546 with no error written,
 * every minute, until only those five properties were left and the queue
 * stopped moving entirely. The slot is what turns five concurrent decodes
 * into five consecutive ones.
 */
describe('withPdfDecodeSlot', () => {
  const gap = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  it('never lets two decodes overlap, whatever order they were queued in', async () => {
    const events: string[] = [];
    const work = (name: string) => async () => {
      events.push(`${name}:start`);
      await gap();
      events.push(`${name}:end`);
      return name;
    };
    const [a, b, c] = await Promise.all([
      withPdfDecodeSlot(work('a')),
      withPdfDecodeSlot(work('b')),
      withPdfDecodeSlot(work('c')),
    ]);
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a decode that fails releases the slot instead of wedging every later caller', async () => {
    const events: string[] = [];
    const failing = withPdfDecodeSlot(async () => {
      events.push('bad:start');
      await gap();
      throw new Error('damaged stream');
    });
    const following = withPdfDecodeSlot(async () => {
      events.push('good:start');
      return 'recovered';
    });
    await expect(failing).rejects.toThrow('damaged stream');
    await expect(following).resolves.toBe('recovered');
    expect(events).toEqual(['bad:start', 'good:start']);
  });

  it('hands each caller its own result, not the chain state', async () => {
    const first = withPdfDecodeSlot(async () => 1);
    const second = withPdfDecodeSlot(async () => 2);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
  });
});

/**
 * The wiring, asserted at the source — a behavioural overlap test would need
 * two real PDFs decoding concurrently inside one process, and what actually
 * regressed here twice was WIRING: a guard that existed and was not on the
 * path a reopen runs through.
 */
describe('every heavy document entry holds the slot, exactly once', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/pdfSourcePhoto.ts'),
    'utf8',
  );

  it('selectPdfPropertyPrimary enters through the slot', () => {
    const body = source.slice(source.indexOf('export async function selectPdfPropertyPrimary'));
    const upToDelegate = body.slice(0, body.indexOf('selectPdfPropertyPrimaryHoldingSlot'));
    expect(upToDelegate).toMatch(/withPdfDecodeSlot\(/);
  });

  it('discoverPdfSourceAssets enters through the slot', () => {
    const body = source.slice(source.indexOf('export async function discoverPdfSourceAssets'));
    const upToDelegate = body.slice(0, body.indexOf('discoverPdfSourceAssetsHoldingSlot'));
    expect(upToDelegate).toMatch(/withPdfDecodeSlot\(/);
  });

  it('the election reaches discovery WITHOUT retaking the slot, or it deadlocks', () => {
    const holding = source.slice(
      source.indexOf('async function selectPdfPropertyPrimaryHoldingSlot'),
      source.indexOf('export async function discoverPdfSourceAssets'),
    );
    // The internal call must go to the unwrapped body: a non-reentrant slot
    // taken twice by one caller waits on itself for ever.
    expect(holding).toMatch(/discoverPdfSourceAssetsHoldingSlot\(/);
    expect(holding).not.toMatch(/await discoverPdfSourceAssets\(/);
  });
});
