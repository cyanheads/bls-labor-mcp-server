/**
 * @fileoverview Search the BLS series catalog by natural language, survey,
 * geographic area, or keywords. Operates entirely offline against the LABSTAT
 * flat-file index loaded at startup — no API quota consumed.
 * @module mcp-server/tools/definitions/bls-search-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';

export const blsSearchSeriesTool = tool('bls_search_series', {
  title: 'Search BLS Series',
  description:
    'Search the BLS series catalog by natural language query, survey code, geographic area, or keywords to resolve cryptic SeriesIDs. Returns matching series with decoded components (survey, area, item, seasonal flag) and plain-language names. Use this before bls_get_series when you have a concept but not a SeriesID. Operates offline — no API quota consumed. Survey filter accepts two-letter codes (CU, CE, LN, LA, PC, JT, OE, EC, PR). Area filter accepts state names, MSA names, or FIPS area codes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.InternalError,
      when: 'The catalog index failed to load at startup.',
      recovery:
        'Restart the server to retry catalog loading. Check BLS_CATALOG_BASE_URL if using a custom mirror.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .refine((s) => s.trim().length > 0, { message: 'query must not be blank' })
      .describe(
        'Natural language or keyword query (e.g. "unemployment rate", "CPI food", "nonfarm payrolls"). Also accepts a SeriesID directly for exact lookup.',
      ),
    survey: z
      .string()
      .optional()
      .describe(
        'Two-letter LABSTAT survey abbreviation to filter results (e.g. CU for CPI, CE for CES, LN for CPS, LA for LAUS, JT for JOLTS, OE for OEWS). Omit to search all loaded surveys.',
      ),
    area: z
      .string()
      .optional()
      .describe(
        'State name, MSA name, or FIPS area code to narrow results to a geographic area. Omit for national series.',
      ),
    seasonal_adjustment: z
      .boolean()
      .optional()
      .describe(
        'When true, return only seasonally adjusted series. When false, return only not-seasonally-adjusted. Omit to return both.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (1–50, default 10).'),
  }),

  output: z.object({
    series: z
      .array(
        z
          .object({
            seriesId: z
              .string()
              .describe('BLS SeriesID — pass to bls_get_series or bls_get_latest to fetch data.'),
            title: z.string().describe('Plain-language series name.'),
            survey: z.string().describe('Survey abbreviation (e.g. CU, CE, LN).'),
            areaName: z.string().optional().describe('Geographic area name, when decoded.'),
            itemName: z.string().optional().describe('Item or subject name, when decoded.'),
            seasonal: z.boolean().describe('True when seasonally adjusted.'),
          })
          .describe('A matching BLS series entry.'),
      )
      .describe('Matching series, ordered by relevance.'),
  }),

  enrichment: {
    totalFound: z.number().describe('Total matches in the catalog before the limit was applied.'),
    catalogSize: z
      .number()
      .describe(
        'Total series in the loaded catalog index. Distinguishes an empty-result search from a failed catalog load.',
      ),
    effectiveQuery: z
      .string()
      .describe(
        'Query string as the server received and searched on. Confirms interpretation for self-correction.',
      ),
    surveyFilter: z
      .string()
      .optional()
      .describe('Survey filter applied, if any. Absent when no survey filter was passed.'),
    areaFilter: z
      .string()
      .optional()
      .describe('Area filter applied, if any. Absent when no area filter was passed.'),
    seasonalFilter: z
      .boolean()
      .optional()
      .describe('Seasonal-adjustment filter applied, if any. Absent when not passed.'),
    limitApplied: z.number().describe('Result limit in effect (defaults to 10 when omitted).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no results matched — e.g. how to broaden the query or remove filters. Absent when results are returned.',
      ),
  },

  handler(input, ctx) {
    ctx.log.info('Executing bls_search_series', {
      query: input.query,
      survey: input.survey,
      area: input.area,
    });

    const service = getBlsCatalogService();
    if (!service.isLoaded) {
      throw ctx.fail(
        'catalog_unavailable',
        'The BLS series catalog index has not been loaded. Server startup may have failed.',
        { ...ctx.recoveryFor('catalog_unavailable') },
      );
    }
    if (service.totalSeries === 0) {
      const detail = service.catalogLoadError ? ` ${service.catalogLoadError}` : '';
      throw ctx.fail(
        'catalog_unavailable',
        `The BLS series catalog loaded but is empty — all LABSTAT downloads failed at startup.${detail} Check BLS_CATALOG_BASE_URL and restart the server.`,
        { ...ctx.recoveryFor('catalog_unavailable') },
      );
    }

    const result = service.search({
      query: input.query,
      survey: input.survey,
      area: input.area,
      seasonal_adjustment: input.seasonal_adjustment,
      limit: input.limit,
    });

    ctx.enrich({
      totalFound: result.total,
      catalogSize: service.totalSeries,
      limitApplied: input.limit,
      ...(input.survey !== undefined && { surveyFilter: input.survey }),
      ...(input.area !== undefined && { areaFilter: input.area }),
      ...(input.seasonal_adjustment !== undefined && {
        seasonalFilter: input.seasonal_adjustment,
      }),
    });
    ctx.enrich.echo(input.query);
    if (result.series.length === 0) {
      const hasFilters =
        input.survey !== undefined ||
        input.area !== undefined ||
        input.seasonal_adjustment !== undefined;
      ctx.enrich.notice(
        hasFilters
          ? 'No matching series found. Try removing the survey/area/seasonal filter or broadening the query.'
          : 'No matching series found. Try broadening the query, checking spelling, or using a BLS SeriesID directly.',
      );
    }

    return {
      series: result.series.map((s) => ({
        seriesId: s.seriesId,
        title: s.title,
        survey: s.surveyAbbr,
        ...(s.areaName ? { areaName: s.areaName } : {}),
        ...(s.itemName ? { itemName: s.itemName } : {}),
        seasonal: s.seasonal,
      })),
    };
  },

  format: (result) => {
    if (result.series.length === 0) {
      return [{ type: 'text', text: 'No matching series found.' }];
    }
    const lines: string[] = [`**${result.series.length} series returned:**\n`];
    for (const s of result.series) {
      const parts: string[] = [`**${s.seriesId}**`];
      parts.push(`— ${s.title}`);
      if (s.areaName) parts.push(`· ${s.areaName}`);
      parts.push(s.seasonal ? '(seasonal adj.)' : '(not seasonal adj.)');
      parts.push(`[${s.survey}]`);
      lines.push(parts.join(' '));
      if (s.itemName) lines.push(`  _${s.itemName}_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
