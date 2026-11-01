/**
 * @fileoverview BLS period-code semantics, shared by the live API and the
 * observations mirror. BLS publishes an annual-average row alongside a series'
 * real periods; it is a BLS-computed annual summary rather than an
 * additional period, so summing or averaging a series' observations
 * double-counts every year unless those rows are excluded.
 * @module services/bls-periods/period-codes
 */

/**
 * Period codes that denote BLS-computed annual summaries, not additional periods.
 * Their values are not universally the arithmetic mean of the year's periods.
 *
 * Verified against the LABSTAT `{survey}.period` tables, which label exactly
 * these three "Annual Average" — `M13` for monthly cadences (`ap`, `ce`, `cu`,
 * `cw`, `jt`, `la`, `pc`, `wp`), `Q05` for quarterly (`ec`, `pr`), and `S03`
 * for the semiannual cadence `cu`/`cw` also publish — and against a live
 * `POST /timeseries/data` carrying `annualaverage: true`, which returns each of
 * them tagged `periodName: "Annual"` beside the real M01–M12 / Q01–Q04 /
 * S01–S02 rows.
 *
 * `A01` is deliberately absent, though it is not unused: LABSTAT defines it for
 * several annual-only surveys (e.g. Major Sector Productivity, Occupational
 * Injuries and Illnesses, International Labor Statistics), always labeled
 * "Annual". In every one of those it is the sole period of a dedicated
 * annual-cadence series — a disjoint series from any M01–M12 or Q01–Q04
 * sibling in the same survey, never injected alongside them the way M13/Q05/S03
 * are. Treating it as an aggregate would discard that series' only real
 * observation rather than de-duplicate a year.
 */
export const ANNUAL_AVERAGE_PERIODS: ReadonlySet<string> = new Set(['M13', 'Q05', 'S03']);

/**
 * True when `period` marks a BLS-computed annual-summary row, not an additional period.
 */
export function isAnnualAveragePeriod(period: string): boolean {
  return ANNUAL_AVERAGE_PERIODS.has(period);
}
