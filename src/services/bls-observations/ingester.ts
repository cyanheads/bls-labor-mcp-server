/**
 * @fileoverview LABSTAT observation ingester — the `sync` generator for the
 * BLS observations mirror. For each surveyed abbreviation it discovers data
 * files from the survey's LABSTAT directory listing, streams each file's
 * tab-delimited rows, and yields pages for the framework's runner. A separate
 * pass, {@link syncFootnoteTables}, reads each survey's footnote code table for
 * the service to keep beside the rows.
 *
 * Checkpoint: ISO 8601 datestamp of the newest `Last-Modified` among the files
 * a run read (lexicographically monotonic). A refresh skips a file whose
 * `Last-Modified` is no newer than the stored checkpoint, past its headers. The
 * checkpoint advances once, on a final empty page after the last survey, and
 * only when the run read every listing and every listed data file: anything
 * unread leaves it where it was, so the next refresh reads that file again. An
 * init never consults the checkpoint, and a resumed init stores none.
 *
 * Cursor: `{abbrIdx}:{fileIdx}:{rowOffset}` — volatile resume position for an
 * interrupted init, carried on init pages only; `rowOffset` counts the data
 * rows of the file already yielded.
 * @module services/bls-observations/ingester
 */

import type { MirrorLogger, MirrorRow, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { SURVEY_ABBRS } from '@/services/bls-catalog/bls-catalog-service.js';
import type { ObservationRow, SyncGaps, UnreadFile } from './types.js';

/** Rows yielded per page — bounds memory during bulk ingest. */
const PAGE_SIZE = 5_000;

/** How long a LABSTAT request may wait for its response headers. */
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Longest wait for the next chunk of a response body. A body is read for as
 * long as it keeps arriving, with no whole-response deadline: the largest
 * LABSTAT data files exceed 390 MB, which no fixed deadline fits on every link.
 * The sync subprocess's own timeout bounds a run as a whole.
 */
const BODY_STALL_TIMEOUT_MS = 60_000;

/** Attempts per request on a transient failure, with linear backoff between them. */
const MAX_FETCH_ATTEMPTS = 3;

/** Statuses worth another attempt; any other non-200 answer is final for the run. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Cursor encoding — `{abbrIndex}:{fileIndex}:{rowOffset}`
// ---------------------------------------------------------------------------

interface IngestCursor {
  /** Index into SURVEY_ABBRS array. */
  abbrIdx: number;
  /** Index into the survey's data file list. */
  fileIdx: number;
  /** Row offset within the current file. */
  rowOffset: number;
}

function encodeCursor(c: IngestCursor): string {
  return `${c.abbrIdx}:${c.fileIdx}:${c.rowOffset}`;
}

function decodeCursor(s: string): IngestCursor {
  const [a, f, r] = s.split(':').map(Number);
  return { abbrIdx: a ?? 0, fileIdx: f ?? 0, rowOffset: r ?? 0 };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Why a LABSTAT request yielded no usable body. */
type FetchFailure = Pick<UnreadFile, 'error' | 'status'>;

/** A LABSTAT response whose headers have arrived, its body not yet read. */
interface OpenResponse {
  /** Aborts the request, erroring its body mid-read. */
  abort: (reason: Error) => void;
  /** `Last-Modified` as ISO 8601; absent when the header is missing or not a date. */
  lastModified: string | undefined;
  response: Response;
}

type OpenResult =
  | { ok: true; open: OpenResponse }
  | { ok: false; failure: FetchFailure; transient: boolean };

/**
 * Request one LABSTAT URL, waiting at most {@link RESPONSE_TIMEOUT_MS} for its
 * headers. A non-200 answer is drained and reported, never thrown; the caller's
 * cancellation is rethrown untouched.
 */
async function openUrl(url: string, userAgent: string, signal: AbortSignal): Promise<OpenResult> {
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
      return {
        ok: false,
        failure: { status: response.status },
        transient: TRANSIENT_STATUSES.has(response.status),
      };
    }
    const abort = (reason: Error) => request.abort(reason);
    return {
      ok: true,
      open: { abort, lastModified: isoDate(response.headers.get('last-modified')), response },
    };
  } catch (err) {
    signal.throwIfAborted();
    return { ok: false, failure: { error: describeError(err) }, transient: true };
  } finally {
    clearTimeout(headerTimer);
  }
}

/**
 * Decode a response body as it arrives. Each chunk must arrive within
 * {@link BODY_STALL_TIMEOUT_MS}; a stall aborts the request, which errors the
 * pending read. A consumer that stops early cancels the rest of the body.
 */
async function* readBody({ abort, response }: OpenResponse): AsyncGenerator<string> {
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

/** Fetch a small LABSTAT file (a listing, a code table) as text, retrying a transient failure. */
async function fetchText(
  url: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; failure: FetchFailure }> {
  let failure: FetchFailure = {};
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep((attempt - 1) * 2_000, signal);
    const result = await openUrl(url, userAgent, signal);
    if (!result.ok) {
      failure = result.failure;
      if (!result.transient) break;
      continue;
    }
    try {
      let text = '';
      for await (const chunk of readBody(result.open)) text += chunk;
      return { ok: true, text };
    } catch (err) {
      signal.throwIfAborted();
      failure = { error: describeError(err) };
    }
  }
  return { ok: false, failure };
}

/** ISO 8601 form of an HTTP date header; `undefined` when absent or unparseable. */
function isoDate(header: string | null): string | undefined {
  const ms = header ? Date.parse(header) : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function timeoutError(message: string): Error {
  return new DOMException(message, 'TimeoutError');
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason);
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Listing parser — discovers data file names in the survey's directory listing
// ---------------------------------------------------------------------------

/** Every `href` value in an HTML document; `[^"]*` cannot backtrack, so the scan is linear. */
const HREF_PATTERN = /href="([^"]*)"/gi;

/**
 * Extract a survey's `{abbr}.data.*` file names from its LABSTAT directory
 * listing, in listing order, exactly as served. The listing is the server's own
 * index of the directory, one link per file:
 *   <A HREF="/pub/time.series/pc/pc.data.0.Current">pc.data.0.Current</A>
 * The survey's `{abbr}.txt` description also names data files, but its prose
 * has drifted from what the directory holds (misspelled, truncated, and missing
 * names), so it is not consulted. Code tables, `{abbr}.series`, and `{abbr}.txt`
 * are not data files and are skipped; a name keeps its spaces.
 */
function parseListingDataFiles(html: string, abbr: string): string[] {
  const prefix = `${abbr}.data.`;
  const files: string[] = [];
  for (const [, href = ''] of html.matchAll(HREF_PATTERN)) {
    const name = decodeHrefSegment(href.slice(href.lastIndexOf('/') + 1));
    if (name.toLowerCase().startsWith(prefix) && !files.includes(name)) files.push(name);
  }
  return files;
}

/** Percent-decode one href path segment; a malformed escape is kept as written. */
function decodeHrefSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Tab-delimited observation data files
// ---------------------------------------------------------------------------

/** Column positions read from a data file's header line. */
interface DataColumns {
  footnote: number;
  period: number;
  seriesId: number;
  value: number;
  year: number;
}

/**
 * Locate the columns of a LABSTAT `{abbr}.data.*` header (tab-delimited):
 *   series_id  year  period  value  footnote_codes
 * `footnote_codes` is optional; `undefined` when any other column is missing.
 */
function parseHeader(line: string): DataColumns | undefined {
  const header = line.split('\t').map((h) => h.trim().toLowerCase());
  const columns = {
    seriesId: header.indexOf('series_id'),
    year: header.indexOf('year'),
    period: header.indexOf('period'),
    value: header.indexOf('value'),
    footnote: header.indexOf('footnote_codes'),
  };
  const { seriesId, year, period, value } = columns;
  return seriesId < 0 || year < 0 || period < 0 || value < 0 ? undefined : columns;
}

/**
 * Parse one data line. Values are stored verbatim, the `-` missing-value
 * sentinel included; a line with an empty required cell is malformed.
 */
function parseRow(line: string, columns: DataColumns): ObservationRow | undefined {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parts = trimmed.split('\t');

  const series_id = parts[columns.seriesId]?.trim();
  const year = parts[columns.year]?.trim();
  const period = parts[columns.period]?.trim();
  const value = parts[columns.value]?.trim();

  /**
   * An empty cell is a malformed row and is dropped. The BLS `-` sentinel is
   * not: it is a published observation saying the period has no figure, with
   * a footnote for why. Stored verbatim, it reaches the shared normalization
   * as `available: false` — the same answer the live API gives.
   */
  if (!series_id || !year || !period || !value) return;

  const footnote_codes = columns.footnote >= 0 ? (parts[columns.footnote]?.trim() ?? '') : '';
  return {
    row_key: `${series_id}|${year}|${period}`,
    series_id,
    year,
    period,
    value,
    footnote_codes,
  };
}

/** How one data file's pages are positioned and when the file may be skipped. */
interface DataFileRead {
  /** The resume cursor after `rowOffset` rows of the file, or past the file at its end. */
  cursorAt: (rowOffset: number, endOfFile: boolean) => string | undefined;
  /** A refresh's checkpoint: a file no newer than it is skipped past its headers. */
  newerThan: string | undefined;
  /** Data rows already ingested from this file (an init resuming mid-file). */
  skipRows: number;
}

/** Whether a data file was read (or skipped as unchanged), and its `Last-Modified`. */
type DataFileOutcome =
  | { read: true; lastModified: string | undefined }
  | { read: false; failure: FetchFailure };

/**
 * Stream one data file's rows as pages of {@link PAGE_SIZE}, retrying a
 * transient failure from the file's first unread row. A file without the
 * observation header is unread: nothing in it can be ingested.
 */
async function* readDataFile(
  url: string,
  file: DataFileRead,
  userAgent: string,
  signal: AbortSignal,
): AsyncGenerator<SyncPage, DataFileOutcome> {
  let failure: FetchFailure = {};
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep((attempt - 1) * 2_000, signal);
    const result = await openUrl(url, userAgent, signal);
    if (!result.ok) {
      failure = result.failure;
      if (!result.transient) break;
      continue;
    }
    const { lastModified, response } = result.open;
    if (file.newerThan && lastModified && lastModified <= file.newerThan) {
      await response.body?.cancel();
      return { read: true, lastModified };
    }
    try {
      if (yield* pageRows(readBody(result.open), file)) return { read: true, lastModified };
      return { read: false, failure: { error: 'No series_id/year/period/value header line' } };
    } catch (err) {
      signal.throwIfAborted();
      failure = { error: describeError(err) };
    }
  }
  return { read: false, failure };
}

/**
 * Parse a data file's text as it streams, yielding pages of rows. A full page
 * goes out only once a later row shows the file continues, so the file's last
 * page carries the cursor past it. Returns `false` when the file does not open
 * with the observation header.
 */
async function* pageRows(
  chunks: AsyncIterable<string>,
  file: DataFileRead,
): AsyncGenerator<SyncPage, boolean> {
  let columns: DataColumns | undefined;
  let skipped = 0;
  let rowOffset = file.skipRows;
  let batch: ObservationRow[] = [];

  for await (const lines of lineBatches(chunks)) {
    for (const line of lines) {
      if (!columns) {
        columns = parseHeader(line);
        if (!columns) return false;
        continue;
      }
      const row = parseRow(line, columns);
      if (!row) continue;
      if (skipped < file.skipRows) {
        skipped++;
        continue;
      }
      if (batch.length === PAGE_SIZE) {
        rowOffset += batch.length;
        yield { records: batch as unknown as MirrorRow[], cursor: file.cursorAt(rowOffset, false) };
        batch = [];
      }
      batch.push(row);
    }
  }
  if (!columns) return false;
  if (batch.length > 0) {
    yield {
      records: batch as unknown as MirrorRow[],
      cursor: file.cursorAt(rowOffset + batch.length, true),
    };
  }
  return true;
}

/** Regroup streamed text into complete lines, one batch per chunk; the last line may lack its newline. */
async function* lineBatches(chunks: AsyncIterable<string>): AsyncGenerator<string[]> {
  let pending = '';
  for await (const chunk of chunks) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    if (lines.length > 0) yield lines;
  }
  if (pending) yield [pending];
}

// ---------------------------------------------------------------------------
// Footnote code tables — `{abbr}.footnote`
// ---------------------------------------------------------------------------

/**
 * Parse a LABSTAT `{abbr}.footnote` table (tab-delimited, CRLF):
 *   footnote_code  footnote_text
 * into text by code. `undefined` when the first line is not that header.
 */
function parseFootnoteTable(text: string): Map<string, string> | undefined {
  const [headerLine = '', ...lines] = text.split('\n');
  const header = headerLine.split('\t').map((h) => h.trim().toLowerCase());
  const codeColumn = header.indexOf('footnote_code');
  const textColumn = header.indexOf('footnote_text');
  if (codeColumn < 0 || textColumn < 0) return;

  const footnotes = new Map<string, string>();
  for (const line of lines) {
    const cells = line.split('\t');
    const code = cells[codeColumn]?.trim();
    if (code) footnotes.set(code, cells[textColumn]?.trim() ?? '');
  }
  return footnotes;
}

/**
 * Read every mirrored survey's `{abbr}.footnote` table and hand each one read to
 * `save`, which replaces that survey's stored copy. The service runs this once
 * per sync, init or refresh, before the data files, so footnote text follows
 * BLS's wording whether or not any data file changed.
 *
 * The observation rows store the codes, so a table that cannot be read loses
 * nothing: the stored copy stays in use and the table is not an unread file — it
 * never holds the checkpoint or changes the exit code. A survey that publishes
 * no table answers 404 and is passed over quietly (EC today); any other failure,
 * or a body without the table's header, is warned about. The caller's
 * cancellation is rethrown.
 */
export async function syncFootnoteTables(
  opts: IngesterOptions,
  save: (survey: string, footnotes: ReadonlyMap<string, string>) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const { catalogBaseUrl, userAgent, log } = opts;
  for (const abbr of SURVEY_ABBRS) {
    signal.throwIfAborted();
    const url = `${catalogBaseUrl}/${abbr}/${abbr}.footnote`;
    const fetched = await fetchText(url, userAgent, signal);
    if (!fetched.ok && fetched.failure.status === 404) continue;

    const footnotes = fetched.ok ? parseFootnoteTable(fetched.text) : undefined;
    if (footnotes) {
      await save(abbr, footnotes);
      continue;
    }
    log?.warning?.('LABSTAT footnote table unread; any stored copy stays in use', {
      survey: abbr,
      url,
      ...(fetched.ok ? { error: 'No footnote_code/footnote_text header line' } : fetched.failure),
    });
  }
}

// ---------------------------------------------------------------------------
// The sync generator
// ---------------------------------------------------------------------------

/**
 * Options passed to the ingester — sourced from server config via the service.
 */
export interface IngesterOptions {
  catalogBaseUrl: string;
  /**
   * Sink for the harvest's own records. A sync runs outside the request
   * pipeline, so there is no `ctx.log` to reach for; the service passes on the
   * logger its caller supplied — in the sync subprocess, one that writes stdout.
   */
  log?: MirrorLogger;
  userAgent: string;
}

/**
 * Async generator that harvests LABSTAT observation data. Yields pages of
 * `ObservationRow` records for the framework runner to upsert, and returns what
 * the run could not cover.
 *
 * The runner commits each page's cursor and checkpoint with the page, and
 * writes the completion marker (`completedAt`) once, after the generator
 * returns normally. So the checkpoint rides only a final empty page, yielded
 * after the last survey when the run read every listing and listed data file:
 * an unread file, an abort, or a crash leaves the stored checkpoint unchanged,
 * and the next refresh reads every file newer than it.
 */
export async function* observationsSync(
  ctx: SyncContext,
  opts: IngesterOptions,
): AsyncGenerator<SyncPage, SyncGaps> {
  const { mode, cursor: rawCursor, checkpoint: priorCheckpoint, signal } = ctx;
  const { catalogBaseUrl, userAgent, log } = opts;
  const gaps: SyncGaps = { surveysWithoutDataFiles: [], unreadFiles: [] };
  const unread = (survey: string, url: string, failure: FetchFailure): void => {
    gaps.unreadFiles.push({ survey, url, ...failure });
    log?.warning?.('LABSTAT file unread; the checkpoint holds until a run reads it', {
      survey,
      url,
      ...failure,
    });
  };

  /**
   * A resumed init read the files before its cursor in an earlier run, which
   * this one cannot vouch for, so it stores no checkpoint.
   */
  const resume = mode === 'init' && rawCursor ? decodeCursor(rawCursor) : undefined;
  if (resume) {
    log?.info?.('Resuming an interrupted init; the next refresh reads every file', {
      cursor: rawCursor,
    });
  }
  const newerThan = mode === 'refresh' ? priorCheckpoint : undefined;
  let newest = '';

  for (const [abbrIdx, abbr] of SURVEY_ABBRS.entries()) {
    if (resume && abbrIdx < resume.abbrIdx) continue;
    signal.throwIfAborted();
    const dirUrl = `${catalogBaseUrl}/${abbr}/`;

    const listing = await fetchText(dirUrl, userAgent, signal);
    if (!listing.ok) {
      unread(abbr, dirUrl, listing.failure);
      continue;
    }
    const dataFiles = parseListingDataFiles(listing.text, abbr);
    /**
     * The listing names exactly the files the directory serves, and the names
     * differ per survey — guessing one would harvest the wrong file for most of
     * them. A survey that yields none is reported rather than passed over:
     * without this the sync exits 0 and the mirror answers every request for
     * that survey as a miss. No file of it was skipped, so the checkpoint
     * still advances.
     */
    if (dataFiles.length === 0) {
      gaps.surveysWithoutDataFiles.push(abbr);
      log?.warning?.('Survey skipped — no data files in its directory listing', {
        survey: abbr,
        listingUrl: dirUrl,
      });
      continue;
    }

    const resumeFile = resume?.abbrIdx === abbrIdx ? resume : undefined;
    for (const [fileIdx, fileName] of dataFiles.entries()) {
      if (resumeFile && fileIdx < resumeFile.fileIdx) continue;
      signal.throwIfAborted();
      const url = `${dirUrl}${encodeURIComponent(fileName)}`;
      const pastFile =
        fileIdx < dataFiles.length - 1
          ? encodeCursor({ abbrIdx, fileIdx: fileIdx + 1, rowOffset: 0 })
          : abbrIdx < SURVEY_ABBRS.length - 1
            ? encodeCursor({ abbrIdx: abbrIdx + 1, fileIdx: 0, rowOffset: 0 })
            : undefined;

      const outcome = yield* readDataFile(
        url,
        {
          cursorAt: (rowOffset, endOfFile) =>
            mode !== 'init'
              ? undefined
              : endOfFile
                ? pastFile
                : encodeCursor({ abbrIdx, fileIdx, rowOffset }),
          newerThan,
          skipRows: resumeFile?.fileIdx === fileIdx ? resumeFile.rowOffset : 0,
        },
        userAgent,
        signal,
      );
      if (!outcome.read) unread(abbr, url, outcome.failure);
      else if (outcome.lastModified && outcome.lastModified > newest) newest = outcome.lastModified;
    }
  }

  if (!resume && gaps.unreadFiles.length === 0 && newest > (priorCheckpoint ?? '')) {
    yield { records: [], checkpoint: newest };
  }
  return gaps;
}
