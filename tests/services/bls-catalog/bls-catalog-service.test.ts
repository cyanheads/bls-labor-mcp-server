/**
 * @fileoverview Tests for BlsCatalogService — the on-disk SQLite catalog index:
 * FTS-backed search + bespoke rescore, OES gating, cold-load harvest, and the
 * not-loaded guard. Search tests seed a store at the same path/schema the service
 * opens (via the exported `createCatalogStore`), then load from it (warm path).
 * @module tests/services/bls-catalog/bls-catalog-service.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorRow } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlsCatalogService,
  createCatalogStore,
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

  it('sends the configured User-Agent and builds the index from a live harvest', async () => {
    const ua = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';
    const captured: HeadersInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.headers) captured.push(init.headers as HeadersInit);
      return Promise.resolve(new Response(SERIES_TEXT, { status: 200 }));
    });

    const dbPath = join(tmpDir, 'cold.db');
    const svc = new BlsCatalogService(BASE_URL, ua, dbPath, 168, false);
    await svc.load(1);

    expect(svc.isLoaded).toBe(true);
    expect(svc.totalSeries).toBeGreaterThan(0);
    expect(captured.length).toBeGreaterThan(0);
    for (const h of captured) {
      expect((h as Record<string, string>)['User-Agent']).toBe(ua);
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
});
