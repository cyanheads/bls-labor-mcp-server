/**
 * @fileoverview Domain types for the BLS LABSTAT catalog service.
 * @module services/bls-catalog/types
 */

/** One entry in the loaded series index. */
export interface CatalogSeries {
  areaName?: string;
  itemName?: string;
  seasonal: boolean;
  seriesId: string;
  surveyAbbr: string;
  title: string;
}

/** Structured search input aligned with the bls_search_series tool. */
export interface CatalogSearchInput {
  area: string | undefined;
  limit: number;
  query: string;
  seasonal_adjustment: boolean | undefined;
  survey: string | undefined;
}

/** Structured search result aligned with the bls_search_series tool output. */
export interface CatalogSearchResult {
  /**
   * Whether the candidate set was bounded by CANDIDATE_LIMIT. When true,
   * `total` is a lower bound — actual matches in the full index may be higher.
   */
  capped: boolean;
  series: CatalogSeries[];
  /** Total candidates scored. A lower bound when `capped` is true. */
  total: number;
}

/**
 * Represents a single survey's LABSTAT files. The catalog loader fetches
 * `{abbr}.series` and joins code-mapping files to produce human-readable titles.
 */
export interface SurveyDefinition {
  /** Two-letter LABSTAT survey abbreviation (e.g. `cu`, `ce`, `ln`). */
  abbr: string;
  /** Optional alternate code mappings used to decode series titles. */
  codeTables?: string[];
  /** Human-readable name (e.g. "CPI - All Urban Consumers"). */
  name: string;
}
