/**
 * @fileoverview Domain types for the BLS observations mirror service.
 * @module services/bls-observations/types
 */

/** One observation row as stored in (and read from) the SQLite mirror. */
export interface ObservationRow {
  /** Raw footnote codes from the data file (empty string when absent). */
  footnote_codes: string;
  period: string;
  /** Composite primary key: `${series_id}|${year}|${period}` */
  row_key: string;
  series_id: string;
  /** Observation value as a string (matches raw LABSTAT format: numeric or '-'). */
  value: string;
  year: string;
}

/** A LABSTAT listing or data file a sync run needed and could not read. */
export interface UnreadFile {
  /** Why the last attempt failed when no HTTP status explains it: a transport error, a timeout, an unrecognized layout. */
  error?: string;
  /** HTTP status of the last attempt, when LABSTAT answered. */
  status?: number;
  survey: string;
  url: string;
}

/** What a completed sync run did not cover. */
export interface SyncGaps {
  /** Surveys whose directory listing names no data files. No file was skipped, so these do not hold the checkpoint. */
  surveysWithoutDataFiles: string[];
  /** Listings and data files the run could not read. Any entry holds the checkpoint. */
  unreadFiles: UnreadFile[];
}

/** Outcome of a series query against the mirror store. */
export interface MirrorSeriesResult {
  /** True when the mirror has rows for every requested series_id; false signals partial coverage. */
  complete: boolean;
  /** Series IDs that had zero mirror rows (will be live-fetched when fallback is enabled). */
  missedIds: string[];
  /** Observations ordered by year DESC, period DESC. */
  observations: ObservationRow[];
}
