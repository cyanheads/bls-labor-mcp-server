/**
 * @fileoverview BLS API v2 raw response types and normalized domain types.
 * @module services/bls-api/types
 */

/** Raw observation from BLS API. */
export interface RawObservation {
  calculations?: {
    net_changes?: Record<string, string>;
    pct_changes?: Record<string, string>;
  };
  footnotes?: Array<{ code?: string; text?: string }>;
  period: string;
  periodName?: string;
  value: string;
  year: string;
}

/** Raw series block from BLS v2 batch response. */
export interface RawSeries {
  catalog?: {
    series_title?: string;
    seasonality?: string;
    area?: string;
    item?: string;
    series_id?: string;
  };
  data: RawObservation[];
  seriesID: string;
}

/** Root of the BLS v2 JSON envelope. */
export interface BlsApiResponse {
  message?: string[];
  Results?: {
    series: RawSeries[];
  };
  responseTime: number;
  status: 'REQUEST_SUCCEEDED' | 'REQUEST_NOT_PROCESSED' | 'REQUEST_FAILED_ERROR' | string;
}

/**
 * Normalized observation for tool output. BLS returns net/percent change over
 * 1, 3, 6, and 12-month intervals for monthly-cadence series when
 * `calculations: true` is requested; a survey returns only the intervals and
 * change types it supports, so every calculation field is optional.
 */
export interface Observation {
  footnotes?: string[];
  netChange1Month?: string;
  netChange3Month?: string;
  netChange6Month?: string;
  netChange12Month?: string;
  pctChange1Month?: string;
  pctChange3Month?: string;
  pctChange6Month?: string;
  pctChange12Month?: string;
  period: string;
  periodName?: string;
  value: string;
  year: string;
}

/** Normalized series block for tool output. */
export interface SeriesData {
  area?: string;
  item?: string;
  observations: Observation[];
  seasonal?: string;
  seriesId: string;
  title?: string;
}

/** Normalized survey metadata from GET /surveys. */
export interface SurveyMeta {
  allowsNetChange: boolean;
  allowsPercentChange: boolean;
  hasAnnualAverages: boolean;
  surveyAbbreviation: string;
  surveyName: string;
}

/** Raw GET /surveys response envelope. */
export interface BlsSurveysResponse {
  message?: string[];
  Results?: {
    survey: Array<{
      survey_abbreviation: string;
      survey_name: string;
      allowsNetChange?: string;
      allowsPercentChange?: string;
      hasAnnualAverages?: string;
    }>;
  };
  responseTime: number;
  status: string;
}
