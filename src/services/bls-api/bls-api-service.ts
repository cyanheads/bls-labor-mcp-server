/**
 * @fileoverview BLS API v2 service. Wraps `POST /timeseries/data` (batch series
 * fetch with optional calculations), `GET /timeseries/data/{id}?latest=true`
 * (single-series latest observation), and `GET /surveys` / `GET /surveys/{abbr}`
 * (survey metadata). Applies retry with 1–2s backoff. Surfaces quota exhaustion,
 * series-not-found, locked-series, no-data, and calculations-not-supported as
 * typed error data so calling tools can produce the right `ctx.fail` reason.
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
  fetchSeries(options: BatchFetchOptions, ctx: Context): Promise<SeriesData[]> {
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
  fetchLatest(seriesId: string, ctx: Context): Promise<SeriesData> {
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
