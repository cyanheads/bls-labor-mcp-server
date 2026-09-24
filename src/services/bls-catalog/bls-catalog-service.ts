/**
 * @fileoverview BLS LABSTAT flat-file catalog service. Downloads each survey's
 * `{survey}.series` file and code tables from
 * `download.bls.gov/pub/time.series/{survey}/`, decodes them into a searchable
 * series index, and persists that index in an on-disk SQLite store
 * (the framework's FTS5-capable `sqliteMirrorStore`). Search runs as an FTS5
 * candidate query rescored by a bespoke relevance function — the index lives on
 * disk, not the JS heap, so large surveys do not inflate memory. No API quota is
 * consumed; the BLS FAQ confirms there is no API catalog endpoint.
 * @module services/bls-catalog/bls-catalog-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
import {
  type MirrorRow,
  type MirrorStore,
  type SqlValue,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
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
 * for every row, `title` for surveys whose `.series` file ships no
 * `series_title` (JT, EC, PR). Only the tables these dimensions name are
 * fetched, and each exists in the survey's LABSTAT directory.
 */
const SURVEYS: SurveyDefinition[] = [
  { abbr: 'cu', name: 'CPI - All Urban Consumers', area: dim('area'), item: dim('item') },
  {
    abbr: 'ap',
    name: 'Consumer Price Index - Average Price Data',
    area: dim('area'),
    item: dim('item'),
  },
  { abbr: 'ce', name: 'CES - Employment, Hours, and Earnings', item: dim('industry') },
  { abbr: 'ln', name: 'CPS - Labor Force Statistics' },
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
  },
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
 * in (`BLS_CATALOG_INCLUDE_OES=true`), keeping the default index small (~160K
 * series), the first harvest fast, and on-disk size modest. OES series remain
 * fetchable by ID via bls_get_series; they are simply not in the search index.
 */
export const OES_SURVEY_ABBR = 'oe';

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

/**
 * Concept/synonym → survey code(s). Canonical economic vocabulary often names a
 * survey by a word its series titles never contain (BLS titles never say
 * "inflation"; PPI series don't contain "producer price index") and the survey's
 * own name isn't in the per-series FTS text. When a query contains one of these
 * phrases, the matching surveys' candidates get a relevance boost in the rescore —
 * combined with the always-unioned COMMON_SERIES, this floats the headline series
 * to the top. Codes are uppercase to match the stored `survey_abbr`.
 */
const CONCEPT_ALIASES: ReadonlyArray<{ phrases: readonly string[]; surveys: readonly string[] }> = [
  { phrases: ['inflation', 'cost of living', 'consumer price', 'cpi'], surveys: ['CU'] },
  { phrases: ['producer price', 'wholesale price', 'ppi'], surveys: ['WP', 'PC'] },
  { phrases: ['jobs', 'job growth', 'payroll', 'nonfarm', 'wage', 'earnings'], surveys: ['CE'] },
  { phrases: ['job opening', 'labor turnover', 'job vacanc', 'quits', 'jolts'], surveys: ['JT'] },
  { phrases: ['unemployment', 'jobless', 'labor force participation'], surveys: ['LN'] },
  { phrases: ['productivity', 'output per hour'], surveys: ['PR', 'MP'] },
  { phrases: ['compensation', 'employer cost'], surveys: ['EC'] },
];

/** Relevance boost for a candidate whose survey matches a query concept alias. */
const ALIAS_SURVEY_BOOST = 6;

/** Max surveys fetched concurrently during a harvest. Keeps the request burst small. */
const SURVEY_FETCH_CONCURRENCY = 3;

/** Rows per SQLite upsert transaction during a harvest. Bounds the write batch size. */
const UPSERT_CHUNK_SIZE = 5_000;

/** Max FTS candidates pulled before the bespoke rescore. Generous so `total` stays accurate. */
const CANDIDATE_LIMIT = 1_000;

/** The catalog table; its FTS5 index is `${CATALOG_TABLE}_fts`. */
const CATALOG_TABLE = 'bls_catalog';
const CATALOG_FTS = `${CATALOG_TABLE}_fts`;

/** Columns the `area` filter matches as a case-insensitive substring. */
const AREA_MATCH_COLUMNS = ['area_name', 'title', 'series_id'] as const;

/**
 * The decoded area labels that mean "the whole country": the CPI/AP
 * `U.S. city average`, the JOLTS `Total US` state code, and the opt-in OEWS
 * `National` area. Rows carrying one, and rows with no decoded area (CE, LN,
 * and the other national surveys), are national for the rescore's tie-break.
 */
const NATIONAL_AREAS: ReadonlySet<string> = new Set(['U.S. city average', 'Total US', 'National']);

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
 * decoded area/item, the survey set) so an index persisted by an earlier
 * release re-harvests on its first boot after the upgrade. The migration clears
 * the completion marker — `writeState` cannot, since it COALESCEs
 * `completed_at` — so `load()` sees a stale index, keeps serving it, and
 * refreshes it. On a brand-new database the marker is already NULL.
 * Version 2: header-keyed code tables and synthesized JT/EC/PR titles.
 */
const CATALOG_INDEX_VERSION = 2;

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
 * and — when the row has no `series_title` — its synthesized title through the
 * survey's code tables (`tables`: table suffix → file text).
 */
function parseSeries(
  text: string,
  survey: SurveyDefinition,
  tables: ReadonlyMap<string, string>,
): CatalogSeries[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const header = splitFields(lines[0] ?? '', false).map((h) => h.toLowerCase());
  const seriesIdCol = Math.max(header.indexOf('series_id'), 0);
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
    seasonal: row.seasonal === 1,
  };
}

/**
 * Build the SQLite-backed catalog store. The FTS5 index spans the text columns
 * the rescorer reads (series id, title, area, item); `survey_abbr`/`seasonal`
 * are indexed for the structured filters. Exported so tests can seed a store at
 * the same path/schema the service opens.
 */
export function createCatalogStore(dbPath: string): MirrorStore {
  return sqliteMirrorStore({
    path: dbPath || ':memory:',
    version: CATALOG_INDEX_VERSION,
    migrations: [
      {
        version: CATALOG_INDEX_VERSION,
        up: (db) => db.exec('UPDATE mirror_sync_state SET completed_at = NULL WHERE id = 1'),
      },
    ],
    table: CATALOG_TABLE,
    primaryKey: 'series_id',
    columns: {
      series_id: 'TEXT',
      title: 'TEXT',
      survey_abbr: 'TEXT',
      area_name: 'TEXT',
      item_name: 'TEXT',
      seasonal: 'INTEGER',
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

  constructor(
    private readonly catalogBaseUrl: string,
    private readonly userAgent: string,
    dbPath = '',
    private readonly cacheTtlHours = 168,
    /** Whether the harvest includes the opt-in OES/OEWS survey (`BLS_CATALOG_INCLUDE_OES`). */
    readonly includeOes = false,
  ) {
    this.store = createCatalogStore(dbPath);
  }

  /**
   * Re-read the row total and the distinct survey codes from the index. Runs
   * once per load and after each harvest — the index changes only then — so
   * search never pays for it. The DISTINCT is a covering scan of
   * `bls_catalog_survey_abbr_idx`. `count()` runs first so the store finishes
   * opening inside its own call: a `shutdown()` racing a first load then
   * cannot close the raw handle between `raw()` resolving and the query.
   */
  private async readIndexStats(): Promise<void> {
    this.cachedTotal = await this.store.count();
    const db = await this.store.raw();
    this.cachedSurveys = db
      .prepare<{ survey_abbr: string }>(
        `SELECT DISTINCT survey_abbr FROM ${CATALOG_TABLE} ORDER BY survey_abbr`,
      )
      .all()
      .map((r) => r.survey_abbr);
  }

  /**
   * Ensure the on-disk index is present and fresh. Serves an existing index
   * immediately (queryable during any refresh); harvests when the store is empty
   * or its last completion is older than the TTL. Retries a fully-empty harvest
   * up to `maxAttempts` times with linear backoff. Sets `loaded = true` after the
   * final outcome so callers can distinguish "still loading" from "load failed".
   */
  async load(maxAttempts = 3): Promise<void> {
    await this.readIndexStats();
    const existing = this.cachedTotal;
    if (existing > 0) {
      this.loaded = true;
      this.loadError = undefined;
      const state = await this.store.readState();
      if (this.isFresh(state.completedAt)) return; // warm + fresh — nothing to do
    }

    let applied = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      applied = await this.harvest();
      if (applied > 0) break;
      if (attempt < maxAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }

    if (applied > 0) {
      await this.readIndexStats();
      this.loaded = true;
      this.loadError = undefined;
      await this.store.writeState({
        status: 'complete',
        completedAt: new Date().toISOString(),
        total: this.cachedTotal,
      });
      return;
    }

    if (existing > 0) {
      // Refresh fetched nothing, but a prior index is still queryable — keep
      // serving it and retry on the next boot rather than tearing it down.
      process.stderr.write(
        '[bls-labor-mcp-server] Catalog refresh fetched no rows — serving the existing index.\n',
      );
      return;
    }

    this.loaded = true; // empty, but "loaded" so search surfaces the empty-catalog error
    this.loadError = `Catalog load failed after ${maxAttempts} attempts — all LABSTAT downloads returned empty.`;
    await this.store.writeState({ status: 'error', error: this.loadError });
  }

  /** True when a completion marker exists and is within the TTL window. */
  private isFresh(completedAt: string | undefined): boolean {
    if (!completedAt) return false;
    const age = Date.now() - Date.parse(completedAt);
    return Number.isFinite(age) && age <= this.cacheTtlHours * 3_600_000;
  }

  /**
   * Fetch every (opted-in) survey with bounded concurrency and upsert the parsed
   * rows into the store in chunks. Returns the number of rows applied.
   */
  private async harvest(): Promise<number> {
    const surveys = this.includeOes ? SURVEYS : SURVEYS.filter((s) => s.abbr !== OES_SURVEY_ABBR);

    let applied = 0;
    for (let i = 0; i < surveys.length; i += SURVEY_FETCH_CONCURRENCY) {
      const batch = surveys.slice(i, i + SURVEY_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((survey) => this.loadSurvey(survey)));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (let j = 0; j < r.value.length; j += UPSERT_CHUNK_SIZE) {
          const chunk = r.value.slice(j, j + UPSERT_CHUNK_SIZE);
          await this.store.applyBatch(chunk.map(toRow), []);
          applied += chunk.length;
        }
      }
    }
    return applied;
  }

  /**
   * Fetch a survey's `.series` file and the code tables its dimensions name,
   * then parse. A missing `.series` file yields no rows; a missing code table
   * leaves that dimension undecoded and is reported on stderr.
   */
  private async loadSurvey(survey: SurveyDefinition): Promise<CatalogSeries[]> {
    const { abbr } = survey;
    const url = (file: string) => `${this.catalogBaseUrl}/${abbr}/${abbr}.${file}`;
    const headers = { 'User-Agent': this.userAgent };
    const dimensions = [survey.area, survey.item, ...(survey.title ?? [])];
    const tableNames = [...new Set(dimensions.flatMap((d) => (d ? [d.table] : [])))];

    const [seriesRes, ...tableResults] = await Promise.allSettled([
      fetch(url('series'), { headers, signal: AbortSignal.timeout(30_000) }),
      ...tableNames.map((table) =>
        fetch(url(table), { headers, signal: AbortSignal.timeout(15_000) }),
      ),
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
    // candidates get a relevance boost in the rescore below.
    const aliasSurveys = new Set<string>();
    for (const alias of CONCEPT_ALIASES) {
      if (alias.phrases.some((p) => query.includes(p))) {
        for (const s of alias.surveys) aliasSurveys.add(s);
      }
    }

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
    const tokens = query.match(/[a-z0-9]+/gi) ?? [];
    if (tokens.length > 0) {
      const match = tokens.map((t) => `"${t.toLowerCase()}"*`).join(' OR ');
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

      // Full-query match
      if (titleLower.includes(query)) score += 10;
      if (commonText?.includes(query)) score += 15;

      // Token-level match
      for (const token of tokens) {
        const t = token.toLowerCase();
        if (titleLower.includes(t)) score += 2;
        if (areaLower.includes(t)) score += 1;
        if (itemLower.includes(t)) score += 1;
        if (s.seriesId.toLowerCase().includes(t)) score += 3;
      }

      if (aliasSurveys.size > 0 && aliasSurveys.has(s.surveyAbbr.toUpperCase())) {
        score += ALIAS_SURVEY_BOOST;
      }

      if (score === 0) continue;
      if (isCommon) score += 8;
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
   * Close the on-disk SQLite index. The store lazy-opens, so closing one that
   * was never queried is a no-op; a harvest still in flight fails its next
   * write, which `load()`'s caller already reports.
   */
  async shutdown(): Promise<void> {
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
   * not what `SURVEYS` asks for: a survey whose download failed is absent, and
   * an index inside its TTL keeps the survey set of its last harvest.
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

/** Release the catalog's SQLite handle. Wired to `createApp({ teardown })`. */
export async function shutdownBlsCatalogService(): Promise<void> {
  const service = _service;
  _service = undefined;
  await service?.shutdown();
}
