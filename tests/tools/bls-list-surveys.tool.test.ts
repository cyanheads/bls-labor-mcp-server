/**
 * @fileoverview Tests for bls_list_surveys tool.
 * @module tests/tools/bls-list-surveys.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blsListSurveysTool,
  CATEGORY_MAP,
} from '@/mcp-server/tools/definitions/bls-list-surveys.tool.js';
import { SURVEY_CAPABILITIES } from '@/services/bls-api/bls-api-service.js';

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

vi.mock('@/services/bls-api/bls-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bls-api/bls-api-service.js')>()),
  getBlsApiService: () => ({ listSurveys: listSurveysMock }),
}));

describe('blsListSurveysTool', () => {
  beforeEach(() => {
    listSurveysMock.mockResolvedValue(MOCK_SURVEYS);
  });

  it('returns all surveys when no category filter is given', async () => {
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({});
    const result = await blsListSurveysTool.handler(input, ctx);

    expect(result.total).toBe(3);
    expect(result.surveys).toHaveLength(3);
    // Sorted alphabetically
    expect(result.surveys[0]!.abbreviation).toBe('CE');
    // No category filter → no echo (#29)
    expect(getEnrichment(ctx).categoryFilter).toBeUndefined();
  });

  it('filters by employment category', async () => {
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({ category: 'employment' });
    const result = await blsListSurveysTool.handler(input, ctx);

    // CE and LN are in the employment category map
    expect(result.surveys.every((s) => ['CE', 'LN'].includes(s.abbreviation))).toBe(true);
    // category filter echoed (#29)
    expect(getEnrichment(ctx).categoryFilter).toBe('employment');
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
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({ category: 'time_use' });
    const result = await blsListSurveysTool.handler(input, ctx);

    expect(result.surveys).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('sorts surveys alphabetically by abbreviation', async () => {
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
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
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
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

describe('blsListSurveysTool — CATEGORY_MAP correctness (#44)', () => {
  // Only `listSurveys` is mocked — the real CATEGORY_MAP does the category
  // filtering, so these assertions exercise the actual map, not a copy of it.
  // The fixture spans exactly the abbreviations under test; each survey code was
  // verified against the live BLS /surveys response.
  const mk = (surveyAbbreviation: string, surveyName: string) => ({
    surveyAbbreviation,
    surveyName,
    allowsNetChange: false,
    allowsPercentChange: false,
    hasAnnualAverages: false,
  });

  const CATEGORY_FIXTURE = [
    // Injury/illness family members + the wrongly-categorized IN.
    mk('IN', 'International Labor Comparison'),
    mk('IS', 'Occupational injuries and illnesses industry data'),
    mk('CF', 'Census of Fatal Occupational Injuries'),
    mk('HC', 'Nonfatal cases involving days away from work: Selected Characteristics (2002)'),
    // Employment + the phantom IC (absent from the live /surveys list).
    mk('CE', 'Employment, Hours, and Earnings from the Current Employment Statistics survey'),
    mk('IC', 'Phantom code — not present in the BLS /surveys response'),
    // Productivity: real PR/PI/PF + the phantom DI.
    mk('PR', 'Major Sector Productivity and Costs'),
    mk('PI', 'Industry Productivity Index'),
    mk('PF', 'Federal Government Productivity Index'),
    mk('DI', 'Phantom code — not present in the BLS /surveys response'),
  ];

  beforeEach(() => {
    listSurveysMock.mockResolvedValue(CATEGORY_FIXTURE);
  });

  const abbrsFor = async (category: 'injuries' | 'employment' | 'productivity') => {
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse({ category });
    const result = await blsListSurveysTool.handler(input, ctx);
    return result.surveys.map((s) => s.abbreviation);
  };

  it('injuries returns the injury/illness family and excludes IN (International Labor Comparison)', async () => {
    const abbrs = await abbrsFor('injuries');
    // Real injury/illness surveys (fatal CFOI + nonfatal IIF/SOII, incl. vintage HC).
    expect(abbrs).toEqual(expect.arrayContaining(['IS', 'CF', 'HC']));
    // IN is International Labor Comparison, not injuries — the pre-fix map returned it.
    expect(abbrs).not.toContain('IN');
  });

  it('employment excludes the phantom IC code', async () => {
    const abbrs = await abbrsFor('employment');
    expect(abbrs).toContain('CE');
    expect(abbrs).not.toContain('IC');
  });

  it('productivity includes PI and PF and excludes the phantom DI code', async () => {
    const abbrs = await abbrsFor('productivity');
    expect(abbrs).toEqual(expect.arrayContaining(['PR', 'PI', 'PF']));
    expect(abbrs).not.toContain('DI');
  });
});

describe('blsListSurveysTool — category coverage of the full survey inventory (#65)', () => {
  // SURVEY_CAPABILITIES holds the swept /surveys inventory: its keys are every
  // survey abbreviation BLS lists. Serving all of them makes the real map the
  // only thing deciding category membership.
  const INVENTORY = Object.keys(SURVEY_CAPABILITIES);
  const CATEGORIES = [
    'prices',
    'employment',
    'wages',
    'productivity',
    'injuries',
    'time_use',
  ] as const;

  beforeEach(() => {
    listSurveysMock.mockResolvedValue(
      INVENTORY.map((abbr) => ({
        surveyAbbreviation: abbr,
        surveyName: `Survey ${abbr}`,
        allowsNetChange: false,
        allowsPercentChange: false,
        hasAnnualAverages: false,
      })),
    );
  });

  const abbrsFor = async (category?: (typeof CATEGORIES)[number]) => {
    const ctx = createMockContext({ errors: blsListSurveysTool.errors });
    const input = blsListSurveysTool.input.parse(category ? { category } : {});
    const result = await blsListSurveysTool.handler(input, ctx);
    return result.surveys.map((s) => s.abbreviation);
  };

  it('sweeps the 70-survey inventory', () => {
    expect(INVENTORY).toHaveLength(70);
  });

  it('puts every inventory survey in at least one category', async () => {
    const covered = new Set<string>();
    for (const category of CATEGORIES) {
      for (const abbr of await abbrsFor(category)) covered.add(abbr);
    }
    expect(INVENTORY.filter((abbr) => !covered.has(abbr))).toEqual([]);
  });

  it('maps no code outside the inventory (no phantom codes)', () => {
    const inventory = new Set(INVENTORY);
    const mapped = Object.values(CATEGORY_MAP).flat();
    expect(mapped.filter((abbr) => !inventory.has(abbr))).toEqual([]);
    expect(Object.keys(CATEGORY_MAP).sort()).toEqual([...CATEGORIES].sort());
  });

  it.each([
    ['prices', ['CW', 'SU', 'CX', 'LI']],
    ['employment', ['EN', 'BD', 'OR', 'WS']],
    ['wages', ['CC', 'CM', 'LE', 'CE']],
  ] as const)('%s returns %j', async (category, expected) => {
    expect(await abbrsFor(category)).toEqual(expect.arrayContaining([...expected]));
  });

  it('lists IN under prices, employment, wages, and productivity, and not injuries', async () => {
    for (const category of ['prices', 'employment', 'wages', 'productivity'] as const) {
      expect(await abbrsFor(category)).toContain('IN');
    }
    expect(await abbrsFor('injuries')).not.toContain('IN');
  });

  it('keeps SA out of prices (#10) and OR out of wages', async () => {
    expect(await abbrsFor('prices')).not.toContain('SA');
    expect(await abbrsFor('wages')).not.toContain('OR');
  });

  it('returns every survey, unchanged, when unfiltered', async () => {
    expect(await abbrsFor()).toEqual([...INVENTORY].sort((a, b) => a.localeCompare(b)));
  });

  it('says in the category description that a survey can sit under several categories', () => {
    expect(blsListSurveysTool.input.shape.category.description).toMatch(/more than one category/);
  });

  it('says in the tool description that search covers only the offline index', () => {
    expect(blsListSurveysTool.description).toContain(
      'bls_search_series covers only the surveys in its offline index',
    );
  });
});
