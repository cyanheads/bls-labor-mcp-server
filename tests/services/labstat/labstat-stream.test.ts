/**
 * @fileoverview The streamed LABSTAT read (#126) at its own seam: the header
 * deadline, the per-chunk stall deadline and the absence of a whole-body one,
 * the decode across chunk boundaries (CRLF, multi-byte characters, BOM), and
 * the line regrouping that reports a body cut short. The catalog and ingester
 * suites prove each caller's wiring.
 * @module tests/services/labstat/labstat-stream.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lineBatches,
  type OpenResponse,
  openUrl,
  readBody,
} from '@/services/labstat/labstat-stream.js';

const URL_ = 'https://download.bls.gov/pub/time.series/cu/cu.series';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function* from(...chunks: string[]): AsyncGenerator<string> {
  yield* chunks;
}

/** Every batch `lineBatches` yields, and what it returns. */
async function collect(
  chunks: AsyncIterable<string>,
): Promise<{ batches: string[][]; tail: string }> {
  const lines = lineBatches(chunks);
  const batches: string[][] = [];
  for (let next = await lines.next(); ; next = await lines.next()) {
    if (next.done) return { batches, tail: next.value };
    batches.push(next.value);
  }
}

/**
 * A body delivered one chunk per read, never ahead of one (`highWaterMark: 0`).
 * Each chunk lands `delayMs` after the read that asked for it, when set. After
 * `chunks` it ends, or with `stall` waits until the request aborts. An abort
 * errors the body, as it does a fetched one.
 */
function pulledBody(
  chunks: Uint8Array[],
  opts: { delayMs?: number; stall?: boolean } = {},
): { open: OpenResponse; pulls: () => number } {
  let pulls = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull(c) {
        const chunk = chunks[pulls++];
        if (chunk && opts.delayMs === undefined) return c.enqueue(chunk);
        if (chunk) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              c.enqueue(chunk);
              resolve();
            }, opts.delayMs);
          });
        }
        if (!opts.stall) return c.close();
        return new Promise<void>(() => {}); // until `abort` errors the stream
      },
    },
    { highWaterMark: 0 },
  );
  return {
    open: { abort: (reason) => controller.error(reason), response: new Response(body) },
    pulls: () => pulls,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('lineBatches', () => {
  it('yields each chunk’s complete lines and returns an empty tail for text ending in a line break', async () => {
    const { batches, tail } = await collect(from('a\tb\r\nc', '\td\r\n', 'e\r\nf\r\n'));
    expect(batches).toEqual([['a\tb\r'], ['c\td\r'], ['e\r', 'f\r']]);
    expect(tail).toBe('');
  });

  it('returns the unterminated last line instead of yielding it', async () => {
    const { batches, tail } = await collect(from('a\r\n', 'WPU0', '1'));
    expect(batches).toEqual([['a\r']]);
    expect(tail).toBe('WPU01');
  });

  it('joins a line spread across chunks that hold no line break', async () => {
    const { batches, tail } = await collect(from('ab', 'cd', 'e\nf', 'g\n'));
    expect(batches).toEqual([['abcde'], ['fg']]);
    expect(tail).toBe('');
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect(from())).toEqual({ batches: [], tail: '' });
  });
});

describe('readBody', () => {
  it('decodes a CRLF and a multi-byte character split across chunks, dropping a leading BOM', async () => {
    const all = bytes('﻿series_id\titem_name\r\nCUUR0000SA0\tAño\r\n');
    const cr = all.indexOf(0x0d);
    const n = all.indexOf(0xc3); // the first byte of "ñ"
    const { open } = pulledBody([all.slice(0, cr + 1), all.slice(cr + 1, n + 1), all.slice(n + 1)]);
    expect(await collect(readBody(open))).toEqual({
      batches: [['series_id\titem_name\r'], ['CUUR0000SA0\tAño\r']],
      tail: '',
    });
  });

  it('reads a body for as long as it keeps arriving, with no whole-body deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const chunks = Array.from({ length: 6 }, (_, i) => `row ${i}\n`);
    // Each chunk lands 50 s after the read that asked for it: 300 s in all.
    const { open } = pulledBody(chunks.map(bytes), { delayMs: 50_000 });
    const read = collect(readBody(open));
    await vi.advanceTimersByTimeAsync(chunks.length * 50_000);
    const { batches, tail } = await read;
    expect(batches.flat()).toEqual(chunks.map((c) => c.trimEnd()));
    expect(tail).toBe('');
  });

  it('errors a read that waits past the stall deadline, after consuming what arrived', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { open, pulls } = pulledBody([bytes('series_id\r\nWPU0111\r\n')], { stall: true });
    const read = collect(readBody(open)).then(
      () => 'completed',
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(pulls()).toBe(2); // the first chunk was read; the second read is waiting
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toMatchObject({ name: 'TimeoutError', message: 'No data for 60000 ms' });
  });

  it('cancels the rest of the body when the consumer stops early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          c.enqueue(bytes('header\nrow\n'));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    for await (const _ of lineBatches(readBody({ abort: () => {}, response: new Response(body) })))
      break;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('openUrl', () => {
  it('sends the User-Agent and opens a 200 response with its body unread', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('series_id\n', { status: 200 }));
    const result = await openUrl(URL_, 'ua/1.0', new AbortController().signal);
    expect(result.kind).toBe('opened');
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('User-Agent')).toBe('ua/1.0');
    if (result.kind === 'opened') expect(result.open.response.bodyUsed).toBe(false);
  });

  it('reports a non-200 answer by status and drains its body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 503 }));
    expect(await openUrl(URL_, 'ua/1.0', new AbortController().signal)).toEqual({
      kind: 'refused',
      status: 503,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a request that rejects with its error', async () => {
    const error = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    expect(await openUrl(URL_, 'ua/1.0', new AbortController().signal)).toEqual({
      kind: 'failed',
      error,
    });
  });

  it('gives up on headers that never arrive at the header deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    let settled = false;
    const opening = openUrl(URL_, 'ua/1.0', new AbortController().signal).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await opening).toMatchObject({
      kind: 'failed',
      error: { name: 'TimeoutError', message: 'No response within 30000 ms' },
    });
  });

  it('rethrows the caller’s cancellation instead of reporting it', async () => {
    const caller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const opening = openUrl(URL_, 'ua/1.0', caller.signal);
    const stop = new Error('Catalog harvest stopped by shutdown.');
    caller.abort(stop);
    await expect(opening).rejects.toBe(stop);
  });
});
