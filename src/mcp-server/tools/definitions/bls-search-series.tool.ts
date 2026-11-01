/**
 * @fileoverview Search the BLS series catalog by natural language, survey,
 * geographic area, or keywords. Operates entirely offline against the LABSTAT
 * flat-file index loaded at startup — no API quota consumed.
 * @module mcp-server/tools/definitions/bls-search-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { areaForm } from '@/services/bls-catalog/area-filter.js';
import {
  catalogSurveyAbbrs,
  getBlsCatalogService,
  OES_SURVEY_ABBR,
} from '@/services/bls-catalog/bls-catalog-service.js';
import { OEWS_COMPOSED_LIMIT } from '@/services/bls-catalog/oews-composition.js';

/** The surveys a default deployment indexes, derived from the catalog's harvest list. */
const DEFAULT_SURVEY_CODES = catalogSurveyAbbrs(false)
  .map((a) => a.toUpperCase())
  .join(', ');

/** A filter value as applied: trimmed, with a blank value meaning no filter. */
function normalizeFilter(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export const blsSearchSeriesTool = tool('bls_search_series', {
  title: 'Search BLS Series',
  description: `Search the BLS series catalog by natural language query, survey code, geographic area, or keywords to resolve cryptic SeriesIDs. Returns matching series with decoded components (survey, area, item, seasonal flag, and publication frequency for surveys that publish one series at several frequencies) and plain-language names, ranked by relevance and paged with limit and offset. Use this before bls_get_series when you have a concept but not a SeriesID. Operates offline against an index of the major surveys — no API quota consumed. Survey filter accepts the two-letter code of an indexed survey (${DEFAULT_SURVEY_CODES}; OE is indexed only when the server sets BLS_CATALOG_INCLUDE_OES=true, and otherwise composes OEWS SeriesIDs from the OE code tables, marked composed and unconfirmed); series in other surveys are fetched by SeriesID with bls_get_series. Area filter accepts place names, USPS state codes, and FIPS, CBSA, and CPI area codes.`,
  annotations: { readOnlyHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'catalog_loading',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The catalog index holds no series yet and a LABSTAT harvest is building it — at first startup, or while an hourly check retries an empty index.',
      recovery:
        'Retry this search shortly; the index answers once the harvest finishes. bls_get_series and bls_get_latest fetch a known SeriesID meanwhile.',
      retryable: true,
      severity: 'notice',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.InternalError,
      when: 'The catalog index holds no series and no harvest is running — every LABSTAT download failed, or the load stopped with an error.',
      recovery:
        'The hourly catalog check retries the harvest; restart the server to retry now, and check BLS_CATALOG_BASE_URL if it points at a custom mirror. bls_get_series fetches a known SeriesID meanwhile.',
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
        `Two-letter LABSTAT survey abbreviation to filter results, case-insensitive (e.g. CU for CPI, CE for CES, SM for state and metro CES, LN for CPS, LA for LAUS, JT for JOLTS). Indexed surveys: ${DEFAULT_SURVEY_CODES}; OE (OEWS) is indexed only when the server sets BLS_CATALOG_INCLUDE_OES=true, and without its rows OE composes OEWS SeriesIDs from the OE code tables for the occupation, place, and data type the query and area name, each marked composed. Omit to search all indexed surveys.`,
      ),
    area: z
      .string()
      .optional()
      .describe(
        'Geographic area to narrow results to, case-insensitive. A USPS state code (TX) or 2-digit state FIPS code (48) selects the state: its statewide series, the areas in it (metro areas reaching into it included), and series with no decoded area whose title names it. An all-digit area code selects the area it names in every survey that decodes it: 3 digits a combined statistical area (CSA), 4 a CPI area (0000 is the U.S. city average), 5 a county FIPS or metro area (CBSA) code, 7 a city or town (state + place FIPS); a code naming no indexed area returns no series. Any other value, such as a place name ("Seattle") or a SeriesID fragment ("ST48"), matches as a substring of the area name, title, or SeriesID; another all-digit value does too, with a notice. Under survey OE with no indexed OE rows, area selects the OEWS areas to compose: a USPS state code or 2-digit state FIPS names the state, a 5-digit CBSA or 7-digit OEWS area code (0042660, 5300000) its area, and any other value is a substring of an OEWS area name; each metro or state it names also composes its state and national rows. Without this filter, a place query names in full (every distinctive word of it, e.g. "black hawk") ranks first among the series matching every query word; otherwise, among equal matches, current series rank first, then national ones.',
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
      .default(10)
      .describe(
        'Maximum number of results to return (default 10); requests above 50 are clamped to 50 with notice.',
      ),
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
            startYear: z
              .number()
              .int()
              .optional()
              .describe(
                'First observation year in the catalog snapshot, when available; does not imply continuous coverage.',
              ),
            endYear: z
              .number()
              .int()
              .optional()
              .describe('Last observation year in the catalog snapshot, when available.'),
            endPeriod: z
              .string()
              .optional()
              .describe(
                'Last observation period code in the catalog snapshot, when available (e.g. M08 or Q04).',
              ),
            seasonal: z
              .string()
              .describe(
                'Seasonality descriptor matching the data-tool form: "Seasonally Adjusted" or "Not Seasonally Adjusted".',
              ),
            frequency: z
              .string()
              .optional()
              .describe(
                'Publication frequency — "Monthly", "Semi-Annual", "Quarterly", or "Annual" — for CU, CW, LN, and BD, which publish one series at several frequencies under the same title. Absent for other surveys.',
              ),
            composed: z
              .boolean()
              .optional()
              .describe(
                'True when the SeriesID was composed from the OEWS code tables rather than read from the index: unconfirmed until bls_get_series returns data for it, since BLS leaves many occupation–area cells unpublished. Composed rows carry no coverage years. Absent for indexed series.',
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
        'True when the FTS candidate pool, after the survey/area/seasonal filters, reached the internal cap (~1000), or when composing OEWS SeriesIDs stopped at its 50-row cap with combinations left. totalCount is then a lower bound and offset paging stops at the pool. Narrow the query, add filters, or use a direct SeriesID to get an exact count.',
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
        'Requested and applied limits when clamped, and how an all-digit area that is not an area code matched, plus guidance on unindexed surveys, offsets past the end, empty results, the next page, the capped candidate pool, or composed OEWS SeriesIDs, which stay unconfirmed until bls_get_series returns them. Absent when neither applies and this page ends an uncapped list of indexed series.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_search_series', {
      query: input.query,
      survey: input.survey,
      area: input.area,
    });

    const service = getBlsCatalogService();
    const readiness = service.readiness;
    if (readiness.status === 'loading') {
      throw ctx.fail(
        'catalog_loading',
        'The BLS series catalog index is still being built from the LABSTAT files and holds no series yet.',
      );
    }
    if (readiness.status === 'unavailable') {
      throw ctx.fail(
        'catalog_unavailable',
        `The BLS series catalog index holds no series and no harvest is running. ${readiness.error}`,
      );
    }

    const survey = normalizeFilter(input.survey)?.toUpperCase();
    const area = normalizeFilter(input.area);
    const { offset } = input;
    const limit = Math.min(input.limit, 50);
    const clampNotice =
      input.limit > limit ? `Requested limit=${input.limit}; applied limit=${limit}. ` : '';
    const fragmentNotice =
      area !== undefined && areaForm(area).kind === 'fragment'
        ? 'The all-digit area is not an area-code length, so it matched as a substring of the area name, title, or SeriesID. Area codes are 2 digits (state FIPS), 3 (CSA), 4 (CPI area), 5 (county FIPS or CBSA), or 7 (state + place FIPS); a USPS code such as TX also names a state. '
        : '';
    const prefix = `${clampNotice}${fragmentNotice}`;
    const notice = (message: string) => ctx.enrich.notice(`${prefix}${message}`);
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

    // One notice per response — prepend any clamp and all-digit-fragment
    // disclosure to the guidance. A page with results after it carries
    // next-page guidance; otherwise the precedence is un-indexed survey,
    // offset past the end, no match, then the capped-pool note on a last page.
    const range = `results ${offset + 1}–${offset + shown}`;
    if (result.composed) {
      // OEWS SeriesIDs composed from the OE code tables (#119). OE has no indexed
      // rows, so the un-indexed-survey branch below must not answer; truncated()
      // writes the paging fields and notice() the one message, last-wins.
      if (nextOffset !== undefined) ctx.enrich.truncated({ shown, cap: limit });
      if (total === 0) {
        notice(
          input.seasonal_adjustment
            ? 'OEWS publishes no seasonally adjusted series, so none was composed. Omit seasonal_adjustment or set it to false.'
            : 'No OEWS SeriesID was composed. Under survey OE the search builds SeriesIDs from the OE code tables, and nothing in them matched: name an occupation as BLS titles it (e.g. "registered nurses"), and give area as a state or metro name, a USPS state code or 2-digit state FIPS, 5-digit CBSA, or 7-digit OEWS area code.',
        );
      } else if (offset >= total) {
        notice(
          `Offset ${offset} is past the last of ${total} results. Pass an offset below ${total} (offset 0 is the first page).`,
        );
      } else {
        const paging =
          nextOffset !== undefined
            ? `Showing ${range} of ${total}. Pass offset: ${nextOffset} for the next page. `
            : '';
        const stopped = capped
          ? `Composition stops at ${OEWS_COMPOSED_LIMIT} rows, so other occupation, area, and data type combinations may also match; name the occupation, area, or data type more precisely to reach them. `
          : '';
        notice(
          `${paging}${stopped}These OEWS SeriesIDs are composed from the OE code tables, not read from the index, so each is unconfirmed: BLS leaves many occupation–area cells unpublished. One bls_get_series call checks them all; where it reports a metro or state ID nonexistent, request the state or national row for the same occupation and data type.`,
        );
      }
    } else if (nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance: `${prefix}Showing ${range} of ${total}. Pass offset: ${nextOffset} for the next page.`,
      });
    } else if (survey !== undefined && !service.indexedSurveys.includes(survey)) {
      const oesHint =
        survey === OES_SURVEY_ABBR.toUpperCase() && !service.includeOes
          ? ' OE (OEWS) series are indexed only when the server sets BLS_CATALOG_INCLUDE_OES=true.'
          : '';
      notice(
        `Survey ${survey} has no series in the offline catalog index (indexed: ${service.indexedSurveys.join(', ')}). Use bls_list_surveys for valid codes; series in other surveys are fetchable by SeriesID via bls_get_series.${oesHint}`,
      );
    } else if (total > 0 && offset >= total) {
      notice(
        `Offset ${offset} is past the last of ${total} results. Pass an offset below ${total} (offset 0 is the first page).`,
      );
    } else if (total === 0) {
      const hasFilters =
        survey !== undefined || area !== undefined || input.seasonal_adjustment !== undefined;
      notice(
        hasFilters
          ? 'No matching series found. Try removing the survey/area/seasonal filter or broadening the query.'
          : 'No matching series found. Try broadening the query, checking spelling, or using a BLS SeriesID directly.',
      );
    } else if (capped) {
      notice(
        `Showing ${range}, the last of ${total} ranked candidates. The candidate pool is capped, so other series may also match. Narrow the query or add survey/area filters to reach them.`,
      );
    } else if (prefix) {
      ctx.enrich.notice(prefix.trim());
    }

    return {
      series: result.series.map((s) => ({
        seriesId: s.seriesId,
        title: s.title,
        survey: s.surveyAbbr,
        ...(s.areaName ? { area: s.areaName } : {}),
        ...(s.itemName ? { item: s.itemName } : {}),
        seasonal: s.seasonal ? 'Seasonally Adjusted' : 'Not Seasonally Adjusted',
        ...(s.frequency ? { frequency: s.frequency } : {}),
        ...(s.startYear !== undefined ? { startYear: s.startYear } : {}),
        ...(s.endYear !== undefined ? { endYear: s.endYear } : {}),
        ...(s.endPeriod ? { endPeriod: s.endPeriod } : {}),
        ...(s.composed ? { composed: true } : {}),
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
      const parts: string[] = [`**${escapeMarkdownInline(s.seriesId)}**`];
      parts.push(`— ${escapeMarkdownInline(s.title)}`);
      if (s.area) parts.push(`· ${escapeMarkdownInline(s.area)}`);
      if (s.seasonal)
        parts.push(
          `(${[s.seasonal, ...(s.frequency ? [s.frequency] : [])].map(escapeMarkdownInline).join(', ')})`,
        );
      parts.push(`[${s.survey}]`);
      if (s.composed) parts.push('· composed (unconfirmed)');
      const coverage =
        s.startYear !== undefined && s.endYear !== undefined
          ? `${s.startYear}–${s.endYear}`
          : s.startYear !== undefined
            ? `from ${s.startYear}`
            : s.endYear !== undefined
              ? `through ${s.endYear}`
              : '';
      if (coverage || s.endPeriod)
        parts.push(
          `· Coverage: ${escapeMarkdownInline([coverage, s.endPeriod].filter(Boolean).join(' '))}`,
        );
      lines.push(parts.join(' '));
      if (s.item) lines.push(`  _${escapeMarkdownInline(s.item)}_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
