/**
 * @fileoverview BLS LABSTAT flat-file catalog service. Downloads each survey's
 * `{survey}.series` file and code tables from
 * `download.bls.gov/pub/time.series/{survey}/`, decodes them into a searchable
 * series index, and persists that index in an on-disk SQLite store
 * (the framework's FTS5-capable `sqliteMirrorStore`). Search runs as an FTS5
 * candidate query rescored by a bespoke relevance function — the index lives on
 * disk, not the JS heap, so large surveys do not inflate memory. No API quota is
 * consumed; the BLS FAQ confirms there is no API catalog endpoint. An hourly
 * scheduler job re-harvests the index once its TTL lapses, so a long-running
 * process stays current without a restart.
 * @module services/bls-catalog/bls-catalog-service
 */

import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
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
import type {
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogSeries,
  CodeDimension,
  SurveyDefinition,
} from './types.js';

/** A dimension keyed by `key` columns — by default the table's own `{table}_code`. */
function dim(table: string, ...key: string[]): CodeDimension {
  return { table, key: key.length > 0 ? key : [`${table}_code`] };
}

/**
 * Surveys fetched at startup. Chosen to cover >95% of real-world queries.
 * Each entry maps the LABSTAT file abbreviation to its program name and the
 * `.series` columns decoded through companion code tables: `area` and `item`
 * for every row, `frequency` for surveys that publish one series at several
 * frequencies under the same `series_title` (CU and CW monthly/semiannual, LN
 * monthly/quarterly/annual), and `title` for surveys whose `.series` file ships
 * no `series_title` (JT, EC, PR). Only the tables these dimensions name are
 * fetched, and each exists in the survey's LABSTAT directory.
 */
const SURVEYS: SurveyDefinition[] = [
  {
    abbr: 'cu',
    name: 'CPI - All Urban Consumers',
    area: dim('area'),
    item: dim('item'),
    frequency: dim('periodicity'),
  },
  {
    abbr: 'ap',
    name: 'Consumer Price Index - Average Price Data',
    area: dim('area'),
    item: dim('item'),
  },
  { abbr: 'ce', name: 'CES - Employment, Hours, and Earnings', item: dim('industry') },
  { abbr: 'ln', name: 'CPS - Labor Force Statistics', frequency: dim('periodicity') },
  /**
   * No `item`: every LAUS title already opens with its measure ("Unemployment
   * Rate: Texas (S)"), and repeating it in `item_name` lifts ~8K state and local
   * rows over the national CPS series for measure queries.
   */
  { abbr: 'la', name: 'LAUS - Local Area Unemployment Statistics', area: dim('area') },
  {
    abbr: 'pc',
    name: 'PPI - Industry Data',
    item: dim('product', 'industry_code', 'product_code'),
  },
  { abbr: 'wp', name: 'PPI - Commodity Data', item: dim('item', 'group_code', 'item_code') },
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
  },
  /** The SIC-basis Employment Cost Index; every series ends in 2005. */
  {
    abbr: 'ec',
    name: 'ECI (SIC basis, ended 2005)',
    title: [dim('compensation', 'comp_code'), dim('group'), dim('ownership'), dim('periodicity')],
  },
  {
    abbr: 'pr',
    name: 'Major Sector Productivity and Costs',
    title: [dim('measure'), dim('sector'), dim('duration')],
  },
  { abbr: 'mp', name: 'Major Sector Total Factor Productivity', item: dim('sector') },
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
  },
  { abbr: 'ci', name: 'ECI - Employment Cost Index', area: dim('area'), item: dim('estimate') },
];

/**
 * Canonical harvest order of LABSTAT survey abbreviations, derived from
 * `SURVEYS`. The observations ingester imports this rather than restating the
 * list, so a survey correction lands in one place and the two harvests cannot
 * drift apart. Order is load-bearing: the ingester's resume cursor encodes a
 * survey's index into this array.
 */
export const SURVEY_ABBRS: readonly string[] = SURVEYS.map((s) => s.abbr);

/**
 * The OES/OEWS survey is a pathological outlier — ~6M series / ~1.2 GB, 32× every
 * other survey combined. It is excluded from the catalog unless explicitly opted
 * in (`BLS_CATALOG_INCLUDE_OES=true`), keeping the default index small (~170K
 * series), the first harvest fast, and on-disk size modest. OES series remain
 * fetchable by ID via bls_get_series; they are simply not in the search index.
 */
export const OES_SURVEY_ABBR = 'oe';

/** The surveys a harvest fetches: every `SURVEYS` entry, less OES unless opted in. */
function configuredSurveys(includeOes: boolean): SurveyDefinition[] {
  return includeOes ? SURVEYS : SURVEYS.filter((s) => s.abbr !== OES_SURVEY_ABBR);
}

/**
 * The configured survey list as a completed harvest persists it in the sync
 * state's `checkpoint`: the harvested abbreviations in `SURVEYS` order,
 * comma-joined. `load()` treats an index whose stored list is missing or
 * different as stale, so a changed `BLS_CATALOG_INCLUDE_OES` or survey set
 * re-harvests on the next boot even inside the TTL.
 */
export function catalogSurveyList(includeOes: boolean): string {
  return configuredSurveys(includeOes)
    .map((s) => s.abbr)
    .join(',');
}

/** Known common series to boost in search rankings. */
const COMMON_SERIES: Record<string, string> = {
  LNS14000000: 'civilian unemployment rate seasonally adjusted',
  CES0000000001: 'total nonfarm payrolls seasonally adjusted',
  CUUR0000SA0: 'cpi-u all items u.s. city average not seasonally adjusted',
  CUSR0000SA0: 'cpi-u all items u.s. city average seasonally adjusted',
  WPUFD49104: 'ppi finished goods',
  JTS000000000000000JOL: 'jolts job openings all industries',
  LNS11300000: 'labor force participation rate',
  LNS12000000: 'civilian employment level',
};

const WORD_CHAR = /\w/;

/**
 * Whether `needle` occurs in `text` where a word starts: at the start of `text`
 * or after a character that is not a letter, digit, or underscore (a needle
 * opening on punctuation matches anywhere). Its end may run on into the word,
 * so `payroll` matches "payrolls" and `manufactur` "manufacturing", but `all`
 * never matches inside "seasonally". The concept aliases and the rescore share
 * it. A literal scan rather than a `RegExp` built from caller text, which V8
 * refuses to compile past ~32K characters. Callers pair long text with a short
 * needle (a query against an alias phrase) or a long needle with short text (a
 * query against a title), and both stay linear.
 */
export function startsWord(text: string, needle: string): boolean {
  if (!needle) return false;
  const anywhere = !WORD_CHAR.test(needle[0] ?? '');
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (anywhere || i === 0 || !WORD_CHAR.test(text[i - 1] ?? '')) return true;
  }
  return false;
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
 * matches "job vacancies" and `payroll` matches "payrolls".
 */
const CONCEPT_ALIASES: ReadonlyArray<{ phrases: readonly string[]; surveys: readonly string[] }> = [
  { phrases: ['inflation', 'cost of living', 'consumer price', 'cpi'], surveys: ['CU'] },
  { phrases: ['producer price', 'wholesale price', 'ppi'], surveys: ['WP', 'PC'] },
  { phrases: ['jobs', 'job growth', 'payroll', 'nonfarm', 'wage', 'earnings'], surveys: ['CE'] },
  { phrases: ['job opening', 'labor turnover', 'job vacanc', 'quits', 'jolts'], surveys: ['JT'] },
  { phrases: ['unemployment', 'jobless', 'labor force participation'], surveys: ['LN'] },
  { phrases: ['productivity', 'output per hour'], surveys: ['PR', 'MP'] },
  /** No CI title says "cost", and no CM or CI title says "employer". */
  { phrases: ['compensation', 'employer cost', 'ecec'], surveys: ['CM', 'CI'] },
  /** Safe only at a word start: "eci" sits inside "special", "decision", "precision". */
  { phrases: ['employment cost index', 'eci'], surveys: ['CI'] },
];

/**
 * Survey codes whose concept aliases the lowercased `query` names. One linear
 * scan per alias phrase over caller text.
 */
export function conceptAliasSurveys(query: string): Set<string> {
  const surveys = new Set<string>();
  for (const alias of CONCEPT_ALIASES) {
    if (alias.phrases.some((p) => startsWord(query, p))) {
      for (const s of alias.surveys) surveys.add(s);
    }
  }
  return surveys;
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
 * whole query, in linear time). Each token is an FTS prefix term run
 * synchronously against SQLite, so search cost grows with this count, not with
 * query length. On the 2026-09-23 index the costliest 32 distinct tokens
 * (single-letter prefixes) search in ~0.7–0.8 s, and each token past that would
 * add ~5 ms. No title in that index holds more than 28 distinct tokens, so a
 * pasted title is never cut.
 */
const MAX_QUERY_TOKENS = 32;

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
 * The decoded area labels that mean "the whole country": the CPI/AP
 * `U.S. city average`, the JOLTS `Total US` state code, the CM/CI
 * `United States (National)` area, and the opt-in OEWS `National` area. Rows
 * carrying one, and rows with no decoded area (CE, LN, and the other national
 * surveys), are national for the rescore's tie-break.
 */
const NATIONAL_AREAS: ReadonlySet<string> = new Set([
  'U.S. city average',
  'Total US',
  'United States (National)',
  'National',
]);

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
 */
const CATALOG_INDEX_VERSION = 3;

/** Code-table key (the key column values joined by a tab, which no field contains) → label. */
type CodeLabels = Map<string, string>;

/** A dimension resolved against one `.series` header: its key column indices and labels. */
interface Decoder {
  cols: number[];
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
  return labels;
}

/** A row's decoded label for a dimension; undefined when its code is not in the table. */
function decode(decoder: Decoder | undefined, parts: string[]): string | undefined {
  return decoder?.labels.get(decoder.cols.map((i) => parts[i] ?? '').join('\t'));
}

/**
 * Parse a `.series` file into catalog entries, decoding each row's area, item,
 * frequency, and — when the row has no `series_title` — its synthesized title
 * through the survey's code tables (`tables`: table suffix → file text). Two
 * bodies yield no entries, so the survey keeps its indexed rows: one whose
 * header has no `series_id` column (an HTML error page served with a 200), and
 * one that ends mid-line. Every LABSTAT file ends in a line break; a
 * close-delimited response cut short resolves with a partial body instead of
 * rejecting, and parsing it would delete the missing tail and index the
 * fragment of its last line.
 */
function parseSeries(
  text: string,
  survey: SurveyDefinition,
  tables: ReadonlyMap<string, string>,
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

  const parsedTables = new Map<string, CodeLabels | undefined>();
  const resolve = (dimension: CodeDimension | undefined): Decoder | undefined => {
    if (!dimension) return;
    const { table, key } = dimension;
    const text = tables.get(table);
    if (text === undefined) return; // fetch failure already reported
    const cacheKey = `${table}\t${key.join('\t')}`;
    if (!parsedTables.has(cacheKey)) {
      const labels = parseCodeTable(text, key);
      if (!labels) {
        warn(`${survey.abbr}.${table} header lacks ${key.join(' + ')} or a *_text/*_name label.`);
      }
      parsedTables.set(cacheKey, labels);
    }
    const labels = parsedTables.get(cacheKey);
    const cols = key.map((k) => header.indexOf(k));
    if (!labels || cols.includes(-1)) {
      if (labels) warn(`${survey.abbr}.series header lacks ${key.join(' + ')}.`);
      return;
    }
    return { cols, labels };
  };

  const area = resolve(survey.area);
  const item = resolve(survey.item);
  const frequencyDecoder = resolve(survey.frequency);
  const titleDecoders = survey.title ? survey.title.map(resolve) : [item, area];
  const surveyAbbr = survey.abbr.toUpperCase();

  const entries: CatalogSeries[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = splitFields(line, false);
    const seriesId = parts[seriesIdCol];
    if (!seriesId) continue;

    const areaName = decode(area, parts);
    const itemName = decode(item, parts);
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
      ...(frequency && { frequency }),
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
    seasonal: row.seasonal === 1,
  };
}

/**
 * The index-version migration. It runs after the declarative
 * `CREATE TABLE IF NOT EXISTS`, which never alters an existing table: an index
 * from an earlier release gains the `frequency` column here, while a brand-new
 * database already has it. Then it clears the completion marker so the next
 * `load()` re-harvests.
 */
function migrateCatalogIndex(db: SqliteHandle): void {
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${CATALOG_TABLE})`).all();
  if (!columns.some((c) => c.name === 'frequency')) {
    db.exec(`ALTER TABLE ${CATALOG_TABLE} ADD COLUMN frequency TEXT`);
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
  /** The surveys this deployment harvests, and their list as the sync state persists it. */
  private readonly surveys: readonly SurveyDefinition[];
  private readonly surveyList: string;
  /** The running load, shared by every concurrent `load()` call. */
  private inFlight: Promise<void> | undefined;
  /** Aborted by `shutdown()`; every fetch, backoff, and write of a harvest observes it. */
  private readonly stopping = new AbortController();

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
   * Re-read the row total and the distinct survey codes from the index. Runs
   * on the first load and after each harvest — the index changes only then —
   * so search never pays for it. `count()` runs first so the store finishes
   * opening inside its own call, before `raw()` hands out the handle.
   */
  private async readIndexStats(): Promise<void> {
    this.cachedTotal = await this.store.count();
    this.cachedSurveys = distinctSurveys(await this.store.raw());
  }

  /**
   * Ensure the on-disk index is present and fresh. Serves an existing index
   * immediately (queryable during any refresh); harvests when the store is
   * empty, its last completion is older than the TTL, or that completion
   * harvested a different survey list than this deployment configures.
   * Retries a fully-empty harvest up to `maxAttempts` times with linear
   * backoff. Sets `loaded = true` after the final outcome so callers can
   * distinguish "still loading" from "load failed".
   *
   * Concurrent calls — the boot load and an hourly refresh tick — share one
   * in-flight run, so a second harvest never starts while one is running. A
   * run that `shutdown()` stops rejects with the shutdown reason.
   */
  load(maxAttempts = 3): Promise<void> {
    this.inFlight ??= this.refresh(maxAttempts).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(maxAttempts: number): Promise<void> {
    const { signal } = this.stopping;
    signal.throwIfAborted();
    if (!this.loaded) await this.readIndexStats();
    const existing = this.cachedTotal;
    if (existing > 0) {
      this.loaded = true;
      this.loadError = undefined;
      if (this.isFresh(await this.store.readState())) return; // warm + fresh — nothing to do
    }

    let applied = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      applied = await this.harvest(signal);
      if (applied > 0) break;
      if (attempt < maxAttempts) await pause(signal, attempt * 5_000);
    }

    if (applied > 0) {
      await this.readIndexStats();
      this.loaded = true;
      this.loadError = undefined;
      signal.throwIfAborted();
      await this.store.writeState({
        status: 'complete',
        completedAt: new Date().toISOString(),
        total: this.cachedTotal,
        checkpoint: this.surveyList,
      });
      return;
    }

    if (existing > 0) {
      // Refresh fetched nothing, but a prior index is still queryable — keep
      // serving it and retry on the next hourly check rather than tearing it down.
      process.stderr.write(
        '[bls-labor-mcp-server] Catalog refresh fetched no rows — serving the existing index.\n',
      );
      return;
    }

    this.loaded = true; // empty, but "loaded" so search surfaces the empty-catalog error
    this.loadError = `Catalog load failed after ${maxAttempts} attempts — all LABSTAT downloads returned empty.`;
    signal.throwIfAborted();
    await this.store.writeState({ status: 'error', error: this.loadError });
  }

  /**
   * True when the last completion is within the TTL window and harvested the
   * survey list this deployment configures (persisted in `checkpoint`). A
   * missing list — an index from an earlier release — counts as stale.
   */
  private isFresh({ completedAt, checkpoint }: SyncState): boolean {
    if (!completedAt || checkpoint !== this.surveyList) return false;
    const age = Date.now() - Date.parse(completedAt);
    return Number.isFinite(age) && age <= this.cacheTtlHours * 3_600_000;
  }

  /**
   * Fetch every configured survey with bounded concurrency and upsert the
   * parsed rows into the store in chunks. After a survey's upserts, its indexed
   * rows absent from the new `.series` file are deleted; once every survey is
   * done, so are the rows of surveys no longer configured (OES after its
   * opt-in turns off). A survey that yields no rows — its `.series` request
   * failed, returned non-200, carried no `series_id` header, or ended mid-line
   * — keeps its rows, and a harvest that applies no rows deletes nothing. Returns the
   * number of rows applied.
   */
  private async harvest(signal: AbortSignal): Promise<number> {
    let applied = 0;
    for (let i = 0; i < this.surveys.length; i += SURVEY_FETCH_CONCURRENCY) {
      const batch = this.surveys.slice(i, i + SURVEY_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((survey) => this.loadSurvey(survey, signal)),
      );
      for (const r of results) {
        signal.throwIfAborted();
        if (r.status !== 'fulfilled' || r.value.length === 0) continue;
        for (let j = 0; j < r.value.length; j += HARVEST_CHUNK_SIZE) {
          const chunk = r.value.slice(j, j + HARVEST_CHUNK_SIZE);
          signal.throwIfAborted();
          await this.store.applyBatch(chunk.map(toRow), []);
          applied += chunk.length;
          await pause(signal);
        }
        const [first] = r.value;
        if (first) {
          await this.deleteRows(first.surveyAbbr, new Set(r.value.map((s) => s.seriesId)), signal);
        }
      }
    }

    if (applied > 0) {
      const configured = new Set(this.surveys.map((s) => s.abbr.toUpperCase()));
      for (const survey of distinctSurveys(await this.store.raw())) {
        if (!configured.has(survey)) await this.deleteRows(survey, undefined, signal);
      }
    }
    return applied;
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
   * then parse. A missing `.series` file yields no rows; a missing code table
   * leaves that dimension undecoded and is reported on stderr. Every request
   * also aborts on `signal`.
   */
  private async loadSurvey(
    survey: SurveyDefinition,
    signal: AbortSignal,
  ): Promise<CatalogSeries[]> {
    const { abbr } = survey;
    const url = (file: string) => `${this.catalogBaseUrl}/${abbr}/${abbr}.${file}`;
    const headers = { 'User-Agent': this.userAgent };
    const dimensions = [survey.area, survey.item, survey.frequency, ...(survey.title ?? [])];
    const tableNames = [...new Set(dimensions.flatMap((d) => (d ? [d.table] : [])))];
    const request = (file: string, timeoutMs: number) =>
      fetch(url(file), {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });

    const [seriesRes, ...tableResults] = await Promise.allSettled([
      request('series', 30_000),
      ...tableNames.map((table) => request(table, 15_000)),
    ]);

    if (seriesRes.status !== 'fulfilled' || !seriesRes.value.ok) return [];
    const seriesText = await seriesRes.value.text();

    const tables = new Map<string, string>();
    for (const [i, table] of tableNames.entries()) {
      const res = tableResults[i];
      if (res?.status === 'fulfilled' && res.value.ok) {
        tables.set(table, await res.value.text());
      } else {
        const cause = res?.status === 'fulfilled' ? `HTTP ${res.value.status}` : 'request failed';
        warn(`${abbr}.${table} unavailable (${cause}) — its codes are not decoded.`);
      }
    }

    return parseSeries(seriesText, survey, tables);
  }

  /**
   * Search the catalog. Narrows the on-disk index with an FTS5 candidate query
   * (plus a direct primary-key lookup so an exact SeriesID always surfaces), then
   * applies the bespoke relevance score over the small candidate set.
   */
  async search(input: CatalogSearchInput): Promise<CatalogSearchResult> {
    if (!this.loaded) {
      throw internalError(
        `Catalog index not loaded — server startup may have failed. ${this.loadError ?? ''}`.trim(),
        { reason: 'catalog_unavailable' },
      );
    }

    const query = input.query.toLowerCase().trim();
    const queryUpper = query.toUpperCase();
    const surveyFilter = input.survey?.toUpperCase();
    const areaFilter = input.area?.toLowerCase();
    const seasonFilter = input.seasonal_adjustment;

    // Concept/synonym resolution: surveys whose canonical vocabulary the query
    // names but whose series titles never contain (e.g. "inflation" → CU). Their
    // candidates get a relevance boost in the rescore below, as do rows of a
    // publication frequency the query names ("quarterly unemployment rate").
    const aliasSurveys = conceptAliasSurveys(query);
    const frequencies = queryFrequencies(query);

    // Candidate set: an exact-id lookup (guarantees the precise SeriesID is in
    // play) unioned with the FTS5 matches, deduped by series id.
    const candidates = new Map<string, CatalogSeries>();

    const exact = await this.store.getByIds([input.query.trim().toUpperCase()]);
    for (const row of exact) candidates.set(row.series_id as string, toCatalog(row));

    // Headline common series are always candidates, independent of the FTS cap.
    // The bm25 pre-filter (CANDIDATE_LIMIT) can drop a headline series that matches
    // only one broad query term before the rescore's common-series boost can float
    // it up; unioning them in (mirroring the exact-id lookup above) restores it. The
    // `score === 0` gate below still excludes them from unrelated queries, so this
    // does not resurface them as false positives.
    const common = await this.store.getByIds(Object.keys(COMMON_SERIES));
    for (const row of common) candidates.set(row.series_id as string, toCatalog(row));

    let ftsCapped = false;
    // Each distinct token once, up to MAX_QUERY_TOKENS: a repeat adds nothing
    // to the match, and the FTS query and the rescore both cost per token.
    const tokens = [...new Set(query.match(/[a-z0-9]+/g))].slice(0, MAX_QUERY_TOKENS);
    const areaMatchable = !areaFilter || areaFilter.length <= MAX_AREA_LENGTH;
    if (tokens.length > 0 && areaMatchable) {
      const match = tokens.map((t) => `"${t}"*`).join(' OR ');
      const rows = await this.candidateRows(match, surveyFilter, seasonFilter, areaFilter);
      // If the FTS query returned exactly CANDIDATE_LIMIT rows the full index likely
      // has more matches — total will be a lower bound.
      ftsCapped = rows.length >= CANDIDATE_LIMIT;
      for (const row of rows) candidates.set(row.series_id as string, toCatalog(row));
    }

    // Score each candidate. Exact series ID match = highest priority.
    const scored: Array<{ s: CatalogSeries; score: number }> = [];
    for (const s of candidates.values()) {
      if (surveyFilter && s.surveyAbbr.toUpperCase() !== surveyFilter) continue;
      if (typeof seasonFilter === 'boolean' && s.seasonal !== seasonFilter) continue;

      if (s.seriesId.toUpperCase() === queryUpper) {
        scored.push({ s, score: 1000 });
        continue;
      }
      const commonText = COMMON_SERIES[s.seriesId];
      const isCommon = commonText !== undefined;

      const titleLower = s.title.toLowerCase();
      const areaLower = s.areaName?.toLowerCase() ?? '';
      const itemLower = s.itemName?.toLowerCase() ?? '';

      let score = 0;

      // Area filter as a hard gate. Also check titleLower to cover surveys
      // (e.g. LAUS) where areaName is not decoded from codes but the area
      // name appears directly in the series title.
      if (areaFilter) {
        const areaMatch =
          areaLower.includes(areaFilter) ||
          titleLower.includes(areaFilter) ||
          s.seriesId.toLowerCase().includes(areaFilter);
        if (!areaMatch) continue;
        score += 5;
      }

      // Full-query and token matches count where a word starts, so "all" never
      // scores inside "seasonally". SeriesIDs are not words — their item and
      // area codes sit mid-ID (`SEHA` in CUSR0000SEHA) — so a token still scores
      // anywhere in one.
      if (startsWord(titleLower, query)) score += 10;
      if (commonText !== undefined && startsWord(commonText, query)) score += 15;

      // Token-level match. `matched` counts the tokens the row matches anywhere,
      // its headline description included, for the headline gate below.
      const idLower = s.seriesId.toLowerCase();
      let matched = 0;
      for (const t of tokens) {
        const inTitle = startsWord(titleLower, t);
        const inArea = startsWord(areaLower, t);
        const inItem = startsWord(itemLower, t);
        const inId = idLower.includes(t);
        if (inTitle) score += 2;
        if (inArea) score += 1;
        if (inItem) score += 1;
        if (inId) score += 3;
        if (inTitle || inArea || inItem || inId || (commonText && startsWord(commonText, t))) {
          matched++;
        }
      }

      const aliasHit = aliasSurveys.has(s.surveyAbbr.toUpperCase());
      if (aliasHit) score += ALIAS_SURVEY_BOOST;

      if (score === 0) continue;
      // The item-match weight, after the zero-score gate: a frequency word
      // qualifies a match but never makes one on its own.
      if (s.frequency && frequencies.has(frequencyKey(s.frequency))) score += 1;
      // A headline earns its boost only when the query names it: through its
      // survey's alias, or by matching most of the distinct tokens scored. One shared
      // word ("all" in "All employees") does not make CES the answer to
      // "annual average all items".
      if (isCommon && (aliasHit || matched * 2 > tokens.length)) score += 8;
      scored.push({ s, score });
    }

    // Without an area the caller asked for national series (the tool's `area`
    // contract), so at equal score a national row outranks a state or metro one.
    // Otherwise ties keep candidate order: exact id, headline, then bm25.
    const national = (s: CatalogSeries) => Number(!s.areaName || NATIONAL_AREAS.has(s.areaName));
    scored.sort((a, b) => b.score - a.score || (areaFilter ? 0 : national(b.s) - national(a.s)));
    const total = scored.length;
    const offset = input.offset ?? 0;
    const series = scored.slice(offset, offset + input.limit).map((x) => x.s);
    return { series, total, capped: ftsCapped };
  }

  /**
   * The FTS candidate query: up to `CANDIDATE_LIMIT` rows matching `match`, in
   * bm25 order, with the survey, seasonal, and area filters applied in SQL so
   * the cap bounds only rows that pass them. The area is a case-insensitive
   * substring of `area_name`, `title`, or `series_id` — the rescore's area gate,
   * pushed down as bound `LIKE` parameters. `MirrorStore.query` has no
   * substring operator, hence the raw handle; the SELECT keeps the store's own
   * relevance form (FTS JOIN, `MATCH`, `ORDER BY bm25()`).
   */
  private async candidateRows(
    match: string,
    survey: string | undefined,
    seasonal: boolean | undefined,
    area: string | undefined,
  ): Promise<MirrorRow[]> {
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
    if (area) {
      const pattern = `%${escapeLike(area)}%`;
      where.push(
        `(${AREA_MATCH_COLUMNS.map((c) => `${CATALOG_TABLE}.${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      params.push(...AREA_MATCH_COLUMNS.map(() => pattern));
    }
    const db = await this.store.raw();
    return db
      .prepare<MirrorRow>(
        `SELECT ${CATALOG_TABLE}.* FROM ${CATALOG_TABLE}
         JOIN ${CATALOG_FTS} ON ${CATALOG_TABLE}.rowid = ${CATALOG_FTS}.rowid
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(${CATALOG_FTS}) ASC LIMIT ?`,
      )
      .all(...params, CANDIDATE_LIMIT);
  }

  /**
   * Look up catalog metadata for a set of SeriesIDs in one query. Used to hydrate
   * titles/area/item onto mirror-sourced observations. Returns a map keyed by
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

  get catalogLoadError(): string | undefined {
    return this.loadError;
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

let refreshScheduled = false;

/**
 * Register and start the hourly catalog refresh on the framework scheduler,
 * on every transport. Each tick calls `load()`, which re-harvests only once
 * the index's TTL has lapsed or its survey list no longer matches, and
 * otherwise returns after one sync-state read. An hourly check rather than a
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
    'Hourly check that re-harvests the LABSTAT catalog index once its TTL lapses.',
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
