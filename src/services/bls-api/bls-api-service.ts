/**
 * @fileoverview BLS API v2 service. Wraps `POST /timeseries/data` (batch series
 * fetch with optional calculations), `GET /timeseries/data/{id}?latest=true`
 * (single-series latest observation), and `GET /surveys` / `GET /surveys/{abbr}`
 * (survey metadata). Applies retry with 1–2s backoff. Surfaces an invalid API
 * key, quota exhaustion, series-not-found, locked-series, no-data,
 * calculations-not-supported, and otherwise-unrecognized request rejections as
 * typed error data so calling tools can produce the right `ctx.fail` reason.
 * Deterministic failures (quota exhaustion, request rejection) carry
 * `retryable: false` so the framework's `withRetry` fails fast instead of
 * burning quota on doomed attempts.
 *
 * Every upstream message is redacted as it is read: BLS echoes the submitted key
 * back when it rejects one, and these messages flow into thrown errors' `data`
 * and message strings, both of which reach the client.
 *
 * When `BLS_OBSERVATIONS_MIRROR_ENABLED=true` and the mirror has completed at
 * least one full sync, `fetchSeries` and `fetchLatest` are routed through the
 * local SQLite mirror instead of the BLS API, bypassing the 500/day quota cap.
 * Series IDs missing from the mirror fall back to the live API when
 * `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=true` (the default); a fallback that
 * fails leaves those IDs empty, with the failure attached, rather than
 * discarding what the mirror served.
 *
 * Both live calls request BLS catalog metadata, and re-issue a request once
 * without it when BLS answers with its generic, series-less rejection.
 * @module services/bls-api/bls-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  configurationError,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getBlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';
import {
  getBlsObservationsService,
  isBlsObservationsServiceReady,
} from '@/services/bls-observations/bls-observations-service.js';
import type { ObservationRow } from '@/services/bls-observations/types.js';
import type {
  BlsApiResponse,
  BlsSurveysResponse,
  Observation,
  RawObservation,
  SeriesData,
  SurveyMeta,
} from './types.js';

/** In-memory survey cache TTL — 30 days. */
const SURVEY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Stands in for the configured API key wherever BLS echoes it back to us. */
const REDACTED_API_KEY = '[REDACTED]';

/**
 * BLS's rejection of a key it does not recognize. Verified 2026-07-17 against
 * all three endpoints this service calls — `POST /timeseries/data`,
 * `GET /timeseries/data/{id}?latest=true`, and `GET /surveys` — each of which
 * answers an unregistered key with HTTP 200 and `REQUEST_NOT_PROCESSED` plus
 * the single message `The key:<key> provided by the User is invalid. Please
 * provide a proper key for the operation to be successful`.
 *
 * Matched on the message rather than the status because `REQUEST_NOT_PROCESSED`
 * is overloaded: quota exhaustion returns it too, and BLS documents neither
 * message. Only the invalid-key phrasing is confirmed, so it is the one matched
 * positively; everything else under that status stays quota.
 */
const INVALID_KEY_PATTERN = /provided by the User is invalid/i;

/**
 * Capability flags for every BLS survey, keyed by `survey_abbreviation`.
 *
 * The bulk `/surveys` endpoint returns only `survey_abbreviation` and
 * `survey_name`; the flags live exclusively on the per-survey `/surveys/{code}`
 * endpoint. Fetching ~70 surveys individually at runtime would spend an eighth
 * of the 500/day quota on metadata every time the process-local cache lapsed,
 * so the sweep is done once at development time and its result baked in here.
 *
 * Covers all 70 abbreviations the bulk endpoint returns, so `listSurveys()`
 * never has to guess. To re-derive after BLS adds or changes a survey:
 * `GET /surveys` for the abbreviation list, then `GET /surveys/{abbr}` for each.
 *
 * Verified 2026-07-17 against `/surveys/{abbr}`, and cross-checked for 17
 * surveys against a live `POST /timeseries/data` with `calculations: true` —
 * the flags predicted which calculations the API actually returned in every
 * case, including the percent-only and neither-supported surveys. Exported as
 * the swept survey inventory, which the `bls_list_surveys` category tests walk.
 */
export const SURVEY_CAPABILITIES: Record<
  string,
  { allowsNetChange: boolean; allowsPercentChange: boolean; hasAnnualAverages: boolean }
> = {
  AP: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  BD: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  BG: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  BP: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  CA: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CB: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CC: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: true },
  CD: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CE: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  CF: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CH: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CI: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  CM: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  CS: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  CU: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  CW: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  CX: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  EB: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  EC: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  EE: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  EI: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  EN: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  EP: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  EW: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  FA: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  FI: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  FM: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  FW: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  GG: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  GP: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  HC: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  HS: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  II: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  IN: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  IP: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  IS: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  JL: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  JT: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  KV: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  LA: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  LE: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  LF: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  LI: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  LN: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  LU: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  ML: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  MP: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  MU: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  MW: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  NB: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  NC: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  ND: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  NW: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  OE: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  OR: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  PC: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  PD: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  PF: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  PI: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  PR: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: true },
  SA: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  SH: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  SI: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  SM: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  SU: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  TU: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  WD: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  WM: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: false },
  WP: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  WS: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
};

/**
 * Lay resolved series out at their requested positions, one entry per position.
 *
 * An ID no source resolved becomes a zero-observation entry. It carries no
 * `failure`: that field reports a BLS advisory about the series, and calling a
 * local-store miss `series_not_found` would attribute to BLS a rejection it
 * never issued. The absence is also what selects the generic recovery notice
 * `bls_get_series` composes for an empty entry.
 */
function alignToRequestOrder(seriesIds: string[], resolved: SeriesData[]): SeriesData[] {
  const byId = new Map(resolved.map((series) => [series.seriesId, series]));
  return seriesIds.map((seriesId) => byId.get(seriesId) ?? { seriesId, observations: [] });
}

/**
 * Describe a failed live fallback for the entries it left empty: the typed
 * `reason` and the recovery hint the calling tool's contract resolved, or the
 * bare message for an untyped failure such as a network error.
 */
function describeLiveFailure(error: unknown): NonNullable<SeriesData['liveFailure']> {
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof McpError ? error.data : undefined;
  const reason = data?.reason;
  const hint = (data?.recovery as { hint?: unknown } | undefined)?.hint;
  return {
    message,
    ...(typeof reason === 'string' && { reason }),
    ...(typeof hint === 'string' && { recovery: hint }),
  };
}

/** Title, area, item, and seasonality as the catalog index records them. */
function catalogFields(
  match: CatalogSeries | undefined,
): Pick<SeriesData, 'area' | 'item' | 'seasonal' | 'title'> {
  if (!match) return {};
  return {
    ...(match.title && { title: match.title }),
    ...(match.areaName && { area: match.areaName }),
    ...(match.itemName && { item: match.itemName }),
    seasonal: match.seasonal ? 'Seasonally Adjusted' : 'Not Seasonally Adjusted',
  };
}

/** Catalog-index metadata for `ids`, or none while the index is unavailable. */
async function lookupCatalogMetadata(ids: string[]): Promise<Map<string, CatalogSeries>> {
  let catalog: ReturnType<typeof getBlsCatalogService>;
  try {
    catalog = getBlsCatalogService();
  } catch {
    return new Map();
  }
  return catalog.isLoaded ? await catalog.lookupByIds(ids) : new Map();
}

/** One BLS advisory about a requested SeriesID. */
type SeriesAdvisory = NonNullable<SeriesData['failure']>;

export interface BatchFetchOptions {
  /**
   * Request BLS's annual-average rows (period M13/Q05/S03) alongside the real
   * periods. Off unless asked: the rows are a year's mean, not an extra period,
   * so a caller reducing `observations` would double-count each year.
   */
  annualAverage?: boolean;
  calculations?: boolean;
  endYear?: number;
  seriesIds: string[];
  startYear?: number;
}

export class BlsApiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private surveyCache: { surveys: SurveyMeta[]; cachedAt: number } | undefined;

  constructor(apiKey: string, baseUrl: string, userAgent: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
  }

  /** Batch-fetch 1–50 series. One API query regardless of series count. */
  async fetchSeries(options: BatchFetchOptions, ctx: Context): Promise<SeriesData[]> {
    const cfg = getServerConfig();

    // ── Mirror routing ───────────────────────────────────────────────────────
    if (cfg.observationsMirrorEnabled && isBlsObservationsServiceReady()) {
      const mirror = getBlsObservationsService();
      const isReady = await mirror.ready();

      if (isReady) {
        ctx.log.debug('fetchSeries: routing via observations mirror', {
          seriesCount: options.seriesIds.length,
        });
        /**
         * LABSTAT bakes annual-average rows into the bulk files unconditionally,
         * so the flag has to travel to the mirror too — otherwise enabling the
         * mirror would silently change what an identical request returns.
         */
        const mirrorResult = await mirror.queryBySeries({
          seriesIds: options.seriesIds,
          annualAverage: options.annualAverage ?? false,
          ...(options.startYear !== undefined ? { startYear: options.startYear } : {}),
          ...(options.endYear !== undefined ? { endYear: options.endYear } : {}),
        });

        const resolved = await this.mirrorRowsToSeriesData(mirrorResult.observations);
        const { missedIds } = mirrorResult;

        if (missedIds.length > 0) {
          if (cfg.observationsMirrorFallbackLive) {
            ctx.log.notice('fetchSeries: mirror miss, falling back to live API', { missedIds });
            try {
              resolved.push(
                ...(await this.fetchSeriesLive({ ...options, seriesIds: missedIds }, ctx)),
              );
            } catch (error) {
              /**
               * The mirror exists to answer without the live API, so a failed
               * fallback is a fact about the missed IDs rather than a verdict on
               * the request — least of all a quota wall, which leaves the mirror
               * the only source still answering. With no mirrored observations
               * there is nothing to keep, and a cancelled caller is gone: both
               * still fail, with the live error as thrown.
               */
              if (ctx.signal.aborted || !resolved.some((s) => s.observations.length > 0)) {
                throw error;
              }
              const liveFailure = describeLiveFailure(error);
              // Not `message`: the client-facing log line would take it as its own text.
              ctx.log.warning('fetchSeries: live fallback failed; answering from the mirror', {
                missedIds,
                reason: liveFailure.reason,
                error: liveFailure.message,
              });
              resolved.push(
                ...missedIds.map((seriesId) => ({ seriesId, observations: [], liveFailure })),
              );
            }
          } else {
            ctx.log.notice('fetchSeries: mirror_partial — some series IDs not in mirror', {
              missedIds,
            });
          }
        }

        /**
         * Both sources answer in their own order — the mirror groups rows the
         * store sorted year-DESC, the fallback answers only the IDs it was
         * given — and neither is obliged to answer at all. Reconciling here is
         * what makes the declared "in request order" contract true and keeps an
         * ID no source resolved visible instead of silently absent.
         */
        return alignToRequestOrder(options.seriesIds, resolved);
      }

      // Mirror not yet ready
      if (!cfg.observationsMirrorFallbackLive) {
        throw serviceUnavailable(
          'Observations mirror is enabled but not yet ready — run the one-time bootstrap first (BLS_OBSERVATIONS_MIRROR_ENABLED=true, then trigger an init sync).',
          { reason: 'service_unavailable' },
        );
      }
      ctx.log.notice('fetchSeries: mirror not ready, falling back to live API');
    }

    // ── Live API path (default / fallback) ──────────────────────────────────
    return this.fetchSeriesLive(options, ctx);
  }

  /** Live API batch fetch — one `POST /timeseries/data`, re-issued once on the generic rejection. */
  private fetchSeriesLive(options: BatchFetchOptions, ctx: Context): Promise<SeriesData[]> {
    return this.withCatalogReissue(
      (catalog) =>
        withRetry(
          async () => {
            const body: Record<string, unknown> = {
              seriesid: options.seriesIds,
              registrationkey: this.apiKey,
            };
            if (catalog) body.catalog = true;
            if (options.startYear !== undefined) body.startyear = String(options.startYear);
            if (options.endYear !== undefined) body.endyear = String(options.endYear);
            if (options.calculations) body.calculations = true;
            if (options.annualAverage) body.annualaverage = true;

            const response = await fetch(`${this.baseUrl}/timeseries/data`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
              body: JSON.stringify(body),
              signal: ctx.signal,
            });

            return this.parseSeriesResponse(await response.text(), options, ctx);
          },
          {
            operation: 'BlsApiService.fetchSeries',
            baseDelayMs: 1500,
            signal: ctx.signal,
          },
        ),
      ctx,
    );
  }

  /**
   * Send a request with BLS catalog metadata, re-issuing it once without on
   * BLS's generic rejection.
   *
   * With catalog metadata requested, BLS intermittently answers a request
   * holding a nonexistent SeriesID — malformed or well-formed — with
   * `REQUEST_FAILED` and a message naming no series (16 of 27 live probes on
   * 2026-09-24), which loses every valid series in the batch. The same request
   * without catalog metadata answered per-series every time (0 of 25), so the
   * re-issue recovers the advisories, and the catalog index supplies the
   * metadata BLS then leaves out. A second generic answer is a genuine rejection
   * and stays `request_rejected`. Every other answer — success included — costs
   * one request, as before. `send` owns its retry loop, so a transient failure on
   * the re-issue never repeats the catalog request, and a cancelled caller's
   * re-issue rejects at `fetch` without being sent.
   */
  private async withCatalogReissue(
    send: (catalog: boolean) => Promise<SeriesData[]>,
    ctx: Context,
  ): Promise<SeriesData[]> {
    try {
      return await send(true);
    } catch (error) {
      if (!(error instanceof McpError && error.data?.reason === 'request_rejected')) throw error;
      ctx.log.notice('BLS rejected a request carrying catalog metadata; re-issuing it without');
      const series = await send(false);
      const metadata = await lookupCatalogMetadata(series.map((s) => s.seriesId));
      return series.map((s) => ({ ...s, ...catalogFields(metadata.get(s.seriesId)) }));
    }
  }

  /** Fetch the single most recent observation for one series. */
  async fetchLatest(seriesId: string, ctx: Context): Promise<SeriesData> {
    const cfg = getServerConfig();

    // ── Mirror routing ───────────────────────────────────────────────────────
    if (cfg.observationsMirrorEnabled && isBlsObservationsServiceReady()) {
      const mirror = getBlsObservationsService();
      const isReady = await mirror.ready();

      if (isReady) {
        ctx.log.debug('fetchLatest: routing via observations mirror', { seriesId });
        const mirrorResult = await mirror.queryLatest([seriesId]);

        if (mirrorResult.observations.length > 0) {
          const seriesList = await this.mirrorRowsToSeriesData(mirrorResult.observations);
          const found = seriesList.find((s) => s.seriesId === seriesId);
          if (found) return found;
        }

        // Series not in mirror — fall back to live if enabled
        if (!cfg.observationsMirrorFallbackLive) {
          throw notFound(
            `Series ${seriesId} not found in local mirror. Run a mirror bootstrap or set BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=true.`,
            { reason: 'series_not_found', seriesId },
          );
        }
        ctx.log.notice('fetchLatest: mirror miss, falling back to live API', { seriesId });
      } else {
        if (!cfg.observationsMirrorFallbackLive) {
          throw serviceUnavailable(
            'Observations mirror is enabled but not yet ready — run the one-time bootstrap first.',
            { reason: 'service_unavailable' },
          );
        }
        ctx.log.notice('fetchLatest: mirror not ready, falling back to live API');
      }
    }

    // ── Live API path (default / fallback) ──────────────────────────────────
    const series = await this.withCatalogReissue(
      (catalog) =>
        withRetry(
          async () => {
            const url = `${this.baseUrl}/timeseries/data/${encodeURIComponent(seriesId)}?latest=true${catalog ? '&catalog=true' : ''}&registrationkey=${this.apiKey}`;
            const response = await fetch(url, {
              headers: { 'User-Agent': this.userAgent },
              signal: ctx.signal,
            });
            return this.parseSeriesResponse(await response.text(), { seriesIds: [seriesId] }, ctx);
          },
          {
            operation: 'BlsApiService.fetchLatest',
            baseDelayMs: 1500,
            signal: ctx.signal,
          },
        ),
      ctx,
    );
    const found = series.find((s) => s.seriesId === seriesId);
    if (!found) {
      throw notFound(`Series not found: ${seriesId}`, { reason: 'series_not_found', seriesId });
    }
    return found;
  }

  /**
   * Convert mirror observation rows to SeriesData, hydrating catalog metadata
   * (title, area, item, seasonal) from the on-disk catalog index.
   * The LABSTAT data files carry only raw observation values — catalog metadata
   * must be joined from the catalog service's series index. Each series is
   * marked `source: 'mirror'`: the rows carry no BLS calculations, and
   * `bls_get_series` reports as much when calculations were requested.
   *
   * Series come back in row order and only for IDs the rows cover; the caller
   * lays them out against the request via {@link alignToRequestOrder}.
   */
  private async mirrorRowsToSeriesData(rows: ObservationRow[]): Promise<SeriesData[]> {
    // Group rows by series_id, ordered by (year DESC, period DESC)
    const grouped = new Map<string, ObservationRow[]>();
    for (const row of rows) {
      let list = grouped.get(row.series_id);
      if (!list) {
        list = [];
        grouped.set(row.series_id, list);
      }
      list.push(row);
    }

    const metadata = await lookupCatalogMetadata([...grouped.keys()]);

    const result: SeriesData[] = [];
    for (const [seriesId, obsRows] of grouped) {
      const observations: Observation[] = obsRows
        .slice()
        .sort((a, b) =>
          a.year !== b.year ? b.year.localeCompare(a.year) : b.period.localeCompare(a.period),
        )
        .map((row) => ({
          year: row.year,
          period: row.period,
          value: row.value,
          available: row.value !== '-',
          ...(row.footnote_codes ? { footnotes: [row.footnote_codes] } : {}),
        }));

      result.push({
        seriesId,
        ...catalogFields(metadata.get(seriesId)),
        observations,
        source: 'mirror',
      });
    }
    return result;
  }

  /** List all surveys. Cached in-memory for 30 days per process. */
  async listSurveys(ctx: Context): Promise<SurveyMeta[]> {
    if (this.surveyCache && Date.now() - this.surveyCache.cachedAt < SURVEY_CACHE_TTL_MS) {
      return this.surveyCache.surveys;
    }

    const surveys = await withRetry(
      async () => {
        const url = `${this.baseUrl}/surveys?registrationkey=${this.apiKey}`;
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal: ctx.signal,
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'BLS surveys API returned HTML instead of JSON — likely rate-limited.',
            { reason: 'service_unavailable', ...ctx.recoveryFor('service_unavailable') },
          );
        }
        let parsed: BlsSurveysResponse;
        try {
          parsed = JSON.parse(text) as BlsSurveysResponse;
        } catch (e: unknown) {
          throw serializationError(
            'Failed to parse BLS surveys response as JSON',
            { reason: 'serialization_failure', ...ctx.recoveryFor('serialization_failure') },
            { cause: e },
          );
        }
        if (parsed.status !== 'REQUEST_SUCCEEDED') {
          // `/surveys` authenticates like the data endpoints, so a bad key lands
          // here too. The generic branch below would call it an upstream outage
          // and — its code being transient — keep retrying the bad key.
          const messages = this.redactMessages(parsed.message);
          if (messages.some((m) => INVALID_KEY_PATTERN.test(m))) {
            throw this.invalidApiKeyError(ctx);
          }
          throw serviceUnavailable(`BLS surveys API: ${messages.join('; ') || 'unknown error'}`, {
            reason: 'service_unavailable',
            ...ctx.recoveryFor('service_unavailable'),
          });
        }
        return (parsed.Results?.survey ?? []).map((s): SurveyMeta => {
          const abbr = s.survey_abbreviation.toUpperCase();
          const caps = SURVEY_CAPABILITIES[abbr];
          return {
            surveyAbbreviation: s.survey_abbreviation,
            surveyName: s.survey_name,
            // The bulk endpoint omits capability flags, so merge them from the
            // swept table, which covers every abbreviation BLS currently lists.
            // The fallbacks only engage for a survey added upstream since the
            // last sweep: prefer the bulk payload if it ever carries the flags,
            // else report false rather than inventing support.
            allowsNetChange: caps?.allowsNetChange ?? s.allowsNetChange === 'true',
            allowsPercentChange: caps?.allowsPercentChange ?? s.allowsPercentChange === 'true',
            hasAnnualAverages: caps?.hasAnnualAverages ?? s.hasAnnualAverages === 'true',
          };
        });
      },
      {
        operation: 'BlsApiService.listSurveys',
        baseDelayMs: 1500,
        signal: ctx.signal,
      },
    );

    this.surveyCache = { surveys, cachedAt: Date.now() };
    return surveys;
  }

  /**
   * Read BLS's message array with the configured key masked out of it.
   *
   * BLS embeds the submitted key verbatim when rejecting one, and callers
   * forward these strings into error `data` and, in places, the error message
   * itself — both reach the client. Redacting here, where the messages are read,
   * covers every throw site and stays independent of BLS's wording: a key echoed
   * in some future message is masked without a new pattern to match.
   */
  private redactMessages(raw: string[] | undefined): string[] {
    const messages = raw ?? [];
    // The key is optional (BLS serves unregistered callers on a 25/day tier).
    // Splitting on an empty key would insert the placeholder between every
    // character, so an absent key is simply nothing to redact.
    if (!this.apiKey) return messages;
    return messages.map((m) => m.replaceAll(this.apiKey, REDACTED_API_KEY));
  }

  /**
   * The configured `BLS_API_KEY` is rejected — a configuration failure, not a
   * quota or availability one: nothing upstream is wrong and no amount of waiting
   * fixes it. `ConfigurationError` also sits outside `withRetry`'s transient set,
   * so the request stops re-sending a key that cannot start working.
   *
   * The upstream message is deliberately not attached: beyond what `reason`
   * already says, the key is all it carries.
   */
  private invalidApiKeyError(ctx: Context): McpError {
    return configurationError('BLS rejected the configured BLS_API_KEY as invalid.', {
      reason: 'invalid_api_key',
      retryable: false,
      ...ctx.recoveryFor('invalid_api_key'),
    });
  }

  private parseSeriesResponse(
    text: string,
    options: Pick<BatchFetchOptions, 'seriesIds'>,
    ctx: Context,
  ): SeriesData[] {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'BLS API returned HTML instead of JSON — likely rate-limited or temporarily unavailable.',
      );
    }

    let parsed: BlsApiResponse;
    try {
      parsed = JSON.parse(text) as BlsApiResponse;
    } catch (e: unknown) {
      throw serializationError('Failed to parse BLS API response as JSON', {}, { cause: e });
    }

    // Check for known BLS error messages
    const messages = this.redactMessages(parsed.message);
    for (const msg of messages) {
      // Ahead of the REQUEST_NOT_PROCESSED fallback, which would otherwise report
      // a rejected key as a quota wall that clears at UTC midnight.
      if (INVALID_KEY_PATTERN.test(msg)) throw this.invalidApiKeyError(ctx);
      if (/daily query limit|500 queries|limit reached/i.test(msg)) {
        // Deterministic until the UTC-midnight reset — retrying only burns more quota.
        throw serviceUnavailable('BLS API daily query limit (500/day) reached.', {
          reason: 'quota_exceeded',
          retryable: false,
          messages,
          ...ctx.recoveryFor('quota_exceeded'),
        });
      }
      if (/database is locked/i.test(msg)) {
        throw serviceUnavailable('BLS database is temporarily locked — retry shortly.', {
          reason: 'series_locked',
          messages,
          ...ctx.recoveryFor('series_locked'),
        });
      }
      if (/calculations.*not supported|does not support.*calculations/i.test(msg)) {
        throw validationError(
          'This survey does not support calculations — remove the calculations flag or check bls_list_surveys.',
          {
            reason: 'calculations_not_supported',
            messages,
            ...ctx.recoveryFor('calculations_not_supported'),
          },
        );
      }
    }

    if (parsed.status === 'REQUEST_NOT_PROCESSED') {
      // The catch-all for this status, not a positive quota match: BLS overloads
      // it and documents none of its message text. Invalid keys are matched by
      // message above; quota is the only other cause known to land here, and the
      // wording below hedges accordingly. Retrying unchanged cannot help.
      throw serviceUnavailable(
        'BLS API request not processed. Daily quota (500 queries/day) may be exhausted — retry after UTC midnight.',
        {
          reason: 'quota_exceeded',
          retryable: false,
          messages,
          ...ctx.recoveryFor('quota_exceeded'),
        },
      );
    }

    const failures = this.classifySeriesFailures(messages, options.seriesIds);

    if (parsed.status !== 'REQUEST_SUCCEEDED') {
      if (failures.size > 0) this.throwSeriesFailure(failures, messages, options, ctx);

      // BLS rejected the request with a message none of the branches above
      // recognize (e.g. "Your request has failed. Please check your input
      // parameters"). Retrying identical parameters cannot help, so this fails
      // fast; withCatalogReissue sends the request once more without catalog
      // metadata, the one change measured to clear it.
      throw serviceUnavailable(`BLS API error: ${messages.join('; ') || parsed.status}`, {
        reason: 'request_rejected',
        retryable: false,
        messages,
        ...ctx.recoveryFor('request_rejected'),
      });
    }

    const byId = new Map((parsed.Results?.series ?? []).map((raw) => [raw.seriesID, raw]));
    const series = options.seriesIds.flatMap((seriesId): SeriesData[] => {
      const raw = byId.get(seriesId);
      // The entry reports the class of the failure, which every advisory for one
      // SeriesID shares; the full set shapes the request-level error instead.
      const failure = failures.get(seriesId)?.[0];
      if (!raw) return failure ? [{ seriesId, observations: [], failure }] : [];
      const cat = raw.catalog;
      return [
        {
          seriesId: raw.seriesID,
          ...(cat?.series_title && { title: cat.series_title }),
          ...(cat?.area && { area: cat.area }),
          ...(cat?.item && { item: cat.item }),
          ...(cat?.seasonality && { seasonal: cat.seasonality }),
          observations: raw.data.map((obs) => this.normalizeObs(obs)),
          ...(failure && { failure }),
        },
      ];
    });

    if (series.every((item) => item.observations.length === 0) && failures.size > 0) {
      this.throwSeriesFailure(failures, messages, options, ctx);
    }

    return series;
  }

  /**
   * Associate BLS advisories with the SeriesID they describe, keeping every
   * advisory an ID collects. A series uncovered over a multi-year window draws
   * one message per year, so keying them last-wins reported a single year of an
   * otherwise complete verdict.
   */
  private classifySeriesFailures(
    messages: string[],
    requestedIds: string[],
  ): Map<string, SeriesAdvisory[]> {
    const failures = new Map<string, SeriesAdvisory[]>();
    for (const message of messages) {
      const reason = /does not exist|invalid series/i.test(message)
        ? 'series_not_found'
        : /no data available/i.test(message)
          ? 'no_data_for_period'
          : undefined;
      if (!reason) continue;

      const id = requestedIds.find((requestedId) =>
        new RegExp(
          `(?:^|\\s)${requestedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
          'i',
        ).test(message),
      );
      if (!id) continue;
      const collected = failures.get(id);
      if (collected) collected.push({ reason, message });
      else failures.set(id, [{ reason, message }]);
    }
    return failures;
  }

  /**
   * Raise the request-level error used when no requested series produced data.
   *
   * The reason follows the composition of the advisories rather than the first
   * invalid ID that turns up: all-invalid raises `series_not_found`, all-
   * uncovered raises `no_data_for_period`, and a mixed batch keeps the stricter
   * `series_not_found` — an invalid SeriesID is wrong at any window, while a
   * period miss may resolve once the window moves. Only two reasons are
   * declared, so a mixed batch carries the second class in the message and in a
   * recovery hint naming both moves; sending the caller to re-resolve an ID that
   * is already correct is the failure this replaces.
   */
  private throwSeriesFailure(
    failures: Map<string, SeriesAdvisory[]>,
    messages: string[],
    options: Pick<BatchFetchOptions, 'seriesIds'>,
    ctx: Context,
  ): never {
    const failing = options.seriesIds
      .map((seriesId) => ({ seriesId, advisories: failures.get(seriesId) ?? [] }))
      .filter((entry) => entry.advisories.length > 0);

    const invalidIds = failing
      .filter((entry) => entry.advisories.some((a) => a.reason === 'series_not_found'))
      .map((entry) => entry.seriesId);
    const uncoveredIds = failing
      .filter((entry) => entry.advisories.every((a) => a.reason === 'no_data_for_period'))
      .map((entry) => entry.seriesId);

    // One line per SeriesID, carrying every advisory BLS issued about it. A
    // lone failing ID reads better inline than under a one-item list.
    const lines = failing.map(
      (entry) => `${entry.seriesId}: ${entry.advisories.map((a) => a.message).join('; ')}`,
    );
    const detail = lines.length === 1 ? ` ${lines[0]}` : `\n  ${lines.join('\n  ')}`;
    const data = { messages, seriesIds: options.seriesIds };

    if (invalidIds.length === 0) {
      throw validationError(`BLS API: No data available for the requested period range.${detail}`, {
        reason: 'no_data_for_period',
        ...data,
        ...ctx.recoveryFor('no_data_for_period'),
      });
    }

    if (uncoveredIds.length === 0) {
      throw notFound(`BLS API: no requested SeriesID exists.${detail}`, {
        reason: 'series_not_found',
        ...data,
        ...ctx.recoveryFor('series_not_found'),
      });
    }

    throw notFound(
      `BLS API: no requested series returned data. Invalid: ${invalidIds.join(', ')}. No data for the requested period: ${uncoveredIds.join(', ')}.${detail}`,
      {
        reason: 'series_not_found',
        ...data,
        recovery: {
          hint: `Replace ${invalidIds.join(', ')} with a valid SeriesID from bls_search_series, and adjust start_year/end_year to a range ${uncoveredIds.join(', ')} covers.`,
        },
      },
    );
  }

  private normalizeObs(raw: RawObservation): Observation {
    const nc = raw.calculations?.net_changes;
    const pc = raw.calculations?.pct_changes;
    return {
      year: raw.year,
      period: raw.period,
      value: raw.value,
      available: raw.value !== '-',
      ...(raw.periodName && { periodName: raw.periodName }),
      ...(raw.footnotes?.length && {
        footnotes: raw.footnotes
          .map((f) => [f.code, f.text].filter(Boolean).join(': '))
          .filter(Boolean),
      }),
      ...(nc?.['1'] && { netChange1Month: nc['1'] }),
      ...(nc?.['3'] && { netChange3Month: nc['3'] }),
      ...(nc?.['6'] && { netChange6Month: nc['6'] }),
      ...(nc?.['12'] && { netChange12Month: nc['12'] }),
      ...(pc?.['1'] && { pctChange1Month: pc['1'] }),
      ...(pc?.['3'] && { pctChange3Month: pc['3'] }),
      ...(pc?.['6'] && { pctChange6Month: pc['6'] }),
      ...(pc?.['12'] && { pctChange12Month: pc['12'] }),
    };
  }
}

let _service: BlsApiService | undefined;

export function initBlsApiService(_config: AppConfig, _storage: unknown): void {
  const cfg = getServerConfig();
  _service = new BlsApiService(cfg.apiKey, cfg.baseUrl, cfg.userAgent);
}

export function getBlsApiService(): BlsApiService {
  if (!_service) {
    throw new Error('BlsApiService not initialized — call initBlsApiService() in setup()');
  }
  return _service;
}
