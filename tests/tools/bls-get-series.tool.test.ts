/**
 * @fileoverview Tests for bls_get_series tool.
 * @module tests/tools/bls-get-series.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The bridge is swappable per test: `undefined` models canvas being unconfigured,
 * an object models canvas configured — whose `registerDataframe` can resolve a
 * handle or throw. `toDatasetField` keeps its real shape so the spilled `dataset`
 * assertions exercise the actual mapping rather than a stub.
 */
const registerDataframeMock = vi.fn();
let canvasBridge: { registerDataframe: typeof registerDataframeMock } | undefined;

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => canvasBridge,
  toDatasetField: (r: { tableName: string; rowCount: number; expiresAt: string }) => ({
    name: r.tableName,
    row_count: r.rowCount,
    expires_at: r.expiresAt,
  }),
}));

/** Enough observations to push the inline JSON past INLINE_BUDGET_CHARS (100k). */
function bulkySeries(seriesId = 'LNS14000000'): SeriesData {
  return {
    seriesId,
    title: 'Unemployment Rate',
    observations: Array.from({ length: 900 }, (_, i) => ({
      year: String(2000 + Math.floor(i / 12)),
      period: `M${String((i % 12) + 1).padStart(2, '0')}`,
      periodName: 'December',
      value: String(4 + (i % 10) / 10),
      footnotes: ['P: Preliminary figure subject to revision in a later release'],
    })),
  };
}

describe('blsGetSeriesTool', () => {
  beforeEach(() => {
    canvasBridge = undefined;
    registerDataframeMock.mockReset();
  });

  it('returns inline series data within budget and enriches with total observations', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
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

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
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

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
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

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
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

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['SPARSE000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);

    expect(result.series[0]!.observationCount).toBe(0);
    expect(result.series[0]!.observations).toHaveLength(0);
    // The zero-obs series must be announced in structuredContent, not just format() (#45)
    expect(getEnrichment(ctx).notice).toContain('SPARSE000');
  });

  it('notices a zero-observation series and names it, on the non-spilled path (#45)', async () => {
    // The empty series is still present in series[], so series.length === seriesRequested
    // even though one series returned nothing — the notice is the only structured signal.
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES, { seriesId: 'NOTREAL999', observations: [] }]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000', 'NOTREAL999'],
    });
    const result = await blsGetSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(result.spilled).toBe(false);
    expect(result.series).toHaveLength(enriched.seriesRequested as number);
    expect(enriched.notice).toContain('NOTREAL999');
    expect(enriched.notice).toContain('bls_search_series');
    // The series that did return data must not be named as empty.
    expect(enriched.notice).not.toContain('LNS14000000');
  });

  it('notices a SeriesID the mirror omitted from series[] entirely (#45)', async () => {
    // The observations mirror groups by returned rows, so a series with no rows is
    // absent rather than present-and-empty. Reconciling against the requested IDs
    // catches that shape too.
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000', 'ABSENT001'],
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('ABSENT001');
  });

  it('points an empty ranged request at the year range as well as the SeriesID (#45)', async () => {
    fetchSeriesMock.mockResolvedValue([{ seriesId: 'ECS10001I', observations: [] }]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['ECS10001I'],
      start_year: 2023,
      end_year: 2024,
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toMatch(/start_year\/end_year/);
  });

  it('sets no notice when every requested series returned data', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    await blsGetSeriesTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
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
    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
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

  it('surfaces all four calculation intervals through the handler (#50)', async () => {
    const allIntervals: SeriesData = {
      seriesId: 'APU0000708111',
      title: 'Eggs, grade A, large, per doz.',
      observations: [
        {
          year: '2024',
          period: 'M12',
          periodName: 'December',
          value: '4.146',
          netChange1Month: '0.497',
          netChange3Month: '0.325',
          netChange6Month: '1.431',
          netChange12Month: '1.639',
          pctChange1Month: '13.6',
          pctChange3Month: '8.5',
          pctChange6Month: '52.7',
          pctChange12Month: '65.4',
        },
      ],
    };
    fetchSeriesMock.mockResolvedValue([allIntervals]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['APU0000708111'],
      calculations: true,
    });
    const result = await blsGetSeriesTool.handler(input, ctx);

    const obs = result.series[0]!.observations[0]!;
    expect(obs.netChange3Month).toBe('0.325');
    expect(obs.netChange6Month).toBe('1.431');
    expect(obs.pctChange3Month).toBe('8.5');
    expect(obs.pctChange6Month).toBe('52.7');
  });

  it('formats all four calculation intervals as table columns (#50)', () => {
    const output = {
      series: [
        {
          seriesId: 'APU0000708111',
          observationCount: 1,
          observations: [
            {
              year: '2024',
              period: 'M12',
              value: '4.146',
              netChange1Month: '0.497',
              netChange3Month: '0.325',
              netChange6Month: '1.431',
              netChange12Month: '1.639',
              pctChange1Month: '13.6',
              pctChange3Month: '8.5',
              pctChange6Month: '52.7',
              pctChange12Month: '65.4',
            },
          ],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;

    for (const header of ['Net 1M', 'Net 3M', 'Net 6M', 'Net 12M']) {
      expect(text).toContain(header);
    }
    for (const header of ['Pct 1M', 'Pct 3M', 'Pct 6M', 'Pct 12M']) {
      expect(text).toContain(header);
    }
    // The 3/6-month values must reach content[], not just structuredContent.
    expect(text).toContain('0.325');
    expect(text).toContain('1.431');
    expect(text).toContain('8.5');
    expect(text).toContain('52.7');
  });

  it('omits calculation columns the survey did not return (#50)', () => {
    // CPI returns percent change only — rendering empty Net columns would be noise.
    const output = {
      series: [
        {
          seriesId: 'CUUR0000SA0',
          observationCount: 1,
          observations: [
            {
              year: '2024',
              period: 'M12',
              value: '315.6',
              pctChange1Month: '0.0',
              pctChange12Month: '2.8',
            },
          ],
        },
      ],
      spilled: false as const,
    };
    const blocks = blsGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Pct 1M');
    expect(text).toContain('Pct 12M');
    expect(text).not.toContain('Net 1M');
    expect(text).not.toContain('Pct 3M');
    expect(text).not.toContain('Pct 6M');
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

  it('throws canvas_unavailable when the result spills and canvas is not configured', async () => {
    fetchSeriesMock.mockResolvedValue([bulkySeries()]);
    canvasBridge = undefined;

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('returns a dataset handle when the result spills and registration succeeds', async () => {
    fetchSeriesMock.mockResolvedValue([bulkySeries()]);
    registerDataframeMock.mockResolvedValue({
      tableName: 'df_AAAAA_BBBBB',
      rowCount: 900,
      expiresAt: '2026-07-18T00:00:00.000Z',
      columnSchema: [],
    });
    canvasBridge = { registerDataframe: registerDataframeMock };

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.dataset?.name).toBe('df_AAAAA_BBBBB');
    expect(result.dataset?.row_count).toBe(900);
    // Preview only inline, but the true count stays visible.
    expect(result.series[0]!.observations).toHaveLength(3);
    expect(result.series[0]!.observationCount).toBe(900);
    expect(getEnrichment(ctx).notice).toContain('df_AAAAA_BBBBB');
  });

  it('throws canvas_registration_failed when canvas is configured but registration fails (#46)', async () => {
    // Previously this returned isError:false with a 3-observation preview, no dataset
    // handle, and a notice pointing at a canvas table that was never created.
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSeriesMock.mockResolvedValue([bulkySeries()]);
    registerDataframeMock.mockRejectedValue(
      serviceUnavailable('registration blew up', { reason: 'canvas_registration_failed' }),
    );
    canvasBridge = { registerDataframe: registerDataframeMock };

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });

    await expect(blsGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_registration_failed' },
    });
  });

  it('composes the empty-series notice with the spill notice (#45, #46)', async () => {
    // ctx.enrich.notice is last-wins, so both signals must arrive as one string.
    fetchSeriesMock.mockResolvedValue([
      bulkySeries(),
      { seriesId: 'NOTREAL999', observations: [] },
    ]);
    registerDataframeMock.mockResolvedValue({
      tableName: 'df_CCCCC_DDDDD',
      rowCount: 900,
      expiresAt: '2026-07-18T00:00:00.000Z',
      columnSchema: [],
    });
    canvasBridge = { registerDataframe: registerDataframeMock };

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000', 'NOTREAL999'],
    });
    await blsGetSeriesTool.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('NOTREAL999');
    expect(notice).toContain('df_CCCCC_DDDDD');
  });

  // Security: verify API key never appears in tool output
  it('does not include API key or env values in output', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);
    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    // process.env.BLS_API_KEY is typically empty/undefined in tests — confirm no secret leakage pattern
    expect(serialized).not.toMatch(/registrationkey/i);
    expect(serialized).not.toMatch(/apikey/i);
  });
});

describe('blsGetSeriesTool — annual averages (#53)', () => {
  /** CPI over 2023–2024: 24 real monthly rows plus the two M13 rows BLS injects. */
  const CPI_WITH_M13: SeriesData = {
    seriesId: 'CUUR0000SA0',
    title: 'CPI-U All Items',
    observations: [
      { year: '2024', period: 'M13', periodName: 'Annual', value: '313.689' },
      { year: '2024', period: 'M12', periodName: 'December', value: '315.605' },
      { year: '2023', period: 'M13', periodName: 'Annual', value: '304.702' },
      { year: '2023', period: 'M12', periodName: 'December', value: '306.746' },
    ],
  };

  beforeEach(() => {
    canvasBridge = undefined;
    registerDataframeMock.mockReset();
    fetchSeriesMock.mockReset();
  });

  it('defaults annual_average to false and does not ask the service for averages', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    await blsGetSeriesTool.handler(input, ctx);

    expect(input.annual_average).toBe(false);
    expect(fetchSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ annualAverage: false }),
      ctx,
    );
  });

  it('does not couple annual averages to a year range', async () => {
    // Requesting a range must not change what a row means (#53's root cause).
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CUUR0000SA0'],
      start_year: 2023,
      end_year: 2024,
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(fetchSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ annualAverage: false, startYear: 2023 }),
      ctx,
    );
  });

  it('forwards annual_average to the service when opted in', async () => {
    fetchSeriesMock.mockResolvedValue([CPI_WITH_M13]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CUUR0000SA0'],
      annual_average: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(fetchSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ annualAverage: true }),
      ctx,
    );
  });

  it('asserts annualAverageApplied:false and omits the count on the default path', async () => {
    // The positive assertion is the point: a consumer can reduce observations[]
    // without knowing BLS period codes.
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    await blsGetSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.annualAverageApplied).toBe(false);
    expect(enriched.annualAverageRows).toBeUndefined();
    expect(enriched.notice).toBeUndefined();
  });

  it('counts annual-average rows and warns against double-counting when opted in', async () => {
    fetchSeriesMock.mockResolvedValue([CPI_WITH_M13]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CUUR0000SA0'],
      annual_average: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.annualAverageApplied).toBe(true);
    expect(enriched.annualAverageRows).toBe(2);
    expect(enriched.totalObservations).toBe(4);
    expect(enriched.notice).toContain('M13');
    expect(enriched.notice).toMatch(/mean of that year/i);
  });

  it('counts Q05 and S03 rows, not just M13', async () => {
    fetchSeriesMock.mockResolvedValue([
      { seriesId: 'PRS30006011', observations: [{ year: '2024', period: 'Q05', value: '-1.0' }] },
      {
        seriesId: 'CUUS0000SA0',
        observations: [{ year: '2024', period: 'S03', value: '313.689' }],
      },
      { seriesId: 'LNS14000000', observations: [{ year: '2024', period: 'M12', value: '4.1' }] },
    ]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['PRS30006011', 'CUUS0000SA0', 'LNS14000000'],
      annual_average: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    expect(getEnrichment(ctx).annualAverageRows).toBe(2);
  });

  it('reports zero rows for a survey that publishes no annual averages, without a notice', async () => {
    // LN reports hasAnnualAverages:true yet returns no M13 row — the count is the
    // only honest signal of what actually came back.
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LNS14000000'],
      annual_average: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.annualAverageApplied).toBe(true);
    expect(enriched.annualAverageRows).toBe(0);
    expect(enriched.notice).toBeUndefined();
  });

  it('marks annual-average rows on canvas rows so SQL can exclude them', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      year: String(2000 + Math.floor(i / 13)),
      period: i % 13 === 12 ? 'M13' : `M${String((i % 13) + 1).padStart(2, '0')}`,
      periodName: i % 13 === 12 ? 'Annual' : 'January',
      value: String(300 + i),
      footnotes: ['P: Preliminary figure subject to revision in a later release'],
    }));
    fetchSeriesMock.mockResolvedValue([{ seriesId: 'CUUR0000SA0', observations: many }]);
    registerDataframeMock.mockResolvedValue({
      tableName: 'df_EEEEE_FFFFF',
      rowCount: 900,
      expiresAt: '2026-07-18T00:00:00.000Z',
      columnSchema: [],
    });
    canvasBridge = { registerDataframe: registerDataframeMock };

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CUUR0000SA0'],
      annual_average: true,
    });
    await blsGetSeriesTool.handler(input, ctx);

    const rows = registerDataframeMock.mock.calls[0]![1].rows as Array<Record<string, unknown>>;
    const averages = rows.filter((r) => r.is_annual_average === true);
    const reals = rows.filter((r) => r.is_annual_average === false);

    expect(averages).toHaveLength(69);
    expect(averages.every((r) => r.period === 'M13')).toBe(true);
    expect(reals.every((r) => r.period !== 'M13')).toBe(true);
    // The opt-in warning must survive composition with the spill notice.
    expect(getEnrichment(ctx).notice).toContain('is_annual_average');
  });

  it('renders an annual-average row with its "Annual" label in content[]', async () => {
    // Different clients read structuredContent vs content[] — the M13 marker has
    // to reach both.
    const blocks = blsGetSeriesTool.format!({
      series: [
        {
          seriesId: 'CUUR0000SA0',
          observationCount: 2,
          observations: [
            { year: '2024', period: 'M13', periodName: 'Annual', value: '313.689' },
            { year: '2024', period: 'M12', periodName: 'December', value: '315.605' },
          ],
        },
      ],
      spilled: false as const,
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Annual 2024');
    expect(text).toContain('M13');
    expect(text).toContain('313.689');
  });

  // Security: verify API key never appears in tool output
  it('does not include API key or env values in output', async () => {
    fetchSeriesMock.mockResolvedValue([MOCK_SERIES]);
    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    // process.env.BLS_API_KEY is typically empty/undefined in tests — confirm no secret leakage pattern
    expect(serialized).not.toMatch(/registrationkey/i);
    expect(serialized).not.toMatch(/apikey/i);
  });
});
