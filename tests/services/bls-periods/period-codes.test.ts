/**
 * @fileoverview Tests for BLS period-code semantics — annual-average detection,
 * the shared predicate behind the bls_get_series opt-in (#53) and the mirror's
 * "latest" ordering (#55), and the period names mirror rows carry (#118).
 * @module tests/services/bls-periods/period-codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  ANNUAL_AVERAGE_PERIODS,
  isAnnualAveragePeriod,
  periodName,
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

describe('periodName (#118)', () => {
  /** The `periodName` the live BLS API returned for each code on 2026-11-01. */
  it.each([
    ['M01', 'January'],
    ['M02', 'February'],
    ['M03', 'March'],
    ['M04', 'April'],
    ['M05', 'May'],
    ['M06', 'June'],
    ['M07', 'July'],
    ['M08', 'August'],
    ['M09', 'September'],
    ['M10', 'October'],
    ['M11', 'November'],
    ['M12', 'December'],
    ['Q01', '1st Quarter'],
    ['Q02', '2nd Quarter'],
    ['Q03', '3rd Quarter'],
    ['Q04', '4th Quarter'],
    ['S01', '1st Half'],
    ['S02', '2nd Half'],
    ['M13', 'Annual'],
    ['Q05', 'Annual'],
    ['S03', 'Annual'],
    ['A01', 'Annual'],
  ])('names %s "%s", as the live API does', (code, name) => {
    expect(periodName(code)).toBe(name);
  });

  it.each([
    ['M00', 'a month code below January'],
    ['M14', 'a month code past the annual average'],
    ['Q06', 'a quarter code past the annual average'],
    ['S04', 'a half code past the annual average'],
    ['A02', 'an annual code BLS does not publish'],
    ['m01', 'a lowercase code'],
    ['M1', 'an unpadded code'],
    [' M01', 'a code with surrounding whitespace'],
    ['', 'an empty code'],
    ['constructor', 'an Object.prototype key'],
  ])('names no period for %j — %s', (code) => {
    expect(periodName(code)).toBeUndefined();
  });
});
