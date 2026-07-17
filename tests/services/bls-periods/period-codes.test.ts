/**
 * @fileoverview Tests for BLS annual-average period-code detection — the shared
 * predicate behind the bls_get_series opt-in (#53) and the mirror's "latest"
 * ordering (#55).
 * @module tests/services/bls-periods/period-codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  ANNUAL_AVERAGE_PERIODS,
  isAnnualAveragePeriod,
} from '@/services/bls-periods/period-codes.js';

describe('isAnnualAveragePeriod', () => {
  it.each([
    ['M13', 'monthly cadence annual average (CU, CW, AP, CE, LA, PC, WP, JT)'],
    ['Q05', 'quarterly cadence annual average (EC, PR)'],
    ['S03', 'semiannual cadence annual average (CU, CW)'],
  ])('treats %s as an annual average — %s', (period) => {
    expect(isAnnualAveragePeriod(period)).toBe(true);
  });

  it.each([
    ['M01', 'January'],
    ['M12', 'December — the real period M13 lexically outranks'],
    ['Q01', '1st quarter'],
    ['Q04', '4th quarter — the real period Q05 lexically outranks'],
    ['S01', 'first half'],
    ['S02', 'second half — the real period S03 lexically outranks'],
  ])('treats %s as a real observation — %s', (period) => {
    expect(isAnnualAveragePeriod(period)).toBe(false);
  });

  it('treats A01 as a real observation, not an aggregate', () => {
    /**
     * LABSTAT does define A01 (e.g. Major Sector Productivity, Occupational
     * Injuries and Illnesses, International Labor Statistics — always labeled
     * "Annual"), but always as the sole period of a dedicated annual-cadence
     * series, never injected alongside a real M01–M12 or Q01–Q04 sibling within
     * the same survey the way M13/Q05/S03 are. Excluding it would drop that
     * series' only observation rather than de-duplicate a year.
     */
    expect(isAnnualAveragePeriod('A01')).toBe(false);
  });

  it('exposes exactly the three codes LABSTAT labels "Annual Average"', () => {
    expect([...ANNUAL_AVERAGE_PERIODS].sort()).toEqual(['M13', 'Q05', 'S03']);
  });
});
