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
});
