/**
 * @fileoverview Tests for bls_list_surveys tool.
 * @module tests/tools/bls-list-surveys.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blsListSurveysTool } from '@/mcp-server/tools/definitions/bls-list-surveys.tool.js';

const MOCK_SURVEYS = [
  {
    surveyAbbreviation: 'CE',
    surveyName: 'Current Employment Statistics',
    allowsNetChange: true,
    allowsPercentChange: true,
    hasAnnualAverages: true,
  },
  {
    surveyAbbreviation: 'CU',
    surveyName: 'CPI - All Urban Consumers',
    allowsNetChange: false,
    allowsPercentChange: true,
    hasAnnualAverages: false,
  },
  {
    surveyAbbreviation: 'LN',
    surveyName: 'CPS - Labor Force Statistics',
    allowsNetChange: false,
    allowsPercentChange: false,
    hasAnnualAverages: false,
  },
];

const listSurveysMock = vi.fn();

vi.mock('@/services/bls-api/bls-api-service.js', () => ({
  getBlsApiService: () => ({ listSurveys: listSurveysMock }),
}));

describe('blsListSurveysTool', () => {
  beforeEach(() => {
    listSurveysMock.mockResolvedValue(MOCK_SURVEYS);
  });

  it('returns all surveys when no category filter is given', async () => {
    const ctx = createMockContext();
    const input = blsListSurveysTool.input.parse({});
    const result = await blsListSurveysTool.handler(input, ctx);

    expect(result.total).toBe(3);
    expect(result.surveys).toHaveLength(3);
    // Sorted alphabetically
    expect(result.surveys[0]!.abbreviation).toBe('CE');
  });

  it('filters by employment category', async () => {
    const ctx = createMockContext();
    const input = blsListSurveysTool.input.parse({ category: 'employment' });
    const result = await blsListSurveysTool.handler(input, ctx);

    // CE and LN are in the employment category map
    expect(result.surveys.every((s) => ['CE', 'LN'].includes(s.abbreviation))).toBe(true);
  });

  it('formats output with abbreviation and capability flags', () => {
    const output = {
      surveys: [
        {
          abbreviation: 'CE',
          name: 'Current Employment Statistics',
          allowsNetChange: true,
          allowsPercentChange: true,
          hasAnnualAverages: true,
        },
      ],
      total: 1,
    };
    const blocks = blsListSurveysTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CE');
    expect(text).toContain('net change');
  });
});

describe('blsListSurveysTool — additional coverage', () => {
  beforeEach(() => {
    listSurveysMock.mockResolvedValue(MOCK_SURVEYS);
  });

  it('returns empty list when no surveys match the category filter', async () => {
    // MOCK_SURVEYS contains CE, CU, LN — none are in the time_use category (TU only)
    const ctx = createMockContext();
    const input = blsListSurveysTool.input.parse({ category: 'time_use' });
    const result = await blsListSurveysTool.handler(input, ctx);

    expect(result.surveys).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('sorts surveys alphabetically by abbreviation', async () => {
    const ctx = createMockContext();
    const input = blsListSurveysTool.input.parse({});
    const result = await blsListSurveysTool.handler(input, ctx);

    // Verify ascending alphabetical order
    const abbrs = result.surveys.map((s) => s.abbreviation);
    const sorted = [...abbrs].sort((a, b) => a.localeCompare(b));
    expect(abbrs).toEqual(sorted);
  });

  it('formats output without capability caps for a survey with no capabilities', () => {
    const output = {
      surveys: [
        {
          abbreviation: 'JT',
          name: 'JOLTS',
          allowsNetChange: false,
          allowsPercentChange: false,
          hasAnnualAverages: false,
        },
      ],
      total: 1,
    };
    const blocks = blsListSurveysTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('JT');
    // No capability annotation should appear for a survey with no capabilities
    expect(text).not.toContain('net change');
    expect(text).not.toContain('% change');
    expect(text).not.toContain('annual avg');
  });

  it('formats empty result with "No surveys matched" message', () => {
    const output = { surveys: [], total: 0 };
    const blocks = blsListSurveysTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No surveys');
  });

  it('returns total equal to surveys array length', async () => {
    const ctx = createMockContext();
    const input = blsListSurveysTool.input.parse({});
    const result = await blsListSurveysTool.handler(input, ctx);

    expect(result.total).toBe(result.surveys.length);
  });

  it('formats output with all three capability flags', () => {
    const output = {
      surveys: [
        {
          abbreviation: 'CE',
          name: 'Current Employment Statistics',
          allowsNetChange: true,
          allowsPercentChange: true,
          hasAnnualAverages: true,
        },
      ],
      total: 1,
    };
    const blocks = blsListSurveysTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('net change');
    expect(text).toContain('% change');
    expect(text).toContain('annual avg');
  });
});

describe('blsListSurveysTool — error contracts', () => {
  beforeEach(() => {
    listSurveysMock.mockReset();
  });

  it('propagates service_unavailable with data.reason when listSurveys rejects', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    listSurveysMock.mockRejectedValue(
      serviceUnavailable('BLS surveys API returned HTML instead of JSON — likely rate-limited.', {
        reason: 'service_unavailable',
      }),
    );

    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({});

    await expect(blsListSurveysTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'service_unavailable' },
    });
  });

  it('propagates serialization_failure with data.reason when listSurveys rejects with parse error', async () => {
    const { serializationError } = await import('@cyanheads/mcp-ts-core/errors');
    listSurveysMock.mockRejectedValue(
      serializationError('Failed to parse BLS surveys response as JSON', {
        reason: 'serialization_failure',
      }),
    );

    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({});

    await expect(blsListSurveysTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'serialization_failure' },
    });
  });
});
