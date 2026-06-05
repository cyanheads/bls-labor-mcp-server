/**
 * @fileoverview Fetch time-series data for 1–50 BLS series by SeriesID. Sends
 * a single POST /timeseries/data request (one API query regardless of series
 * count). When total observations exceed the inline budget, spills to canvas
 * and returns a `dataset` field with a `df_<id>` handle for follow-up SQL.
 * @module mcp-server/tools/definitions/bls-get-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type BatchFetchOptions, getBlsApiService } from '@/services/bls-api/bls-api-service.js';
import type { SeriesData } from '@/services/bls-api/types.js';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';

/** Inline budget in characters of JSON. ~25k tokens ≈ 100,000 chars. */
const INLINE_BUDGET_CHARS = 100_000;

const ObservationSchema = z.object({
  year: z.string().describe('Observation year.'),
  period: z.string().describe('Period code (e.g. M01–M13, Q01–Q05, A01).'),
  periodName: z.string().optional().describe('Human-readable period name.'),
  value: z
    .string()
    .describe('Observation value as a string matching BLS output. Parse to float for arithmetic.'),
  footnotes: z.array(z.string()).optional().describe('Footnote codes and text, when present.'),
  netChange1Month: z.string().optional().describe('1-month net change (when calculations=true).'),
  netChange12Month: z.string().optional().describe('12-month net change (when calculations=true).'),
  pctChange1Month: z
    .string()
    .optional()
    .describe('1-month percent change (when calculations=true).'),
  pctChange12Month: z
    .string()
    .optional()
    .describe('12-month percent change (when calculations=true).'),
});

export const blsGetSeriesTool = tool('bls_get_series', {
  title: 'Get BLS Time-Series Data',
  description:
    'Fetch time-series data for 1–50 BLS series by SeriesID in a single API request (one query against the 500/day limit). Supports optional year range (up to 20 years per request) and BLS-computed period-over-period calculations (net change and percent change; a survey returns whichever it supports — CPI and PPI return percent change only, the inflation rate — so check bls_list_surveys first). When the total observation count would exceed the inline context budget, results spill to a canvas dataframe and the response includes a dataset.name handle for follow-up SQL via bls_dataframe_query. Use bls_search_series first if you need to resolve a concept to a SeriesID.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS API 500 query/day limit has been reached.',
      recovery:
        'The daily quota resets at UTC midnight. Retry after midnight or reduce query volume.',
    },
    {
      reason: 'series_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more SeriesIDs do not exist in BLS data.',
      recovery: 'Use bls_search_series to find valid SeriesIDs before calling bls_get_series.',
    },
    {
      reason: 'series_locked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS database is temporarily locked for the requested series.',
      recovery: 'The BLS database lock is transient — retry the request after a brief delay.',
    },
    {
      reason: 'no_data_for_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No data is available for the requested year range.',
      recovery: 'Adjust start_year or end_year. The BLS series may not cover the requested period.',
    },
    {
      reason: 'calculations_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'calculations=true was requested for a survey that does not support it.',
      recovery:
        'Remove the calculations flag or use bls_list_surveys to verify calculation support before requesting it.',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The result set exceeds the inline budget and canvas (DuckDB) is not configured.',
      recovery:
        'Narrow start_year/end_year to reduce the result set, or enable canvas by setting CANVAS_PROVIDER_TYPE=duckdb.',
    },
  ],

  input: z.object({
    series_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        'One or more BLS SeriesIDs (1–50). The entire batch counts as one API query. Use bls_search_series to resolve concepts to SeriesIDs.',
      ),
    start_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe(
        'Start year for the data range (inclusive). The BLS API allows up to 20 years per request. Omit for the API default (typically 3–20 years depending on survey).',
      ),
    end_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe(
        'End year for the data range (inclusive). Defaults to the current year when omitted.',
      ),
    calculations: z
      .boolean()
      .optional()
      .describe(
        'When true, request BLS-computed period-over-period calculations. The flag is a single boolean (you cannot select an individual calculation type), but the API returns whichever the survey supports: CPI and PPI return percent change only (the inflation rate), with no error. Only surveys that support neither net nor percent change (e.g. AP average price data) return an error — check bls_list_surveys first.',
      ),
  }),

  output: z.object({
    series: z
      .array(
        z
          .object({
            seriesId: z.string().describe('BLS SeriesID.'),
            title: z.string().optional().describe('Series name when returned by the API.'),
            area: z.string().optional().describe('Geographic area when returned by the API.'),
            item: z.string().optional().describe('Item/subject when returned by the API.'),
            seasonal: z
              .string()
              .optional()
              .describe('Seasonality indicator when returned by the API.'),
            observationCount: z
              .number()
              .describe(
                'Total observations for this series. When spilled to canvas, all observations are on the dataframe; inline only shows a preview.',
              ),
            observations: z
              .array(ObservationSchema.describe('One observation data point.'))
              .describe(
                'Inline observations. All observations when no spillover; preview rows when spilled to canvas.',
              ),
          })
          .describe('Time-series data for one BLS series.'),
      )
      .describe('Series data, in request order.'),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Canvas table name (df_XXXXX_XXXXX). Pass to bls_dataframe_query.'),
        row_count: z.number().describe('Total rows in the canvas table.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp (sliding 24h window).'),
        truncated: z
          .boolean()
          .describe(
            'True when the upstream response had more rows than the canvas materialization cap.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe handle — present when the observation volume exceeded the inline budget. Use bls_dataframe_query with dataset.name to run SQL across the full data.',
      ),
    spilled: z
      .boolean()
      .describe('True when results spilled to canvas due to inline budget overflow.'),
  }),

  enrichment: {
    totalObservations: z.number().describe('Total observation rows across all requested series.'),
    seriesRequested: z
      .number()
      .describe(
        'Number of SeriesIDs requested. Compare against the returned series[] length to detect series that returned no data.',
      ),
    startYearApplied: z
      .number()
      .optional()
      .describe('Start year in effect, when a range was requested.'),
    endYearApplied: z
      .number()
      .optional()
      .describe('End year in effect, when a range was requested.'),
    calculationsApplied: z
      .boolean()
      .optional()
      .describe('Whether BLS net/percent-change calculations were requested.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for agents — e.g. when results spilled to canvas and SQL is needed for full access. Absent when all observations fit inline.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_get_series', {
      count: input.series_ids.length,
      startYear: input.start_year,
      endYear: input.end_year,
      calculations: input.calculations,
    });

    if (
      input.start_year !== undefined &&
      input.end_year !== undefined &&
      input.start_year > input.end_year
    ) {
      throw ctx.fail(
        'no_data_for_period',
        `start_year (${input.start_year}) must not be greater than end_year (${input.end_year}).`,
        { ...ctx.recoveryFor('no_data_for_period') },
      );
    }

    if (
      input.start_year !== undefined &&
      input.end_year !== undefined &&
      input.end_year - input.start_year >= 20
    ) {
      throw ctx.fail(
        'no_data_for_period',
        `Year range ${input.start_year}–${input.end_year} spans ${input.end_year - input.start_year + 1} years. The BLS API caps requests at 20 years. Split into multiple requests (e.g. ${input.start_year}–${input.start_year + 19}, then ${input.start_year + 20}–${input.end_year}).`,
        { ...ctx.recoveryFor('no_data_for_period') },
      );
    }

    const service = getBlsApiService();
    const fetchOptions: BatchFetchOptions = { seriesIds: input.series_ids };
    if (input.start_year !== undefined) fetchOptions.startYear = input.start_year;
    if (input.end_year !== undefined) fetchOptions.endYear = input.end_year;
    if (input.calculations !== undefined) fetchOptions.calculations = input.calculations;
    const allSeries = await service.fetchSeries(fetchOptions, ctx);

    // Flatten to rows for canvas registration
    const allRows = flattenToRows(allSeries);
    const inlineJson = JSON.stringify(allRows);
    const shouldSpill = inlineJson.length > INLINE_BUDGET_CHARS;

    const totalObservations = allRows.length;
    ctx.enrich({
      totalObservations,
      seriesRequested: input.series_ids.length,
      ...(input.start_year !== undefined && { startYearApplied: input.start_year }),
      ...(input.end_year !== undefined && { endYearApplied: input.end_year }),
      ...(input.calculations !== undefined && { calculationsApplied: input.calculations }),
    });

    if (shouldSpill) {
      const bridge = getCanvasBridge();

      if (!bridge) {
        // Data would be silently truncated — surface this as an error so agents
        // know to narrow the year range rather than treating partial data as complete.
        throw ctx.fail(
          'canvas_unavailable',
          `Result set exceeded the inline budget (${allRows.length} rows across ${allSeries.length} series). Canvas is not configured — full data cannot be returned.`,
          {
            recovery: {
              hint: 'Narrow start_year/end_year to reduce result size, or enable canvas by setting CANVAS_PROVIDER_TYPE=duckdb.',
            },
          },
        );
      }

      const registered = await bridge.registerDataframe(ctx, {
        rows: allRows,
        sourceTool: 'bls_get_series',
        queryParams: {
          series_ids: input.series_ids,
          start_year: input.start_year,
          end_year: input.end_year,
          calculations: input.calculations,
        },
      });
      const dataset = registered ? { ...toDatasetField(registered), truncated: false } : undefined;

      ctx.enrich.notice(
        `${totalObservations} total observations across ${allSeries.length} series exceeded the inline budget. Full data is in canvas table ${dataset?.name ?? '(unavailable)'}; use bls_dataframe_query for SQL access.`,
      );

      // Still return preview rows inline — first 3 observations per series
      const seriesPreview = allSeries.map((s) => ({
        seriesId: s.seriesId,
        ...(s.title && { title: s.title }),
        ...(s.area && { area: s.area }),
        ...(s.item && { item: s.item }),
        ...(s.seasonal && { seasonal: s.seasonal }),
        observationCount: s.observations.length,
        observations: s.observations.slice(0, 3).map(normalizeObs),
      }));
      return {
        series: seriesPreview,
        ...(dataset !== undefined && { dataset }),
        spilled: true as const,
      };
    }

    return {
      series: allSeries.map((s) => ({
        seriesId: s.seriesId,
        ...(s.title && { title: s.title }),
        ...(s.area && { area: s.area }),
        ...(s.item && { item: s.item }),
        ...(s.seasonal && { seasonal: s.seasonal }),
        observationCount: s.observations.length,
        observations: s.observations.map(normalizeObs),
      })),
      spilled: false as const,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.spilled && result.dataset) {
      const ds = result.dataset;
      lines.push(
        `**Spilled to canvas** — ${ds.row_count} total rows in \`${ds.name}\`${ds.truncated ? ' (truncated)' : ''}.`,
      );
      lines.push(`Use \`bls_dataframe_query\` with table \`${ds.name}\` for full SQL access.`);
      lines.push(`Expires: ${ds.expires_at}\n`);
    }

    for (const s of result.series) {
      lines.push(`### ${s.seriesId}${s.title ? ` — ${s.title}` : ''}`);
      if (s.area) lines.push(`Area: ${s.area}`);
      if (s.item) lines.push(`Item: ${s.item}`);
      if (s.seasonal) lines.push(`Seasonality: ${s.seasonal}`);
      lines.push(`Observations: ${s.observationCount}${result.spilled ? ' (preview below)' : ''}`);
      lines.push('');
      if (s.observations.length > 0) {
        const hasCalcs = s.observations.some(
          (o) => o.netChange1Month || o.netChange12Month || o.pctChange1Month || o.pctChange12Month,
        );
        if (hasCalcs) {
          lines.push('| Period | Code | Value | Net 1M | Net 12M | Pct 1M | Pct 12M | Notes |');
          lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
          for (const obs of s.observations) {
            const periodLabel = obs.periodName ? `${obs.periodName} ${obs.year}` : `${obs.year}`;
            const notes = obs.footnotes?.join('; ') ?? '';
            lines.push(
              `| ${periodLabel} | ${obs.period} | ${obs.value} | ${obs.netChange1Month ?? ''} | ${obs.netChange12Month ?? ''} | ${obs.pctChange1Month ?? ''} | ${obs.pctChange12Month ?? ''} | ${notes} |`,
            );
          }
        } else {
          lines.push('| Period | Code | Value | Notes |');
          lines.push('| --- | --- | --- | --- |');
          for (const obs of s.observations) {
            const periodLabel = obs.periodName ? `${obs.periodName} ${obs.year}` : `${obs.year}`;
            const notes = obs.footnotes?.join('; ') ?? '';
            lines.push(`| ${periodLabel} | ${obs.period} | ${obs.value} | ${notes} |`);
          }
        }
      } else {
        lines.push(
          '_No observations returned. If this SeriesID is unverified, use `bls_search_series` to confirm it exists._',
        );
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

function flattenToRows(series: SeriesData[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const s of series) {
    for (const obs of s.observations) {
      rows.push({
        series_id: s.seriesId,
        series_title: s.title ?? null,
        area: s.area ?? null,
        item: s.item ?? null,
        seasonal: s.seasonal ?? null,
        year: obs.year,
        period: obs.period,
        period_name: obs.periodName ?? null,
        value: obs.value,
        footnotes: obs.footnotes?.join('; ') ?? null,
        net_change_1m: obs.netChange1Month ?? null,
        net_change_12m: obs.netChange12Month ?? null,
        pct_change_1m: obs.pctChange1Month ?? null,
        pct_change_12m: obs.pctChange12Month ?? null,
      });
    }
  }
  return rows;
}

function normalizeObs(obs: SeriesData['observations'][number]) {
  return {
    year: obs.year,
    period: obs.period,
    value: obs.value,
    ...(obs.periodName && { periodName: obs.periodName }),
    ...(obs.footnotes?.length && { footnotes: obs.footnotes }),
    ...(obs.netChange1Month && { netChange1Month: obs.netChange1Month }),
    ...(obs.netChange12Month && { netChange12Month: obs.netChange12Month }),
    ...(obs.pctChange1Month && { pctChange1Month: obs.pctChange1Month }),
    ...(obs.pctChange12Month && { pctChange12Month: obs.pctChange12Month }),
  };
}
