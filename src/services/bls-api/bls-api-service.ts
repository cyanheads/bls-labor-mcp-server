/**
 * @fileoverview BLS API v2 service. Wraps `POST /timeseries/data` (batch series
 * fetch with optional calculations), `GET /timeseries/data/{id}?latest=true`
 * (single-series latest observation), and `GET /surveys` / `GET /surveys/{abbr}`
 * (survey metadata). Applies retry with 1–2s backoff. Surfaces quota exhaustion,
 * series-not-found, locked-series, no-data, calculations-not-supported, and
 * otherwise-unrecognized request rejections as typed error data so calling tools
 * can produce the right `ctx.fail` reason. Deterministic failures (quota
 * exhaustion, request rejection) carry `retryable: false` so the framework's
 * `withRetry` fails fast instead of burning quota on doomed attempts.
 *
 * When `BLS_OBSERVATIONS_MIRROR_ENABLED=true` and the mirror has completed at
 * least one full sync, `fetchSeries` and `fetchLatest` are routed through the
 * local SQLite mirror instead of the BLS API, bypassing the 500/day quota cap.
 * Series IDs missing from the mirror fall back to the live API when
 * `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=true` (the default).
 * @module services/bls-api/bls-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
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
 * case, including the percent-only and neither-supported surveys.
 */
const SURVEY_CAPABILITIES: Record<
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

        const mirrorSeries = await this.mirrorRowsToSeriesData(mirrorResult.observations);

        // Fetch missing IDs from live API when fallback is enabled
        if (mirrorResult.missedIds.length > 0 && cfg.observationsMirrorFallbackLive) {
          ctx.log.notice('fetchSeries: mirror miss, falling back to live API', {
            missedIds: mirrorResult.missedIds,
          });
          const liveSeries = await this.fetchSeriesLive(
            { ...options, seriesIds: mirrorResult.missedIds },
            ctx,
          );
          return [...mirrorSeries, ...liveSeries];
        }

        // Emit a notice when coverage is partial but fallback is disabled
        if (!mirrorResult.complete) {
          ctx.log.notice('fetchSeries: mirror_partial — some series IDs not in mirror', {
            missedIds: mirrorResult.missedIds,
          });
        }

        return mirrorSeries;
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

  /** Live API batch fetch — the original implementation. */
  private fetchSeriesLive(options: BatchFetchOptions, ctx: Context): Promise<SeriesData[]> {
    return withRetry(
      async () => {
        const body: Record<string, unknown> = {
          seriesid: options.seriesIds,
          registrationkey: this.apiKey,
          catalog: true,
        };
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
    );
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
    return withRetry(
      async () => {
        const url = `${this.baseUrl}/timeseries/data/${encodeURIComponent(seriesId)}?latest=true&catalog=true&registrationkey=${this.apiKey}`;
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal: ctx.signal,
        });
        const text = await response.text();
        const series = this.parseSeriesResponse(text, { seriesIds: [seriesId] }, ctx);
        const found = series.find((s) => s.seriesId === seriesId);
        if (!found) {
          throw notFound(`Series not found: ${seriesId}`, {
            reason: 'series_not_found',
            seriesId,
          });
        }
        return found;
      },
      {
        operation: 'BlsApiService.fetchLatest',
        baseDelayMs: 1500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Convert mirror observation rows to SeriesData, hydrating catalog metadata
   * (title, area, item, seasonal) from the in-memory catalog index.
   * The LABSTAT data files carry only raw observation values — catalog metadata
   * must be joined from the catalog service's in-memory series index.
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

    // Hydrate catalog metadata in one batch lookup when the catalog is available.
    const catalog = (() => {
      try {
        const svc = getBlsCatalogService();
        return svc.isLoaded ? svc : null;
      } catch {
        return null;
      }
    })();
    const metadata: Map<string, CatalogSeries> = catalog
      ? await catalog.lookupByIds([...grouped.keys()])
      : new Map();

    const result: SeriesData[] = [];
    for (const [seriesId, obsRows] of grouped) {
      // Series metadata from the catalog, when present
      let title: string | undefined;
      let area: string | undefined;
      let item: string | undefined;
      let seasonal: string | undefined;

      const match = metadata.get(seriesId);
      if (match) {
        title = match.title;
        area = match.areaName;
        item = match.itemName;
        seasonal = match.seasonal ? 'Seasonally Adjusted' : 'Not Seasonally Adjusted';
      }

      const observations: Observation[] = obsRows
        .slice()
        .sort((a, b) =>
          a.year !== b.year ? b.year.localeCompare(a.year) : b.period.localeCompare(a.period),
        )
        .map((row) => ({
          year: row.year,
          period: row.period,
          value: row.value,
          ...(row.footnote_codes ? { footnotes: [row.footnote_codes] } : {}),
        }));

      result.push({
        seriesId,
        ...(title && { title }),
        ...(area && { area }),
        ...(item && { item }),
        ...(seasonal && { seasonal }),
        observations,
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
            { reason: 'service_unavailable' },
          );
        }
        let parsed: BlsSurveysResponse;
        try {
          parsed = JSON.parse(text) as BlsSurveysResponse;
        } catch (e: unknown) {
          throw serializationError(
            'Failed to parse BLS surveys response as JSON',
            { reason: 'serialization_failure' },
            { cause: e },
          );
        }
        if (parsed.status !== 'REQUEST_SUCCEEDED') {
          throw serviceUnavailable(
            `BLS surveys API: ${parsed.message?.join('; ') ?? 'unknown error'}`,
            { reason: 'service_unavailable' },
          );
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
    const messages = parsed.message ?? [];
    for (const msg of messages) {
      if (/daily query limit|500 queries|limit reached/i.test(msg)) {
        // Deterministic until the UTC-midnight reset — retrying only burns more quota.
        throw serviceUnavailable('BLS API daily query limit (500/day) reached.', {
          reason: 'quota_exceeded',
          retryable: false,
          messages,
        });
      }
      if (/does not exist/i.test(msg)) {
        throw notFound(`BLS API: ${msg} — use bls_search_series to find valid SeriesIDs.`, {
          reason: 'series_not_found',
          messages,
          seriesIds: options.seriesIds,
        });
      }
      if (/database is locked/i.test(msg)) {
        throw serviceUnavailable('BLS database is temporarily locked — retry shortly.', {
          reason: 'series_locked',
          messages,
        });
      }
      if (/no data available/i.test(msg)) {
        // Collect all per-series "no data" messages so the caller can identify
        // which series to remove or which range to narrow.
        const detail = messages
          .filter((m) => /no data available/i.test(m))
          .map((m) => `  ${m}`)
          .join('\n');
        throw validationError(
          `BLS API: No data available for the requested period range.\n${detail}`,
          { reason: 'no_data_for_period', messages },
        );
      }
      if (/calculations.*not supported|does not support.*calculations/i.test(msg)) {
        throw validationError(
          'This survey does not support calculations — remove the calculations flag or check bls_list_surveys.',
          { reason: 'calculations_not_supported', messages },
        );
      }
    }

    if (parsed.status === 'REQUEST_NOT_PROCESSED') {
      // Quota exhausted — BLS returns this status when the key hits 500/day.
      // The request was not processed at all, so retrying it unchanged cannot help.
      throw serviceUnavailable(
        'BLS API request not processed. Daily quota (500 queries/day) may be exhausted — retry after UTC midnight.',
        { reason: 'quota_exceeded', retryable: false, messages },
      );
    }

    if (parsed.status !== 'REQUEST_SUCCEEDED') {
      // BLS rejected the request with a message none of the branches above
      // recognize (e.g. "Your request has failed. Please check your input
      // parameters"). That is a verdict on the request, so identical parameters
      // will be rejected again — fail fast and let the caller adjust them.
      throw serviceUnavailable(`BLS API error: ${messages.join('; ') || parsed.status}`, {
        reason: 'request_rejected',
        retryable: false,
        messages,
        ...ctx.recoveryFor('request_rejected'),
      });
    }

    return (parsed.Results?.series ?? []).map((raw): SeriesData => {
      const cat = raw.catalog;
      return {
        seriesId: raw.seriesID,
        ...(cat?.series_title && { title: cat.series_title }),
        ...(cat?.area && { area: cat.area }),
        ...(cat?.item && { item: cat.item }),
        ...(cat?.seasonality && { seasonal: cat.seasonality }),
        observations: raw.data.map((obs) => this.normalizeObs(obs)),
      };
    });
  }

  private normalizeObs(raw: RawObservation): Observation {
    const nc = raw.calculations?.net_changes;
    const pc = raw.calculations?.pct_changes;
    return {
      year: raw.year,
      period: raw.period,
      value: raw.value,
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
