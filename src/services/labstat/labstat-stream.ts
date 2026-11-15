/**
 * @fileoverview Streamed LABSTAT reads, shared by the catalog harvest and the
 * observations ingester: a request that waits a bounded time for its headers,
 * a body decoded as it arrives with a bounded wait between chunks, and the
 * decoded text regrouped into lines. Nothing bounds a whole body, so a file's
 * size limits neither read: the largest LABSTAT files (`oe.series` at over
 * 1.2 GB, data files past 390 MB) fit no fixed deadline on every link, and Node
 * cannot hold `oe.series` as one string (its limit is 536,870,888 characters).
 * @module services/labstat/labstat-stream
 */

/** How long a LABSTAT request may wait for its response headers. */
const RESPONSE_TIMEOUT_MS = 30_000;

/** Longest wait for the next chunk of a response body. */
const BODY_STALL_TIMEOUT_MS = 60_000;

/** A LABSTAT response whose headers have arrived, its body not yet read. */
export interface OpenResponse {
  /** Aborts the request, erroring its body mid-read. */
  abort: (reason: Error) => void;
  response: Response;
}

/**
 * A request's outcome: `opened` with a 200 response; `refused` with another
 * status, its body already drained; `failed` when no response arrived (a
 * network error or the header deadline), with what the request rejected with.
 */
export type OpenResult =
  | { kind: 'opened'; open: OpenResponse }
  | { kind: 'refused'; status: number }
  | { kind: 'failed'; error: unknown };

/**
 * Request one LABSTAT URL, waiting at most {@link RESPONSE_TIMEOUT_MS} for its
 * headers. A failure is returned, never thrown; the caller's cancellation is
 * rethrown untouched.
 */
export async function openUrl(
  url: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<OpenResult> {
  const request = new AbortController();
  const headerTimer = setTimeout(
    () => request.abort(timeoutError(`No response within ${RESPONSE_TIMEOUT_MS} ms`)),
    RESPONSE_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.any([signal, request.signal]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'refused', status: response.status };
    }
    return { kind: 'opened', open: { abort: (reason) => request.abort(reason), response } };
  } catch (error) {
    signal.throwIfAborted();
    return { kind: 'failed', error };
  } finally {
    clearTimeout(headerTimer);
  }
}

/**
 * Decode a response body as it arrives. Each chunk must arrive within
 * {@link BODY_STALL_TIMEOUT_MS}; a stall aborts the request, which errors the
 * pending read. A consumer that stops early cancels the rest of the body.
 */
export async function* readBody({ abort, response }: OpenResponse): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let streaming = true;
  try {
    for (;;) {
      const stallTimer = setTimeout(
        () => abort(timeoutError(`No data for ${BODY_STALL_TIMEOUT_MS} ms`)),
        BODY_STALL_TIMEOUT_MS,
      );
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        streaming = false; // the body errored; there is nothing left to cancel
        throw err;
      } finally {
        clearTimeout(stallTimer);
      }
      if (chunk.done) {
        streaming = false;
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
      }
      yield decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (streaming) await reader.cancel();
  }
}

/**
 * Regroup streamed text into complete lines, one batch per chunk that
 * completes any. Returns the text after the last line break: empty when the
 * text ends in one, as every LABSTAT file does, and otherwise an unterminated
 * last line — the sign of a body cut short. Lines keep any `\r`.
 */
export async function* lineBatches(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string[], string> {
  let pending = '';
  for await (const chunk of chunks) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    if (lines.length > 0) yield lines;
  }
  return pending;
}

function timeoutError(message: string): Error {
  return new DOMException(message, 'TimeoutError');
}
