/**
 * @fileoverview List BLS survey programs with their codes, descriptions, and
 * calculation-support metadata. Backed by the BLS /surveys API with monthly
 * caching; does not consume meaningful API quota.
 * @module mcp-server/tools/definitions/bls-list-surveys
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBlsApiService } from '@/services/bls-api/bls-api-service.js';

/**
 * Survey category tags used to group BLS programs for filtering. Codes are the
 * two-letter `survey_abbreviation` values from the BLS /surveys list. The
 * injuries family is partitioned by measure and year-vintage (CFOI fatal +
 * IIF/SOII nonfatal, across historical ranges), so it spans many codes.
 */
const CATEGORY_MAP: Record<string, string[]> = {
  prices: ['CU', 'PC', 'WP', 'AP', 'EI'],
  employment: ['CE', 'LN', 'LA', 'SM', 'SA', 'OE', 'JT'],
  wages: ['OE', 'EC', 'CI', 'NW'],
  productivity: ['PR', 'MP', 'IP', 'PI', 'PF'],
  injuries: [
    'CA',
    'CB',
    'CD',
    'CF',
    'CH',
    'CS',
    'FA',
    'FI',
    'FW',
    'HC',
    'HS',
    'II',
    'IS',
    'SH',
    'SI',
  ],
  time_use: ['TU'],
};

export const blsListSurveysTool = tool('bls_list_surveys', {
  title: 'List BLS Surveys',
  description:
    'List BLS survey programs with their abbreviation codes, full names, and metadata about calculation support and annual averages. Use to discover which survey covers a topic before calling bls_search_series. Optional category filter narrows results to prices, employment, wages, productivity, injuries, or time_use surveys.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'BLS rejected the configured BLS_API_KEY as invalid.',
      retryable: false,
      recovery:
        'Set BLS_API_KEY to a valid key and restart the server — register free at https://data.bls.gov/registrationEngine/. This is a configuration error: it does not clear at the UTC quota reset.',
    },
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'BLS /surveys API is unreachable or returns a non-200 response.',
      recovery: 'Retry after a short delay. If persistent, check BLS API status at api.bls.gov.',
    },
    {
      reason: 'serialization_failure',
      code: JsonRpcErrorCode.InternalError,
      when: 'BLS /surveys response cannot be parsed (malformed JSON or unexpected schema).',
      recovery:
        'This is a BLS API inconsistency — retry or use a known survey code directly with bls_search_series.',
    },
  ],

  input: z.object({
    category: z
      .enum(['prices', 'employment', 'wages', 'productivity', 'injuries', 'time_use'])
      .optional()
      .describe(
        'Optional category filter. One of: prices, employment, wages, productivity, injuries, time_use. Omit to list all surveys.',
      ),
  }),

  output: z.object({
    surveys: z
      .array(
        z
          .object({
            abbreviation: z
              .string()
              .describe('Two-character survey abbreviation (e.g. CU, CE, LN).'),
            name: z.string().describe('Full survey name (e.g. CPI - All Urban Consumers).'),
            allowsNetChange: z
              .boolean()
              .describe(
                'True when the survey supports BLS-computed net change via calculations=true.',
              ),
            allowsPercentChange: z
              .boolean()
              .describe(
                'True when the survey supports BLS-computed percent change via calculations=true.',
              ),
            hasAnnualAverages: z
              .boolean()
              .describe(
                'True when BLS reports that the survey publishes annual average observations. Advisory only: it does not predict whether a given series returns annual-average rows for bls_get_series with annual_average=true — LN, CE, LA and SM report true yet return none. Read annualAverageRows on that response for what actually came back.',
              ),
          })
          .describe('A BLS survey program entry.'),
      )
      .describe('BLS survey programs matching the filter, sorted alphabetically by abbreviation.'),
    total: z.number().describe('Total surveys returned.'),
  }),

  enrichment: {
    categoryFilter: z
      .string()
      .optional()
      .describe('Category filter applied, if any. Absent when all surveys were listed.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_list_surveys', { category: input.category });
    const all = await getBlsApiService().listSurveys(ctx);

    const categoryAbbrs = input.category ? CATEGORY_MAP[input.category] : undefined;

    const filtered = all.filter((s) =>
      categoryAbbrs ? categoryAbbrs.includes(s.surveyAbbreviation.toUpperCase()) : true,
    );

    filtered.sort((a, b) => a.surveyAbbreviation.localeCompare(b.surveyAbbreviation));

    if (input.category !== undefined) ctx.enrich({ categoryFilter: input.category });

    return {
      surveys: filtered.map((s) => ({
        abbreviation: s.surveyAbbreviation,
        name: s.surveyName,
        allowsNetChange: s.allowsNetChange,
        allowsPercentChange: s.allowsPercentChange,
        hasAnnualAverages: s.hasAnnualAverages,
      })),
      total: filtered.length,
    };
  },

  format: (result) => {
    if (result.surveys.length === 0) {
      return [{ type: 'text', text: 'No surveys matched the filter.' }];
    }
    const lines: string[] = [`**${result.total} BLS survey(s):**\n`];
    for (const s of result.surveys) {
      const caps: string[] = [];
      if (s.allowsNetChange) caps.push('net change');
      if (s.allowsPercentChange) caps.push('% change');
      if (s.hasAnnualAverages) caps.push('annual avg');
      const capStr = caps.length > 0 ? ` · ${caps.join(', ')}` : '';
      lines.push(`**${s.abbreviation}** — ${s.name}${capStr}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
