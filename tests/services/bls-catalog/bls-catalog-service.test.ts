/**
 * @fileoverview Tests for BlsCatalogService — search logic, not-loaded guard, and UA header.
 * @module tests/services/bls-catalog/bls-catalog-service.test
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';

function makeService(entries: CatalogSeries[]): BlsCatalogService {
  const svc = new BlsCatalogService('http://unused', 'test-ua/1.0');
  // @ts-expect-error - directly populating internal state for tests
  svc.index = entries;
  // @ts-expect-error
  svc.loaded = true;
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

describe('BlsCatalogService.load', () => {
  it('sends the configured User-Agent on catalog fetches', async () => {
    const ua = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';
    const capturedHeaders: HeadersInit[] = [];

    // Minimal series file: header + one data row
    const seriesText = 'series_id\ttitle\tseasonal\nLNS14000000\tUnemployment Rate\tS\n';
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.headers) capturedHeaders.push(init.headers as HeadersInit);
      return Promise.resolve(new Response(seriesText, { status: 200 }));
    });

    const svc = new BlsCatalogService('https://download.bls.gov/pub/time.series', ua);
    await svc.load(1);

    expect(capturedHeaders.length).toBeGreaterThan(0);
    for (const h of capturedHeaders) {
      expect((h as Record<string, string>)['User-Agent']).toBe(ua);
    }
    vi.restoreAllMocks();
  });
});

describe('BlsCatalogService.search', () => {
  it('throws internalError when catalog is not loaded', () => {
    const svc = new BlsCatalogService('http://unused', 'test-ua/1.0');
    expect(() =>
      svc.search({
        query: 'unemployment',
        survey: undefined,
        area: undefined,
        seasonal_adjustment: undefined,
        limit: 10,
      }),
    ).toThrow();
  });

  it('returns exact match on seriesId query', () => {
    const svc = makeService(FIXTURES);
    const result = svc.search({
      query: 'TEST_UNEMP_001',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series[0]!.seriesId).toBe('TEST_UNEMP_001');
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by survey abbreviation', () => {
    const svc = makeService(FIXTURES);
    const result = svc.search({
      query: 'all',
      survey: 'CU',
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.every((s) => s.surveyAbbr === 'CU')).toBe(true);
  });

  it('filters by seasonal adjustment flag', () => {
    const svc = makeService(FIXTURES);
    const nsa = svc.search({
      query: 'CPI',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: false,
      limit: 10,
    });
    expect(nsa.series.every((s) => !s.seasonal)).toBe(true);
  });

  it('respects the limit', () => {
    const many: CatalogSeries[] = Array.from({ length: 20 }, (_, i) => ({
      seriesId: `MANYTEST${String(i).padStart(3, '0')}`,
      title: `Series ${i} unemployment data`,
      surveyAbbr: 'LN',
      seasonal: true,
    }));
    const svc = makeService(many);
    const result = svc.search({
      query: 'unemployment',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 5,
    });
    expect(result.series.length).toBeLessThanOrEqual(5);
    expect(result.total).toBeGreaterThan(5);
  });

  it('returns empty series when nothing matches', () => {
    const svc = makeService(FIXTURES);
    const result = svc.search({
      query: 'zzznomatchzzz',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('filters by area name', () => {
    const svc = makeService(FIXTURES);
    const result = svc.search({
      query: 'unemployment',
      survey: undefined,
      area: 'United States',
      seasonal_adjustment: undefined,
      limit: 10,
    });
    // Only TEST_UNEMP_001 has areaName 'United States'
    expect(result.series.every((s) => s.areaName?.toLowerCase().includes('united states'))).toBe(
      true,
    );
  });

  it('area filter produces zero results when no entries match', () => {
    const svc = makeService(FIXTURES);
    const result = svc.search({
      query: 'unemployment',
      survey: undefined,
      area: 'zzznomatchregion',
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('combines survey + seasonal filters correctly', () => {
    const svc = makeService(FIXTURES);
    // CU survey + not seasonally adjusted
    const result = svc.search({
      query: 'cpi',
      survey: 'CU',
      area: undefined,
      seasonal_adjustment: false,
      limit: 10,
    });
    expect(result.series.every((s) => s.surveyAbbr === 'CU' && !s.seasonal)).toBe(true);
  });

  it('scores common series higher than generic matches for known IDs', () => {
    // Add a common series and a non-common series with the same title keyword
    const withCommon: typeof FIXTURES = [
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
    const svc = makeService(withCommon);
    const result = svc.search({
      query: 'unemployment rate',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    // LNS14000000 should appear first due to COMMON_SERIES boost
    expect(result.series[0]!.seriesId).toBe('LNS14000000');
  });

  it('isLoaded reflects the internal state', () => {
    const unloaded = new BlsCatalogService('http://unused', 'test-ua/1.0');
    expect(unloaded.isLoaded).toBe(false);

    const loaded = makeService(FIXTURES);
    expect(loaded.isLoaded).toBe(true);
  });

  it('totalSeries reflects index length', () => {
    const svc = makeService(FIXTURES);
    expect(svc.totalSeries).toBe(FIXTURES.length);
  });

  it('catalogLoadError is undefined when loaded successfully', () => {
    const svc = makeService(FIXTURES);
    expect(svc.catalogLoadError).toBeUndefined();
  });
});

describe('BlsCatalogService cache (#32)', () => {
  const BASE_URL = 'https://download.bls.gov/pub/time.series';
  const SERIES_TEXT = 'series_id\ttitle\tseasonal\nLNS14000000\tUnemployment Rate\tS\n';
  let cacheDir: string;
  let cachePath: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'bls-cache-'));
    cachePath = join(cacheDir, 'catalog.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('persists the catalog after a live load and serves it on the next boot without re-fetching', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(SERIES_TEXT, { status: 200 })));

    // Cold boot: fetches live, writes the cache.
    const first = new BlsCatalogService(BASE_URL, 'ua/1.0', cachePath, 168);
    await first.load(1);
    expect(first.isLoaded).toBe(true);
    expect(first.totalSeries).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);

    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      version: number;
      series: unknown[];
    };
    expect(cached.version).toBe(1);
    expect(Array.isArray(cached.series)).toBe(true);

    // Warm boot: a fresh instance on the same path loads from cache, no network.
    fetchSpy.mockClear();
    const second = new BlsCatalogService(BASE_URL, 'ua/1.0', cachePath, 168);
    await second.load(1);
    expect(second.isLoaded).toBe(true);
    expect(second.totalSeries).toBe(first.totalSeries);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-fetches live when the cache is older than the TTL', async () => {
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now() - 200 * 3_600_000, // 200 h old, beyond a 168 h TTL
        series: [{ seriesId: 'STALE000', title: 'Stale', surveyAbbr: 'LN', seasonal: false }],
      }),
      'utf8',
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(SERIES_TEXT, { status: 200 })));

    const svc = new BlsCatalogService(BASE_URL, 'ua/1.0', cachePath, 168);
    await svc.load(1);

    expect(fetchSpy).toHaveBeenCalled();
    const result = svc.search({
      query: 'STALE000',
      survey: undefined,
      area: undefined,
      seasonal_adjustment: undefined,
      limit: 10,
    });
    expect(result.series.find((s) => s.seriesId === 'STALE000')).toBeUndefined();
  });

  it('falls back to a live fetch when the cache file is corrupt', async () => {
    await writeFile(cachePath, '{ not valid json', 'utf8');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(SERIES_TEXT, { status: 200 })));

    const svc = new BlsCatalogService(BASE_URL, 'ua/1.0', cachePath, 168);
    await svc.load(1);

    expect(fetchSpy).toHaveBeenCalled();
    expect(svc.isLoaded).toBe(true);
    expect(svc.totalSeries).toBeGreaterThan(0);
  });

  it('skips cache I/O entirely when cachePath is empty', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(SERIES_TEXT, { status: 200 })));

    const svc = new BlsCatalogService(BASE_URL, 'ua/1.0', '', 168);
    await svc.load(1);

    expect(fetchSpy).toHaveBeenCalled();
    expect(svc.isLoaded).toBe(true);
  });
});
