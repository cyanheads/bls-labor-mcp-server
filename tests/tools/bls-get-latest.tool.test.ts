/**
 * @fileoverview Tests for bls_get_latest tool.
 * @module tests/tools/bls-get-latest.tool.test
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
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

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
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

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
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

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000'] });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('LNS14000000');
    expect(result.failed[0]!.error).toContain('No observations returned');
  });

  it('marks and renders an unavailable latest observation (#58)', async () => {
    fetchLatestMock.mockResolvedValue({
      ...MOCK_SERIES,
      observations: [
        {
          year: '2025',
          period: 'M10',
          periodName: 'October',
          value: '-',
          available: false,
          footnotes: ['9: Data unavailable.'],
        },
      ],
    });

    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: ['LNS14000000'] },
      { context: { errors: blsGetLatestTool.errors } },
    );

    expect(result.structuredContent).toMatchObject({
      results: [{ latestObservation: { value: '-', available: false } }],
      notice: expect.stringContaining('1 latest observation(s) are unavailable'),
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Value: **Unavailable**'),
    });
  });

  it('reports an Invalid Series advisory as a per-series failure (#61)', async () => {
    fetchLatestMock.mockRejectedValue(
      notFound(
        'BLS API: Invalid Series for Series BOGUS123 — use bls_search_series to find valid SeriesIDs.',
        { reason: 'series_not_found' },
      ),
    );

    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: ['BOGUS123'] },
      { context: { errors: blsGetLatestTool.errors } },
    );

    expect(result.structuredContent).toMatchObject({
      succeeded: 0,
      failed: [
        {
          seriesId: 'BOGUS123',
          error: expect.stringContaining('Invalid Series for Series BOGUS123'),
        },
      ],
      notice: expect.stringContaining('bls_search_series'),
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Invalid Series for Series BOGUS123'),
    });
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
            available: true,
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

  it('rethrows a request-level reason when no series returned an observation (#80)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchLatestMock
      .mockRejectedValueOnce(notFound('Series does not exist', { reason: 'series_not_found' }))
      .mockRejectedValueOnce(serviceUnavailable('quota', { reason: 'quota_exceeded' }));

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['BOGUS123', 'LNS14000000'] });

    await expect(blsGetLatestTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded' },
    });
  });

  it.each([
    { reason: 'quota_exceeded', hint: 'UTC midnight' },
    { reason: 'invalid_api_key', hint: 'BLS_API_KEY' },
    { reason: 'series_locked', hint: 'brief delay' },
  ] as const)(
    'keeps a served series when another fails with $reason, on both surfaces (#80)',
    async ({ reason, hint }) => {
      const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
      fetchLatestMock
        .mockResolvedValueOnce(MOCK_SERIES)
        .mockImplementationOnce((_seriesId, ctx) =>
          Promise.reject(
            serviceUnavailable(`BLS failure: ${reason}`, { reason, ...ctx.recoveryFor(reason) }),
          ),
        );

      const result = await runToolContract(
        blsGetLatestTool,
        { series_ids: ['LNS14000000', 'LNU00009999'] },
        { context: { errors: blsGetLatestTool.errors } },
      );

      expect(result.structuredContent).toMatchObject({
        results: [{ seriesId: 'LNS14000000', latestObservation: { value: '4.1' } }],
        succeeded: 1,
        failed: [{ seriesId: 'LNU00009999', error: expect.stringContaining(reason) }],
        notice: expect.stringContaining(reason),
      });
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).toContain('LNU00009999');
      expect(notice).toContain(hint);
      // The SeriesID is not the problem, so the caller is not sent to re-resolve it.
      expect(notice).not.toContain('bls_search_series');

      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('- LNU00009999:');
      expect(text).toContain(hint);
    },
  );

  it('names both classes when a request-level failure sits beside an invalid SeriesID (#80)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    fetchLatestMock
      .mockResolvedValueOnce(MOCK_SERIES)
      .mockRejectedValueOnce(notFound('Series does not exist', { reason: 'series_not_found' }))
      .mockRejectedValueOnce(serviceUnavailable('quota', { reason: 'quota_exceeded' }));

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({
      series_ids: ['LNS14000000', 'BOGUS123', 'LNU00009999'],
    });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.failed.map((f) => f.seriesId)).toEqual(['BOGUS123', 'LNU00009999']);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('bls_search_series');
    expect(notice).toContain('quota_exceeded');
    expect(notice).toMatch(/LNU00009999[^.]*quota_exceeded/);
    const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
    expect(warnings[0]?.data).toMatchObject({ seriesIds: ['LNU00009999'] });
  });

  it('fails a cancelled request rather than returning the legs that finished (#80)', async () => {
    const controller = new AbortController();
    fetchLatestMock.mockResolvedValueOnce(MOCK_SERIES).mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    });

    const ctx = createMockContext({ errors: blsGetLatestTool.errors, signal: controller.signal });
    const input = blsGetLatestTool.input.parse({ series_ids: ['LNS14000000', 'LNU00009999'] });

    await expect(blsGetLatestTool.handler(input, ctx)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('handles mixed success and failure across multiple series', async () => {
    fetchLatestMock
      .mockResolvedValueOnce(MOCK_SERIES)
      .mockRejectedValueOnce(new Error('series_not_found'));

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({
      series_ids: ['LNS14000000', 'INVALID000'],
    });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('INVALID000');
    // Failed series are in failed[] only — results[] contains only successful entries.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.seriesId).toBe('LNS14000000');
    expect(result.results[0]!.latestObservation).toBeDefined();

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.notice).toContain('bls_search_series');
  });

  it('failed series are excluded from results and appear only in failed[]', async () => {
    // Previously failed stubs appeared in both results[] and failed[]. This test
    // verifies that a rejected fetch for the first ID leaves results[] with only
    // the successful second entry, not a bare stub for the invalid first.
    fetchLatestMock
      .mockRejectedValueOnce(new Error('Series does not exist'))
      .mockResolvedValueOnce(MOCK_SERIES);

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({
      series_ids: ['ZZZZZZZ_INVALID', 'LNS14000000'],
    });
    const result = await blsGetLatestTool.handler(input, ctx);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.seriesId).toBe('ZZZZZZZ_INVALID');
    // Only the valid series is in results — failed entries do not appear there.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.seriesId).toBe('LNS14000000');
    expect(result.results[0]!.latestObservation?.value).toBe('4.1');
  });

  it('format footer counts results + failed as the total requested', () => {
    // results[] has 1 success, failed[] has 1 failure → "1 of 2 series returned data."
    const output = {
      results: [
        {
          seriesId: 'LNS14000000',
          latestObservation: { year: '2024', period: 'M12', value: '4.1', available: true },
        },
      ],
      succeeded: 1,
      failed: [{ seriesId: 'INVALID000', error: 'series_not_found' }],
    };
    const blocks = blsGetLatestTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 of 2 series returned data');
  });

  it('rejects empty series_ids array', () => {
    expect(() => blsGetLatestTool.input.parse({ series_ids: [] })).toThrow();
  });

  it('rejects series_ids array with more than 50 entries', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ID${i}`);
    expect(() => blsGetLatestTool.input.parse({ series_ids: ids })).toThrow();
  });

  it('formats output with failed series listed', () => {
    // results[] contains only successful entries; failed[] carries the errors.
    const output = {
      results: [],
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
            available: true,
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
            available: true,
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
