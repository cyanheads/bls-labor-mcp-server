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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlsApiService } from '@/services/bls-api/bls-api-service.js';

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

/** The generic rejection BLS returns when it dislikes the request parameters. */
const REJECTED_RESPONSE = {
  status: 'REQUEST_FAILED_ERROR',
  responseTime: 10,
  message: [
    'Your request has failed. Please check your input parameters, and try your request again.',
  ],
};

/** A genuinely transient failure — BLS releases the lock on its own. */
const LOCKED_RESPONSE = {
  status: 'REQUEST_FAILED_ERROR',
  responseTime: 10,
  message: ['The database is locked for this series'],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BlsApiService — retry behavior (real withRetry)', () => {
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

  it('fails fast on request_rejected — exactly one request, no retries (#48)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(okJson(REJECTED_RESPONSE)));

    const svc = new BlsApiService(apiKey, baseUrl, userAgent);
    const ctx = createMockContext();

    await expect(svc.fetchSeries({ seriesIds: ['LNS14000000'] }, ctx)).rejects.toMatchObject({
      data: { reason: 'request_rejected', retryable: false },
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
