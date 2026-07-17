/**
 * @fileoverview Return the single most recent observation for one or more BLS
 * series. Issues one GET request per SeriesID — each consumes one of the 500
 * daily API queries. Prefer bls_get_series with a 1-year window for large
 * batches; bls_get_latest is optimised for the single-series "current value" ask.
 * @module mcp-server/tools/definitions/bls-get-latest
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getBlsApiService } from '@/services/bls-api/bls-api-service.js';

/**
 * Failures that are verdicts on the request rather than on one series. Every leg
 * of the fan-out below meets them identically, so they surface as the tool's own
 * error instead of as N copies buried in `failed[]` — a rejected API key read as
 * a per-series problem sends the caller hunting for bad SeriesIDs.
 */
const REQUEST_LEVEL_REASONS = new Set(['invalid_api_key', 'quota_exceeded', 'series_locked']);

const ObservationSchema = z.object({
  year: z.string().describe('Observation year (e.g. "2024").'),
  period: z.string().describe('Observation period code (e.g. "M12" for December, "Q01" for Q1).'),
  periodName: z.string().optional().describe('Human-readable period name (e.g. "December").'),
  value: z
    .string()
    .describe(
      'Observation value as a string, matching BLS API output. Parse to float for arithmetic.',
    ),
  footnotes: z.array(z.string()).optional().describe('Footnote codes and text, when present.'),
});

export const blsGetLatestTool = tool('bls_get_latest', {
  title: 'Get Latest BLS Observation',
  description:
    'Return the single most recent observation for one or more BLS series. Use for "what is X right now" questions — the current unemployment rate, the latest CPI reading, etc. Each series consumes one API query against the 500/day limit; for the current value of many series, bls_get_series with a 1-year window is more quota-efficient (one query for up to 50 series). Recommended limit: 10 series; maximum: 50.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

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
      reason: 'series_locked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS database is temporarily locked for the requested series.',
      recovery: 'The BLS database lock is transient — retry the request after a brief delay.',
    },
  ],

  input: z.object({
    series_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        'One or more BLS SeriesIDs (1–50). Each consumes one daily API query. Use bls_search_series to resolve concepts to SeriesIDs. Recommended: ≤10 series.',
      ),
  }),

  output: z.object({
    results: z
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
            latestObservation: ObservationSchema.optional().describe('Most recent observation.'),
          })
          .describe('Latest observation result for one BLS series.'),
      )
      .describe(
        'Successfully fetched series with their latest observations. Series that failed appear in failed[] instead.',
      ),
    succeeded: z.number().describe('Number of series with a successfully fetched observation.'),
    failed: z
      .array(
        z
          .object({
            seriesId: z.string().describe('SeriesID that failed.'),
            error: z
              .string()
              .describe(
                'Error message. Common values: "Series does not exist" (invalid SeriesID — use bls_search_series to find valid IDs), "No observations returned" (series exists but has no current data).',
              ),
          })
          .describe(
            'A series that could not be fetched, e.g. due to an invalid SeriesID or empty data window.',
          ),
      )
      .describe(
        'Series that failed to fetch. Inspect seriesId and error for per-item details. Not-found series appear here rather than as a tool-level error.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when one or more series failed — e.g. to use bls_search_series to verify SeriesIDs. Absent when all series returned data.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_get_latest', { count: input.series_ids.length });
    const service = getBlsApiService();

    // Pair each seriesId with its settlement so downstream logic has the id regardless
    // of whether the fetch succeeded or rejected (rejections don't carry the seriesId).
    const pairs = await Promise.allSettled(
      input.series_ids.map(async (seriesId) => ({
        seriesId,
        data: await service.fetchLatest(seriesId, ctx),
      })),
    );

    const results: Array<{
      seriesId: string;
      title?: string;
      area?: string;
      item?: string;
      seasonal?: string;
      latestObservation?: {
        year: string;
        period: string;
        periodName?: string;
        value: string;
        footnotes?: string[];
      };
    }> = [];
    const failed: Array<{ seriesId: string; error: string }> = [];
    let succeededCount = 0;

    for (const [i, settlement] of pairs.entries()) {
      // i is always within bounds — pairs is derived 1:1 from input.series_ids.
      const requestedId = input.series_ids[i] ?? '';
      if (settlement.status === 'rejected') {
        const err: unknown = settlement.reason;
        if (err instanceof McpError) {
          const reason = (err.data as Record<string, unknown> | undefined)?.reason;
          if (typeof reason === 'string' && REQUEST_LEVEL_REASONS.has(reason)) throw err;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        failed.push({ seriesId: requestedId, error: errorMsg });
        // Failed series go into failed[] only — not results[].
        continue;
      }

      const { seriesId, data } = settlement.value;
      const obs = data.observations[0];
      if (!obs) {
        const errorMsg =
          'No observations returned — series may exist but has no data for the current period.';
        failed.push({ seriesId, error: errorMsg });
        // No-observation series go into failed[] only — not results[].
        continue;
      }

      results.push({
        seriesId: data.seriesId,
        ...(data.title && { title: data.title }),
        ...(data.area && { area: data.area }),
        ...(data.item && { item: data.item }),
        ...(data.seasonal && { seasonal: data.seasonal }),
        latestObservation: {
          year: obs.year,
          period: obs.period,
          value: obs.value,
          ...(obs.periodName && { periodName: obs.periodName }),
          ...(obs.footnotes?.length && { footnotes: obs.footnotes }),
        },
      });
      succeededCount++;
    }

    if (failed.length > 0) {
      const allFailed = succeededCount === 0;
      ctx.enrich.notice(
        allFailed
          ? `All ${failed.length} series failed. Use bls_search_series to verify the SeriesIDs are valid before retrying.`
          : `${failed.length} of ${input.series_ids.length} series failed. Use bls_search_series to verify the failing SeriesIDs.`,
      );
    }

    return {
      results,
      succeeded: succeededCount,
      failed,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const r of result.results) {
      const obs = r.latestObservation;
      if (!obs) continue;
      lines.push(`**${r.seriesId}**${r.title ? ` — ${r.title}` : ''}`);
      const periodStr = obs.periodName
        ? `${obs.periodName} ${obs.year}`
        : `${obs.period} ${obs.year}`;
      lines.push(`Value: **${obs.value}** (${periodStr})`);
      lines.push(`Period: ${obs.period}`);
      if (obs.footnotes?.length) lines.push(`Footnotes: ${obs.footnotes.join('; ')}`);
      if (r.area) lines.push(`Area: ${r.area}`);
      if (r.item) lines.push(`Item: ${r.item}`);
      if (r.seasonal) lines.push(`Seasonality: ${r.seasonal}`);
      lines.push('');
    }
    if (result.failed.length > 0) {
      lines.push(`**${result.failed.length} failed:**`);
      for (const f of result.failed) {
        lines.push(`- ${f.seriesId}: ${f.error}`);
      }
    }
    const total = result.results.length + result.failed.length;
    lines.push(`_${result.succeeded} of ${total} series returned data._`);
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
