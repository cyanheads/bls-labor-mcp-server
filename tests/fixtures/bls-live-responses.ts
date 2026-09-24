/**
 * @fileoverview BLS API v2 response bodies captured from the live API on
 * 2026-09-24 (UTC), HTTP 200 each, used verbatim so the catalog re-issue is
 * tested against what BLS actually sends rather than a hand-written guess.
 * With catalog metadata requested, a request holding a nonexistent SeriesID
 * drew {@link GENERIC_REJECTION} in 16 of 27 sequential probes; with it off, 0
 * of 25 did, and each answered per-series as below.
 * @module tests/fixtures/bls-live-responses
 */

/**
 * The generic rejection — `POST /timeseries/data` of `["LNS14000000","BOGUS123"]`
 * with `catalog: true`. It names no series, and `Results` is `null`. The latest
 * GET (`/timeseries/data/BOGUS123?latest=true&catalog=true`) returns the same body.
 */
export const GENERIC_REJECTION = {
  status: 'REQUEST_FAILED',
  responseTime: 0,
  message: [
    'Your request has failed. Please check your input parameters, and try your request again.',
  ],
  Results: null,
};

/** The same POST with `catalog: false`: per-series advisories, the valid series intact. */
export const MIXED_INVALID_WITHOUT_CATALOG = {
  status: 'REQUEST_SUCCEEDED',
  responseTime: 67,
  message: ['Unable to get Catalog Data for series BOGUS123', 'Invalid Series for Series BOGUS123'],
  Results: {
    series: [
      {
        seriesID: 'LNS14000000',
        data: [
          { year: '2025', period: 'M12', periodName: 'December', value: '4.4', footnotes: [{}] },
          { year: '2025', period: 'M11', periodName: 'November', value: '4.5', footnotes: [{}] },
          {
            year: '2025',
            period: 'M10',
            periodName: 'October',
            value: '-',
            footnotes: [
              { code: '9', text: 'Data unavailable due to the 2025 lapse in appropriations.' },
            ],
          },
          { year: '2025', period: 'M09', periodName: 'September', value: '4.4', footnotes: [{}] },
          { year: '2025', period: 'M08', periodName: 'August', value: '4.3', footnotes: [{}] },
          { year: '2025', period: 'M07', periodName: 'July', value: '4.3', footnotes: [{}] },
          { year: '2025', period: 'M06', periodName: 'June', value: '4.1', footnotes: [{}] },
          { year: '2025', period: 'M05', periodName: 'May', value: '4.3', footnotes: [{}] },
          { year: '2025', period: 'M04', periodName: 'April', value: '4.2', footnotes: [{}] },
          { year: '2025', period: 'M03', periodName: 'March', value: '4.2', footnotes: [{}] },
          { year: '2025', period: 'M02', periodName: 'February', value: '4.2', footnotes: [{}] },
          { year: '2025', period: 'M01', periodName: 'January', value: '4.0', footnotes: [{}] },
        ],
      },
      { seriesID: 'BOGUS123', data: [] },
    ],
  },
};

/** `GET /timeseries/data/BOGUS123?latest=true` with no `catalog` parameter. */
export const LATEST_INVALID_WITHOUT_CATALOG = {
  status: 'REQUEST_SUCCEEDED',
  responseTime: 88,
  message: ['Unable to get Catalog Data for series BOGUS123', 'Invalid Series for Series BOGUS123'],
  Results: { series: [{ seriesID: 'BOGUS123', data: [] }] },
};
