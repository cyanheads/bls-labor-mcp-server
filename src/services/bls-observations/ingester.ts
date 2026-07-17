/**
 * @fileoverview LABSTAT observation ingester — the `sync` generator for the
 * BLS observations mirror. For each surveyed abbreviation it discovers data
 * files by parsing the survey's `{abbr}.readme`, fetches them, parses the
 * tab-delimited rows, and yields pages for the framework's runner.
 *
 * Checkpoint: ISO 8601 datestamp of the last `Last-Modified` response header
 * seen (lexicographically monotonic). On a `refresh` run the checkpoint seeds
 * an early-exit guard — files whose `Last-Modified` predates the checkpoint
 * are skipped. Cursor: `{abbr}:{fileIndex}:{rowOffset}` — volatile intra-run
 * resume for interrupted inits.
 * @module services/bls-observations/ingester
 */

import type { MirrorRow, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { SURVEY_ABBRS } from '@/services/bls-catalog/bls-catalog-service.js';
import type { ObservationRow } from './types.js';

/** Rows yielded per page — controls memory peak during bulk ingest. */
const PAGE_SIZE = 5_000;

/** HTTP timeout for LABSTAT file fetches (30 s). */
const FETCH_TIMEOUT_MS = 30_000;

/** Retry budget for a single HTTP fetch (3 attempts, linear backoff). */
const MAX_FETCH_ATTEMPTS = 3;

/** Min value string that represents an actual number (excludes '-'). */
const NULL_VALUE = '-';

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

async function fetchText(
  url: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<{ text: string; lastModified: string | null } | null> {
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    // Combine caller signal with per-fetch timeout
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: combinedSignal,
      });
      if (!response.ok) {
        if (response.status === 404) return null; // file doesn't exist — expected for some surveys
        if (attempt < MAX_FETCH_ATTEMPTS) {
          await sleep(attempt * 2_000, signal);
          continue;
        }
        return null;
      }
      const text = await response.text();
      const lastModified = response.headers.get('last-modified');
      return { text, lastModified };
    } catch (err) {
      if (signal.aborted) throw err; // propagate cancellation immediately
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 2_000, signal);
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });
}

// ---------------------------------------------------------------------------
// README parser — discovers data file names in `{abbr}.readme`
// ---------------------------------------------------------------------------

/**
 * Parse `{abbr}.readme` text to extract the list of `{abbr}.data.*` filenames.
 * The readme lists files in a section that begins with lines like:
 *   Name of file:  cu.data.1.AllItems
 * or in some surveys:
 *   cu.data.0.AllData
 * We look for any token that starts with `{abbr}.data.`.
 */
function parseReadmeDataFiles(readmeText: string, abbr: string): string[] {
  const prefix = `${abbr}.data.`;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of readmeText.split('\n')) {
    // Find any token on the line that looks like {abbr}.data.{...}
    const matches = line.match(new RegExp(`${abbr}\\.data\\.\\S+`, 'gi'));
    if (matches) {
      for (const m of matches) {
        const normalized = m
          .toLowerCase()
          .trim()
          .replace(/[.,;:)]+$/, '');
        if (normalized.startsWith(prefix) && !seen.has(normalized)) {
          seen.add(normalized);
          result.push(normalized);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tab-delimited observation row parser
// ---------------------------------------------------------------------------

/**
 * Parse one LABSTAT `{abbr}.data.*` file into ObservationRows.
 * Expected header (tab-delimited):
 *   series_id  year  period  value  footnote_codes
 * The footnote_codes column is optional and may be absent entirely.
 */
function parseDataFile(text: string, startRow: number): ObservationRow[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const header = lines[0]?.split('\t').map((h) => h.trim().toLowerCase()) ?? [];
  const colSeriesId = header.indexOf('series_id');
  const colYear = header.indexOf('year');
  const colPeriod = header.indexOf('period');
  const colValue = header.indexOf('value');
  const colFootnote = header.indexOf('footnote_codes');

  // Require at least the four mandatory columns
  if (colSeriesId < 0 || colYear < 0 || colPeriod < 0 || colValue < 0) return [];

  const rows: ObservationRow[] = [];
  for (let i = Math.max(1, startRow + 1); i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split('\t');

    const series_id = parts[colSeriesId]?.trim();
    const year = parts[colYear]?.trim();
    const period = parts[colPeriod]?.trim();
    const value = parts[colValue]?.trim();

    if (!series_id || !year || !period || !value) continue;
    // Skip rows with no meaningful value
    if (value === NULL_VALUE) continue;

    const footnote_codes = colFootnote >= 0 ? (parts[colFootnote]?.trim() ?? '') : '';
    const row_key = `${series_id}|${year}|${period}`;

    rows.push({ row_key, series_id, year, period, value, footnote_codes });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The sync generator
// ---------------------------------------------------------------------------

/**
 * Options passed to the ingester — sourced from server config via the service.
 */
export interface IngesterOptions {
  catalogBaseUrl: string;
  userAgent: string;
}

/**
 * Async generator that harvests LABSTAT observation data. Yields pages of
 * `ObservationRow` records for the framework runner to upsert. Each page
 * carries a cursor for mid-run resume and an updated checkpoint (the max
 * `Last-Modified` header seen so far, ISO 8601).
 *
 * The framework writes the completion marker (`completedAt`) ONCE, after the
 * generator returns normally — never per page. The per-page `checkpoint`
 * advances the stored high-water mark as pages are committed, so an
 * interrupted init can skip already-fresh files on resume.
 */
export async function* observationsSync(
  ctx: SyncContext,
  opts: IngesterOptions,
): AsyncGenerator<SyncPage> {
  const { mode, cursor: rawCursor, checkpoint: priorCheckpoint, signal } = ctx;
  const { catalogBaseUrl, userAgent } = opts;

  // Decode intra-run resume cursor (init mode only)
  const resume: IngestCursor =
    mode === 'init' && rawCursor
      ? decodeCursor(rawCursor)
      : { abbrIdx: 0, fileIdx: 0, rowOffset: 0 };

  let maxLastModified = priorCheckpoint ?? '';

  for (const [abbrIdx, abbr] of SURVEY_ABBRS.entries()) {
    if (signal.aborted) break;
    if (abbrIdx < resume.abbrIdx) continue;
    const baseDir = `${catalogBaseUrl}/${abbr}`;

    // Discover data files from the readme
    const readmeResult = await fetchText(`${baseDir}/${abbr}.readme`, userAgent, signal);
    if (signal.aborted) break;

    let dataFiles: string[] = [];
    if (readmeResult) {
      dataFiles = parseReadmeDataFiles(readmeResult.text, abbr);
    }
    // Fallback: try the canonical single-file name that many surveys use
    if (dataFiles.length === 0) {
      dataFiles = [`${abbr}.data.1.AllData`];
    }

    const startFileIdx = abbrIdx === resume.abbrIdx ? resume.fileIdx : 0;

    for (const [fileIdx, fileName] of dataFiles.entries()) {
      if (signal.aborted) break;
      if (fileIdx < startFileIdx) continue;
      const url = `${baseDir}/${fileName}`;

      const result = await fetchText(url, userAgent, signal);
      if (signal.aborted) break;
      if (!result) continue; // file not found or fetch failed — skip

      // On refresh: if this file's Last-Modified predates our checkpoint, skip
      if (mode === 'refresh' && priorCheckpoint && result.lastModified) {
        const fileStamp = new Date(result.lastModified).toISOString();
        if (fileStamp <= priorCheckpoint) continue;
      }

      // Advance our checkpoint tracking
      if (result.lastModified) {
        const stamp = new Date(result.lastModified).toISOString();
        if (stamp > maxLastModified) maxLastModified = stamp;
      }

      // Parse the file in PAGE_SIZE chunks
      const startRow =
        abbrIdx === resume.abbrIdx && fileIdx === resume.fileIdx ? resume.rowOffset : 0;
      const allRows = parseDataFile(result.text, startRow);

      for (let rowOffset = 0; rowOffset < allRows.length; rowOffset += PAGE_SIZE) {
        if (signal.aborted) break;
        const batch = allRows.slice(rowOffset, rowOffset + PAGE_SIZE);
        if (batch.length === 0) continue;

        const isLastBatch = rowOffset + PAGE_SIZE >= allRows.length;
        const isLastFile = fileIdx === dataFiles.length - 1;
        const isLastSurvey = abbrIdx === SURVEY_ABBRS.length - 1;

        // Cursor: records progress through surveys/files/rows for interrupt resume
        // On the last page of a file, advance to the next file
        const nextCursor: IngestCursor = isLastBatch
          ? isLastFile
            ? { abbrIdx: abbrIdx + 1, fileIdx: 0, rowOffset: 0 }
            : { abbrIdx, fileIdx: fileIdx + 1, rowOffset: 0 }
          : { abbrIdx, fileIdx, rowOffset: rowOffset + PAGE_SIZE };

        // Checkpoint: only emit on last page of a survey — prevents per-page
        // checkpoint noise while still advancing on every completed survey
        const checkpoint =
          isLastBatch && isLastFile && maxLastModified ? maxLastModified : undefined;

        yield {
          records: batch as unknown as MirrorRow[],
          cursor: isLastBatch && isLastFile && isLastSurvey ? undefined : encodeCursor(nextCursor),
          ...(checkpoint !== undefined ? { checkpoint } : {}),
        };
      }
    }
  }
}
