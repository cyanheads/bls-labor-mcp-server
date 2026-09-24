/**
 * @fileoverview Tests for BlsCatalogService — the on-disk SQLite catalog index:
 * FTS-backed search + bespoke rescore, OES gating, cold-load harvest, LABSTAT
 * code-table decoding, the index-version upgrade re-harvest, and the not-loaded
 * guard. Search tests seed a store at the same path/schema the service opens
 * (via the exported `createCatalogStore`), then load from it (warm path).
 * Harvest tests serve LABSTAT fixtures at their download.bls.gov URLs through a
 * fetch mock, so the real parse → join → SQLite path runs.
 * @module tests/services/bls-catalog/bls-catalog-service.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MirrorRow, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlsCatalogService,
  createCatalogStore,
  escapeLike,
} from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';

let tmpDir: string;
let dbCounter = 0;
const dirs: string[] = [];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-catalog-'));
  dirs.push(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function toMirrorRow(s: CatalogSeries): MirrorRow {
  return {
    series_id: s.seriesId,
    title: s.title,
    survey_abbr: s.surveyAbbr,
    area_name: s.areaName ?? null,
    item_name: s.itemName ?? null,
    seasonal: s.seasonal ? 1 : 0,
  };
}

/** Seed a fresh SQLite catalog with `entries`, then return a loaded service over it. */
async function seedAndLoad(entries: CatalogSeries[]): Promise<BlsCatalogService> {
  const dbPath = join(tmpDir, `catalog-${dbCounter++}.db`);
  const store = createCatalogStore(dbPath);
  await store.applyBatch(entries.map(toMirrorRow), []);
  await store.writeState({
    status: 'complete',
    completedAt: new Date().toISOString(),
    total: entries.length,
  });
  await store.close();

  const svc = new BlsCatalogService('http://unused', 'test-ua/1.0', dbPath, 168, false);
  await svc.load();
  return svc;
}

// Use non-COMMON_SERIES IDs so scoring is predictable
const FIXTURES: CatalogSeries[] = [
  {
    seriesId: 'TEST_UNEMP_001',
    title: 'Unemployment Rate - National',
    surveyAbbr: 'LN',
    seasonal: true,
    areaName: 'United States',
  },
  {
    seriesId: 'TEST_NONFARM_002',
    title: 'Total Nonfarm Payrolls',
    surveyAbbr: 'CE',
    seasonal: true,
  },
  {
    seriesId: 'TEST_CPI_003',
    title: 'CPI-U All Items Urban Average',
    surveyAbbr: 'CU',
    seasonal: false,
    itemName: 'All items',
  },
];

describe('BlsCatalogService.search', () => {
  it('rejects when the catalog is not loaded', async () => {
    const svc = new BlsCatalogService('http://unused', 'test-ua/1.0');
    await expect(
      svc.search({
        query: 'unemployment',
        survey: undefined,
        area: undefined,
        seasonal_adjustment: undefined,
        limit: 10,
      }),
    ).rejects.toThrow();
  });

  it('returns exact match on seriesId query', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'TEST_UNEMP_001',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('TEST_UNEMP_001');
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by survey abbreviation', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'all',
      survey: 'CU',
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.length).toBeGreaterThan(0);
    expect(result.series.every((s) => s.surveyAbbr === 'CU')).toBe(true);
  });

  it('filters by seasonal adjustment flag', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const nsa = await svc.search({
      query: 'CPI',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: false,
      limit: 10,
    });
    expect(nsa.series.length).toBeGreaterThan(0);
    expect(nsa.series.every((s) => !s.seasonal)).toBe(true);
  });

  it('respects the limit', async () => {
    const many: CatalogSeries[] = Array.from({ length: 20 }, (_, i) => ({
      seriesId: `MANYTEST${String(i).padStart(3, '0')}`,
      title: `Series ${i} unemployment data`,
      surveyAbbr: 'LN',
      seasonal: true,
    }));
    const svc = await seedAndLoad(many);
    const result = await svc.search({
      query: 'unemployment',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 5,
    });
    expect(result.series.length).toBeLessThanOrEqual(5);
    expect(result.total).toBeGreaterThan(5);
  });

  it('returns empty series when nothing matches', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'zzznomatchzzz',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns capped=false when fewer than CANDIDATE_LIMIT rows match', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'unemployment',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    // FIXTURES has only 3 entries — cannot hit the 1000-row FTS cap.
    expect(result.capped).toBe(false);
  });

  it('returns capped=true when the FTS query fills the CANDIDATE_LIMIT bucket (#40)', async () => {
    // Build exactly CANDIDATE_LIMIT (1000) + 1 entries that all match "series data" so
    // the FTS query returns 1000 rows and the service sets capped=true.
    const many: CatalogSeries[] = Array.from({ length: 1001 }, (_, i) => ({
      seriesId: `CAPTEST${String(i).padStart(5, '0')}`,
      title: `Series ${i} data`,
      surveyAbbr: 'LN',
      seasonal: true,
    }));
    const svc = await seedAndLoad(many);
    const result = await svc.search({
      query: 'series data',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.capped).toBe(true);
  });

  it('filters by area name', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'unemployment',
      survey: undefined,
      area: 'United States',
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.length).toBeGreaterThan(0);
    expect(result.series.every((s) => s.areaName?.toLowerCase().includes('united states'))).toBe(
      true,
    );
  });

  it('area filter produces zero results when no entries match', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'unemployment',
      survey: undefined,
      area: 'zzznomatchregion',
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('combines survey + seasonal filters correctly', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const result = await svc.search({
      query: 'cpi',
      survey: 'CU',
      area: undefined,
      seasonal_adjustment: false,
      limit: 10,
    });
    expect(result.series.every((s) => s.surveyAbbr === 'CU' && !s.seasonal)).toBe(true);
  });

  it('scores common series higher than generic matches for known IDs', async () => {
    const withCommon: CatalogSeries[] = [
      {
        seriesId: 'LNS14000000',
        title: 'Unemployment Rate Seasonally Adjusted',
        surveyAbbr: 'LN',
        seasonal: true,
        areaName: 'United States',
      },
      {
        seriesId: 'TEST_OTHER_001',
        title: 'Unemployment Rate Other Area',
        surveyAbbr: 'LN',
        seasonal: false,
      },
    ];
    const svc = await seedAndLoad(withCommon);
    const result = await svc.search({
      query: 'unemployment rate',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('LNS14000000');
  });

  it('surfaces a headline common series dropped by the FTS candidate cap (#35 regression)', async () => {
    // 1001 decoys match all three query terms and outrank the single-term headline
    // series on bm25, filling the entire CANDIDATE_LIMIT (1000) window. Without the
    // common-series union the headline CPI never reaches the bespoke rescore.
    const decoys: CatalogSeries[] = Array.from({ length: 1001 }, (_, i) => ({
      seriesId: `DECOY${String(i).padStart(5, '0')}`,
      title: `Consumer price index component ${i}`,
      surveyAbbr: 'XX',
      seasonal: false,
    }));
    const headline: CatalogSeries = {
      seriesId: 'CUUR0000SA0',
      title: 'All items in U.S. city average, all urban consumers, not seasonally adjusted',
      surveyAbbr: 'CU',
      seasonal: false,
      itemName: 'All items',
    };
    const svc = await seedAndLoad([...decoys, headline]);
    const result = await svc.search({
      query: 'consumer price index',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('CUUR0000SA0');
  });

  it('does not surface common series for an unrelated query, despite the union (#6 guard)', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'LNS14000000',
        title: 'Unemployment Rate Seasonally Adjusted',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'TEST_BANANA_01',
        title: 'Banana retail price',
        surveyAbbr: 'AP',
        seasonal: false,
      },
    ]);
    const result = await svc.search({
      query: 'banana',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.some((s) => s.seriesId === 'LNS14000000')).toBe(false);
  });

  it('resolves a concept synonym (inflation) to its survey headline via the alias map (#36)', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'CUUR0000SA0',
        title: 'All items in U.S. city average, all urban consumers, not seasonally adjusted',
        surveyAbbr: 'CU',
        seasonal: false,
      },
      {
        seriesId: 'TEST_WAGE_01',
        title: 'Average hourly earnings, total private',
        surveyAbbr: 'CE',
        seasonal: true,
      },
    ]);
    const result = await svc.search({
      query: 'inflation',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('CUUR0000SA0');
  });

  it('pins the no-area ranking: score order, then FTS bm25 order among ties (characterization)', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'PIN_A',
        title: 'Hourly earnings of production workers',
        surveyAbbr: 'CE',
        seasonal: true,
      },
      { seriesId: 'PIN_B', title: 'Average hourly earnings', surveyAbbr: 'CE', seasonal: true },
      {
        seriesId: 'PIN_C',
        title: 'Average hourly earnings, total private',
        surveyAbbr: 'CE',
        seasonal: false,
      },
      { seriesId: 'PIN_D', title: 'Average weekly hours', surveyAbbr: 'CE', seasonal: true },
      {
        seriesId: 'PIN_E',
        title: 'Average hourly earnings index',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'PIN_F',
        title: 'Earnings',
        surveyAbbr: 'LN',
        seasonal: true,
        itemName: 'Hourly',
      },
      { seriesId: 'PIN_G', title: 'Unrelated banana price', surveyAbbr: 'AP', seasonal: false },
    ]);
    const result = await svc.search({
      query: 'average hourly earnings',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.map((s) => s.seriesId)).toEqual([
      'PIN_B',
      'PIN_C',
      'PIN_E',
      'PIN_A',
      'PIN_D',
      'PIN_F',
    ]);
    expect(result.total).toBe(6);
    expect(result.capped).toBe(false);
  });

  it('ranks the on-topic survey above wrong-domain token matches (producer price index, #36)', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'WPUFD49104',
        title: 'PPI Commodity data for final demand - finished goods, not seasonally adjusted',
        surveyAbbr: 'WP',
        seasonal: false,
      },
      {
        seriesId: 'TEST_OCC_01',
        title: 'Producers and directors',
        surveyAbbr: 'OE',
        seasonal: false,
      },
    ]);
    const result = await svc.search({
      query: 'producer price index',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('WPUFD49104');
  });
});

describe('BlsCatalogService state', () => {
  it('isLoaded reflects whether load() has run', async () => {
    const unloaded = new BlsCatalogService('http://unused', 'test-ua/1.0');
    expect(unloaded.isLoaded).toBe(false);

    const loaded = await seedAndLoad(FIXTURES);
    expect(loaded.isLoaded).toBe(true);
  });

  it('totalSeries reflects the indexed row count', async () => {
    const svc = await seedAndLoad(FIXTURES);
    expect(svc.totalSeries).toBe(FIXTURES.length);
  });

  it('catalogLoadError is undefined when loaded successfully', async () => {
    const svc = await seedAndLoad(FIXTURES);
    expect(svc.catalogLoadError).toBeUndefined();
  });

  it('lookupByIds hydrates metadata for the given series ids', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const map = await svc.lookupByIds(['TEST_CPI_003', 'TEST_UNEMP_001', 'NOPE']);
    expect(map.get('TEST_CPI_003')?.title).toBe('CPI-U All Items Urban Average');
    expect(map.get('TEST_UNEMP_001')?.areaName).toBe('United States');
    expect(map.has('NOPE')).toBe(false);
  });
});

describe('BlsCatalogService.load (cold harvest)', () => {
  const BASE_URL = 'https://download.bls.gov/pub/time.series';
  const SERIES_TEXT = 'series_id\tseries_title\tseasonal\nLNS14000000\tUnemployment Rate\tS\n';

  // These fixtures serve one body for every URL, so each code table's header
  // mismatch is reported; keep that expected noise out of the test output.
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('sends the configured User-Agent and builds the index from a live harvest', async () => {
    const ua = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';
    const captured: Headers[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.headers) captured.push(new Headers(init.headers));
      return Promise.resolve(new Response(SERIES_TEXT, { status: 200 }));
    });

    const dbPath = join(tmpDir, 'cold.db');
    const svc = new BlsCatalogService(BASE_URL, ua, dbPath, 168, false);
    await svc.load(1);

    expect(svc.isLoaded).toBe(true);
    expect(svc.totalSeries).toBeGreaterThan(0);
    expect(captured.length).toBeGreaterThan(0);
    for (const h of captured) {
      expect(h.get('User-Agent')).toBe(ua);
    }
  });

  it('serves the persisted index on the next boot without re-fetching', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(SERIES_TEXT, { status: 200 })));

    const dbPath = join(tmpDir, 'warm.db');
    const first = new BlsCatalogService(BASE_URL, 'ua/1.0', dbPath, 168, false);
    await first.load(1);
    expect(first.totalSeries).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);

    fetchSpy.mockClear();
    const second = new BlsCatalogService(BASE_URL, 'ua/1.0', dbPath, 168, false);
    await second.load(1);
    expect(second.totalSeries).toBe(first.totalSeries);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('excludes the OES survey by default and includes it when opted in', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      urls.push(String(url));
      return Promise.resolve(new Response(SERIES_TEXT, { status: 200 }));
    });

    const offSvc = new BlsCatalogService(BASE_URL, 'ua/1.0', join(tmpDir, 'off.db'), 168, false);
    await offSvc.load(1);
    expect(urls.some((u) => u.includes('/oe/'))).toBe(false);

    urls.length = 0;
    const onSvc = new BlsCatalogService(BASE_URL, 'ua/1.0', join(tmpDir, 'on.db'), 168, true);
    await onSvc.load(1);
    expect(urls.some((u) => u.includes('/oe/oe.series'))).toBe(true);
  });

  it('harvests the ap Average Price survey, never the sa employment survey, and labels rows with the ap name (#43)', async () => {
    // Production ap.series carries series_title per row; this fixture omits it so the
    // fallback title synthesis fires and the survey name becomes observable.
    const AP_SERIES = 'series_id\tarea_code\titem_code\nAPU0000701111\t0000\t701111\n';
    const AP_AREA = 'area_code\tarea_name\n0000\tU.S. city average\n';
    const AP_ITEM = 'item_code\titem_name\n701111\tFlour, white, all purpose, per lb.\n';
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/ap/ap.series'))
        return Promise.resolve(new Response(AP_SERIES, { status: 200 }));
      if (u.includes('/ap/ap.area')) return Promise.resolve(new Response(AP_AREA, { status: 200 }));
      if (u.includes('/ap/ap.item')) return Promise.resolve(new Response(AP_ITEM, { status: 200 }));
      // Every other survey contributes nothing, isolating the ap harvest.
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const svc = new BlsCatalogService(BASE_URL, 'ua/1.0', join(tmpDir, 'ap.db'), 168, false);
    await svc.load(1);

    // abbr fix: the harvest fetches the ap flat files and never the sa ones.
    expect(urls.some((u) => u.includes('/ap/ap.series'))).toBe(true);
    expect(urls.some((u) => u.includes('/sa/'))).toBe(false);

    // name fix: the ap survey name flows into the synthesized title (row had no series_title).
    const result = await svc.search({
      query: 'APU0000701111',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 5,
    });
    expect(result.series.length).toBeGreaterThan(0);
    expect(result.series[0]!.seriesId).toBe('APU0000701111');
    expect(result.series[0]!.title).toContain('Consumer Price Index - Average Price Data');
  });

  it('harvests the cw CPI-W survey so CWUR series resolve by exact SeriesID (#51)', async () => {
    // Mirrors production cw.series, which does carry series_title per row.
    const CW_SERIES =
      'series_id\tarea_code\titem_code\tseasonal\tperiodicity_code\tbase_code\tbase_period\tseries_title\n' +
      'CWUR0000SA0\t0000\tSA0\tU\tR\tS\t1982-84=100\tAll items in U.S. city average, urban wage earners and clerical workers, not seasonally adjusted\n';
    const CW_AREA = 'area_code\tarea_name\n0000\tU.S. city average\n';
    const CW_ITEM = 'item_code\titem_name\nSA0\tAll items\n';
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/cw/cw.series'))
        return Promise.resolve(new Response(CW_SERIES, { status: 200 }));
      if (u.includes('/cw/cw.area')) return Promise.resolve(new Response(CW_AREA, { status: 200 }));
      if (u.includes('/cw/cw.item')) return Promise.resolve(new Response(CW_ITEM, { status: 200 }));
      // Every other survey contributes nothing, isolating the cw harvest.
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const svc = new BlsCatalogService(BASE_URL, 'ua/1.0', join(tmpDir, 'cw.db'), 168, false);
    await svc.load(1);

    expect(urls.some((u) => u.includes('/cw/cw.series'))).toBe(true);

    // The reported repro: an exact SeriesID lookup returned zero results.
    const exact = await svc.search({
      query: 'CWUR0000SA0',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 5,
    });
    expect(exact.series[0]!.seriesId).toBe('CWUR0000SA0');
    expect(exact.series[0]!.surveyAbbr).toBe('CW');

    // ...as did a survey-filtered concept query.
    const filtered = await svc.search({
      query: 'all items',
      survey: 'CW',
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 5,
    });
    expect(filtered.series.length).toBeGreaterThan(0);
    expect(filtered.series[0]!.seriesId).toBe('CWUR0000SA0');
  });
});

// ---------------------------------------------------------------------------
// LABSTAT code-table decoding (#63, #83)
// ---------------------------------------------------------------------------

const LABSTAT_URL = 'https://download.bls.gov/pub/time.series';

/** Render rows as a LABSTAT flat file: tab-delimited, CRLF line endings. */
function tsv(...rows: string[][]): string {
  return `${rows.map((r) => r.join('\t')).join('\r\n')}\r\n`;
}

/**
 * Serve `files` (keyed by file name, e.g. `jt.series`) at their LABSTAT URLs;
 * every other URL 404s. Captures the service's stderr warnings. Returns the file
 * names requested, in order, and the warnings written.
 */
function serveLabstat(files: Record<string, string>): { requested: string[]; warnings: string[] } {
  const requested: string[] = [];
  const warnings: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    const file = u.slice(u.lastIndexOf('/') + 1);
    requested.push(file);
    const body = files[file];
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 }),
    );
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    warnings.push(String(chunk));
    return true;
  });
  return { requested, warnings };
}

/** Cold-harvest a fresh index from `files` and return the loaded service. */
async function harvestFrom(
  files: Record<string, string>,
  opts: { includeOes?: boolean } = {},
): Promise<{ svc: BlsCatalogService; requested: string[]; warnings: string[] }> {
  const { requested, warnings } = serveLabstat(files);
  const svc = new BlsCatalogService(
    LABSTAT_URL,
    'ua/1.0',
    join(tmpDir, `harvest-${dbCounter++}.db`),
    168,
    opts.includeOes ?? false,
  );
  await svc.load(1);
  return { svc, requested, warnings };
}

function searchInput(
  query: string,
  opts: { survey?: string; area?: string; limit?: number } = {},
): Parameters<BlsCatalogService['search']>[0] {
  return {
    query,
    survey: opts.survey,
    area: opts.area,
    seasonal_adjustment: undefined,
    limit: opts.limit ?? 10,
  };
}

const PERIODS = ['', '2000', 'M12', '2026', 'M07'];

/** Real jt.* rows (2026-09-23): national, state, region, industry, and size-class series. */
const JT_FILES: Record<string, string> = {
  'jt.series': tsv(
    [
      'series_id                     ',
      'seasonal',
      'industry_code',
      'state_code',
      'area_code',
      'sizeclass_code',
      'dataelement_code',
      'ratelevel_code',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    ['JTS000000000000000JOL         ', 'S', '000000', '00', '00000', '00', 'JO', 'L', ...PERIODS],
    ['JTS000000000000000QUL         ', 'S', '000000', '00', '00000', '00', 'QU', 'L', ...PERIODS],
    ['JTS000000000000000QUR         ', 'S', '000000', '00', '00000', '00', 'QU', 'R', ...PERIODS],
    ['JTU000000000000000QUR         ', 'U', '000000', '00', '00000', '00', 'QU', 'R', ...PERIODS],
    ['JTS000000010000000QUR         ', 'S', '000000', '01', '00000', '00', 'QU', 'R', ...PERIODS],
    ['JTS000000060000000JOL         ', 'S', '000000', '06', '00000', '00', 'JO', 'L', ...PERIODS],
    ['JTS000000060000000JOR         ', 'S', '000000', '06', '00000', '00', 'JO', 'R', ...PERIODS],
    ['JTS000000060000000QUR         ', 'S', '000000', '06', '00000', '00', 'QU', 'R', ...PERIODS],
    ['JTS300000000000000JOR         ', 'S', '300000', '00', '00000', '00', 'JO', 'R', ...PERIODS],
    ['JTS100000000000001HIL         ', 'S', '100000', '00', '00000', '01', 'HI', 'L', ...PERIODS],
    ['JTS000000MW0000000HIL         ', 'S', '000000', 'MW', '00000', '00', 'HI', 'L', ...PERIODS],
  ),
  'jt.dataelement': tsv(
    ['dataelement_code', 'dataelement_text', 'display_level', 'selectable', 'sort_sequence'],
    ['HI', 'Hires', '0', 'T', '2'],
    ['JO', 'Job openings', '0', 'T', '1'],
    ['QU', 'Quits', '1', 'T', '4'],
  ),
  'jt.industry': tsv(
    ['industry_code', 'industry_text', 'display_level', 'selectable', 'sort_sequence'],
    ['000000', 'Total nonfarm', '0', 'T', '1'],
    ['100000', 'Total private', '1', 'T', '2'],
    ['300000', 'Manufacturing', '2', 'T', '6'],
  ),
  'jt.state': tsv(
    ['state_code', 'state_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00', 'Total US', '0', 'T', '1'],
    ['01', 'Alabama', '2', 'T', '6'],
    ['06', 'California', '2', 'T', '10'],
    ['MW', 'Midwest region', '1', 'T', '4'],
  ),
  'jt.sizeclass': tsv(
    ['sizeclass_code', 'sizeclass_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00', 'All size classes', '0', 'T', '1'],
    ['01', '1 to 9 employees', '1', 'T', '2'],
  ),
  'jt.ratelevel': tsv(
    ['ratelevel_code', 'ratelevel_text', 'display_level', 'selectable', 'sort_sequence'],
    ['L', 'Level - In Thousands', '0', 'T', '2'],
    ['R', 'Rate', '0', 'T', '1'],
  ),
  // Constant `00000` on every jt.series row — must never become the area.
  'jt.area': tsv(
    ['area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00000', 'All areas', '0', 'T', '1'],
  ),
};

/** Real pr.* rows: one sector/measure crossed with every duration. */
const PR_FILES: Record<string, string> = {
  'pr.series': tsv(
    [
      'series_id        ',
      'sector_code',
      'class_code',
      'measure_code',
      'duration_code',
      'seasonal',
      'base_year',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    ['PRS85006091      ', '8500', '6', '09', '1', 'S', '-', '', '1948', 'Q01', '2026', 'Q02'],
    ['PRS85006092      ', '8500', '6', '09', '2', 'S', '-', '', '1947', 'Q02', '2026', 'Q02'],
    ['PRS85006093      ', '8500', '6', '09', '3', 'S', '2017', '', '1947', 'Q01', '2026', 'Q02'],
    ['PRS85006112      ', '8500', '6', '11', '2', 'S', '-', '', '1947', 'Q02', '2026', 'Q02'],
    ['PRS85006113      ', '8500', '6', '11', '3', 'S', '2017', '', '1947', 'Q01', '2026', 'Q02'],
    ['PRS30006093      ', '3000', '6', '09', '3', 'S', '2017', '', '1987', 'Q01', '2026', 'Q02'],
  ),
  'pr.measure': tsv(
    ['measure_code', 'measure_text', 'display_level', 'selectable', 'sort_sequence'],
    ['09', 'Labor productivity (output per hour)', '0', 'T', '1'],
    ['11', 'Unit labor costs', '0', 'T', '7'],
  ),
  'pr.sector': tsv(
    ['sector_code', 'sector_name', 'display_level', 'selectable', 'sort_sequence'],
    ['3000', 'Manufacturing', '0', 'T', '4'],
    ['8500', 'Nonfarm Business', '0', 'T', '1'],
  ),
  'pr.duration': tsv(
    ['duration_code', 'duration_text', 'display_level', 'selectable', 'sort_sequence'],
    ['1', '% Change same quarter 1 year ago', '0', 'T', '1'],
    ['2', '% Change from previous quarter', '0', 'T', '2'],
    ['3', 'Index (2017=100)', '0', 'T', '3'],
  ),
};

/**
 * Real ec.* rows. `ec.compensation` keys on `comp_code` (not its file stem), and
 * `ec.group` is space-delimited with a trailing `.` line — both as upstream ships them.
 */
const EC_FILES: Record<string, string> = {
  'ec.series': tsv(
    [
      'series_id',
      'comp_code',
      'group_code',
      'ownership_code',
      'periodicity_code',
      'seasonal',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    ['ECS10001I        ', '1', '000', '1', 'I', 'S', '          ', '1982', 'Q01', '2005', 'Q04'],
    ['ECU10001I        ', '1', '000', '1', 'I', 'U', '          ', '1981', 'Q02', '2005', 'Q04'],
    ['ECS20002I        ', '2', '000', '2', 'I', 'S', '          ', '1980', 'Q01', '2005', 'Q04'],
    ['ECS20002Q        ', '2', '000', '2', 'Q', 'S', '          ', '1980', 'Q02', '2005', 'Q04'],
    ['ECS22302I        ', '2', '230', '2', 'I', 'S', '          ', '1980', 'Q01', '2005', 'Q04'],
    ['ECS22402I        ', '2', '240', '2', 'I', 'S', '          ', '1975', 'Q03', '2005', 'Q04'],
  ),
  'ec.compensation': tsv(
    ['comp_code', 'comp_text'],
    ['1', 'Total compensation'],
    ['2', 'Wages and salaries'],
    ['3', 'Benefits'],
  ),
  'ec.group':
    'group_code      group_name\r\n' +
    '000     All workers\r\n' +
    '101     Production and non-supervisory occupations\r\n' +
    '230     Construction\r\n' +
    '240     Manufacturing\r\n' +
    '.\r\n',
  'ec.ownership': tsv(
    ['ownership_code', 'ownership_name'],
    ['1', 'Civilian'],
    ['2', 'Private industry'],
    ['3', 'State and local government'],
  ),
  'ec.periodicity': tsv(
    ['periodicity_code', 'periodicity_text'],
    ['A', '12 month percent cha'],
    ['I', 'Index number'],
    ['Q', '3 month percent chan'],
  ),
};

/** Distinct `title|seasonal` pairs across `ids`. */
async function distinctTitleSeasonal(svc: BlsCatalogService, ids: string[]): Promise<number> {
  const rows = await svc.lookupByIds(ids);
  expect(rows.size).toBe(ids.length);
  return new Set([...rows.values()].map((s) => `${s.title}|${s.seasonal}`)).size;
}

describe('BlsCatalogService.load — LABSTAT decoding (characterization)', () => {
  it('decodes CPI area and item names and keeps the upstream series_title', async () => {
    const { svc } = await harvestFrom({
      'cu.series': tsv(
        [
          'series_id        ',
          'area_code',
          'item_code',
          'seasonal',
          'periodicity_code',
          'base_code',
          'base_period',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        [
          'CUSR0000SA0      ',
          '0000',
          'SA0',
          'S',
          'R',
          'S',
          '1982-84=100',
          'All items in U.S. city average, all urban consumers, seasonally adjusted',
          '',
          '1947',
          'M01',
          '2026',
          'M08',
        ],
      ),
      'cu.area': tsv(
        ['area_code', 'area_name', 'display_level', 'selectable', 'sort_sequence'],
        ['0000', 'U.S. city average', '0', 'T', '1'],
      ),
      'cu.item': tsv(
        ['item_code', 'item_name', 'display_level', 'selectable', 'sort_sequence'],
        ['SA0', 'All items', '0', 'T', '1'],
      ),
    });

    const row = (await svc.lookupByIds(['CUSR0000SA0'])).get('CUSR0000SA0');
    expect(row).toEqual({
      seriesId: 'CUSR0000SA0',
      title: 'All items in U.S. city average, all urban consumers, seasonally adjusted',
      surveyAbbr: 'CU',
      areaName: 'U.S. city average',
      itemName: 'All items',
      seasonal: true,
    });
  });

  it('keeps series_title verbatim for a survey that ships one (CE)', async () => {
    const { svc } = await harvestFrom({
      'ce.series': tsv(
        [
          'series_id        ',
          'supersector_code',
          'industry_code',
          'data_type_code',
          'seasonal',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        [
          'CES2000000001    ',
          '20',
          '20000000',
          '01',
          'S',
          'All employees, thousands, construction, seasonally adjusted',
          '',
          '1939',
          'M01',
          '2026',
          'M08',
        ],
      ),
    });
    const row = (await svc.lookupByIds(['CES2000000001'])).get('CES2000000001');
    expect(row?.title).toBe('All employees, thousands, construction, seasonally adjusted');
    expect(row?.seasonal).toBe(true);
  });
});

describe('BlsCatalogService.load — title synthesis for title-less surveys (#63)', () => {
  it('composes JT titles from the ordered dimension list and decodes the state as the area', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const rows = await svc.lookupByIds([
      'JTS000000000000000QUR',
      'JTS000000060000000JOR',
      'JTS000000MW0000000HIL',
      'JTS100000000000001HIL',
    ]);

    expect(rows.get('JTS000000000000000QUR')).toMatchObject({
      title: 'JOLTS - Quits - Total nonfarm - Total US - All size classes - Rate',
      areaName: 'Total US',
      surveyAbbr: 'JT',
      seasonal: true,
    });
    expect(rows.get('JTS000000060000000JOR')).toMatchObject({
      title: 'JOLTS - Job openings - Total nonfarm - California - All size classes - Rate',
      areaName: 'California',
    });
    expect(rows.get('JTS000000MW0000000HIL')).toMatchObject({
      title:
        'JOLTS - Hires - Total nonfarm - Midwest region - All size classes - Level - In Thousands',
      areaName: 'Midwest region',
    });
    expect(rows.get('JTS100000000000001HIL')?.title).toBe(
      'JOLTS - Hires - Total private - Total US - 1 to 9 employees - Level - In Thousands',
    );
  });

  it('gives every JT row a distinct title + seasonal pair and never the constant "All areas"', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const ids = [...JT_FILES['jt.series']!.matchAll(/^(JT\w+)/gm)].map((m) => m[1]!);
    expect(ids).toHaveLength(11);
    expect(await distinctTitleSeasonal(svc, ids)).toBe(ids.length);
    const rows = await svc.lookupByIds(ids);
    for (const s of rows.values()) expect(s.areaName).not.toBe('All areas');
  });

  it('gives PR distinct titles even without the seasonal flag, under the program name', async () => {
    const { svc } = await harvestFrom(PR_FILES);
    const ids = [...PR_FILES['pr.series']!.matchAll(/^(PR\w+)/gm)].map((m) => m[1]!);
    const rows = await svc.lookupByIds(ids);
    expect(new Set([...rows.values()].map((s) => s.title)).size).toBe(ids.length);
    expect(rows.get('PRS85006093')?.title).toBe(
      'Major Sector Productivity and Costs - Labor productivity (output per hour) - Nonfarm Business - Index (2017=100)',
    );
    expect(rows.get('PRS30006093')?.title).toBe(
      'Major Sector Productivity and Costs - Labor productivity (output per hour) - Manufacturing - Index (2017=100)',
    );
  });

  it('decodes EC through comp_code → ec.compensation and the space-delimited ec.group', async () => {
    const { svc } = await harvestFrom(EC_FILES);
    const ids = [...EC_FILES['ec.series']!.matchAll(/^(EC\w+)/gm)].map((m) => m[1]!);
    expect(await distinctTitleSeasonal(svc, ids)).toBe(ids.length);
    const rows = await svc.lookupByIds(ids);
    expect(rows.get('ECS22302I')?.title).toBe(
      'ECI (SIC basis, ended 2005) - Wages and salaries - Construction - Private industry - Index number',
    );
    expect(rows.get('ECS10001I')?.title).toBe(
      'ECI (SIC basis, ended 2005) - Total compensation - All workers - Civilian - Index number',
    );
    expect(rows.get('ECS20002Q')?.title).toBe(
      'ECI (SIC basis, ended 2005) - Wages and salaries - All workers - Private industry - 3 month percent chan',
    );
    expect(rows.get('ECS22402I')?.title).toContain('- Manufacturing -');
  });

  it('ranks the national quits rate in the top 5 for "quits rate total nonfarm"', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const result = await svc.search(searchInput('quits rate total nonfarm', { limit: 5 }));
    expect(result.series.map((s) => s.seriesId)).toContain('JTS000000000000000QUR');
  });

  it('reaches JT state series through the area filter', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const result = await svc.search(
      searchInput('job openings', { survey: 'JT', area: 'California', limit: 5 }),
    );
    const ids = result.series.map((s) => s.seriesId);
    expect(ids).toContain('JTS000000060000000JOL');
    expect(ids).toContain('JTS000000060000000JOR');
    expect(result.series.every((s) => s.areaName === 'California')).toBe(true);
  });

  it('separates JT job-openings rows from other data elements for a bare "job openings" query', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const result = await svc.search(searchInput('job openings', { survey: 'JT', limit: 4 }));
    expect(result.series.map((s) => s.seriesId).sort()).toEqual([
      'JTS000000000000000JOL',
      'JTS000000060000000JOL',
      'JTS000000060000000JOR',
      'JTS300000000000000JOR',
    ]);
  });
});

describe('BlsCatalogService.load — header-keyed code-table joins (#83)', () => {
  it('decodes the LAUS area from la.area, whose first column is area_type_code', async () => {
    const { svc } = await harvestFrom({
      'la.series': tsv(
        [
          'series_id                     ',
          'area_type_code',
          'area_code',
          'measure_code',
          'seasonal',
          'srd_code',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        [
          'LASST480000000000003          ',
          'A',
          'ST4800000000000',
          '03',
          'S',
          '48',
          'Unemployment Rate: Texas (S)',
          '',
          '1976',
          'M01',
          '2026',
          'M08',
        ],
        [
          'LAUST060000000000006          ',
          'A',
          'ST0600000000000',
          '06',
          'U',
          '06',
          'Labor Force: California (U)',
          '',
          '1976',
          'M01',
          '2026',
          'M08',
        ],
      ),
      'la.area': tsv(
        [
          'area_type_code',
          'area_code',
          'area_text',
          'display_level',
          'selectable',
          'sort_sequence',
        ],
        ['A', 'ST0600000000000', 'California', '0', 'T', '388'],
        ['A', 'ST4800000000000', 'Texas', '0', 'T', '6710'],
      ),
      // Served so the no-item assertion below can fail: a declared la.measure
      // item dimension would decode these codes.
      'la.measure': tsv(
        ['measure_code', 'measure_text'],
        ['03', 'unemployment rate'],
        ['06', 'labor force'],
      ),
    });

    const rows = await svc.lookupByIds(['LASST480000000000003', 'LAUST060000000000006']);
    expect(rows.get('LASST480000000000003')).toMatchObject({
      title: 'Unemployment Rate: Texas (S)',
      areaName: 'Texas',
    });
    expect(rows.get('LAUST060000000000006')?.areaName).toBe('California');
    // The measure already opens every LAUS title; it is not repeated as the item.
    expect(rows.get('LASST480000000000003')?.itemName).toBeUndefined();
  });

  it('joins pc.product on the composite industry_code + product_code key', async () => {
    const pcRow = (id: string, industry: string, product: string, title: string) => [
      id,
      industry,
      product,
      'U',
      '198112',
      title,
      '',
      '1981',
      'M12',
      '2026',
      'M08',
    ];
    const { svc } = await harvestFrom({
      'pc.series': tsv(
        [
          'series_id                     ',
          'industry_code',
          'product_code',
          'seasonal',
          'base_date',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        pcRow(
          'PCU113310113310',
          '113310',
          '113310',
          'PPI industry data for Logging, not seasonally adjusted',
        ),
        pcRow(
          'PCU113310113310P',
          '113310',
          '113310P',
          'PPI industry data for Logging-Primary products, not seasonally adjusted',
        ),
      ),
      'pc.product': tsv(
        ['industry_code', 'product_code', 'product_name'],
        ['113310', '113310', 'Logging'],
        ['113310', '113310M', 'Miscellaneous receipts'],
        ['113310', '113310P', 'Primary products'],
        // The same product code under another industry: a join on product_code
        // alone would take this later label.
        ['221111', '113310P', 'Hydroelectric power generation'],
      ),
    });

    const rows = await svc.lookupByIds(['PCU113310113310', 'PCU113310113310P']);
    expect(rows.get('PCU113310113310')?.itemName).toBe('Logging');
    expect(rows.get('PCU113310113310P')).toMatchObject({
      itemName: 'Primary products',
      title: 'PPI industry data for Logging-Primary products, not seasonally adjusted',
    });
  });

  it('joins wp.item on group_code + item_code, where item_code alone is ambiguous', async () => {
    const wpRow = (id: string, group: string, item: string, seasonal: string, title: string) => [
      id,
      group,
      item,
      seasonal,
      '198506',
      title,
      '',
      '1985',
      'M06',
      '2026',
      'M08',
    ];
    const { svc } = await harvestFrom({
      'wp.series': tsv(
        [
          'series_id                     ',
          'group_code',
          'item_code',
          'seasonal',
          'base_date',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        wpRow(
          'WPU08710101',
          '08',
          '710101',
          'U',
          'PPI Commodity data for Lumber and wood products-Wood poles, piles, and posts owned and treated by the same establishment, not seasonally adjusted',
        ),
        wpRow(
          'WPU57710101',
          '57',
          '710101',
          'U',
          'PPI Commodity data for Wholesale trade services-Apparel wholesaling, not seasonally adjusted',
        ),
        wpRow('WPS01', '01', '-', 'S', 'PPI Commodity data for Farm products, seasonally adjusted'),
      ),
      'wp.item': tsv(
        ['group_code', 'item_code', 'item_name'],
        ['01', '-', 'Farm products'],
        ['08', '-', 'Lumber and wood products'],
        [
          '08',
          '710101',
          'Wood poles, piles, and posts owned and treated by the same establishment',
        ],
        ['57', '-', 'Wholesale trade services'],
        ['57', '710101', 'Apparel wholesaling'],
      ),
    });

    const rows = await svc.lookupByIds(['WPU08710101', 'WPU57710101', 'WPS01']);
    expect(rows.get('WPU08710101')?.itemName).toBe(
      'Wood poles, piles, and posts owned and treated by the same establishment',
    );
    expect(rows.get('WPU57710101')?.itemName).toBe('Apparel wholesaling');
    expect(rows.get('WPS01')?.itemName).toBe('Farm products');
  });

  it('decodes the CES industry from ce.industry, whose label is its fourth column', async () => {
    const ceRow = (id: string, supersector: string, industry: string, title: string) => [
      id,
      supersector,
      industry,
      '01',
      'S',
      title,
      '',
      '1939',
      'M01',
      '2026',
      'M08',
    ];
    const { svc } = await harvestFrom({
      'ce.series': tsv(
        [
          'series_id        ',
          'supersector_code',
          'industry_code',
          'data_type_code',
          'seasonal',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        ceRow(
          'CES2000000001    ',
          '20',
          '20000000',
          'All employees, thousands, construction, seasonally adjusted',
        ),
        ceRow(
          'CES0500000001    ',
          '05',
          '05000000',
          'All employees, thousands, total private, seasonally adjusted',
        ),
      ),
      'ce.industry': tsv(
        [
          'industry_code',
          'naics_code',
          'publishing_status',
          'industry_name',
          'display_level',
          'selectable',
          'sort_sequence',
        ],
        ['05000000', '-', 'A', 'Total private', '1', 'T', '2'],
        ['20000000', '23', 'A', 'Construction', '2', 'T', '28'],
      ),
    });
    const rows = await svc.lookupByIds(['CES2000000001', 'CES0500000001']);
    expect(rows.get('CES2000000001')?.itemName).toBe('Construction');
    expect(rows.get('CES0500000001')?.itemName).toBe('Total private');
  });

  it('decodes the MP sector as the item', async () => {
    const { svc } = await harvestFrom({
      'mp.series': tsv(
        [
          'series_id        ',
          'sector_code',
          'measure_code',
          'duration_code',
          'base_year',
          'series_title',
          'footnote_codes',
          'begin_year',
          'begin_period',
          'end_year',
          'end_period',
        ],
        [
          'MPU0011012       ',
          '0011',
          '01',
          '2',
          '2017',
          'Total factor productivity for Agriculture, forestry, fishing, and hunting (NAICS 11), Indexes = 100.000',
          '04',
          '1987',
          'A01',
          '2024',
          'A01',
        ],
      ),
      'mp.sector': tsv(
        ['sector_code', 'sector_name', 'display_level', 'selectable', 'sort_sequence'],
        ['0011', 'Agriculture, forestry, fishing, and hunting (NAICS 11)', '1', 'T', '3'],
      ),
    });
    const row = (await svc.lookupByIds(['MPU0011012'])).get('MPU0011012');
    expect(row?.itemName).toBe('Agriculture, forestry, fishing, and hunting (NAICS 11)');
  });

  it('requests only code tables that exist in the LABSTAT survey directories', async () => {
    /** Non-data files listed in each survey directory on download.bls.gov (2026-09-23). */
    const LISTED: Record<string, string> = {
      ap: 'area item period seasonal series',
      ce: 'datatype industry period seasonal series supersector',
      cu: 'area aspect base item period periodicity seasonal series',
      cw: 'area aspect base item period periodicity seasonal series',
      ec: 'compensation group ownership period periodicity seasonal series',
      jt: 'area dataelement industry period ratelevel seasonal series sizeclass state',
      la: 'area area_type areamaps map_info measure period seasonal series state_region_division',
      ln: 'absn activity ages aspect born cert chld class disa duration education entr expr hheader hour indy jdes lfst look mari mjhs occupation orig pcts periodicity race rjnw rnlf rwns seasonal seek series sexs tdat tlwk vets wkst',
      mp: 'duration measure period seasonal sector series',
      oe: 'area areatype datatype industry occupation release seasonal sector series',
      pc: 'industry period product seasonal series',
      pr: 'class duration measure period seasonal sector series',
      wp: 'group item period seasonal series',
    };
    const listed = new Set(
      Object.entries(LISTED).flatMap(([abbr, names]) =>
        names.split(' ').map((n) => `${abbr}.${n}`),
      ),
    );
    const files = Object.fromEntries([...listed].map((f) => [f, 'header_only\r\n']));

    const { requested } = await harvestFrom(files, { includeOes: true });
    expect(requested.filter((f) => f.endsWith('.series'))).toHaveLength(13);
    expect(requested.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('still indexes a survey whose code table 404s, reporting the table on stderr', async () => {
    const { 'jt.state': _dropped, ...withoutState } = JT_FILES;
    const { svc, warnings } = await harvestFrom(withoutState);

    const row = (await svc.lookupByIds(['JTS000000060000000JOR'])).get('JTS000000060000000JOR');
    expect(row?.title).toBe('JOLTS - Job openings - Total nonfarm - All size classes - Rate');
    expect(row?.areaName).toBeUndefined();
    expect(warnings.filter((w) => w.includes('jt.state'))).toEqual([
      '[bls-labor-mcp-server] Catalog: jt.state unavailable (HTTP 404) — its codes are not decoded.\n',
    ]);
  });

  it('reports a code table whose header lacks the declared key column', async () => {
    const { svc, warnings } = await harvestFrom({
      ...JT_FILES,
      'jt.sizeclass': tsv(['size_code', 'sizeclass_text'], ['00', 'All size classes']),
    });

    const row = (await svc.lookupByIds(['JTS000000000000000QUR'])).get('JTS000000000000000QUR');
    expect(row?.title).toBe('JOLTS - Quits - Total nonfarm - Total US - Rate');
    expect(warnings.some((w) => w.includes('jt.sizeclass header lacks sizeclass_code'))).toBe(true);
  });
});

describe('BlsCatalogService.load — index version upgrade (#63)', () => {
  /** The catalog schema an earlier release persisted: same columns, no index version (1). */
  function legacyStore(path: string) {
    return sqliteMirrorStore({
      path,
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

  const LEGACY_TITLE = 'JOLTS - Job Openings and Labor Turnover - All areas';

  /** Persist a fresh (inside-TTL) legacy index holding the pre-fix JT QUR row. */
  async function seedLegacy(path: string): Promise<void> {
    const legacy = legacyStore(path);
    await legacy.applyBatch(
      [
        {
          series_id: 'JTS000000000000000QUR',
          title: LEGACY_TITLE,
          survey_abbr: 'JT',
          area_name: 'All areas',
          item_name: null,
          seasonal: 1,
        },
      ],
      [],
    );
    await legacy.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      total: 1,
    });
    await legacy.close();
  }

  it('re-harvests a fresh index from an earlier release once, serving it meanwhile', async () => {
    const dbPath = join(tmpDir, 'upgrade.db');
    await seedLegacy(dbPath);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      await gate;
      const body = JT_FILES[u.slice(u.lastIndexOf('/') + 1)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    });

    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    const loading = svc.load(1);

    // The harvest is in flight (held at the gate); the old index serves meanwhile.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(svc.isLoaded).toBe(true);
    const during = await svc.search(searchInput('JTS000000000000000QUR'));
    expect(during.series[0]?.title).toBe(LEGACY_TITLE);

    release();
    await loading;
    const after = (await svc.lookupByIds(['JTS000000000000000QUR'])).get('JTS000000000000000QUR');
    expect(after?.title).toBe('JOLTS - Quits - Total nonfarm - Total US - All size classes - Rate');
    expect(after?.areaName).toBe('Total US');
    await svc.shutdown();

    // Once: the upgraded index is fresh on the next boot.
    fetchSpy.mockClear();
    const next = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await next.load(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await next.shutdown();
  });

  it('keeps serving the old index when the upgrade harvest fetches nothing, and retries next boot', async () => {
    const dbPath = join(tmpDir, 'upgrade-fail.db');
    await seedLegacy(dbPath);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));

    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await svc.load(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(svc.isLoaded).toBe(true);
    expect(svc.catalogLoadError).toBeUndefined();
    const kept = (await svc.lookupByIds(['JTS000000000000000QUR'])).get('JTS000000000000000QUR');
    expect(kept?.title).toBe(LEGACY_TITLE);
    await svc.shutdown();

    fetchSpy.mockClear();
    const next = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await next.load(1);
    expect(fetchSpy).toHaveBeenCalled();
    await next.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Area filter before the candidate cap (#69)
// ---------------------------------------------------------------------------

/** Search input with every filter spelled out; `offset` omitted unless given. */
function search(
  query: string,
  opts: { survey?: string; area?: string; limit?: number; offset?: number } = {},
): Parameters<BlsCatalogService['search']>[0] {
  return {
    query,
    survey: opts.survey,
    area: opts.area,
    seasonal_adjustment: undefined,
    limit: opts.limit ?? 10,
    ...(opts.offset !== undefined && { offset: opts.offset }),
  };
}

/**
 * 1,001 LA decoys whose repeated query terms outrank every area row on bm25,
 * filling the whole 1,000-row candidate window (the #35 decoy pattern).
 */
const AREA_DECOYS: CatalogSeries[] = Array.from({ length: 1001 }, (_, i) => ({
  seriesId: `LADECOY${String(i).padStart(5, '0')}`,
  title: `Unemployment rate unemployment rate ${i}`,
  surveyAbbr: 'LA',
  seasonal: false,
}));

const SEATTLE: CatalogSeries[] = [
  {
    seriesId: 'LAUCT536300000000003',
    title: 'Unemployment Rate: Seattle city, WA (U)',
    surveyAbbr: 'LA',
    seasonal: false,
    areaName: 'Seattle city, WA',
  },
  {
    seriesId: 'LAUMT534266000000003',
    title: 'Unemployment Rate: Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area (U)',
    surveyAbbr: 'LA',
    seasonal: false,
    areaName: 'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
  },
  // No decoded area: matched through its title.
  {
    seriesId: 'CETESTSEA01',
    title: 'Insured unemployment rate, Seattle area test series',
    surveyAbbr: 'CE',
    seasonal: false,
  },
];

/** Code-style area rows: matched only through their series_id. */
const WASHINGTON: CatalogSeries[] = [
  {
    seriesId: 'LASST530000000000003',
    title: 'Unemployment Rate: Washington (S)',
    surveyAbbr: 'LA',
    seasonal: true,
    areaName: 'Washington',
  },
  {
    seriesId: 'LAUST530000000000003',
    title: 'Unemployment Rate: Washington (U)',
    surveyAbbr: 'LA',
    seasonal: false,
    areaName: 'Washington',
  },
];

/** Rows an unescaped `_`, `%`, or `\` would match, plus rows holding those characters literally. */
const WILDCARD_ROWS: CatalogSeries[] = [
  {
    seriesId: 'TESTSTX53ROW',
    title: 'Unemployment rate stx53 row',
    surveyAbbr: 'LN',
    seasonal: false,
  },
  {
    seriesId: 'TEST100ROW',
    title: 'Unemployment rate index 100 base',
    surveyAbbr: 'LN',
    seasonal: false,
  },
  { seriesId: 'TESTABROW', title: 'Unemployment rate lab row', surveyAbbr: 'LN', seasonal: false },
  {
    seriesId: 'TESTLITERAL1',
    title: 'Unemployment rate st_53 literal',
    surveyAbbr: 'LN',
    seasonal: false,
  },
  {
    seriesId: 'TESTLITERAL2',
    title: 'Unemployment rate 100% literal',
    surveyAbbr: 'LN',
    seasonal: false,
  },
  {
    seriesId: 'TESTLITERAL3',
    title: 'Unemployment rate a\\b literal',
    surveyAbbr: 'LN',
    seasonal: false,
  },
];

describe('BlsCatalogService.search — area before the candidate cap (#69)', () => {
  it('returns every area row that 1,001 outranking decoys push past the cap, with an exact total', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...SEATTLE]);
    const unfiltered = await svc.search(search('unemployment rate', { limit: 50 }));
    expect(unfiltered.capped).toBe(true);
    expect(unfiltered.series.some((s) => SEATTLE.some((a) => a.seriesId === s.seriesId))).toBe(
      false,
    );

    const result = await svc.search(search('unemployment rate', { area: 'Seattle', limit: 50 }));
    expect(result.series.map((s) => s.seriesId).sort()).toEqual([
      'CETESTSEA01',
      'LAUCT536300000000003',
      'LAUMT534266000000003',
    ]);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(false);
  });

  it('combines survey and area under the same decoys', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...SEATTLE]);
    const result = await svc.search(search('unemployment rate', { survey: 'LA', area: 'seattle' }));
    expect(result.series.map((s) => s.seriesId).sort()).toEqual([
      'LAUCT536300000000003',
      'LAUMT534266000000003',
    ]);
    expect(result.total).toBe(2);
    expect(result.capped).toBe(false);
  });

  it('matches a code-style area by series_id substring, case-insensitively', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...SEATTLE, ...WASHINGTON]);
    for (const area of ['ST53', 'st53']) {
      const result = await svc.search(search('unemployment rate', { area }));
      expect(result.series.map((s) => s.seriesId).sort()).toEqual([
        'LASST530000000000003',
        'LAUST530000000000003',
      ]);
      expect(result.total).toBe(2);
    }
  });

  it('matches %, _, and \\ in the area literally', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...WILDCARD_ROWS]);
    const idsFor = async (area: string) =>
      (await svc.search(search('unemployment rate', { area }))).series.map((s) => s.seriesId);
    expect(await idsFor('st_53')).toEqual(['TESTLITERAL1']);
    expect(await idsFor('100%')).toEqual(['TESTLITERAL2']);
    expect(await idsFor('a\\b')).toEqual(['TESTLITERAL3']);
    expect(await idsFor('stx_53')).toEqual([]);
    expect(await idsFor('%')).toEqual(['TESTLITERAL2']);
    expect(await idsFor('_')).toEqual(['TESTLITERAL1']);
  });

  it('reports capped with an area only when at least 1,000 area rows match', async () => {
    const ohio: CatalogSeries[] = Array.from({ length: 1001 }, (_, i) => ({
      seriesId: `LAOHIO${String(i).padStart(5, '0')}`,
      title: `Unemployment Rate: Ohio county ${i} (U)`,
      surveyAbbr: 'LA',
      seasonal: false,
      areaName: `Ohio county ${i}`,
    }));
    const svc = await seedAndLoad([...AREA_DECOYS, ...ohio, ...SEATTLE]);
    const capped = await svc.search(search('unemployment rate', { area: 'Ohio' }));
    expect(capped.capped).toBe(true);
    expect(capped.total).toBe(1000);
    expect(capped.series.every((s) => s.areaName?.startsWith('Ohio county'))).toBe(true);

    const small = await svc.search(search('unemployment rate', { area: 'Seattle' }));
    expect(small.capped).toBe(false);
    expect(small.total).toBe(3);
  });

  it('gates the unioned headline rows by area; an exact SeriesID still wins (characterization)', async () => {
    const svc = await seedAndLoad([
      ...SEATTLE,
      {
        seriesId: 'LNS14000000',
        title: 'Unemployment Rate',
        surveyAbbr: 'LN',
        seasonal: true,
      },
    ]);
    // The exact-id match scores before the area gate, so it survives any area.
    const exact = await svc.search(search('LNS14000000', { area: 'Seattle' }));
    expect(exact.series.map((s) => s.seriesId)).toEqual(['LNS14000000']);
    const headline = await svc.search(search('unemployment rate', { area: 'Seattle' }));
    expect(headline.series.map((s) => s.seriesId)).not.toContain('LNS14000000');
    expect(headline.total).toBe(3);
  });

  it('keeps the rescore order within the area-filtered list', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...SEATTLE]);
    const result = await svc.search(search('Seattle unemployment rate', { area: 'Seattle' }));
    // Full-query-free rows: the two LAUS titles and the CE row each score on the
    // tokens; the CE title repeats no extra token, so bm25 + rescore decide.
    expect(result.series.map((s) => s.seriesId)).toEqual([
      'LAUCT536300000000003',
      'LAUMT534266000000003',
      'CETESTSEA01',
    ]);
  });
});

describe('escapeLike (#69)', () => {
  it('escapes the LIKE wildcards and the escape character, leaving other text alone', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('Seattle-Tacoma, WA')).toBe('Seattle-Tacoma, WA');
  });

  it('runs in linear time on worst-case caller text', () => {
    const time = (input: string) => {
      const start = performance.now();
      for (let i = 0; i < 20; i++) escapeLike(input);
      return (performance.now() - start) / 20;
    };
    for (const ch of ['%', '\\', '_']) {
      time(ch.repeat(5_000)); // warm the JIT
      const t5k = Math.max(time(ch.repeat(5_000)), 0.001);
      const t20k = time(ch.repeat(20_000));
      const t80k = time(ch.repeat(80_000));
      // Linear growth predicts 16× from 5k to 80k; quadratic would be 256×.
      expect(t80k / t5k).toBeLessThan(64);
      expect(t20k).toBeLessThan(t80k * 2);
      expect(t80k).toBeLessThan(50);
      expect(escapeLike(ch.repeat(80_000))).toHaveLength(160_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Offset paging (#62)
// ---------------------------------------------------------------------------

describe('BlsCatalogService.search — offset paging (#62)', () => {
  const ROWS: CatalogSeries[] = Array.from({ length: 137 }, (_, i) => ({
    seriesId: `PAGE${String(i).padStart(4, '0')}`,
    title: i % 3 === 0 ? `Quits rate total nonfarm ${i}` : `Quits level ${i}`,
    surveyAbbr: 'JT',
    seasonal: i % 2 === 0,
  }));

  it('concatenates pages at offset 0, 50, 100 into the unpaged rescored list', async () => {
    const svc = await seedAndLoad(ROWS);
    const unpaged = await svc.search(search('quits rate', { limit: 1_000 }));
    expect(unpaged.total).toBe(137);

    const pages: string[] = [];
    for (const offset of [0, 50, 100]) {
      const page = await svc.search(search('quits rate', { limit: 50, offset }));
      expect(page.total).toBe(137);
      pages.push(...page.series.map((s) => s.seriesId));
    }
    expect(pages).toEqual(unpaged.series.map((s) => s.seriesId));
    expect(new Set(pages).size).toBe(137);
  });

  it('returns total - offset rows on the last page and none past the end', async () => {
    const svc = await seedAndLoad(ROWS);
    const last = await svc.search(search('quits rate', { limit: 50, offset: 100 }));
    expect(last.series).toHaveLength(37);
    const past = await svc.search(search('quits rate', { limit: 50, offset: 137 }));
    expect(past.series).toEqual([]);
    expect(past.total).toBe(137);
  });

  it('offset 0 and an omitted offset return the same page', async () => {
    const svc = await seedAndLoad(ROWS);
    const omitted = await svc.search(search('quits rate', { limit: 20 }));
    const zero = await svc.search(search('quits rate', { limit: 20, offset: 0 }));
    expect(zero).toEqual(omitted);
  });

  it('pages the area-filtered list', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...SEATTLE]);
    const all = await svc.search(search('unemployment rate', { area: 'Seattle', limit: 50 }));
    const second = await svc.search(
      search('unemployment rate', { area: 'Seattle', limit: 2, offset: 2 }),
    );
    expect(second.total).toBe(3);
    expect(second.series.map((s) => s.seriesId)).toEqual(
      all.series.slice(2).map((s) => s.seriesId),
    );
  });
});

// ---------------------------------------------------------------------------
// Indexed-survey set (#64)
// ---------------------------------------------------------------------------

describe('BlsCatalogService.indexedSurveys (#64)', () => {
  it('lists the distinct survey codes in the index, sorted', async () => {
    const svc = await seedAndLoad(FIXTURES);
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'LN']);
  });

  it('omits a survey whose .series download failed during the harvest', async () => {
    const { svc } = await harvestFrom({
      ...JT_FILES,
      'pr.series': PR_FILES['pr.series']!,
      'pr.measure': PR_FILES['pr.measure']!,
    });
    expect(svc.indexedSurveys).toEqual(['JT', 'PR']);
  });

  it('picks up surveys a refresh harvest adds, without a restart', async () => {
    const dbPath = join(tmpDir, 'stale.db');
    const store = createCatalogStore(dbPath);
    await store.applyBatch(FIXTURES.map(toMirrorRow), []);
    await store.writeState({
      status: 'complete',
      completedAt: new Date(Date.now() - 1_000 * 3_600_000).toISOString(),
      total: FIXTURES.length,
    });
    await store.close();

    serveLabstat(JT_FILES);
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await svc.load(1);
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'JT', 'LN']);
    expect(svc.totalSeries).toBe(FIXTURES.length + 11);
  });

  it('is empty before any index loads', () => {
    expect(new BlsCatalogService('http://unused', 'ua/1.0').indexedSurveys).toEqual([]);
  });

  it('exposes the OES opt-in', () => {
    expect(new BlsCatalogService('http://unused', 'ua/1.0', '', 168, true).includeOes).toBe(true);
    expect(new BlsCatalogService('http://unused', 'ua/1.0').includeOes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// National-first tie-break when area is omitted
// ---------------------------------------------------------------------------

describe('BlsCatalogService.search — national rows first at equal score', () => {
  const jt = (state: string, name: string, element = 'QU', label = 'Quits'): CatalogSeries => ({
    seriesId: `JTS000000${state}0000000${element}R`,
    title: `JOLTS - ${label} - Total nonfarm - ${name} - All size classes - Rate`,
    surveyAbbr: 'JT',
    seasonal: true,
    areaName: name,
  });
  const STATES = [
    jt('01', 'Alabama'),
    jt('02', 'Alaska'),
    jt('04', 'Arizona'),
    jt('00', 'Total US'),
    jt('MW', 'Midwest region'),
    jt('01', 'Alabama', 'HI', 'Hires'),
    jt('00', 'Total US', 'HI', 'Hires'),
  ];

  it('ranks the national JOLTS row above state rows that tie it', async () => {
    const svc = await seedAndLoad(STATES);
    const quits = await svc.search(search('quits'));
    expect(quits.series[0]!.seriesId).toBe('JTS000000000000000QUR');
    const hires = await svc.search(search('hires'));
    expect(hires.series[0]!.seriesId).toBe('JTS000000000000000HIR');
  });

  it('ranks the U.S. city average and undecoded-area rows above metro rows that tie them', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'CUURA421SAF',
        title: 'Food in Seattle-Tacoma-Bellevue, WA, all urban consumers, not seasonally adjusted',
        surveyAbbr: 'CU',
        seasonal: false,
        areaName: 'Seattle-Tacoma-Bellevue, WA',
      },
      {
        seriesId: 'CUUR0000SAF',
        title: 'Food in U.S. city average, all urban consumers, not seasonally adjusted',
        surveyAbbr: 'CU',
        seasonal: false,
        areaName: 'U.S. city average',
      },
    ]);
    const result = await svc.search(search('food urban consumers'));
    expect(result.series.map((s) => s.seriesId)).toEqual(['CUUR0000SAF', 'CUURA421SAF']);
  });

  it('ranks the opt-in OEWS "National" area above a state row that ties it', async () => {
    // Same-length titles tie on score and bm25, so candidate order puts Texas first.
    const svc = await seedAndLoad([
      {
        seriesId: 'OEUS480000000000029114104',
        title: 'Annual mean wage for Registered Nurses in All Industries in Texas',
        surveyAbbr: 'OE',
        seasonal: false,
        areaName: 'Texas',
      },
      {
        seriesId: 'OEUN000000000000029114104',
        title: 'Annual mean wage for Registered Nurses in All Industries in National',
        surveyAbbr: 'OE',
        seasonal: false,
        areaName: 'National',
      },
    ]);
    const result = await svc.search(search('registered nurses annual mean wage'));
    expect(result.series.map((s) => s.seriesId)).toEqual([
      'OEUN000000000000029114104',
      'OEUS480000000000029114104',
    ]);
  });

  it('never lifts a national row over a higher-scoring state row', async () => {
    const svc = await seedAndLoad(STATES);
    const result = await svc.search(search('quits alabama'));
    expect(result.series[0]!.seriesId).toBe('JTS000000010000000QUR');
  });

  it('leaves the order of an area-filtered list unchanged', async () => {
    const svc = await seedAndLoad(STATES);
    const noTieBreak = await svc.search(search('quits', { area: 'a' }));
    // Every row matches "a" (its title says "All size classes"); the national row
    // keeps its bm25 place among the ties instead of moving to the front.
    expect(noTieBreak.series.map((s) => s.seriesId)[0]).not.toBe('JTS000000000000000QUR');
    expect(noTieBreak.total).toBe(5);
  });
});

describe('BlsCatalogService.load racing shutdown', () => {
  it('finishes a first load that a shutdown interrupts without a closed-handle error', async () => {
    const dbPath = join(tmpDir, 'race.db');
    const store = createCatalogStore(dbPath);
    await store.applyBatch(FIXTURES.map(toMirrorRow), []);
    await store.writeState({ status: 'complete', completedAt: new Date().toISOString() });
    await store.close();

    const svc = new BlsCatalogService('http://unused', 'ua/1.0', dbPath, 168, false);
    const loading = svc.load(1);
    const closing = svc.shutdown();
    await expect(loading).resolves.toBeUndefined();
    await closing;
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'LN']);
    await svc.shutdown();
  });
});
