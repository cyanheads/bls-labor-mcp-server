/**
 * @fileoverview Tests for the mirror routing gate in BlsApiService — verifies
 * that when the mirror is disabled or not ready, the live API is called, and
 * when ready, the mirror is queried instead. Also covers partial-coverage
 * fallback, the not-ready-with-no-fallback error, and the live path still works.
 * @module tests/services/bls-observations/bls-observations-routing.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlsApiService } from '@/services/bls-api/bls-api-service.js';
import type { SeriesData } from '@/services/bls-api/types.js';

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

// Config mock — default: mirror disabled. vi.fn so tests can override per-case.
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    observationsMirrorEnabled: false,
    observationsMirrorFallbackLive: true,
  })),
}));

// Mirror service mock — default: service not ready
vi.mock('@/services/bls-observations/bls-observations-service.js', () => ({
  isBlsObservationsServiceReady: vi.fn().mockReturnValue(false),
  getBlsObservationsService: vi.fn().mockReturnValue({
    ready: vi.fn().mockResolvedValue(false),
    queryBySeries: vi.fn(),
    queryLatest: vi.fn(),
  }),
}));

// Catalog service mock — not loaded (metadata hydration skipped)
vi.mock('@/services/bls-catalog/bls-catalog-service.js', () => ({
  getBlsCatalogService: () => ({ isLoaded: false }),
}));

// Bypass withRetry — tests focus on routing, not retry logic
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...original, withRetry: (fn: () => Promise<unknown>) => fn() };
});

// ---------------------------------------------------------------------------
// Mock reference helpers
// ---------------------------------------------------------------------------

import { getServerConfig } from '@/config/server-config.js';
import {
  getBlsObservationsService,
  isBlsObservationsServiceReady,
} from '@/services/bls-observations/bls-observations-service.js';

type MockedMirror = {
  ready: ReturnType<typeof vi.fn>;
  queryBySeries: ReturnType<typeof vi.fn>;
  queryLatest: ReturnType<typeof vi.fn>;
};

function getMirror(): MockedMirror {
  return vi.mocked(getBlsObservationsService)() as unknown as MockedMirror;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const apiKey = 'test-key';
const baseUrl = 'https://api.bls.gov/publicAPI/v2';
const userAgent = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LIVE_RESPONSE = {
  status: 'REQUEST_SUCCEEDED',
  responseTime: 50,
  message: [],
  Results: {
    series: [
      {
        seriesID: 'LNS14000000',
        catalog: { series_title: 'Unemployment Rate', seasonality: 'Seasonally Adjusted' },
        data: [
          { year: '2024', period: 'M12', periodName: 'December', value: '4.1', footnotes: [] },
        ],
      },
    ],
  },
};

const LIVE_CES_RESPONSE = {
  status: 'REQUEST_SUCCEEDED',
  responseTime: 50,
  message: [],
  Results: {
    series: [
      {
        seriesID: 'CES0000000001',
        catalog: { series_title: 'Total Nonfarm' },
        data: [{ year: '2024', period: 'M12', value: '159367', footnotes: [] }],
      },
    ],
  },
};

/** One mirror row, shaped as the store returns it. */
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

const MIRROR_OBS = [mirrorRow('LNS14000000', '2024', 'M12', '4.1')];

/** A minimal live batch response echoing one requested SeriesID with one row. */
function liveResponse(seriesId: string): Response {
  return okJson({
    status: 'REQUEST_SUCCEEDED',
    responseTime: 50,
    message: [],
    Results: {
      series: [{ seriesID: seriesId, data: [{ year: '2024', period: 'M06', value: '9.9' }] }],
    },
  });
}

// ---------------------------------------------------------------------------
// Group 1: Mirror disabled — live API always called
// ---------------------------------------------------------------------------

describe('fetchSeries — mirror DISABLED', () => {
  beforeEach(() => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: false,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(false);
  });

  it('calls live API when mirror is disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(LIVE_RESPONSE));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result[0]?.seriesId).toBe('LNS14000000');
    expect(getMirror().queryBySeries).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Group 2: Mirror enabled but NOT ready — falls back to live
// ---------------------------------------------------------------------------

describe('fetchSeries — mirror ENABLED but NOT READY', () => {
  beforeEach(() => {
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(false);
  });

  it('falls back to live API when mirror is not ready and fallback is true', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(LIVE_RESPONSE));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result[0]?.seriesId).toBe('LNS14000000');
    expect(getMirror().queryBySeries).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('throws serviceUnavailable when mirror not ready and fallback is false', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: false,
    } as ReturnType<typeof getServerConfig>);

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx)).rejects.toMatchObject({
      data: { reason: 'service_unavailable' },
    });
  });
});

// ---------------------------------------------------------------------------
// Group 3: Mirror READY — served from mirror
// ---------------------------------------------------------------------------

describe('fetchSeries — mirror READY', () => {
  beforeEach(() => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(true);
    getMirror().queryBySeries.mockResolvedValue({
      observations: MIRROR_OBS,
      complete: true,
      missedIds: [],
    });
  });

  it('queries mirror and does NOT call live API when mirror is ready and complete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx);

    // Live API must NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getMirror().queryBySeries).toHaveBeenCalledWith(
      expect.objectContaining({ seriesIds: ['LNS14000000'] }),
    );
    expect(result[0]?.seriesId).toBe('LNS14000000');
    expect(result[0]?.observations[0]?.value).toBe('4.1');

    fetchSpy.mockRestore();
  });

  it('forwards annual_average to the mirror so both paths answer alike (#53)', async () => {
    // LABSTAT bakes annual-average rows in unconditionally; without the flag the
    // mirror would answer an identical request with rows the live path omits.
    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    await svc.fetchSeries({ seriesIds: ['LNS14000000'], annualAverage: true }, ctx);

    expect(getMirror().queryBySeries).toHaveBeenCalledWith(
      expect.objectContaining({ annualAverage: true }),
    );
  });

  it('tells the mirror annualAverage:false when the caller did not ask', async () => {
    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    await svc.fetchSeries({ seriesIds: ['LNS14000000'], startYear: 2023 }, ctx);

    expect(getMirror().queryBySeries).toHaveBeenCalledWith(
      expect.objectContaining({ annualAverage: false }),
    );
  });

  it('carries annual_average into the live fallback for missed IDs', async () => {
    getMirror().queryBySeries.mockResolvedValue({
      observations: MIRROR_OBS,
      complete: false,
      missedIds: ['CUUR0000SA0'],
    });
    let body: Record<string, unknown> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(okJson(LIVE_CES_RESPONSE));
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    await svc.fetchSeries({ seriesIds: ['LNS14000000', 'CUUR0000SA0'], annualAverage: true }, ctx);

    expect(body.annualaverage).toBe(true);

    fetchSpy.mockRestore();
  });

  it('falls back to live for missed IDs when mirror is partially complete', async () => {
    getMirror().queryBySeries.mockResolvedValue({
      observations: MIRROR_OBS,
      complete: false,
      missedIds: ['CES0000000001'],
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(LIVE_CES_RESPONSE));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchSeries({ seriesIds: ['LNS14000000', 'CES0000000001'] }, ctx);

    // Live was called only for the missed ID
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.length).toBe(2);
    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['LNS14000000', 'CES0000000001']);

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Group 3b: Mirror READY — request-order reconciliation (#73)
// ---------------------------------------------------------------------------

describe('fetchSeries — mirror-routed request order (#73)', () => {
  beforeEach(() => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(true);
    getMirror().queryBySeries.mockReset();
  });

  function disableFallback(): void {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: false,
    } as ReturnType<typeof getServerConfig>);
  }

  it('returns a fully mirrored batch in request order, not newest-year-first', async () => {
    // The store sorts year DESC and the row grouping preserves that, so the
    // 2025 series led the 2020 one however the caller asked for them.
    getMirror().queryBySeries.mockResolvedValue({
      observations: [
        mirrorRow('HIT_NEW', '2025', 'M01', '2.0'),
        mirrorRow('HIT_OLD', '2020', 'M01', '1.0'),
      ],
      complete: true,
      missedIds: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries(
      { seriesIds: ['HIT_OLD', 'HIT_NEW'] },
      createMockContext(),
    );

    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['HIT_OLD', 'HIT_NEW']);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('places a live-fallback result at its requested position', async () => {
    getMirror().queryBySeries.mockResolvedValue({
      observations: [mirrorRow('HIT_NEW', '2025', 'M01', '2.0')],
      complete: false,
      missedIds: ['MISS'],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(liveResponse('MISS'));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries({ seriesIds: ['MISS', 'HIT_NEW'] }, createMockContext());

    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['MISS', 'HIT_NEW']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result[0]!.observations).toHaveLength(1);

    fetchSpy.mockRestore();
  });

  it('keeps an unresolved ID as a zero-observation entry when fallback is off', async () => {
    disableFallback();
    getMirror().queryBySeries.mockResolvedValue({
      observations: [mirrorRow('HIT_NEW', '2025', 'M01', '2.0')],
      complete: false,
      missedIds: ['MISS'],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries({ seriesIds: ['MISS', 'HIT_NEW'] }, createMockContext());

    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['MISS', 'HIT_NEW']);
    expect(result[0]!.observations).toEqual([]);
    // A mirror miss is a fact about the local store, not a BLS advisory (#59).
    expect(result[0]).not.toHaveProperty('failure');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('answers an all-missed batch with one zero-observation entry per position', async () => {
    disableFallback();
    getMirror().queryBySeries.mockResolvedValue({
      observations: [],
      complete: false,
      missedIds: ['MISS_A', 'MISS_B'],
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries({ seriesIds: ['MISS_A', 'MISS_B'] }, createMockContext());

    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['MISS_A', 'MISS_B']);
    expect(result.every((s: SeriesData) => s.observations.length === 0)).toBe(true);
  });

  it('gives a series the annual-average filter emptied its position, spending no live query', async () => {
    // Coverage is judged before the filter, so ANNUAL0 is in neither missedIds
    // nor observations — a fallback would re-ask for rows the caller declined.
    getMirror().queryBySeries.mockResolvedValue({
      observations: [mirrorRow('HIT_NEW', '2025', 'M01', '2.0')],
      complete: true,
      missedIds: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries(
      { seriesIds: ['ANNUAL0', 'HIT_NEW'] },
      createMockContext(),
    );

    expect(result.map((s: SeriesData) => s.seriesId)).toEqual(['ANNUAL0', 'HIT_NEW']);
    expect(result[0]!.observations).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('returns one entry per requested position for duplicate and single-ID requests', async () => {
    getMirror().queryBySeries.mockResolvedValue({
      observations: [mirrorRow('HIT_NEW', '2025', 'M01', '2.0')],
      complete: true,
      missedIds: [],
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    const duplicated = await svc.fetchSeries({ seriesIds: ['HIT_NEW', 'HIT_NEW'] }, ctx);
    expect(duplicated.map((s: SeriesData) => s.seriesId)).toEqual(['HIT_NEW', 'HIT_NEW']);

    const single = await svc.fetchSeries({ seriesIds: ['HIT_NEW'] }, ctx);
    expect(single.map((s: SeriesData) => s.seriesId)).toEqual(['HIT_NEW']);
  });
});

// ---------------------------------------------------------------------------
// Group 4: fetchLatest — mirror routing
// ---------------------------------------------------------------------------

describe('fetchLatest — mirror routing gate', () => {
  beforeEach(() => {
    getMirror().ready.mockResolvedValue(false);
    getMirror().queryLatest.mockReset();
  });

  it('calls live API when mirror is disabled', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: false,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(false);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(LIVE_RESPONSE));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchLatest('LNS14000000', ctx);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.seriesId).toBe('LNS14000000');
    expect(getMirror().queryLatest).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('queries mirror for fetchLatest when ready, skips live', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(true);
    getMirror().queryLatest.mockResolvedValue({
      observations: MIRROR_OBS,
      complete: true,
      missedIds: [],
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchLatest('LNS14000000', ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getMirror().queryLatest).toHaveBeenCalledWith(['LNS14000000']);
    expect(result.seriesId).toBe('LNS14000000');

    fetchSpy.mockRestore();
  });

  it('falls back to live for fetchLatest when series not in mirror', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: true,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(true);
    getMirror().queryLatest.mockResolvedValue({
      observations: [],
      complete: false,
      missedIds: ['LNS14000000'],
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(LIVE_RESPONSE));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();
    const result = await svc.fetchLatest('LNS14000000', ctx);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.seriesId).toBe('LNS14000000');

    fetchSpy.mockRestore();
  });

  it('throws notFound for fetchLatest when series not in mirror and fallback disabled', async () => {
    vi.mocked(getServerConfig).mockReturnValue({
      observationsMirrorEnabled: true,
      observationsMirrorFallbackLive: false,
    } as ReturnType<typeof getServerConfig>);
    vi.mocked(isBlsObservationsServiceReady).mockReturnValue(true);
    getMirror().ready.mockResolvedValue(true);
    getMirror().queryLatest.mockResolvedValue({
      observations: [],
      complete: false,
      missedIds: ['MISSING000'],
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.fetchLatest('MISSING000', ctx)).rejects.toMatchObject({
      data: { reason: 'series_not_found' },
    });
  });
});
