/**
 * @fileoverview Mirror-path normalization tests for BlsApiService.
 * @module tests/services/bls-api/bls-api-mirror.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

const queryBySeries = vi.fn();

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    observationsMirrorEnabled: true,
    observationsMirrorFallbackLive: false,
  }),
}));

vi.mock('@/services/bls-observations/bls-observations-service.js', () => ({
  isBlsObservationsServiceReady: () => true,
  getBlsObservationsService: () => ({
    ready: () => Promise.resolve(true),
    queryBySeries,
  }),
}));

vi.mock('@/services/bls-catalog/bls-catalog-service.js', () => ({
  getBlsCatalogService: () => {
    throw new Error('catalog unavailable in mirror normalization test');
  },
}));

import { BlsApiService } from '@/services/bls-api/bls-api-service.js';

describe('BlsApiService mirror observation normalization', () => {
  it('marks the LABSTAT missing-value sentinel unavailable (#58)', async () => {
    queryBySeries.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [
        {
          row_key: 'LNS14000000|2025|M10',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M10',
          value: '-',
          footnote_codes: '9',
        },
      ],
    });

    const result = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['LNS14000000'], startYear: 2025, endYear: 2025 },
      createMockContext(),
    );

    expect(result[0]!.observations[0]).toMatchObject({
      value: '-',
      available: false,
      footnotes: ['9'],
    });
  });

  it('queries the mirror over the resolved window it was handed (#76)', async () => {
    // The handler resolves a one-sided range once, before the fetch options
    // exist, so the mirror and the live API read the same window — the mirror
    // must forward whichever bounds arrive rather than deriving its own.
    queryBySeries.mockResolvedValue({ complete: true, missedIds: [], observations: [] });

    await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['WPUFD49104'], annualAverage: false, startYear: 2000, endYear: 2019 },
      createMockContext(),
    );

    expect(queryBySeries).toHaveBeenCalledWith({
      seriesIds: ['WPUFD49104'],
      annualAverage: false,
      startYear: 2000,
      endYear: 2019,
    });
  });

  it('keeps normalization intact when the response is reconciled to request order (#73)', async () => {
    queryBySeries.mockResolvedValue({
      complete: false,
      missedIds: ['ABSENT001'],
      observations: [
        {
          row_key: 'LNS14000000|2025|M11',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M11',
          value: '4.2',
          footnote_codes: '',
        },
        {
          row_key: 'LNS14000000|2025|M10',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M10',
          value: '-',
          footnote_codes: '9',
        },
      ],
    });

    const result = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['ABSENT001', 'LNS14000000'], startYear: 2025, endYear: 2025 },
      createMockContext(),
    );

    expect(result.map((s) => s.seriesId)).toEqual(['ABSENT001', 'LNS14000000']);
    expect(result[0]!.observations).toEqual([]);
    expect(result[1]!.observations).toMatchObject([
      { period: 'M11', value: '4.2', available: true },
      { period: 'M10', value: '-', available: false, footnotes: ['9'] },
    ]);
  });
});
