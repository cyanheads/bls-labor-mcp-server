/**
 * @fileoverview `bls_get_series` and `bls_get_latest` run end to end through the
 * real BlsApiService and the framework's real `withRetry`, with only the server
 * config, the observations mirror, the catalog index, and `fetch` faked. Covers
 * what only shows at that seam: the mirror/live partial result when the live
 * fallback fails (#80), the catalog-free re-issue after BLS's generic
 * rejection (#81), and whether calculations reached every mirror-served series
 * (#96) — each through both `structuredContent` and `content[]`.
 * @module tests/tools/bls-data-tools.service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENERIC_REJECTION,
  LATEST_INVALID_WITHOUT_CATALOG,
  MIXED_INVALID_WITHOUT_CATALOG,
} from '../fixtures/bls-live-responses.js';

const state = vi.hoisted(() => ({
  config: {
    apiKey: 'test-key',
    baseUrl: 'https://bls.test/publicAPI/v2',
    userAgent: 'test-bls-mcp/1.0',
    observationsMirrorEnabled: false,
    observationsMirrorFallbackLive: true,
  },
  mirror: {
    ready: () => Promise.resolve(true),
    queryBySeries: vi.fn(),
    queryLatest: vi.fn(),
  },
  catalog: { isLoaded: true, lookupByIds: vi.fn() },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => state.config }));
vi.mock('@/services/bls-observations/bls-observations-service.js', () => ({
  isBlsObservationsServiceReady: () => state.config.observationsMirrorEnabled,
  getBlsObservationsService: () => state.mirror,
}));
vi.mock('@/services/bls-catalog/bls-catalog-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bls-catalog/bls-catalog-service.js')>()),
  getBlsCatalogService: () => state.catalog,
}));

import { blsGetLatestTool } from '@/mcp-server/tools/definitions/bls-get-latest.tool.js';
import { blsGetSeriesTool } from '@/mcp-server/tools/definitions/bls-get-series.tool.js';
import { blsListSurveysTool } from '@/mcp-server/tools/definitions/bls-list-surveys.tool.js';
import { initBlsApiService } from '@/services/bls-api/bls-api-service.js';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mirrorRow(series_id: string, year: string, period: string, value: string) {
  return {
    row_key: `${series_id}|${year}|${period}`,
    series_id,
    year,
    period,
    value,
    footnote_codes: '',
  };
}

/** Every text block `content[]` carries, joined — what a content-only client reads. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

const QUOTA_BODY = {
  status: 'REQUEST_NOT_PROCESSED',
  responseTime: 10,
  message: ['Daily threshold of 500 queries reached'],
};

/** A live answer echoing each requested SeriesID with one row carrying calculations. */
function liveWithCalculations(init: RequestInit | undefined): Response {
  const ids = (JSON.parse(init?.body as string) as { seriesid: string[] }).seriesid;
  return okJson({
    status: 'REQUEST_SUCCEEDED',
    responseTime: 10,
    message: [],
    Results: {
      series: ids.map((seriesID) => ({
        seriesID,
        data: [
          {
            year: '2025',
            period: 'M03',
            value: '4.4',
            calculations: { net_changes: { '1': '0.1' }, pct_changes: { '1': '2.3' } },
          },
        ],
      })),
    },
  });
}

const seriesContext = { context: { errors: blsGetSeriesTool.errors } };
const latestContext = { context: { errors: blsGetLatestTool.errors } };

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected unmocked BLS request'));
  state.config.observationsMirrorEnabled = false;
  state.config.apiKey = 'test-key';
  state.catalog.isLoaded = true;
  state.mirror.queryBySeries.mockReset();
  state.mirror.queryLatest.mockReset();
  state.catalog.lookupByIds.mockReset();
  state.catalog.lookupByIds.mockResolvedValue(new Map());
  // The service reads everything it needs from the mocked server config.
  initBlsApiService({} as AppConfig, undefined);
});

describe('canonical retrieval and truthful metadata', () => {
  it.each([
    ['series', blsGetSeriesTool],
    ['latest', blsGetLatestTool],
  ] as const)(
    '%s canonicalizes IDs without restricting valid shapes and hydrates ordinary live metadata',
    async (name, tool) => {
      const ids = ['OEUM004266000000029114103', 'PCU1133--1133--'];
      state.catalog.lookupByIds.mockResolvedValue(
        new Map([
          [
            ids[0]!,
            {
              seriesId: ids[0]!,
              title: 'Decoded duration and units',
              areaName: 'Catalog area',
              seasonal: false,
            },
          ],
        ]),
      );
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
        const requested =
          name === 'series'
            ? (JSON.parse(init!.body as string) as { seriesid: string[] }).seriesid
            : [decodeURIComponent(String(url).split('/timeseries/data/')[1]!.split('?')[0]!)];
        return Promise.resolve(
          okJson({
            status: 'REQUEST_SUCCEEDED',
            responseTime: 1,
            Results: {
              series: requested.map((seriesID) => ({
                seriesID,
                catalog: {
                  series_title: 'Generic upstream',
                  area: 'API area',
                  measure_data_type: 'Number in thousands',
                },
                data: [{ year: '2025', period: 'M01', value: '2' }],
              })),
            },
          }),
        );
      });
      const result = await runToolContract(
        tool,
        { series_ids: [' oeum004266000000029114103 ', ids[0]!, 'pcu1133--1133--'] },
        { context: { errors: tool.errors } },
      );
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured[name === 'series' ? 'series' : 'results']).toMatchObject([
        {
          seriesId: ids[0],
          title: 'Decoded duration and units',
          area: 'API area',
          measure: 'Number in thousands',
        },
        { seriesId: ids[1], title: 'Generic upstream', measure: 'Number in thousands' },
      ]);
      expect(spy).toHaveBeenCalledTimes(name === 'series' ? 1 : 2);
      expect(contentText(result)).toContain('Measure: Number in thousands');
      expect(contentText(result)).toContain('Decoded duration and units');
    },
  );

  it.each([
    ['series', false, 25],
    ['series', true, 50],
    ['latest', false, 50],
  ] as const)(
    '%s applies its effective cap keyed=%s before I/O and preserves the exact remainder',
    async (name, keyed, cap) => {
      state.config.apiKey = keyed ? 'test-key' : '';
      initBlsApiService({} as AppConfig, undefined);
      const ids = Array.from({ length: 53 }, (_, i) => `TEST${i}`);
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        name === 'series'
          ? Promise.resolve(liveWithCalculations(init))
          : Promise.resolve(
              okJson({
                status: 'REQUEST_SUCCEEDED',
                responseTime: 1,
                Results: {
                  series: [
                    {
                      seriesID: String(url).split('/timeseries/data/')[1]!.split('?')[0],
                      data: [{ year: '2025', period: 'M01', value: '1' }],
                    },
                  ],
                },
              }),
            ),
      );
      const tool = name === 'series' ? blsGetSeriesTool : blsGetLatestTool;
      const result = await runToolContract(
        tool,
        { series_ids: [' test0 ', ...ids] },
        { context: { errors: tool.errors } },
      );
      expect(result.structuredContent).toMatchObject({ unprocessedSeriesIds: ids.slice(cap) });
      expect(contentText(result)).toContain(`applied limit ${cap}`);
      expect(contentText(result)).toContain('TEST52');
      expect(spy).toHaveBeenCalledTimes(name === 'series' ? 1 : 50);
      if (name === 'series')
        expect(JSON.parse(spy.mock.calls[0]![1]!.body as string).seriesid).toEqual(
          ids.slice(0, cap),
        );
      expect(
        (result.structuredContent as Record<string, unknown[]>)[
          name === 'series' ? 'series' : 'results'
        ],
      ).toHaveLength(cap);
    },
  );

  it('rejects whitespace-only IDs before I/O on both branches', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        Results: {
          series: [{ seriesID: '   ', data: [{ year: '2025', period: 'M01', value: '1' }] }],
        },
      }),
    );
    for (const tool of [blsGetSeriesTool, blsGetLatestTool]) {
      const result = await runToolContract(
        tool,
        { series_ids: ['   '] },
        { context: { errors: tool.errors } },
      );
      expect(result.structuredContent).toHaveProperty('error');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports explicit upstream reductions without deriving the window from sparse observations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        message: [
          'Year range has been reduced to the system-allowed limit of 10 years.',
          'Calculations have been disabled for this request. test-key',
        ],
        Results: {
          series: [{ seriesID: 'GOOD', data: [{ year: '2018', period: 'M01', value: '3' }] }],
        },
      }),
    );
    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['GOOD'], start_year: 2010, end_year: 2024, calculations: true },
      seriesContext,
    );
    expect(result.structuredContent).toMatchObject({
      startYearApplied: 2010,
      endYearApplied: 2019,
      calculationsApplied: false,
    });
    const text = contentText(result);
    expect(text).toContain('Year range has been reduced');
    expect(text).toContain('no calculation values for GOOD');
    expect(JSON.stringify(result)).not.toContain('test-key');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        Results: {
          series: [{ seriesID: 'GOOD', data: [{ year: '2018', period: 'M01', value: '3' }] }],
        },
      }),
    );
    const sparse = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['GOOD'], start_year: 2010, end_year: 2024 },
      seriesContext,
    );
    expect(sparse.structuredContent).toMatchObject({
      startYearApplied: 2010,
      endYearApplied: 2024,
    });
  });

  it('preserves supported calculations when another data-bearing series has none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        Results: {
          series: [
            {
              seriesID: 'GOOD',
              data: [
                {
                  year: '2025',
                  period: 'M01',
                  value: '3',
                  calculations: { pct_changes: { '1': '0.2' } },
                },
              ],
            },
            { seriesID: 'PLAIN', data: [{ year: '2025', period: 'Q01', value: '4' }] },
          ],
        },
      }),
    );
    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['GOOD', 'PLAIN'], calculations: true },
      seriesContext,
    );
    expect(result.structuredContent).toMatchObject({
      calculationsApplied: false,
      series: [{ observations: [{ pctChange1Month: '0.2' }] }, { seriesId: 'PLAIN' }],
    });
    expect(contentText(result)).toContain('0.2');
    expect(contentText(result)).toContain('no calculation values for PLAIN');
  });

  it('keeps upstream metadata with the catalog unavailable and distinguishes upstream omissions from invalid IDs', async () => {
    state.catalog.isLoaded = false;
    vi.mocked(globalThis.fetch).mockResolvedValue(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        message: [
          'Requested Series list has been reduced to the system-allowed limit of 25 series.',
          'Invalid Series for Series BAD',
        ],
        Results: {
          series: [
            {
              seriesID: 'GOOD',
              catalog: { series_title: 'API title' },
              data: [{ year: '2025', period: 'M01', value: '1' }],
            },
          ],
        },
      }),
    );
    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['GOOD', 'BAD', 'OMITTED'] },
      seriesContext,
    );
    expect(result.structuredContent).toMatchObject({
      series: [
        { seriesId: 'GOOD', title: 'API title' },
        { seriesId: 'BAD', observationCount: 0 },
        { seriesId: 'OMITTED', observationCount: 0 },
      ],
    });
    const series = (result.structuredContent as { series: Record<string, unknown>[] }).series;
    expect(series[0]).not.toHaveProperty('measure');
    expect(state.catalog.lookupByIds).not.toHaveBeenCalled();
    expect(contentText(result)).toContain('BLS reports BAD is invalid');
    expect(contentText(result)).toContain('BLS omitted OMITTED');
    expect(contentText(result)).not.toContain('BLS reports OMITTED is invalid');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const liveToolRuns = [
  {
    name: 'series',
    run: () => runToolContract(blsGetSeriesTool, { series_ids: ['LNS14000000'] }, seriesContext),
  },
  {
    name: 'latest',
    run: () => runToolContract(blsGetLatestTool, { series_ids: ['LNS14000000'] }, latestContext),
  },
  {
    name: 'surveys',
    run: () =>
      runToolContract(blsListSurveysTool, {}, { context: { errors: blsListSurveysTool.errors } }),
  },
];

describe('live failures reach both tool response surfaces', () => {
  it.each(['series', 'latest'])(
    '%s preserves mirror success when a live peer exhausts the body budget',
    async (name) => {
      vi.useFakeTimers();
      state.config.observationsMirrorEnabled = true;
      state.mirror.queryBySeries.mockResolvedValue({
        observations: [mirrorRow('GOOD', '2025', 'M01', '4.4')],
        complete: false,
        missedIds: ['BAD'],
      });
      state.mirror.queryLatest.mockImplementation((ids: string[]) =>
        Promise.resolve({
          observations: ids[0] === 'GOOD' ? [mirrorRow('GOOD', '2025', 'M01', '4.4')] : [],
          complete: ids[0] === 'GOOD',
          missedIds: ids[0] === 'GOOD' ? [] : ids,
        }),
      );
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
                init!.signal!.addEventListener(
                  'abort',
                  () => controller.error(init!.signal!.reason),
                  { once: true },
                );
              },
            }),
          ),
        ),
      );
      const pending =
        name === 'series'
          ? runToolContract(blsGetSeriesTool, { series_ids: ['GOOD', 'BAD'] }, seriesContext)
          : runToolContract(blsGetLatestTool, { series_ids: ['GOOD', 'BAD'] }, latestContext);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('upstream_timeout'),
      });
      expect(contentText(result)).toContain('GOOD');
      expect(contentText(result)).toContain('4.4');
      expect(contentText(result)).toContain('upstream_timeout');
      expect(contentText(result)).not.toContain('bls_search_series');
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['series', 'latest'])(
    '%s surfaces timeout when the mirror misses every ID',
    async (name) => {
      vi.useFakeTimers();
      state.config.observationsMirrorEnabled = true;
      state.mirror.queryBySeries.mockResolvedValue({
        observations: [],
        complete: false,
        missedIds: ['BAD'],
      });
      state.mirror.queryLatest.mockResolvedValue({
        observations: [],
        complete: false,
        missedIds: ['BAD'],
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
          }),
      );
      const pending =
        name === 'series'
          ? runToolContract(blsGetSeriesTool, { series_ids: ['BAD'] }, seriesContext)
          : runToolContract(blsGetLatestTool, { series_ids: ['BAD'] }, latestContext);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: { reason: 'upstream_timeout', recovery: { hint: expect.stringContaining('BLS') } },
        },
      });
      expect(contentText(result)).toContain('upstream_timeout');
    },
  );

  it.each(['series', 'latest'])(
    '%s never returns partial mirror data after caller cancellation',
    async (name) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      state.config.observationsMirrorEnabled = true;
      state.mirror.queryBySeries.mockResolvedValue({
        observations: [mirrorRow('GOOD', '2025', 'M01', '4.4')],
        complete: false,
        missedIds: ['BAD'],
      });
      state.mirror.queryLatest.mockImplementation((ids: string[]) =>
        Promise.resolve({
          observations: ids[0] === 'GOOD' ? [mirrorRow('GOOD', '2025', 'M01', '4.4')] : [],
          complete: ids[0] === 'GOOD',
          missedIds: ids[0] === 'GOOD' ? [] : ids,
        }),
      );
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
          }),
      );
      const pending =
        name === 'series'
          ? runToolContract(
              blsGetSeriesTool,
              { series_ids: ['GOOD', 'BAD'] },
              { context: { errors: blsGetSeriesTool.errors, signal: caller.signal } },
            )
          : runToolContract(
              blsGetLatestTool,
              { series_ids: ['GOOD', 'BAD'] },
              { context: { errors: blsGetLatestTool.errors, signal: caller.signal } },
            );
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
      caller.abort(new Error('caller cancelled the live fallback'));
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain('caller cancelled the live fallback');
      expect(result.structuredContent).not.toHaveProperty('series');
      expect(result.structuredContent).not.toHaveProperty('results');
      await vi.runAllTimersAsync();
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(liveToolRuns)(
    '$name reports availability failures with status and recovery',
    async ({ run }) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response('private body test-key', { status: 403 })),
      );
      const result = await run();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'service_unavailable',
            status: 403,
            retryable: false,
            recovery: { hint: expect.stringContaining('BLS') },
          },
        },
      });
      expect(contentText(result)).toContain('Recovery:');
      expect(contentText(result)).toContain('service_unavailable');
      expect(JSON.stringify(result)).not.toContain('private body');
      expect(JSON.stringify(result)).not.toContain('test-key');
    },
  );

  it.each(liveToolRuns)('$name reports malformed payloads with recovery', async ({ run }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{bad json')),
    );
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'serialization_failure',
          retryable: false,
          recovery: { hint: expect.stringContaining('BLS') },
        },
      },
    });
    expect(contentText(result)).toContain('Recovery:');
    expect(contentText(result)).toContain('serialization_failure');
  });

  it.each(liveToolRuns)('$name reports budget expiry with stable BLS recovery', async ({ run }) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const pending = run();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_timeout',
          retryable: true,
          recovery: { hint: expect.stringContaining('BLS') },
        },
      },
    });
    expect(contentText(result)).toContain('Recovery:');
    expect(contentText(result)).toContain('upstream_timeout');
  });

  it('latest keeps a success and names an unavailable peer without blaming SeriesIDs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      Promise.resolve(
        String(url).includes('/GOOD?')
          ? okJson({
              status: 'REQUEST_SUCCEEDED',
              message: [],
              Results: {
                series: [
                  { seriesID: 'GOOD', data: [{ year: '2025', period: 'M01', value: '4.4' }] },
                ],
              },
            })
          : new Response('', { status: 403 }),
      ),
    );
    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: ['GOOD', 'BAD'] },
      latestContext,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      succeeded: 1,
      results: [{ seriesId: 'GOOD' }],
      failed: [{ seriesId: 'BAD' }],
      notice: expect.stringContaining('service_unavailable'),
    });
    expect(contentText(result)).toContain('4.4');
    expect(contentText(result)).toContain('service_unavailable');
    expect(contentText(result)).not.toContain('verify the failing SeriesIDs');
    expect(contentText(result)).not.toContain('bls_search_series');
  });
});

describe('bls_get_series — failed live fallback keeps the mirrored series (#80)', () => {
  beforeEach(() => {
    state.config.observationsMirrorEnabled = true;
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [
        mirrorRow('LNU00000002', '2025', 'M03', '4.4'),
        mirrorRow('LNU00000002', '2025', 'M02', '4.5'),
      ],
      complete: false,
      missedIds: ['LNU00009999'],
    });
  });

  it('answers the mirrored series and names the quota failure, on both surfaces', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(okJson(QUOTA_BODY)));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00009999', 'LNU00000002'], start_year: 2025, end_year: 2025 },
      seriesContext,
    );

    expect(result.structuredContent).toMatchObject({
      series: [
        { seriesId: 'LNU00009999', observationCount: 0, observations: [] },
        { seriesId: 'LNU00000002', observationCount: 2 },
      ],
      totalObservations: 2,
      seriesRequested: 2,
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('LNU00009999');
    expect(notice).toContain('quota_exceeded');
    expect(notice).toContain('UTC midnight');
    expect(notice).not.toContain('bls_search_series');
    expect(notice).not.toContain('LNU00000002');

    const text = contentText(result);
    expect(text).toContain('### LNU00000002');
    expect(text).toContain('| March 2025 | M03 | 4.4 |');
    expect(text).toContain('quota_exceeded');
    expect(text).toContain('UTC midnight');
    // The quota wall says nothing about the SeriesID, on this surface either.
    expect(text).not.toContain('bls_search_series');
  });

  it('names the typed availability failure without exposing the raw transport message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Unable to connect.'));
    // The real retry ladder backs off between the four attempts a network error earns.
    vi.useFakeTimers();

    const pending = runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00009999', 'LNU00000002'] },
      seriesContext,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('LNU00009999');
    expect(notice).toContain('service_unavailable');
    expect(notice).toContain('BLS API availability');
    expect(notice).not.toContain('bls_search_series');
    expect(contentText(result)).toContain('service_unavailable');
    expect(contentText(result)).not.toContain('Unable to connect.');
  });

  it('reports a doubly rejected fallback as a rejected request, not an invalid SeriesID', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(GENERIC_REJECTION)));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00009999', 'LNU00000002'] },
      seriesContext,
    );

    // The fallback leg inherits the catalog-free re-issue (#81), then stops.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('request_rejected');
    expect(notice).not.toContain('invalid or does not exist');
    expect(notice).not.toContain('Split series_ids');
  });

  it('recovers a fallback leg’s generic rejection through the re-issue, keeping all three sources', async () => {
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [mirrorRow('LNU00000002', '2025', 'M03', '4.4')],
      complete: false,
      missedIds: ['LNS14000000', 'BOGUS123'],
    });
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      bodies.push(body);
      return Promise.resolve(
        okJson(body.catalog === true ? GENERIC_REJECTION : MIXED_INVALID_WITHOUT_CATALOG),
      );
    });

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['BOGUS123', 'LNU00000002', 'LNS14000000'], start_year: 2025, end_year: 2025 },
      seriesContext,
    );

    expect(bodies.map((b) => b.seriesid)).toEqual([
      ['LNS14000000', 'BOGUS123'],
      ['LNS14000000', 'BOGUS123'],
    ]);
    expect(result.structuredContent).toMatchObject({
      series: [
        { seriesId: 'BOGUS123', observationCount: 0 },
        { seriesId: 'LNU00000002', observationCount: 1 },
        { seriesId: 'LNS14000000', observationCount: 12 },
      ],
      notice: expect.stringContaining('BOGUS123 is invalid or does not exist'),
    });
    expect((result.structuredContent as { notice: string }).notice).not.toContain('fallback');
    expect(contentText(result)).toContain('### LNS14000000');
  });

  it('fails the call with the live error when every requested ID missed the mirror', async () => {
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [],
      complete: false,
      missedIds: ['LNU00009999'],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(okJson(QUOTA_BODY)));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00009999'] },
      seriesContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'quota_exceeded',
          retryable: false,
          recovery: { hint: expect.stringContaining('UTC midnight') },
        },
      },
    });
  });
});

describe('bls_get_series — catalog-free re-issue after the generic rejection (#81)', () => {
  it('keeps the valid series with index metadata and names the invalid ID, on both surfaces', async () => {
    state.catalog.lookupByIds.mockResolvedValue(
      new Map([
        [
          'LNS14000000',
          {
            seriesId: 'LNS14000000',
            surveyAbbr: 'LN',
            title: '(Seas) Unemployment Rate',
            areaName: 'U.S.',
            seasonal: true,
          },
        ],
      ]),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(GENERIC_REJECTION))
      .mockResolvedValueOnce(okJson(MIXED_INVALID_WITHOUT_CATALOG));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNS14000000', 'BOGUS123'], start_year: 2025, end_year: 2025 },
      seriesContext,
    );

    expect(state.catalog.lookupByIds).toHaveBeenCalledWith(['LNS14000000', 'BOGUS123']);
    expect(result.structuredContent).toMatchObject({
      series: [
        {
          seriesId: 'LNS14000000',
          title: '(Seas) Unemployment Rate',
          area: 'U.S.',
          seasonal: 'Seasonally Adjusted',
          observationCount: 12,
          availableObservationCount: 11,
        },
        { seriesId: 'BOGUS123', observationCount: 0 },
      ],
      notice: expect.stringContaining('BOGUS123 is invalid or does not exist'),
    });
    const [valid, invalid] = (result.structuredContent as { series: object[] }).series;
    expect(valid).not.toHaveProperty('item');
    expect(invalid).not.toHaveProperty('title');

    const text = contentText(result);
    expect(text).toContain('### LNS14000000 — (Seas) Unemployment Rate');
    expect(text).toContain('Seasonality: Seasonally Adjusted');
    expect(text).toContain('BOGUS123 is invalid or does not exist');
  });

  it('omits catalog fields for a re-issued series the index does not hold', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(GENERIC_REJECTION))
      .mockResolvedValueOnce(okJson(MIXED_INVALID_WITHOUT_CATALOG));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNS14000000', 'BOGUS123'], start_year: 2025, end_year: 2025 },
      seriesContext,
    );

    const [valid] = (result.structuredContent as { series: object[] }).series;
    expect(valid).toMatchObject({ seriesId: 'LNS14000000', observationCount: 12 });
    for (const field of ['title', 'area', 'item', 'seasonal']) {
      expect(valid).not.toHaveProperty(field);
    }
    expect(contentText(result)).toContain('### LNS14000000\n');
  });

  it('fails with request_rejected when both answers are generic', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(okJson(GENERIC_REJECTION)),
    );

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNS14000000', 'BOGUS123'] },
      seriesContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'request_rejected', retryable: false } },
    });
    const text = contentText(result);
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('Split series_ids');
  });
});

describe('bls_get_latest — end to end (#80, #81)', () => {
  it('routes the Invalid Series advisory from the re-issue to failed[], on both surfaces', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(GENERIC_REJECTION))
      .mockResolvedValueOnce(okJson(LATEST_INVALID_WITHOUT_CATALOG));

    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: ['BOGUS123'] },
      latestContext,
    );

    expect(result.structuredContent).toMatchObject({
      succeeded: 0,
      failed: [
        {
          seriesId: 'BOGUS123',
          error: expect.stringContaining('Invalid Series for Series BOGUS123'),
        },
      ],
    });
    expect(contentText(result)).toContain('Invalid Series for Series BOGUS123');
  });

  it('keeps the mirror-served series when another ID’s fallback hits the quota', async () => {
    state.config.observationsMirrorEnabled = true;
    state.mirror.queryLatest.mockImplementation((ids: string[]) =>
      Promise.resolve(
        ids[0] === 'LNU00000002'
          ? {
              observations: [mirrorRow('LNU00000002', '2025', 'M03', '4.4')],
              complete: true,
              missedIds: [],
            }
          : { observations: [], complete: false, missedIds: ids },
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(okJson(QUOTA_BODY)));

    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: ['LNU00000002', 'LNU00009999'] },
      latestContext,
    );

    expect(result.structuredContent).toMatchObject({
      results: [{ seriesId: 'LNU00000002', latestObservation: { value: '4.4' } }],
      succeeded: 1,
      failed: [{ seriesId: 'LNU00009999' }],
      notice: expect.stringContaining('quota_exceeded'),
    });
    const text = contentText(result);
    expect(text).toContain('**LNU00000002**');
    expect(text).toContain('UTC midnight');
  });
});

describe('bls_get_series — calculations and the observations mirror (#96)', () => {
  it('reports calculationsApplied:true when every series was served live (mirror off)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      Promise.resolve(liveWithCalculations(init)),
    );

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00000002'], start_year: 2025, end_year: 2025, calculations: true },
      seriesContext,
    );

    expect(result.structuredContent).toMatchObject({
      series: [{ observations: [{ netChange1Month: '0.1', pctChange1Month: '2.3' }] }],
      calculationsApplied: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('**calculationsApplied:** true');
  });

  it('reports calculationsApplied:false and names a mirror-served series, on both surfaces', async () => {
    state.config.observationsMirrorEnabled = true;
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [mirrorRow('LNU00000002', '2025', 'M03', '4.4')],
      complete: true,
      missedIds: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00000002'], start_year: 2025, end_year: 2025, calculations: true },
      seriesContext,
    );

    // Served from the mirror as before — no daily query spent to fetch calculations.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      calculationsApplied: false,
      notice: expect.stringContaining('LNU00000002'),
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toMatch(/calculations/);
    expect(notice).toMatch(/mirror/);
    const text = contentText(result);
    expect(text).toContain('**calculationsApplied:** false');
    expect(text).toMatch(/LNU00000002[^\n]*calculations|calculations[^\n]*LNU00000002/);
  });

  it('names only the mirror-served series in a mixed mirror/live result', async () => {
    state.config.observationsMirrorEnabled = true;
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [mirrorRow('LNU00000002', '2025', 'M03', '4.4')],
      complete: false,
      missedIds: ['LNS14000000'],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      Promise.resolve(liveWithCalculations(init)),
    );

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNS14000000', 'LNU00000002'], calculations: true },
      seriesContext,
    );

    expect(result.structuredContent).toMatchObject({
      series: [
        { seriesId: 'LNS14000000', observations: [{ netChange1Month: '0.1' }] },
        { seriesId: 'LNU00000002', observations: [{ value: '4.4' }] },
      ],
      calculationsApplied: false,
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('LNU00000002');
    expect(notice).not.toContain('LNS14000000');
  });

  it('leaves calculations:false unchanged on the mirror path', async () => {
    state.config.observationsMirrorEnabled = true;
    state.mirror.queryBySeries.mockResolvedValue({
      observations: [mirrorRow('LNU00000002', '2025', 'M03', '4.4')],
      complete: true,
      missedIds: [],
    });

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNU00000002'], calculations: false },
      seriesContext,
    );

    expect(result.structuredContent).toMatchObject({ calculationsApplied: false });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});

describe('live-path measure beside the catalog index (#127)', () => {
  /** The index row for LNS14000000, decoding `ln.tdat` as BLS's `measure_data_type` does. */
  const LN_CATALOG = {
    seriesId: 'LNS14000000',
    surveyAbbr: 'LN',
    title: '(Seas) Unemployment Rate',
    measure: 'Percent or rate',
    seasonal: true,
  };

  it.each([
    ['series', blsGetSeriesTool, 'series'],
    ['latest', blsGetLatestTool, 'results'],
  ] as const)(
    '%s keeps the measure_data_type BLS answered over the index measure (characterization)',
    async (_name, tool, key) => {
      state.catalog.lookupByIds.mockResolvedValue(
        new Map([['LNS14000000', { ...LN_CATALOG, measure: 'Index measure' }]]),
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          okJson({
            status: 'REQUEST_SUCCEEDED',
            responseTime: 1,
            Results: {
              series: [
                {
                  seriesID: 'LNS14000000',
                  catalog: { measure_data_type: 'Percent or rate' },
                  data: [{ year: '2025', period: 'M01', value: '4.0' }],
                },
              ],
            },
          }),
        ),
      );

      const result = await runToolContract(
        tool,
        { series_ids: ['LNS14000000'] },
        { context: { errors: tool.errors } },
      );

      expect((result.structuredContent as Record<string, unknown>)[key]).toMatchObject([
        { seriesId: 'LNS14000000', measure: 'Percent or rate' },
      ]);
      const text = contentText(result);
      expect(text).toContain('Measure: Percent or rate');
      expect(text).not.toContain('Index measure');
    },
  );

  it('fills a re-issued series’ measure from the index, on both surfaces (#81)', async () => {
    state.catalog.lookupByIds.mockResolvedValue(new Map([['LNS14000000', LN_CATALOG]]));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(GENERIC_REJECTION))
      .mockResolvedValueOnce(okJson(MIXED_INVALID_WITHOUT_CATALOG));

    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['LNS14000000', 'BOGUS123'], start_year: 2025, end_year: 2025 },
      seriesContext,
    );

    const [valid, invalid] = (result.structuredContent as { series: object[] }).series;
    expect(valid).toMatchObject({ seriesId: 'LNS14000000', measure: 'Percent or rate' });
    expect(invalid).not.toHaveProperty('measure');
    expect(contentText(result)).toContain('Measure: Percent or rate');
  });
});

/**
 * An OEWS SeriesID BLS reports nonexistent is usually an occupation–area cell it
 * does not publish (#119). The catalog singleton is never initialized here, so
 * the stored OE code tables are absent and the hint names the national row.
 */
describe('unpublished OEWS SeriesIDs point at their national row (#119)', () => {
  const METRO = 'OEUM004766000000029114103';
  const NATIONAL = 'OEUN000000000000029114103';
  const HINT = `BLS leaves many OEWS occupation–area cells unpublished; request the national row ${NATIONAL} for the same occupation and data type.`;

  /** BLS's answer naming every ID in `invalid` nonexistent, with one observation per `valid` ID. */
  function answer(invalid: string[], valid: string[] = []): Response {
    return okJson({
      status: 'REQUEST_SUCCEEDED',
      responseTime: 1,
      message: invalid.map((id) => `Series does not exist for Series ${id}`),
      Results: {
        series: [
          ...valid.map((id) => ({
            seriesID: id,
            data: [{ year: '2025', period: 'A01', value: '60.76' }],
          })),
          ...invalid.map((id) => ({ seriesID: id, data: [] })),
        ],
      },
    });
  }

  beforeEach(() => {
    state.catalog.isLoaded = false;
  });

  it('bls_get_series recovers a lone unpublished OEWS ID through its national row, not search', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(answer([METRO]));
    const result = await runToolContract(blsGetSeriesTool, { series_ids: [METRO] }, seriesContext);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'series_not_found', recovery: { hint: `${METRO}: ${HINT}` } } },
    });
    expect(contentText(result)).toContain(`${METRO}: ${HINT}`);
    expect(contentText(result)).not.toContain('bls_search_series');
  });

  it('bls_get_series keeps the search recovery for other IDs, beside the OEWS row', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(answer(['BOGUS123']));
    const plain = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['BOGUS123'] },
      seriesContext,
    );
    expect(plain.structuredContent).toMatchObject({
      error: {
        data: {
          recovery: {
            hint: 'Use bls_search_series to find valid SeriesIDs before calling bls_get_series.',
          },
        },
      },
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(answer(['BOGUS123', METRO]));
    const mixed = await runToolContract(
      blsGetSeriesTool,
      { series_ids: ['BOGUS123', METRO] },
      seriesContext,
    );
    expect(mixed.structuredContent).toMatchObject({
      error: {
        data: {
          recovery: {
            hint: `Use bls_search_series to find valid SeriesIDs before calling bls_get_series. ${METRO}: ${HINT}`,
          },
        },
      },
    });
  });

  it('bls_get_series keeps the year-range move beside an OEWS row when another ID has no data for the period', async () => {
    const uncovered = (invalid: string) =>
      okJson({
        status: 'REQUEST_SUCCEEDED',
        responseTime: 1,
        message: [
          `Series does not exist for Series ${invalid}`,
          'No Data Available for Series WPUFD49104 Year: 2005',
        ],
        Results: {
          series: [
            { seriesID: 'WPUFD49104', data: [] },
            { seriesID: invalid, data: [] },
          ],
        },
      });
    const run = (invalid: string) =>
      runToolContract(
        blsGetSeriesTool,
        { series_ids: ['WPUFD49104', invalid], start_year: 2005, end_year: 2006 },
        seriesContext,
      );

    vi.mocked(globalThis.fetch).mockResolvedValue(uncovered('BOGUS123'));
    expect((await run('BOGUS123')).structuredContent).toMatchObject({
      error: {
        data: {
          recovery: {
            hint: 'Replace BOGUS123 with a valid SeriesID from bls_search_series, and adjust start_year/end_year to a range WPUFD49104 covers.',
          },
        },
      },
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(uncovered(METRO));
    const oews = await run(METRO);
    expect(oews.structuredContent).toMatchObject({
      error: {
        data: {
          recovery: {
            hint: `Adjust start_year/end_year to a range WPUFD49104 covers. ${METRO}: ${HINT}`,
          },
        },
      },
    });
    expect(contentText(oews)).toContain(`${METRO}: ${HINT}`);
  });

  it('bls_get_series names the OEWS row in the per-ID notice when another series returned data', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(answer([METRO, 'BOGUS123'], [NATIONAL]));
    const result = await runToolContract(
      blsGetSeriesTool,
      { series_ids: [NATIONAL, METRO, 'BOGUS123'] },
      seriesContext,
    );
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain(`BLS reports ${METRO} is invalid or does not exist. ${HINT}`);
    expect(notice).toContain(
      'BLS reports BOGUS123 is invalid or does not exist. Use bls_search_series to find a valid SeriesID.',
    );
    expect(contentText(result)).toContain(NATIONAL);
    expect(contentText(result)).toContain('request the national row');
  });

  it('bls_get_latest names the OEWS row for an unpublished OEWS ID, on both surfaces', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      Promise.resolve(String(url).includes(METRO) ? answer([METRO]) : answer(['BOGUS123'])),
    );
    const result = await runToolContract(
      blsGetLatestTool,
      { series_ids: [METRO, 'BOGUS123'] },
      latestContext,
    );
    expect(result.structuredContent).toMatchObject({
      succeeded: 0,
      failed: [{ seriesId: METRO }, { seriesId: 'BOGUS123' }],
      notice: `BOGUS123 failed. Use bls_search_series to verify that SeriesID. BLS reports ${METRO} is invalid or does not exist. ${HINT}`,
    });
    expect(contentText(result)).toContain('request the national row');
  });
});
