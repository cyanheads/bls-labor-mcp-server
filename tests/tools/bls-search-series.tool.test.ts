/**
 * @fileoverview Tests for bls_search_series tool.
 * @module tests/tools/bls-search-series.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blsSearchSeriesTool } from '@/mcp-server/tools/definitions/bls-search-series.tool.js';

const MOCK_SERIES = [
  {
    seriesId: 'LNS14000000',
    title: 'Unemployment Rate',
    surveyAbbr: 'LN',
    seasonal: true,
    areaName: 'United States',
  },
];

const mockSearch = vi.fn().mockResolvedValue({ series: MOCK_SERIES, total: 1, capped: false });
let mockIsLoaded = true;
let mockTotalSeries = 847000;
let mockCatalogLoadError: string | undefined;

vi.mock('@/services/bls-catalog/bls-catalog-service.js', () => ({
  getBlsCatalogService: () => ({
    get isLoaded() {
      return mockIsLoaded;
    },
    get totalSeries() {
      return mockTotalSeries;
    },
    get catalogLoadError() {
      return mockCatalogLoadError;
    },
    search: mockSearch,
  }),
}));

describe('blsSearchSeriesTool', () => {
  it('throws catalog_unavailable when catalog is not loaded', async () => {
    mockIsLoaded = false;
    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'unemployment' });

    await expect(blsSearchSeriesTool.handler(input, ctx)).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'catalog_unavailable' }) }),
    );
    mockIsLoaded = true;
  });

  it('returns series from catalog on happy path and enriches with totals', async () => {
    mockIsLoaded = true;
    mockSearch.mockResolvedValueOnce({ series: MOCK_SERIES, total: 1, capped: false });
    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'unemployment', limit: 5 });
    const result = await blsSearchSeriesTool.handler(input, ctx);

    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.seriesId).toBe('LNS14000000');

    const enriched = getEnrichment(ctx);
    expect(enriched.totalCount).toBe(1);
    expect(enriched.capped).toBe(false);
    expect(enriched.truncated).toBeUndefined();
    expect(enriched.catalogSize).toBe(847000);
    expect(enriched.notice).toBeUndefined();
    // echo: query + applied limit, no filters passed (#29)
    expect(enriched.effectiveQuery).toBe('unemployment');
    expect(enriched.limitApplied).toBe(5);
    expect(enriched.surveyFilter).toBeUndefined();
    expect(enriched.areaFilter).toBeUndefined();
    expect(enriched.seasonalFilter).toBeUndefined();
  });

  it('enriches capped=true when the FTS candidate pool hit the internal cap (#40)', async () => {
    mockIsLoaded = true;
    mockSearch.mockResolvedValueOnce({ series: MOCK_SERIES, total: 1000, capped: true });
    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'employment', limit: 10 });
    await blsSearchSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.capped).toBe(true);
    expect(enriched.totalCount).toBe(1000);
    // total (1000) exceeds the returned list — truncation disclosed
    expect(enriched.truncated).toBe(true);
    expect(enriched.cap).toBe(10);
  });

  it('echoes applied survey/area/seasonal filters in enrichment', async () => {
    mockSearch.mockResolvedValueOnce({ series: MOCK_SERIES, total: 1, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({
      query: 'nonfarm',
      survey: 'CE',
      area: 'United States',
      seasonal_adjustment: true,
      limit: 25,
    });
    await blsSearchSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.effectiveQuery).toBe('nonfarm');
    expect(enriched.surveyFilter).toBe('CE');
    expect(enriched.areaFilter).toBe('United States');
    expect(enriched.seasonalFilter).toBe(true);
    expect(enriched.limitApplied).toBe(25);
  });

  it('enriches with notice when no series match', async () => {
    mockSearch.mockResolvedValueOnce({ series: [], total: 0, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'zzznotasurvey', limit: 5 });
    await blsSearchSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.totalCount).toBe(0);
  });

  it('formats output including seasonal field', () => {
    const output = {
      series: [
        {
          seriesId: 'LNS14000000',
          title: 'Unemployment Rate',
          survey: 'LN',
          seasonal: 'Seasonally Adjusted',
        },
      ],
    };
    const blocks = blsSearchSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('LNS14000000');
    expect(text).toContain('Seasonally Adjusted');
  });

  it('renders no-results message when series is empty', () => {
    const output = { series: [] };
    const blocks = blsSearchSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No matching series');
  });
});

describe('blsSearchSeriesTool — additional coverage', () => {
  beforeEach(() => {
    mockIsLoaded = true;
    mockTotalSeries = 847000;
    mockCatalogLoadError = undefined;
    mockSearch.mockResolvedValue({ series: MOCK_SERIES, total: 1, capped: false });
  });

  it('throws catalog_unavailable when catalog loaded but empty (totalSeries === 0)', async () => {
    mockIsLoaded = true;
    mockTotalSeries = 0;
    mockCatalogLoadError = 'All LABSTAT downloads returned empty.';

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'unemployment' });

    await expect(blsSearchSeriesTool.handler(input, ctx)).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'catalog_unavailable' }) }),
    );
  });

  it('enriches with filter-specific notice when no results and filters are active', async () => {
    mockSearch.mockResolvedValueOnce({ series: [], total: 0, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({
      query: 'nonfarm',
      survey: 'CE',
      seasonal_adjustment: true,
    });
    await blsSearchSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    // Filter-specific notice mentions removing filters
    expect(enriched.notice).toContain('filter');
  });

  it('returns area and item when present in catalog entry (renamed from areaName/itemName)', async () => {
    const seriesWithCodes = [
      {
        seriesId: 'CU0000SA0',
        title: 'CPI-U All Items',
        surveyAbbr: 'CU',
        seasonal: true,
        areaName: 'U.S. city average',
        itemName: 'All items',
      },
    ];
    mockSearch.mockResolvedValueOnce({ series: seriesWithCodes, total: 1, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'CPI all items' });
    const result = await blsSearchSeriesTool.handler(input, ctx);

    // Output now uses area/item (aligned with data-tool shape), not areaName/itemName.
    expect(result.series[0]!.area).toBe('U.S. city average');
    expect(result.series[0]!.item).toBe('All items');
    expect(result.series[0]!.seasonal).toBe('Seasonally Adjusted');
  });

  it('omits area/item from output when absent in catalog entry', async () => {
    // Return a series with no areaName/itemName from the catalog
    const seriesNoArea = [
      {
        seriesId: 'TEST_PLAIN_001',
        title: 'Unemployment Rate',
        surveyAbbr: 'LN',
        seasonal: true,
        // no areaName, no itemName
      },
    ];
    mockSearch.mockResolvedValueOnce({ series: seriesNoArea, total: 1, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: 'unemployment' });
    const result = await blsSearchSeriesTool.handler(input, ctx);

    // Output uses area/item (not areaName/itemName).
    expect('area' in (result.series[0] ?? {})).toBe(false);
    expect('item' in (result.series[0] ?? {})).toBe(false);
    // seasonal is always present as a string descriptor.
    expect(result.series[0]!.seasonal).toBe('Seasonally Adjusted');
  });

  it('rejects blank query string', () => {
    expect(() => blsSearchSeriesTool.input.parse({ query: '   ' })).toThrow();
  });

  it('rejects empty query string', () => {
    expect(() => blsSearchSeriesTool.input.parse({ query: '' })).toThrow();
  });

  it('rejects limit below 1', () => {
    expect(() => blsSearchSeriesTool.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('rejects limit above 50', () => {
    expect(() => blsSearchSeriesTool.input.parse({ query: 'test', limit: 51 })).toThrow();
  });

  it('formats output with item when present (renamed from itemName)', () => {
    const output = {
      series: [
        {
          seriesId: 'CU0000SA0',
          title: 'CPI-U All Items',
          survey: 'CU',
          seasonal: 'Seasonally Adjusted',
          item: 'All items',
        },
      ],
    };
    const blocks = blsSearchSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('All items');
  });

  // Security: oversized query should not crash the handler
  it('handles very long query string without throwing', async () => {
    const longQuery = 'a'.repeat(500);
    mockSearch.mockResolvedValueOnce({ series: [], total: 0, capped: false });
    mockIsLoaded = true;

    const ctx = createMockContext({ errors: blsSearchSeriesTool.errors });
    const input = blsSearchSeriesTool.input.parse({ query: longQuery });
    await expect(blsSearchSeriesTool.handler(input, ctx)).resolves.toBeDefined();
  });
});
