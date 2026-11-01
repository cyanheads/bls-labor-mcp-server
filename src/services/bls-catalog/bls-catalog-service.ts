/**
 * @fileoverview BLS LABSTAT flat-file catalog service. Downloads each survey's
 * `{survey}.series` file and code tables from
 * `download.bls.gov/pub/time.series/{survey}/`, decodes them into a searchable
 * series index, and persists that index in an on-disk SQLite store
 * (the framework's FTS5-capable `sqliteMirrorStore`). Search runs as an FTS5
 * candidate query rescored by a bespoke relevance function — the index lives on
 * disk, not the JS heap, so large surveys do not inflate memory. No API quota is
 * consumed; the BLS FAQ confirms there is no API catalog endpoint. An hourly
 * scheduler job checks each survey and re-harvests those whose TTL lapsed or
 * whose failure backoff ran out, so a long-running process stays current
 * without a restart.
 * @module services/bls-catalog/bls-catalog-service
 */

import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  type MirrorRow,
  type MirrorStore,
  type SqliteHandle,
  type SqlValue,
  type SyncState,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  AREA_CODE_SOURCES,
  type AreaIndex,
  indexAreas,
  type ResolvedArea,
  resolveArea,
} from './area-filter.js';
import {
  composeOewsSearch,
  OEWS_TABLE_NAMES,
  type OewsTableName,
  type OewsTables,
  oewsFallbacks,
  parseOewsTables,
} from './oews-composition.js';
import type {
  CatalogReadiness,
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogSeries,
  CodeDimension,
  SurveyDefinition,
  SurveyFailure,
  SurveyLoad,
  SurveyRefresh,
  SurveySearchCoverage,
} from './types.js';

/** A dimension keyed by `key` columns — by default the table's own `{table}_code`. */
function dim(table: string, ...key: string[]): CodeDimension {
  return { table, key: key.length > 0 ? key : [`${table}_code`] };
}

/** The code tables a dimension reads: its own, then its fallback's. */
function dimensionTables({ table, fallback }: CodeDimension): string[] {
  return fallback ? [table, ...dimensionTables(fallback.dimension)] : [table];
}

/**
 * The SM area: a metro row's metro area, or a statewide row's state. Statewide
 * rows carry `area_code` `00000`, which `sm.area` labels "Statewide".
 */
const SM_AREA: CodeDimension = {
  ...dim('area'),
  fallback: { code: '00000', dimension: dim('state') },
};

/**
 * Surveys fetched at startup. Chosen to cover >95% of real-world queries.
 * Each entry maps the LABSTAT file abbreviation to its program name and the
 * `.series` columns decoded through companion code tables: `area` and `item`
 * for every row, `frequency` for surveys that publish one series at several
 * frequencies under the same `series_title` (CU and CW monthly/semiannual, LN
 * monthly/quarterly/annual, BD quarterly/annual), and `title` for surveys whose
 * `.series` file ships no `series_title` (JT, EC, PR, SM, EE). Only the tables
 * these dimensions name are fetched, and each exists in the survey's LABSTAT
 * directory. Entries marked `catalogOnly` (SM through EE) stay out of the
 * observations mirror: their data files total 1.78 GB.
 *
 * `measure` names the table whose label the BLS API returns verbatim as
 * `catalog.measure_data_type`, so a series served without the API (the
 * observations mirror) carries the same `measure` the live path does. Surveys
 * without one leave it unset: BLS's API returns no catalog for JOLTS or the
 * SIC-basis ECI series, so there is no string to reproduce. The catalog-only
 * surveys leave it unset too: the mirror never serves them.
 */
const SURVEYS: SurveyDefinition[] = [
  {
    abbr: 'cu',
    name: 'CPI - All Urban Consumers',
    area: dim('area'),
    item: dim('item'),
    measure: dim('item'),
    frequency: dim('periodicity'),
  },
  {
    abbr: 'ap',
    name: 'Consumer Price Index - Average Price Data',
    area: dim('area'),
    item: dim('item'),
    measure: dim('item'),
  },
  {
    abbr: 'ce',
    name: 'CES - Employment, Hours, and Earnings',
    item: dim('industry'),
    measure: dim('datatype', 'data_type_code'),
  },
  {
    abbr: 'ln',
    name: 'CPS - Labor Force Statistics',
    measure: dim('tdat'),
    frequency: dim('periodicity'),
  },
  /**
   * No `item`: every LAUS title already opens with its measure ("Unemployment
   * Rate: Texas (S)"), and repeating it in `item_name` lifts ~8K state and local
   * rows over the national CPS series for measure queries.
   */
  {
    abbr: 'la',
    name: 'LAUS - Local Area Unemployment Statistics',
    area: dim('area'),
    measure: dim('measure'),
  },
  {
    abbr: 'pc',
    name: 'PPI - Industry Data',
    item: dim('product', 'industry_code', 'product_code'),
    measure: dim('product', 'industry_code', 'product_code'),
  },
  {
    abbr: 'wp',
    name: 'PPI - Commodity Data',
    item: dim('item', 'group_code', 'item_code'),
    measure: dim('item', 'group_code', 'item_code'),
  },
  /**
   * The acronym alone: the name prefixes every synthesized JT title, and the
   * spelled-out "Job Openings and Labor Turnover" would put "job openings" into
   * the quits, hires, and separations rows too. `area_code` is the constant
   * `00000` on every row; `state_code` carries the geography.
   */
  {
    abbr: 'jt',
    name: 'JOLTS',
    area: dim('state'),
    title: [dim('dataelement'), dim('industry'), dim('state'), dim('sizeclass'), dim('ratelevel')],
  },
  {
    abbr: 'oe',
    name: 'OES/OEWS - Occupational Employment and Wage Statistics',
    area: dim('area'),
    item: dim('occupation'),
    measure: dim('datatype'),
  },
  /** The SIC-basis Employment Cost Index; every series ends in 2005. */
  {
    abbr: 'ec',
    name: 'ECI (SIC basis, ended 2005)',
    title: [dim('compensation', 'comp_code'), dim('group'), dim('ownership'), dim('periodicity')],
    footnoteUnlabeled: true,
  },
  {
    abbr: 'pr',
    name: 'Major Sector Productivity and Costs',
    measure: dim('measure'),
    title: [dim('measure'), dim('sector'), dim('duration')],
  },
  {
    abbr: 'mp',
    name: 'Major Sector Total Factor Productivity',
    item: dim('sector'),
    measure: dim('measure'),
  },
  /**
   * Appended rather than grouped with the CPI family above: `SURVEY_ABBRS`
   * indices are load-bearing for the observations ingester's resume cursor
   * (see below), so new surveys go on the end to leave existing indices fixed.
   */
  {
    abbr: 'cw',
    name: 'CPI-W - Urban Wage Earners and Clerical Workers',
    area: dim('area'),
    item: dim('item'),
    measure: dim('item'),
    frequency: dim('periodicity'),
  },
  /**
   * The current compensation-cost surveys, which replaced EC. Both ship
   * `series_title`; the estimate (total compensation, wages and salaries, a
   * benefit) is the item. CI's `periodicity_code` names a measure (index,
   * 12-month percent change), already in its titles, so it is not a frequency.
   */
  {
    abbr: 'cm',
    name: 'ECEC - Employer Costs for Employee Compensation',
    area: dim('area'),
    item: dim('estimate'),
    measure: dim('datatype'),
  },
  {
    abbr: 'ci',
    name: 'ECI - Employment Cost Index',
    area: dim('area'),
    item: dim('estimate'),
    measure: dim('estimate'),
  },
  /**
   * No `series_title`, and BLS's own catalog title is generic. The full program
   * name leads the synthesized title: its "State" is what lifts a statewide row
   * for a query that names one ("nonfarm employment Washington state").
   */
  {
    abbr: 'sm',
    name: 'SAE - State and Area Employment, Hours, and Earnings',
    area: SM_AREA,
    item: dim('industry'),
    title: [dim('data_type'), dim('industry'), SM_AREA],
    catalogOnly: true,
  },
  { abbr: 'le', name: 'CPS - Weekly and Hourly Earnings', area: dim('fips'), catalogOnly: true },
  { abbr: 'ei', name: 'Import/Export Price Indexes', catalogOnly: true },
  {
    abbr: 'su',
    name: 'C-CPI-U - Chained CPI',
    area: dim('area'),
    item: dim('item'),
    catalogOnly: true,
  },
  {
    abbr: 'ip',
    name: 'Industry Productivity',
    area: dim('area'),
    item: dim('measure'),
    catalogOnly: true,
  },
  {
    abbr: 'bd',
    name: 'BED - Business Employment Dynamics',
    area: dim('state'),
    item: dim('industry'),
    frequency: dim('periodicity'),
    catalogOnly: true,
  },
  { abbr: 'lu', name: 'CPS - Union Affiliation', area: dim('fips'), catalogOnly: true },
  /** The SIC-basis CES, which ships no `series_title`; every series ends by 2003. */
  {
    abbr: 'ee',
    name: 'CES (SIC basis, ended 2003)',
    title: [dim('datatype', 'data_type_code'), dim('industry')],
    footnoteUnlabeled: true,
    catalogOnly: true,
  },
];

/**
 * The observations mirror's harvest order of LABSTAT survey abbreviations: the
 * `SURVEYS` entries not marked `catalogOnly`, in order. The observations
 * ingester imports this rather than restating the list, so a survey correction
 * lands in one place and the two harvests cannot drift apart. Order is
 * load-bearing: the ingester's resume cursor encodes a survey's index into this
 * array.
 */
export const SURVEY_ABBRS: readonly string[] = SURVEYS.filter((s) => !s.catalogOnly).map(
  (s) => s.abbr,
);

/**
 * The OES/OEWS survey is a pathological outlier — ~6M series / ~1.26 GB, over
 * 20× every other survey combined. Its series are excluded from the index unless
 * explicitly opted in (`BLS_CATALOG_INCLUDE_OES=true`, which only the Bun
 * runtime can read into one string), keeping the default index small, the
 * first harvest fast, and on-disk size modest. Every harvest stores OE's small
 * code tables instead, and while the index holds no OE rows bls_search_series
 * composes OEWS SeriesIDs from them (`oews-composition.ts`).
 */
export const OES_SURVEY_ABBR = 'oe';

/** Schedule key of the OE code tables, a harvest unit beside the surveys. */
const OEWS_TABLES = 'oe-tables';

/** The persisted OE code tables, one row per file, holding its LABSTAT text. */
const OEWS_TABLES_TABLE = 'bls_oews_tables';

/** The surveys a harvest fetches: every `SURVEYS` entry, less OES unless opted in. */
function configuredSurveys(includeOes: boolean): SurveyDefinition[] {
  return includeOes ? SURVEYS : SURVEYS.filter((s) => s.abbr !== OES_SURVEY_ABBR);
}

/**
 * The catalog's survey abbreviations, in `SURVEYS` order: every survey a
 * harvest fetches, the catalog-only ones included.
 */
export function catalogSurveyAbbrs(includeOes: boolean): string[] {
  return configuredSurveys(includeOes).map((s) => s.abbr);
}

/**
 * The configured survey list as a completed harvest persists it in the sync
 * state's `checkpoint`: `catalogSurveyAbbrs`, comma-joined. `load()` treats an
 * index whose stored list is missing or different as stale, so a changed
 * `BLS_CATALOG_INCLUDE_OES` or survey set re-harvests on the next boot even
 * inside the TTL.
 */
export function catalogSurveyList(includeOes: boolean): string {
  return catalogSurveyAbbrs(includeOes).join(',');
}

/** Known common series to boost in search rankings. */
const COMMON_SERIES: Record<string, string> = {
  LNS14000000: 'civilian unemployment rate seasonally adjusted',
  CES0000000001: 'total nonfarm payrolls seasonally adjusted',
  CUUR0000SA0: 'cpi-u all items u.s. city average not seasonally adjusted',
  CUSR0000SA0: 'cpi-u all items u.s. city average seasonally adjusted',
  WPUFD4: 'ppi final demand not seasonally adjusted',
  JTS000000000000000JOL: 'jolts job openings all industries',
  LNS11300000: 'labor force participation rate',
  LNS12000000: 'civilian employment level',
};

const WORD_CHAR = /\w/;
const FTS_WORD_CHAR = /^[\p{L}\p{N}\p{M}]/u;

/**
 * Whether `needle` occurs in `text` where a word starts: at the start of `text`
 * or after a character that is not a letter, digit, or underscore (a needle
 * opening on punctuation matches anywhere). Its end may run on into the word,
 * so `payroll` matches "payrolls" and `manufactur` "manufacturing", but `all`
 * never matches inside "seasonally". The concept aliases and the rescore share
 * it. A literal scan rather than a `RegExp` built from caller text, which V8
 * refuses to compile past ~32K characters. Callers pair long text with a short
 * needle (a query against an alias phrase) or a long needle with short text (a
 * query against a title), and both stay linear. `wholeEnd` also requires the
 * match to end at an FTS word boundary.
 */
export function startsWord(text: string, needle: string, wholeEnd = false): boolean {
  if (!needle) return false;
  const anywhere = !WORD_CHAR.test(needle[0] ?? '');
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (
      (anywhere || i === 0 || !WORD_CHAR.test(text[i - 1] ?? '')) &&
      (!wholeEnd || !FTS_WORD_CHAR.test(text.slice(i + needle.length, i + needle.length + 2)))
    )
      return true;
  }
  return false;
}

/** Whole single-character terms, using the FTS tokenizer's punctuation boundaries. */
function wholeTerms(text: string): Set<string> {
  return new Set(text.match(/(?<![\p{L}\p{N}\p{M}])[a-z0-9](?![\p{L}\p{N}\p{M}])/gu));
}

/**
 * Concept/synonym → survey code(s). Canonical economic vocabulary often names a
 * survey by a word its series titles never contain (BLS titles never say
 * "inflation"; PPI series don't contain "producer price index") and the survey's
 * own name isn't in the per-series FTS text. When a query contains one of these
 * phrases, the matching surveys' candidates get a relevance boost in the rescore —
 * combined with the always-unioned COMMON_SERIES, this floats the headline series
 * to the top. Codes are uppercase to match the stored `survey_abbr`.
 *
 * A phrase matches where a word starts (`startsWord`), and its end may run
 * on into the word: `ppi` never fires inside "shopping", while `job vacanc`
 * matches "job vacancies" and `payroll` matches "payrolls". A fired phrase's
 * words also count as matched on every row of its surveys when the rescore
 * asks whether a row matches every query word, so the index names
 * (`consumer price index`) are phrases of their own.
 */
const CONCEPT_ALIASES: ReadonlyArray<{ phrases: readonly string[]; surveys: readonly string[] }> = [
  {
    phrases: ['inflation', 'cost of living', 'consumer price index', 'consumer price', 'cpi'],
    surveys: ['CU'],
  },
  {
    phrases: ['producer price index', 'producer price', 'wholesale price', 'ppi'],
    surveys: ['WP', 'PC'],
  },
  { phrases: ['jobs', 'job growth', 'payroll', 'nonfarm', 'wage', 'earnings'], surveys: ['CE'] },
  { phrases: ['job opening', 'labor turnover', 'job vacanc', 'quits', 'jolts'], surveys: ['JT'] },
  { phrases: ['unemployment', 'jobless', 'labor force participation'], surveys: ['LN'] },
  { phrases: ['productivity', 'output per hour'], surveys: ['PR', 'MP'] },
  /** No CI title says "cost", and no CM or CI title says "employer". */
  { phrases: ['compensation', 'employer cost', 'ecec'], surveys: ['CM', 'CI'] },
  /** Safe only at a word start: "eci" sits inside "special", "decision", "precision". */
  { phrases: ['employment cost index', 'eci'], surveys: ['CI'] },
];

/** A survey's core measure, by its decoded item names. */
interface CoreMeasure {
  items: readonly string[];
  survey: string;
}

/**
 * What a query means by `core` (a whole word) beside one of a survey's concept
 * aliases (`core inflation`, `core cpi`, `core ppi`). The measure's rows join
 * the candidates, count `core` as matched, and take the headline boost.
 * Without an alias, `core` is an ordinary word.
 */
const CORE_MEASURES: readonly CoreMeasure[] = [
  { survey: 'CU', items: ['All items less food and energy'] },
  {
    survey: 'WP',
    items: [
      'Final demand less foods and energy',
      'Final demand less foods, energy, and trade services',
    ],
  },
];

/** A concept alias the query names: its surveys and the phrases that fired. */
interface FiredAlias {
  phrases: readonly string[];
  surveys: readonly string[];
}

/** The concept aliases the lowercased `query` names. One linear scan per alias phrase over caller text. */
function firedAliases(query: string): FiredAlias[] {
  const fired: FiredAlias[] = [];
  for (const { phrases, surveys } of CONCEPT_ALIASES) {
    const named = phrases.filter((p) => startsWord(query, p));
    if (named.length > 0) fired.push({ phrases: named, surveys });
  }
  return fired;
}

/** Survey codes whose concept aliases the lowercased `query` names. */
export function conceptAliasSurveys(query: string): Set<string> {
  return new Set(firedAliases(query).flatMap((a) => a.surveys));
}

/**
 * Survey → the query tokens its fired alias phrases name, which every row of
 * that survey counts as matched. A token equal to a phrase word counts; one
 * extending the phrase's last word counts too, since that word may run on
 * ("openings" for `job opening`).
 */
function aliasWords(
  fired: readonly FiredAlias[],
  tokens: readonly string[],
): Map<string, Set<string>> {
  const words = new Map<string, Set<string>>();
  for (const { phrases, surveys } of fired) {
    const covered = tokens.filter((t) =>
      phrases.some((p) => {
        const parts = p.split(' ');
        return parts.includes(t) || t.startsWith(parts.at(-1) ?? p);
      }),
    );
    for (const survey of surveys) {
      const set = words.get(survey) ?? new Set<string>();
      for (const t of covered) set.add(t);
      words.set(survey, set);
    }
  }
  return words;
}

/**
 * Frequency words a query can name, as whole words. `annual` is deliberately
 * absent: it names the annual-average period (M13) that monthly series carry
 * too, and matching it would also lift annual-only CPS series over the
 * canonical monthly ones.
 */
const FREQUENCY_WORDS = /\b(?:monthly|quarterly|semi[- ]?annual)\b/g;

/** A frequency word or label reduced to its letters: `Semi-Annual` → `semiannual`. */
function frequencyKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

/** The publication frequencies the lowercased `query` names, as `frequencyKey`s. */
export function queryFrequencies(query: string): Set<string> {
  return new Set(query.match(FREQUENCY_WORDS)?.map(frequencyKey));
}

/** Relevance boost for a candidate whose survey matches a query concept alias. */
const ALIAS_SURVEY_BOOST = 6;

/** Max surveys fetched concurrently during a harvest. Keeps the request burst small. */
const SURVEY_FETCH_CONCURRENCY = 3;

/**
 * Rows per SQLite transaction during a harvest, upserts and deletes alike. The
 * driver is synchronous, so this bounds how long one write holds the event
 * loop; the harvest yields a turn between chunks so searches interleave.
 */
const HARVEST_CHUNK_SIZE = 5_000;

/** Scheduler job id of the hourly catalog refresh. */
export const CATALOG_REFRESH_JOB_ID = 'bls-catalog-refresh';

/** Top of every hour. */
const CATALOG_REFRESH_CRON = '0 * * * *';

/** Max FTS candidates pulled before the bespoke rescore. Generous so `total` stays accurate. */
const CANDIDATE_LIMIT = 1_000;

/**
 * Distinct query tokens the FTS match and the token rescore use; later ones
 * are ignored there (the full-query, alias, and frequency checks still read the
 * whole query, in linear time). Candidate count and prefix expansion are
 * independently bounded; SQLite still executes the candidate query synchronously.
 */
const MAX_QUERY_TOKENS = 32;

/** Maximum one-character prefix expansions in one candidate query. */
const MAX_SHORT_PREFIXES = 2;

/**
 * An `area` longer than this is longer than any indexed title, area name, or
 * SeriesID (≤ 242 characters on the 2026-09-23 files), so no row can contain
 * it. The FTS query is skipped for it: SQLite rejects a `LIKE` pattern over
 * 50,000 bytes.
 */
const MAX_AREA_LENGTH = 1_000;

/** The catalog table; its FTS5 index is `${CATALOG_TABLE}_fts`. */
const CATALOG_TABLE = 'bls_catalog';
const CATALOG_FTS = `${CATALOG_TABLE}_fts`;

/** Columns the `area` filter matches as a case-insensitive substring. */
const AREA_MATCH_COLUMNS = ['area_name', 'title', 'series_id'] as const;

/**
 * The decoded area labels that mean "the whole country": the CPI/AP/SU
 * `U.S. city average`, the JOLTS `Total US` state code, the CM/CI
 * `United States (National)` area, the opt-in OEWS `National` area, the
 * LE/LU/IP `U.S. Total`, the BD `U.S. totals`, and the SM `All States`. Rows
 * carrying one, and rows with no decoded area (CE, LN, and the other national
 * surveys), are national for the rescore's tie-break.
 */
const NATIONAL_AREAS: ReadonlySet<string> = new Set([
  'U.S. city average',
  'Total US',
  'United States (National)',
  'National',
  'U.S. Total',
  'U.S. totals',
  'All States',
]);

/** Geographic boilerplate and modifiers do not identify a place on their own. */
const GEOGRAPHIC_STOP_WORDS = new Set([
  'all',
  'area',
  'areas',
  'city',
  'county',
  'division',
  'metropolitan',
  'micropolitan',
  'combined',
  'nonmetropolitan',
  'region',
  'state',
  'statistical',
  'town',
  'township',
  'parish',
  'borough',
  'municipality',
  'new',
  'north',
  'south',
  'east',
  'west',
  'united',
  'states',
  'national',
  'total',
  'average',
  'balance',
  'part',
  'village',
  'msa',
  'csa',
  'cdp',
]);

/**
 * Words a query uses to join or qualify, never to name: a row need not match
 * them to match every query word, and they never make an area-name part.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'in',
  'less',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'with',
]);

/**
 * CPS demographic labels. A part of an area name made only of these (White
 * County) never names a place: `white unemployment rate` asks for the CPS
 * group.
 */
const DEMOGRAPHIC_LABELS: ReadonlySet<string> = new Set([
  'white',
  'black',
  'african',
  'american',
  'asian',
  'hispanic',
  'latino',
  'men',
  'women',
]);

/** One part of a decoded area name, split on `-` `,` `/` `(` `)`, and its distinctive words. */
interface AreaPart {
  area: string;
  words: readonly string[];
}

/**
 * Index the decoded area names by distinctive word — three or more
 * characters, no geographic boilerplate or function word — for each part of
 * the name. A query names an area when it holds every distinctive word of
 * one part: `black hawk` names Black Hawk County, `black` alone does not.
 * National areas and parts made only of CPS demographic labels name nothing.
 */
function indexAreaParts(areas: Iterable<string>): Map<string, AreaPart[]> {
  const places = new Map<string, AreaPart[]>();
  for (const area of areas) {
    if (NATIONAL_AREAS.has(area)) continue;
    for (const piece of area.toLowerCase().split(/[-,/()]/)) {
      const words = [
        ...new Set(
          (piece.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).filter(
            (w) => w.length >= 3 && !GEOGRAPHIC_STOP_WORDS.has(w) && !FUNCTION_WORDS.has(w),
          ),
        ),
      ];
      if (words.length === 0 || words.every((w) => DEMOGRAPHIC_LABELS.has(w))) continue;
      const part = { area, words };
      for (const word of words) {
        const parts = places.get(word);
        if (parts) parts.push(part);
        else places.set(word, [part]);
      }
    }
  }
  return places;
}

/** The decoded areas whose name a query names, given the query's whole words. */
function namedAreas(
  places: ReadonlyMap<string, readonly AreaPart[]>,
  words: ReadonlySet<string>,
): Set<string> {
  const named = new Set<string>();
  for (const word of words) {
    for (const part of places.get(word) ?? []) {
      if (part.words.every((w) => words.has(w))) named.add(part.area);
    }
  }
  return named;
}

/**
 * The FTS condition a candidate must meet to match every required query word:
 * an `AND` of the words its survey's alias does not cover, `''` when the alias
 * covers them all. Without `surveys` it applies to every other survey.
 */
interface AllWordsMatch {
  match: string;
  surveys?: readonly string[];
}

/** A scored candidate and its rank keys; every key but `score` is 0 or 1. */
interface RankedSeries {
  aggregate: number;
  allWords: number;
  current: number;
  exact: number;
  national: number;
  place: number;
  s: CatalogSeries;
  score: number;
}

/**
 * Escape `text` for a `LIKE … ESCAPE '\'` pattern so `%`, `_`, and `\` match
 * literally. One linear pass over caller text; the result is always bound as a
 * parameter, never interpolated into SQL.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * Catalog index version. Bump it whenever the harvest's output changes (titles,
 * decoded area/item, columns) so an index persisted by an earlier release
 * re-harvests on its first boot after the upgrade. A change to the configured
 * survey set alone needs no bump: the persisted survey list
 * (`catalogSurveyList`) already marks the index stale. The migration clears the
 * completion marker — `writeState` cannot, since it COALESCEs `completed_at` —
 * so `load()` sees a stale index, keeps serving it, and refreshes it. On a
 * brand-new database the marker is already NULL.
 * Version 2: header-keyed code tables and synthesized JT/EC/PR titles.
 * Version 3: the `frequency` column (CU, CW, LN) and the CM/CI surveys.
 * Version 4: independently optional coverage columns and complete survey decoding.
 * Version 5: the decoded `measure` column, and the OE code tables
 * (`bls_oews_tables`) OEWS composition reads.
 */
const CATALOG_INDEX_VERSION = 5;

/** Code-table key (the key column values joined by a tab, which no field contains) → label. */
type CodeLabels = Map<string, string>;

/**
 * A dimension resolved against one `.series` header: its key column indices,
 * its labels, and the decoder a row carrying its fallback code reads instead.
 */
interface Decoder {
  cols: number[];
  fallback?: { code: string; decoder: Decoder };
  labels: CodeLabels;
}

function warn(message: string): void {
  process.stderr.write(`[bls-labor-mcp-server] Catalog: ${message}\n`);
}

/**
 * Wait `ms` — or, with no `ms`, one event-loop turn — and throw the abort
 * reason if `signal` aborts first.
 */
async function pause(signal: AbortSignal, ms?: number): Promise<void> {
  const wait =
    ms === undefined ? nextTurn(undefined, { signal }) : sleep(ms, undefined, { signal });
  await wait.catch(() => signal.throwIfAborted());
}

/** Each indexed survey's row count, by code in sorted order — one covering scan of the `survey_abbr` index. */
function surveyCounts(db: SqliteHandle): Map<string, number> {
  const rows = db
    .prepare<{ survey_abbr: string; n: number }>(
      `SELECT survey_abbr, COUNT(*) AS n FROM ${CATALOG_TABLE} GROUP BY survey_abbr ORDER BY survey_abbr`,
    )
    .all();
  return new Map(rows.map((r) => [r.survey_abbr, r.n]));
}

/** Distinct survey codes in the index, sorted — a covering scan of the `survey_abbr` index. */
function distinctSurveys(db: SqliteHandle): string[] {
  return db
    .prepare<{ survey_abbr: string }>(
      `SELECT DISTINCT survey_abbr FROM ${CATALOG_TABLE} ORDER BY survey_abbr`,
    )
    .all()
    .map((r) => r.survey_abbr);
}

/**
 * Split a LABSTAT line into trimmed fields. Files are tab-delimited, except a
 * few space-padded code tables (`ec.group`) whose columns are separated by runs
 * of two or more spaces.
 */
function splitFields(line: string, spaced: boolean): string[] {
  return (spaced ? line.trim().split(/\s{2,}/) : line.split('\t')).map((f) => f.trim());
}

/**
 * Parse a code table by its header: the code from the `key` column(s), the
 * label from the first `_text`/`_name` column. Space-delimited when the header
 * holds no tab. Returns undefined when the header lacks a key or label column.
 */
function parseCodeTable(text: string, key: readonly string[]): CodeLabels | undefined {
  const [headerLine = '', ...lines] = text.split('\n');
  const spaced = !headerLine.includes('\t');
  const header = splitFields(headerLine, spaced).map((h) => h.toLowerCase());
  const keyCols = key.map((k) => header.indexOf(k));
  const labelCol = header.findIndex((h) => h.endsWith('_text') || h.endsWith('_name'));
  if (keyCols.includes(-1) || labelCol < 0) return;

  const labels: CodeLabels = new Map();
  for (const line of lines) {
    const parts = splitFields(line, spaced);
    const code = keyCols.map((i) => parts[i] ?? '');
    const label = parts[labelCol];
    if (label && code.every(Boolean)) labels.set(code.join('\t'), label);
  }
  return labels.size > 0 ? labels : undefined;
}

/** A four-digit catalog year, absent when blank, malformed, or zero. */
function coverageYear(value: string | undefined): number | undefined {
  if (value?.length !== 4) return;
  const year = Number(value);
  return Number.isInteger(year) && year > 0 && String(year) === value ? year : undefined;
}

/**
 * A row's decoded label for a dimension — through its fallback when the row
 * carries the fallback code; undefined when its code is not in the table.
 */
function decode(decoder: Decoder | undefined, parts: string[]): string | undefined {
  if (!decoder) return;
  const { cols, fallback, labels } = decoder;
  const code = cols.map((i) => parts[i] ?? '').join('\t');
  return fallback && code === fallback.code ? decode(fallback.decoder, parts) : labels.get(code);
}

/**
 * Parse a `.series` file into catalog entries, decoding each row's area, item,
 * measure, frequency, and — when the row has no `series_title` — its synthesized title
 * through the survey's code tables (`tables`: table suffix → file text). Two
 * bodies yield no entries, so the survey keeps its indexed rows: one whose
 * header has no `series_id` column (an HTML error page served with a 200), and
 * one that ends mid-line. Every LABSTAT file ends in a line break; a
 * close-delimited response cut short resolves with a partial body instead of
 * rejecting, and parsing it would delete the missing tail and index the
 * fragment of its last line. Missing or structurally unusable declared code
 * tables also keep the survey's prior rows rather than replacing decoded data.
 * The measure table is the exception for a survey with no indexed rows
 * (`measureRequired` false): it only labels mirror-served series (#127), so
 * such a survey indexes without a measure rather than not at all.
 */
function parseSeries(
  text: string,
  survey: SurveyDefinition,
  tables: ReadonlyMap<string, string>,
  measureRequired: boolean,
): CatalogSeries[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  if (lines.at(-1) !== '') {
    warn(`${survey.abbr}.series ends mid-line — a truncated download; its indexed rows are kept.`);
    return [];
  }

  const header = splitFields(lines[0] ?? '', false).map((h) => h.toLowerCase());
  const seriesIdCol = header.indexOf('series_id');
  if (seriesIdCol < 0) {
    warn(`${survey.abbr}.series has no series_id header column — its indexed rows are kept.`);
    return [];
  }
  const titleCol = header.indexOf('series_title');
  const seasonalCol = header.findIndex((h) => h.includes('seasonal'));
  const startYearCol = header.indexOf('begin_year');
  const endYearCol = header.indexOf('end_year');
  const endPeriodCol = header.indexOf('end_period');
  const footnoteUnlabeled = survey.footnoteUnlabeled && !header.includes('footnote_codes');

  const parsedTables = new Map<string, CodeLabels | undefined>();
  let incomplete = false;
  const resolve = (dimension: CodeDimension | undefined): Decoder | undefined => {
    if (!dimension) return;
    const { table, key } = dimension;
    const text = tables.get(table);
    if (text === undefined) {
      incomplete = true;
      return;
    }
    const cacheKey = `${table}\t${key.join('\t')}`;
    if (!parsedTables.has(cacheKey)) {
      const labels = parseCodeTable(text, key);
      if (!labels) {
        warn(
          `${survey.abbr}.${table} header lacks ${key.join(' + ')} or a *_text/*_name label, or has no usable rows.`,
        );
      }
      parsedTables.set(cacheKey, labels);
    }
    const labels = parsedTables.get(cacheKey);
    const cols = key.map((k) => header.indexOf(k));
    if (!labels || cols.includes(-1)) {
      incomplete = true;
      if (labels) warn(`${survey.abbr}.series header lacks ${key.join(' + ')}.`);
      return;
    }
    if (!dimension.fallback) return { cols, labels };
    const fallback = resolve(dimension.fallback.dimension);
    return (
      fallback && { cols, labels, fallback: { code: dimension.fallback.code, decoder: fallback } }
    );
  };

  const area = resolve(survey.area);
  const item = resolve(survey.item);
  const frequencyDecoder = resolve(survey.frequency);
  const titleDecoders = survey.title ? survey.title.map(resolve) : [item, area];
  if (incomplete) return [];
  const measureDecoder = resolve(survey.measure);
  if (incomplete && measureRequired) return [];
  const surveyAbbr = survey.abbr.toUpperCase();

  const entries: CatalogSeries[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = splitFields(line, false);
    const coverageOffset = footnoteUnlabeled && parts.length === header.length + 1 ? 1 : 0;
    const startYear = coverageYear(
      startYearCol < 0 ? undefined : parts[startYearCol + coverageOffset],
    );
    const endYear = coverageYear(endYearCol < 0 ? undefined : parts[endYearCol + coverageOffset]);
    const endPeriod = endPeriodCol < 0 ? undefined : parts[endPeriodCol + coverageOffset];
    const seriesId = parts[seriesIdCol];
    if (!seriesId) continue;

    const areaName = decode(area, parts);
    const itemName = decode(item, parts);
    const measure = decode(measureDecoder, parts);
    const frequency = decode(frequencyDecoder, parts);
    const title =
      (titleCol >= 0 ? parts[titleCol] : undefined) ||
      [survey.name, ...titleDecoders.map((d) => decode(d, parts))]
        .filter((p): p is string => Boolean(p))
        .join(' - ');

    const seasonCode = seasonalCol >= 0 ? parts[seasonalCol] : undefined;
    const seasonal = seasonCode
      ? seasonCode.toUpperCase() === 'S' || seasonCode === 'seasonally adjusted'
      : false;

    entries.push({
      seriesId,
      title,
      surveyAbbr,
      ...(areaName && { areaName }),
      ...(itemName && { itemName }),
      ...(measure && { measure }),
      ...(frequency && { frequency }),
      ...(startYear !== undefined && { startYear }),
      ...(endYear !== undefined && { endYear }),
      ...(endPeriod && { endPeriod }),
      seasonal,
    });
  }
  return entries;
}

/** Map a parsed catalog entry to a SQLite row. `seasonal` is stored as 0/1 (no boolean affinity). */
function toRow(s: CatalogSeries): MirrorRow {
  return {
    series_id: s.seriesId,
    title: s.title,
    survey_abbr: s.surveyAbbr,
    area_name: s.areaName ?? null,
    item_name: s.itemName ?? null,
    seasonal: s.seasonal ? 1 : 0,
    frequency: s.frequency ?? null,
    start_year: s.startYear ?? null,
    end_year: s.endYear ?? null,
    end_period: s.endPeriod ?? null,
    measure: s.measure ?? null,
  };
}

/** Map a SQLite row back to a catalog entry. */
function toCatalog(row: MirrorRow): CatalogSeries {
  return {
    seriesId: row.series_id as string,
    title: row.title as string,
    surveyAbbr: row.survey_abbr as string,
    ...(row.area_name != null ? { areaName: row.area_name as string } : {}),
    ...(row.item_name != null ? { itemName: row.item_name as string } : {}),
    ...(row.frequency != null ? { frequency: row.frequency as string } : {}),
    ...(row.start_year != null ? { startYear: row.start_year as number } : {}),
    ...(row.end_year != null ? { endYear: row.end_year as number } : {}),
    ...(row.end_period != null ? { endPeriod: row.end_period as string } : {}),
    ...(row.measure != null ? { measure: row.measure as string } : {}),
    seasonal: row.seasonal === 1,
  };
}

/**
 * The index-version migration. It runs after the declarative
 * `CREATE TABLE IF NOT EXISTS`, which never alters an existing table: an index
 * from an earlier release gains every missing frequency/coverage/measure column,
 * while a brand-new database already has them. Both gain the OE code-table store.
 * Then it clears the completion marker so the next `load()` re-harvests.
 */
function migrateCatalogIndex(db: SqliteHandle): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${OEWS_TABLES_TABLE} (name TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID`,
  );
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${CATALOG_TABLE})`).all();
  for (const [name, type] of Object.entries({
    frequency: 'TEXT',
    start_year: 'INTEGER',
    end_year: 'INTEGER',
    end_period: 'TEXT',
    measure: 'TEXT',
  })) {
    if (!columns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE ${CATALOG_TABLE} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec('UPDATE mirror_sync_state SET completed_at = NULL WHERE id = 1');
}

/**
 * Build the SQLite-backed catalog store. The FTS5 index spans the text columns
 * the rescorer reads (series id, title, area, item); `survey_abbr`/`seasonal`
 * are indexed for the structured filters. `frequency` is a plain column: FTS
 * would let "annual" match "semi-annual" rows. Exported so tests can seed a
 * store at the same path/schema the service opens.
 */
export function createCatalogStore(dbPath: string): MirrorStore {
  return sqliteMirrorStore({
    path: dbPath || ':memory:',
    version: CATALOG_INDEX_VERSION,
    migrations: [{ version: CATALOG_INDEX_VERSION, up: migrateCatalogIndex }],
    table: CATALOG_TABLE,
    primaryKey: 'series_id',
    columns: {
      series_id: 'TEXT',
      title: 'TEXT',
      survey_abbr: 'TEXT',
      area_name: 'TEXT',
      item_name: 'TEXT',
      seasonal: 'INTEGER',
      frequency: 'TEXT',
      start_year: 'INTEGER',
      end_year: 'INTEGER',
      end_period: 'TEXT',
      measure: 'TEXT',
    },
    fts: ['series_id', 'title', 'area_name', 'item_name'],
    indexes: [{ columns: ['survey_abbr'] }, { columns: ['seasonal'] }],
  });
}

export class BlsCatalogService {
  private readonly store: MirrorStore;
  private loaded = false;
  private loadError: string | undefined;
  private cachedTotal = 0;
  private cachedSurveys: readonly string[] = [];
  /** Each indexed survey's row count, read with the totals (#121). */
  private cachedSurveyCounts: ReadonlyMap<string, number> = new Map();
  /** The stored OE code tables; undefined until a harvest stores a usable set (#119). */
  private oewsTables: OewsTables | undefined;
  /** Decoded area-name parts by distinctive word (`indexAreaParts`). */
  private areaParts: ReadonlyMap<string, readonly AreaPart[]> = new Map();
  /** Survey code → the latest `end_year` of its rows; the reference for a row's currency. */
  private newestYears: ReadonlyMap<string, number> = new Map();
  /** The decoded areas each state and area code of the `area` filter resolves to. */
  private areaIndex: AreaIndex = { codes: new Map(), states: new Map() };
  /** The surveys this deployment harvests, and their list as the sync state persists it. */
  private readonly surveys: readonly SurveyDefinition[];
  private readonly surveyList: string;
  /** The running load, shared by every concurrent `load()` call. */
  private inFlight: Promise<void> | undefined;
  /** Aborted by `shutdown()`; every fetch, backoff, and write of a harvest observes it. */
  private readonly stopping = new AbortController();
  /** Checks this process has run: every `load()` that starts a run, not one that joins it. */
  private checks = 0;
  /**
   * Each configured survey's refresh record, by abbreviation, for the life of
   * the process. Undefined until the first check; a restart starts over, so an
   * index left incomplete re-harvests every survey.
   */
  private schedule: Map<string, SurveyRefresh> | undefined;

  constructor(
    private readonly catalogBaseUrl: string,
    private readonly userAgent: string,
    dbPath = '',
    private readonly cacheTtlHours = 168,
    /** Whether the harvest includes the opt-in OES/OEWS survey (`BLS_CATALOG_INCLUDE_OES`). */
    readonly includeOes = false,
  ) {
    this.store = createCatalogStore(dbPath);
    this.surveys = configuredSurveys(includeOes);
    this.surveyList = catalogSurveyList(includeOes);
  }

  /**
   * Re-read totals and per-survey counts and rebuild the geographic vocabulary,
   * the area-filter index, and each survey's newest year. Runs on the first
   * load and after each harvest — the index changes only then — so neither
   * search nor bls_list_surveys pays for it. `count()` runs first so the store
   * finishes opening inside its own call, before `raw()` hands out the handle.
   */
  private async readIndexStats(): Promise<void> {
    this.cachedTotal = await this.store.count();
    const db = await this.store.raw();
    this.cachedSurveyCounts = surveyCounts(db);
    this.cachedSurveys = [...this.cachedSurveyCounts.keys()];
    const areas = db
      .prepare<{ area_name: string }>(
        `SELECT DISTINCT area_name FROM ${CATALOG_TABLE} WHERE area_name IS NOT NULL`,
      )
      .all()
      .map((r) => r.area_name);
    this.areaParts = indexAreaParts(areas);
    // Each area code a SeriesID carries, with the area it names; `types` are
    // LAUS area types, the SeriesID's characters 4–5.
    const coded = AREA_CODE_SOURCES.flatMap(({ survey, types = [], start, length }) =>
      db
        .prepare<{ area: string; code: string }>(
          `SELECT DISTINCT substr(series_id, ?, ?) AS code, area_name AS area FROM ${CATALOG_TABLE}
           WHERE survey_abbr = ? AND area_name IS NOT NULL
           ${types.length > 0 ? `AND substr(series_id, 4, 2) IN (${types.map(() => '?').join(',')})` : ''}`,
        )
        .all(start, length, survey, ...types),
    );
    this.areaIndex = indexAreas(areas, coded);
    const newest = db
      .prepare<{ survey_abbr: string; newest: number }>(
        `SELECT survey_abbr, MAX(end_year) AS newest FROM ${CATALOG_TABLE}
         WHERE end_year IS NOT NULL GROUP BY survey_abbr`,
      )
      .all();
    this.newestYears = new Map(newest.map((r) => [r.survey_abbr, r.newest]));
  }

  /**
   * Run one check of the on-disk index, serving an existing index throughout
   * (queryable during any refresh). An index with no series harvests every
   * configured survey, retrying a fully empty harvest up to `maxAttempts` times
   * with linear backoff. Otherwise the check harvests only the surveys due, in
   * one attempt: a survey whose last success is older than the TTL, and a
   * failed survey whose backoff ran out — retried at the next check, then
   * after 2, 4, 8 … checks, the gap capped at the TTL in hours (one check runs
   * per hour). The first check seeds every survey's last success from the
   * stored completion only when the store records a complete harvest of the
   * configured survey list, so an incomplete refresh, a changed list, or an
   * index-version upgrade makes every survey due. A check with nothing due
   * does no I/O. The sync state turns `complete` only once every configured
   * survey has succeeded, with `completedAt` the oldest success.
   *
   * Concurrent calls — the boot load and an hourly refresh tick — share one
   * in-flight run, so a second harvest never starts while one is running. A
   * run that `shutdown()` stops rejects with the shutdown reason. A rejected
   * run records its reason, which `readiness` reports while the index holds no
   * series.
   */
  load(maxAttempts = 3): Promise<void> {
    this.inFlight ??= this.refresh(maxAttempts)
      .catch((error: unknown) => {
        this.loadError = `Catalog load stopped: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async refresh(maxAttempts: number): Promise<void> {
    const { signal } = this.stopping;
    signal.throwIfAborted();
    const check = ++this.checks;
    if (!this.loaded) {
      await this.readIndexStats();
      this.oewsTables ??= await this.readStoredOewsTables();
    }
    const existing = this.cachedTotal;
    let due = this.surveys;
    let tablesDue = true;
    if (existing > 0) {
      this.loaded = true;
      this.loadError = undefined;
      this.schedule ??= this.scheduleFrom(await this.store.readState());
      const schedule = this.schedule;
      const nowMs = Date.now();
      due = this.surveys.filter((s) => this.isDue(schedule.get(s.abbr), check, nowMs));
      tablesDue = this.isDue(schedule.get(OEWS_TABLES), check, nowMs);
      if (due.length === 0 && !tablesDue) return; // warm, nothing due
    }

    // Only an index with no series repeats a harvest that applied nothing.
    const attempts = existing > 0 ? 1 : maxAttempts;
    let { applied, failed, oeTables } = await this.harvest(due, signal);
    for (let attempt = 1; attempt < attempts && applied === 0; attempt++) {
      await pause(signal, attempt * 5_000);
      ({ applied, failed, oeTables } = await this.harvest(due, signal));
    }
    const tablesFailure = tablesDue ? await this.harvestOewsTables(signal, oeTables) : undefined;

    // An index still holding no series retries every survey at the next check.
    const empty = existing === 0 && applied === 0;
    if (!empty) {
      const harvested = [...due.map((s) => s.abbr), ...(tablesDue ? [OEWS_TABLES] : [])];
      const failedUnits = new Set(failed.keys());
      if (tablesFailure !== undefined) failedUnits.add(OEWS_TABLES);
      this.record(check, harvested, failedUnits);
    }
    for (const [abbr, failure] of failed) {
      const retry = this.nextRetry(abbr, check, empty);
      warn(
        failure.outcome === 'series_unavailable'
          ? `${abbr}.series unavailable (${failure.cause}) — its indexed rows are kept; ${retry}.`
          : `${abbr} not refreshed — its indexed rows are kept; ${retry}.`,
      );
    }
    if (tablesFailure !== undefined) {
      warn(
        `OE code tables not refreshed (${tablesFailure}) — the stored tables are kept; ${this.nextRetry(OEWS_TABLES, check, empty)}.`,
      );
    }

    if (applied > 0) {
      await this.readIndexStats();
      this.loaded = true;
      this.loadError = undefined;
      signal.throwIfAborted();
      const completedAtMs = this.oldestSuccess();
      await this.store.writeState({
        status: completedAtMs === undefined ? 'error' : 'complete',
        ...(completedAtMs !== undefined && { completedAt: new Date(completedAtMs).toISOString() }),
        total: this.cachedTotal,
        checkpoint: this.surveyList,
      });
      return;
    }

    if (existing > 0) {
      // Refresh fetched nothing, but a prior index is still queryable — keep
      // serving it and retry on the next hourly check rather than tearing it down.
      // A check that refreshed only the OE code tables fetched what was due.
      if (due.length > 0) {
        process.stderr.write(
          '[bls-labor-mcp-server] Catalog refresh fetched no rows — serving the existing index.\n',
        );
      }
      return;
    }

    this.loaded = true; // empty, but loaded: `readiness` reports it unavailable with this error
    this.loadError = `Catalog load failed after ${maxAttempts} ${maxAttempts === 1 ? 'attempt' : 'attempts'} — all LABSTAT downloads returned empty.`;
    signal.throwIfAborted();
    await this.store.writeState({ status: 'error', error: this.loadError });
  }

  /**
   * The first check's schedule, from the stored sync state: every survey last
   * succeeded at the stored completion when the state records a complete
   * harvest of the configured survey list (persisted in `checkpoint`). The OE
   * code tables do not hold the state incomplete, so a completion vouches for
   * them only when a usable set is stored; without one they are due. Otherwise —
   * an incomplete refresh, a missing list (an index from an earlier release), a
   * different list, or a completion an index-version migration cleared —
   * nothing has a record, so all is due.
   */
  private scheduleFrom({ status, completedAt, checkpoint }: SyncState): Map<string, SurveyRefresh> {
    const succeededAtMs = Date.parse(completedAt ?? '');
    if (
      status !== 'complete' ||
      checkpoint !== this.surveyList ||
      !Number.isFinite(succeededAtMs)
    ) {
      return new Map();
    }
    const current = [...this.surveys.map((s) => s.abbr), ...(this.oewsTables ? [OEWS_TABLES] : [])];
    return new Map(
      current.map((unit): [string, SurveyRefresh] => [unit, { state: 'current', succeededAtMs }]),
    );
  }

  /** Whether a survey is due at `check`: no record, a lapsed TTL, or a backoff that ran out. */
  private isDue(record: SurveyRefresh | undefined, check: number, nowMs: number): boolean {
    if (!record) return true;
    if (record.state === 'failing') return check >= record.retryCheck;
    return nowMs - record.succeededAtMs > this.cacheTtlHours * 3_600_000;
  }

  /**
   * Record a check's outcome for the units it harvested — surveys by
   * abbreviation, and the OE code tables: a success restarts TTL scheduling
   * from now; a failure doubles the gap to its next retry (1, 2, 4 … checks),
   * capped at the TTL in hours.
   */
  private record(check: number, harvested: readonly string[], failed: ReadonlySet<string>): void {
    this.schedule ??= new Map();
    const schedule = this.schedule;
    const nowMs = Date.now();
    const maxGap = Math.max(1, this.cacheTtlHours);
    for (const unit of harvested) {
      if (!failed.has(unit)) {
        schedule.set(unit, { state: 'current', succeededAtMs: nowMs });
        continue;
      }
      const prior = schedule.get(unit);
      const failures = (prior?.state === 'failing' ? prior.failures : 0) + 1;
      const gap = Math.min(2 ** (failures - 1), maxGap);
      schedule.set(unit, { state: 'failing', failures, retryCheck: check + gap });
    }
  }

  /** When a survey that failed at `check` is tried next, for its stderr line. */
  private nextRetry(abbr: string, check: number, empty: boolean): string {
    const record = this.schedule?.get(abbr);
    const gap = !empty && record?.state === 'failing' ? record.retryCheck - check : 1;
    return gap === 1 ? 'next retry at the next hourly check' : `next retry in ${gap} hourly checks`;
  }

  /** The oldest last success across the configured surveys; undefined while any is not current. */
  private oldestSuccess(): number | undefined {
    let oldest = Number.POSITIVE_INFINITY;
    for (const { abbr } of this.surveys) {
      const record = this.schedule?.get(abbr);
      if (record?.state !== 'current') return;
      oldest = Math.min(oldest, record.succeededAtMs);
    }
    return oldest;
  }

  /**
   * Fetch the OE code tables composition reads and, once all three arrive and
   * parse, replace the stored set in one transaction and serve it. Returns why
   * the set was not replaced — each failed request or body read, or an unusable
   * table — or undefined once it is; the stored set stays in force meanwhile.
   * Fetched whatever the OES opt-in: the tables are small, and composition runs
   * whenever the index holds no OE rows. Every request also aborts on `signal`,
   * and an abort rejects. Tables the OE survey's own harvest already fetched
   * (`loaded`, by table suffix) are reused rather than requested again.
   */
  private async harvestOewsTables(
    signal: AbortSignal,
    loaded: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    const download = async (name: OewsTableName): Promise<string> => {
      const fetched = loaded.get(name);
      if (fetched !== undefined) return fetched;
      const res = await fetch(
        `${this.catalogBaseUrl}/${OES_SURVEY_ABBR}/${OES_SURVEY_ABBR}.${name}`,
        {
          headers: { 'User-Agent': this.userAgent },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    };
    const results = await Promise.allSettled(OEWS_TABLE_NAMES.map(download));
    signal.throwIfAborted();

    const bodies: Partial<Record<OewsTableName, string>> = {};
    const failures: string[] = [];
    for (const [i, name] of OEWS_TABLE_NAMES.entries()) {
      const result = results[i];
      if (result?.status === 'fulfilled') {
        bodies[name] = result.value;
        continue;
      }
      const error: unknown = result?.reason;
      const cause =
        error instanceof Error
          ? error.cause instanceof Error
            ? `${error.message}: ${error.cause.message}`
            : error.message
          : String(error);
      failures.push(`oe.${name}: ${cause}`);
    }
    const { area, occupation, datatype } = bodies;
    if (area === undefined || occupation === undefined || datatype === undefined) {
      return failures.join('; ');
    }
    const tables = parseOewsTables({ area, occupation, datatype });
    if (!tables) return 'a table lacks a required column or has no usable rows';

    const db = await this.store.raw();
    const upsert = db.prepare(
      `INSERT INTO ${OEWS_TABLES_TABLE} (name, body) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body`,
    );
    db.transaction(() => {
      for (const [name, body] of Object.entries({ area, occupation, datatype }))
        upsert.run(name, body);
    });
    this.oewsTables = tables;
    return;
  }

  /** The stored OE code tables, parsed; undefined while no usable set is stored. */
  private async readStoredOewsTables(): Promise<OewsTables | undefined> {
    const rows = (await this.store.raw())
      .prepare<{ name: string; body: string }>(`SELECT name, body FROM ${OEWS_TABLES_TABLE}`)
      .all();
    const bodies = new Map(rows.map((r) => [r.name, r.body]));
    const area = bodies.get('area');
    const occupation = bodies.get('occupation');
    const datatype = bodies.get('datatype');
    if (area === undefined || occupation === undefined || datatype === undefined) return;
    return parseOewsTables({ area, occupation, datatype });
  }

  /**
   * Fetch `surveys` with bounded concurrency and upsert the parsed rows into
   * the store in chunks. After a survey's upserts, its indexed rows absent from
   * the new `.series` file are deleted; once every survey is done, so are the
   * rows of surveys no longer configured (OES after its opt-in turns off) —
   * judged against the whole configured list, so a harvest of some surveys
   * leaves the others' rows alone. A survey that yields no rows (`SurveyLoad`)
   * keeps its rows, and a harvest that applies no rows deletes nothing. Returns
   * the rows applied and each failed survey's outcome, by abbreviation.
   */
  private async harvest(
    surveys: readonly SurveyDefinition[],
    signal: AbortSignal,
  ): Promise<{
    applied: number;
    failed: Map<string, SurveyFailure>;
    oeTables: ReadonlyMap<string, string>;
  }> {
    let applied = 0;
    let oeTables: ReadonlyMap<string, string> = new Map();
    const failed = new Map<string, SurveyFailure>();
    for (let i = 0; i < surveys.length; i += SURVEY_FETCH_CONCURRENCY) {
      const batch = surveys.slice(i, i + SURVEY_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((survey) => this.loadSurvey(survey, signal)),
      );
      for (const [k, { abbr }] of batch.entries()) {
        signal.throwIfAborted();
        const result = results[k];
        if (result?.status !== 'fulfilled') {
          warn(`${abbr} harvest failed: ${String(result?.reason)}`);
          failed.set(abbr, { outcome: 'unusable' });
          continue;
        }
        if (result.value.outcome !== 'indexed') {
          failed.set(abbr, result.value);
          continue;
        }
        const { entries, tables } = result.value;
        if (abbr === OES_SURVEY_ABBR) oeTables = tables;
        for (let j = 0; j < entries.length; j += HARVEST_CHUNK_SIZE) {
          const chunk = entries.slice(j, j + HARVEST_CHUNK_SIZE);
          signal.throwIfAborted();
          await this.store.applyBatch(chunk.map(toRow), []);
          applied += chunk.length;
          await pause(signal);
        }
        const [first] = entries;
        if (first) {
          await this.deleteRows(first.surveyAbbr, new Set(entries.map((s) => s.seriesId)), signal);
        }
      }
    }

    if (applied > 0) {
      const configured = new Set(this.surveys.map((s) => s.abbr.toUpperCase()));
      for (const survey of distinctSurveys(await this.store.raw())) {
        if (!configured.has(survey)) await this.deleteRows(survey, undefined, signal);
      }
    }
    return { applied, failed, oeTables };
  }

  /**
   * Delete `survey`'s indexed rows whose series id is not in `keep` — every row
   * when `keep` is omitted. Walks the survey's rows a chunk at a time in rowid
   * order off the `survey_abbr` index, deleting each chunk's stale ids in one
   * transaction and yielding a turn between chunks, so no transaction spans a
   * whole survey.
   */
  private async deleteRows(
    survey: string,
    keep: ReadonlySet<string> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const page = (await this.store.raw()).prepare<{ rowid: number; series_id: string }>(
      `SELECT rowid, series_id FROM ${CATALOG_TABLE}
       WHERE survey_abbr = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
    );
    let after = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = page.all(survey, after, HARVEST_CHUNK_SIZE);
      const last = rows.at(-1);
      if (!last) return;
      after = last.rowid;
      const stale = rows.filter((r) => !keep?.has(r.series_id)).map((r) => r.series_id);
      if (stale.length > 0) await this.store.applyBatch([], stale);
      await pause(signal);
    }
  }

  /**
   * Fetch a survey's `.series` file and the code tables its dimensions name,
   * then parse. A failed `.series` request or body read returns its cause; a
   * failed or unusable declared table, or a `.series` body the parser refuses,
   * reports itself on stderr and returns `unusable`. Either preserves the
   * survey's previous snapshot. Every request also aborts on `signal`, and an
   * abort rejects rather than reading as a failed survey.
   */
  private async loadSurvey(survey: SurveyDefinition, signal: AbortSignal): Promise<SurveyLoad> {
    const { abbr } = survey;
    const url = (file: string) => `${this.catalogBaseUrl}/${abbr}/${abbr}.${file}`;
    const headers = { 'User-Agent': this.userAgent };
    const dimensions = [
      survey.area,
      survey.item,
      survey.measure,
      survey.frequency,
      ...(survey.title ?? []),
    ];
    const tableNames = [...new Set(dimensions.flatMap((d) => (d ? dimensionTables(d) : [])))];
    const request = (file: string, timeoutMs: number) =>
      fetch(url(file), {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });

    /**
     * Why a request or body read failed, rethrowing a shutdown's abort. Node's
     * fetch rejects with a bare "fetch failed" that carries the reason in `cause`.
     */
    const failure = (error: unknown): string => {
      signal.throwIfAborted();
      if (!(error instanceof Error)) return String(error);
      return error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message;
    };

    const [seriesRes, ...tableResults] = await Promise.allSettled([
      request('series', 30_000),
      ...tableNames.map((table) => request(table, 15_000)),
    ]);

    if (seriesRes.status === 'rejected') {
      return {
        outcome: 'series_unavailable',
        cause: `request failed: ${failure(seriesRes.reason)}`,
      };
    }
    if (!seriesRes.value.ok) {
      return { outcome: 'series_unavailable', cause: `HTTP ${seriesRes.value.status}` };
    }
    let seriesText: string;
    try {
      seriesText = await seriesRes.value.text();
    } catch (error) {
      return { outcome: 'series_unavailable', cause: `body read failed: ${failure(error)}` };
    }

    const warm = this.cachedSurveyCounts.has(abbr.toUpperCase());
    const tables = new Map<string, string>();
    for (const [i, table] of tableNames.entries()) {
      const res = tableResults[i];
      let cause: string;
      if (res?.status !== 'fulfilled') cause = 'request failed';
      else if (!res.value.ok) cause = `HTTP ${res.value.status}`;
      else {
        try {
          tables.set(table, await res.value.text());
          continue;
        } catch (error) {
          cause = `body read failed: ${failure(error)}`;
        }
      }
      // A survey with no indexed rows still indexes without its measure table (see parseSeries).
      const kept =
        warm || table !== survey.measure?.table
          ? 'its indexed rows are kept'
          : 'its rows index without a measure';
      warn(`${abbr}.${table} unavailable (${cause}) — ${kept}.`);
    }

    const entries = parseSeries(seriesText, survey, tables, warm);
    return entries.length > 0 ? { outcome: 'indexed', entries, tables } : { outcome: 'unusable' };
  }

  /**
   * Search the catalog. Narrows the on-disk index with an FTS5 candidate query
   * (plus a direct primary-key lookup so an exact SeriesID always surfaces), then
   * applies the bespoke relevance score over the small candidate set.
   */
  async search(input: CatalogSearchInput): Promise<CatalogSearchResult> {
    const readiness = this.readiness;
    if (readiness.status === 'loading') {
      throw serviceUnavailable('Catalog index is still being built — no series indexed yet.', {
        reason: 'catalog_loading',
        retryable: true,
      });
    }
    if (readiness.status === 'unavailable') {
      throw internalError(`Catalog index holds no series. ${readiness.error}`, {
        reason: 'catalog_unavailable',
      });
    }

    // OEWS SeriesIDs composed from the OE code tables while the index holds no OE rows (#119).
    const oewsTables = this.oewsComposition;
    const composed = oewsTables && composeOewsSearch(oewsTables, input);
    if (composed) return composed;

    const query = input.query.toLowerCase().trim();
    const queryUpper = query.toUpperCase();
    const surveyFilter = input.survey?.toUpperCase();
    const areaFilter = input.area?.toLowerCase();
    // A state or area code resolves to decoded area names; any other area is a substring.
    const resolvedArea = areaFilter ? resolveArea(areaFilter, this.areaIndex) : undefined;
    const seasonFilter = input.seasonal_adjustment;

    // Concept/synonym resolution: surveys whose canonical vocabulary the query
    // names but whose series titles never contain (e.g. "inflation" → CU). Their
    // candidates get a relevance boost in the rescore below, as do rows of a
    // publication frequency the query names ("quarterly unemployment rate").
    const fired = firedAliases(query);
    const aliasSurveys = new Set(fired.flatMap((a) => a.surveys));
    const frequencies = queryFrequencies(query);
    // Each distinct token once, up to MAX_QUERY_TOKENS: a repeat adds nothing
    // to the match, and the FTS query and the rescore both cost per token.
    const tokens = [...new Set(query.match(/[a-z0-9]+/g))].slice(0, MAX_QUERY_TOKENS);
    // The core measures `core` names beside their survey's alias, within the survey filter.
    const coreMeasures = tokens.includes('core')
      ? CORE_MEASURES.filter(
          (m) => aliasSurveys.has(m.survey) && (!surveyFilter || surveyFilter === m.survey),
        )
      : [];

    // Candidate set: an exact-id lookup (guarantees the precise SeriesID is in
    // play) unioned with the FTS5 matches, deduped by series id.
    const candidates = new Map<string, CatalogSeries>();

    const exact = await this.store.getByIds([input.query.trim().toUpperCase()]);
    for (const row of exact) candidates.set(row.series_id as string, toCatalog(row));

    // The core measures a query names are candidates whatever its other words
    // match, ahead of the headlines so they keep the ties a core query makes.
    if (coreMeasures.length > 0) {
      for (const row of await this.coreRows(coreMeasures)) {
        candidates.set(row.series_id as string, toCatalog(row));
      }
    }

    // Headline common series are always candidates, independent of the FTS cap.
    // The bm25 pre-filter (CANDIDATE_LIMIT) can drop a headline series that matches
    // only one broad query term before the rescore's common-series boost can float
    // it up; unioning them in (mirroring the exact-id lookup above) restores it. The
    // `score === 0` gate below still excludes them from unrelated queries, so this
    // does not resurface them as false positives.
    const common = await this.store.getByIds(Object.keys(COMMON_SERIES));
    for (const row of common) candidates.set(row.series_id as string, toCatalog(row));

    let ftsCapped = false;
    const wholeShortTerms = tokens.filter((t) => t.length === 1).length > MAX_SHORT_PREFIXES;
    // A row matches every query word when it matches each word that is not a
    // function word, in its own text or through a concept alias its survey
    // answers to.
    const required = tokens.filter((t) => !FUNCTION_WORDS.has(t));
    const covered = aliasWords(fired, required);
    // Areas the query names, by its whole words: "seattle" in "seattleé" names nothing.
    const named = new Set<string>();
    if (!areaFilter) {
      const tokenSet = new Set(tokens);
      const words = new Set<string>();
      for (const [word] of query.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
        if (tokenSet.has(word)) words.add(word);
      }
      for (const area of namedAreas(this.areaParts, words)) named.add(area);
    }
    const wholeQueryEnd =
      wholeShortTerms &&
      tokens.some(
        (t) => t.length === 1 && query.endsWith(t) && !/[a-z0-9]/.test(query.at(-2) ?? ''),
      );
    const areaMatchable =
      !areaFilter ||
      (resolvedArea
        ? resolvedArea.areas.size > 0 || resolvedArea.state !== undefined
        : areaFilter.length <= MAX_AREA_LENGTH);
    if (tokens.length > 0 && areaMatchable) {
      const term = (t: string) => `"${t}"${wholeShortTerms && t.length === 1 ? '' : '*'}`;
      const every = (words: readonly string[]) => words.map(term).join(' AND ');
      // The rows that match every word, by the surveys an alias excuses from some of them.
      const allWords: AllWordsMatch[] = [];
      if (required.length > 0) {
        const bySurveys = new Map<string, string[]>();
        for (const [survey, words] of covered) {
          const key = every(required.filter((t) => !words.has(t)));
          bySurveys.set(key, [...(bySurveys.get(key) ?? []), survey]);
        }
        for (const [match, surveys] of bySurveys) allWords.push({ surveys, match });
        allWords.push({ match: every(required) });
      }
      const rows = await this.candidateRows(
        tokens.map(term).join(' OR '),
        surveyFilter,
        seasonFilter,
        resolvedArea ?? areaFilter,
        allWords,
        [...named],
      );
      // If the FTS query returned exactly CANDIDATE_LIMIT rows the full index likely
      // has more matches — total will be a lower bound.
      ftsCapped = rows.length >= CANDIDATE_LIMIT;
      for (const row of rows) candidates.set(row.series_id as string, toCatalog(row));
    }

    // Score each candidate. Exact series ID match = highest priority.
    const scored: RankedSeries[] = [];
    for (const s of candidates.values()) {
      if (surveyFilter && s.surveyAbbr.toUpperCase() !== surveyFilter) continue;
      if (typeof seasonFilter === 'boolean' && s.seasonal !== seasonFilter) continue;

      if (s.seriesId.toUpperCase() === queryUpper) {
        scored.push({
          s,
          exact: 1,
          allWords: 0,
          place: 0,
          score: 1000,
          current: 0,
          national: 0,
          aggregate: 0,
        });
        continue;
      }
      const survey = s.surveyAbbr.toUpperCase();
      const commonText = COMMON_SERIES[s.seriesId];
      const isCommon = commonText !== undefined;
      const isCore = coreMeasures.some(
        (m) => m.survey === survey && s.itemName !== undefined && m.items.includes(s.itemName),
      );

      const titleLower = s.title.toLowerCase();
      const areaLower = s.areaName?.toLowerCase() ?? '';
      const itemLower = s.itemName?.toLowerCase() ?? '';

      let score = 0;

      // Area filter as a hard gate. Also check titleLower to cover surveys
      // (e.g. LAUS) where areaName is not decoded from codes but the area
      // name appears directly in the series title. A state or area code
      // matches its resolved areas, and a state also an area-less row whose
      // title names it as a comma-separated part — the `candidateRows`
      // clause, mirrored.
      if (areaFilter) {
        const areaMatch = resolvedArea
          ? s.areaName !== undefined
            ? resolvedArea.areas.has(s.areaName)
            : resolvedArea.state !== undefined &&
              `, ${titleLower},`.includes(`, ${resolvedArea.state},`)
          : areaLower.includes(areaFilter) ||
            titleLower.includes(areaFilter) ||
            s.seriesId.toLowerCase().includes(areaFilter);
        if (!areaMatch) continue;
      }

      // Full-query and token matches count where a word starts, so "all" never
      // scores inside "seasonally". SeriesIDs are not words — their item and
      // area codes sit mid-ID (`SEHA` in CUSR0000SEHA) — so a token still scores
      // anywhere in one.
      if (startsWord(titleLower, query, wholeQueryEnd)) score += 10;
      if (commonText !== undefined && startsWord(commonText, query, wholeQueryEnd)) score += 15;

      // Token-level match. `matched` counts the tokens the row matches anywhere,
      // its headline description included, for the headline gate below;
      // `missing` counts the required words it matches nowhere, its survey's
      // alias words included. A core measure matches `core` itself.
      const aliasCovered = covered.get(survey);
      const idLower = s.seriesId.toLowerCase();
      const shortTerms = wholeShortTerms
        ? {
            title: wholeTerms(titleLower),
            area: wholeTerms(areaLower),
            item: wholeTerms(itemLower),
            id: wholeTerms(idLower),
            common: commonText ? wholeTerms(commonText) : undefined,
          }
        : undefined;
      let matched = 0;
      let missing = 0;
      for (const t of tokens) {
        const whole = t.length === 1 ? shortTerms : undefined;
        const inTitle = whole ? whole.title.has(t) : startsWord(titleLower, t);
        const inArea = whole ? whole.area.has(t) : startsWord(areaLower, t);
        const inItem = whole ? whole.item.has(t) : startsWord(itemLower, t);
        const inId = whole ? whole.id.has(t) : idLower.includes(t);
        /**
         * A function word is never required, so it weighs a quarter of a content
         * word: it still breaks ties ("per" in "Bacon, sliced, per lb."), but "of"
         * in a long EI title never outweighs an item match ("price of eggs").
         */
        const weight = FUNCTION_WORDS.has(t) ? 0.25 : 1;
        if (inTitle) score += 2 * weight;
        if (inArea) score += weight;
        if (inItem) score += weight;
        if (inId) score += 3 * weight;
        if (
          inTitle ||
          inArea ||
          inItem ||
          inId ||
          (whole ? whole.common?.has(t) : commonText && startsWord(commonText, t)) ||
          (isCore && t === 'core')
        ) {
          matched++;
        } else if (!FUNCTION_WORDS.has(t) && !aliasCovered?.has(t)) {
          missing++;
        }
      }

      const aliasHit = aliasSurveys.has(survey);
      if (aliasHit) score += ALIAS_SURVEY_BOOST;

      if (score === 0) continue;
      // The area bonus, after the zero-score gate: an in-area row the query does
      // not match (an always-unioned headline) never qualifies on its area alone.
      if (areaFilter) score += 5;
      // The item-match weight, after the zero-score gate: a frequency word
      // qualifies a match but never makes one on its own.
      if (s.frequency && frequencies.has(frequencyKey(s.frequency))) score += 1;
      // A headline earns its boost only when the query names it: through its
      // survey's alias, or by matching most of the distinct tokens scored. One shared
      // word ("all" in "All employees") does not make CES the answer to
      // "annual average all items". A core measure is the headline its core query
      // names, its alias always among them: it outscores rows matching `core`
      // inside another word ("Fiber cores and tubes").
      if ((isCommon || isCore) && (aliasHit || matched * 2 > tokens.length)) score += 8;
      const allWords = Number(required.length > 0 && missing === 0);
      // A place the query names counts only on a row that matches every other word.
      const place = Number(allWords === 1 && s.areaName !== undefined && named.has(s.areaName));
      // A row is current when its data runs to within a year of its survey's
      // newest row, so JT state rows and MP industries a year behind stay
      // current; unknown coverage counts as current.
      const newest = this.newestYears.get(survey);
      const current = Number(
        s.endYear === undefined || newest === undefined || s.endYear >= newest - 1,
      );
      const national = areaFilter ? 0 : Number(!s.areaName || NATIONAL_AREAS.has(s.areaName));
      // The JOLTS all-industry, all-size row its breakdowns tie.
      const aggregate = Number(
        survey === 'JT' &&
          s.title.includes(' - Total nonfarm - ') &&
          s.title.includes(' - All size classes - '),
      );
      scored.push({ s, exact: 0, allWords, place, score, current, national, aggregate });
    }

    // Exact IDs lead, then rows matching every query word — the place rows
    // the query names first among them — then score. At equal score, current
    // rows lead the rest, then national rows lead unless area is explicit,
    // then the JOLTS aggregate leads its breakdowns; remaining ties keep
    // candidate order.
    scored.sort(
      (a, b) =>
        b.exact - a.exact ||
        b.allWords - a.allWords ||
        b.place - a.place ||
        b.score - a.score ||
        b.current - a.current ||
        b.national - a.national ||
        b.aggregate - a.aggregate,
    );
    const total = scored.length;
    const offset = input.offset ?? 0;
    const series = scored.slice(offset, offset + input.limit).map((x) => x.s);
    return { series, total, capped: ftsCapped };
  }

  /**
   * The FTS candidate query: up to `CANDIDATE_LIMIT` rows matching `match`,
   * with structured filters applied so the cap bounds only rows that pass
   * them. Rows matching every required word (`allWords`) are admitted first,
   * those in an area the query names (`named`) leading them, then the rest in
   * bm25 order — rows with no decoded area included. The area is a
   * case-insensitive substring of `area_name`, `title`, or `series_id` — the
   * rescore's area gate, pushed down as bound `LIKE` parameters. A resolved
   * state or area code instead keeps rows whose `area_name` is one of its
   * areas (one JSON-array parameter) and, for a state, rows with no decoded
   * area whose title names it as a comma-separated part.
   * `MirrorStore.query` has no substring operator, hence the raw handle; the
   * SELECT keeps the store's own relevance form (FTS JOIN, `MATCH`, `bm25()`).
   */
  private async candidateRows(
    match: string,
    survey: string | undefined,
    seasonal: boolean | undefined,
    area: string | ResolvedArea | undefined,
    allWords: readonly AllWordsMatch[],
    named: readonly string[],
  ): Promise<MirrorRow[]> {
    const allWordsParams: SqlValue[] = [];
    const condition = ({ match }: AllWordsMatch) => {
      if (!match) return '1';
      allWordsParams.push(match);
      return `${CATALOG_TABLE}.rowid IN (SELECT rowid FROM ${CATALOG_FTS} WHERE ${CATALOG_FTS} MATCH ?)`;
    };
    let allWordsSql = '0';
    const fallback = allWords.find((m) => !m.surveys);
    if (fallback) {
      const branches = allWords.flatMap((m) => {
        if (!m.surveys) return [];
        allWordsParams.push(...m.surveys);
        return `WHEN ${CATALOG_TABLE}.survey_abbr IN (${m.surveys.map(() => '?').join(',')}) THEN ${condition(m)}`;
      });
      const otherwise = condition(fallback);
      allWordsSql =
        branches.length > 0 ? `CASE ${branches.join(' ')} ELSE ${otherwise} END` : otherwise;
    }
    const where = [`${CATALOG_FTS} MATCH ?`];
    const params: SqlValue[] = [match];
    if (survey) {
      where.push(`${CATALOG_TABLE}.survey_abbr = ?`);
      params.push(survey);
    }
    if (typeof seasonal === 'boolean') {
      where.push(`${CATALOG_TABLE}.seasonal = ?`);
      params.push(seasonal ? 1 : 0);
    }
    if (typeof area === 'string') {
      const pattern = `%${escapeLike(area)}%`;
      where.push(
        `(${AREA_MATCH_COLUMNS.map((c) => `${CATALOG_TABLE}.${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      params.push(...AREA_MATCH_COLUMNS.map(() => pattern));
    } else if (area) {
      const inAreas = `${CATALOG_TABLE}.area_name IN (SELECT value FROM json_each(?))`;
      params.push(JSON.stringify([...area.areas]));
      if (area.state === undefined) where.push(inAreas);
      else {
        where.push(
          `(${inAreas} OR (${CATALOG_TABLE}.area_name IS NULL AND (', ' || ${CATALOG_TABLE}.title || ',') LIKE ? ESCAPE '\\'))`,
        );
        params.push(`%, ${escapeLike(area.state)},%`);
      }
    }
    const db = await this.store.raw();
    // `area_name IN (…)` is NULL for a row with no decoded area; the IS NOT NULL
    // guard keeps such rows at 0, so they keep their bm25 place.
    const place =
      named.length > 0
        ? `(all_words AND area_name IS NOT NULL AND area_name IN (${named.map(() => '?').join(',')})) DESC, `
        : '';
    return db
      .prepare<MirrorRow>(
        `SELECT * FROM (
           SELECT ${CATALOG_TABLE}.*, ${allWordsSql} AS all_words, bm25(${CATALOG_FTS}) AS relevance
           FROM ${CATALOG_TABLE}
           JOIN ${CATALOG_FTS} ON ${CATALOG_TABLE}.rowid = ${CATALOG_FTS}.rowid
           WHERE ${where.join(' AND ')}
         )
         ORDER BY all_words DESC, ${place}relevance ASC LIMIT ?`,
      )
      .all(...allWordsParams, ...params, ...named, CANDIDATE_LIMIT);
  }

  /**
   * Every row of the given core measures (`CORE_MEASURES`), by survey and
   * decoded item, in SeriesID order. At most a few hundred rows (117 CU rows
   * and 4 WP rows on the 2026-11-01 files), found through the `survey_abbr` index.
   */
  private async coreRows(measures: readonly CoreMeasure[]): Promise<MirrorRow[]> {
    const where = measures
      .map((m) => `(survey_abbr = ? AND item_name IN (${m.items.map(() => '?').join(',')}))`)
      .join(' OR ');
    return (await this.store.raw())
      .prepare<MirrorRow>(`SELECT * FROM ${CATALOG_TABLE} WHERE ${where} ORDER BY series_id`)
      .all(...measures.flatMap((m) => [m.survey, ...m.items]));
  }

  /**
   * Look up catalog metadata for a set of SeriesIDs in one query. Used to hydrate
   * titles/area/item/measure onto mirror-sourced observations. Returns a map keyed by
   * SeriesID; ids absent from the catalog are simply omitted.
   */
  async lookupByIds(ids: string[]): Promise<Map<string, CatalogSeries>> {
    if (!this.loaded || ids.length === 0) return new Map();
    const rows = await this.store.getByIds(ids);
    return new Map(rows.map((row) => [row.series_id as string, toCatalog(row)]));
  }

  /**
   * Stop any in-flight harvest, wait for it to settle, then close the on-disk
   * SQLite index. The store reopens on its next call after `close()`, so a
   * harvest left running would keep writing to a reopened handle; aborting
   * first — the fetches, the retry backoff, and the check before every write
   * all observe it — means no write follows this call. The stopped `load()`
   * rejects with the shutdown reason for its caller to report. The store
   * lazy-opens, so closing one that was never queried is a no-op.
   */
  async shutdown(): Promise<void> {
    this.stopping.abort(new Error('Catalog harvest stopped by shutdown.'));
    await Promise.allSettled([this.inFlight]);
    await this.store.close();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get totalSeries(): number {
    return this.cachedTotal;
  }

  /**
   * Uppercase survey codes present in the index, sorted — what the index holds,
   * not what `SURVEYS` asks for: a survey whose download failed is absent (or
   * keeps its rows from an earlier harvest). Updated when a harvest completes.
   */
  get indexedSurveys(): readonly string[] {
    return this.cachedSurveys;
  }

  /** The stored OE code tables, whether or not search composes from them. */
  get storedOewsTables(): OewsTables | undefined {
    return this.oewsTables;
  }

  /** The OE code tables while search composes OEWS SeriesIDs: stored, and no OE rows indexed. */
  private get oewsComposition(): OewsTables | undefined {
    return this.cachedSurveyCounts.has(OES_SURVEY_ABBR.toUpperCase()) ? undefined : this.oewsTables;
  }

  /**
   * How bls_search_series reaches survey `abbr` (#121), from the counts cached
   * at load and after each harvest — no catalog query. Undefined until the
   * first load completes. A survey whose refresh failed stays `indexed` while
   * its earlier rows remain; OE reads `composed` while its code tables are
   * stored, the index holds none of its rows, and search can answer.
   */
  searchCoverage(abbr: string): SurveySearchCoverage | undefined {
    if (!this.loaded) return;
    const code = abbr.toUpperCase();
    const seriesIndexed = this.cachedSurveyCounts.get(code);
    if (seriesIndexed !== undefined) return { searchCoverage: 'indexed', seriesIndexed };
    const composed =
      code === OES_SURVEY_ABBR.toUpperCase() && this.cachedTotal > 0 && this.oewsComposition;
    return { searchCoverage: composed ? 'composed' : 'none' };
  }

  /**
   * Whether search can answer, from the indexed row total, the in-flight run,
   * and the last load's outcome. An index holding series stays `ready` through
   * every refresh, failed or not.
   */
  get readiness(): CatalogReadiness {
    if (this.cachedTotal > 0) return { status: 'ready' };
    if (this.inFlight) return { status: 'loading' };
    return { status: 'unavailable', error: this.loadError ?? 'No catalog load has run yet.' };
  }
}

let _service: BlsCatalogService | undefined;

export function initBlsCatalogService(_config: AppConfig, _storage: StorageService): void {
  const { catalogBaseUrl, userAgent, catalogDbPath, catalogCacheTtlHours, catalogIncludeOes } =
    getServerConfig();
  _service = new BlsCatalogService(
    catalogBaseUrl,
    userAgent,
    catalogDbPath,
    catalogCacheTtlHours,
    catalogIncludeOes,
  );
}

export function getBlsCatalogService(): BlsCatalogService {
  if (!_service) {
    throw new Error('BlsCatalogService not initialized — call initBlsCatalogService() in setup()');
  }
  return _service;
}

/**
 * Where to go instead of an OEWS SeriesID BLS reports nonexistent: its state
 * and national rows (`oewsFallbacks`), through the stored OE code tables when
 * the catalog has them — the national row alone otherwise. Undefined for a
 * national OEWS ID and for any other survey's ID. Shared by bls_get_series and
 * bls_get_latest, so both name the same rows in the same words.
 */
export function unpublishedOewsHint(seriesId: string): string | undefined {
  const fallbacks = oewsFallbacks(seriesId, _service?.storedOewsTables);
  if (fallbacks.length === 0) return;
  const rows = fallbacks
    .map((id) => `the ${id[3] === 'S' ? 'state' : 'national'} row ${id}`)
    .join(' or ');
  return `BLS leaves many OEWS occupation–area cells unpublished; request ${rows} for the same occupation and data type.`;
}

let refreshScheduled = false;

/**
 * Register and start the hourly catalog refresh on the framework scheduler,
 * on every transport. Each tick calls `load()`, one check: an index with no
 * series re-harvests every survey; otherwise only the surveys due — those
 * whose last success is older than the TTL, and failed surveys whose backoff
 * ran out (retried at the next check, then 2, 4, 8 … checks later, capped at
 * the TTL). A process's first check makes every survey due when the stored
 * harvest was incomplete or its survey list or index version changed. A check
 * with nothing due does no I/O. An hourly check rather than a
 * `setTimeout(ttl)`: timers clamp delays above 2^31−1 ms (~596 h), and
 * `BLS_CATALOG_CACHE_TTL_HOURS` has no upper bound. The scheduler skips a tick
 * while the previous one runs, and `load()` shares its in-flight run with the
 * boot load. `shutdownBlsCatalogService()` removes the job.
 */
export async function scheduleBlsCatalogRefresh(): Promise<void> {
  await schedulerService.schedule(
    CATALOG_REFRESH_JOB_ID,
    CATALOG_REFRESH_CRON,
    () => getBlsCatalogService().load(),
    'Hourly check that re-harvests the LABSTAT surveys whose TTL lapsed or whose failure backoff ran out, and every survey of an empty index.',
  );
  schedulerService.start(CATALOG_REFRESH_JOB_ID);
  refreshScheduled = true;
}

/**
 * Stop the refresh job, then stop any in-flight harvest and release the
 * catalog's SQLite handle. Wired to `createApp({ teardown })`.
 */
export async function shutdownBlsCatalogService(): Promise<void> {
  if (refreshScheduled) {
    schedulerService.remove(CATALOG_REFRESH_JOB_ID);
    refreshScheduled = false;
  }
  const service = _service;
  _service = undefined;
  await service?.shutdown();
}
