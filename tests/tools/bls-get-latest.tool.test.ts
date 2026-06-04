/**
 * @fileoverview Tests for bls_get_latest tool.
 * @module tests/tools/bls-get-latest.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blsGetLatestTool } from '@/mcp-server/tools/definitions/bls-get-latest.tool.js';
import type { SeriesData } from '@/services/bls-api/types.js';

const MOCK_SERIES: SeriesData = {
  seriesId: 'LNS14000000',
  title: 'Unemployment Rate',
  area: 'U.S.',
  item: 'Unemployment rate',
  seasonal: 'Seasonally Adjusted',
  observations: [{ year: '2024', period: 'M12', periodName: 'December', value: '4.1' }],
};

const fetchLatestMock = vi.fn();

vi.mock('@/services/bls-api/bls-api-service.js', () => ({
  getBlsApiService: () => ({ fetchLatest: fetchLatestMock }),
}));

describe('blsGetLatestTool', () => {
  it('returns latest observations for valid series with no notice', async () => {
    fetchLatestMock.mockResolvedValue(MOCK_SERIES);

    const ctx = createMockContext();
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.results[0]!.seriesId).toBe('LNS14000000');
    expect(result.results[0]!.latestObservation?.value).toBe('4.1');

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeUndefined();
  });

  it('records failed series and enriches with notice', async () => {
    fetchLatestMock.mockRejectedValue(new Error('series_not_found'));

    const ctx = createMockContext();
    const input = blsGetLatestTool.input.parse({ series_ids: ['INVALID000'] });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('INVALID000');
    expect(result.failed[0]!.error).toContain('series_not_found');

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.notice).toContain('bls_search_series');
  });

  it('handles sparse upstream payload — no observations goes to failed', async () => {
    const sparse: SeriesData = { seriesId: 'LNS14000000', observations: [] };
    fetchLatestMock.mockResolvedValue(sparse);

    const ctx = createMockContext();
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('LNS14000000');
    expect(result.failed[0]!.error).toContain('No observations returned');
  });

  it('formats output with period code and item fields', () => {
    const output = {
      results: [
        {
          seriesId: 'LNS14000000',
          title: 'Unemployment Rate',
          area: 'U.S.',
          item: 'Unemployment rate',
          seasonal: 'Seasonally Adjusted',
          latestObservation: {
            year: '2024',
            period: 'M12',
            periodName: 'December',
            value: '4.1',
          },
        },
      ],
      succeeded: 1,
      failed: [],
    };
    const blocks = blsGetLatestTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('LNS14000000');
    expect(text).toContain('4.1');
    expect(text).toContain('M12');
    expect(text).toContain('Item:');
  });
});

describe('blsGetLatestTool — additional coverage', () => {
  beforeEach(() => {
    fetchLatestMock.mockReset();
  });

  it('rethrows quota_exceeded error (affects all series)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchLatestMock.mockRejectedValue(
      serviceUnavailable('quota exceeded', { reason: 'quota_exceeded' }),
    );

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetLatestTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded' },
    });
  });

  it('rethrows series_locked error (affects all series)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchLatestMock.mockRejectedValue(serviceUnavailable('locked', { reason: 'series_locked' }));

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetLatestTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'series_locked' },
    });
  });

  it('handles mixed success and failure across multiple series', async () => {
    fetchLatestMock
      .mockResolvedValueOnce(MOCK_SERIES)
      .mockRejectedValueOnce(new Error('series_not_found'));

    const ctx = createMockContext();
    const input = blsGetLatestTool.input.parse({
      series_ids: ['LNS14000000', 'INVALID000'],
    });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('INVALID000');
    // results must mirror request order: results[0] = LNS14000000, results[1] = INVALID000
    expect(result.results[0]!.seriesId).toBe('LNS14000000');
    expect(result.results[0]!.latestObservation).toBeDefined();
    expect(result.results[1]!.seriesId).toBe('INVALID000');
    expect(result.results[1]!.latestObservation).toBeUndefined();

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.notice).toContain('bls_search_series');
  });

  it('preserves request order when invalid series precedes valid series', async () => {
    // Regression: previously results were [...succeeded, ...failed], so a failed[0] would
    // appear at results[1] instead of results[0]. This test puts the invalid ID first.
    fetchLatestMock
      .mockRejectedValueOnce(new Error('Series does not exist'))
      .mockResolvedValueOnce(MOCK_SERIES);

    const ctx = createMockContext();
    const input = blsGetLatestTool.input.parse({
      series_ids: ['ZZZZZZZ_INVALID', 'LNS14000000'],
    });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('ZZZZZZZ_INVALID');
    // results[0] must be the invalid (first requested), results[1] the valid (second requested)
    expect(result.results[0]!.seriesId).toBe('ZZZZZZZ_INVALID');
    expect(result.results[0]!.latestObservation).toBeUndefined();
    expect(result.results[1]!.seriesId).toBe('LNS14000000');
    expect(result.results[1]!.latestObservation?.value).toBe('4.1');
  });

  it('rejects empty series_ids array', () => {
    expect(() => blsGetLatestTool.input.parse({ series_ids: [] })).toThrow();
  });

  it('rejects series_ids array with more than 50 entries', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ID${i}`);
    expect(() => blsGetLatestTool.input.parse({ series_ids: ids })).toThrow();
  });

  it('formats output with failed series listed', () => {
    const output = {
      results: [
        { seriesId: 'LNS14000000' }, // succeeded but no latestObservation — format skips it
        { seriesId: 'INVALID000' },
      ],
      succeeded: 0,
      failed: [{ seriesId: 'INVALID000', error: 'series_not_found' }],
    };
    const blocks = blsGetLatestTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('failed');
    expect(text).toContain('INVALID000');
    expect(text).toContain('series_not_found');
  });

  it('formats output with footnotes when present', () => {
    const output = {
      results: [
        {
          seriesId: 'LNS14000000',
          latestObservation: {
            year: '2024',
            period: 'M12',
            value: '4.1',
            footnotes: ['P: Preliminary'],
          },
        },
      ],
      succeeded: 1,
      failed: [],
    };
    const blocks = blsGetLatestTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Preliminary');
  });

  it('formats output with periodName when present', () => {
    const output = {
      results: [
        {
          seriesId: 'LNS14000000',
          latestObservation: {
            year: '2024',
            period: 'M12',
            periodName: 'December',
            value: '4.1',
          },
        },
      ],
      succeeded: 1,
      failed: [],
    };
    const blocks = blsGetLatestTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // With periodName, format should show "December 2024"
    expect(text).toContain('December 2024');
  });
});
