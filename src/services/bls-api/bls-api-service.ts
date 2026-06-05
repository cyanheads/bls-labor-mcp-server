/**
 * @fileoverview BLS API v2 service. Wraps `POST /timeseries/data` (batch series
 * fetch with optional calculations), `GET /timeseries/data/{id}?latest=true`
 * (single-series latest observation), and `GET /surveys` / `GET /surveys/{abbr}`
 * (survey metadata). Applies retry with 1–2s backoff. Surfaces quota exhaustion,
 * series-not-found, locked-series, no-data, and calculations-not-supported as
 * typed error data so calling tools can produce the right `ctx.fail` reason.
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
 * Hardcoded capability flags for known surveys. The bulk `/surveys` endpoint
 * only returns `survey_abbreviation` and `survey_name` — capability fields are
 * only available on the per-survey `/surveys/{code}` endpoint. Fetching all
 * ~70 surveys individually on every list call would consume significant quota
 * and latency. This table covers the surveys most relevant to the tool surface
 * and is merged at list time. Sourced from BLS `/surveys/{code}` responses.
 */
const SURVEY_CAPABILITIES: Record<
  string,
  { allowsNetChange: boolean; allowsPercentChange: boolean; hasAnnualAverages: boolean }
> = {
  AP: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  CE: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  CI: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  CU: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: true },
  EC: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  EI: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  IP: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  JT: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  LA: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: true },
  LN: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  MP: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  NW: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  OE: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  PC: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  PR: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  SA: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
  SM: { allowsNetChange: true, allowsPercentChange: true, hasAnnualAverages: true },
  TU: { allowsNetChange: false, allowsPercentChange: false, hasAnnualAverages: false },
  WP: { allowsNetChange: false, allowsPercentChange: true, hasAnnualAverages: false },
};

export interface BatchFetchOptions {
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
        const queryOpts: { seriesIds: string[]; startYear?: number; endYear?: number } = {
          seriesIds: options.seriesIds,
          ...(options.startYear !== undefined ? { startYear: options.startYear } : {}),
          ...(options.endYear !== undefined ? { endYear: options.endYear } : {}),
        };
        const mirrorResult = await mirror.queryBySeries(queryOpts);

        const mirrorSeries = this.mirrorRowsToSeriesData(mirrorResult.observations);

        // Fetch missing IDs from live API when fallback is enabled
        if (mirrorResult.missedIds.length > 0 && cfg.observationsMirrorFallbackLive) {
          ctx.log.notice('fetchSeries: mirror miss, falling back to live API', {
            missedIds: mirrorResult.missedIds,
          });
          const liveOptions: BatchFetchOptions = {
            seriesIds: mirrorResult.missedIds,
            ...(options.startYear !== undefined ? { startYear: options.startYear } : {}),
            ...(options.endYear !== undefined ? { endYear: options.endYear } : {}),
            ...(options.calculations !== undefined ? { calculations: options.calculations } : {}),
          };
          const liveSeries = await this.fetchSeriesLive(liveOptions, ctx);
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
        if (options.startYear !== undefined || options.endYear !== undefined)
          body.annualaverage = true;

        const response = await fetch(`${this.baseUrl}/timeseries/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
          body: JSON.stringify(body),
          signal: ctx.signal,
        });

        return this.parseSeriesResponse(await response.text(), options);
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
          const seriesList = this.mirrorRowsToSeriesData(mirrorResult.observations);
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
        const series = this.parseSeriesResponse(text, { seriesIds: [seriesId] });
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
  private mirrorRowsToSeriesData(rows: ObservationRow[]): SeriesData[] {
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

    // Hydrate catalog metadata from the catalog service when available
    const catalog = (() => {
      try {
        const svc = getBlsCatalogService();
        return svc.isLoaded ? svc : null;
      } catch {
        return null;
      }
    })();

    const result: SeriesData[] = [];
    for (const [seriesId, obsRows] of grouped) {
      // Try to look up series metadata from the catalog
      let title: string | undefined;
      let area: string | undefined;
      let item: string | undefined;
      let seasonal: string | undefined;

      if (catalog) {
        const found = catalog.search({
          query: seriesId,
          limit: 1,
          area: undefined,
          seasonal_adjustment: undefined,
          survey: undefined,
        });
        const match = found.series.find((s) => s.seriesId === seriesId);
        if (match) {
          title = match.title;
          area = match.areaName;
          item = match.itemName;
          seasonal = match.seasonal ? 'Seasonally Adjusted' : 'Not Seasonally Adjusted';
        }
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
            // Bulk endpoint omits capability flags; merge from hardcoded table.
            // Per-survey endpoint has them but fetching ~70 surveys individually
            // wastes quota. Fall back to false for surveys not in the table.
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
        throw serviceUnavailable('BLS API daily query limit (500/day) reached.', {
          reason: 'quota_exceeded',
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
      // Quota exhausted — BLS returns this status when the key hits 500/day
      throw serviceUnavailable(
        'BLS API request not processed. Daily quota (500 queries/day) may be exhausted — retry after UTC midnight.',
        { reason: 'quota_exceeded', messages },
      );
    }

    if (parsed.status !== 'REQUEST_SUCCEEDED') {
      throw serviceUnavailable(`BLS API error: ${messages.join('; ') || parsed.status}`);
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
      ...(nc?.['12'] && { netChange12Month: nc['12'] }),
      ...(pc?.['1'] && { pctChange1Month: pc['1'] }),
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
