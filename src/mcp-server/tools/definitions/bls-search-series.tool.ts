/**
 * @fileoverview Search the BLS series catalog by natural language, survey,
 * geographic area, or keywords. Operates entirely offline against the LABSTAT
 * flat-file index loaded at startup — no API quota consumed.
 * @module mcp-server/tools/definitions/bls-search-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getBlsCatalogService,
  OES_SURVEY_ABBR,
  SURVEY_ABBRS,
} from '@/services/bls-catalog/bls-catalog-service.js';

/** The surveys a default deployment indexes, derived from the harvest list. */
const DEFAULT_SURVEY_CODES = SURVEY_ABBRS.filter((a) => a !== OES_SURVEY_ABBR)
  .map((a) => a.toUpperCase())
  .join(', ');

/** A filter value as applied: trimmed, with a blank value meaning no filter. */
function normalizeFilter(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export const blsSearchSeriesTool = tool('bls_search_series', {
  title: 'Search BLS Series',
  description: `Search the BLS series catalog by natural language query, survey code, geographic area, or keywords to resolve cryptic SeriesIDs. Returns matching series with decoded components (survey, area, item, seasonal flag) and plain-language names, ranked by relevance and paged with limit and offset. Use this before bls_get_series when you have a concept but not a SeriesID. Operates offline against an index of the major surveys — no API quota consumed. Survey filter accepts the two-letter code of an indexed survey (${DEFAULT_SURVEY_CODES}; OE only when the server sets BLS_CATALOG_INCLUDE_OES=true); series in other surveys are fetched by SeriesID with bls_get_series. Area filter accepts state names, MSA names, or FIPS area codes.`,
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
        `Two-letter LABSTAT survey abbreviation to filter results, case-insensitive (e.g. CU for CPI, CE for CES, LN for CPS, LA for LAUS, JT for JOLTS). Indexed surveys: ${DEFAULT_SURVEY_CODES}; OE (OEWS) only when the server sets BLS_CATALOG_INCLUDE_OES=true. Omit to search all indexed surveys.`,
      ),
    area: z
      .string()
      .optional()
      .describe(
        'State name, MSA name, or FIPS area code to narrow results to a geographic area — a case-insensitive substring of the area name, title, or SeriesID. Omit for national series, which then rank first among equal matches.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of ranked results to skip, for paging past the first page (default 0). Pass nextOffset from the previous response to get the next page.',
      ),
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
            area: z.string().optional().describe('Geographic area name, when decoded.'),
            item: z.string().optional().describe('Item or subject name, when decoded.'),
            seasonal: z
              .string()
              .describe(
                'Seasonality descriptor matching the data-tool form: "Seasonally Adjusted" or "Not Seasonally Adjusted".',
              ),
          })
          .describe('A matching BLS series entry.'),
      )
      .describe('Matching series, ordered by relevance.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total ranked results after every filter (area included), before limit and offset. A lower bound when capped is true — the catalog index may contain more matching series.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when ranked results remain past this page; nextOffset fetches them.'),
    shown: z.number().optional().describe('Number of series returned in this response.'),
    cap: z.number().optional().describe('The result limit that capped the returned list.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset of the next page. Present only when truncated is true.'),
    capped: z
      .boolean()
      .describe(
        'True when the FTS candidate pool, after the survey/area/seasonal filters, reached the internal cap (~1000). totalCount is then a lower bound and offset paging stops at the pool. Narrow the query, add filters, or use a direct SeriesID to get an exact count.',
      ),
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
      .describe(
        'Survey filter applied, trimmed and uppercased. Absent when no survey filter was passed or it was blank.',
      ),
    areaFilter: z
      .string()
      .optional()
      .describe(
        'Area filter applied, trimmed. Absent when no area filter was passed or it was blank.',
      ),
    seasonalFilter: z
      .boolean()
      .optional()
      .describe('Seasonal-adjustment filter applied, if any. Absent when not passed.'),
    limitApplied: z.number().describe('Result limit in effect (defaults to 10 when omitted).'),
    offsetApplied: z.number().describe('Offset in effect (defaults to 0 when omitted).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on the result: the survey is not in the offline index, the offset is past the last result, nothing matched, which offset fetches the next page, or, on the last page of a capped list, that other series may also match. Absent when this page ends an uncapped list with results.',
      ),
  },

  async handler(input, ctx) {
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

    const survey = normalizeFilter(input.survey)?.toUpperCase();
    const area = normalizeFilter(input.area);
    const { limit, offset } = input;
    const result = await service.search({
      query: input.query,
      survey,
      area,
      seasonal_adjustment: input.seasonal_adjustment,
      limit,
      offset,
    });
    const { total, capped } = result;
    const shown = result.series.length;
    const nextOffset = offset + shown < total ? offset + shown : undefined;

    ctx.enrich({
      capped,
      catalogSize: service.totalSeries,
      limitApplied: limit,
      offsetApplied: offset,
      ...(nextOffset !== undefined && { nextOffset }),
      ...(survey !== undefined && { surveyFilter: survey }),
      ...(area !== undefined && { areaFilter: area }),
      ...(input.seasonal_adjustment !== undefined && {
        seasonalFilter: input.seasonal_adjustment,
      }),
    });
    ctx.enrich.total(total);
    ctx.enrich.echo(input.query);

    // One notice per response — the framework keeps the last one written. A page
    // with results after it carries only the next-page guidance; otherwise the
    // precedence is un-indexed survey, offset past the end, no match, then the
    // capped-pool note on a last page.
    const range = `results ${offset + 1}–${offset + shown}`;
    if (nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance: `Showing ${range} of ${total}. Pass offset: ${nextOffset} for the next page.`,
      });
    } else if (survey !== undefined && !service.indexedSurveys.includes(survey)) {
      const oesHint =
        survey === OES_SURVEY_ABBR.toUpperCase() && !service.includeOes
          ? ' OE (OEWS) series are indexed only when the server sets BLS_CATALOG_INCLUDE_OES=true.'
          : '';
      ctx.enrich.notice(
        `Survey ${survey} has no series in the offline catalog index (indexed: ${service.indexedSurveys.join(', ')}). Use bls_list_surveys for valid codes; series in other surveys are fetchable by SeriesID via bls_get_series.${oesHint}`,
      );
    } else if (total > 0 && offset >= total) {
      ctx.enrich.notice(
        `Offset ${offset} is past the last of ${total} results. Pass an offset below ${total} (offset 0 is the first page).`,
      );
    } else if (total === 0) {
      const hasFilters =
        survey !== undefined || area !== undefined || input.seasonal_adjustment !== undefined;
      ctx.enrich.notice(
        hasFilters
          ? 'No matching series found. Try removing the survey/area/seasonal filter or broadening the query.'
          : 'No matching series found. Try broadening the query, checking spelling, or using a BLS SeriesID directly.',
      );
    } else if (capped) {
      ctx.enrich.notice(
        `Showing ${range}, the last of ${total} ranked candidates. The candidate pool is capped, so other series may also match. Narrow the query or add survey/area filters to reach them.`,
      );
    }

    return {
      series: result.series.map((s) => ({
        seriesId: s.seriesId,
        title: s.title,
        survey: s.surveyAbbr,
        ...(s.areaName ? { area: s.areaName } : {}),
        ...(s.itemName ? { item: s.itemName } : {}),
        seasonal: s.seasonal ? 'Seasonally Adjusted' : 'Not Seasonally Adjusted',
      })),
    };
  },

  format: (result) => {
    // The notice says why the page is empty: no match, an un-indexed survey, or
    // an offset past the last result.
    if (result.series.length === 0) {
      return [{ type: 'text', text: 'No series returned.' }];
    }
    const lines: string[] = [`**${result.series.length} series returned:**\n`];
    for (const s of result.series) {
      const parts: string[] = [`**${s.seriesId}**`];
      parts.push(`— ${s.title}`);
      if (s.area) parts.push(`· ${s.area}`);
      if (s.seasonal) parts.push(`(${s.seasonal})`);
      parts.push(`[${s.survey}]`);
      lines.push(parts.join(' '));
      if (s.item) lines.push(`  _${s.item}_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
