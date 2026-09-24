/**
 * @fileoverview Fetch time-series data for 1–50 BLS series by SeriesID. Sends
 * a single POST /timeseries/data request (one API query regardless of series
 * count). When total observations exceed the inline budget, spills to canvas
 * and returns a `dataset` field with a `df_<id>` handle for schema discovery
 * and follow-up SQL.
 * @module mcp-server/tools/definitions/bls-get-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema, ColumnType } from '@cyanheads/mcp-ts-core/canvas';
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
    .describe(
      'Raw observation value from BLS. The literal "-" means unavailable; check available before arithmetic and read footnotes for the reason.',
    ),
  available: z
    .boolean()
    .describe('False when BLS published the "-" missing-value sentinel for this period.'),
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
    "Fetch time-series data for 1–50 BLS series by SeriesID in a single API request (one query against the 500/day limit). Supports optional year range (up to 20 years per request) and BLS-computed period-over-period calculations (net change and percent change; a survey returns whichever it supports and silently omits the rest — CPI and PPI return percent change only, the inflation rate). BLS can publish a '-' missing-value sentinel; check observation.available before arithmetic. Set annual_average to add each year's annual-average row, which is that year's mean rather than an additional period. When the total observation count would exceed the inline context budget, results spill to a canvas dataframe and the response includes a dataset.name handle. Call bls_dataframe_describe with that name to inspect the dataframe schema, then use the name in bls_dataframe_query SQL. Use bls_search_series first if you need to resolve a concept to a SeriesID.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'BLS rejected the configured BLS_API_KEY as invalid.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Set BLS_API_KEY to a valid key and restart the server — register free at https://data.bls.gov/registrationEngine/. This is a configuration error: it does not clear at the UTC quota reset.',
    },
    {
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS API 500 query/day limit has been reached.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'The daily quota resets at UTC midnight. Retry after midnight or reduce query volume.',
    },
    {
      reason: 'request_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'BLS returned a non-success status with a message matching no known failure mode, both for the request and for its automatic re-issue without catalog metadata — e.g. a rejected combination of request parameters.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'BLS rejected the request as a whole, not a named series. Retry once; if it recurs, omit calculations or annual_average, or change start_year/end_year.',
    },
    {
      reason: 'series_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No requested series returned data and at least one SeriesID does not exist. A batch mixing an invalid SeriesID with one BLS has no data for lands here too, and names both in the message and recovery hint.',
      thrownBy: 'service',
      recovery: 'Use bls_search_series to find valid SeriesIDs before calling bls_get_series.',
    },
    {
      reason: 'series_locked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS database is temporarily locked for the requested series.',
      thrownBy: 'service',
      recovery: 'The BLS database lock is transient — retry the request after a brief delay.',
    },
    {
      reason: 'no_data_for_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested year range is unusable before the request — start_year after end_year, a span of 20 years or more, or end_year without start_year — or BLS returned data for none of the requested series over the range.',
      recovery: 'Adjust start_year or end_year. The BLS series may not cover the requested period.',
    },
    {
      reason: 'calculations_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'calculations=true was requested for a survey that does not support it.',
      thrownBy: 'service',
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
      thrownBy: 'service',
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
        'Start year for the data range (inclusive). The BLS API allows up to 20 years per request and requires both bounds or neither: supplying start_year alone resolves end_year to the current year, capped at start_year + 19 so the window stays inside the 20-year limit. Omit both for the API default (typically 3–20 years depending on survey).',
      ),
    end_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe(
        'End year for the data range (inclusive). Supplying it without start_year is rejected before the request — BLS applies no default start year alongside an explicit end year. Pair it with start_year, or omit both for the API default window.',
      ),
    calculations: z
      .boolean()
      .optional()
      .describe(
        'When true, request BLS-computed period-over-period calculations. The flag is a single boolean (you cannot select an individual calculation type), but the API returns whichever the survey supports and omits the rest — CPI and PPI return percent change only (the inflation rate), and a survey that supports neither simply returns its observations without calculation fields. Requesting calculations never fails, so it is always safe to set; consult bls_list_surveys (allowsNetChange / allowsPercentChange) only to predict which fields will come back. Monthly-cadence series return each supported change type over 1, 3, 6, and 12-month intervals; other cadences return a subset. A series served from the local observation mirror, when the server runs one, carries no calculation fields; enrichment.calculationsApplied is then false and notice names it.',
      ),
    annual_average: z
      .boolean()
      .default(false)
      .describe(
        'When true, add each year\'s annual-average row to the observations. An annual average is the mean of that year\'s real periods, returned as an extra row named "Annual" with period M13 (monthly series), Q05 (quarterly) or S03 (semiannual) — not an additional month or quarter, so it must be excluded from any sum or average over observations. Defaults to false, which returns real periods only; check available before aggregating. Independent of start_year/end_year. Surveys that publish no annual averages return the same rows either way; enrichment.annualAverageRows reports how many rows were actually added.',
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
                'Total period rows for this series, including unavailable BLS placeholder rows. When spilled to canvas, all rows are on the dataframe; inline only shows a preview.',
              ),
            availableObservationCount: z
              .number()
              .describe('Rows with a published numeric value, excluding the BLS "-" sentinel.'),
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
          .describe(
            'Canvas table name (df_XXXXX_XXXXX). Pass to bls_dataframe_describe first to inspect column_schema, then use it in bls_dataframe_query SQL.',
          ),
        row_count: z.number().describe('Total rows in the canvas table.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp (sliding 24h window).'),
      })
      .optional()
      .describe(
        'Canvas dataframe handle — present when the observation volume exceeded the inline budget. Call bls_dataframe_describe with dataset.name to inspect column_schema, then use that table name in bls_dataframe_query SQL across the full data.',
      ),
    spilled: z
      .boolean()
      .describe('True when results spilled to canvas due to inline budget overflow.'),
  }),

  enrichment: {
    totalObservations: z.number().describe('Total observation rows across all requested series.'),
    availableObservations: z.number().describe('Rows with a published numeric value.'),
    unavailableObservations: z
      .number()
      .describe('Rows carrying the BLS "-" missing-value sentinel.'),
    seriesRequested: z
      .number()
      .describe(
        'Number of SeriesIDs requested. Do not compare it against series[] length to find empty series — a SeriesID that returned no data is still listed in series[] with observationCount 0. Check observationCount per entry, or read notice, which names every SeriesID that came back empty.',
      ),
    startYearApplied: z
      .number()
      .optional()
      .describe(
        'Start year applied to the query, whether it was served live or from the local observation mirror. Absent when no year range was in effect.',
      ),
    endYearApplied: z
      .number()
      .optional()
      .describe(
        'End year applied to the query. Resolved from start_year when end_year was omitted, so it can differ from the requested range; notice names the cap when the 20-year window decided it. Absent when no year range was in effect.',
      ),
    calculationsApplied: z
      .boolean()
      .optional()
      .describe(
        'Whether BLS net/percent-change calculations were applied. True when calculations=true reached BLS for every returned series; false when calculations=false, or when the local observation mirror served a series, whose rows carry no calculations — notice then names those series. Absent when calculations was omitted.',
      ),
    annualAverageApplied: z
      .boolean()
      .describe(
        'Whether annual-average rows were requested. When false, observations hold real periods only; filter on available before aggregation.',
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
        "Guidance for agents — names any SeriesID that returned zero observations with its reason (including a failed live fallback's reason and recovery for a SeriesID the local observation mirror does not hold), names mirror-served series that lack requested calculations, reports a resolved end_year the 20-year window capped, and reports the bls_dataframe_describe then bls_dataframe_query workflow when results spill to canvas. Absent when every requested series returned data over the window as asked and it all fit inline.",
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

    const notices: string[] = [];
    const startYear = input.start_year;
    let endYear = input.end_year;

    /**
     * BLS requires `startyear` and `endyear` together and rejects either one
     * alone, spending a daily query to say so. Resolving the pair here — once,
     * before the fetch options exist — is what keeps the observations mirror
     * and the live API on the same window.
     */
    if (startYear !== undefined && endYear === undefined) {
      const currentYear = new Date().getFullYear();
      const windowEnd = startYear + 19;
      // A start year in the future would otherwise resolve to an inverted range.
      endYear = Math.min(Math.max(currentYear, startYear), windowEnd);
      if (windowEnd < currentYear) {
        notices.push(
          `end_year was omitted and resolved to ${endYear} rather than the current year (${currentYear}): BLS caps a request at 20 years, so the window ends at start_year + 19. Request ${windowEnd + 1}–${currentYear} separately for the remainder.`,
        );
      }
    } else if (startYear === undefined && endYear !== undefined) {
      throw ctx.fail(
        'no_data_for_period',
        `end_year (${endYear}) was supplied without start_year. BLS requires both year bounds or neither, and applies no default start year alongside an explicit end year. Supply start_year no more than 19 years before end_year, or omit both for the BLS default window.`,
        { ...ctx.recoveryFor('no_data_for_period') },
      );
    }

    const service = getBlsApiService();
    const fetchOptions: BatchFetchOptions = {
      seriesIds: input.series_ids,
      annualAverage: input.annual_average,
    };
    if (startYear !== undefined) fetchOptions.startYear = startYear;
    if (endYear !== undefined) fetchOptions.endYear = endYear;
    if (input.calculations !== undefined) fetchOptions.calculations = input.calculations;
    const allSeries = await service.fetchSeries(fetchOptions, ctx);

    /**
     * A SeriesID repeated in series_ids keeps one `series[]` entry per requested
     * position, but it is still one series: counting it per position would
     * double its observations in every total and write each of its rows to the
     * canvas table twice.
     */
    const uniqueSeries = [...new Map(allSeries.map((s) => [s.seriesId, s])).values()];

    // Flatten to rows for canvas registration
    const allRows = flattenToRows(uniqueSeries);
    const inlineJson = JSON.stringify(allRows);
    const shouldSpill = inlineJson.length > INLINE_BUDGET_CHARS;

    const totalObservations = allRows.length;
    const unavailableObservations = allRows.filter((row) => row.available === false).length;
    const availableObservations = totalObservations - unavailableObservations;
    const annualAverageRows = allRows.filter((r) => r.is_annual_average === true).length;
    const mirrorServedIds = uniqueSeries
      .filter((s) => s.source === 'mirror')
      .map((s) => s.seriesId);
    ctx.enrich({
      totalObservations,
      availableObservations,
      unavailableObservations,
      seriesRequested: input.series_ids.length,
      annualAverageApplied: input.annual_average,
      ...(startYear !== undefined && { startYearApplied: startYear }),
      ...(endYear !== undefined && { endYearApplied: endYear }),
      ...(input.calculations !== undefined && {
        calculationsApplied: input.calculations && mirrorServedIds.length === 0,
      }),
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
    const emptySeriesIds = [...new Set(input.series_ids)].filter(
      (id) => (byId.get(id)?.observations.length ?? 0) === 0,
    );
    if (emptySeriesIds.length > 0) {
      const ranged = startYear !== undefined || endYear !== undefined;
      /**
       * A live fallback that failed says nothing about the SeriesIDs it was
       * sent, so they are named under the failure itself — its reason and
       * recovery — instead of being sent to bls_search_series. The service
       * issues one fallback per call, so every such entry carries the same one.
       */
      const liveFailedIds: string[] = [];
      let liveFailure: SeriesData['liveFailure'];
      for (const id of emptySeriesIds) {
        const entry = byId.get(id);
        if (entry?.liveFailure) {
          liveFailedIds.push(id);
          liveFailure = entry.liveFailure;
          continue;
        }
        const failure = entry?.failure;
        notices.push(
          failure?.reason === 'series_not_found'
            ? `BLS reports ${id} is invalid or does not exist. Use bls_search_series to find a valid SeriesID.`
            : failure?.reason === 'no_data_for_period'
              ? `BLS returned no data for ${id} over the requested period. Adjust start_year/end_year.`
              : `No observations returned for ${id}. Confirm the SeriesID with bls_search_series${ranged ? ', or widen start_year/end_year — the series may not publish over the requested range' : ''}.`,
        );
      }
      if (liveFailure) {
        notices.push(
          `The local observation mirror does not hold ${liveFailedIds.join(', ')}, and the live BLS API fallback for ${liveFailedIds.length === 1 ? 'it' : 'them'} failed: ${liveFailure.reason ?? liveFailure.message}. ${liveFailure.recovery ?? 'Retry once the BLS API is reachable.'}`,
        );
      }
    }
    if (input.calculations && mirrorServedIds.length > 0) {
      notices.push(
        `calculations=true was not applied to ${mirrorServedIds.join(', ')}: the local observation mirror served ${mirrorServedIds.length === 1 ? 'it' : 'them'}, and mirror rows carry no BLS net or percent changes. Derive period-over-period changes from the observation values.`,
      );
    }
    if (unavailableObservations > 0) {
      notices.push(
        `${unavailableObservations} of ${totalObservations} rows are unavailable BLS observations. Check available before arithmetic, use value_numeric in DataCanvas SQL, and read each row's footnotes for the reason.`,
      );
    }
    if (input.annual_average && annualAverageRows > 0) {
      notices.push(
        `${annualAverageRows} of ${totalObservations} observations are annual-average rows (period M13/Q05/S03, named "Annual"): each is the mean of that year's real periods, not an additional one. Exclude them from any sum or average over observations, or via is_annual_average when querying the canvas table.`,
      );
    }

    if (shouldSpill) {
      const bridge = getCanvasBridge();

      /**
       * Both spill failures tell the caller to narrow the year range, so both
       * name the range in force — including an `end_year` this handler resolved
       * rather than the caller supplying, which is otherwise a bound they cannot
       * see to narrow.
       */
      const appliedWindow =
        startYear !== undefined && endYear !== undefined
          ? `${startYear}–${endYear}${input.end_year === undefined ? ', end_year resolved from start_year' : ''}`
          : 'the BLS default window, since neither start_year nor end_year was supplied';

      if (!bridge) {
        // Data would be silently truncated — surface this as an error so agents
        // know to narrow the year range rather than treating partial data as complete.
        throw ctx.fail(
          'canvas_unavailable',
          `Result set exceeded the inline budget (${allRows.length} rows across ${uniqueSeries.length} series) over ${appliedWindow}. Canvas is not configured — full data cannot be returned.`,
          {
            recovery: {
              hint: `The applied window was ${appliedWindow}. Narrow start_year/end_year to reduce the result set, or enable canvas by setting CANVAS_PROVIDER_TYPE=duckdb.`,
            },
          },
        );
      }

      // Registration throws if it fails, so a spilled result always has a handle.
      const registered = await bridge.registerDataframe(ctx, {
        rows: allRows,
        schema: SPILL_SCHEMA,
        sourceTool: 'bls_get_series',
        appliedScope: `The applied window was ${appliedWindow}.`,
        queryParams: {
          series_ids: input.series_ids,
          start_year: startYear,
          end_year: endYear,
          calculations: input.calculations,
          annual_average: input.annual_average,
        },
      });
      const dataset = toDatasetField(registered);

      notices.push(
        `${totalObservations} total observations across ${uniqueSeries.length} series exceeded the inline budget. Full data is in canvas table ${dataset.name}; call bls_dataframe_describe with name=${dataset.name} to inspect column_schema, then use ${dataset.name} in bls_dataframe_query SQL.`,
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
        availableObservationCount: s.observations.filter(observationAvailable).length,
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
        availableObservationCount: s.observations.filter(observationAvailable).length,
        observations: s.observations.map(normalizeObs),
      })),
      spilled: false as const,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.spilled && result.dataset) {
      const ds = result.dataset;
      lines.push(`**Spilled to canvas** — ${ds.row_count} total rows in \`${ds.name}\`.`);
      lines.push(
        `Call \`bls_dataframe_describe\` with \`name=${ds.name}\` to inspect \`column_schema\`, then use table \`${ds.name}\` in \`bls_dataframe_query\` SQL.`,
      );
      lines.push(`Expires: ${ds.expires_at}\n`);
    }

    for (const s of result.series) {
      lines.push(`### ${s.seriesId}${s.title ? ` — ${s.title}` : ''}`);
      if (s.area) lines.push(`Area: ${s.area}`);
      if (s.item) lines.push(`Item: ${s.item}`);
      if (s.seasonal) lines.push(`Seasonality: ${s.seasonal}`);
      const availableObservationCount =
        s.availableObservationCount ??
        s.observations.filter((obs) => obs.available ?? obs.value !== '-').length;
      lines.push(
        `Observations: ${availableObservationCount} available of ${s.observationCount} row(s)${result.spilled ? ' (preview below)' : ''}`,
      );
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
            (obs.available ?? obs.value !== '-') ? obs.value : 'Unavailable (-)',
            ...calcs.map((c) => obs[c.key] ?? ''),
            obs.footnotes?.join('; ') ?? '',
          ];
          lines.push(`| ${cells.join(' | ')} |`);
        }
      } else {
        // The notice names every empty SeriesID with its own reason and next step —
        // an invalid ID, an uncovered range, or a failed live fallback.
        lines.push('_No observations returned. The notice names the reason and the next step._');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

const spillColumn = (name: string, type: ColumnType): ColumnSchema => ({
  name,
  type,
  nullable: true,
});

/**
 * Canvas schema for the rows {@link flattenToRows} builds, in its key order.
 * Declared rather than inferred from the batch, so a column's type never
 * depends on the values that arrived: `value_numeric` and every calculation
 * column are `DOUBLE` whether the batch holds whole numbers, fractions, or only
 * unavailable rows. Every column is nullable — sparse BLS fields must not trip
 * a NOT NULL appender rollback.
 */
const SPILL_SCHEMA: ColumnSchema[] = [
  spillColumn('series_id', 'VARCHAR'),
  spillColumn('series_title', 'VARCHAR'),
  spillColumn('area', 'VARCHAR'),
  spillColumn('item', 'VARCHAR'),
  spillColumn('seasonal', 'VARCHAR'),
  spillColumn('year', 'VARCHAR'),
  spillColumn('period', 'VARCHAR'),
  spillColumn('period_name', 'VARCHAR'),
  spillColumn('is_annual_average', 'BOOLEAN'),
  spillColumn('value', 'VARCHAR'),
  spillColumn('available', 'BOOLEAN'),
  spillColumn('value_numeric', 'DOUBLE'),
  spillColumn('footnotes', 'VARCHAR'),
  spillColumn('net_change_1m', 'DOUBLE'),
  spillColumn('net_change_3m', 'DOUBLE'),
  spillColumn('net_change_6m', 'DOUBLE'),
  spillColumn('net_change_12m', 'DOUBLE'),
  spillColumn('pct_change_1m', 'DOUBLE'),
  spillColumn('pct_change_3m', 'DOUBLE'),
  spillColumn('pct_change_6m', 'DOUBLE'),
  spillColumn('pct_change_12m', 'DOUBLE'),
];

/** A BLS numeric string as a number; `null` when absent, blank, or not a number. */
function parseNumeric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flattenToRows(series: SeriesData[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const s of series) {
    for (const obs of s.observations) {
      const available = observationAvailable(obs);
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
        available,
        value_numeric: available ? parseNumeric(obs.value) : null,
        footnotes: obs.footnotes?.join('; ') ?? null,
        net_change_1m: parseNumeric(obs.netChange1Month),
        net_change_3m: parseNumeric(obs.netChange3Month),
        net_change_6m: parseNumeric(obs.netChange6Month),
        net_change_12m: parseNumeric(obs.netChange12Month),
        pct_change_1m: parseNumeric(obs.pctChange1Month),
        pct_change_3m: parseNumeric(obs.pctChange3Month),
        pct_change_6m: parseNumeric(obs.pctChange6Month),
        pct_change_12m: parseNumeric(obs.pctChange12Month),
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
    available: observationAvailable(obs),
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

function observationAvailable(obs: SeriesData['observations'][number]): boolean {
  return obs.available ?? obs.value !== '-';
}
