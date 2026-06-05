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

/** Outcome of a series query against the mirror store. */
export interface MirrorSeriesResult {
  /** True when the mirror has rows for every requested series_id; false signals partial coverage. */
  complete: boolean;
  /** Series IDs that had zero mirror rows (will be live-fetched when fallback is enabled). */
  missedIds: string[];
  /** Observations ordered by year DESC, period DESC. */
  observations: ObservationRow[];
}
