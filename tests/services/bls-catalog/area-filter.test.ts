/**
 * @fileoverview Tests for the catalog search `area` grammar: the form an area
 * value takes, the states a decoded area name lies in, the cross-survey area
 * key, the code index, and resolution. Area names are real decoded names from
 * the 2026-11-01 LABSTAT files; `BlsCatalogService.search` wires this into the
 * SQL candidate query and the rescore gate (tested there).
 * @module tests/services/bls-catalog/area-filter.test
 */

import { describe, expect, it } from 'vitest';
import {
  AREA_CODE_SOURCES,
  areaForm,
  areaKey,
  indexAreas,
  resolveArea,
  statesOf,
} from '@/services/bls-catalog/area-filter.js';
import { expectLinearCpuTime } from './linear-time.js';

describe('areaForm (#110)', () => {
  it.each([
    ['TX', 'TX'],
    ['tx', 'TX'],
    ['Wa', 'WA'],
    ['dc', 'DC'],
    ['pr', 'PR'],
    ['48', 'TX'],
    ['06', 'CA'],
    ['11', 'DC'],
    ['72', 'PR'],
  ])('reads %j as the state %s', (area, usps) => {
    const form = areaForm(area);
    expect(form.kind).toBe('state');
    expect(form.kind === 'state' && form.state?.usps).toBe(usps);
  });

  it.each(['99', '00', '03', '52'])('reads %j as a state FIPS code that names no state', (area) => {
    expect(areaForm(area)).toEqual({ kind: 'state', state: undefined });
  });

  it.each(['500', '0000', '0100', '42660', '53033', '5363000', '000'])(
    'reads %j as an area code',
    (area) => {
      expect(areaForm(area)).toEqual({ kind: 'code', code: area });
    },
  );

  it.each(['0', '9', '123456', '12345678', '1'.repeat(40)])(
    'reads all-digit %j as a fragment',
    (area) => {
      expect(areaForm(area)).toEqual({ kind: 'fragment' });
    },
  );

  it.each(['ZZ', 'US', 'us', 'ST48', 'S49D', 'Texas', 'a', '4８', '4 8', '4-8', ' 48', 'tx '])(
    'reads %j as text',
    (area) => {
      expect(areaForm(area)).toEqual({ kind: 'text' });
    },
  );

  it.each<[string, (n: number) => string]>([
    ['digits', (n) => '1'.repeat(n)],
    ['digits then a letter', (n) => `${'1'.repeat(n)}a`],
    ['letters', (n) => 'a'.repeat(n)],
    ['a letter then digits', (n) => `a${'1'.repeat(n)}`],
  ])('runs in linear time on a long run of %s', (label, text) => {
    expectLinearCpuTime(areaForm, text, label, 5);
  });
});

describe('statesOf (#110)', () => {
  it.each([
    ['Texas', ['TX']],
    ['District of Columbia', ['DC']],
    ['West Virginia', ['WV']],
    ['Virginia', ['VA']],
    ['Arkansas', ['AR']],
    ['Kansas', ['KS']],
    ['Urban Alaska', ['AK']],
    ['Balance of California, state less Los Angeles-Long Beach-Glendale MD', ['CA']],
    ['Texas County, MO', ['MO']],
    ['Anderson County, TX', ['TX']],
    ['Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area', ['WA']],
    ['Seattle-Tacoma-Bellevue WA', ['WA']],
    ['Seattle-Tacoma, WA CSA', ['WA']],
    ['Washington, DC-MD-VA', ['DC', 'MD', 'VA']],
    ['Kansas City, MO-KS', ['MO', 'KS']],
    ['Wilmington, DE-MD-NJ Metropolitan Division', ['DE', 'MD', 'NJ']],
    ['Wilmington, DE-MD-NJ Metropolitan Division, DE part', ['DE']],
    ['Allentown-Bethlehem-Easton, PA-NJ Metropolitan Statistical Area, NJ part', ['NJ']],
    ['Abilene city, Jones County part, TX', ['TX']],
    ['Gunnison-Hinsdale, CO LMA', ['CO']],
    ['Total US', []],
    ['U.S. city average', []],
    ['Northeast', []],
    ['Midwest - Size Class D', []],
    ['West region', []],
    ['United States (National)', []],
  ])('places %j in %j', (area, states) => {
    expect(statesOf(area)).toEqual(states);
  });
});

describe('areaKey (#110)', () => {
  it.each([
    ['Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area', 'seattle tacoma bellevue wa'],
    ['Seattle-Tacoma-Bellevue WA', 'seattle tacoma bellevue wa'],
    ['Seattle-Tacoma-Bellevue, WA', 'seattle tacoma bellevue wa'],
    ['Seattle-Tacoma, WA Combined Statistical Area', 'seattle tacoma wa'],
    ['Seattle-Tacoma, WA CSA', 'seattle tacoma wa'],
    [
      'Minneapolis-St. Paul-Bloomington, MN-WI Metropolitan Statistical Area',
      'minneapolis st paul bloomington mn wi',
    ],
    ['Minneapolis-St.Paul-Bloomington, MN-WI', 'minneapolis st paul bloomington mn wi'],
    ['Aberdeen, SD Micropolitan Statistical Area', 'aberdeen sd'],
    ['Pacific division', 'pacific'],
    ['Pacific census division', 'pacific'],
    ['Northeast region', 'northeast'],
    ['Northeast census region', 'northeast'],
    ['Northeast', 'northeast'],
    [
      'Atlanta-Sandy Springs-Roswell, GA Metropolitan Division',
      'atlanta sandy springs roswell ga metropolitan division',
    ],
    ['King County, WA', 'king county wa'],
  ])('keys %j as %j', (name, key) => {
    expect(areaKey(name)).toBe(key);
  });
});

describe('indexAreas and resolveArea (#110)', () => {
  const AREAS = [
    'Texas',
    'Anderson County, TX',
    'Texas County, MO',
    'Washington',
    'Seattle city, WA',
    'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
    'Seattle-Tacoma-Bellevue WA',
    'Seattle-Tacoma-Bellevue, WA',
    'Seattle-Bellevue-Kent, WA Metropolitan Division',
    'Madison town, ME',
    'Northeast',
    'Northeast region',
    'U.S. city average',
    'Total US',
  ];
  // As BlsCatalogService reads them through AREA_CODE_SOURCES.
  const CODED = [
    { code: '42660', area: 'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area' },
    { code: '42644', area: 'Seattle-Bellevue-Kent, WA Metropolitan Division' },
    { code: '5363000', area: 'Seattle city, WA' },
    { code: '2342660', area: 'Madison town, ME' },
    { code: '0100', area: 'Northeast' },
    { code: '0000', area: 'U.S. city average' },
    { code: 'S49D', area: 'Seattle-Tacoma-Bellevue WA' },
  ];
  const index = indexAreas(AREAS, CODED);
  const areasOf = (area: string) =>
    [...(resolveArea(area, index)?.areas ?? ['(substring)'])].sort();

  it('expands a code to every decoded name sharing its area key', () => {
    expect(areasOf('42660')).toEqual([
      'Seattle-Tacoma-Bellevue WA',
      'Seattle-Tacoma-Bellevue, WA',
      'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
    ]);
    expect(areasOf('42644')).toEqual(['Seattle-Bellevue-Kent, WA Metropolitan Division']);
    expect(areasOf('0100')).toEqual(['Northeast', 'Northeast region']);
    expect(areasOf('5363000')).toEqual(['Seattle city, WA']);
  });

  it('resolves a state to the areas in it, with its name for titles', () => {
    expect(resolveArea('tx', index)).toEqual({
      areas: new Set(['Texas', 'Anderson County, TX']),
      state: 'texas',
    });
    expect(areasOf('53')).toEqual([
      'Seattle city, WA',
      'Seattle-Bellevue-Kent, WA Metropolitan Division',
      'Seattle-Tacoma-Bellevue WA',
      'Seattle-Tacoma-Bellevue, WA',
      'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
      'Washington',
    ]);
  });

  it('resolves a well-formed code or state naming no indexed area to no areas', () => {
    for (const area of ['99', '12345', '999', '9999', '1234567']) {
      expect(resolveArea(area, index)).toEqual({ areas: new Set() });
    }
    // A state in the table but absent from the index keeps its title match.
    expect(resolveArea('vt', index)).toEqual({ areas: new Set(), state: 'vermont' });
  });

  it('leaves a letter-bearing CPI code, any text, and an all-digit fragment as substrings', () => {
    for (const area of ['s49d', 'seattle', 'st48', '9', '123456']) {
      expect(resolveArea(area, index)).toBeUndefined();
    }
  });

  it('reads every code at a length the grammar recognizes', () => {
    const lengths = new Set(AREA_CODE_SOURCES.map((s) => s.length));
    for (const length of lengths) {
      expect(areaForm('1'.repeat(length)).kind, `length ${length}`).toBe('code');
    }
  });
});
