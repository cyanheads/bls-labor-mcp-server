/**
 * @fileoverview Retry-behavior tests for BlsApiService. Deliberately kept in a
 * separate file from `bls-api-service.test.ts`, which mocks `withRetry` away at
 * file scope to keep parsing tests fast — that mock would make every assertion
 * here vacuous. These exercise the real framework retry loop to prove that
 * deterministic BLS failures fail fast instead of burning the daily quota on
 * doomed attempts.
 * @module tests/services/bls-api/bls-api-service-retry.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlsApiService } from '@/services/bls-api/bls-api-service.js';
import {
  GENERIC_REJECTION,
  LATEST_INVALID_WITHOUT_CATALOG,
  MIXED_INVALID_WITHOUT_CATALOG,
} from '../../fixtures/bls-live-responses.js';

const apiKey = 'test-key';
const baseUrl = 'https://api.bls.gov/publicAPI/v2';
const userAgent = 'test-bls-mcp/1.0 (casey@caseyjhand.com)';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** BLS reports quota exhaustion as a non-processed status, not an HTTP 429. */
const QUOTA_RESPONSE = {
  status: 'REQUEST_NOT_PROCESSED',
  responseTime: 10,
  message: ['Daily threshold of 500 queries reached'],
};

/** A genuinely transient failure — BLS releases the lock on its own. */
const LOCKED_RESPONSE = {
  status: 'REQUEST_FAILED_ERROR',
  responseTime: 10,
  message: ['The database is locked for this series'],
};

/** BLS rejects an unregistered key identically on every endpoint, /surveys included. */
const INVALID_KEY_RESPONSE = {
  status: 'REQUEST_NOT_PROCESSED',
  responseTime: 0,
  message: [
    'The key:FAKE0000000000000000000000000001 provided by the User is invalid. Please provide a proper key for the operation to be successful',
  ],
  Results: {},
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected unmocked BLS request'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A body which has already delivered bytes but never finishes until aborted. */
function stalledBody(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

const operations = {
  series: (svc: BlsApiService, ctx: ReturnType<typeof createMockContext>) =>
    svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx),
  latest: (svc: BlsApiService, ctx: ReturnType<typeof createMockContext>) =>
    svc.fetchLatest('LNS14000000', ctx),
  surveys: (svc: BlsApiService, ctx: ReturnType<typeof createMockContext>) => svc.listSurveys(ctx),
};

describe('BLS live transport classification and operation budget', () => {
  it('does not start a retry whose backoff outlasts the remaining operation budget', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(new Response('unavailable', { status: 500 }));
        }),
    );
    const pending = operations
      .series(new BlsApiService(apiKey, baseUrl, userAgent), createMockContext())
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(44_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ data: { reason: 'upstream_timeout', status: 500 } });
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body', 'backoff', 'reissue'])(
    'preserves caller cancellation identity during %s',
    async (phase) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const reason = new Error('caller explicitly cancelled BLS');
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const signal = init!.signal!;
        if (phase === 'backoff') return Promise.resolve(new Response('', { status: 500 }));
        if (phase === 'body' || phase === 'reissue') return Promise.resolve(stalledBody(signal));
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      });
      if (phase === 'reissue') spy.mockResolvedValueOnce(okJson(GENERIC_REJECTION));
      const pending = operations
        .series(
          new BlsApiService(apiKey, baseUrl, userAgent),
          createMockContext({ signal: caller.signal }),
        )
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      const count = phase === 'reissue' ? 2 : 1;
      expect(spy).toHaveBeenCalledTimes(count);
      caller.abort(reason);
      expect(await pending).toBe(reason);
      await vi.runAllTimersAsync();
      expect(spy).toHaveBeenCalledTimes(count);
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    'retries HTTP %i before interpreting a successful envelope',
    async (status) => {
      vi.useFakeTimers();
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [] } }), {
            status,
          }),
        ),
      );
      const pending = operations
        .series(new BlsApiService(apiKey, baseUrl, userAgent), createMockContext())
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        data: { reason: 'service_unavailable', status, retryable: true },
      });
      expect(spy).toHaveBeenCalledTimes(4);
    },
  );

  it.each([400, 401, 403, 404, 501])(
    'does not retry nontransient HTTP %i or interpret its body',
    async (status) => {
      vi.useFakeTimers();
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() =>
          Promise.resolve(new Response('<html>key: test-key</html>', { status })),
        );
      const pending = operations
        .series(new BlsApiService(apiKey, baseUrl, userAgent), createMockContext())
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({
        data: { reason: 'service_unavailable', status, retryable: false },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error)).not.toContain('test-key');
    },
  );

  it('normalizes transport errors without leaking their URL, key, or raw message', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('socket reset https://host/?registrationkey=test-key'));
    const pending = operations
      .series(new BlsApiService(apiKey, baseUrl, userAgent), createMockContext())
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toMatchObject({ data: { reason: 'service_unavailable', retryable: true } });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(error)).not.toMatch(/registrationkey|test-key|socket reset/);
  });

  it.each(Object.entries(operations))(
    '%s classifies complete malformed JSON without retrying',
    async (_name, invoke) => {
      vi.useFakeTimers();
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(new Response('{broken')));
      const pending = invoke(
        new BlsApiService(apiKey, baseUrl, userAgent),
        createMockContext(),
      ).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        data: { reason: 'serialization_failure', retryable: false },
      });
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    Object.entries(operations).flatMap(([name, invoke]) =>
      ['headers', 'body'].map((phase) => ({ name, invoke, phase })),
    ),
  )('$name bounds stalled $phase to the total 45s budget', async ({ invoke, phase }) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let completed = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init!.signal!;
      if (phase === 'body') return Promise.resolve(stalledBody(signal));
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    const pending = invoke(
      new BlsApiService(apiKey, baseUrl, userAgent),
      createMockContext({ signal: caller.signal }),
    )
      .catch((error: unknown) => error)
      .then((value) => {
        completed = true;
        return value;
      });
    try {
      await vi.advanceTimersByTimeAsync(44_999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);
      expect(await pending).toMatchObject({ data: { reason: 'upstream_timeout' } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      caller.abort();
      await pending;
    }
  });

  it('shares the original deadline with the catalog-less reissue', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let completeFirst!: () => void;
    let completed = false;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeFirst = () => resolve(okJson(GENERIC_REJECTION));
          }),
      )
      .mockImplementation((_url, init) => Promise.resolve(stalledBody(init!.signal!)));
    const pending = operations
      .series(
        new BlsApiService(apiKey, baseUrl, userAgent),
        createMockContext({ signal: caller.signal }),
      )
      .catch((error: unknown) => error)
      .then((value) => {
        completed = true;
        return value;
      });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      completeFirst();
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(completed).toBe(true);
      expect(await pending).toMatchObject({ data: { reason: 'upstream_timeout' } });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      caller.abort();
      await pending;
    }
  });
});

describe('BlsApiService — retry behavior (real withRetry)', () => {
  it('keeps an empty successful batch distinct from a rejected request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({
        status: 'REQUEST_SUCCEEDED',
        message: [],
        Results: { series: [] },
      }),
    );
    await expect(
      new BlsApiService(apiKey, baseUrl, userAgent).fetchSeries(
        { seriesIds: ['LNS14000000'] },
        createMockContext(),
      ),
    ).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('fails fast on quota_exceeded — exactly one request, no retries (#47)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(QUOTA_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded', retryable: false },
    });

    // The whole point: retrying a quota rejection burns more of the exhausted quota.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails fast on quota_exceeded via fetchLatest — exactly one request (#47)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(QUOTA_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.fetchLatest('LNS14000000', ctx)).rejects.toMatchObject({
      data: { reason: 'quota_exceeded', retryable: false },
    });

    // bls_get_latest fans out one fetchLatest per series, so per-call waste multiplies.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails fast on request_rejected — one catalog-free re-issue, then no retries (#48, #81)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(okJson(GENERIC_REJECTION));
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(
      svc.fetchSeries(
        {
          seriesIds: ['LNS14000000', 'BOGUS123'],
          startYear: 2025,
          endYear: 2025,
          calculations: true,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      data: { reason: 'request_rejected', retryable: false },
    });

    // The generic answer is catalog-correlated, so it earns exactly one re-issue
    // without catalog metadata; a second generic answer is final.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const { catalog, ...rest } = bodies[0]!;
    expect(catalog).toBe(true);
    expect(bodies[1]).toEqual(rest);
  });

  it('keeps the valid series when a generic rejection yields to a per-series answer (#81)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(GENERIC_REJECTION))
      .mockResolvedValueOnce(okJson(MIXED_INVALID_WITHOUT_CATALOG));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries(
      { seriesIds: ['LNS14000000', 'BOGUS123'], startYear: 2025, endYear: 2025 },
      createMockContext(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.map((s) => s.seriesId)).toEqual(['LNS14000000', 'BOGUS123']);
    expect(result[0]!.observations).toHaveLength(12);
    expect(result[1]).toMatchObject({
      observations: [],
      failure: { reason: 'series_not_found', message: 'Invalid Series for Series BOGUS123' },
    });
  });

  it('re-issues a generic latest GET once without catalog=true (#81)', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((url) => {
        urls.push(String(url));
        return Promise.resolve(okJson(GENERIC_REJECTION));
      })
      .mockImplementationOnce((url) => {
        urls.push(String(url));
        return Promise.resolve(okJson(LATEST_INVALID_WITHOUT_CATALOG));
      });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const error = await svc.fetchLatest('BOGUS123', createMockContext()).catch((e: unknown) => e);

    expect(error).toMatchObject({ data: { reason: 'series_not_found' } });
    expect((error as Error).message).toContain('Invalid Series for Series BOGUS123');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('&catalog=true');
    expect(urls[1]).not.toContain('catalog');
    expect(urls[1]).toBe(urls[0]!.replace('&catalog=true', ''));
  });

  it('stays request_rejected on fetchLatest when both answers are generic — no third request (#81)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(GENERIC_REJECTION)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    await expect(svc.fetchLatest('BOGUS123', createMockContext())).rejects.toMatchObject({
      data: { reason: 'request_rejected', retryable: false },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('never re-issues into a cancelled request (#81)', async () => {
    const controller = new AbortController();
    let sent = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      // Behave like the real fetch: an aborted signal rejects before any request.
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      sent++;
      controller.abort();
      return Promise.resolve(okJson(GENERIC_REJECTION));
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const error = await svc
      .fetchSeries(
        { seriesIds: ['LNS14000000', 'BOGUS123'] },
        createMockContext({ signal: controller.signal }),
      )
      .catch((e: unknown) => e);

    expect((error as Error).name).toBe('AbortError');
    expect(sent).toBe(1);
  });

  it('sends exactly one request, with catalog metadata, when the first answer succeeds (#81)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(
        okJson({
          status: 'REQUEST_SUCCEEDED',
          responseTime: 10,
          message: [],
          Results: {
            series: [
              { seriesID: 'LNS14000000', data: [{ year: '2025', period: 'M01', value: '4.0' }] },
            ],
          },
        }),
      );
    });

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const result = await svc.fetchSeries({ seriesIds: ['LNS14000000'] }, createMockContext());

    expect(result[0]!.observations).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.catalog).toBe(true);
  });

  it('sends exactly one request when the first answer names the failing series (#81)', async () => {
    // A per-series advisory is a classified answer, not the generic rejection.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        okJson({
          status: 'REQUEST_SUCCEEDED',
          responseTime: 10,
          message: ['Invalid Series for Series BOGUS123'],
          Results: { series: [{ seriesID: 'BOGUS123', data: [] }] },
        }),
      ),
    );

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    await expect(
      svc.fetchSeries({ seriesIds: ['BOGUS123'] }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'series_not_found' } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends exactly one request when BLS rejects the configured key (#81)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(INVALID_KEY_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    await expect(
      svc.fetchSeries({ seriesIds: ['LNS14000000'] }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_api_key', retryable: false } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails fast on an invalid key from listSurveys — exactly one request (#56)', async () => {
    // listSurveys used to bucket this as a generic serviceUnavailable — a
    // transient code, so withRetry re-sent a key that cannot start working.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(INVALID_KEY_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.listSurveys(ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_api_key', retryable: false },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still retries series_locked to the full attempt budget — the fail-fast flag is not global', async () => {
    // Guards against over-applying `retryable: false`, and proves the assertions
    // above measure real retry behavior rather than a mocked-away withRetry.
    vi.useFakeTimers();
    // A fresh Response per call — a Response body can only be read once, and the
    // retry path reads one per attempt.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(LOCKED_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    const settled = svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toMatchObject({ data: { reason: 'series_locked' } });
    // withRetry defaults to maxRetries: 3 → 4 total attempts.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
