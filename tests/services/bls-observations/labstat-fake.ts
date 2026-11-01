/**
 * @fileoverview A fake LABSTAT `fetch` for the observation-mirror tests. Serves
 * each configured survey's directory listing and files the way download.bls.gov
 * does, and 404s everything else. Bodies stream in small chunks, so line
 * handling across chunk boundaries is exercised, and honor the request signal:
 * aborting a request errors its body, as it does under Node and Bun.
 * @module tests/services/bls-observations/labstat-fake
 */

/** One file the fake serves. The spec is read on every request, so a test can change it between runs. */
export interface FakeFile {
  body?: string;
  lastModified?: string;
  /** Deliver the body up to this many bytes, then stop sending without closing. */
  stallAfterBytes?: number;
  /** A non-200 status answers with an empty body. */
  status?: number;
}

/**
 * Files by name for each survey. The reserved name `''` is the directory listing
 * itself: give it a `status` to fail the listing. Every other name is linked
 * from the listing.
 */
export type FakeLabstat = Record<string, Record<string, FakeFile>>;

const BASE_PATH = '/pub/time.series/';
const CHUNK_BYTES = 64;

/** An IIS directory listing in the shape download.bls.gov serves, linking each name. */
export function listingHtml(abbr: string, names: string[]): string {
  const entries = names
    .map((n) => `10/15/2026  7:30 AM       123456 <A HREF="${BASE_PATH}${abbr}/${n}">${n}</A><br>`)
    .join('');
  return `<html><head><title>download.bls.gov - ${BASE_PATH}${abbr}/</title></head><body><H1>download.bls.gov - ${BASE_PATH}${abbr}/</H1><hr>\n\n<pre><A HREF="${BASE_PATH}">[To Parent Directory]</A><br><br>${entries}</pre><hr></body></html>`;
}

/** A body that streams `text` in small chunks and errors when `signal` aborts. */
function streamBody(
  text: string,
  signal: AbortSignal | null | undefined,
  onCancel: () => void,
  stallAfterBytes?: number,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const end = stallAfterBytes ?? bytes.length;
  let offset = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => {
          if (!finished) controller.error(signal.reason);
        },
        { once: true },
      );
    },
    async pull(controller) {
      if (offset >= end) {
        if (stallAfterBytes !== undefined) await new Promise<void>(() => {});
        finished = true;
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, end)));
      offset += CHUNK_BYTES;
    },
    cancel() {
      finished = true;
      onCancel();
    },
  });
}

/**
 * Build a fake `fetch` over `labstat`. `requested` records every URL asked for,
 * in order; `cancelled` records each URL whose body the client cancelled.
 */
export function fakeLabstat(labstat: FakeLabstat): {
  cancelled: string[];
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requested: string[];
} {
  const requested: string[] = [];
  const cancelled: string[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    const path = new URL(url).pathname;
    const [abbr = '', rawName] = path.startsWith(BASE_PATH)
      ? path.slice(BASE_PATH.length).split('/')
      : [];
    const survey = labstat[abbr];
    if (!survey || rawName === undefined) return Promise.resolve(new Response('', { status: 404 }));

    const name = decodeURIComponent(rawName);
    const listed = Object.keys(survey).filter((n) => n !== '');
    const file =
      name === ''
        ? { body: listingHtml(abbr, listed), ...survey[''] }
        : Object.entries(survey).find(
            ([n]) => n !== '' && n.toLowerCase() === name.toLowerCase(),
          )?.[1];
    if (!file) return Promise.resolve(new Response('', { status: 404 }));
    if (file.status !== undefined && file.status !== 200) {
      return Promise.resolve(new Response('', { status: file.status }));
    }
    const headers = file.lastModified ? { 'Last-Modified': file.lastModified } : undefined;
    const body = streamBody(
      file.body ?? '',
      init?.signal,
      () => cancelled.push(url),
      file.stallAfterBytes,
    );
    return Promise.resolve(new Response(body, { status: 200, ...(headers && { headers }) }));
  };
  return { cancelled, fetch, requested };
}
