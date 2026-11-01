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
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type MirrorRow, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  BlsCatalogService,
  catalogSurveyList,
  conceptAliasSurveys,
  createCatalogStore,
  escapeLike,
  getBlsCatalogService,
  initBlsCatalogService,
  queryFrequencies,
  shutdownBlsCatalogService,
  startsWord,
  unpublishedOewsHint,
} from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';
import { OE_TABLE_FILES, storeOewsTables, tsv } from './oews-fixtures.js';

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
    frequency: s.frequency ?? null,
    start_year: s.startYear ?? null,
    end_year: s.endYear ?? null,
    end_period: s.endPeriod ?? null,
  };
}

/**
 * Seed a fresh SQLite catalog with `entries`, the OE code tables, and the
 * default survey list, then return a loaded service over it (warm path, no harvest).
 */
async function seedAndLoad(entries: CatalogSeries[]): Promise<BlsCatalogService> {
  const dbPath = join(tmpDir, `catalog-${dbCounter++}.db`);
  const store = createCatalogStore(dbPath);
  await store.applyBatch(entries.map(toMirrorRow), []);
  await storeOewsTables(store);
  await store.writeState({
    status: 'complete',
    completedAt: new Date().toISOString(),
    total: entries.length,
    checkpoint: catalogSurveyList(false),
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
        seriesId: 'WPUFD4',
        title: 'PPI Commodity data for Final demand, not seasonally adjusted',
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
    expect(result.series[0]!.seriesId).toBe('WPUFD4');
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

  it('readiness is ready when loaded successfully', async () => {
    const svc = await seedAndLoad(FIXTURES);
    expect(svc.readiness).toEqual({ status: 'ready' });
  });

  it('lookupByIds hydrates metadata for the given series ids', async () => {
    const svc = await seedAndLoad(FIXTURES);
    const map = await svc.lookupByIds(['TEST_CPI_003', 'TEST_UNEMP_001', 'NOPE']);
    expect(map.get('TEST_CPI_003')?.title).toBe('CPI-U All Items Urban Average');
    expect(map.get('TEST_UNEMP_001')?.areaName).toBe('United States');
    expect(map.has('NOPE')).toBe(false);
  });
});

describe('BlsCatalogService.readiness (#112)', () => {
  const surveyCount = catalogSurveyList(false).split(',').length;

  /** Hold every download until the returned release runs or its request aborts, then serve `files`. */
  function holdDownloads(files: Record<string, string>): () => void {
    serveLabstat(files);
    const serveNow = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        void gate.then(resolve);
      });
      return serveNow(url, init);
    });
    return release;
  }

  it('is loading through a cold harvest, between its attempts too, and unavailable naming the stop once it rejects', async () => {
    const { requested } = serveLabstat({});
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', join(tmpDir, 'cold-attempts.db'));
    const loading = svc.load(2);
    const settled = loading.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    // Every survey failed on the first attempt; the second waits out its backoff.
    await vi.waitFor(() =>
      expect(requested.filter((f) => f.endsWith('.series'))).toHaveLength(surveyCount),
    );
    expect(svc.readiness).toEqual({ status: 'loading' });
    await expect(svc.search(searchInput('unemployment'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'catalog_loading', retryable: true },
    });
    // Hydration for the data tools is unchanged: off until a load finishes.
    expect(svc.isLoaded).toBe(false);
    expect((await svc.lookupByIds(['LNS14000000'])).size).toBe(0);

    await svc.shutdown();
    expect(await settled).toMatch(/stopped by shutdown/);
    expect(svc.readiness).toEqual({
      status: 'unavailable',
      error: 'Catalog load stopped: Catalog harvest stopped by shutdown.',
    });
    expect(requested.filter((f) => f.endsWith('.series'))).toHaveLength(surveyCount);
  });

  it('is unavailable after an empty cold load, loading while the next check retries, and ready once series land', async () => {
    serveLabstat({});
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', join(tmpDir, 'empty-retry.db'));
    await svc.load(1);

    const emptyError =
      'Catalog load failed after 1 attempt — all LABSTAT downloads returned empty.';
    expect(svc.readiness).toEqual({ status: 'unavailable', error: emptyError });
    expect(svc.isLoaded).toBe(true);
    await expect(svc.search(searchInput('unemployment'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining(emptyError),
      data: { reason: 'catalog_unavailable' },
    });

    const release = holdDownloads(JT_FILES);
    const retry = svc.load(1);
    expect(svc.readiness).toEqual({ status: 'loading' });
    release();
    await retry;
    expect(svc.readiness).toEqual({ status: 'ready' });
    expect((await svc.search(searchInput('JTS000000000000000QUR'))).series[0]?.seriesId).toBe(
      'JTS000000000000000QUR',
    );
    await svc.shutdown();
  });

  it('stays ready while a stale index refreshes and after a refresh that fetches nothing', async () => {
    const dbPath = join(tmpDir, 'stale-ready.db');
    const store = createCatalogStore(dbPath);
    await store.applyBatch(FIXTURES.map(toMirrorRow), []);
    await store.writeState({
      status: 'complete',
      completedAt: new Date(Date.now() - 1_000 * 3_600_000).toISOString(),
      checkpoint: catalogSurveyList(false),
    });
    await store.close();

    const release = holdDownloads({});
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    const refreshing = svc.load(1);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(svc.readiness).toEqual({ status: 'ready' });
    release();
    await refreshing;
    expect(svc.readiness).toEqual({ status: 'ready' });
    expect(svc.totalSeries).toBe(FIXTURES.length);
    await svc.shutdown();
  });
});

describe('BlsCatalogService.load (cold harvest)', () => {
  const BASE_URL = 'https://download.bls.gov/pub/time.series';
  const keys = [
    'area_code',
    'item_code',
    'industry_code',
    'periodicity_code',
    'product_code',
    'group_code',
    'state_code',
    'dataelement_code',
    'sizeclass_code',
    'ratelevel_code',
    'occupation_code',
    'comp_code',
    'ownership_code',
    'measure_code',
    'sector_code',
    'duration_code',
    'estimate_code',
    'data_type_code',
    'tdat_code',
    'datatype_code',
    'fips_code',
  ];
  const SERIES_TEXT = `series_id\tseries_title\tseasonal\t${keys.join('\t')}\nLNS14000000\tUnemployment Rate\tS\t${keys.map(() => 'x').join('\t')}\n`;
  const TABLE_TEXT = `${keys.join('\t')}\tlabel_text\n${keys.map(() => 'x').join('\t')}\tDecoded label\n`;
  const fixtureBody = (url: unknown) =>
    String(url).endsWith('.series')
      ? SERIES_TEXT
      : (OE_TABLE_FILES[String(url).slice(String(url).lastIndexOf('/') + 1)] ?? TABLE_TEXT);

  // Complete declared tables keep these tests focused on transport and persistence.
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('sends the configured User-Agent and builds the index from a live harvest', async () => {
    const ua = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';
    const captured: Headers[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (init?.headers) captured.push(new Headers(init.headers));
      return Promise.resolve(new Response(fixtureBody(url), { status: 200 }));
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
      .mockImplementation((url) =>
        Promise.resolve(new Response(fixtureBody(url), { status: 200 })),
      );

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
    expect(urls.some((u) => u.includes('/oe/oe.series'))).toBe(false);

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
      if (u.includes('/cw/cw.periodicity'))
        return Promise.resolve(new Response('periodicity_code\tperiodicity_name\nR\tMonthly\n'));
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

/**
 * Real measure tables (2026-11-01): the tables whose labels BLS's API returns
 * verbatim as `catalog.measure_data_type` (#127).
 */
const CE_DATATYPE = tsv(
  ['data_type_code', 'data_type_text'],
  ['01', 'ALL EMPLOYEES, THOUSANDS'],
  ['03', 'AVERAGE HOURLY EARNINGS OF ALL EMPLOYEES'],
);
const LN_TDAT = tsv(
  ['tdat_code', 'tdat_text'],
  ['00', 'Number in thousands'],
  ['01', 'Percent or rate'],
);
const MP_MEASURE = tsv(
  ['measure_code', 'measure_text', 'display_level', 'selectable', 'sort_sequence'],
  ['01', 'Total factor productivity', '0', 'T', '1'],
  ['03', 'Combined inputs', '0', 'T', '5'],
);
const CM_DATATYPE = tsv(
  ['datatype_code', 'datatype_text', 'display_level', 'selectable', 'sort_sequence'],
  ['D', 'Cost of compensation (Cost per hour worked)', '0', 'T', '39'],
  ['P', 'Percent of total compensation', '0', 'T', '40'],
);

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
      'cu.periodicity': tsv(['periodicity_code', 'periodicity_name'], ['R', 'Monthly']),
    });

    const row = (await svc.lookupByIds(['CUSR0000SA0'])).get('CUSR0000SA0');
    expect(row).toEqual({
      seriesId: 'CUSR0000SA0',
      title: 'All items in U.S. city average, all urban consumers, seasonally adjusted',
      surveyAbbr: 'CU',
      areaName: 'U.S. city average',
      itemName: 'All items',
      measure: 'All items',
      seasonal: true,
      frequency: 'Monthly',
      startYear: 1947,
      endYear: 2026,
      endPeriod: 'M08',
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
      'ce.industry': tsv(['industry_code', 'industry_name'], ['20000000', 'Construction']),
      'ce.datatype': CE_DATATYPE,
    });
    const row = (await svc.lookupByIds(['CES2000000001'])).get('CES2000000001');
    expect(row?.title).toBe('All employees, thousands, construction, seasonally adjusted');
    expect(row?.seasonal).toBe(true);
  });
});

describe('BlsCatalogService.load — coverage (#90)', () => {
  it('keeps header-keyed and historical EC omitted-footnote-header coverage aligned', async () => {
    const normal = await harvestFrom(EC_FILES);
    const normalRow = (await normal.svc.lookupByIds(['ECS10001I'])).get('ECS10001I');
    expect(normalRow).toMatchObject({ startYear: 1982, endYear: 2005, endPeriod: 'Q04' });
    await normal.svc.shutdown();
    const { svc } = await harvestFrom({
      ...JT_FILES,
      ...EC_FILES,
      'ec.series': EC_FILES['ec.series']!.replace('footnote_codes\t', ''),
    });
    const rows = await svc.lookupByIds(['ECS10001I', 'JTS000000000000000QUR']);
    expect(rows.get('ECS10001I')).toMatchObject({
      startYear: 1982,
      endYear: 2005,
      endPeriod: 'Q04',
    });
    expect(rows.get('ECS10001I')).toEqual(normalRow);
    expect(rows.get('JTS000000000000000QUR')).toMatchObject({
      startYear: 2000,
      endYear: 2026,
      endPeriod: 'M07',
    });
    await svc.shutdown();
  });

  it('omits each invalid or missing coverage value independently', async () => {
    const { svc } = await harvestFrom({
      'ln.series': tsv(
        [
          'series_id',
          'series_title',
          'periodicity_code',
          'tdat_code',
          'end_period',
          'end_year',
          'begin_year',
        ],
        ['SPARSE1', 'Sparse coverage', 'M', '01', 'M08', '2026', ''],
        ['SPARSE2', 'Sparse coverage', 'M', '01', '', '20x6', '1948'],
        ['SPARSE3', 'Sparse coverage', 'M', '01', 'Q02', '2026.0', '0000'],
      ),
      'ln.periodicity': tsv(['periodicity_code', 'periodicity_text'], ['M', 'Monthly']),
      'ln.tdat': LN_TDAT,
    });
    const rows = await svc.lookupByIds(['SPARSE1', 'SPARSE2', 'SPARSE3']);
    expect(rows.get('SPARSE1')).toMatchObject({ endYear: 2026, endPeriod: 'M08' });
    expect(rows.get('SPARSE1')).not.toHaveProperty('startYear');
    expect(rows.get('SPARSE2')).toMatchObject({ startYear: 1948 });
    expect(rows.get('SPARSE2')).not.toHaveProperty('endYear');
    expect(rows.get('SPARSE2')).not.toHaveProperty('endPeriod');
    expect(rows.get('SPARSE3')).not.toHaveProperty('startYear');
    expect(rows.get('SPARSE3')).not.toHaveProperty('endYear');
    expect(rows.get('SPARSE3')).toHaveProperty('endPeriod', 'Q02');
    await svc.shutdown();
  });
});

describe('BlsCatalogService.load — declared table failures (#94)', () => {
  it.each(['missing', 'invalid', 'empty', 'rejected', 'body-read'])(
    'preserves the complete prior survey on %s table failure, retries, then recovers',
    async (failure) => {
      const dbPath = join(tmpDir, `table-${failure}.db`);
      const old = createCatalogStore(dbPath);
      const prior = {
        seriesId: 'JTS000000000000000QUR',
        title: 'Old quits',
        surveyAbbr: 'JT',
        seasonal: true,
        areaName: 'Old area',
        itemName: 'Old item',
        frequency: 'Quarterly',
        startYear: 1982,
        endYear: 2005,
        endPeriod: 'Q04',
      };
      await old.applyBatch(
        [toMirrorRow(prior), toMirrorRow({ ...prior, seriesId: 'KEEP_DELETED' })],
        [],
      );
      await old.writeState({
        status: 'complete',
        completedAt: new Date().toISOString(),
        checkpoint: catalogSurveyList(true),
      });
      await old.close();
      const files = { ...JT_FILES, ...EC_FILES };
      if (failure === 'missing') delete files['jt.dataelement'];
      if (failure === 'invalid') files['jt.dataelement'] = 'wrong\theader\nJO\tJob openings\n';
      if (failure === 'empty') files['jt.dataelement'] = 'dataelement_code\tdataelement_text\n';
      const { requested } = serveLabstat(files);
      const normalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      if (failure === 'rejected' || failure === 'body-read') {
        vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
          if (String(url).endsWith('/jt.dataelement')) {
            requested.push('jt.dataelement');
            if (failure === 'rejected') return Promise.reject(new Error('network failure'));
            const response = new Response('');
            vi.spyOn(response, 'text').mockRejectedValue(new Error('body failure'));
            return Promise.resolve(response);
          }
          return normalFetch(url, init);
        });
      }
      const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
      await svc.load(1);
      expect((await svc.lookupByIds([prior.seriesId])).get(prior.seriesId)).toEqual(prior);
      expect((await svc.lookupByIds(['KEEP_DELETED'])).has('KEEP_DELETED')).toBe(true);
      expect((await svc.lookupByIds(['ECS10001I'])).has('ECS10001I')).toBe(true);
      const attempts = requested.length;
      const stateStore = createCatalogStore(dbPath);
      const state = await stateStore.readState();
      expect(state.status).toBe('error');
      expect(state.completedAt).toBeDefined();
      expect(state.checkpoint).toBe(catalogSurveyList(false));
      await stateStore.close();
      await svc.load(1);
      expect(requested.length).toBeGreaterThan(attempts);
      // The retry requests the failed survey's files only, never EC's, which succeeded (#104).
      const retried = requested.slice(attempts);
      expect(retried).toContain('jt.series');
      expect(retried).toContain('jt.dataelement');
      expect(retried.filter((f) => f.startsWith('ec.'))).toEqual([]);
      await svc.shutdown();
      serveLabstat({ ...JT_FILES, ...EC_FILES });
      const recovered = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
      await recovered.load(1);
      expect((await recovered.lookupByIds([prior.seriesId])).get(prior.seriesId)?.title).toContain(
        'Quits - Total nonfarm',
      );
      expect((await recovered.lookupByIds(['KEEP_DELETED'])).has('KEEP_DELETED')).toBe(false);
      await recovered.shutdown();
    },
  );
});

describe('BlsCatalogService.load — retrying failed surveys (#104)', () => {
  const HOUR = 3_600_000;
  const T0 = Date.parse('2026-10-01T00:00:00Z');
  const surveys = catalogSurveyList(false).split(',');
  const healthySeries = surveys.filter((a) => a !== 'jt').map((a) => `${a}.series`);
  /** Key columns of the composite declared keys; every other key is `{table}_code`. */
  const COMPOSITE_KEYS = [
    'industry_code',
    'product_code',
    'group_code',
    'item_code',
    'comp_code',
    'data_type_code',
  ];

  type Served = (init: RequestInit | undefined) => Promise<Response>;
  const unavailable: Served = () => Promise.resolve(new Response('busy', { status: 503 }));
  /** Hangs until the request aborts, as a stalled download does. */
  const hang: Served = (init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  const storeOf = (svc: BlsCatalogService) =>
    (svc as unknown as { store: ReturnType<typeof createCatalogStore> }).store;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Serve every survey one fresh row (`{ABBR}NEW`) and every declared table a
   * decoding row, except the files `failing` answers — mutable between checks.
   * A `.series` body is built a microtask after its request, by which time its
   * survey's table requests (issued alongside it) have named every key column.
   */
  function serveSurveys(): {
    requested: string[];
    lines: string[];
    failing: Record<string, Served>;
  } {
    const requested: string[] = [];
    const lines: string[] = [];
    const failing: Record<string, Served> = {};
    const keys = new Set(COMPOSITE_KEYS);
    const row = (columns: string[]) => columns.map(() => 'x').join('\t');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const file = String(url).slice(String(url).lastIndexOf('/') + 1);
      requested.push(file);
      const [abbr = '', table = ''] = file.split('.');
      const failure = failing[file];
      if (failure) return failure(init);
      const oe = OE_TABLE_FILES[file];
      if (oe !== undefined) return new Response(oe);
      if (table !== 'series') {
        keys.add(`${table}_code`);
        const header = [...COMPOSITE_KEYS, `${table}_code`];
        return new Response(`${header.join('\t')}\tlabel_text\n${row(header)}\tDecoded\n`);
      }
      await Promise.resolve();
      const header = [...keys];
      return new Response(
        `series_id\tseries_title\tseasonal\t${header.join('\t')}\n${abbr.toUpperCase()}NEW\tSeries ${abbr}\tS\t${row(header)}\n`,
      );
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return { requested, lines, failing };
  }

  /** Persist a complete index holding `{ABBR}OLD` for every configured survey, completed `ageHours` ago. */
  async function seedComplete(path: string, ageHours: number): Promise<void> {
    const store = createCatalogStore(path);
    await store.applyBatch(
      surveys.map((abbr) =>
        toMirrorRow({
          seriesId: `${abbr.toUpperCase()}OLD`,
          title: `Old ${abbr}`,
          surveyAbbr: abbr.toUpperCase(),
          seasonal: true,
        }),
      ),
      [],
    );
    await store.writeState({
      status: 'complete',
      completedAt: new Date(Date.now() - ageHours * HOUR).toISOString(),
      total: surveys.length,
      checkpoint: catalogSurveyList(false),
    });
    await store.close();
  }

  /**
   * A service over a stale complete index whose first check harvests every
   * survey and fails JT's `.series` (HTTP 503) — JT's first failure.
   */
  async function afterJtFails(ttlHours = 168) {
    const path = join(tmpDir, `retry-${dbCounter++}.db`);
    await seedComplete(path, 200);
    const served = serveSurveys();
    served.failing['jt.series'] = unavailable;
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, ttlHours, false);
    await svc.load(1);
    return { ...served, svc, path };
  }

  /** The files one more check requests. */
  async function nextCheck(svc: BlsCatalogService, requested: string[]): Promise<string[]> {
    const before = requested.length;
    await svc.load(1);
    return requested.slice(before);
  }

  async function has(svc: BlsCatalogService, id: string): Promise<boolean> {
    return (await svc.lookupByIds([id])).has(id);
  }

  it('retries only the failed survey and its declared tables on the next check of a warm index', async () => {
    const { svc, requested } = await afterJtFails();
    expect(await has(svc, 'JTOLD')).toBe(true);
    expect(await has(svc, 'CUOLD')).toBe(false);
    expect(await has(svc, 'CUNEW')).toBe(true);

    const retry = await nextCheck(svc, requested);
    expect(retry).toContain('jt.series');
    expect(retry.length).toBeGreaterThan(1);
    expect(retry.filter((f) => !f.startsWith('jt.'))).toEqual([]);
    await svc.shutdown();
  });

  /** A body the runtime cannot read, as Node's string limit refuses a `.series` file over ~512 MiB. */
  const unreadable: Served = () => {
    const response = new Response('');
    vi.spyOn(response, 'text').mockRejectedValue(
      new RangeError('Cannot create a string longer than 0x1fffffe8 characters'),
    );
    return Promise.resolve(response);
  };

  it.each([
    ['an unreadable body', 168, [1, 3, 7, 15], unreadable],
    ['HTTP 503', 4, [1, 3, 7, 11, 15], unavailable],
  ])(
    'backs off a survey whose .series keeps failing (%s, TTL %i h): one download at checks %j after its first failure',
    async (_, ttlHours, retries, failure) => {
      const { svc, requested, failing } = await afterJtFails(ttlHours);
      failing['jt.series'] = failure;
      const hits: number[] = [];
      for (let check = 1; check <= 16; check++) {
        const files = await nextCheck(svc, requested);
        expect(files.filter((f) => !f.startsWith('jt.'))).toEqual([]);
        const downloads = files.filter((f) => f === 'jt.series').length;
        expect(downloads).toBeLessThanOrEqual(1);
        if (downloads > 0) hits.push(check);
      }
      expect(hits).toEqual(retries);
      await svc.shutdown();
    },
  );

  it('returns a recovered survey to TTL scheduling', async () => {
    const { svc, requested, failing } = await afterJtFails();
    for (let check = 1; check < 7; check++) await nextCheck(svc, requested);
    delete failing['jt.series'];
    expect(await nextCheck(svc, requested)).toContain('jt.series'); // check 7 succeeds
    expect(await has(svc, 'JTNEW')).toBe(true);

    for (let check = 8; check <= 30; check++) expect(await nextCheck(svc, requested)).toEqual([]);
    vi.setSystemTime(T0 + 169 * HOUR);
    expect(await nextCheck(svc, requested)).toContain('jt.series');
    await svc.shutdown();
  });

  it('re-harvests the healthy surveys once when their TTL lapses while another still fails', async () => {
    const { svc, requested } = await afterJtFails();
    await nextCheck(svc, requested); // check 1: JT retries and fails again; next JT retry at check 3

    vi.setSystemTime(T0 + 169 * HOUR);
    const lapsed = await nextCheck(svc, requested); // check 2
    expect(lapsed.filter((f) => f.endsWith('.series')).sort()).toEqual(healthySeries.sort());

    vi.setSystemTime(T0 + 170 * HOUR);
    const next = await nextCheck(svc, requested); // check 3: JT's retry only
    expect(next.filter((f) => f.endsWith('.series'))).toEqual(['jt.series']);
    await svc.shutdown();
  });

  it('makes one attempt per survey on a warm index when every .series fails, and keeps serving', async () => {
    const path = join(tmpDir, `outage-${dbCounter++}.db`);
    await seedComplete(path, 200);
    const { requested, failing } = serveSurveys();
    for (const abbr of surveys) failing[`${abbr}.series`] = unavailable;
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);

    await svc.load(); // the default three attempts apply only to an index with no series
    for (const abbr of surveys) {
      expect(requested.filter((f) => f === `${abbr}.series`)).toHaveLength(1);
    }
    expect(svc.readiness).toEqual({ status: 'ready' });
    expect(svc.totalSeries).toBe(surveys.length);
    expect(await has(svc, 'CUOLD')).toBe(true);
    await svc.shutdown();
  });

  it('retries an index with no series at every check and omits a survey that keeps failing', async () => {
    const { requested, failing } = serveSurveys();
    for (const abbr of surveys) failing[`${abbr}.series`] = unavailable;
    const svc = new BlsCatalogService(
      LABSTAT_URL,
      'ua/1.0',
      join(tmpDir, `cold-${dbCounter++}.db`),
    );
    for (let check = 1; check <= 3; check++) {
      const files = await nextCheck(svc, requested);
      expect(files.filter((f) => f.endsWith('.series')).sort()).toEqual(
        surveys.map((a) => `${a}.series`).sort(),
      );
    }

    for (const abbr of surveys) if (abbr !== 'jt') delete failing[`${abbr}.series`];
    await nextCheck(svc, requested);
    expect(await has(svc, 'CUNEW')).toBe(true);
    expect(svc.indexedSurveys).not.toContain('JT');
    expect((await nextCheck(svc, requested)).filter((f) => f.endsWith('.series'))).toEqual([
      'jt.series',
    ]);
    expect(svc.indexedSurveys).not.toContain('JT');
    await svc.shutdown();
  });

  it('deletes no row of a configured survey outside a retry, and still removes unconfigured surveys', async () => {
    const { svc, requested, failing } = await afterJtFails();
    await storeOf(svc).applyBatch(
      [
        toMirrorRow({ seriesId: 'OEUN1', title: 'OES', surveyAbbr: 'OE', seasonal: false }),
        toMirrorRow({ seriesId: 'CUEXTRA', title: 'Extra', surveyAbbr: 'CU', seasonal: false }),
      ],
      [],
    );
    delete failing['jt.series'];

    expect((await nextCheck(svc, requested)).filter((f) => f.endsWith('.series'))).toEqual([
      'jt.series',
    ]);
    expect(await has(svc, 'JTNEW')).toBe(true);
    expect(await has(svc, 'JTOLD')).toBe(false);
    expect(await has(svc, 'CUNEW')).toBe(true);
    expect(await has(svc, 'CUEXTRA')).toBe(true);
    expect(await has(svc, 'OEUN1')).toBe(false);
    await svc.shutdown();
  });

  it('writes complete only once every survey succeeded, with completedAt the oldest success', async () => {
    const { svc, requested, failing, path } = await afterJtFails();
    const stateOf = async () => {
      const store = createCatalogStore(path);
      const state = await store.readState();
      await store.close();
      return state;
    };
    const seeded = new Date(T0 - 200 * HOUR).toISOString();
    expect(await stateOf()).toMatchObject({ status: 'error', completedAt: seeded });

    delete failing['jt.series'];
    vi.setSystemTime(T0 + HOUR);
    await nextCheck(svc, requested);
    expect(await stateOf()).toMatchObject({
      status: 'complete',
      completedAt: new Date(T0).toISOString(),
      checkpoint: catalogSurveyList(false),
    });
    await svc.shutdown();
  });

  it('reports a failed .series request or body read on one stderr line with the file, cause, and next retry', async () => {
    const { svc, requested, lines, failing } = await afterJtFails();
    const jtLines = (from: number) => lines.slice(from).filter((l) => l.includes('jt.series'));
    const prefix = '[bls-labor-mcp-server] Catalog: jt.series unavailable';
    expect(jtLines(0)).toEqual([
      `${prefix} (HTTP 503) — its indexed rows are kept; next retry at the next hourly check.\n`,
    ]);

    failing['jt.series'] = () => {
      const response = new Response('');
      vi.spyOn(response, 'text').mockRejectedValue(new Error('body failure'));
      return Promise.resolve(response);
    };
    let from = lines.length;
    await nextCheck(svc, requested); // check 1
    expect(jtLines(from)).toEqual([
      `${prefix} (body read failed: body failure) — its indexed rows are kept; next retry in 2 hourly checks.\n`,
    ]);

    failing['jt.series'] = () => Promise.reject(new Error('network down'));
    await nextCheck(svc, requested); // check 2: not due
    from = lines.length;
    await nextCheck(svc, requested); // check 3
    expect(jtLines(from)).toEqual([
      `${prefix} (request failed: network down) — its indexed rows are kept; next retry in 4 hourly checks.\n`,
    ]);
    await svc.shutdown();
  });

  it('harvests every survey after a restart over an incomplete index', async () => {
    const { svc, requested, path } = await afterJtFails();
    await svc.shutdown();
    const restarted = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    const files = await nextCheck(restarted, requested);
    expect(files.filter((f) => f.endsWith('.series')).sort()).toEqual(
      surveys.map((a) => `${a}.series`).sort(),
    );
    await restarted.shutdown();
  });

  it('stops an in-flight retry on shutdown without a later write', async () => {
    const { svc, requested, failing } = await afterJtFails();
    failing['jt.series'] = hang;
    const writeState = vi.spyOn(storeOf(svc), 'writeState');
    const retry = svc.load(1).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.waitFor(() => expect(requested.at(-1)?.startsWith('jt.')).toBe(true));
    await svc.shutdown();
    expect(await retry).toMatch(/stopped by shutdown/);
    expect(writeState).not.toHaveBeenCalled();
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

/** Space-separated LABSTAT fields: a header, or a run of codes that hold no spaces. */
function fields(text: string): string[] {
  return text.split(' ');
}

/**
 * A real SM row: its code columns (state, area, supersector, industry, data
 * type) as one space-separated string, its seasonal flag, and its first year;
 * every row here closes on the 2025 benchmark and 2026 M09.
 */
function smRow(id: string, codes: string, seasonal: string, beginYear = '1990'): string[] {
  return [id, ...fields(codes), seasonal, '2025', '', beginYear, 'M01', '2026', 'M09'];
}

/**
 * Real rows of the catalog-only surveys (2026-11-01), with the code tables each
 * declares. SM and EE ship no `series_title`; EE's rows carry a footnote field
 * (`n`) its header does not name.
 */
const CATALOG_ONLY_FILES: Record<string, string> = {
  'sm.series': tsv(
    fields(
      'series_id state_code area_code supersector_code industry_code data_type_code seasonal benchmark_year footnote_codes begin_year begin_period end_year end_period',
    ),
    smRow('SMS00000000000000021', '00 00000 00 00000000 21', 'S', '1991'),
    smRow('SMS11477640000000001', '11 47764 00 00000000 01', 'S'),
    smRow('SMS48000000000000001', '48 00000 00 00000000 01', 'S'),
    smRow('SMS53000000000000001', '53 00000 00 00000000 01', 'S'),
    smRow('SMS53426600000000001', '53 42660 00 00000000 01', 'S'),
    smRow('SMU48000000500000003', '48 00000 05 05000000 03', 'U', '2007'),
    smRow('SMU53000000000000001', '53 00000 00 00000000 01', 'U', '1939'),
    smRow('SMU53426600000000001', '53 42660 00 00000000 01', 'U'),
  ),
  'sm.state': tsv(
    ['state_code', 'state_name'],
    ['00', 'All States'],
    ['11', 'District of Columbia'],
    ['48', 'Texas'],
    ['53', 'Washington'],
  ),
  'sm.area': tsv(
    ['area_code', 'area_name'],
    ['00000', 'Statewide'],
    ['42660', 'Seattle-Tacoma-Bellevue, WA'],
    ['47764', 'Washington, DC-MD Metropolitan Division'],
  ),
  'sm.data_type': tsv(
    ['data_type_code', 'data_type_text'],
    ['01', 'All Employees, In Thousands'],
    ['03', 'Average Hourly Earnings of All Employees, In Dollars'],
    ['21', 'Diffusion Indexes, 1-month span, seasonally adjusted, total nonfarm'],
  ),
  'sm.industry': tsv(
    ['industry_code', 'industry_name'],
    ['00000000', 'Total Nonfarm'],
    ['05000000', 'Total Private'],
  ),
  'ee.series': tsv(
    fields(
      'series_id industry_code data_type_code seasonal begin_year begin_period end_year end_period',
    ),
    fields('EES00000001 000000 01 S n 1939 M01 2003 M04'),
    fields('EEU00000001 000000 01 U n 1919 M13 2003 M04'),
    fields('EES00500001 005000 01 S n 1939 M01 2003 M04'),
    fields('EES20000003 200000 03 S n 1947 M01 2003 M04'),
  ),
  // A blank second line, and industry rows wider than their header, as upstream ships them.
  'ee.datatype': tsv(
    ['data_type_code', 'data_type_text'],
    [''],
    ['01', 'ALL EMPLOYEES, THOUSANDS'],
    ['03', 'PRODUCTION WORKERS, THOUSANDS'],
  ),
  'ee.industry': tsv(
    ['industry_code', 'SIC_code', 'publishing_status', 'industry_name'],
    [''],
    ['000000', 'N/A', 'B', 'Total nonfarm', '1 ', 'T', '1    '],
    ['005000', 'N/A', 'A', 'Total private', '1 ', 'T', '2    '],
    ['200000', '15-17', 'A', 'Construction', '2 ', 'T', '17   '],
  ),
  'bd.series': tsv(
    fields(
      'series_id seasonal msa_code state_code county_code industry_code unitanalysis_code dataelement_code sizeclass_code dataclass_code ratelevel_code periodicity_code ownership_code series_title footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('BDS0000000000000000110001LQ5 S 00000 00 000 000000 1 1 00 01 L Q 5'),
      'Quarterly gross job gains for the total private sector in the U.S. (rounded to the nearest thousands)',
      ...fields('1 1992 Q03 2026 Q01'),
    ],
    [
      ...fields('BDU0000000000000000110001RA5 U 00000 00 000 000000 1 1 00 01 R A 5'),
      'Percent of gross job gains for the total private sector in the U.S. (as a percentage of employment in this sector)',
      ...fields('1 1994 Q01 2026 Q01'),
    ],
    [
      ...fields('BDU0000000000000000110001RQ5 U 00000 00 000 000000 1 1 00 01 R Q 5'),
      'Percent of gross job gains for the total private sector in the U.S. (as a percentage of employment in this sector)',
      ...fields('1 1992 Q03 2026 Q01'),
    ],
    [
      ...fields('BDS0000053000000000110001LQ5 S 00000 53 000 000000 1 1 00 01 L Q 5'),
      'Gross job gains',
      ...fields('1 1992 Q03 2026 Q01'),
    ],
  ),
  'bd.state': tsv(['state_code', 'state_name'], ['00', 'U.S. totals'], ['53', 'Washington']),
  'bd.industry': tsv(
    ['industry_code', 'industry_name', 'display_level', 'selectable', 'sort_sequence'],
    ['000000', 'Total private', '0', 'T', '1'],
  ),
  'bd.periodicity': tsv(
    ['periodicity_code', 'periodicity_name'],
    ['A', 'Annual'],
    ['Q', 'Quarterly'],
  ),
  'ip.series': tsv(
    fields(
      'series_id seasonal sector_code industry_code measure_code duration_code base_year type_code area_code series_title footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('IPUAN1111__L011000000 U A N1111__ L01 1 - R 000000'),
      'Annual percent change of hours worked for NAICS 1111, oilseed and grain farming, U.S. total',
      ...fields('A 1988 A01 2024 A01'),
    ],
    [
      ...fields('IPUAN1111__L201000000 U A N1111__ L20 1 - R 000000'),
      'Annual percent change of hours worked for NAICS 1111, oilseed and grain farming, U.S. total',
      ...fields('A 1988 A01 2024 A01'),
    ],
    [
      ...fields('IPUZN______L000010000 U Z N______ L00 0 2017 I 010000'),
      'Annual labor productivity (index, 2017=100) for private nonfarm, Alabama',
      '',
      ...fields('2007 A01 2025 A01'),
    ],
  ),
  'ip.area': tsv(
    ['area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
    ['000000', 'U.S. Total', '1', 'T', '1'],
    ['010000', 'Alabama', '3', 'T', '2'],
  ),
  'ip.measure': tsv(
    ['measure_code', 'measure_text', 'display_level', 'selectable', 'sort_sequence'],
    ['L00', 'Labor productivity (Index, 2017=100)', '0', 'T', '2'],
    ['L01', 'Hours worked (Index, 2017=100)', '0', 'T', '7'],
    ['L20', 'Hours worked (Millions of hours)', '0', 'T', '31'],
  ),
  'le.series': tsv(
    fields(
      'series_id lfst_code fips_code series_title tdata_code pcts_code earn_code cert_code class_code unin_code indy_code occupation_code education_code ages_code race_code orig_code sexs_code born_code seasonal footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('LEU0252881500 25 00'),
      '(unadj)- Median usual weekly earnings (second quartile), Employed full time, Wage and salary workers',
      ...fields('00 00 01 00 16 0 0000 0000 00 00 00 00 0 00 U'),
      '',
      ...fields('1979 Q01 2026 Q03'),
    ],
    [
      ...fields('LEU0252881553 25 53'),
      '(unadj)- Median weekly earnings, Full-time wage and salary workers, Washington',
      ...fields('00 00 01 00 16 0 0000 0000 00 00 00 00 0 00 U'),
      '',
      ...fields('2012 A01 2025 A01'),
    ],
  ),
  'le.fips': tsv(['fips_code', 'fips_text'], ['00', 'U.S. Total'], ['53', 'Washington']),
  'lu.series': tsv(
    fields(
      'series_id lfst_code fips_code series_title tdata_code pcts_code earn_code class_code unin_code indy_code occupation_code education_code ages_code race_code orig_code sexs_code seasonal footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('LUU0201CEBE00 20 00'),
      '(unadj)- Percent of employed, Private wage and salary workers, Represented by unions, Broadcasting and content providers',
      ...fields('01 05 00 17 2 6671 0000 00 00 00 00 0 U'),
      '',
      ...fields('2025 A01 2025 A01'),
    ],
    [
      ...fields('LUU0203161853 20 53'),
      '(unadj)- Employed wage and salary workers, Members of unions, (WA) Washington',
      ...fields('00 00 00 16 1 0000 0000 00 00 00 00 0 U'),
      '',
      ...fields('2000 A01 2025 A01'),
    ],
  ),
  'lu.fips': tsv(['fips_code', 'fips_text'], ['00', 'U.S. Total'], ['53', 'Washington']),
  'su.series': tsv(
    fields(
      'series_id area_code item_code seasonal periodicity_code base_code base_period series_title footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('SUUR0000SA0 0000 SA0 U R S'),
      'DECEMBER 1999=100',
      'All items in U.S. city average, all urban consumers, chained, not seasonally adjusted',
      '',
      ...fields('1999 M12 2026 M09'),
    ],
  ),
  'su.area': tsv(
    ['area_code', 'area_name', 'display_level', 'selectable', 'sort_sequence'],
    ['0000', 'U.S. city average', '0', 'T', '1'],
  ),
  'su.item': tsv(
    ['item_code', 'item_name', 'display_level', 'selectable', 'sort_sequence'],
    ['SA0', 'All items', '0', 'T', '1'],
  ),
  'ei.series': tsv(
    fields(
      'series_id seasonal index_code series_name base_period series_title footnote_codes begin_year begin_period end_year end_period',
    ),
    [
      ...fields('EIUCDCANMANU U CD Canada-Manufacturing'),
      'December 2020=100',
      'Monthly export price index by destination for NAICS, Manufacturing, Canada, not seasonally adjusted',
      '',
      ...fields('2020 M12 2026 M09'),
    ],
  ),
};

const CATALOG_ONLY_SURVEYS = ['SM', 'LE', 'EI', 'SU', 'IP', 'BD', 'LU', 'EE'];

describe('BlsCatalogService.load — catalog-only surveys (#120)', () => {
  it('harvests all eight and returns each one under its survey filter', async () => {
    const { svc, requested } = await harvestFrom(CATALOG_ONLY_FILES);
    for (const abbr of CATALOG_ONLY_SURVEYS) {
      expect(requested).toContain(`${abbr.toLowerCase()}.series`);
    }
    expect(svc.indexedSurveys).toEqual([...CATALOG_ONLY_SURVEYS].sort());
    expect(svc.totalSeries).toBe(25);
    for (const survey of CATALOG_ONLY_SURVEYS) {
      const result = await svc.search(searchInput(survey, { survey, limit: 50 }));
      const ids = [...CATALOG_ONLY_FILES[`${survey.toLowerCase()}.series`]!.matchAll(/^(\w+)/gm)]
        .map((m) => m[1]!)
        .slice(1);
      expect(result.series.map((s) => s.seriesId).sort()).toEqual(ids.sort());
    }
  });

  it('titles SM rows from the data type, industry, and area; a statewide row takes its state as the area', async () => {
    const { svc } = await harvestFrom(CATALOG_ONLY_FILES);
    const ids = [...CATALOG_ONLY_FILES['sm.series']!.matchAll(/^(SM\w+)/gm)].map((m) => m[1]!);
    const rows = await svc.lookupByIds(ids);
    expect(rows.get('SMS53000000000000001')).toEqual({
      seriesId: 'SMS53000000000000001',
      title:
        'SAE - State and Area Employment, Hours, and Earnings - All Employees, In Thousands - Total Nonfarm - Washington',
      surveyAbbr: 'SM',
      areaName: 'Washington',
      itemName: 'Total Nonfarm',
      seasonal: true,
      startYear: 1990,
      endYear: 2026,
      endPeriod: 'M09',
    });
    expect(rows.get('SMU53426600000000001')).toMatchObject({
      title:
        'SAE - State and Area Employment, Hours, and Earnings - All Employees, In Thousands - Total Nonfarm - Seattle-Tacoma-Bellevue, WA',
      areaName: 'Seattle-Tacoma-Bellevue, WA',
      seasonal: false,
    });
    expect(rows.get('SMS11477640000000001')?.areaName).toBe(
      'Washington, DC-MD Metropolitan Division',
    );
    expect(rows.get('SMU48000000500000003')).toMatchObject({
      title:
        'SAE - State and Area Employment, Hours, and Earnings - Average Hourly Earnings of All Employees, In Dollars - Total Private - Texas',
      areaName: 'Texas',
      itemName: 'Total Private',
    });
    expect(rows.get('SMS00000000000000021')?.areaName).toBe('All States');
    for (const s of rows.values()) expect(s.areaName).not.toBe('Statewide');
    expect(await distinctTitleSeasonal(svc, ids)).toBe(ids.length);
  });

  it('titles EE rows from ee.datatype and ee.industry and reads coverage past the unlabeled footnote', async () => {
    const { svc } = await harvestFrom(CATALOG_ONLY_FILES);
    const rows = await svc.lookupByIds(['EES00000001', 'EEU00000001', 'EES20000003']);
    expect(rows.get('EES00000001')).toEqual({
      seriesId: 'EES00000001',
      title: 'CES (SIC basis, ended 2003) - ALL EMPLOYEES, THOUSANDS - Total nonfarm',
      surveyAbbr: 'EE',
      seasonal: true,
      startYear: 1939,
      endYear: 2003,
      endPeriod: 'M04',
    });
    expect(rows.get('EEU00000001')).toMatchObject({ startYear: 1919, endPeriod: 'M04' });
    expect(rows.get('EES20000003')?.title).toBe(
      'CES (SIC basis, ended 2003) - PRODUCTION WORKERS, THOUSANDS - Construction',
    );
  });

  it('decodes the BD area, industry, and frequency, separating twins that share a title', async () => {
    const { svc } = await harvestFrom(CATALOG_ONLY_FILES);
    const rows = await svc.lookupByIds([
      'BDU0000000000000000110001RA5',
      'BDU0000000000000000110001RQ5',
      'BDS0000053000000000110001LQ5',
    ]);
    const annual = rows.get('BDU0000000000000000110001RA5');
    const quarterly = rows.get('BDU0000000000000000110001RQ5');
    expect(annual).toMatchObject({
      areaName: 'U.S. totals',
      itemName: 'Total private',
      frequency: 'Annual',
      startYear: 1994,
    });
    expect(quarterly).toMatchObject({ areaName: 'U.S. totals', frequency: 'Quarterly' });
    expect(annual?.title).toBe(quarterly?.title);
    expect(rows.get('BDS0000053000000000110001LQ5')).toMatchObject({
      title: 'Gross job gains',
      areaName: 'Washington',
      frequency: 'Quarterly',
    });
  });

  it('decodes the IP area and measure, separating rows that share a title', async () => {
    const { svc } = await harvestFrom(CATALOG_ONLY_FILES);
    const rows = await svc.lookupByIds([
      'IPUAN1111__L011000000',
      'IPUAN1111__L201000000',
      'IPUZN______L000010000',
    ]);
    const index = rows.get('IPUAN1111__L011000000');
    const hours = rows.get('IPUAN1111__L201000000');
    expect(index).toMatchObject({
      areaName: 'U.S. Total',
      itemName: 'Hours worked (Index, 2017=100)',
      startYear: 1988,
      endYear: 2024,
      endPeriod: 'A01',
    });
    expect(hours).toMatchObject({
      areaName: 'U.S. Total',
      itemName: 'Hours worked (Millions of hours)',
    });
    expect(index?.title).toBe(hours?.title);
    expect(rows.get('IPUZN______L000010000')?.areaName).toBe('Alabama');
  });

  it('keeps series_title for LE, LU, SU, and EI, decoding LE and LU areas from their fips tables', async () => {
    const { svc } = await harvestFrom(CATALOG_ONLY_FILES);
    const rows = await svc.lookupByIds([
      'LEU0252881500',
      'LEU0252881553',
      'LUU0201CEBE00',
      'LUU0203161853',
      'SUUR0000SA0',
      'EIUCDCANMANU',
    ]);
    expect(rows.get('LEU0252881500')).toEqual({
      seriesId: 'LEU0252881500',
      title:
        '(unadj)- Median usual weekly earnings (second quartile), Employed full time, Wage and salary workers',
      surveyAbbr: 'LE',
      areaName: 'U.S. Total',
      seasonal: false,
      startYear: 1979,
      endYear: 2026,
      endPeriod: 'Q03',
    });
    expect(rows.get('LEU0252881553')?.areaName).toBe('Washington');
    expect(rows.get('LUU0201CEBE00')).toMatchObject({ surveyAbbr: 'LU', areaName: 'U.S. Total' });
    expect(rows.get('LUU0203161853')).toMatchObject({
      title: '(unadj)- Employed wage and salary workers, Members of unions, (WA) Washington',
      areaName: 'Washington',
    });
    expect(rows.get('SUUR0000SA0')).toEqual({
      seriesId: 'SUUR0000SA0',
      title:
        'All items in U.S. city average, all urban consumers, chained, not seasonally adjusted',
      surveyAbbr: 'SU',
      areaName: 'U.S. city average',
      itemName: 'All items',
      seasonal: false,
      startYear: 1999,
      endYear: 2026,
      endPeriod: 'M09',
    });
    expect(rows.get('EIUCDCANMANU')).toEqual({
      seriesId: 'EIUCDCANMANU',
      title:
        'Monthly export price index by destination for NAICS, Manufacturing, Canada, not seasonally adjusted',
      surveyAbbr: 'EI',
      seasonal: false,
      startYear: 2020,
      endYear: 2026,
      endPeriod: 'M09',
    });
  });

  it.each([
    ['LE', 'U.S. Total'],
    ['BD', 'U.S. totals'],
    ['SM', 'All States'],
  ])('ranks the national %s row (%s) above a state row that ties it', async (survey, national) => {
    // The one-word state area keeps its title shorter in tokens, so bm25 puts it first.
    const svc = await seedAndLoad([
      {
        seriesId: `${survey}STATE`,
        title: 'Median weekly earnings, Washington',
        surveyAbbr: survey,
        seasonal: false,
        areaName: 'Washington',
      },
      {
        seriesId: `${survey}NATIONAL`,
        title: `Median weekly earnings, ${national}`,
        surveyAbbr: survey,
        seasonal: false,
        areaName: national,
      },
    ]);
    const result = await svc.search(searchInput('median weekly earnings'));
    expect(result.series.map((s) => s.seriesId)).toEqual([`${survey}NATIONAL`, `${survey}STATE`]);
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
      'ce.datatype': CE_DATATYPE,
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
      'mp.measure': MP_MEASURE,
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
      cm: 'area aspect contacts datatype estimate footnote industry occupation owner seasonal series subcell',
      ci: 'area aspect contacts estimate footnote industry occupation owner periodicity seasonal series subcell',
      ec: 'compensation group ownership period periodicity seasonal series',
      jt: 'area dataelement industry period ratelevel seasonal series sizeclass state',
      la: 'area area_type areamaps map_info measure period seasonal series state_region_division',
      ln: 'absn activity ages aspect born cert chld class disa duration education entr expr hheader hour indy jdes lfst look mari mjhs occupation orig pcts periodicity race rjnw rnlf rwns seasonal seek series sexs tdat tlwk vets wkst',
      mp: 'duration measure period seasonal sector series',
      oe: 'area areatype datatype industry occupation release seasonal sector series',
      pc: 'industry period product seasonal series',
      pr: 'class duration measure period seasonal sector series',
      wp: 'group item period seasonal series',
      // The catalog-only surveys, listed 2026-11-01 (#120).
      bd: 'contacts county dataclass dataelement footnote industry msa ownership periodicity ratelevel seasonal series sizeclass state unitanalysis',
      ee: 'contacts datatype footnote industry period seasonal series',
      ei: 'contacts footnote index period seasonal series',
      ip: 'area contacts duration footnote industry measure seasonal sector series type',
      le: 'ages born cert class contacts earn education fips footnote indy lfst occupation orig pcts race seasonal series sexs tdata unin',
      lu: 'ages class contacts earn education fips footnote indy lfst occupation orig pcts periodicity race seasonal series sexs tdata unin',
      sm: 'area contacts data_type footnote industry period seasonal series state supersector',
      su: 'area base footnote item periodicity seasonal series',
    };
    const listed = new Set(
      Object.entries(LISTED).flatMap(([abbr, names]) =>
        names.split(' ').map((n) => `${abbr}.${n}`),
      ),
    );
    const files = Object.fromEntries([...listed].map((f) => [f, 'header_only\r\n']));

    const { requested } = await harvestFrom(files, { includeOes: true });
    expect(requested.filter((f) => f.endsWith('.series'))).toHaveLength(23);
    expect(requested.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('omits a cold survey whose declared code table 404s, reporting the table on stderr', async () => {
    const { 'jt.state': _dropped, ...withoutState } = JT_FILES;
    const { svc, warnings } = await harvestFrom(withoutState);

    const row = (await svc.lookupByIds(['JTS000000060000000JOR'])).get('JTS000000060000000JOR');
    expect(row).toBeUndefined();
    expect(warnings.filter((w) => w.includes('jt.state'))).toEqual([
      '[bls-labor-mcp-server] Catalog: jt.state unavailable (HTTP 404) — its indexed rows are kept.\n',
    ]);
  });

  it('reports a code table whose header lacks the declared key column', async () => {
    const { svc, warnings } = await harvestFrom({
      ...JT_FILES,
      'jt.sizeclass': tsv(['size_code', 'sizeclass_text'], ['00', 'All size classes']),
    });

    const row = (await svc.lookupByIds(['JTS000000000000000QUR'])).get('JTS000000000000000QUR');
    expect(row).toBeUndefined();
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

  /**
   * Persist a fresh (inside-TTL) legacy index holding the pre-fix JT QUR row,
   * with the configured survey list, so only the index version marks it stale.
   */
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
      checkpoint: catalogSurveyList(false),
    });
    await legacy.close();
  }

  it('re-harvests a fresh legacy index, serves it meanwhile, and retries its incomplete refresh', async () => {
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

    // JT succeeded, but other surveys failed: the upgraded schema persists and the harvest retries.
    fetchSpy.mockClear();
    const next = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await next.load(1);
    expect(fetchSpy).toHaveBeenCalled();
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
    expect(svc.readiness).toEqual({ status: 'ready' });
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
// Publication frequency (#85)
// ---------------------------------------------------------------------------

const CU_HEADER = [
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
];

/** A CPI-family `.series` row (CU and CW share the layout). */
const cpiRow = (id: string, area: string, seasonal: string, periodicity: string, title: string) => [
  id,
  area,
  'SA0',
  seasonal,
  periodicity,
  'S',
  '1982-84=100',
  title,
  '',
  '1947',
  'M01',
  '2026',
  'M08',
];

/** CPI periodicity table as upstream ships it: `periodicity_name` labels. */
const CPI_PERIODICITY = tsv(
  ['periodicity_code', 'periodicity_name'],
  ['R', 'Monthly'],
  ['S', 'Semi-Annual'],
);

const CPI_AREA = tsv(
  ['area_code', 'area_name', 'display_level', 'selectable', 'sort_sequence'],
  ['0000', 'U.S. city average', '0', 'T', '1'],
  ['S49D', 'Seattle-Tacoma-Bellevue, WA', '1', 'T', '79'],
);
const CPI_ITEM = tsv(
  ['item_code', 'item_name', 'display_level', 'selectable', 'sort_sequence'],
  ['SA0', 'All items', '0', 'T', '1'],
);

const US_NSA = 'All items in U.S. city average, all urban consumers, not seasonally adjusted';
const SEA_NSA =
  'All items in Seattle-Tacoma-Bellevue, WA, all urban consumers, not seasonally adjusted';
const CW_NSA =
  'All items in U.S. city average, urban wage earners and clerical workers, not seasonally adjusted';

/**
 * Real cu/cw/ln rows (2026-09-23): monthly/semiannual CPI twins that share a
 * title, and CPS monthly/quarterly twins plus an annual-only series. `ln.periodicity`
 * labels its codes in `periodicity_text`, the CPI tables in `periodicity_name`.
 */
const FREQUENCY_FILES: Record<string, string> = {
  'cu.series': tsv(
    CU_HEADER,
    cpiRow(
      'CUSR0000SA0      ',
      '0000',
      'S',
      'R',
      'All items in U.S. city average, all urban consumers, seasonally adjusted',
    ),
    cpiRow('CUUR0000SA0      ', '0000', 'U', 'R', US_NSA),
    cpiRow('CUUS0000SA0      ', '0000', 'U', 'S', US_NSA),
    cpiRow('CUURS49DSA0      ', 'S49D', 'U', 'R', SEA_NSA),
    cpiRow('CUUSS49DSA0      ', 'S49D', 'U', 'S', SEA_NSA),
    // A code the periodicity table does not list: the row keeps no frequency.
    cpiRow(
      'CUUX0000SA0      ',
      '0000',
      'U',
      'X',
      'All items test row with an unlisted periodicity',
    ),
  ),
  'cu.periodicity': CPI_PERIODICITY,
  'cu.area': CPI_AREA,
  'cu.item': CPI_ITEM,
  'cw.series': tsv(
    CU_HEADER,
    cpiRow('CWUR0000SA0      ', '0000', 'U', 'R', CW_NSA),
    cpiRow('CWUS0000SA0      ', '0000', 'U', 'S', CW_NSA),
  ),
  'cw.periodicity': CPI_PERIODICITY,
  'cw.area': CPI_AREA,
  'cw.item': CPI_ITEM,
  'ln.series': tsv(
    [
      'series_id        ',
      'lfst_code',
      'periodicity_code',
      'series_title',
      'seasonal',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
      'tdat_code',
    ],
    [
      'LNS14000000      ',
      '40',
      'M',
      '(Seas) Unemployment Rate',
      'S',
      '',
      '1948',
      'M01',
      '2026',
      'M08',
      '01',
    ],
    [
      'LNS14000000Q     ',
      '40',
      'Q',
      '(Seas) Unemployment Rate',
      'S',
      '',
      '1948',
      'Q01',
      '2026',
      'Q02',
      '01',
    ],
    [
      'LNU04000000      ',
      '40',
      'M',
      '(Unadj) Unemployment Rate',
      'U',
      '',
      '1948',
      'M01',
      '2026',
      'M08',
      '01',
    ],
    [
      'LNU04000000Q     ',
      '40',
      'Q',
      '(Unadj) Unemployment Rate',
      'U',
      '',
      '1948',
      'Q01',
      '2026',
      'Q02',
      '01',
    ],
    [
      'LNU04079823      ',
      '40',
      'A',
      '(unadj) Unemployment rate - Divorced',
      'U',
      '',
      '1994',
      'A01',
      '2025',
      'A01',
      '01',
    ],
  ),
  'ln.periodicity': tsv(
    ['periodicity_code', 'periodicity_text'],
    ['A', 'Annual'],
    ['M', 'Monthly'],
    ['Q', 'Quarterly'],
  ),
  'ln.tdat': LN_TDAT,
};

describe('BlsCatalogService.load — publication frequency (#85)', () => {
  it('decodes CU, CW, and LN periodicity codes into a frequency and leaves titles unchanged', async () => {
    const { svc, requested } = await harvestFrom(FREQUENCY_FILES);
    const rows = await svc.lookupByIds([
      'CUSR0000SA0',
      'CUUR0000SA0',
      'CUUS0000SA0',
      'CWUR0000SA0',
      'CWUS0000SA0',
      'LNS14000000',
      'LNS14000000Q',
      'LNU04079823',
    ]);
    const freq = Object.fromEntries([...rows].map(([id, s]) => [id, s.frequency]));
    expect(freq).toEqual({
      CUSR0000SA0: 'Monthly',
      CUUR0000SA0: 'Monthly',
      CUUS0000SA0: 'Semi-Annual',
      CWUR0000SA0: 'Monthly',
      CWUS0000SA0: 'Semi-Annual',
      LNS14000000: 'Monthly',
      LNS14000000Q: 'Quarterly',
      LNU04079823: 'Annual',
    });
    expect(rows.get('CUUS0000SA0')?.title).toBe(US_NSA);
    expect(rows.get('CWUS0000SA0')?.title).toBe(CW_NSA);
    expect(rows.get('LNS14000000Q')?.title).toBe('(Seas) Unemployment Rate');
    expect(requested).toEqual(
      expect.arrayContaining(['cu.periodicity', 'cw.periodicity', 'ln.periodicity']),
    );
  });

  it('separates every twin that shares a title and seasonal flag', async () => {
    const { svc } = await harvestFrom(FREQUENCY_FILES);
    const ids = [
      ...Object.values(FREQUENCY_FILES)
        .join('\n')
        .matchAll(/^((?:CU|CW|LN)\w+)/gm),
    ].map((m) => m[1]!);
    const rows = [...(await svc.lookupByIds(ids)).values()];
    expect(rows).toHaveLength(ids.length);
    const withFrequency = new Set(rows.map((s) => `${s.title}|${s.seasonal}|${s.frequency}`));
    expect(withFrequency.size).toBe(ids.length);
    expect(new Set(rows.map((s) => `${s.title}|${s.seasonal}`)).size).toBeLessThan(ids.length);
  });

  it('leaves the frequency unset for an unlisted code and for surveys without the dimension', async () => {
    const { svc } = await harvestFrom({ ...FREQUENCY_FILES, ...EC_FILES, ...CM_CI_FILES });
    const rows = await svc.lookupByIds(['CUUX0000SA0', 'ECS20002Q', 'CIU1010000000000A']);
    expect(rows.size).toBe(3);
    // CI's periodicity_code is a measure type (12-month percent change), not a frequency.
    for (const s of rows.values()) expect(s).not.toHaveProperty('frequency');
  });
});

describe('BlsCatalogService.search — frequency words (#85)', () => {
  /**
   * Regional monthly/semiannual CPI twins and monthly/quarterly/annual CPS rows,
   * semiannual and quarterly seeded first. No row is a `COMMON_SERIES` headline,
   * whose own boost would decide the order.
   */
  const cpiTwin = (seriesId: string, areaName: string, frequency: string): CatalogSeries => ({
    seriesId,
    title: `All items in ${areaName}, all urban consumers, not seasonally adjusted`,
    surveyAbbr: 'CU',
    seasonal: false,
    areaName,
    itemName: 'All items',
    frequency,
  });
  const lnRow = (seriesId: string, title: string, frequency?: string): CatalogSeries => ({
    seriesId,
    title,
    surveyAbbr: 'LN',
    seasonal: false,
    ...(frequency && { frequency }),
  });
  const ROWS: CatalogSeries[] = [
    cpiTwin('CUUS0100SA0', 'Northeast urban', 'Semi-Annual'),
    cpiTwin('CUUR0100SA0', 'Northeast urban', 'Monthly'),
    cpiTwin('CUUSS49DSA0', 'Seattle-Tacoma-Bellevue, WA', 'Semi-Annual'),
    cpiTwin('CUURS49DSA0', 'Seattle-Tacoma-Bellevue, WA', 'Monthly'),
    lnRow('LNU04000000Q', '(Unadj) Unemployment Rate', 'Quarterly'),
    lnRow('LNU04000000', '(Unadj) Unemployment Rate', 'Monthly'),
    lnRow('LNU04079823', '(unadj) Unemployment rate - Divorced', 'Annual'),
    lnRow('LNU04000001', '(Unadj) Unemployment Rate - test'),
  ];
  const idsFor = async (svc: BlsCatalogService, query: string, survey?: string) =>
    (await svc.search(search(query, survey ? { survey } : {}))).series.map((s) => s.seriesId);

  it('keeps candidate order at equal score when the query names no frequency — never a tie-break', async () => {
    const svc = await seedAndLoad(ROWS);
    expect(await idsFor(svc, 'all items', 'CU')).toEqual([
      'CUUS0100SA0',
      'CUUR0100SA0',
      'CUUSS49DSA0',
      'CUURS49DSA0',
    ]);
    expect((await idsFor(svc, 'unemployment rate', 'LN')).slice(0, 2)).toEqual([
      'LNU04000000Q',
      'LNU04000000',
    ]);
  });

  it.each(['monthly all items', 'all items monthly', 'MONTHLY all items'])(
    '%j lifts the monthly twins over their semiannual twins',
    async (query) => {
      const svc = await seedAndLoad(ROWS);
      expect(await idsFor(svc, query, 'CU')).toEqual([
        'CUUR0100SA0',
        'CUURS49DSA0',
        'CUUS0100SA0',
        'CUUSS49DSA0',
      ]);
    },
  );

  it.each(['semiannual all items', 'semi-annual all items', 'semi annual all items'])(
    '%j keeps the semiannual twins first and lifts them over equal monthly rows',
    async (query) => {
      const svc = await seedAndLoad([...ROWS].reverse());
      const ids = await idsFor(svc, query, 'CU');
      expect(ids.slice(0, 2).sort()).toEqual(['CUUS0100SA0', 'CUUSS49DSA0']);
    },
  );

  it('lifts the quarterly twin for "quarterly unemployment rate"', async () => {
    const svc = await seedAndLoad([...ROWS].reverse());
    const ids = await idsFor(svc, 'quarterly unemployment rate', 'LN');
    expect(ids.indexOf('LNU04000000Q')).toBeLessThan(ids.indexOf('LNU04000000'));
  });

  it('never matches "annual", which names the annual-average period monthly series also carry', async () => {
    const svc = await seedAndLoad(ROWS);
    expect(await idsFor(svc, 'annual all items', 'CU')).toEqual(
      await idsFor(svc, 'all items', 'CU'),
    );
    expect(await idsFor(svc, 'annual unemployment rate', 'LN')).toEqual(
      await idsFor(svc, 'unemployment rate', 'LN'),
    );
  });

  it('matches frequency words only as whole words', async () => {
    const svc = await seedAndLoad(ROWS);
    expect(await idsFor(svc, 'bimonthly all items', 'CU')).toEqual(
      await idsFor(svc, 'all items', 'CU'),
    );
  });

  it('qualifies a match but never makes one: a frequency word alone surfaces no headline row', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'LNS14000000',
        title: '(Seas) Unemployment Rate',
        surveyAbbr: 'LN',
        seasonal: true,
        frequency: 'Monthly',
      },
      {
        seriesId: 'TEST_BANANA_01',
        title: 'Banana retail price',
        surveyAbbr: 'AP',
        seasonal: false,
      },
    ]);
    expect(await idsFor(svc, 'monthly banana')).toEqual(['TEST_BANANA_01']);
  });

  it('returns the stored frequency on each result', async () => {
    const svc = await seedAndLoad(ROWS);
    const result = await svc.search(search('LNU04000000Q'));
    expect(result.series[0]).toMatchObject({ seriesId: 'LNU04000000Q', frequency: 'Quarterly' });
    const plain = await svc.search(search('LNU04000001'));
    expect(plain.series[0]).not.toHaveProperty('frequency');
  });
});

describe('queryFrequencies (#85)', () => {
  it('names each frequency word once, normalized', () => {
    expect([...queryFrequencies('semi-annual and semi annual and semiannual cpi')]).toEqual([
      'semiannual',
    ]);
    expect([...queryFrequencies('monthly vs quarterly')].sort()).toEqual(['monthly', 'quarterly']);
    expect([...queryFrequencies('annual average bimonthly semiannually')]).toEqual([]);
  });
});

describe('BlsCatalogService.load — index version 4 adds frequency and coverage columns (#85, #90)', () => {
  /** The catalog store as 0.5.x persisted it: index version 2, no frequency column. */
  function v2Store(path: string) {
    return sqliteMirrorStore({
      path,
      version: 2,
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

  async function columnsOf(dbPath: string): Promise<{ columns: string[]; version: number }> {
    const store = createCatalogStore(dbPath);
    const db = await store.raw();
    const columns = db
      .prepare<{ name: string }>('PRAGMA table_info(bls_catalog)')
      .all()
      .map((c) => c.name);
    const version = db
      .prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')
      .get()?.v;
    await store.close();
    return { columns, version: version ?? 0 };
  }

  it('adds the column to a fresh v2 index, re-harvests once, and serves the old rows meanwhile', async () => {
    const dbPath = join(tmpDir, 'v2.db');
    const legacy = v2Store(dbPath);
    await legacy.applyBatch(
      [
        {
          series_id: 'LNS14000000Q',
          title: '(Seas) Unemployment Rate',
          survey_abbr: 'LN',
          area_name: null,
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
      checkpoint: catalogSurveyList(false),
    });
    await legacy.close();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      await gate;
      const body = FREQUENCY_FILES[u.slice(u.lastIndexOf('/') + 1)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    const loading = svc.load(1);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const during = await svc.search(searchInput('LNS14000000Q'));
    expect(during.series[0]).toMatchObject({
      seriesId: 'LNS14000000Q',
      title: '(Seas) Unemployment Rate',
    });
    expect(during.series[0]).not.toHaveProperty('frequency');

    release();
    await loading;
    expect((await svc.lookupByIds(['LNS14000000Q'])).get('LNS14000000Q')?.frequency).toBe(
      'Quarterly',
    );
    await svc.shutdown();

    const { columns, version } = await columnsOf(dbPath);
    expect(columns.filter((c) => c === 'frequency')).toHaveLength(1);
    for (const name of ['start_year', 'end_year', 'end_period'])
      expect(columns.filter((c) => c === name)).toHaveLength(1);
    expect(version).toBe(5);

    fetchSpy.mockClear();
    const next = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await next.load(1);
    expect(fetchSpy).toHaveBeenCalled();
    await next.shutdown();
  });

  it('creates the column on a fresh database, which the migration tolerates, and runs it once', async () => {
    const dbPath = join(tmpDir, 'fresh-v3.db');
    const { columns, version } = await columnsOf(dbPath);
    expect(columns.filter((c) => c === 'frequency')).toHaveLength(1);
    for (const name of ['start_year', 'end_year', 'end_period'])
      expect(columns.filter((c) => c === name)).toHaveLength(1);
    expect(version).toBe(5);

    const store = createCatalogStore(dbPath);
    const completedAt = new Date().toISOString();
    await store.writeState({ status: 'complete', completedAt, total: 0 });
    await store.close();
    const reopened = createCatalogStore(dbPath);
    expect((await reopened.readState()).completedAt).toBe(completedAt);
    await reopened.close();
  });

  it('upgrades a v3 database with only some coverage columns without duplicating them', async () => {
    const dbPath = join(tmpDir, 'partial-columns.db');
    const legacy = sqliteMirrorStore({
      path: dbPath,
      version: 3,
      table: 'bls_catalog',
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
      },
      fts: ['series_id', 'title', 'area_name', 'item_name'],
    });
    await legacy.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      checkpoint: catalogSurveyList(false),
    });
    await legacy.close();
    const upgraded = createCatalogStore(dbPath);
    expect((await upgraded.readState()).completedAt).toBeUndefined();
    await upgraded.close();
    for (let open = 0; open < 2; open++) {
      const { columns, version } = await columnsOf(dbPath);
      for (const name of ['frequency', 'start_year', 'end_year', 'end_period'])
        expect(columns.filter((c) => c === name)).toHaveLength(1);
      expect(version).toBe(5);
    }
  });
});

describe('BlsCatalogService.load — index version 5 adds the measure column (#127)', () => {
  it('adds the column to a fresh v4 index once and re-harvests it with the measure decoded', async () => {
    const dbPath = join(tmpDir, 'v4.db');
    const v4 = sqliteMirrorStore({
      path: dbPath,
      version: 4,
      table: 'bls_catalog',
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
      },
      fts: ['series_id', 'title', 'area_name', 'item_name'],
      indexes: [{ columns: ['survey_abbr'] }, { columns: ['seasonal'] }],
    });
    await v4.applyBatch(
      [
        {
          series_id: 'CES0000000001',
          title: 'All employees, thousands, total nonfarm, seasonally adjusted',
          survey_abbr: 'CE',
          area_name: null,
          item_name: 'Total nonfarm',
          seasonal: 1,
        },
      ],
      [],
    );
    await v4.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      total: 1,
      checkpoint: catalogSurveyList(false),
    });
    await v4.close();

    serveLabstat(MEASURE_FILES);
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await svc.load(1);
    expect((await svc.lookupByIds(['CES0000000001'])).get('CES0000000001')?.measure).toBe(
      'ALL EMPLOYEES, THOUSANDS',
    );
    await svc.shutdown();

    for (let open = 0; open < 2; open++) {
      const store = createCatalogStore(dbPath);
      const db = await store.raw();
      const columns = db
        .prepare<{ name: string }>('PRAGMA table_info(bls_catalog)')
        .all()
        .map((c) => c.name);
      const version = db
        .prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')
        .get()?.v;
      await store.close();
      expect(columns.filter((c) => c === 'measure')).toHaveLength(1);
      expect(version).toBe(5);
    }
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

// ---------------------------------------------------------------------------
// Area codes and states (#110)
// ---------------------------------------------------------------------------

/**
 * Catalog rows of the 2026-11-01 files, as `[SeriesID, title, survey, area]`,
 * that an area code or state selects or a substring would wrongly reach.
 */
const AREA_GRAMMAR_ROWS: CatalogSeries[] = (
  [
    ['LASST480000000000003', 'Unemployment Rate: Texas (S)', 'LA', 'Texas'],
    [
      'LAUCN480010000000003',
      'Unemployment Rate: Anderson County, TX (U)',
      'LA',
      'Anderson County, TX',
    ],
    ['LAUCN292150000000003', 'Unemployment Rate: Texas County, MO (U)', 'LA', 'Texas County, MO'],
    ['LNU0404952648', '(Unadj) Unemployment Rate - Veterans, 18 years and over, Texas', 'LN'],
    ['LNU0404960148', '(Unadj) Unemployment Rate - Nonveterans, 18 years and over, Texas', 'LN'],
    ['LNS14000048', '(Seas) Unemployment Rate - 25 yrs. & over', 'LN'],
    ['LNS14024887', '(Seas) Unemployment Rate - 16-24 yrs.', 'LN'],
    ['LNS14000000', 'Unemployment Rate', 'LN'],
    ['LNU04050008', '(Unadj) Unemployment Rate - Veterans, Gulf War Era, 25 to 34 years', 'LN'],
    ['LNU04096935', '(unadj) Unemployment rate - Experienced, Dishwashers', 'LN'],
    ['LNU04083444', '(unadj) Unemployment rate - Dominican', 'LN'],
    ['LNU04027990', '(unadj) Unemployment rate - Never married', 'LN'],
    [
      'JTS000000480000000QUR',
      'JOLTS - Quits - Total nonfarm - Texas - All size classes - Rate',
      'JT',
      'Texas',
    ],
    [
      'JTS000000060000000QUR',
      'JOLTS - Quits - Total nonfarm - California - All size classes - Rate',
      'JT',
      'California',
    ],
    [
      'JTS000000000000000QUR',
      'JOLTS - Quits - Total nonfarm - Total US - All size classes - Rate',
      'JT',
      'Total US',
    ],
    [
      'JTS000000NE0000000QUR',
      'JOLTS - Quits - Total nonfarm - Northeast region - All size classes - Rate',
      'JT',
      'Northeast region',
    ],
    ['LASST530000000000003', 'Unemployment Rate: Washington (S)', 'LA', 'Washington'],
    ['LASST060000000000003', 'Unemployment Rate: California (S)', 'LA', 'California'],
    ['LAUCT536300000000003', 'Unemployment Rate: Seattle city, WA (U)', 'LA', 'Seattle city, WA'],
    [
      'LAUCS253630000000003',
      'Unemployment Rate: Longmeadow town, MA (U)',
      'LA',
      'Longmeadow town, MA',
    ],
    [
      'LAUMT534266000000003',
      'Unemployment Rate: Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area (U)',
      'LA',
      'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
    ],
    ['LAUCS234266000000003', 'Unemployment Rate: Madison town, ME (U)', 'LA', 'Madison town, ME'],
    [
      'LAUCA535000000000003',
      'Unemployment Rate: Seattle-Tacoma, WA Combined Statistical Area (U)',
      'LA',
      'Seattle-Tacoma, WA Combined Statistical Area',
    ],
    ['LAUCN530330000000003', 'Unemployment Rate: King County, WA (U)', 'LA', 'King County, WA'],
    [
      'CIU20100000000LLA',
      'Total compensation for private industry workers in the Seattle-Tacoma, WA CSA, 12-month percent change, current dollars',
      'CI',
      'Seattle-Tacoma, WA CSA',
    ],
    [
      'CUURS49DSA0',
      'All items in Seattle-Tacoma-Bellevue, WA, all urban consumers, not seasonally adjusted',
      'CU',
      'Seattle-Tacoma-Bellevue WA',
    ],
    [
      'CUUR0000SA0',
      'All items in U.S. city average, all urban consumers, not seasonally adjusted',
      'CU',
      'U.S. city average',
    ],
    [
      'CUUR0100SA0',
      'All items in Northeast urban, all urban consumers, not seasonally adjusted',
      'CU',
      'Northeast',
    ],
  ] as const
).map(([seriesId, title, surveyAbbr, areaName]) => ({
  seriesId,
  title,
  surveyAbbr,
  seasonal: seriesId[2] === 'S',
  ...(areaName !== undefined && { areaName }),
}));

describe('BlsCatalogService.search — area codes and states (#110)', () => {
  const idsFor = async (svc: BlsCatalogService, query: string, area: string) =>
    (await svc.search(search(query, { area, limit: 50 }))).series.map((s) => s.seriesId).sort();

  it.each(['48', 'TX', 'tx'])(
    'area %j is Texas: its statewide row, the areas in it, and titles naming it',
    async (area) => {
      const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
      // Not the CPS rows whose IDs hold 48, nor Texas County, MO.
      expect(await idsFor(svc, 'unemployment rate', area)).toEqual([
        'JTS000000480000000QUR',
        'LASST480000000000003',
        'LAUCN480010000000003',
        'LNU0404952648',
        'LNU0404960148',
      ]);
      const quits = await svc.search(search('quits rate', { area }));
      expect(quits.series[0]?.seriesId).toBe('JTS000000480000000QUR');
    },
  );

  it('reads a USPS code as the state, never as letters inside a word', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    expect(await idsFor(svc, 'unemployment rate', 'WA')).toEqual([
      'LASST530000000000003',
      'LAUCA535000000000003',
      'LAUCN530330000000003',
      'LAUCT536300000000003',
      'LAUMT534266000000003',
    ]);
    // CPI names a metro with its state after a space, not a comma.
    expect(await idsFor(svc, 'all items', 'Wa')).toEqual(['CUURS49DSA0']);
    expect(await idsFor(svc, 'unemployment rate', 'CA')).toEqual([
      'JTS000000060000000QUR',
      'LASST060000000000003',
    ]);
  });

  it('resolves 5- and 7-digit codes to the area they name, in every survey that decodes it', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    // 42660 sits inside Madison town's county-subdivision code; 5363000 inside Longmeadow's.
    expect(await idsFor(svc, 'unemployment rate', '42660')).toEqual(['LAUMT534266000000003']);
    expect(await idsFor(svc, 'all items', '42660')).toEqual(['CUURS49DSA0']);
    expect(await idsFor(svc, 'unemployment rate', '5363000')).toEqual(['LAUCT536300000000003']);
    expect(await idsFor(svc, 'unemployment rate', '53033')).toEqual(['LAUCN530330000000003']);
  });

  it('resolves a 3-digit CSA and a 4-digit CPI area code across surveys', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    expect(await idsFor(svc, 'unemployment rate', '500')).toEqual(['LAUCA535000000000003']);
    expect(await idsFor(svc, 'total compensation', '500')).toEqual(['CIU20100000000LLA']);
    expect(await idsFor(svc, 'all items', '0000')).toEqual(['CUUR0000SA0']);
    // Not the national CPS headline, whose SeriesID holds 0000.
    expect(await idsFor(svc, 'unemployment rate', '0000')).not.toContain('LNS14000000');
    // The CPI Northeast region is the JOLTS Northeast region ("All size classes" matches "all").
    expect(await idsFor(svc, 'all items', '0100')).toEqual([
      'CUUR0100SA0',
      'JTS000000NE0000000QUR',
    ]);
    expect(await idsFor(svc, 'quits rate', '0100')).toEqual(['JTS000000NE0000000QUR']);
  });

  it.each(['99', '000', '00000', '0000000'])(
    'returns no rows for %j, a well-formed code naming no indexed area; an exact SeriesID still wins',
    async (area) => {
      const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
      const result = await svc.search(search('unemployment rate', { area }));
      expect(result.series).toEqual([]);
      expect(result.total).toBe(0);
      expect(await idsFor(svc, 'LNS14000000', area)).toEqual(['LNS14000000']);
    },
  );

  it('admits no in-area headline that matches no query word (#129)', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    expect(await idsFor(svc, 'unemployment rate', '0000')).toEqual([]);
    expect(await idsFor(svc, 'breweries', 'U.S. city average')).toEqual([]);
    expect(await idsFor(svc, 'all items', '0000')).toEqual(['CUUR0000SA0']);
  });

  it('keeps an exact SeriesID first under a state code (characterization)', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    const result = await svc.search(search('LNS14000000', { area: '48' }));
    expect(result.series[0]?.seriesId).toBe('LNS14000000');
  });

  it('matches any other all-digit value and any text as a substring (characterization)', async () => {
    const svc = await seedAndLoad(AREA_GRAMMAR_ROWS);
    expect(await idsFor(svc, 'unemployment rate', '9')).toEqual([
      'LAUCN292150000000003',
      'LNU04027990',
      'LNU0404952648',
      'LNU0404960148',
      'LNU04096935',
    ]);
    expect(await idsFor(svc, 'unemployment rate', '123456')).toEqual([]);
    expect(await idsFor(svc, 'unemployment rate', 'Texas')).toEqual([
      'JTS000000480000000QUR',
      'LASST480000000000003',
      'LAUCN292150000000003',
      'LNU0404952648',
      'LNU0404960148',
    ]);
    expect(await idsFor(svc, 'all items', 's49d')).toEqual(['CUURS49DSA0']);
    expect(await idsFor(svc, 'unemployment rate', 'ST48')).toEqual(['LASST480000000000003']);
  });

  it('filters a state before the candidate cap: 1,001 outranking decoys holding 48 stay out', async () => {
    const svc = await seedAndLoad([...AREA_DECOYS, ...AREA_GRAMMAR_ROWS]);
    const result = await svc.search(search('unemployment rate', { area: '48', limit: 50 }));
    expect(result.series.map((s) => s.seriesId).sort()).toEqual([
      'JTS000000480000000QUR',
      'LASST480000000000003',
      'LAUCN480010000000003',
      'LNU0404952648',
      'LNU0404960148',
    ]);
    expect(result.total).toBe(5);
    expect(result.capped).toBe(false);
  });
});

/**
 * Assert that `run` takes linear time in its input's length. Times 10-call
 * batches of `run` on the 5K, 20K, and 80K-character `text` in five
 * interleaved rounds and keeps each size's fastest batch: noise only adds
 * time, and a GC pause or preemption must then slow the same size in every
 * round to count. The 5K time is floored at 10 µs, since several inputs finish
 * near timer resolution there, where a ratio is noise. Linear growth predicts
 * 16× from 5K to 80K; quadratic would be 256×.
 */
function expectLinearTime(
  run: (input: string) => void,
  text: (length: number) => string,
  label: string,
): void {
  const time = (input: string) => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) run(input);
    return (performance.now() - start) / 10;
  };
  const [small, mid, large] = [text(5_000), text(20_000), text(80_000)];
  time(small); // warm the JIT
  let [t5k, t20k, t80k] = [Infinity, Infinity, Infinity];
  for (let round = 0; round < 5; round++) {
    t5k = Math.min(t5k, time(small));
    t20k = Math.min(t20k, time(mid));
    t80k = Math.min(t80k, time(large));
  }
  t5k = Math.max(t5k, 0.01);
  expect(t80k / t5k, label).toBeLessThan(64);
  expect(t20k, label).toBeLessThan(t80k * 2);
  expect(t80k, label).toBeLessThan(50);
}

describe('BlsCatalogService.search — geographic preference (#98)', () => {
  const national: CatalogSeries = {
    seriesId: 'LNS14000000',
    title: 'Unemployment Rate',
    surveyAbbr: 'LN',
    seasonal: true,
  };
  const place = (name: string, i = 0): CatalogSeries => ({
    seriesId: `LA_PLACE_${i}`,
    title: `Unemployment Rate: ${name} (U)`,
    areaName: name,
    surveyAbbr: 'LA',
    seasonal: false,
  });
  const names = [
    'Seattle',
    'Baltimore',
    'Chicago',
    'Philadelphia',
    'Denver',
    'Texas',
    'California',
    'Honolulu',
  ];

  it('keeps the bare headline and exact IDs ahead (characterization)', async () => {
    const svc = await seedAndLoad([national, ...names.map(place)]);
    expect((await svc.search(search('unemployment rate'))).series[0]?.seriesId).toBe('LNS14000000');
    expect((await svc.search(search('LNS14000000'))).series[0]?.seriesId).toBe('LNS14000000');
  });

  it.each(names)('prefers decoded %s without filtering national matches', async (name) => {
    const svc = await seedAndLoad([national, ...names.map(place)]);
    const result = await svc.search(search(`${name} unemployment rate`, { limit: 50 }));
    expect(result.series.slice(0, 5).some((s) => s.areaName === name)).toBe(true);
    expect(result.series[0]?.areaName).toBe(name);
    expect(result.series.some((s) => s.seriesId === national.seriesId)).toBe(true);
    const again = await svc.search(search(`${name} unemployment rate`, { limit: 1, offset: 1 }));
    expect(again.series).toEqual(result.series.slice(1, 2));
    const first = result.series[0];
    expect(first).toBeDefined();
    if (first) first.areaName = 'caller mutation';
    expect((await svc.search(search(`${name} unemployment rate`))).series[0]?.areaName).toBe(name);
  });

  it('admits a decoded place before the candidate cap', async () => {
    const decoys = Array.from({ length: 1001 }, (_, i) => ({
      ...national,
      seriesId: `LN_GEO_${i}`,
      title: 'Seattle unemployment rate',
    }));
    const target = {
      ...place('Seattle city, WA'),
      title: `Unemployment Rate: Seattle city, WA ${'details '.repeat(30)}`,
    };
    const svc = await seedAndLoad([...decoys, national, target]);
    const result = await svc.search(search('seattle unemployment rate'));
    expect(result.capped).toBe(true);
    expect(result.series[0]?.seriesId).toBe(target.seriesId);
  });

  it.each([
    'all',
    'area',
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
    'seatt',
    'WA',
    'united',
    'national',
    'average',
  ])('does not infer geography from %s', async (word) => {
    // The place rows match every query word (#122), so an outscoring row that
    // does too is what they must stay behind: a named place would lead it.
    const everyWord = {
      ...national,
      seriesId: 'LN_EVERY_WORD',
      title: `Unemployment Rate ${word}`,
    };
    const svc = await seedAndLoad([
      national,
      everyWord,
      place('Allentown Dallas Seattle city, WA'),
      ...(word === 'seatt' ? [] : [place(`${word} county`, 1)]),
      place('United States (National)', 2),
    ]);
    expect((await svc.search(search(`${word} unemployment rate`))).series[0]?.seriesId).toBe(
      everyWord.seriesId,
    );
  });

  it('recognizes New York while retaining whole geographic boundaries', async () => {
    const svc = await seedAndLoad([national, place('New York'), place('Yorkshire', 1)]);
    expect((await svc.search(search('new york unemployment rate'))).series[0]?.areaName).toBe(
      'New York',
    );
  });

  it('keeps exact IDs and structured filters ahead of geographic preference', async () => {
    const exact = { ...national, seriesId: 'Seattle', title: 'Employment level' };
    const svc = await seedAndLoad([national, exact, place('Seattle')]);
    expect((await svc.search(search('Seattle'))).series[0]?.seriesId).toBe('Seattle');
    const input = search('Seattle unemployment rate', { survey: 'LN' });
    expect((await svc.search(input)).series.map((s) => s.seriesId)).toEqual([
      national.seriesId,
      exact.seriesId,
    ]);
    expect(
      (await svc.search({ ...input, survey: undefined, seasonal_adjustment: true })).series.map(
        (s) => s.seriesId,
      ),
    ).toEqual([national.seriesId, exact.seriesId]);
    const terms = [
      'unemployment',
      'rate',
      ...Array.from({ length: 30 }, (_, i) => `zz${i}`),
      'Seattle',
    ];
    expect((await svc.search(search(terms.join(' ')))).series[0]?.seriesId).toBe('LNS14000000');
  });

  it.each(['seattleé', 'éSeattle', 'seattle𐐀', '𐐀Seattle'])(
    'requires whole query words: %s',
    async (word) => {
      // Seattle's row matches every query token, so it must stay behind an outscoring row that does too.
      const everyWord = {
        ...national,
        seriesId: 'LN_EVERY_WORD',
        title: 'Unemployment Rate Seattle',
      };
      const svc = await seedAndLoad([national, everyWord, place('Seattle')]);
      expect((await svc.search(search(`${word} unemployment rate`))).series[0]?.seriesId).toBe(
        everyWord.seriesId,
      );
    },
  );

  it('keeps the geographic scanner bounded across long and multiline queries', async () => {
    const svc = await seedAndLoad([national, place('Seattle')]);
    for (const shape of [
      (n: number) => `seattle ${'9'.repeat(n)}`,
      (n: number) => `seattle ${'§1 x'.repeat(n)}\ny`,
      (n: number) => `seattle ${'  \r\n'.repeat(n)}`,
    ]) {
      let first = 0;
      for (const n of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
        const query = shape(n);
        const start = process.threadCpuUsage();
        await svc.search(search(query));
        const cpu = process.threadCpuUsage(start);
        const elapsed = Math.max((cpu.user + cpu.system) / 1000, 1);
        first ||= elapsed;
        expect(elapsed).toBeLessThan(500);
        if (n === 320_000) expect(elapsed / first).toBeLessThan(256);
      }
    }
  });

  it('rebuilds vocabulary when refreshed decoded areas change', async () => {
    const files: Record<string, string> = {
      'la.series': tsv(
        ['series_id', 'area_code', 'measure_code', 'seasonal', 'series_title'],
        ['LA_PLACE', '01', '03', 'U', 'Unemployment Rate'],
      ),
      'la.area': tsv(['area_code', 'area_text'], ['01', 'Seattle']),
      'la.measure': tsv(['measure_code', 'measure_text'], ['03', 'unemployment rate']),
      'ln.series': tsv(
        ['series_id', 'periodicity_code', 'seasonal', 'series_title', 'tdat_code'],
        ['LNS14000000', 'M', 'S', 'Unemployment Rate', '01'],
      ),
      'ln.periodicity': tsv(['periodicity_code', 'periodicity_text'], ['M', 'Monthly']),
      'ln.tdat': LN_TDAT,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const file = String(url).split('/').at(-1) ?? '';
      return new Response(files[file] ?? '', { status: files[file] ? 200 : 404 });
    });
    const svc = new BlsCatalogService(
      'https://fixture',
      'test',
      join(tmpDir, 'geo-refresh.db'),
      -1,
    );
    await svc.load(1);
    expect((await svc.search(search('seattle unemployment rate'))).series[0]?.seriesId).toBe(
      'LA_PLACE',
    );
    files['la.area'] = tsv(['area_code', 'area_text'], ['01', 'Honolulu']);
    await svc.load(1);
    expect((await svc.search(search('seattle unemployment rate'))).series[0]?.seriesId).toBe(
      'LNS14000000',
    );
    expect((await svc.search(search('honolulu unemployment rate'))).series[0]?.seriesId).toBe(
      'LA_PLACE',
    );
    await svc.shutdown();
  });
});

describe('BlsCatalogService.search — place words need every other query word (#105)', () => {
  const US = 'U.S. city average';
  const laus = (seriesId: string, measure: string, areaName: string): CatalogSeries => ({
    seriesId,
    title: `${measure}: ${areaName} (U)`,
    surveyAbbr: 'LA',
    seasonal: false,
    areaName,
  });
  const cps = (seriesId: string, label: string): CatalogSeries => ({
    seriesId,
    title: `(Seas) Unemployment Rate${label ? ` - ${label}` : ''}`,
    surveyAbbr: 'LN',
    seasonal: true,
  });
  /** Real 2026-11-01 titles: each query's answer beside the place rows whose names share a query word. */
  const ROWS: CatalogSeries[] = [
    {
      seriesId: 'CUUR0000SA0',
      title: 'All items in U.S. city average, all urban consumers, not seasonally adjusted',
      surveyAbbr: 'CU',
      seasonal: false,
      areaName: US,
      itemName: 'All items',
    },
    {
      seriesId: 'CUSR0000SA0',
      title: 'All items in U.S. city average, all urban consumers, seasonally adjusted',
      surveyAbbr: 'CU',
      seasonal: true,
      areaName: US,
      itemName: 'All items',
    },
    {
      seriesId: 'CUUR0000SA0L1E',
      title:
        'All items less food and energy in U.S. city average, all urban consumers, not seasonally adjusted',
      surveyAbbr: 'CU',
      seasonal: false,
      areaName: US,
      itemName: 'All items less food and energy',
    },
    {
      seriesId: 'APU0000708111',
      title:
        'Eggs, grade A, large, per doz. in U.S. city average, average price, not seasonally adjusted',
      surveyAbbr: 'AP',
      seasonal: false,
      areaName: US,
      itemName: 'Eggs, grade A, large, per doz.',
    },
    {
      seriesId: 'CIS1020000000000I',
      title: 'Wages and salaries for all civilian workers, current dollar index',
      surveyAbbr: 'CI',
      seasonal: true,
      areaName: 'United States (National)',
      itemName: 'Wages and salaries',
    },
    cps('LNS14000000', ''),
    cps('LNS14000003', 'White'),
    cps('LNS14000006', 'Black or African American'),
    laus('LAUCN550990000000003', 'Unemployment Rate', 'Price County, WI'),
    laus('LAUCN550990000000004', 'Unemployment', 'Price County, WI'),
    laus('LAUCN190130000000003', 'Unemployment Rate', 'Black Hawk County, IA'),
    laus('LAUCN051450000000003', 'Unemployment Rate', 'White County, AR'),
    laus('LAUCN021640000000005', 'Employment', 'Lake and Peninsula Borough, AK'),
    laus('LASBS390000000000004', 'Unemployment', 'Balance of Ohio, state less Cleveland MSA'),
  ];
  const firstFor = async (svc: BlsCatalogService, query: string) =>
    (await svc.search(search(query))).series[0]?.seriesId;

  it.each([
    ['consumer price index all items', ['CUUR0000SA0', 'CUSR0000SA0']],
    ['price of eggs', ['APU0000708111']],
    ['black unemployment rate', ['LNS14000006']],
    ['employment cost index wages and salaries', ['CIS1020000000000I']],
    ['all items less food and energy', ['CUUR0000SA0L1E']],
  ])('%j leads with its answer, not a place sharing one word', async (query, answers) => {
    const svc = await seedAndLoad(ROWS);
    expect(answers).toContain(await firstFor(svc, query));
  });

  it('weighs a function word below a content word, so "price of eggs" keeps the AP row over an EI title holding "of"', async () => {
    // Real 2026-11-01 EI title: it matches `price` and `eggs` too, and `of` only in "products of animal".
    const ei: CatalogSeries = {
      seriesId: 'EIUID04',
      title:
        'Monthly export price index for Harmonized 04, Dairy produce; birds eggs; natural honey; edible products of animal origin, not elsewhere specified or included, not seasonally adjusted',
      surveyAbbr: 'EI',
      seasonal: false,
    };
    const svc = await seedAndLoad([...ROWS, ei]);
    expect(await firstFor(svc, 'price of eggs')).toBe('APU0000708111');
  });

  it('never reads a CPS demographic label alone as a place', async () => {
    const svc = await seedAndLoad(ROWS);
    // White County's rows match every word of the query, yet `white` names the CPS group.
    expect(await firstFor(svc, 'white unemployment rate')).toBe('LNS14000003');
  });

  it('names a place only by every distinctive word of one part of its name', async () => {
    const svc = await seedAndLoad(ROWS);
    expect(await firstFor(svc, 'black hawk county unemployment rate')).toBe('LAUCN190130000000003');
    expect(await firstFor(svc, 'price county unemployment rate')).toBe('LAUCN550990000000003');
  });

  it('admits a row with no decoded area on bm25 when the query holds a place word', async () => {
    // 1,001 area-bearing rows that hold "producer price" fill the pool ahead of area-less rows.
    const decoys = Array.from({ length: 1001 }, (_, i) =>
      laus(`LADECOYPRICE${String(i).padStart(5, '0')}`, 'Producer price decoy', `Decoy ${i}, WI`),
    );
    const target: CatalogSeries = {
      seriesId: 'WPUSI012011',
      title:
        'PPI Commodity data for Special indexes-Construction materials, not seasonally adjusted',
      surveyAbbr: 'WP',
      seasonal: false,
    };
    const svc = await seedAndLoad([...decoys, ...ROWS, target]);
    const result = await svc.search(search('construction materials producer price'));
    expect(result.capped).toBe(true);
    expect(result.series[0]?.seriesId).toBe('WPUSI012011');
  });
});

describe('escapeLike (#69)', () => {
  it('escapes the LIKE wildcards and the escape character, leaving other text alone', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('Seattle-Tacoma, WA')).toBe('Seattle-Tacoma, WA');
  });

  it('runs in linear time on worst-case caller text', () => {
    for (const ch of ['%', '\\', '_']) {
      expectLinearTime(escapeLike, (n) => ch.repeat(n), ch);
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
      'pr.sector': PR_FILES['pr.sector']!,
      'pr.duration': PR_FILES['pr.duration']!,
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
      checkpoint: catalogSurveyList(false),
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

describe('BlsCatalogService.search — currency, the JOLTS aggregate, and core measures (#122)', () => {
  const ids = async (svc: BlsCatalogService, input: Parameters<BlsCatalogService['search']>[0]) =>
    (await svc.search(input)).series.map((s) => s.seriesId);
  const jt = (seriesId: string, element: string, industry: string, area = 'Total US') => ({
    seriesId,
    title: `JOLTS - ${element} - ${industry} - ${area} - All size classes - Rate`,
    surveyAbbr: 'JT',
    seasonal: true,
    areaName: area,
    endYear: area === 'Total US' ? 2026 : 2025,
  });
  /** Real 2026-11-01 JT rows; the breakdowns seed first, so they lead on candidate order alone. */
  const JOLTS: CatalogSeries[] = [
    jt('JTS230000000000000QUR', 'Quits', 'Construction'),
    jt('JTS300000000000000QUR', 'Quits', 'Manufacturing'),
    jt('JTS000000010000000QUR', 'Quits', 'Total nonfarm', 'Alabama'),
    jt('JTS000000000000000QUR', 'Quits', 'Total nonfarm'),
    jt('JTS230000000000000JOR', 'Job openings', 'Construction'),
    jt('JTS000000000000000JOR', 'Job openings', 'Total nonfarm'),
    {
      seriesId: 'JTS000000000000000JOL',
      title:
        'JOLTS - Job openings - Total nonfarm - Total US - All size classes - Level - In Thousands',
      surveyAbbr: 'JT',
      seasonal: true,
      areaName: 'Total US',
      endYear: 2026,
    },
  ];

  it.each<[string, string | undefined]>([
    ['quits rate', 'JT'],
    ['quits rate', undefined],
    ['job openings rate', 'JT'],
    ['job openings rate', undefined],
  ])('ranks the Total nonfarm row first for %j (survey %j)', async (query, survey) => {
    const svc = await seedAndLoad(JOLTS);
    const element = query.startsWith('quits') ? 'QUR' : 'JOR';
    const result = await ids(svc, search(query, survey ? { survey } : {}));
    expect(result[0]).toBe(`JTS000000000000000${element}`);
    // The breakdown stays in the list, behind the aggregate.
    expect(result.indexOf(`JTS230000000000000${element}`)).toBeGreaterThan(0);
  });

  it('never lifts the aggregate over a better-scoring breakdown', async () => {
    const svc = await seedAndLoad(JOLTS);
    expect((await ids(svc, search('quits rate construction')))[0]).toBe('JTS230000000000000QUR');
  });

  it('ranks a series that ended more than a year before its survey below current ties, hiding none', async () => {
    const egg = (seriesId: string, seasonal: boolean, startYear: number, endYear: number) => ({
      seriesId,
      title: `PPI Commodity data for Farm products-Chicken eggs, ${seasonal ? '' : 'not '}seasonally adjusted`,
      surveyAbbr: 'WP',
      seasonal,
      itemName: 'Chicken eggs',
      startYear,
      endYear,
    });
    // Real rows: the seasonally adjusted pair ended in 2012 and leads on bm25 (shorter titles).
    const svc = await seedAndLoad([
      egg('WPS017', true, 1967, 2012),
      egg('WPS0171', true, 1991, 2012),
      egg('WPU017', false, 1926, 2026),
    ]);
    const result = await svc.search(search('eggs'));
    expect(result.series.map((s) => s.seriesId)).toEqual(['WPU017', 'WPS017', 'WPS0171']);
    expect(result.total).toBe(3);
  });

  it('applies currency only at equal score: a better-scoring ended row still leads', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'ENDED',
        title: 'Chicken eggs',
        surveyAbbr: 'WP',
        seasonal: false,
        itemName: 'Chicken eggs',
        endYear: 2012,
      },
      {
        seriesId: 'CURRENT',
        title: 'Chicken eggs',
        surveyAbbr: 'WP',
        seasonal: false,
        endYear: 2026,
      },
    ]);
    expect(await ids(svc, search('eggs'))).toEqual(['ENDED', 'CURRENT']);
  });

  it.each<[string, number]>([
    ['MP', 2025],
    ['JT', 2026],
    ['LN', 2026],
  ])(
    'counts a %s row ending a year before its survey newest (%i) as current',
    async (survey, newest) => {
      // Identical titles tie on score and bm25, so candidate order is seed order.
      const row = (seriesId: string, endYear?: number): CatalogSeries => ({
        seriesId,
        title: 'Currency probe',
        surveyAbbr: survey,
        seasonal: false,
        ...(endYear !== undefined && { endYear }),
      });
      const svc = await seedAndLoad([
        row('ENDED', newest - 2),
        row('BEHIND', newest - 1),
        row('NEWEST', newest),
        row('UNKNOWN'),
      ]);
      expect(await ids(svc, search('currency probe'))).toEqual([
        'BEHIND',
        'NEWEST',
        'UNKNOWN',
        'ENDED',
      ]);
    },
  );

  it('measures currency against each survey separately', async () => {
    // Every EC row ends in 2005, so they are current against EC, not against CU's 2026.
    const row = (seriesId: string, surveyAbbr: string, endYear: number): CatalogSeries => ({
      seriesId,
      title: 'Survey probe',
      surveyAbbr,
      seasonal: false,
      endYear,
    });
    const svc = await seedAndLoad([
      row('CU_OLD', 'CU', 2017),
      row('EC_ROW', 'EC', 2005),
      row('CU_ROW', 'CU', 2026),
    ]);
    expect(await ids(svc, search('survey probe'))).toEqual(['EC_ROW', 'CU_ROW', 'CU_OLD']);
  });

  it.each([
    ['black unemployment rate', 'LNS14000006'],
    ['labor force participation rate women', 'LNS11300002'],
  ])('leads %j within LN with the demographic row (characterization)', async (query, answer) => {
    const svc = await seedAndLoad([
      {
        seriesId: 'LNS14000000',
        title: '(Seas) Unemployment Rate',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'LNS11300000',
        title: '(Seas) Labor Force Participation Rate',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'LNS12000000',
        title: '(Seas) Employment Level',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'LNS14000006',
        title: '(Seas) Unemployment Rate - Black or African American',
        surveyAbbr: 'LN',
        seasonal: true,
      },
      {
        seriesId: 'LNS11300002',
        title: '(Seas) Labor Force Participation Rate - Women',
        surveyAbbr: 'LN',
        seasonal: true,
      },
    ]);
    expect((await ids(svc, search(query, { survey: 'LN' })))[0]).toBe(answer);
  });

  const cpi = (seriesId: string, item: string, area = 'U.S. city average') => ({
    seriesId,
    title: `${item} in ${area}, all urban consumers, ${seriesId[2] === 'S' ? '' : 'not '}seasonally adjusted`,
    surveyAbbr: 'CU',
    seasonal: seriesId[2] === 'S',
    areaName: area,
    itemName: item,
  });
  const ppi = (seriesId: string, item: string) => ({
    seriesId,
    title: `PPI Commodity data for ${item}, ${seriesId[2] === 'S' ? '' : 'not '}seasonally adjusted`,
    surveyAbbr: 'WP',
    seasonal: seriesId[2] === 'S',
    itemName: item,
  });
  /** Real 2026-11-01 rows: the headlines, the core measures, and the "Fiber cores" rows `core` also matches. */
  const CORE: CatalogSeries[] = [
    {
      seriesId: 'PCU32221932221982',
      title:
        'PPI industry data for Other paperboard container manufacturing-Fiber cores and tubes, not seasonally adjusted',
      surveyAbbr: 'PC',
      seasonal: false,
      itemName: 'Fiber cores and tubes',
    },
    {
      seriesId: 'WPU09150732',
      title:
        'PPI Commodity data for Pulp, paper, and allied products-Fiber cores and tubes, not seasonally adjusted',
      surveyAbbr: 'WP',
      seasonal: false,
      itemName: 'Fiber cores and tubes',
    },
    cpi('CUUR0000SA0', 'All items'),
    cpi('CUSR0000SA0', 'All items'),
    cpi('CUUR0100SA0L1E', 'All items less food and energy', 'Northeast'),
    cpi('CUUR0000SA0L1E', 'All items less food and energy'),
    cpi('CUSR0000SA0L1E', 'All items less food and energy'),
    cpi('CUUR0000SA0L12E', 'All items less food, shelter, and energy'),
    ppi('WPUFD4', 'Final demand'),
    ppi('WPUFD49104', 'Final demand less foods and energy'),
    ppi('WPSFD49104', 'Final demand less foods and energy'),
    ppi('WPUFD49116', 'Final demand less foods, energy, and trade services'),
    ppi('WPUFD413', 'Final demand goods less foods and energy'),
  ];
  /** Each survey's national core rows (the leaders), then every core row of it. */
  const CU_CORE = [['CUSR0000SA0L1E', 'CUUR0000SA0L1E'], ['CUUR0100SA0L1E']];
  const WP_CORE = [['WPSFD49104', 'WPUFD49104', 'WPUFD49116'], []];

  it.each<[string, string | undefined, string[][]]>([
    ['core inflation', 'CU', CU_CORE],
    ['core inflation', undefined, CU_CORE],
    ['core cpi', undefined, CU_CORE],
    ['CPI core', undefined, CU_CORE],
    ['core ppi', undefined, WP_CORE],
    ['core producer prices', undefined, WP_CORE],
  ])(
    'leads %j (survey %j) with its core measure',
    async (query, survey, [leaders = [], rest = []]) => {
      const svc = await seedAndLoad(CORE);
      const result = await ids(svc, search(query, { ...(survey && { survey }), limit: 50 }));
      expect(new Set(result.slice(0, leaders.length))).toEqual(new Set(leaders));
      // Every core row of the survey joins; a near-miss item ("less food, shelter, and energy") never does.
      expect(result).toEqual(expect.arrayContaining(rest));
      expect(result).not.toContain('CUUR0000SA0L12E');
    },
  );

  it('keeps the survey, seasonal, and area filters on the core rows', async () => {
    const svc = await seedAndLoad(CORE);
    expect(
      await ids(svc, { ...search('core inflation'), seasonal_adjustment: false }),
    ).not.toContain('CUSR0000SA0L1E');
    expect(await ids(svc, search('core inflation', { area: 'Northeast' }))).toEqual([
      'CUUR0100SA0L1E',
    ]);
    expect(
      (await ids(svc, search('core inflation', { survey: 'WP' }))).some((id) =>
        id.startsWith('CU'),
      ),
    ).toBe(false);
  });

  it.each(['core', 'cores ppi'])(
    'leaves %j to its own words: no alias, or no whole word "core" (characterization)',
    async (query) => {
      const svc = await seedAndLoad(CORE);
      const result = await ids(svc, search(query, { limit: 50 }));
      expect(new Set(result.slice(0, 2))).toEqual(new Set(['PCU32221932221982', 'WPU09150732']));
      if (query === 'core') expect(result).toHaveLength(2);
    },
  );
});

describe('BlsCatalogService.load racing shutdown', () => {
  it('finishes a first load that a shutdown interrupts without a closed-handle error', async () => {
    const dbPath = join(tmpDir, 'race.db');
    const store = createCatalogStore(dbPath);
    await store.applyBatch(FIXTURES.map(toMirrorRow), []);
    await storeOewsTables(store); // a complete index with its tables: nothing is due
    await store.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      checkpoint: catalogSurveyList(false),
    });
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

// ---------------------------------------------------------------------------
// ECEC (CM) and ECI (CI) (#86)
// ---------------------------------------------------------------------------

const COMP_HEADER = (measureCol: string) => [
  'series_id        ',
  'seasonal',
  'owner_code',
  'industry_code',
  'occupation_code',
  'subcell_code',
  'area_code',
  measureCol,
  'estimate_code',
  'series_title',
  'footnote_codes',
  'begin_year',
  'begin_period',
  'end_year',
  'end_period',
];

/** A cm/ci `.series` row: national (`99999`) or the Seattle CSA (`00500`), per estimate. */
const compRow = (
  id: string,
  seasonal: string,
  owner: string,
  area: string,
  measure: string,
  estimate: string,
  title: string,
) => [
  id,
  seasonal,
  owner,
  '000000',
  '000000',
  '00',
  area,
  measure,
  estimate,
  title,
  '',
  '2004',
  'Q01',
  '2026',
  'Q02',
];

const COMP_AREA = tsv(
  ['area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
  ['00500', 'Seattle-Tacoma, WA CSA', '3', 'T', '31'],
  ['99999', 'United States (National)', '0', 'T', '1'],
);
const COMP_ESTIMATE = tsv(
  ['estimate_code', 'estimate_text', 'display_level', 'selectable', 'sort_sequence'],
  ['01', 'Total compensation', '0', 'T', '1'],
  ['02', 'Wages and salaries', '1', 'T', '2'],
  ['03', 'Total benefits', '1', 'T', '3'],
  ['15', 'Health insurance', '2', 'T', '4'],
);

/** Real cm/ci rows (2026-09-23): national and Seattle CSA rows across estimates. */
const CM_CI_FILES: Record<string, string> = {
  'cm.series': tsv(
    COMP_HEADER('datatype_code'),
    compRow(
      'CMU1010000000000D',
      'U',
      '1',
      '99999',
      'D',
      '01',
      'Total compensation cost per hour worked for civilian workers',
    ),
    compRow(
      'CMU1020000000000D',
      'U',
      '1',
      '99999',
      'D',
      '02',
      'Wages and salaries cost per hour worked for civilian workers',
    ),
    compRow(
      'CMU1150000000000D',
      'U',
      '1',
      '99999',
      'D',
      '15',
      'Health insurance cost per hour worked for civilian workers',
    ),
    compRow(
      'CMU20100000000LLD',
      'U',
      '2',
      '00500',
      'D',
      '01',
      'Total compensation for private industry workers in the Seattle-Tacoma, WA CSA; Cost per hour worked',
    ),
    compRow(
      'CMU20200000000LLD',
      'U',
      '2',
      '00500',
      'D',
      '02',
      'Wages and salaries for private industry workers in the Seattle-Tacoma, WA CSA; Cost per hour worked',
    ),
  ),
  'cm.area': COMP_AREA,
  'cm.estimate': COMP_ESTIMATE,
  'cm.datatype': CM_DATATYPE,
  'ci.series': tsv(
    COMP_HEADER('periodicity_code'),
    compRow(
      'CIU1010000000000A',
      'U',
      '1',
      '99999',
      'A',
      '01',
      'Total compensation for all civilian workers, 12-month percent change, current dollars',
    ),
    compRow(
      'CIU1020000000000A',
      'U',
      '1',
      '99999',
      'A',
      '02',
      'Wages and salaries for all civilian workers, 12-month percent change, current dollars',
    ),
    compRow(
      'CIS1010000000000I',
      'S',
      '1',
      '99999',
      'I',
      '01',
      'Total compensation for all civilian workers, current dollar index',
    ),
    compRow(
      'CIU20100000000LLA',
      'U',
      '2',
      '00500',
      'A',
      '01',
      'Total compensation for private industry workers in the Seattle-Tacoma, WA CSA, 12-month percent change, current dollars',
    ),
    compRow(
      'CIU20200000000LLA',
      'U',
      '2',
      '00500',
      'A',
      '02',
      'Wages and salaries for private industry workers in the Seattle-Tacoma, WA CSA, 12-month percent change, current dollars',
    ),
  ),
  'ci.area': COMP_AREA,
  'ci.estimate': COMP_ESTIMATE,
};

describe('BlsCatalogService — ECEC (CM) and ECI (CI) (#86)', () => {
  it('harvests CM and CI with the area and estimate decoded and series_title kept', async () => {
    const { svc, requested } = await harvestFrom(CM_CI_FILES);
    const rows = await svc.lookupByIds([
      'CMU1010000000000D',
      'CMU1150000000000D',
      'CMU20200000000LLD',
      'CIU1020000000000A',
      'CIS1010000000000I',
      'CIU20100000000LLA',
    ]);
    const decoded = Object.fromEntries(
      [...rows].map(([id, s]) => [id, [s.surveyAbbr, s.areaName, s.itemName, s.seasonal]]),
    );
    expect(decoded).toEqual({
      CMU1010000000000D: ['CM', 'United States (National)', 'Total compensation', false],
      CMU1150000000000D: ['CM', 'United States (National)', 'Health insurance', false],
      CMU20200000000LLD: ['CM', 'Seattle-Tacoma, WA CSA', 'Wages and salaries', false],
      CIU1020000000000A: ['CI', 'United States (National)', 'Wages and salaries', false],
      CIS1010000000000I: ['CI', 'United States (National)', 'Total compensation', true],
      CIU20100000000LLA: ['CI', 'Seattle-Tacoma, WA CSA', 'Total compensation', false],
    });
    expect(rows.get('CIS1010000000000I')?.title).toBe(
      'Total compensation for all civilian workers, current dollar index',
    );
    expect(svc.indexedSurveys).toEqual(['CI', 'CM']);
    expect(requested.filter((f) => /^c[mi]\./.test(f)).sort()).toEqual([
      'ci.area',
      'ci.estimate',
      'ci.series',
      'cm.area',
      'cm.datatype',
      'cm.estimate',
      'cm.series',
    ]);
  });

  /**
   * The fixture holds too few current rows to fill a top 10, so rank the whole
   * list: every row of `surveys` carrying the asked estimate must outrank every EC row.
   */
  async function rankEstimate(
    svc: BlsCatalogService,
    query: string,
    item: string,
    surveys = ['CM', 'CI'],
  ) {
    const series = (await svc.search(searchInput(query, { limit: 50 }))).series;
    const firstEc = series.findIndex((s) => s.surveyAbbr === 'EC');
    const current = series.flatMap((s, i) =>
      surveys.includes(s.surveyAbbr) && s.itemName === item ? [i] : [],
    );
    expect(current.length).toBeGreaterThan(0);
    return {
      top: series[0],
      firstEc: firstEc < 0 ? Infinity : firstEc,
      lastCurrent: Math.max(...current),
    };
  }

  it.each([
    ['compensation', 'Total compensation'],
    ['employer cost compensation', 'Total compensation'],
    ['employer costs for employee compensation', 'Total compensation'],
    ['total compensation cost per hour worked', 'Total compensation'],
    ['health insurance cost per hour', 'Health insurance'],
  ])('%j ranks CM first and its %s rows above every EC row', async (query, item) => {
    const { svc } = await harvestFrom({ ...CM_CI_FILES, ...EC_FILES });
    const { top, firstEc, lastCurrent } = await rankEstimate(svc, query, item);
    expect(top?.surveyAbbr).toBe('CM');
    expect(firstEc).toBeGreaterThan(lastCurrent);
  });

  it('ranks CI first for "eci wages and salaries 12-month percent change", EC rows below', async () => {
    const { svc } = await harvestFrom({ ...CM_CI_FILES, ...EC_FILES });
    const query = 'eci wages and salaries 12-month percent change';
    const { top, firstEc, lastCurrent } = await rankEstimate(svc, query, 'Wages and salaries', [
      'CI',
    ]);
    expect(top?.seriesId).toBe('CIU1020000000000A');
    expect(firstEc).toBeGreaterThan(lastCurrent);
  });

  it('returns a CI series in the top 3 for "employment cost index"', async () => {
    const { svc } = await harvestFrom({ ...CM_CI_FILES, ...EC_FILES });
    const result = await svc.search(searchInput('employment cost index', { limit: 3 }));
    expect(result.series.some((s) => s.surveyAbbr === 'CI')).toBe(true);
  });

  it('reaches the Seattle CM and CI rows through the area filter', async () => {
    const { svc } = await harvestFrom(CM_CI_FILES);
    const total = await svc.search(searchInput('total compensation', { area: 'Seattle' }));
    expect(total.series.map((s) => s.seriesId).sort()).toEqual([
      'CIU20100000000LLA',
      'CMU20100000000LLD',
    ]);
    const wages = await svc.search(searchInput('wages and salaries', { area: 'seattle' }));
    expect(wages.series.map((s) => s.seriesId).sort()).toEqual([
      'CIU20200000000LLA',
      'CMU20200000000LLD',
    ]);
  });

  it('still reaches EC with survey: "EC"', async () => {
    const { svc } = await harvestFrom({ ...CM_CI_FILES, ...EC_FILES });
    const result = await svc.search(searchInput('total compensation', { survey: 'EC' }));
    expect(result.series.length).toBeGreaterThan(0);
    expect(result.series.every((s) => s.surveyAbbr === 'EC')).toBe(true);
  });

  it('ranks a national CM row above a regional row that ties it', async () => {
    // Equal rescore; the longer national row trails on bm25, so candidate order puts Seattle first.
    const svc = await seedAndLoad([
      {
        seriesId: 'CMU20100000000LLD',
        title: 'Total compensation cost per hour, Seattle',
        surveyAbbr: 'CM',
        seasonal: false,
        areaName: 'Seattle-Tacoma, WA CSA',
        itemName: 'Total compensation',
      },
      {
        seriesId: 'CMU1010000000000D',
        title: 'Total compensation cost per hour worked for civilian workers in every area',
        surveyAbbr: 'CM',
        seasonal: false,
        areaName: 'United States (National)',
        itemName: 'Total compensation',
      },
    ]);
    const result = await svc.search(searchInput('total compensation cost per hour'));
    expect(result.series.map((s) => s.seriesId)).toEqual([
      'CMU1010000000000D',
      'CMU20100000000LLD',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Measure (#127)
// ---------------------------------------------------------------------------

/**
 * One survey per code table BLS's `catalog.measure_data_type` reproduces,
 * shaped like the real files, with two codes each so a constant cannot pass.
 * Labels are the real table text (2026-11-01).
 */
const MEASURE_FILES: Record<string, string> = {
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
      'CES0000000001    ',
      '00',
      '00000000',
      '01',
      'S',
      'All employees, thousands, total nonfarm, seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
    [
      'CES0500000003    ',
      '05',
      '05000000',
      '03',
      'S',
      'Average hourly earnings of all employees, total private, seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
    // A code ce.datatype does not list: the row is indexed without a measure.
    [
      'CES0500000099    ',
      '05',
      '05000000',
      '99',
      'S',
      'Unlisted data type',
      '',
      ...PERIODS.slice(1),
    ],
  ),
  'ce.industry': tsv(
    ['industry_code', 'naics_code', 'publishing_status', 'industry_name'],
    ['00000000', '-', 'B', 'Total nonfarm'],
    ['05000000', '-', 'A', 'Total private'],
  ),
  'ce.datatype': CE_DATATYPE,
  'ln.series': tsv(
    [
      'series_id        ',
      'lfst_code',
      'periodicity_code',
      'series_title',
      'tdat_code',
      'seasonal',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    [
      'LNS11000000      ',
      '10',
      'M',
      '(Seas) Civilian Labor Force Level',
      '00',
      'S',
      ...PERIODS.slice(1),
    ],
    ['LNS14000000      ', '40', 'M', '(Seas) Unemployment Rate', '01', 'S', ...PERIODS.slice(1)],
  ),
  'ln.periodicity': tsv(['periodicity_code', 'periodicity_text'], ['M', 'Monthly']),
  'ln.tdat': LN_TDAT,
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
      'Total factor productivity, NAICS 11',
      '04',
      '1987',
      'A01',
      '2024',
      'A01',
    ],
    [
      'MPU0011032       ',
      '0011',
      '03',
      '2',
      '2017',
      'Combined inputs, NAICS 11',
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
  'mp.measure': MP_MEASURE,
  'cm.series': tsv(
    COMP_HEADER('datatype_code'),
    compRow('CMU1010000000000D', 'U', '1', '99999', 'D', '01', 'Total compensation cost per hour'),
    compRow(
      'CMU1020000000000P',
      'U',
      '1',
      '99999',
      'P',
      '02',
      'Wages as a percent of compensation',
    ),
  ),
  'cm.area': COMP_AREA,
  'cm.estimate': COMP_ESTIMATE,
  'cm.datatype': CM_DATATYPE,
  'cu.series': tsv(
    CU_HEADER,
    cpiRow('CUUR0000SA0      ', '0000', 'U', 'R', US_NSA),
    cpiRow('CUUR0000SAF1     ', '0000', 'U', 'R', 'Food in U.S. city average').with(2, 'SAF1'),
  ),
  'cu.area': CPI_AREA,
  'cu.periodicity': CPI_PERIODICITY,
  'cu.item': tsv(
    ['item_code', 'item_name', 'display_level', 'selectable', 'sort_sequence'],
    ['SA0', 'All items', '0', 'T', '1'],
    ['SAF1', 'Food', '1', 'T', '2'],
  ),
  'oe.series': tsv(
    [
      'series_id                     ',
      'seasonal',
      'areatype_code',
      'industry_code',
      'occupation_code',
      'datatype_code',
      'state_code',
      'area_code',
      'sector_code',
      'series_title',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    ...['01', '03'].map((datatype) => [
      `OEUM0042660000000291141${datatype}`,
      'U',
      'M',
      '000000',
      '291141',
      datatype,
      '53',
      '0042660',
      '-',
      `Registered Nurses in Seattle-Tacoma-Bellevue, WA (${datatype})`,
      '',
      '2025',
      'A01',
      '2025',
      'A01',
    ]),
  ),
  'oe.area': tsv(
    ['state_code', 'area_code', 'areatype_code', 'area_name'],
    ['53', '0042660', 'M', 'Seattle-Tacoma-Bellevue, WA'],
  ),
  'oe.occupation': tsv(['occupation_code', 'occupation_name'], ['291141', 'Registered Nurses']),
  'oe.datatype': tsv(
    ['datatype_code', 'datatype_name'],
    ['01', 'Employment'],
    ['03', 'Hourly mean wage'],
  ),
};

/**
 * The surveys whose item label BLS's API returns verbatim as
 * `catalog.measure_data_type` (AP, CW, PC, WP), with the real table text
 * (2026-11-01). The PC and WP tables each hold a real row that shares half of
 * a series' composite key, so a join on one key column alone mislabels.
 */
const ITEM_MEASURE_FILES: Record<string, string> = {
  'ap.series': tsv(
    [
      'series_id        ',
      'area_code',
      'item_code',
      'series_title',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    [
      'APU0000702111    ',
      '0000',
      '702111',
      'Bread, white, pan, per lb. (453.6 gm) in U.S. city average, average price, not seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
    [
      'APU0000708111    ',
      '0000',
      '708111',
      'Eggs, grade A, large, per doz. in U.S. city average, average price, not seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
  ),
  'ap.area': tsv(['area_code', 'area_name'], ['0000', 'U.S. city average']),
  'ap.item': tsv(
    ['item_code', 'item_name'],
    ['702111', 'Bread, white, pan, per lb. (453.6 gm)'],
    ['708111', 'Eggs, grade A, large, per doz.'],
  ),
  'cw.series': tsv(
    CU_HEADER,
    cpiRow('CWUR0000SA0      ', '0000', 'U', 'R', CW_NSA),
    cpiRow(
      'CWSR0000SAF1     ',
      '0000',
      'S',
      'R',
      'Food in U.S. city average, urban wage earners and clerical workers, seasonally adjusted',
    ).with(2, 'SAF1'),
  ),
  'cw.area': CPI_AREA,
  'cw.periodicity': CPI_PERIODICITY,
  'cw.item': tsv(
    ['item_code', 'item_name', 'display_level', 'selectable', 'sort_sequence'],
    ['SA0', 'All items', '0', 'T', '1'],
    ['SAF1', 'Food', '1', 'T', '4'],
  ),
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
    ...[
      ['PCU325412325412', '325412', '325412', 'Pharmaceutical preparation manufacturing'],
      [
        'PCU325412325412P',
        '325412',
        '325412P',
        'Pharmaceutical preparation manufacturing-Primary products',
      ],
      [
        'PCU3339213339211',
        '333921',
        '3339211',
        'Elevator and moving stairway mfg-Elevators and moving stairways',
      ],
    ].map(([id = '', industry = '', product = '', name = '']) => [
      id.padEnd(30),
      industry,
      product,
      'U',
      '198112',
      `PPI industry data for ${name}, not seasonally adjusted`,
      '',
      ...PERIODS.slice(1),
    ]),
  ),
  'pc.product': tsv(
    ['industry_code', 'product_code', 'product_name'],
    ['325412', '325412', 'Pharmaceutical preparation manufacturing'],
    ['325412', '325412P', 'Primary products'],
    ['333921', '3339211', 'Elevators and moving stairways'],
  ),
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
    [
      'WPU01                         ',
      '01',
      '-',
      'U',
      '198200',
      'PPI Commodity data for Farm products, not seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
    [
      'WPUFD49207                    ',
      'FD',
      '49207',
      'U',
      '198200',
      'PPI Commodity data for Final demand-Finished goods, not seasonally adjusted',
      '',
      ...PERIODS.slice(1),
    ],
  ),
  'wp.item': tsv(
    ['group_code', 'item_code', 'item_name'],
    ['01', '-', 'Farm products'],
    ['02', '-', 'Processed foods and feeds'],
    ['FD', '49207', 'Finished goods'],
  ),
};

/** Real la.* rows and the whole `la.measure` table (2026-11-01). */
const LA_MEASURE_FILES: Record<string, string> = {
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
      'LASST530000000000003          ',
      'A',
      'ST5300000000000',
      '03',
      'S',
      '53',
      'Unemployment Rate: Washington (S)',
      '',
      '1976',
      'M01',
      '2026',
      'M09',
    ],
    [
      'LASST530000000000008          ',
      'A',
      'ST5300000000000',
      '08',
      'S',
      '53',
      'Labor Force Participation Rate: Washington (S)',
      '',
      '1976',
      'M01',
      '2026',
      'M09',
    ],
    [
      'LAUCN530330000000003          ',
      'F',
      'CN5303300000000',
      '03',
      'U',
      '53',
      'Unemployment Rate: King County, WA (U)',
      '',
      '1990',
      'M01',
      '2026',
      'M09',
    ],
  ),
  'la.area': tsv(
    ['area_type_code', 'area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
    ['A', 'ST5300000000000', 'Washington', '0', 'T', '7845'],
    ['F', 'CN5303300000000', 'King County, WA', '0', 'T', '7891'],
  ),
  'la.measure': tsv(
    ['measure_code', 'measure_text'],
    ['03', 'unemployment rate'],
    ['04', 'unemployment'],
    ['05', 'employment'],
    ['06', 'labor force'],
    ['07', 'employment-population ratio'],
    ['08', 'labor force participation rate'],
    ['09', 'civilian noninstitutional population'],
  ),
};

describe('BlsCatalogService.load — measure (#127)', () => {
  it('decodes each mapped survey’s measure from the table BLS reads measure_data_type from', async () => {
    const { svc, requested } = await harvestFrom(
      {
        ...MEASURE_FILES,
        ...PR_FILES,
        'ci.series': CM_CI_FILES['ci.series']!,
        'ci.area': COMP_AREA,
        'ci.estimate': COMP_ESTIMATE,
      },
      { includeOes: true },
    );
    const rows = await svc.lookupByIds([
      'CES0000000001',
      'CES0500000003',
      'LNS11000000',
      'LNS14000000',
      'MPU0011012',
      'MPU0011032',
      'CMU1010000000000D',
      'CMU1020000000000P',
      'CIU1010000000000A',
      'CIU1020000000000A',
      'PRS85006092',
      'PRS85006112',
      'CUUR0000SA0',
      'CUUR0000SAF1',
      'OEUM004266000000029114101',
      'OEUM004266000000029114103',
    ]);
    expect(Object.fromEntries([...rows].map(([id, s]) => [id, s.measure]))).toEqual({
      CES0000000001: 'ALL EMPLOYEES, THOUSANDS',
      CES0500000003: 'AVERAGE HOURLY EARNINGS OF ALL EMPLOYEES',
      LNS11000000: 'Number in thousands',
      LNS14000000: 'Percent or rate',
      MPU0011012: 'Total factor productivity',
      MPU0011032: 'Combined inputs',
      CMU1010000000000D: 'Cost of compensation (Cost per hour worked)',
      CMU1020000000000P: 'Percent of total compensation',
      CIU1010000000000A: 'Total compensation',
      CIU1020000000000A: 'Wages and salaries',
      PRS85006092: 'Labor productivity (output per hour)',
      PRS85006112: 'Unit labor costs',
      CUUR0000SA0: 'All items',
      CUUR0000SAF1: 'Food',
      OEUM004266000000029114101: 'Employment',
      OEUM004266000000029114103: 'Hourly mean wage',
    });
    expect(requested).toEqual(
      expect.arrayContaining([
        'ce.datatype',
        'ln.tdat',
        'mp.measure',
        'cm.datatype',
        'oe.datatype',
      ]),
    );
    // CI and CU decode the measure from the item's table, which is fetched once.
    expect(requested.filter((f) => f === 'ci.estimate')).toHaveLength(1);
    expect(requested.filter((f) => f === 'cu.item')).toHaveLength(1);
    await svc.shutdown();
  });

  it('indexes a row whose code its measure table does not list, without a measure', async () => {
    const { svc } = await harvestFrom(MEASURE_FILES);
    const rows = await svc.lookupByIds(['CES0000000001', 'CES0500000099']);
    expect(rows.get('CES0000000001')?.measure).toBe('ALL EMPLOYEES, THOUSANDS');
    expect(rows.get('CES0500000099')).toMatchObject({ itemName: 'Total private' });
    expect(rows.get('CES0500000099')).not.toHaveProperty('measure');
    await svc.shutdown();
  });

  it('decodes AP, CW, PC, and WP measures from the item table, fetched once', async () => {
    const { svc, requested } = await harvestFrom(ITEM_MEASURE_FILES);
    const ids = [
      'APU0000702111',
      'APU0000708111',
      'CWUR0000SA0',
      'CWSR0000SAF1',
      'PCU325412325412',
      'PCU325412325412P',
      'PCU3339213339211',
      'WPU01',
      'WPUFD49207',
    ];
    const rows = await svc.lookupByIds(ids);
    // The strings BLS's API returns as measure_data_type for these series.
    expect(Object.fromEntries([...rows].map(([id, s]) => [id, s.measure]))).toEqual({
      APU0000702111: 'Bread, white, pan, per lb. (453.6 gm)',
      APU0000708111: 'Eggs, grade A, large, per doz.',
      CWUR0000SA0: 'All items',
      CWSR0000SAF1: 'Food',
      PCU325412325412: 'Pharmaceutical preparation manufacturing',
      PCU325412325412P: 'Primary products',
      PCU3339213339211: 'Elevators and moving stairways',
      WPU01: 'Farm products',
      WPUFD49207: 'Finished goods',
    });
    for (const id of ids) expect(rows.get(id)?.itemName).toBe(rows.get(id)?.measure);
    // No table beyond the ones the item and area already read.
    expect(requested.filter((f) => /^(ap|cw|pc|wp)\./.test(f)).sort()).toEqual([
      'ap.area',
      'ap.item',
      'ap.series',
      'cw.area',
      'cw.item',
      'cw.periodicity',
      'cw.series',
      'pc.product',
      'pc.series',
      'wp.item',
      'wp.series',
    ]);
    await svc.shutdown();
  });

  it('decodes the LAUS measure from la.measure on the series measure_code', async () => {
    const { svc, requested } = await harvestFrom(LA_MEASURE_FILES);
    const rows = await svc.lookupByIds([
      'LASST530000000000003',
      'LASST530000000000008',
      'LAUCN530330000000003',
    ]);
    expect(Object.fromEntries([...rows].map(([id, s]) => [id, s.measure]))).toEqual({
      LASST530000000000003: 'unemployment rate',
      LASST530000000000008: 'labor force participation rate',
      LAUCN530330000000003: 'unemployment rate',
    });
    expect(rows.get('LASST530000000000008')).toMatchObject({
      title: 'Labor Force Participation Rate: Washington (S)',
      areaName: 'Washington',
    });
    expect(rows.get('LAUCN530330000000003')?.areaName).toBe('King County, WA');
    // The measure is not repeated as the item.
    for (const s of rows.values()) expect(s).not.toHaveProperty('itemName');
    expect(requested.filter((f) => f.startsWith('la.')).sort()).toEqual([
      'la.area',
      'la.measure',
      'la.series',
    ]);
    await svc.shutdown();
  });

  it('decodes none where BLS’s API catalog carries no measure (JT, EC)', async () => {
    const { svc, requested } = await harvestFrom({ ...JT_FILES, ...EC_FILES });
    const rows = await svc.lookupByIds(['JTS000000000000000JOL', 'ECS10001I']);
    expect(rows.size).toBe(2);
    for (const s of rows.values()) expect(s).not.toHaveProperty('measure');
    // No measure table is fetched for them.
    expect(requested.filter((f) => /^(jt|ec)\./.test(f) && !f.endsWith('.series')).sort()).toEqual([
      'ec.compensation',
      'ec.group',
      'ec.ownership',
      'ec.periodicity',
      'jt.dataelement',
      'jt.industry',
      'jt.ratelevel',
      'jt.sizeclass',
      'jt.state',
    ]);
    await svc.shutdown();
  });

  it('indexes a cold survey without a measure when its measure table is unavailable', async () => {
    const { 'ce.datatype': _dropped, ...withoutDatatype } = MEASURE_FILES;
    const { svc, warnings } = await harvestFrom(withoutDatatype);
    const rows = await svc.lookupByIds(['CES0000000001', 'LNS14000000']);
    expect(rows.get('CES0000000001')).toMatchObject({
      title: 'All employees, thousands, total nonfarm, seasonally adjusted',
      itemName: 'Total nonfarm',
    });
    expect(rows.get('CES0000000001')).not.toHaveProperty('measure');
    expect(rows.get('LNS14000000')?.measure).toBe('Percent or rate');
    expect(warnings.filter((w) => w.includes('ce.datatype'))).toEqual([
      '[bls-labor-mcp-server] Catalog: ce.datatype unavailable (HTTP 404) — its rows index without a measure.\n',
    ]);
    await svc.shutdown();
  });

  it('keeps a warm survey’s rows, measure included, when its measure table is unavailable', async () => {
    const dbPath = join(tmpDir, 'measure-warm.db');
    const old = createCatalogStore(dbPath);
    const prior: CatalogSeries = {
      seriesId: 'CES0000000001',
      title: 'Old title',
      surveyAbbr: 'CE',
      seasonal: true,
      measure: 'ALL EMPLOYEES, THOUSANDS',
    };
    await old.applyBatch([{ ...toMirrorRow(prior), measure: prior.measure ?? null }], []);
    await old.writeState({
      status: 'complete',
      completedAt: '2020-01-01T00:00:00.000Z',
      checkpoint: catalogSurveyList(false),
    });
    await old.close();
    const { 'ce.datatype': _dropped, ...withoutDatatype } = MEASURE_FILES;
    serveLabstat(withoutDatatype);
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', dbPath, 168, false);
    await svc.load(1);
    expect((await svc.lookupByIds([prior.seriesId])).get(prior.seriesId)).toEqual(prior);
    await svc.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Concept aliases on word boundaries (#89)
// ---------------------------------------------------------------------------

describe('BlsCatalogService.search — concept aliases (#89)', () => {
  /**
   * One probe row per survey under an identical title, so only an alias boost
   * separates them. LA and AP carry no alias and seed first: the rows ranked
   * above `PROBE_LA` are exactly the boosted surveys.
   */
  const PROBES: CatalogSeries[] = [
    'LA',
    'AP',
    'CU',
    'WP',
    'PC',
    'CE',
    'JT',
    'LN',
    'PR',
    'MP',
    'EC',
    'CM',
    'CI',
  ].map((surveyAbbr) => ({
    seriesId: `PROBE_${surveyAbbr}`,
    title: 'Alias probe row',
    surveyAbbr,
    seasonal: false,
  }));

  async function boosted(svc: BlsCatalogService, phrase: string): Promise<string[]> {
    const result = await svc.search(search(`${phrase} probe`, { limit: 20 }));
    const ids = result.series.map((s) => s.seriesId);
    expect(ids).toHaveLength(PROBES.length);
    return ids
      .slice(0, ids.indexOf('PROBE_LA'))
      .map((id) => id.replace('PROBE_', ''))
      .sort();
  }

  it.each<[string, string[]]>([
    ['inflation', ['CU']],
    ['cost of living', ['CU']],
    ['consumer prices', ['CU']],
    ['cpi', ['CU']],
    ['cpi-u', ['CU']],
    ['producer prices', ['PC', 'WP']],
    ['wholesale price', ['PC', 'WP']],
    ['ppi', ['PC', 'WP']],
    ['(ppi)', ['PC', 'WP']],
    ['jobs', ['CE']],
    ['job growth', ['CE']],
    ['payrolls', ['CE']],
    ['nonfarm', ['CE']],
    ['wages', ['CE']],
    ['earnings', ['CE']],
    ['job openings', ['JT']],
    ['labor turnover', ['JT']],
    ['job vacancies', ['JT']],
    ['quits', ['JT']],
    ['jolts', ['JT']],
    ['unemployment', ['LN']],
    ['jobless', ['LN']],
    ['labor force participation', ['LN']],
    ['productivity', ['MP', 'PR']],
    ['output per hour', ['MP', 'PR']],
    ['compensation', ['CI', 'CM']],
    ['employer costs', ['CI', 'CM']],
    ['ecec', ['CI', 'CM']],
    ['employment cost index', ['CI']],
    ['eci', ['CI']],
    ['eci benefits', ['CI']],
  ])('%j boosts %j', async (phrase, surveys) => {
    const svc = await seedAndLoad(PROBES);
    expect(await boosted(svc, phrase)).toEqual(surveys);
  });

  it.each([
    'grocery shopping',
    'happiness',
    'shopping centers',
    'special',
    'decision',
    'precision',
    'overcompensation',
  ])('%j matches no alias inside a word', async (phrase) => {
    const svc = await seedAndLoad(PROBES);
    expect(await boosted(svc, phrase)).toEqual([]);
  });
});

describe('conceptAliasSurveys (#89)', () => {
  it('matches alias phrases at word starts, a stem phrase completing inside its word', () => {
    expect([...conceptAliasSurveys('job vacancies')]).toEqual(['JT']);
    expect([...conceptAliasSurveys('ppi')].sort()).toEqual(['PC', 'WP']);
    expect([...conceptAliasSurveys('happiness while shopping')]).toEqual([]);
  });

  it('runs in linear time on worst-case caller text', () => {
    const run = (input: string) => {
      conceptAliasSurveys(input);
      queryFrequencies(input);
    };
    /**
     * Near-misses, where each position starts a phrase or frequency word that
     * fails late, plus a unit that matches at every word.
     */
    const units = [
      'job ',
      'cost of ',
      'labor force ',
      'semi-',
      'semi ',
      'employ',
      'p',
      'a',
      'monthly ',
    ];
    for (const unit of units) {
      const text = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      expectLinearTime(run, text, unit);
    }
  });
});

// ---------------------------------------------------------------------------
// Query tokens score at word starts (#91)
// ---------------------------------------------------------------------------

describe('BlsCatalogService.search — tokens score at word starts (#91)', () => {
  const US = 'U.S. city average';
  const cpi = (
    seriesId: string,
    item: string,
    seasonal: boolean,
    frequency = 'Monthly',
  ): CatalogSeries => ({
    seriesId,
    title: `${item} in ${US}, all urban consumers, ${seasonal ? '' : 'not '}seasonally adjusted`,
    surveyAbbr: 'CU',
    seasonal,
    areaName: US,
    itemName: item,
    frequency,
  });
  /** Real 2026-09-23 rows: the headline series plus CPI all-items rows they outranked. */
  const HEADLINES: CatalogSeries[] = [
    cpi('CUUR0000SA0', 'All items', false),
    cpi('CUSR0000SA0', 'All items', true),
    {
      seriesId: 'CES0000000001',
      title: 'All employees, thousands, total nonfarm, seasonally adjusted',
      surveyAbbr: 'CE',
      seasonal: true,
      itemName: 'Total nonfarm',
    },
    {
      seriesId: 'WPUFD4',
      title: 'PPI Commodity data for Final demand, not seasonally adjusted',
      surveyAbbr: 'WP',
      seasonal: false,
      itemName: 'Final demand',
    },
    {
      seriesId: 'JTS000000000000000JOL',
      title:
        'JOLTS - Job openings - Total nonfarm - Total US - All size classes - Level - In Thousands',
      surveyAbbr: 'JT',
      seasonal: true,
      areaName: 'Total US',
    },
    {
      seriesId: 'LNS14000000',
      title: '(Seas) Unemployment Rate',
      surveyAbbr: 'LN',
      seasonal: true,
      frequency: 'Monthly',
    },
    cpi('CUUS0000SA0', 'All items', false, 'Semi-Annual'),
    cpi('CUSR0000SA0L1', 'All items less food', true),
    cpi('CUSR0000SA0L2', 'All items less shelter', true),
    cpi('CUUR0000AA0', 'All items - old base', false),
    cpi('CUUR0000SA0R', 'Purchasing power of the consumer dollar', false),
    cpi('CUSR0000SEHA', 'Rent of primary residence', true),
    cpi('CUUR0000SEHA', 'Rent of primary residence', false),
    {
      seriesId: 'CES2000000057',
      title:
        'Aggregate weekly payrolls of all employees, thousands, construction, seasonally adjusted',
      surveyAbbr: 'CE',
      seasonal: true,
      itemName: 'Construction',
    },
    {
      seriesId: 'JTS230000000000000JOR',
      title: 'JOLTS - Job openings - Construction - Total US - All size classes - Rate',
      surveyAbbr: 'JT',
      seasonal: true,
      areaName: 'Total US',
    },
  ];
  const idsFor = async (svc: BlsCatalogService, query: string, limit = 10) =>
    (await svc.search(search(query, { limit }))).series.map((s) => s.seriesId);

  it('keeps the CE, WP, and JT headlines out of the top 5 for "annual average all items"', async () => {
    const svc = await seedAndLoad(HEADLINES);
    const top5 = (await svc.search(search('annual average all items', { limit: 5 }))).series;
    expect(top5.map((s) => s.surveyAbbr)).toEqual(['CU', 'CU', 'CU', 'CU', 'CU']);
    expect(top5.slice(0, 2).map((s) => s.seriesId)).toEqual(['CUUR0000SA0', 'CUSR0000SA0']);
  });

  it('never counts a token found only inside another word', async () => {
    const svc = await seedAndLoad(HEADLINES);
    // "all" sits inside "seasonally"; WPUFD4 has no other match.
    expect(await idsFor(svc, 'all', 50)).not.toContain('WPUFD4');
    // "employ" starts "employees" but sits inside "unemployment".
    const employ = await idsFor(svc, 'employ', 50);
    expect(employ).toContain('CES0000000001');
    expect(employ).not.toContain('LNS14000000');
  });

  it('never counts a token inside a word of the area or item', async () => {
    // Headline ids make both rows candidates without an FTS match; "all" sits only inside "Dallas" and "Small".
    const svc = await seedAndLoad([
      {
        seriesId: 'LNS12000000',
        title: 'Price index',
        surveyAbbr: 'AP',
        seasonal: false,
        areaName: 'Dallas-Fort Worth-Arlington, TX',
      },
      {
        seriesId: 'LNS11300000',
        title: 'Price index',
        surveyAbbr: 'AP',
        seasonal: false,
        itemName: 'Small appliances',
      },
    ]);
    expect(await idsFor(svc, 'all', 50)).toEqual([]);
  });

  it('counts a match in the headline description toward the headline gate', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'JTS000000000000000JOL',
        title:
          'JOLTS - Job openings - Total nonfarm - Total US - All size classes - Level - In Thousands',
        surveyAbbr: 'JT',
        seasonal: true,
        areaName: 'Total US',
      },
      {
        seriesId: 'TEST_INDUSTRIES',
        title: 'Industries, all sizes',
        surveyAbbr: 'AP',
        seasonal: false,
      },
    ]);
    // "industries" is only in the headline's description ("jolts job openings all industries"),
    // and "all" in its title: 2 of 2 tokens, so the +8 lifts it over a row matching both in its title.
    expect(await idsFor(svc, 'industries all')).toEqual([
      'JTS000000000000000JOL',
      'TEST_INDUSTRIES',
    ]);
  });

  it.each<[string, string[]]>([
    ['payrolls', ['CES0000000001', 'CES2000000057']],
    ['job openings', ['JTS000000000000000JOL', 'JTS230000000000000JOR']],
    ['consumer prices', ['CUUR0000SA0', 'CUSR0000SA0', 'CUUR0000SA0R']],
  ])('keeps the top results for the plural or stem query %j', async (query, top) => {
    const svc = await seedAndLoad(HEADLINES);
    expect((await idsFor(svc, query)).slice(0, top.length)).toEqual(top);
  });

  it('matches a stem at a word start: "manufactur" finds "manufacturing"', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'CES3000000001',
        title: 'All employees, thousands, manufacturing, seasonally adjusted',
        surveyAbbr: 'CE',
        seasonal: true,
        itemName: 'Manufacturing',
      },
    ]);
    expect(await idsFor(svc, 'manufactur')).toEqual(['CES3000000001']);
  });

  it('keeps matching a SeriesID fragment inside the ID, where the item code sits', async () => {
    const svc = await seedAndLoad(HEADLINES);
    expect((await idsFor(svc, 'seha rent')).slice(0, 2).sort()).toEqual([
      'CUSR0000SEHA',
      'CUUR0000SEHA',
    ]);
    expect((await idsFor(svc, 'sa0')).slice(0, 2)).toEqual(['CUUR0000SA0', 'CUSR0000SA0']);
  });

  it('still lifts a headline its survey alias names, with no title token match', async () => {
    const svc = await seedAndLoad(HEADLINES);
    expect((await idsFor(svc, 'jobs'))[0]).toBe('CES0000000001');
    expect((await idsFor(svc, 'inflation')).slice(0, 2)).toEqual(['CUUR0000SA0', 'CUSR0000SA0']);
  });
});

describe('BlsCatalogService.search — the PPI headline is Final demand (#125)', () => {
  const ppi = (seriesId: string, subject: string, item: string): CatalogSeries => ({
    seriesId,
    title: `PPI Commodity data for ${subject}, ${seriesId[2] === 'S' ? '' : 'not '}seasonally adjusted`,
    surveyAbbr: 'WP',
    seasonal: seriesId[2] === 'S',
    itemName: item,
  });
  const CORE_PPI = 'Final demand less foods and energy';
  /** Real 2026-11-01 rows: core PPI seeds first, then finished goods, the final-demand index, and a PC row. */
  const ROWS: CatalogSeries[] = [
    ppi('WPUFD49104', CORE_PPI, CORE_PPI),
    ppi('WPSFD49104', CORE_PPI, CORE_PPI),
    ppi('WPSFD49207', 'Final demand-Finished goods', 'Finished goods'),
    ppi('WPUFD49207', 'Final demand-Finished goods', 'Finished goods'),
    ppi('WPSFD4', 'Final demand', 'Final demand'),
    ppi('WPUFD4', 'Final demand', 'Final demand'),
    {
      seriesId: 'PCU113310113310',
      title: 'PPI industry data for Logging, not seasonally adjusted',
      surveyAbbr: 'PC',
      seasonal: false,
      itemName: 'Logging',
    },
  ];
  const firstFor = async (svc: BlsCatalogService, query: string) =>
    (await svc.search(search(query))).series[0]?.seriesId;

  it.each<[string, string[]]>([
    ['ppi', ['WPUFD4', 'WPSFD4']],
    ['producer price index', ['WPUFD4', 'WPSFD4']],
    ['ppi finished goods', ['WPUFD49207', 'WPSFD49207']],
  ])('leads %j with %j', async (query, answers) => {
    const svc = await seedAndLoad(ROWS);
    expect(answers).toContain(await firstFor(svc, query));
  });
});

describe('startsWord (#91)', () => {
  it('matches where a word starts, literally, and lets the end run on', () => {
    expect(startsWord('all items', 'all')).toBe(true);
    expect(startsWord('seasonally adjusted', 'all')).toBe(false);
    expect(startsWord('seasonally adjusted, all items', 'all')).toBe(true);
    expect(startsWord('aggregate weekly payrolls', 'payroll')).toBe(true);
    expect(startsWord('in u.s. city average', 'u.s.')).toBe(true);
    expect(startsWord('in uxsx city', 'u.s.')).toBe(false);
    expect(startsWord('state_rate', 'rate')).toBe(false);
    expect(startsWord('ppi (final)', '(final')).toBe(true);
    expect(startsWord('anything', '')).toBe(false);
  });

  it('takes caller text of any length that a RegExp would refuse to compile', () => {
    const title = 'All items in U.S. city average, all urban consumers, not seasonally adjusted';
    expect(startsWord(title, 'all '.repeat(20_000))).toBe(false);
    expect(startsWord(`${'all '.repeat(20_000)}x`, 'all')).toBe(true);
  });

  it('runs in linear time on worst-case caller text, as haystack or needle', () => {
    const title = 'All items in U.S. city average, all urban consumers, not seasonally adjusted';
    const run = (input: string) => {
      startsWord(title, input);
      startsWord(input, 'all');
      startsWord(input, 'job vacanc');
    };
    /** Units whose every position holds a near-miss: an in-word "all", or a phrase that fails late. */
    for (const unit of ['xall', 'all ', 'job ', 'a', '(']) {
      const text = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      expectLinearTime(run, text, unit);
    }
  });
});

// ---------------------------------------------------------------------------
// Long and repetitive queries stay bounded (#92)
// ---------------------------------------------------------------------------

describe('BlsCatalogService.search — token modes (#95)', () => {
  it.each(['ats', 'á', '𐐀'])(
    'keeps a whole final term whole before %j in the full-query score',
    async (suffix) => {
      const svc = await seedAndLoad([
        { seriesId: 'ZZ001', title: `a b c${suffix}`, surveyAbbr: 'AP', seasonal: false },
        { seriesId: 'ZZ002', title: 'a-b-c', areaName: 'a b c', surveyAbbr: 'AP', seasonal: false },
      ]);
      expect((await svc.search(search('a b c'))).series.map((s) => s.seriesId)).toEqual([
        'ZZ002',
        'ZZ001',
      ]);
    },
  );

  it.each([
    { seriesId: 'ZZ001', title: 'Alpha beta gamma' },
    { seriesId: 'ZZ002', title: 'Index', areaName: 'Alpha beta gamma' },
    { seriesId: 'ZZ003', title: 'Index', itemName: 'Alpha beta gamma' },
    { seriesId: 'ABC001', title: 'Index' },
    { seriesId: 'CES0000000001', title: 'Index' },
  ])('uses whole terms across candidate and rescore fields: $seriesId', async (row) => {
    const svc = await seedAndLoad([{ ...row, surveyAbbr: 'AP', seasonal: false }]);
    expect(await svc.search(search('a b c'))).toEqual({ series: [], total: 0, capped: false });
  });

  it('counts whole tokens separated by punctuation or line breaks and retains longer stems', async () => {
    const svc = await seedAndLoad([
      { seriesId: 'ZZ001', title: 'a-b\nc\r\nManufacturing', surveyAbbr: 'AP', seasonal: false },
      { seriesId: 'ZZ002', title: 'Alpha beta gamma', surveyAbbr: 'AP', seasonal: false },
    ]);
    const result = await svc.search(search('a b c manufactur'));
    expect(result.series.map((s) => s.seriesId)).toEqual(['ZZ001']);
    expect(result.total).toBe(1);
    expect(await svc.search(search('a b c manufactur', { offset: 1 }))).toEqual({
      series: [],
      total: 1,
      capped: false,
    });
  });

  it('does not restore whole-term prefix scores on a row admitted by another token', async () => {
    const svc = await seedAndLoad([
      {
        seriesId: 'ABC001',
        title: 'Manufacturing alpha beta gamma',
        surveyAbbr: 'AP',
        seasonal: false,
      },
      { seriesId: 'ZZ001', title: 'Manufacturing a b c', surveyAbbr: 'AP', seasonal: false },
    ]);
    const result = await svc.search(search('a b c manufactur'));
    expect(result.series.map((s) => s.seriesId)).toEqual(['ZZ001', 'ABC001']);
  });

  it('selects modes after distinct-token capping and keeps exact-ID priority', async () => {
    const svc = await seedAndLoad([
      { seriesId: 'A_B_C', title: 'Manufacturing', surveyAbbr: 'AP', seasonal: false },
    ]);
    expect((await svc.search(search('A_B_C'))).series[0]?.seriesId).toBe('A_B_C');
    const terms = ['m', ...Array.from({ length: 31 }, (_, i) => `zz${i}`)];
    expect((await svc.search(search(`${terms.join(' ')} a b c`))).series[0]?.seriesId).toBe(
      'A_B_C',
    );
    expect(await svc.search(search('m m m m'))).toEqual(await svc.search(search('m m')));
  });

  it.each(['m', 'm m', 'u.s. city', 'manufactur', 'seha rent'])(
    'retains prefix and ID-fragment recall for %j (characterization)',
    async (query) => {
      const svc = await seedAndLoad([
        {
          seriesId: 'CUSR0000SEHA',
          title: 'Manufacturing rent in U.S. city average',
          surveyAbbr: 'CU',
          seasonal: true,
        },
      ]);
      expect((await svc.search(search(query))).series.map((s) => s.seriesId)).toEqual([
        'CUSR0000SEHA',
      ]);
    },
  );

  it('keeps token-mode scans linear in thread CPU time', async () => {
    const shapes = [
      { text: (n: number) => `${'za'.repeat(Math.ceil(n / 2))}\ny`, first: 1_250, last: 80_000 },
      { text: (n: number) => ' a\r\n'.repeat(Math.ceil(n / 4)), first: 1_250, last: 80_000 },
      { text: (n: number) => '1'.repeat(n), first: 5_000, last: 320_000 },
    ];
    for (const { text, first, last } of shapes) {
      let baseline = 0;
      let largest = 0;
      for (let n = first; n <= last; n *= 2) {
        const svc = await seedAndLoad([
          { seriesId: 'CES0000000001', title: text(n), surveyAbbr: 'AP', seasonal: false },
        ]);
        await svc.search(search('a b c'));
        const times: number[] = [];
        for (let round = 0; round < 3; round++) {
          const start = process.threadCpuUsage();
          await svc.search(search('a b c'));
          const elapsed = process.threadCpuUsage(start);
          times.push((elapsed.user + elapsed.system) / 1_000);
        }
        largest = times.sort((a, b) => a - b)[1]!;
        expect(largest).toBeLessThan(250);
        if (n === first) baseline = Math.max(largest, 0.05);
        await svc.shutdown();
      }
      expect(largest / baseline).toBeLessThan(256);
    }
  });
});

describe('BlsCatalogService.search — long and repetitive queries (#92)', () => {
  /** An items-only row that scores 3, a row matching only "all" (2), and the CES headline. */
  const ROWS: CatalogSeries[] = [
    {
      seriesId: 'TEST_ITEMS',
      title: 'Items index',
      surveyAbbr: 'AP',
      seasonal: false,
      itemName: 'Items',
    },
    { seriesId: 'TEST_ALL', title: 'All data series', surveyAbbr: 'AP', seasonal: false },
    {
      seriesId: 'CES0000000001',
      title: 'All employees, thousands, total nonfarm, seasonally adjusted',
      surveyAbbr: 'CE',
      seasonal: true,
      itemName: 'Total nonfarm',
    },
  ];
  const idsFor = async (svc: BlsCatalogService, query: string, area?: string) =>
    (
      await svc.search(search(query, { limit: 50, ...(area !== undefined && { area }) }))
    ).series.map((s) => s.seriesId);

  it('scores a repeated token once: "all all all items" ranks as "all items"', async () => {
    const svc = await seedAndLoad(ROWS);
    const once = await idsFor(svc, 'all items');
    expect(once).toEqual(['TEST_ITEMS', 'TEST_ALL', 'CES0000000001']);
    expect(await idsFor(svc, 'all all all items')).toEqual(once);
    expect(await idsFor(svc, `${'all '.repeat(800)}items`)).toEqual(once);
  });

  it('keeps the headline gate on distinct tokens: repeating "all" earns CES no boost', async () => {
    const svc = await seedAndLoad(ROWS);
    const result = await svc.search(search('all all all items'));
    expect(result.series.at(-1)?.seriesId).toBe('CES0000000001');
  });

  it('scores the first 32 distinct tokens and ignores the rest', async () => {
    const svc = await seedAndLoad([
      { seriesId: 'TEST_W31', title: 'Word w31 row', surveyAbbr: 'AP', seasonal: false },
      { seriesId: 'TEST_W32', title: 'Word w32 row', surveyAbbr: 'AP', seasonal: false },
    ]);
    // Two-digit words, so no token is a word-start prefix of another ("w3" of "w32").
    const words = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    // Repeats before the cap do not use it up: w00 twice still leaves w31 the 32nd distinct token.
    const ids = await idsFor(svc, ['w00', ...words].join(' '));
    expect(ids).toEqual(['TEST_W31']);
  });

  it('stays bounded in time however many distinct tokens the query holds', async () => {
    const svc = await seedAndLoad(
      Array.from({ length: 2_000 }, (_, i) => ({
        seriesId: `TEST_BOUND${String(i).padStart(4, '0')}`,
        title: `Series w${i} a${i % 7} b${i % 11} all items`,
        surveyAbbr: 'AP',
        seasonal: false,
      })),
    );
    /** Median of five runs, so one GC pause cannot decide the ratio. */
    const time = async (query: string) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await svc.search(search(query));
        runs.push(performance.now() - start);
      }
      return runs.sort((a, b) => a - b)[2] ?? 0;
    };
    const distinct = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    await time(distinct(32)); // warm the statement cache and the JIT
    const t32 = Math.max(await time(distinct(32)), 5);
    const t5000 = await time(distinct(5_000));
    const tRepeat = await time('all '.repeat(5_000));
    // The cap makes cost independent of query length; uncapped, 5,000 terms cost ~90× 32.
    expect(t5000 / t32).toBeLessThan(8);
    expect(t5000).toBeLessThan(250);
    expect(tRepeat).toBeLessThan(250);
  });

  it('matches nothing for an area longer than any indexed text, without a SQLite error', async () => {
    const svc = await seedAndLoad(ROWS);
    const area = 'a'.repeat(60_000);
    expect(await idsFor(svc, 'all items', area)).toEqual([]);
    // An exact SeriesID still scores before the area gate, as it does for any area.
    expect(await idsFor(svc, 'TEST_ITEMS', area)).toEqual(['TEST_ITEMS']);
  });
});

// ---------------------------------------------------------------------------
// OEWS SeriesIDs composed from the OE code tables (#119)
// ---------------------------------------------------------------------------

const SEATTLE_RN_IDS = [
  'OEUM004266000000029114103',
  'OEUS530000000000029114103',
  'OEUN000000000000029114103',
];

/** One indexed OE row per area, as the opt-in harvest decodes them from `oe.series`. */
const OE_SERIES = tsv(
  [
    'series_id',
    'seasonal',
    'areatype_code',
    'industry_code',
    'occupation_code',
    'datatype_code',
    'state_code',
    'area_code',
    'sector_code',
    'series_title',
    'footnote_codes',
    'begin_year',
    'begin_period',
    'end_year',
    'end_period',
  ],
  [
    'OEUM004266000000029114103',
    'U',
    'M',
    '000000',
    '291141',
    '03',
    '53',
    '0042660',
    '-',
    'Hourly mean wage for Registered Nurses in All Industries in Seattle-Tacoma-Bellevue, WA',
    '',
    '2025',
    'A01',
    '2025',
    'A01',
  ],
  [
    'OEUN000000000000029114103',
    'U',
    'N',
    '000000',
    '291141',
    '03',
    '00',
    '0000000',
    '-',
    'Hourly mean wage for Registered Nurses in All Industries in the United States',
    '',
    '2025',
    'A01',
    '2025',
    'A01',
  ],
);

describe('BlsCatalogService — OEWS composition from the OE code tables (#119)', () => {
  /** Harvest a fresh index at `path` from `files` (one load, every download once). */
  async function harvestAt(
    path: string,
    files: Record<string, string>,
    includeOes = false,
  ): Promise<{ svc: BlsCatalogService; requested: string[]; warnings: string[] }> {
    const served = serveLabstat(files);
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, includeOes);
    await svc.load(1);
    return { svc, ...served };
  }

  const nurses = (opts: { survey?: string; area?: string } = { survey: 'OE', area: 'Seattle' }) =>
    searchInput('registered nurses hourly mean wage', opts);

  it('harvests the OE code tables by default, never oe.series, and composes under survey OE', async () => {
    const { svc, requested } = await harvestFrom({ ...JT_FILES, ...OE_TABLE_FILES });
    expect(requested).toEqual(expect.arrayContaining(['oe.area', 'oe.occupation', 'oe.datatype']));
    expect(requested.filter((f) => f === 'oe.series' || f.startsWith('oe.data.'))).toEqual([]);

    const result = await svc.search(nurses());
    expect(result.composed).toBe(true);
    expect(result.series.slice(0, 3).map((s) => s.seriesId)).toEqual(SEATTLE_RN_IDS);
    expect(result.series.every((s) => s.composed === true && s.surveyAbbr === 'OE')).toBe(true);
    expect(result.series[0]).not.toHaveProperty('startYear');
    await svc.shutdown();
  });

  it('keeps the stored tables across a restart, and when a later download fails', async () => {
    const path = join(tmpDir, `oews-${dbCounter++}.db`);
    const first = await harvestAt(path, { ...JT_FILES, ...OE_TABLE_FILES });
    await first.svc.shutdown();
    vi.restoreAllMocks();

    // The other surveys failed, so the restart re-harvests every survey and the
    // tables; oe.occupation now answers 503 and the stored set stays in force.
    const files: Record<string, string> = { ...JT_FILES, ...OE_TABLE_FILES };
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const file = String(url).slice(String(url).lastIndexOf('/') + 1);
      if (file === 'oe.occupation') return Promise.resolve(new Response('busy', { status: 503 }));
      const body = files[file];
      return Promise.resolve(
        body === undefined ? new Response('', { status: 404 }) : new Response(body),
      );
    });
    const restarted = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    await restarted.load(1);
    expect(warnings.join('')).toContain(
      'OE code tables not refreshed (oe.occupation: HTTP 503) — the stored tables are kept;',
    );
    const result = await restarted.search(nurses());
    expect(result.series.slice(0, 3).map((s) => s.seriesId)).toEqual(SEATTLE_RN_IDS);
    await restarted.shutdown();
  });

  it('keeps a structurally unusable table set out, keeping the stored one', async () => {
    const { svc, warnings } = await harvestFrom({
      ...JT_FILES,
      ...OE_TABLE_FILES,
      'oe.area': '<html><body>Access Denied</body></html>\n',
    });
    expect(warnings.join('')).toContain(
      'OE code tables not refreshed (a table lacks a required column or has no usable rows) — the stored tables are kept;',
    );
    const result = await svc.search(nurses());
    expect(result.composed).toBeUndefined();
    expect(result.total).toBe(0);
    await svc.shutdown();
  });

  it('composes nothing while no tables are stored', async () => {
    const { svc } = await harvestFrom(JT_FILES);
    const result = await svc.search(nurses());
    expect(result).toEqual({ series: [], total: 0, capped: false });
    await svc.shutdown();
  });

  it('returns no composed row for an unscoped query, but decodes an exact OE SeriesID', async () => {
    const { svc } = await harvestFrom({ ...JT_FILES, ...OE_TABLE_FILES });
    const unscoped = await svc.search(nurses({}));
    expect(unscoped.composed).toBeUndefined();
    expect(unscoped.series.filter((s) => s.composed)).toEqual([]);

    const exact = await svc.search(searchInput('OEUM004266000000029114103'));
    expect(exact.series.map((s) => [s.seriesId, s.composed])).toEqual([
      ['OEUM004266000000029114103', true],
    ]);
    const unknown = await svc.search(searchInput('OEUM009999900000029114103'));
    expect(unknown.series).toEqual([]);
    expect(unknown.composed).toBeUndefined();
    await svc.shutdown();
  });

  it('serves only indexed OE rows, composing nothing, once the opt-in has indexed OE', async () => {
    const { svc } = await harvestFrom(
      { ...JT_FILES, ...OE_TABLE_FILES, 'oe.series': OE_SERIES },
      { includeOes: true },
    );
    expect(svc.indexedSurveys).toContain('OE');
    const result = await svc.search(nurses());
    expect(result.composed).toBeUndefined();
    expect(result.series.map((s) => [s.seriesId, s.composed])).toEqual([
      ['OEUM004266000000029114103', undefined],
    ]);
    const exact = await svc.search(searchInput('OEUS530000000000029114103', { survey: 'OE' }));
    expect(exact.series).toEqual([]);
    await svc.shutdown();
  });

  it('composes under the opt-in while its OE harvest has indexed no rows', async () => {
    const { svc } = await harvestFrom({ ...JT_FILES, ...OE_TABLE_FILES }, { includeOes: true });
    expect(svc.indexedSurveys).not.toContain('OE');
    const result = await svc.search(nurses());
    expect(result.series.slice(0, 3).map((s) => s.seriesId)).toEqual(SEATTLE_RN_IDS);
    await svc.shutdown();
  });

  it('requests each OE code table once when the opt-in OE harvest already read it', async () => {
    const path = join(tmpDir, `oews-reuse-${dbCounter++}.db`);
    const { svc, requested } = await harvestAt(
      path,
      { ...JT_FILES, ...OE_TABLE_FILES, 'oe.series': OE_SERIES },
      true,
    );
    expect(svc.indexedSurveys).toContain('OE');
    expect(requested.filter((f) => f.startsWith('oe.')).sort()).toEqual([
      'oe.area',
      'oe.datatype',
      'oe.occupation',
      'oe.series',
    ]);
    expect(svc.storedOewsTables?.areas.get('0042660')?.name).toBe('Seattle-Tacoma-Bellevue, WA');
    await svc.shutdown();
    vi.restoreAllMocks();

    // The reused bodies were stored: a restart whose downloads all fail still holds them.
    serveLabstat({});
    const restarted = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, true);
    await restarted.load(1);
    expect(restarted.storedOewsTables?.areas.get('0042660')?.name).toBe(
      'Seattle-Tacoma-Bellevue, WA',
    );
    await restarted.shutdown();
  });

  it('re-harvests a fresh version-4 index once, gaining the tables (CATALOG_INDEX_VERSION bump)', async () => {
    const path = join(tmpDir, `v4-${dbCounter++}.db`);
    const v4 = sqliteMirrorStore({
      path,
      version: 4,
      table: 'bls_catalog',
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
      },
      fts: ['series_id', 'title', 'area_name', 'item_name'],
      indexes: [{ columns: ['survey_abbr'] }, { columns: ['seasonal'] }],
    });
    await v4.applyBatch(
      [toMirrorRow({ seriesId: 'JTOLD', title: 'Old', surveyAbbr: 'JT', seasonal: true })],
      [],
    );
    await v4.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      total: 1,
      checkpoint: catalogSurveyList(false),
    });
    await v4.close();

    const { svc, requested } = await harvestAt(path, { ...JT_FILES, ...OE_TABLE_FILES });
    expect(requested).toEqual(expect.arrayContaining(['jt.series', 'oe.area']));
    const result = await svc.search(nurses());
    expect(result.series[0]?.seriesId).toBe(SEATTLE_RN_IDS[0]);
    await svc.shutdown();
  });
});

describe('BlsCatalogService.load — the OE code tables on the refresh schedule (#119)', () => {
  const HOUR = 3_600_000;
  const T0 = Date.parse('2026-10-01T00:00:00Z');
  const OE_FILES = Object.keys(OE_TABLE_FILES);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Serve every configured survey one decodable row and the OE tables from the
   * fixtures, except the files `failing` names (HTTP 503) — mutable between
   * checks. A `.series` body is built a microtask after its request, by which
   * time its survey's table requests have named every key column.
   */
  function serveCatalog(): { requested: string[]; lines: string[]; failing: Set<string> } {
    const requested: string[] = [];
    const lines: string[] = [];
    const failing = new Set<string>();
    const keys = new Set([
      'industry_code',
      'product_code',
      'group_code',
      'item_code',
      'comp_code',
      'data_type_code',
    ]);
    const row = (columns: string[]) => columns.map(() => 'x').join('\t');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const file = String(url).slice(String(url).lastIndexOf('/') + 1);
      requested.push(file);
      if (failing.has(file)) return new Response('busy', { status: 503 });
      const oe = OE_TABLE_FILES[file];
      if (oe !== undefined) return new Response(oe);
      const [abbr = '', table = ''] = file.split('.');
      if (table !== 'series') {
        keys.add(`${table}_code`);
        const header = [...keys];
        return new Response(`${header.join('\t')}\tlabel_text\n${row(header)}\tDecoded\n`);
      }
      await Promise.resolve();
      const header = [...keys];
      return new Response(
        `series_id\tseries_title\tseasonal\t${header.join('\t')}\n${abbr.toUpperCase()}NEW\tSeries ${abbr}\tS\t${row(header)}\n`,
      );
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return { requested, lines, failing };
  }

  async function check(svc: BlsCatalogService, requested: string[]): Promise<string[]> {
    const before = requested.length;
    await svc.load(1);
    return requested.slice(before);
  }

  async function stateOf(path: string) {
    const store = createCatalogStore(path);
    const state = await store.readState();
    await store.close();
    return state;
  }

  it('retries failed tables alone with backoff, without holding the index incomplete', async () => {
    const path = join(tmpDir, `oe-sched-${dbCounter++}.db`);
    const { requested, lines, failing } = serveCatalog();
    failing.add('oe.datatype');
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    await svc.load(1); // check 1: every survey and the tables; the tables fail
    expect(svc.indexedSurveys.length).toBeGreaterThan(0);
    expect((await stateOf(path)).status).toBe('complete');
    expect(lines.filter((l) => l.includes('OE code tables'))).toEqual([
      '[bls-labor-mcp-server] Catalog: OE code tables not refreshed (oe.datatype: HTTP 503) — the stored tables are kept; next retry at the next hourly check.\n',
    ]);

    expect((await check(svc, requested)).sort()).toEqual([...OE_FILES].sort()); // check 2
    expect(await check(svc, requested)).toEqual([]); // check 3: backing off
    failing.clear();
    expect((await check(svc, requested)).sort()).toEqual([...OE_FILES].sort()); // check 4
    expect(await stateOf(path)).toMatchObject({ status: 'complete' });
    expect(await check(svc, requested)).toEqual([]);
    const composed = await svc.search(
      searchInput('registered nurses hourly mean wage', { survey: 'OE', area: 'Seattle' }),
    );
    expect(composed.series[0]?.seriesId).toBe('OEUM004266000000029114103');
    await svc.shutdown();
  });

  it('refreshes the tables with the index when the TTL lapses, and seeds them current on restart', async () => {
    const path = join(tmpDir, `oe-ttl-${dbCounter++}.db`);
    const { requested } = serveCatalog();
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    await svc.load(1);
    expect(await stateOf(path)).toMatchObject({ status: 'complete' });
    expect(await check(svc, requested)).toEqual([]);
    await svc.shutdown();

    const restarted = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    expect(await check(restarted, requested)).toEqual([]);
    vi.setSystemTime(T0 + 169 * HOUR);
    const lapsed = await check(restarted, requested);
    expect(lapsed).toEqual(expect.arrayContaining([...OE_FILES, 'jt.series']));
    await restarted.shutdown();
  });

  it('retries the tables at the first check after a restart when none are stored', async () => {
    const path = join(tmpDir, `oe-restart-${dbCounter++}.db`);
    const { requested, failing } = serveCatalog();
    failing.add('oe.datatype');
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    await svc.load(1); // every survey succeeds, so the state is complete; the tables fail
    expect(await stateOf(path)).toMatchObject({ status: 'complete' });
    expect(svc.storedOewsTables).toBeUndefined();
    await svc.shutdown();

    failing.clear();
    const restarted = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    expect((await check(restarted, requested)).sort()).toEqual([...OE_FILES].sort());
    expect(restarted.storedOewsTables).toBeDefined();
    await restarted.shutdown();
  });
});

describe('BlsCatalogService.searchCoverage (#121)', () => {
  const ROWS: CatalogSeries[] = [
    { seriesId: 'CES0000000001', title: 'All employees', surveyAbbr: 'CE', seasonal: true },
    { seriesId: 'CES0500000001', title: 'Total private', surveyAbbr: 'CE', seasonal: true },
    { seriesId: 'CUUR0000SA0', title: 'All items', surveyAbbr: 'CU', seasonal: false },
    { seriesId: 'LNS14000000', title: 'Unemployment rate', surveyAbbr: 'LN', seasonal: true },
  ];

  /**
   * An index holding `rows` whose stored harvest is incomplete, so the first
   * check retries everything: LABSTAT serves `files` and 404s the rest.
   */
  async function loadWith(rows: CatalogSeries[], files: Record<string, string>) {
    const path = join(tmpDir, `coverage-${dbCounter++}.db`);
    const store = createCatalogStore(path);
    await store.applyBatch(rows.map(toMirrorRow), []);
    await store.writeState({ status: 'error', total: rows.length });
    await store.close();
    const served = serveLabstat(files);
    const svc = new BlsCatalogService(LABSTAT_URL, 'ua/1.0', path, 168, false);
    await svc.load(1);
    return { svc, path, ...served };
  }

  it('marks indexed surveys with their counts, OE composed, and every other survey none', async () => {
    const { svc } = await loadWith(ROWS, OE_TABLE_FILES);
    expect(svc.searchCoverage('CE')).toEqual({ searchCoverage: 'indexed', seriesIndexed: 2 });
    expect(svc.searchCoverage('cu')).toEqual({ searchCoverage: 'indexed', seriesIndexed: 1 });
    expect(svc.searchCoverage('LN')).toEqual({ searchCoverage: 'indexed', seriesIndexed: 1 });
    expect(svc.searchCoverage('OE')).toEqual({ searchCoverage: 'composed' });
    expect(svc.searchCoverage('EN')).toEqual({ searchCoverage: 'none' });
    await svc.shutdown();
  });

  it('marks OE none while no tables are stored', async () => {
    const { svc } = await loadWith(ROWS, {});
    expect(svc.searchCoverage('OE')).toEqual({ searchCoverage: 'none' });
    await svc.shutdown();
  });

  it('reports nothing before the first load completes', async () => {
    serveLabstat({});
    const svc = new BlsCatalogService(
      LABSTAT_URL,
      'ua/1.0',
      join(tmpDir, `cold-${dbCounter++}.db`),
    );
    expect(svc.searchCoverage('CE')).toBeUndefined();
    const loading = svc.load(1);
    expect(svc.searchCoverage('CE')).toBeUndefined();
    await loading;
    await svc.shutdown();
  });

  it('marks every survey none, OE included, over a loaded but empty index', async () => {
    const { svc } = await harvestFrom(OE_TABLE_FILES);
    expect(svc.readiness.status).toBe('unavailable');
    expect(svc.searchCoverage('OE')).toEqual({ searchCoverage: 'none' });
    expect(svc.searchCoverage('CE')).toEqual({ searchCoverage: 'none' });
    await svc.shutdown();
  });

  it('keeps a failed survey indexed with its stored count, and updates counts after a harvest', async () => {
    const { svc } = await loadWith(ROWS, { ...OE_TABLE_FILES, ...JT_FILES });
    // CE's refresh 404ed: its two stored rows remain, and JT's harvest added eleven.
    expect(svc.searchCoverage('CE')).toEqual({ searchCoverage: 'indexed', seriesIndexed: 2 });
    expect(svc.searchCoverage('JT')).toEqual({ searchCoverage: 'indexed', seriesIndexed: 11 });
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'JT', 'LN']);
    await svc.shutdown();
  });

  it('reads cached counts: a call runs no catalog query', async () => {
    const { svc } = await loadWith(ROWS, OE_TABLE_FILES);
    const store = (svc as unknown as { store: ReturnType<typeof createCatalogStore> }).store;
    const spies = (['raw', 'count', 'query', 'getByIds', 'readState'] as const).map((m) =>
      vi.spyOn(store, m),
    );
    for (const abbr of ['CE', 'OE', 'EN', 'JT']) svc.searchCoverage(abbr);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    await svc.shutdown();
  });
});

describe('unpublishedOewsHint (#119)', () => {
  const METRO = 'OEUM004266000000029114103';
  const LEAD = 'BLS leaves many OEWS occupation–area cells unpublished; request';
  const TAIL = 'for the same occupation and data type.';

  /** Initialize the catalog singleton over a fresh index harvested from `files`. */
  async function initFrom(files: Record<string, string>): Promise<void> {
    vi.stubEnv('BLS_CATALOG_DB_PATH', join(tmpDir, `hint-${dbCounter++}.db`));
    resetServerConfig();
    serveLabstat(files);
    initBlsCatalogService({} as AppConfig, {} as StorageService);
    await getBlsCatalogService().load(1);
  }

  afterEach(async () => {
    await shutdownBlsCatalogService();
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('names the national row alone while the catalog is not initialized', () => {
    expect(unpublishedOewsHint(METRO)).toBe(
      `${LEAD} the national row OEUN000000000000029114103 ${TAIL}`,
    );
  });

  it('names the state row, then the national row, once the catalog stores the OE code tables', async () => {
    await initFrom({ ...JT_FILES, ...OE_TABLE_FILES });
    expect(unpublishedOewsHint(METRO)).toBe(
      `${LEAD} the state row OEUS530000000000029114103 or the national row OEUN000000000000029114103 ${TAIL}`,
    );
  });

  it('names the national row alone when the initialized catalog stores no tables', async () => {
    await initFrom(JT_FILES);
    expect(getBlsCatalogService().storedOewsTables).toBeUndefined();
    expect(unpublishedOewsHint(METRO)).toBe(
      `${LEAD} the national row OEUN000000000000029114103 ${TAIL}`,
    );
  });

  it('has none for a national OEWS ID, a subnational-only data type at state level, or another survey', () => {
    expect(unpublishedOewsHint('OEUN000000000000029114103')).toBeUndefined();
    expect(unpublishedOewsHint('OEUS530000000000029114116')).toBeUndefined();
    expect(unpublishedOewsHint('LNS14000000')).toBeUndefined();
  });
});
