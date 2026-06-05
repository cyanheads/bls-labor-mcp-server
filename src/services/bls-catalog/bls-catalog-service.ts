/**
 * @fileoverview BLS LABSTAT flat-file catalog service. Downloads `{survey}.series`
 * files from `download.bls.gov/pub/time.series/{survey}/`, parses them into a
 * searchable series index, and persists that index in an on-disk SQLite store
 * (the framework's FTS5-capable `sqliteMirrorStore`). Search runs as an FTS5
 * candidate query rescored by a bespoke relevance function — the index lives on
 * disk, not the JS heap, so large surveys do not inflate memory. No API quota is
 * consumed; the BLS FAQ confirms there is no API catalog endpoint.
 * @module services/bls-catalog/bls-catalog-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { type MirrorRow, type MirrorStore, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { getServerConfig } from '@/config/server-config.js';
import type {
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogSeries,
  SurveyDefinition,
} from './types.js';

/**
 * Surveys fetched at startup. Chosen to cover >95% of real-world queries.
 * Each entry maps the LABSTAT file abbreviation to a human-readable name.
 * The `codeTables` entries name the companion mapping files that provide
 * human-readable area and item names.
 */
const SURVEYS: SurveyDefinition[] = [
  { abbr: 'cu', name: 'CPI - All Urban Consumers', codeTables: ['area', 'item', 'periodicity'] },
  { abbr: 'sa', name: 'CPI - Average Retail Prices', codeTables: ['area', 'item'] },
  {
    abbr: 'ce',
    name: 'CES - Employment, Hours, and Earnings',
    codeTables: ['industry', 'datatype', 'state', 'area', 'supersector'],
  },
  {
    abbr: 'ln',
    name: 'CPS - Labor Force Statistics',
    codeTables: ['tdata', 'periodicity', 'series_catalog'],
  },
  {
    abbr: 'la',
    name: 'LAUS - Local Area Unemployment Statistics',
    codeTables: ['area', 'measure'],
  },
  {
    abbr: 'pc',
    name: 'PPI - Industry Data',
    codeTables: ['industry', 'product', 'group', 'seasonality'],
  },
  { abbr: 'wp', name: 'PPI - Commodity Data', codeTables: ['commodity', 'group', 'seasonality'] },
  {
    abbr: 'jt',
    name: 'JOLTS - Job Openings and Labor Turnover',
    codeTables: ['industry', 'dataelement', 'state', 'area', 'seasonadj', 'ratelevel'],
  },
  {
    abbr: 'oe',
    name: 'OES/OEWS - Occupational Employment and Wage Statistics',
    codeTables: ['area', 'industry', 'occupation', 'datatype'],
  },
  {
    abbr: 'ec',
    name: 'ECEC - Employer Costs for Employee Compensation',
    codeTables: ['ownership', 'occupation', 'subcell', 'datatype', 'industry'],
  },
  { abbr: 'pr', name: 'Productivity - Business', codeTables: ['measure', 'sector'] },
  { abbr: 'mp', name: 'Productivity - Major Sector', codeTables: ['measure', 'sector'] },
];

/**
 * The OES/OEWS survey is a pathological outlier — ~6M series / ~1.2 GB, 32× every
 * other survey combined. It is excluded from the catalog unless explicitly opted
 * in (`BLS_CATALOG_INCLUDE_OES=true`), keeping the default index small (~187K
 * series), the first harvest fast, and on-disk size modest. OES series remain
 * fetchable by ID via bls_get_series; they are simply not in the search index.
 */
const OES_SURVEY_ABBR = 'oe';

/** Known common series to boost in search rankings. */
const COMMON_SERIES: Record<string, string> = {
  LNS14000000: 'civilian unemployment rate seasonally adjusted',
  CES0000000001: 'total nonfarm payrolls seasonally adjusted',
  CUUR0000SA0:
    'consumer price index cpi cpi-u all items u.s. city average all urban consumers not seasonally adjusted',
  CUSR0000SA0:
    'consumer price index cpi cpi-u all items u.s. city average all urban consumers seasonally adjusted',
  WPUFD49104: 'producer price index ppi finished goods',
  JTS000000000000000JOL: 'jolts job openings all industries',
  LNS11300000: 'labor force participation rate',
  LNS12000000: 'civilian employment level',
};

/** Column indices in a `.series` tab-delimited file. Varies by survey — we try all fallbacks. */
interface SeriesColumns {
  areaCode?: number;
  itemCode?: number;
  periodicity?: number;
  seasonal?: number;
  seriesId: number;
  title?: number;
}

/** Max surveys fetched concurrently during a harvest. Keeps the request burst small. */
const SURVEY_FETCH_CONCURRENCY = 3;

/** Rows per SQLite upsert transaction during a harvest. Bounds the write batch size. */
const UPSERT_CHUNK_SIZE = 5_000;

/** Max FTS candidates pulled before the bespoke rescore. Generous so `total` stays accurate. */
const CANDIDATE_LIMIT = 1_000;

/** Parse an area code → name mapping from a `.area` file. */
function parseCodeMap(text: string, keyCol = 0, valCol = 1): Map<string, string> {
  const map = new Map<string, string>();
  const [, ...dataLines] = text.split('\n');
  for (const line of dataLines) {
    const parts = line?.split('\t');
    const key = parts?.[keyCol]?.trim();
    const val = parts?.[valCol]?.trim();
    if (key && val) map.set(key, val);
  }
  return map;
}

/** Parse a `.series` file into catalog entries using optional code maps. */
function parseSeries(
  text: string,
  surveyAbbr: string,
  surveyName: string,
  areaCodes: Map<string, string>,
  itemCodes: Map<string, string>,
): CatalogSeries[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const header = lines[0]?.split('\t').map((h) => h.trim().toLowerCase()) ?? [];
  const seriesIdIdx = header.indexOf('series_id');
  const cols: SeriesColumns = { seriesId: seriesIdIdx >= 0 ? seriesIdIdx : 0 };
  const titleIdx = header.indexOf('series_title');
  if (titleIdx >= 0) cols.title = titleIdx;
  const areaIdx = header.findIndex((h) => h.includes('area_code'));
  if (areaIdx >= 0) cols.areaCode = areaIdx;
  const itemIdx = header.findIndex((h) => h.includes('item_code'));
  if (itemIdx >= 0) cols.itemCode = itemIdx;
  const seasonIdx = header.findIndex((h) => h.includes('seasonal'));
  if (seasonIdx >= 0) cols.seasonal = seasonIdx;

  const entries: CatalogSeries[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const seriesId = parts[cols.seriesId]?.trim();
    if (!seriesId) continue;

    let title = cols.title !== undefined ? parts[cols.title]?.trim() : undefined;
    const areaCode = cols.areaCode !== undefined ? parts[cols.areaCode]?.trim() : undefined;
    const itemCode = cols.itemCode !== undefined ? parts[cols.itemCode]?.trim() : undefined;
    const seasonCode = cols.seasonal !== undefined ? parts[cols.seasonal]?.trim() : undefined;

    const areaName = areaCode ? areaCodes.get(areaCode) : undefined;
    const itemName = itemCode ? itemCodes.get(itemCode) : undefined;

    if (!title) {
      const titleParts: string[] = [surveyName];
      if (itemName) titleParts.push(itemName);
      if (areaName) titleParts.push(areaName);
      title = titleParts.join(' - ');
    }

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
    table: 'bls_catalog',
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

  constructor(
    private readonly catalogBaseUrl: string,
    private readonly userAgent: string,
    dbPath = '',
    private readonly cacheTtlHours = 168,
    private readonly includeOes = false,
  ) {
    this.store = createCatalogStore(dbPath);
  }

  /**
   * Ensure the on-disk index is present and fresh. Serves an existing index
   * immediately (queryable during any refresh); harvests when the store is empty
   * or its last completion is older than the TTL. Retries a fully-empty harvest
   * up to `maxAttempts` times with linear backoff. Sets `loaded = true` after the
   * final outcome so callers can distinguish "still loading" from "load failed".
   */
  async load(maxAttempts = 3): Promise<void> {
    const existing = await this.store.count();
    if (existing > 0) {
      this.loaded = true;
      this.cachedTotal = existing;
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
      this.cachedTotal = await this.store.count();
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

  private async loadSurvey(survey: SurveyDefinition): Promise<CatalogSeries[]> {
    const baseUrl = this.catalogBaseUrl;
    const abbr = survey.abbr;

    const headers = { 'User-Agent': this.userAgent };
    const [seriesRes, ...codeResults] = await Promise.allSettled([
      fetch(`${baseUrl}/${abbr}/${abbr}.series`, { headers, signal: AbortSignal.timeout(30_000) }),
      ...(survey.codeTables ?? []).map((table) =>
        fetch(`${baseUrl}/${abbr}/${abbr}.${table}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    ]);

    if (seriesRes.status !== 'fulfilled' || !seriesRes.value.ok) return [];
    const seriesText = await seriesRes.value.text();

    const areaCodes = new Map<string, string>();
    const itemCodes = new Map<string, string>();

    const tableNames = survey.codeTables ?? [];
    for (const [i, res] of codeResults.entries()) {
      if (res?.status !== 'fulfilled' || !res.value.ok) continue;
      const text = await res.value.text();
      const tableName = tableNames[i];
      const parsed = parseCodeMap(text);
      if (tableName === 'area' || tableName === 'state') {
        for (const [k, v] of parsed) areaCodes.set(k, v);
      } else if (
        tableName === 'item' ||
        tableName === 'product' ||
        tableName === 'commodity' ||
        tableName === 'occupation'
      ) {
        for (const [k, v] of parsed) itemCodes.set(k, v);
      }
    }

    return parseSeries(seriesText, abbr.toUpperCase(), survey.name, areaCodes, itemCodes);
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

    // Candidate set: an exact-id lookup (guarantees the precise SeriesID is in
    // play), known headline/common series (so bespoke boosts are not lost to the
    // FTS candidate cap), and the FTS5 matches, deduped by series id.
    const candidates = new Map<string, CatalogSeries>();

    const exact = await this.store.getByIds([input.query.trim().toUpperCase()]);
    for (const row of exact) candidates.set(row.series_id as string, toCatalog(row));

    const commonRows = await this.store.getByIds(Object.keys(COMMON_SERIES));
    for (const row of commonRows) candidates.set(row.series_id as string, toCatalog(row));

    const tokens = query.match(/[a-z0-9]+/gi) ?? [];
    if (tokens.length > 0) {
      const match = tokens.map((t) => `"${t.toLowerCase()}"*`).join(' OR ');
      const filters = [];
      if (surveyFilter)
        filters.push({ column: 'survey_abbr', op: 'eq' as const, value: surveyFilter });
      if (typeof seasonFilter === 'boolean') {
        filters.push({ column: 'seasonal', op: 'eq' as const, value: seasonFilter ? 1 : 0 });
      }
      const { rows } = await this.store.query({
        match,
        filters,
        sort: 'relevance',
        limit: CANDIDATE_LIMIT,
        offset: 0,
      });
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

      if (score === 0) continue;
      if (isCommon) score += 8;
      scored.push({ s, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    const series = scored.slice(0, input.limit).map((x) => x.s);
    return { series, total };
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

  get isLoaded(): boolean {
    return this.loaded;
  }

  get totalSeries(): number {
    return this.cachedTotal;
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
