/**
 * @fileoverview Domain types for the BLS LABSTAT catalog service.
 * @module services/bls-catalog/types
 */

/** One entry in the loaded series index. */
export interface CatalogSeries {
  areaName?: string;
  /**
   * Publication frequency label from the survey's periodicity table (`Monthly`,
   * `Semi-Annual`, `Quarterly`, `Annual`) — set for surveys that publish one
   * series at several frequencies under the same title (CU, CW, LN).
   */
  frequency?: string;
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
  /** Rows of the ranked, filtered list to skip before the page. Default 0. */
  offset?: number;
  query: string;
  seasonal_adjustment: boolean | undefined;
  survey: string | undefined;
}

/** Structured search result aligned with the bls_search_series tool output. */
export interface CatalogSearchResult {
  /**
   * Whether the candidate set was bounded by CANDIDATE_LIMIT. When true,
   * `total` is a lower bound — actual matches in the full index may be higher.
   * The cap applies after the survey, seasonal, and area filters.
   */
  capped: boolean;
  /** The page: `limit` rows of the ranked list starting at `offset`. */
  series: CatalogSeries[];
  /** Total candidates scored, after every filter. A lower bound when `capped` is true. */
  total: number;
}

/**
 * A `.series` column — or column tuple — decoded through a same-survey LABSTAT
 * code table. The key columns carry the same names in both files.
 */
export interface CodeDimension {
  /** Key column(s). Composite keys (PC `industry_code` + `product_code`) list every part. */
  key: readonly string[];
  /** Code-table suffix: `{abbr}.{table}` (e.g. `state` → `jt.state`). */
  table: string;
}

/**
 * Represents a single survey's LABSTAT files. The catalog loader fetches
 * `{abbr}.series` plus the code tables its dimensions name, and decodes each
 * row's area, item, frequency, and — when the file ships no `series_title` —
 * its title.
 */
export interface SurveyDefinition {
  /** Two-letter LABSTAT survey abbreviation (e.g. `cu`, `ce`, `ln`). */
  abbr: string;
  /** Dimension decoded as the series `area` (geography). */
  area?: CodeDimension;
  /**
   * Dimension decoded as the series publication `frequency` — only for surveys
   * whose periodicity code means publication frequency rather than a measure type.
   */
  frequency?: CodeDimension;
  /** Dimension decoded as the series `item` (the item, product, industry, or measure). */
  item?: CodeDimension;
  /** Program label; prefixes every title the loader synthesizes for this survey. */
  name: string;
  /**
   * Ordered dimensions joined after `name` to synthesize a title for rows with
   * no `series_title`. Defaults to `item` then `area`.
   */
  title?: readonly CodeDimension[];
}
