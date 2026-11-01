/**
 * @fileoverview Domain types for the BLS LABSTAT catalog service.
 * @module services/bls-catalog/types
 */

/** One entry in the loaded series index. */
export interface CatalogSeries {
  areaName?: string;
  /**
   * An OEWS SeriesID built from the OE code tables rather than read from the
   * index (#119): BLS does not publish every occupation in every area, so the
   * ID is unconfirmed until a data request returns it.
   */
  composed?: true;
  endPeriod?: string;
  endYear?: number;
  /**
   * Publication frequency label from the survey's periodicity table (`Monthly`,
   * `Semi-Annual`, `Quarterly`, `Annual`) — set for surveys that publish one
   * series at several frequencies under the same title (CU, CW, LN, BD).
   */
  frequency?: string;
  itemName?: string;
  /**
   * What the series measures, as BLS's API `catalog.measure_data_type` names it,
   * decoded from the survey's code table that reproduces that string.
   */
  measure?: string;
  seasonal: boolean;
  seriesId: string;
  /** Observation coverage reported by the harvested catalog snapshot. */
  startYear?: number;
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
  /**
   * The list was composed from the OE code tables (#119); `capped` then means
   * more than `OEWS_COMPOSED_LIMIT` candidates.
   */
  composed?: true;
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
  /**
   * A code whose label names nothing specific, and the dimension a row carrying
   * it decodes through instead: SM's `area_code` `00000`, which `sm.area`
   * labels "Statewide", takes the row's state from `sm.state`.
   */
  fallback?: { code: string; dimension: CodeDimension };
  /** Key column(s). Composite keys (PC `industry_code` + `product_code`) list every part. */
  key: readonly string[];
  /** Code-table suffix: `{abbr}.{table}` (e.g. `state` → `jt.state`). */
  table: string;
}

/**
 * Represents a single survey's LABSTAT files. The catalog loader fetches
 * `{abbr}.series` plus the code tables its dimensions name, and decodes each
 * row's area, item, measure, frequency, and — when the file ships no
 * `series_title` — its title.
 */
export interface SurveyDefinition {
  /** Two-letter LABSTAT survey abbreviation (e.g. `cu`, `ce`, `ln`). */
  abbr: string;
  /** Dimension decoded as the series `area` (geography). */
  area?: CodeDimension;
  /**
   * Indexed by the catalog only: the observations mirror, which reads
   * `SURVEY_ABBRS`, does not harvest the survey's data files.
   */
  catalogOnly?: boolean;
  /**
   * Rows carry a footnote field between `seasonal` and `begin_year` that a
   * header without `footnote_codes` does not name (EC's historical layout, EE).
   * A row one field wider than such a header reads its coverage one field later.
   */
  footnoteUnlabeled?: boolean;
  /**
   * Dimension decoded as the series publication `frequency` — only for surveys
   * whose periodicity code means publication frequency rather than a measure type.
   */
  frequency?: CodeDimension;
  /** Dimension decoded as the series `item` (the item, product, industry, or measure). */
  item?: CodeDimension;
  /**
   * Dimension decoded as the series `measure` — only for surveys where this
   * table's label is the API's `catalog.measure_data_type` verbatim. A survey
   * without one leaves `measure` unset rather than guessing.
   */
  measure?: CodeDimension;
  /** Program label; prefixes every title the loader synthesizes for this survey. */
  name: string;
  /**
   * Ordered dimensions joined after `name` to synthesize a title for rows with
   * no `series_title`. Defaults to `item` then `area`.
   */
  title?: readonly CodeDimension[];
}

/**
 * Whether the catalog can answer a search. `ready` once the index holds series,
 * also while a refresh runs; `loading` while a harvest builds an index that
 * holds none yet (the boot harvest, or a later check retrying an empty index);
 * `unavailable` when it holds none and no harvest is running, with why the last
 * load ended that way.
 */
export type CatalogReadiness =
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'unavailable'; error: string };

/**
 * How bls_search_series reaches a survey (#121): `indexed` when the index holds
 * its series (`seriesIndexed` of them), `composed` when the search builds its
 * SeriesIDs from code tables (OEWS without indexed OE rows), `none` otherwise.
 */
export type SurveySearchCoverage =
  | { searchCoverage: 'indexed'; seriesIndexed: number }
  | { searchCoverage: 'composed' | 'none' };

/**
 * One survey's harvest outcome. `indexed` carries its parsed rows and the code
 * tables it fetched, by table suffix. Otherwise it
 * keeps its indexed rows: `series_unavailable` when its `.series` request or
 * body read failed, with the cause; `unusable` when a declared code table or the
 * `.series` body failed a check that reported itself on stderr.
 */
export type SurveyLoad =
  | { outcome: 'indexed'; entries: CatalogSeries[]; tables: ReadonlyMap<string, string> }
  | { outcome: 'series_unavailable'; cause: string }
  | { outcome: 'unusable' };

/** A survey harvest that kept the survey's indexed rows. */
export type SurveyFailure = Exclude<SurveyLoad, { outcome: 'indexed' }>;

/**
 * A configured survey's refresh record, kept in memory for the life of the
 * process. `current`: its last harvest succeeded at `succeededAtMs`, and it is
 * due again once that is older than the TTL. `failing`: its last `failures`
 * harvests failed in a row, and it is due again at check `retryCheck`. A survey
 * with no record is due.
 */
export type SurveyRefresh =
  | { state: 'current'; succeededAtMs: number }
  | { state: 'failing'; failures: number; retryCheck: number };
