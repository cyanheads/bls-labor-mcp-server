/**
 * @fileoverview Return the single most recent observation for one or more BLS
 * series. Issues one GET request per SeriesID — each consumes one of the 500
 * daily API queries. Prefer bls_get_series with a 1-year window for large
 * batches; bls_get_latest is optimised for the single-series "current value" ask.
 * @module mcp-server/tools/definitions/bls-get-latest
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getBlsApiService } from '@/services/bls-api/bls-api-service.js';
import { unpublishedOewsHint } from '@/services/bls-catalog/bls-catalog-service.js';

/**
 * Failures that are verdicts on the request rather than on one series. Every
 * live leg of the fan-out below meets them identically, so when no series
 * returned an observation they surface as the tool's own error instead of as N
 * copies buried in `failed[]` — a rejected API key read as a per-series problem
 * sends the caller hunting for bad SeriesIDs. When some series did return one —
 * served by the observations mirror, or by a live leg that finished before the
 * quota ran out — those are kept, and the notice names the reason instead.
 */
const REQUEST_LEVEL_REASONS = new Set([
  'invalid_api_key',
  'quota_exceeded',
  'series_locked',
  'service_unavailable',
  'serialization_failure',
  'upstream_timeout',
]);

const ObservationSchema = z.object({
  year: z.string().describe('Observation year (e.g. "2024").'),
  period: z.string().describe('Observation period code (e.g. "M12" for December, "Q01" for Q1).'),
  periodName: z.string().optional().describe('Human-readable period name (e.g. "December").'),
  value: z
    .string()
    .describe(
      'Raw observation value from BLS. The literal "-" means unavailable; check available before arithmetic and read footnotes for the reason.',
    ),
  available: z
    .boolean()
    .describe('False when BLS published the "-" missing-value sentinel for this period.'),
  footnotes: z.array(z.string()).optional().describe('Footnote codes and text, when present.'),
});

export const blsGetLatestTool = tool('bls_get_latest', {
  title: 'Get Latest BLS Observation',
  description:
    'Return the single most recent observation for BLS series. SeriesIDs are trimmed, uppercased, and deduplicated in first-occurrence order. Processes the first 50 unique IDs and returns the exact remainder as unprocessedSeriesIds for a separate request. Each processed series costs one API query; bls_get_series with a 1-year window uses one query for a batch. Recommended limit: 10 series.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'BLS is unreachable or returns an unsuccessful HTTP response, and no requested series returned an observation.',
      thrownBy: 'service',
      recovery: 'Check BLS API availability and network access before retrying.',
    },
    {
      reason: 'serialization_failure',
      code: JsonRpcErrorCode.SerializationError,
      when: 'BLS returns malformed JSON, and no requested series returned an observation.',
      retryable: false,
      thrownBy: 'service',
      recovery: 'BLS returned an invalid response. Retry later; report persistent failures.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The live BLS request exceeds its shared 45-second operation budget, and no requested series returned an observation.',
      retryable: true,
      thrownBy: 'service',
      recovery: 'BLS did not respond within the operation budget. Retry after a short delay.',
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'BLS rejected the configured BLS_API_KEY as invalid, and no requested series returned an observation.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Set BLS_API_KEY to a valid key and restart the server — register free at https://data.bls.gov/registrationEngine/. This is a configuration error: it does not clear at the UTC quota reset.',
    },
    {
      reason: 'quota_exceeded',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS API 500 query/day limit has been reached, and no requested series returned an observation.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'The daily quota resets at UTC midnight. Retry after midnight or reduce query volume.',
    },
    {
      reason: 'series_locked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The BLS database is temporarily locked for the requested series, and no requested series returned an observation.',
      thrownBy: 'service',
      recovery: 'The BLS database lock is transient — retry the request after a brief delay.',
    },
  ],

  input: z.object({
    series_ids: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        'BLS SeriesIDs, trimmed, uppercased, and deduplicated in first-occurrence order. Processes the first 50 unique IDs; unprocessedSeriesIds names the exact remainder. Each processed ID consumes one daily API query. Recommended: ≤10 series.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            seriesId: z.string().describe('BLS SeriesID.'),
            title: z.string().optional().describe('Series name from BLS or the catalog index.'),
            area: z.string().optional().describe('Geographic area from BLS or the catalog index.'),
            item: z.string().optional().describe('Item/subject from BLS or the catalog index.'),
            measure: z.string().optional().describe('Measurement type and units supplied by BLS.'),
            seasonal: z
              .string()
              .optional()
              .describe('Seasonality indicator from BLS or the catalog index.'),
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
                'Error message. Common values: "Series does not exist" or "Invalid Series" (invalid SeriesID — use bls_search_series to find valid IDs), "No observations returned" (series exists but has no current data). The generic "Your request has failed. Please check your input parameters, and try your request again." means BLS rejected the request itself twice, the second time without catalog metadata, rather than naming the SeriesID. A quota, API-key, database-lock, availability, malformed-response, or timeout failure lands here only when another series returned an observation; notice then names its reason and recovery.',
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
    unprocessedSeriesIds: z
      .array(z.string())
      .optional()
      .describe(
        'Canonical unique SeriesIDs beyond the 50-series cap, in original order. Request these separately.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for unprocessed IDs, unavailable observations, or failed series — bls_search_series for a SeriesID BLS rejected, the state or national row to request for an OEWS SeriesID BLS reports nonexistent, or the reason and recovery for a request failure that left other series answered. Absent when all requested IDs returned available observations.',
      ),
  },

  enrichmentTrailer: {
    unprocessedSeriesIds: { render: (ids) => ids?.map(escapeMarkdownInline).join(', ') ?? '' },
    notice: { render: escapeMarkdownInline },
  },

  async handler(input, ctx) {
    ctx.log.info('Executing bls_get_latest', { count: input.series_ids.length });
    const service = getBlsApiService();
    const canonicalIds = [...new Set(input.series_ids.map((id) => id.trim().toUpperCase()))];
    const seriesIds = canonicalIds.slice(0, 50);
    const unprocessedSeriesIds = canonicalIds.slice(50);
    if (unprocessedSeriesIds.length > 0) ctx.enrich({ unprocessedSeriesIds });

    // Pair each seriesId with its settlement so downstream logic has the id regardless
    // of whether the fetch succeeded or rejected (rejections don't carry the seriesId).
    const pairs = await Promise.allSettled(
      seriesIds.map(async (seriesId) => ({
        seriesId,
        data: await service.fetchLatest(seriesId, ctx),
      })),
    );
    // A cancelled caller is gone; the legs that finished first are no answer to give.
    ctx.signal.throwIfAborted();

    const results: Array<{
      seriesId: string;
      title?: string;
      area?: string;
      item?: string;
      measure?: string;
      seasonal?: string;
      latestObservation?: {
        year: string;
        period: string;
        periodName?: string;
        value: string;
        available: boolean;
        footnotes?: string[];
      };
    }> = [];
    const failed: Array<{ seriesId: string; error: string }> = [];
    const requestLevel: Array<{ seriesId: string; error: McpError; reason: string }> = [];
    /** The row to request instead of each OEWS SeriesID BLS reports nonexistent (#119). */
    const oewsFallbacks = new Map<string, string>();
    let unavailableCount = 0;

    for (const [i, settlement] of pairs.entries()) {
      // Settlements and canonical IDs have the same positions and length.
      const requestedId = seriesIds[i] as string;
      if (settlement.status === 'rejected') {
        const err: unknown = settlement.reason;
        if (err instanceof McpError) {
          const reason = err.data?.reason;
          if (typeof reason === 'string' && REQUEST_LEVEL_REASONS.has(reason)) {
            requestLevel.push({ seriesId: requestedId, error: err, reason });
          }
          const fallback =
            reason === 'series_not_found' ? unpublishedOewsHint(requestedId) : undefined;
          if (fallback) oewsFallbacks.set(requestedId, fallback);
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
        ...(data.measure && { measure: data.measure }),
        ...(data.seasonal && { seasonal: data.seasonal }),
        latestObservation: {
          year: obs.year,
          period: obs.period,
          value: obs.value,
          available: obs.available ?? obs.value !== '-',
          ...(obs.periodName && { periodName: obs.periodName }),
          ...(obs.footnotes?.length && { footnotes: obs.footnotes }),
        },
      });
      if ((obs.available ?? obs.value !== '-') === false) unavailableCount++;
    }

    const [firstRequestLevel] = requestLevel;
    if (firstRequestLevel && results.length === 0) throw firstRequestLevel.error;

    const notices: string[] = [];
    if (unprocessedSeriesIds.length > 0)
      notices.push(
        `Requested ${canonicalIds.length} unique series; applied limit 50. Request the remaining SeriesIDs separately: ${unprocessedSeriesIds.join(', ')}.`,
      );
    /** Failed IDs named and sent to bls_search_series. */
    const searchNotice = (ids: string[]) =>
      `${ids.join(', ')} failed. Use bls_search_series to verify ${ids.length === 1 ? 'that SeriesID' : 'those SeriesIDs'}.`;
    if (requestLevel.length === 0) {
      const searchable = failed.filter((f) => !oewsFallbacks.has(f.seriesId));
      if (oewsFallbacks.size > 0) {
        if (searchable.length > 0) notices.push(searchNotice(searchable.map((f) => f.seriesId)));
      } else if (failed.length > 0) {
        const allFailed = results.length === 0;
        notices.push(
          allFailed
            ? `All ${failed.length} series failed. Use bls_search_series to verify the SeriesIDs are valid before retrying.`
            : `${failed.length} of ${seriesIds.length} series failed. Use bls_search_series to verify the failing SeriesIDs.`,
        );
      }
    } else {
      ctx.log.warning('bls_get_latest: answering with the series that succeeded', {
        seriesIds: requestLevel.map((r) => r.seriesId),
        reasons: [...new Set(requestLevel.map((r) => r.reason))],
      });
      const requestLevelIds = new Set(requestLevel.map((r) => r.seriesId));
      const unresolved = failed.filter(
        (f) => !requestLevelIds.has(f.seriesId) && !oewsFallbacks.has(f.seriesId),
      );
      if (unresolved.length > 0) notices.push(searchNotice(unresolved.map((f) => f.seriesId)));
      const byReason = new Map<string, { ids: string[]; hint: unknown }>();
      for (const { seriesId, error, reason } of requestLevel) {
        const group = byReason.get(reason) ?? {
          ids: [],
          hint: (error.data?.recovery as { hint?: unknown } | undefined)?.hint,
        };
        group.ids.push(seriesId);
        byReason.set(reason, group);
      }
      for (const [reason, { ids, hint }] of byReason) {
        notices.push(
          `${ids.join(', ')} failed with ${reason}, a failure of the request rather than of the SeriesID.${typeof hint === 'string' ? ` ${hint}` : ''}`,
        );
      }
    }
    for (const [seriesId, fallback] of oewsFallbacks) {
      notices.push(`BLS reports ${seriesId} is invalid or does not exist. ${fallback}`);
    }
    if (unavailableCount > 0) {
      notices.push(
        `${unavailableCount} latest observation(s) are unavailable in BLS data. Check latestObservation.available and read footnotes for the reason.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      results,
      succeeded: results.length,
      failed,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const r of result.results) {
      const obs = r.latestObservation;
      if (!obs) continue;
      lines.push(
        `**${escapeMarkdownInline(r.seriesId)}**${r.title ? ` — ${escapeMarkdownInline(r.title)}` : ''}`,
      );
      const periodStr = obs.periodName
        ? `${obs.periodName} ${obs.year}`
        : `${obs.period} ${obs.year}`;
      lines.push(
        (obs.available ?? obs.value !== '-')
          ? `Value: **${escapeMarkdownInline(obs.value)}** (${escapeMarkdownInline(periodStr)})`
          : `Value: **Unavailable** (BLS raw value: \`${obs.value}\`; ${escapeMarkdownInline(periodStr)})`,
      );
      lines.push(`Available: ${(obs.available ?? obs.value !== '-') ? 'yes' : 'no'}`);
      lines.push(`Period: ${escapeMarkdownInline(obs.period)}`);
      if (obs.footnotes?.length)
        lines.push(`Footnotes: ${escapeMarkdownInline(obs.footnotes.join('; '))}`);
      if (r.area) lines.push(`Area: ${escapeMarkdownInline(r.area)}`);
      if (r.item) lines.push(`Item: ${escapeMarkdownInline(r.item)}`);
      if (r.measure) lines.push(`Measure: ${escapeMarkdownInline(r.measure)}`);
      if (r.seasonal) lines.push(`Seasonality: ${escapeMarkdownInline(r.seasonal)}`);
      lines.push('');
    }
    if (result.failed.length > 0) {
      lines.push(`**${result.failed.length} failed:**`);
      for (const f of result.failed) {
        lines.push(`- ${escapeMarkdownInline(f.seriesId)}: ${escapeMarkdownInline(f.error)}`);
      }
    }
    const total = result.results.length + result.failed.length;
    lines.push(`_${result.succeeded} of ${total} series returned data._`);
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
