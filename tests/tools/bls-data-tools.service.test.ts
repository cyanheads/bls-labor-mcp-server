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
vi.mock('@/services/bls-catalog/bls-catalog-service.js', () => ({
  getBlsCatalogService: () => state.catalog,
}));

import { blsGetLatestTool } from '@/mcp-server/tools/definitions/bls-get-latest.tool.js';
import { blsGetSeriesTool } from '@/mcp-server/tools/definitions/bls-get-series.tool.js';
import { initBlsApiService } from '@/services/bls-api/bls-api-service.js';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mirrorRow(series_id: string, year: string, period: string, value: string) {
  return { row_key: `${series_id}|${year}|${period}`, series_id, year, period, value };
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
  state.config.observationsMirrorEnabled = false;
  state.mirror.queryBySeries.mockReset();
  state.mirror.queryLatest.mockReset();
  state.catalog.lookupByIds.mockReset();
  state.catalog.lookupByIds.mockResolvedValue(new Map());
  // The service reads everything it needs from the mocked server config.
  initBlsApiService({} as AppConfig, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(text).toContain('| 2025 | M03 | 4.4 |');
    expect(text).toContain('quota_exceeded');
    expect(text).toContain('UTC midnight');
    // The quota wall says nothing about the SeriesID, on this surface either.
    expect(text).not.toContain('bls_search_series');
  });

  it('names the message when the live failure has no reason', async () => {
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
    expect(notice).toContain('Unable to connect. (failed after 4 attempts)');
    expect(notice).not.toContain('bls_search_series');
    expect(contentText(result)).toContain('Unable to connect.');
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
