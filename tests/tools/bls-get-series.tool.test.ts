/**
 * @fileoverview Tests for bls_get_series tool.
 * @module tests/tools/bls-get-series.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { blsGetSeriesTool } from '@/mcp-server/tools/definitions/bls-get-series.tool.js';
import type { SeriesData } from '@/services/bls-api/types.js';

const MOCK_SERIES: SeriesData = {
  seriesId: 'LNS14000000',
  title: 'Unemployment Rate',
  area: 'U.S.',
  item: 'Unemployment rate',
  seasonal: 'Seasonally Adjusted',
  observations: [
    { year: '2024', period: 'M12', periodName: 'December', value: '4.1' },
    { year: '2024', period: 'M11', periodName: 'November', value: '4.2' },
  ],
};

const fetchSeriesMock = vi.fn();

vi.mock('@/services/bls-api/bls-api-service.js', () => ({
  getBlsApiService: () => ({ fetchSeries: fetchSeriesMock }),
}));

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => undefined,
  toDatasetField: vi.fn(),
}));

describe('blsGetSeriesTool', () => {
  it('returns inline series data within budget and enriches with total observations', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);

    expect(result.spilled).toBe(false);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.seriesId).toBe('LNS14000000');
    expect(result.series[0]!.observations).toHaveLength(2);
    expect(result.series[0]!.observations[0]!.value).toBe('4.1');

    const enriched = getEnrichment(ctx);
    expect(enriched.totalObservations).toBe(2);
    expect(enriched.notice).toBeUndefined();
    // echo: request params, none of the optional ones passed (#30)
    expect(enriched.seriesRequested).toBe(1);
    expect(enriched.startYearApplied).toBeUndefined();
    expect(enriched.endYearApplied).toBeUndefined();
    expect(enriched.calculationsApplied).toBeUndefined();
  });

  it('echoes requested params (series count, year range, calculations) in enrichment', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000', 'CES0000000001'],
      start_year: 2020,
      end_year: 2024,
      calculations: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.seriesRequested).toBe(2);
    expect(enriched.startYearApplied).toBe(2020);
    expect(enriched.endYearApplied).toBe(2024);
    expect(enriched.calculationsApplied).toBe(true);
  });

  it('throws on service error (quota_exceeded)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSeriesMock.mockRejectedValue(serviceUnavailable('quota', { reason: 'quota_exceeded' }));

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded' },
    });
  });

  it('passes calculations flag only when set', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000'],
      calculations: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(fetchSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ calculations: true }),
      ctx,
    );
  });

  it('returns percent-change-only calculations without error for partially-supported surveys (#37)', async () => {
    // CPI (survey CU) has allowsNetChange:false, allowsPercentChange:true — the API
    // returns only the percent-change fields, gracefully, with no error.
    const pctOnly: SeriesData = {
      seriesId: 'CUUR0000SA0',
      title: 'CPI-U All Items',
      observations: [
        {
          year: '2026',
          period: 'M04',
          periodName: 'April',
          value: '333.0',
          pctChange1Month: '0.2',
          pctChange12Month: '3.8',
        },
      ],
    };
    fetchSeriesMock.mockResolvedValue([pctOnly]);

    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CUUR0000SA0'],
      calculations: true,
    });
    const result = await blsGetSeriesTool.handler(input, ctx);

    const obs = result.series[0]!.observations[0]!;
    expect(obs.pctChange1Month).toBe('0.2');
    expect(obs.pctChange12Month).toBe('3.8');
    expect(obs.netChange1Month).toBeUndefined();
    expect(obs.netChange12Month).toBeUndefined();
    expect(getEnrichment(ctx).calculationsApplied).toBe(true);
  });

  it('handles sparse upstream payload — series with no observations', async () => {
    const sparse: SeriesData = { seriesId: 'SPARSE000', observations: [] };
    fetchSeriesMock.mockResolvedValue([sparse]);

    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({ series_ids: ['SPARSE000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);

    expect(result.series[0]!.observationCount).toBe(0);
    expect(result.series[0]!.observations).toHaveLength(0);
  });

  it('formats output with period code column', () => {
    const output = {
      series: [
        {
          seriesId: 'LNS14000000',
          title: 'Unemployment Rate',
          observationCount: 1,
          observations: [{ year: '2024', period: 'M12', periodName: 'December', value: '4.1' }],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('LNS14000000');
    expect(text).toContain('M12');
    expect(text).toContain('4.1');
  });

  it('formats spilled output with truncated flag', () => {
    const output = {
      series: [
        {
          seriesId: 'LNS14000000',
          observationCount: 100,
          observations: [{ year: '2024', period: 'M12', value: '4.1' }],
        },
      ],
      dataset: {
        name: 'df_AAAAA_BBBBB',
        row_count: 100,
        expires_at: '2026-05-22T00:00:00.000Z',
        truncated: true,
      },
      spilled: true as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_AAAAA_BBBBB');
    expect(text).toContain('truncated');
  });

  it('throws no_data_for_period when start_year > end_year', async () => {
    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000'],
      start_year: 2024,
      end_year: 2020,
    });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data_for_period' },
    });
  });

  it('throws no_data_for_period when year range spans 20+ years', async () => {
    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000'],
      start_year: 2000,
      end_year: 2024, // 25-year range
    });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data_for_period' },
    });
  });

  it('accepts exactly 19-year range without throwing validation error', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);
    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000'],
      start_year: 2005,
      end_year: 2023, // 19-year range — within 20-year cap
    });

    await expect(blsGetSeriesTool.handler(input, ctx)).resolves.toBeDefined();
  });

  it('rejects empty series_ids array', () => {
    expect(() => blsGetSeriesTool.input.parse({ series_ids: [] })).toThrow();
  });

  it('rejects series_ids array with more than 50 entries', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `LNS${String(i).padStart(8, '0')}`);
    expect(() => blsGetSeriesTool.input.parse({ series_ids: ids })).toThrow();
  });

  it('passes quota_exceeded error from service through unchanged', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSeriesMock.mockRejectedValue(serviceUnavailable('quota', { reason: 'quota_exceeded' }));

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded' },
    });
  });

  it('formats observations with calculation columns when present', () => {
    const output = {
      series: [
        {
          seriesId: 'LNS14000000',
          title: 'Unemployment Rate',
          observationCount: 1,
          observations: [
            {
              year: '2024',
              period: 'M12',
              periodName: 'December',
              value: '4.1',
              netChange1Month: '-0.1',
              netChange12Month: '-0.3',
              pctChange1Month: '-2.4',
              pctChange12Month: '-6.8',
            },
          ],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Net 1M');
    expect(text).toContain('-0.1');
    expect(text).toContain('-0.3');
  });

  it('formats observations with footnotes', () => {
    const output = {
      series: [
        {
          seriesId: 'LNS14000000',
          observationCount: 1,
          observations: [
            {
              year: '2024',
              period: 'M12',
              value: '4.1',
              footnotes: ['P: Preliminary'],
            },
          ],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Preliminary');
  });

  it('formats series with no observations with a helpful message', () => {
    const output = {
      series: [
        {
          seriesId: 'NODATA000',
          observationCount: 0,
          observations: [],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No observations');
    expect(text).toContain('bls_search_series');
  });

  // Security: verify API key never appears in tool output
  it('does not include API key or env values in output', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);
    const ctx = createMockContext();
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    // process.env.BLS_API_KEY is typically empty/undefined in tests — confirm no secret leakage pattern
    expect(serialized).not.toMatch(/registrationkey/i);
    expect(serialized).not.toMatch(/apikey/i);
  });
});
