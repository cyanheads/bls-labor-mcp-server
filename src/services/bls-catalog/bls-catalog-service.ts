/**
 * @fileoverview BLS LABSTAT flat-file catalog service. Downloads `{survey}.series`
 * files from `download.bls.gov/pub/time.series/{survey}/` at startup and builds
 * an in-memory full-text + structured search index. No API quota consumed — all
 * search is offline. Covers the most commonly queried BLS surveys; the BLS FAQ
 * confirms there is no API catalog endpoint.
 * @module services/bls-catalog/bls-catalog-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
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

/** Column indices in a `.series` tab-delimited file. Varies by survey — we try all fallbacks. */
interface SeriesColumns {
  areaCode?: number;
  itemCode?: number;
  periodicity?: number;
  seasonal?: number;
  seriesId: number;
  title?: number;
}

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

export class BlsCatalogService {
  private index: CatalogSeries[] = [];
  private loaded = false;
  private loadError: string | undefined;

  constructor(
    private readonly catalogBaseUrl: string,
    private readonly userAgent: string,
  ) {}

  /**
   * Fetch all LABSTAT series files and build the in-memory index.
   * Retries up to `maxAttempts` times with linear backoff (attempt * 5 s).
   * Sets `loaded = true` after the final attempt regardless of outcome so
   * callers can distinguish "still loading" from "load failed".
   */
  async load(maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const results = await Promise.allSettled(SURVEYS.map((survey) => this.loadSurvey(survey)));
      const all: CatalogSeries[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') all.push(...r.value);
      }
      if (all.length > 0) {
        this.index = all;
        this.loaded = true;
        this.loadError = undefined;
        return;
      }
      if (attempt < maxAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
    this.loaded = true;
    this.loadError = `Catalog load failed after ${maxAttempts} attempts — all LABSTAT downloads returned empty.`;
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

  search(input: CatalogSearchInput): CatalogSearchResult {
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

    let candidates = this.index;

    if (surveyFilter) {
      candidates = candidates.filter((s) => s.surveyAbbr.toUpperCase() === surveyFilter);
    }
    if (typeof seasonFilter === 'boolean') {
      candidates = candidates.filter((s) => s.seasonal === seasonFilter);
    }

    // Score each candidate. Exact series ID match = highest priority.
    const scored: Array<{ s: CatalogSeries; score: number }> = [];
    for (const s of candidates) {
      if (s.seriesId.toUpperCase() === queryUpper) {
        scored.push({ s, score: 1000 });
        continue;
      }
      // Common series boost
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
      const tokens = query.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (titleLower.includes(token)) score += 2;
        if (areaLower.includes(token)) score += 1;
        if (itemLower.includes(token)) score += 1;
        if (s.seriesId.toLowerCase().includes(token)) score += 3;
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

  get isLoaded(): boolean {
    return this.loaded;
  }

  get totalSeries(): number {
    return this.index.length;
  }

  get catalogLoadError(): string | undefined {
    return this.loadError;
  }
}

let _service: BlsCatalogService | undefined;

export function initBlsCatalogService(_config: AppConfig, _storage: StorageService): void {
  const { catalogBaseUrl, userAgent } = getServerConfig();
  _service = new BlsCatalogService(catalogBaseUrl, userAgent);
}

export function getBlsCatalogService(): BlsCatalogService {
  if (!_service) {
    throw new Error('BlsCatalogService not initialized — call initBlsCatalogService() in setup()');
  }
  return _service;
}
