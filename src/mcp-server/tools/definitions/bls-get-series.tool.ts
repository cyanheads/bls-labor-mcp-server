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
import { isAnnualAveragePeriod } from '@/services/bls-periods/period-codes.js';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';

/** Inline budget in characters of JSON. ~25k tokens ≈ 100,000 chars. */
const INLINE_BUDGET_CHARS = 100_000;

const ObservationSchema = z.object({
  year: z.string().describe('Observation year.'),
  period: z
    .string()
    .describe(
      'BLS period code: M01–M12 are months, Q01–Q04 quarters, S01–S02 semiannual halves. M13, Q05 and S03 are not further periods — each is the mean of that year\'s real observations, named "Annual", and appears only when annual_average is true. Exclude them from any sum or average over observations.',
    ),
  periodName: z.string().optional().describe('Human-readable period name.'),
  value: z
    .string()
    .describe('Observation value as a string matching BLS output. Parse to float for arithmetic.'),
  footnotes: z.array(z.string()).optional().describe('Footnote codes and text, when present.'),
  netChange1Month: z.string().optional().describe('1-month net change (when calculations=true).'),
  netChange3Month: z.string().optional().describe('3-month net change (when calculations=true).'),
  netChange6Month: z.string().optional().describe('6-month net change (when calculations=true).'),
  netChange12Month: z.string().optional().describe('12-month net change (when calculations=true).'),
  pctChange1Month: z
    .string()
    .optional()
    .describe('1-month percent change (when calculations=true).'),
  pctChange3Month: z
    .string()
    .optional()
    .describe('3-month percent change (when calculations=true).'),
  pctChange6Month: z
    .string()
    .optional()
    .describe('6-month percent change (when calculations=true).'),
  pctChange12Month: z
    .string()
    .optional()
    .describe('12-month percent change (when calculations=true).'),
});

/**
 * Calculation columns in BLS interval order, used to render only the intervals a
 * survey actually returned. BLS emits 1/3/6/12-month net and percent change for
 * monthly-cadence series; other cadences and surveys return a subset.
 */
const CALC_COLUMNS = [
  { header: 'Net 1M', key: 'netChange1Month' },
  { header: 'Net 3M', key: 'netChange3Month' },
  { header: 'Net 6M', key: 'netChange6Month' },
  { header: 'Net 12M', key: 'netChange12Month' },
  { header: 'Pct 1M', key: 'pctChange1Month' },
  { header: 'Pct 3M', key: 'pctChange3Month' },
  { header: 'Pct 6M', key: 'pctChange6Month' },
  { header: 'Pct 12M', key: 'pctChange12Month' },
] as const satisfies ReadonlyArray<{
  header: string;
  key: keyof z.infer<typeof ObservationSchema>;
}>;

export const blsGetSeriesTool = tool('bls_get_series', {
  title: 'Get BLS Time-Series Data',
  description:
    "Fetch time-series data for 1–50 BLS series by SeriesID in a single API request (one query against the 500/day limit). Supports optional year range (up to 20 years per request) and BLS-computed period-over-period calculations (net change and percent change; a survey returns whichever it supports and silently omits the rest — CPI and PPI return percent change only, the inflation rate). Observations cover real periods only and are safe to sum or average as returned; set annual_average to add each year's annual-average row, which is that year's mean rather than an additional period. When the total observation count would exceed the inline context budget, results spill to a canvas dataframe and the response includes a dataset.name handle for follow-up SQL via bls_dataframe_query. Use bls_search_series first if you need to resolve a concept to a SeriesID.",
  annotations: { readOnlyHint: true, openWorldHint: true },

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
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS API 500 query/day limit has been reached.',
      retryable: false,
      recovery:
        'The daily quota resets at UTC midnight. Retry after midnight or reduce query volume.',
    },
    {
      reason: 'request_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'BLS returned a non-success status with a message matching no known failure mode — e.g. a rejected combination of request parameters.',
      retryable: false,
      recovery:
        'Retry with calculations omitted, or split series_ids into smaller batches to isolate the series BLS rejects.',
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
    {
      reason: 'canvas_registration_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The result set exceeds the inline budget and canvas is configured, but registering the dataframe failed.',
      recovery:
        'Retry the request — the failure is usually transient. If it persists, narrow start_year/end_year so the result fits inline.',
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
        'When true, request BLS-computed period-over-period calculations. The flag is a single boolean (you cannot select an individual calculation type), but the API returns whichever the survey supports and omits the rest — CPI and PPI return percent change only (the inflation rate), and a survey that supports neither simply returns its observations without calculation fields. Requesting calculations never fails, so it is always safe to set; consult bls_list_surveys (allowsNetChange / allowsPercentChange) only to predict which fields will come back. Monthly-cadence series return each supported change type over 1, 3, 6, and 12-month intervals; other cadences return a subset.',
      ),
    annual_average: z
      .boolean()
      .default(false)
      .describe(
        'When true, add each year\'s annual-average row to the observations. An annual average is the mean of that year\'s real periods, returned as an extra row named "Annual" with period M13 (monthly series), Q05 (quarterly) or S03 (semiannual) — not an additional month or quarter, so it must be excluded from any sum or average over observations. Defaults to false, which returns real periods only and is safe to aggregate directly. Independent of start_year/end_year. Surveys that publish no annual averages return the same rows either way; enrichment.annualAverageRows reports how many rows were actually added.',
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
        'Number of SeriesIDs requested. Do not compare it against series[] length to find empty series — a SeriesID that returned no data is still listed in series[] with observationCount 0. Check observationCount per entry, or read notice, which names every SeriesID that came back empty.',
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
    annualAverageApplied: z
      .boolean()
      .describe(
        'Whether annual-average rows were requested. When false, observations hold real periods only and can be summed or averaged directly.',
      ),
    annualAverageRows: z
      .number()
      .optional()
      .describe(
        'How many observations across all series are annual-average rows (period M13/Q05/S03). Present only when annual_average is true; 0 means none of the requested surveys publish annual averages.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for agents — names any SeriesID that returned zero observations, and reports when results spilled to canvas and SQL is needed for full access. Absent when every requested series returned data and it all fit inline.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_get_series', {
      count: input.series_ids.length,
      startYear: input.start_year,
      endYear: input.end_year,
      calculations: input.calculations,
      annualAverage: input.annual_average,
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
    const fetchOptions: BatchFetchOptions = {
      seriesIds: input.series_ids,
      annualAverage: input.annual_average,
    };
    if (input.start_year !== undefined) fetchOptions.startYear = input.start_year;
    if (input.end_year !== undefined) fetchOptions.endYear = input.end_year;
    if (input.calculations !== undefined) fetchOptions.calculations = input.calculations;
    const allSeries = await service.fetchSeries(fetchOptions, ctx);

    // Flatten to rows for canvas registration
    const allRows = flattenToRows(allSeries);
    const inlineJson = JSON.stringify(allRows);
    const shouldSpill = inlineJson.length > INLINE_BUDGET_CHARS;

    const totalObservations = allRows.length;
    const annualAverageRows = allRows.filter((r) => r.is_annual_average === true).length;
    ctx.enrich({
      totalObservations,
      seriesRequested: input.series_ids.length,
      annualAverageApplied: input.annual_average,
      ...(input.start_year !== undefined && { startYearApplied: input.start_year }),
      ...(input.end_year !== undefined && { endYearApplied: input.end_year }),
      ...(input.calculations !== undefined && { calculationsApplied: input.calculations }),
      ...(input.annual_average && { annualAverageRows }),
    });

    /**
     * Empty series are invisible in the payload alone: the live API echoes a
     * requested SeriesID back with `data: []`, while the observations mirror
     * omits it entirely. Reconciling against the requested IDs catches both.
     * `ctx.enrich.notice` is last-wins, so every notice this handler emits is
     * composed into one string below.
     */
    const byId = new Map(allSeries.map((s) => [s.seriesId, s]));
    const emptySeriesIds = input.series_ids.filter(
      (id) => (byId.get(id)?.observations.length ?? 0) === 0,
    );
    const notices: string[] = [];
    if (emptySeriesIds.length > 0) {
      const ranged = input.start_year !== undefined || input.end_year !== undefined;
      notices.push(
        `No observations returned for ${emptySeriesIds.join(', ')}. Confirm the SeriesID with bls_search_series${ranged ? ', or widen start_year/end_year — the series may not publish over the requested range' : ''}.`,
      );
    }
    if (input.annual_average && annualAverageRows > 0) {
      notices.push(
        `${annualAverageRows} of ${totalObservations} observations are annual-average rows (period M13/Q05/S03, named "Annual"): each is the mean of that year's real periods, not an additional one. Exclude them from any sum or average over observations, or via is_annual_average when querying the canvas table.`,
      );
    }

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

      // Registration throws if it fails, so a spilled result always has a handle.
      const registered = await bridge.registerDataframe(ctx, {
        rows: allRows,
        sourceTool: 'bls_get_series',
        queryParams: {
          series_ids: input.series_ids,
          start_year: input.start_year,
          end_year: input.end_year,
          calculations: input.calculations,
          annual_average: input.annual_average,
        },
      });
      const dataset = { ...toDatasetField(registered), truncated: false };

      notices.push(
        `${totalObservations} total observations across ${allSeries.length} series exceeded the inline budget. Full data is in canvas table ${dataset.name}; use bls_dataframe_query for SQL access.`,
      );
      ctx.enrich.notice(notices.join(' '));

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
        dataset,
        spilled: true as const,
      };
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
        // Render only the calculation intervals this survey actually returned —
        // an all-empty column carries no information for the reader.
        const calcs = CALC_COLUMNS.filter((c) => s.observations.some((o) => o[c.key]));
        const headers = ['Period', 'Code', 'Value', ...calcs.map((c) => c.header), 'Notes'];
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const obs of s.observations) {
          const periodLabel = obs.periodName ? `${obs.periodName} ${obs.year}` : `${obs.year}`;
          const cells = [
            periodLabel,
            obs.period,
            obs.value,
            ...calcs.map((c) => obs[c.key] ?? ''),
            obs.footnotes?.join('; ') ?? '',
          ];
          lines.push(`| ${cells.join(' | ')} |`);
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
        // SQL discriminator — an aggregate query that ignores it double-counts each year.
        is_annual_average: isAnnualAveragePeriod(obs.period),
        value: obs.value,
        footnotes: obs.footnotes?.join('; ') ?? null,
        net_change_1m: obs.netChange1Month ?? null,
        net_change_3m: obs.netChange3Month ?? null,
        net_change_6m: obs.netChange6Month ?? null,
        net_change_12m: obs.netChange12Month ?? null,
        pct_change_1m: obs.pctChange1Month ?? null,
        pct_change_3m: obs.pctChange3Month ?? null,
        pct_change_6m: obs.pctChange6Month ?? null,
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
    ...(obs.netChange3Month && { netChange3Month: obs.netChange3Month }),
    ...(obs.netChange6Month && { netChange6Month: obs.netChange6Month }),
    ...(obs.netChange12Month && { netChange12Month: obs.netChange12Month }),
    ...(obs.pctChange1Month && { pctChange1Month: obs.pctChange1Month }),
    ...(obs.pctChange3Month && { pctChange3Month: obs.pctChange3Month }),
    ...(obs.pctChange6Month && { pctChange6Month: obs.pctChange6Month }),
    ...(obs.pctChange12Month && { pctChange12Month: obs.pctChange12Month }),
  };
}
