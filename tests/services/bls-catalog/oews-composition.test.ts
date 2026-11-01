/**
 * @fileoverview Tests for OEWS SeriesID composition from the OE code tables
 * (#119): table parsing, BLS's existence rules, the 50-row cap, ranking, the
 * area and data-type matches, exact-ID decoding, and the state/national
 * fallback rows the data tools name for an unpublished ID. Fixture rows are
 * real `oe.area`, `oe.occupation`, and `oe.datatype` rows (2026-05-15 files).
 * @module tests/services/bls-catalog/oews-composition.test
 */

import { describe, expect, it } from 'vitest';
import {
  composeOewsSearch,
  OEWS_COMPOSED_LIMIT,
  type OewsTables,
  oewsFallbacks,
  parseOewsTables,
} from '@/services/bls-catalog/oews-composition.js';
import type { CatalogSearchInput } from '@/services/bls-catalog/types.js';
import { expectLinearCpuTime } from './linear-time.js';
import { OE_AREA, OE_DATATYPE, OE_OCCUPATION, tsv } from './oews-fixtures.js';

function tables(): OewsTables {
  const parsed = parseOewsTables({
    area: OE_AREA,
    occupation: OE_OCCUPATION,
    datatype: OE_DATATYPE,
  });
  if (!parsed) throw new Error('fixture tables did not parse');
  return parsed;
}

function input(
  query: string,
  opts: Partial<Omit<CatalogSearchInput, 'query'>> = {},
): CatalogSearchInput {
  return {
    query,
    survey: 'OE',
    area: undefined,
    seasonal_adjustment: undefined,
    limit: 50,
    offset: 0,
    ...opts,
  };
}

function compose(query: string, opts: Partial<Omit<CatalogSearchInput, 'query'>> = {}) {
  const result = composeOewsSearch(tables(), input(query, opts));
  if (!result) throw new Error(`composition did not apply to ${JSON.stringify(query)}`);
  return result;
}

const ids = (query: string, opts: Partial<Omit<CatalogSearchInput, 'query'>> = {}) =>
  compose(query, opts).series.map((s) => s.seriesId);

/** The positional parts of an OEWS SeriesID. */
function parts(id: string) {
  return {
    seasonal: id[2],
    areatype: id[3],
    area: id.slice(4, 11),
    industry: id.slice(11, 17),
    occupation: id.slice(17, 23),
    datatype: id.slice(23),
  };
}

describe('parseOewsTables', () => {
  it('reads the three tables by header, ignoring the occupation descriptions', () => {
    const t = tables();
    expect(t.areas.get('0042660')).toEqual({
      code: '0042660',
      name: 'Seattle-Tacoma-Bellevue, WA',
      areatype: 'M',
      stateCode: '53',
    });
    expect(t.occupations.map((o) => o.code)).toContain('291141');
    expect(t.occupations.find((o) => o.code === '291141')).toEqual({
      code: '291141',
      name: 'Registered Nurses',
      level: 3,
    });
    expect(t.datatypes.map((d) => d.code)).toEqual(
      Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
  });

  it.each([
    ['area', 'state_code\tarea_code\tarea_name\r\n53\t5300000\tWashington\r\n'],
    ['occupation', 'occupation_code\toccupation_name\r\n291141\tRegistered Nurses\r\n'],
    ['datatype', 'datatype_code\tdatatype_text\r\n'],
    ['datatype', '<html><body>Access Denied</body></html>\n'],
  ] as const)('rejects a set whose %s table lacks a column or rows', (name, body) => {
    const bodies = { area: OE_AREA, occupation: OE_OCCUPATION, datatype: OE_DATATYPE };
    expect(parseOewsTables({ ...bodies, [name]: body })).toBeUndefined();
  });

  it('skips rows whose codes do not fit the SeriesID positions', () => {
    const parsed = parseOewsTables({
      area: tsv(
        ['state_code', 'area_code', 'areatype_code', 'area_name'],
        ['00', '0000000', 'N', 'National'],
        ['53', '42660', 'M', 'Short code'],
        ['53', '5300000', 'X', 'Unknown type'],
      ),
      occupation: OE_OCCUPATION,
      datatype: OE_DATATYPE,
    });
    expect([...(parsed?.areas.keys() ?? [])]).toEqual(['0000000']);
  });
});

describe('composeOewsSearch — the #119 acceptance query', () => {
  const result = () =>
    compose('registered nurses hourly mean wage', { area: 'Seattle', limit: 10 });

  it('leads with the Seattle row, then its state and national rows', () => {
    expect(result().series.slice(0, 3)).toEqual([
      {
        seriesId: 'OEUM004266000000029114103',
        title:
          'Hourly mean wage for Registered Nurses in All Industries in Seattle-Tacoma-Bellevue, WA',
        surveyAbbr: 'OE',
        areaName: 'Seattle-Tacoma-Bellevue, WA',
        itemName: 'Registered Nurses',
        seasonal: false,
        composed: true,
      },
      {
        seriesId: 'OEUS530000000000029114103',
        title: 'Hourly mean wage for Registered Nurses in All Industries in Washington',
        surveyAbbr: 'OE',
        areaName: 'Washington',
        itemName: 'Registered Nurses',
        seasonal: false,
        composed: true,
      },
      {
        seriesId: 'OEUN000000000000029114103',
        title: 'Hourly mean wage for Registered Nurses in All Industries in the United States',
        surveyAbbr: 'OE',
        areaName: 'National',
        itemName: 'Registered Nurses',
        seasonal: false,
        composed: true,
      },
    ]);
  });

  it('marks the result composed and ranks the other nurse occupations after the full match', () => {
    const r = result();
    expect(r.composed).toBe(true);
    expect(r.capped).toBe(false);
    // RN, then the four occupations matching only "nurses", each in three areas.
    expect(r.total).toBe(15);
    expect(r.series.slice(3).every((s) => s.itemName !== 'Registered Nurses')).toBe(true);
    expect(r.series.every((s) => s.seriesId.endsWith('03'))).toBe(true);
  });
});

describe('composeOewsSearch — existence rules', () => {
  /** Every row a query composes, across every page. */
  const all = (query: string, area?: string) =>
    compose(query, { ...(area !== undefined && { area }), limit: 50 }).series.map((s) =>
      parts(s.seriesId),
    );

  it('composes only seasonal U, industry 000000, and the area’s own areatype', () => {
    for (const area of ['Seattle', 'Washington', 'Walla Walla', 'Portland']) {
      for (const p of all('nurses', area)) {
        expect(p.seasonal).toBe('U');
        expect(p.industry).toBe('000000');
        const areatype = tables().areas.get(p.area)?.areatype;
        expect(p.areatype).toBe(areatype);
      }
    }
  });

  it('composes minor and broad groups only nationally', () => {
    const minor = all('healthcare diagnosing or treating practitioners', 'Seattle');
    expect(minor.filter((p) => p.occupation === '291000').map((p) => p.areatype)).toEqual([
      'N',
      'N',
      'N',
    ]);
    const broad = all('therapists', 'Seattle');
    expect(broad.map((p) => p.areatype)).toEqual(['N', 'N', 'N']);
    // A major group and a detailed occupation compose in every area.
    const major = all('healthcare practitioners technical occupations', 'Seattle');
    expect(new Set(major.filter((p) => p.occupation === '290000').map((p) => p.areatype))).toEqual(
      new Set(['M', 'S', 'N']),
    );
  });

  it('never composes employment per 1,000 jobs or the location quotient nationally', () => {
    const lq = all('registered nurses location quotient', 'Seattle').filter(
      (p) => p.occupation === '291141',
    );
    expect(lq.map((p) => `${p.areatype}${p.datatype}`)).toEqual(['M17', 'S17']);
    const per = all('registered nurses employment per 1,000 jobs', 'Seattle').filter(
      (p) => p.occupation === '291141',
    );
    expect(per.map((p) => `${p.areatype}${p.datatype}`)).toEqual(['M16', 'S16']);
    // No named area: national only, so nothing composes.
    expect(compose('registered nurses location quotient').total).toBe(0);
  });
});

describe('composeOewsSearch — the 50-row cap', () => {
  // Five nurse occupations × five areas (three named by "Washington", plus the
  // DC state row and the national row) × three default data types = 75.
  it('composes at most 50 rows and reports the cap', () => {
    const r = compose('nurses', { area: 'Washington', limit: 50 });
    expect(r.total).toBe(OEWS_COMPOSED_LIMIT);
    expect(r.series).toHaveLength(50);
    expect(r.capped).toBe(true);
    expect(new Set(r.series.map((s) => s.seriesId)).size).toBe(50);
  });

  it('pages the capped list and ends at 50', () => {
    const pages = [0, 20, 40].map(
      (offset) => compose('nurses', { area: 'Washington', limit: 20, offset }).series,
    );
    expect(pages.map((p) => p.length)).toEqual([20, 20, 10]);
    expect(pages.flat().map((s) => s.seriesId)).toEqual(
      ids('nurses', { area: 'Washington', limit: 50 }),
    );
    const past = compose('nurses', { area: 'Washington', limit: 20, offset: 50 });
    expect(past.series).toEqual([]);
    expect(past.total).toBe(50);
    expect(past.capped).toBe(true);
  });

  it('leaves an uncapped list uncapped', () => {
    expect(compose('nuclear engineers', { area: 'Walla Walla' })).toMatchObject({
      total: 9,
      capped: false,
    });
  });
});

describe('composeOewsSearch — ranking and matching', () => {
  it('ranks the named area above its state and national rows for each occupation and data type', () => {
    const order = ids('registered nurses', { area: 'Seattle' }).slice(0, 9);
    expect(order).toEqual([
      'OEUM004266000000029114101',
      'OEUM004266000000029114103',
      'OEUM004266000000029114104',
      'OEUS530000000000029114101',
      'OEUS530000000000029114103',
      'OEUS530000000000029114104',
      'OEUN000000000000029114101',
      'OEUN000000000000029114103',
      'OEUN000000000000029114104',
    ]);
  });

  it('composes only national rows when no area is named', () => {
    const areas = new Set(ids('registered nurses').map((id) => parts(id).areatype));
    expect(areas).toEqual(new Set(['N']));
  });

  it('takes a place named in the query as the area', () => {
    expect(ids('registered nurses hourly mean wage seattle').slice(0, 3)).toEqual([
      'OEUM004266000000029114103',
      'OEUS530000000000029114103',
      'OEUN000000000000029114103',
    ]);
  });

  it('prefers an area whose whole name the query gives', () => {
    // "Washington" names the state outright; the DC metro and the nonmetro area only contain it.
    const areas = new Set(
      ids('registered nurses hourly mean wage washington').map((id) => parts(id).area),
    );
    expect(areas).toEqual(new Set(['5300000', '0000000']));
    const newYork = new Set(ids('nurse practitioners new york').map((id) => parts(id).area));
    expect(newYork).toEqual(new Set(['3600000', '0000000']));
  });

  it('keeps every area a partial place match ties on', () => {
    const areas = new Set(
      ids('nuclear engineers hourly mean wage portland').map((id) => parts(id).area),
    );
    expect(areas).toEqual(new Set(['0038860', '0038900', '2300000', '4100000', '0000000']));
  });

  it('matches occupation words in either number, never inside another word', () => {
    expect(ids('registered nurse hourly mean wage')[0]).toBe('OEUN000000000000029114103');
    expect(ids('nurse practitioner annual mean wage')[0]).toBe('OEUN000000000000029117104');
    // A word matches whole, singular or plural: "nursing" is not "nurses".
    expect(compose('nursing assistants').total).toBe(0);
  });

  it('composes All Occupations when the query names no occupation', () => {
    expect(ids('employment', { area: 'Walla Walla' })).toEqual([
      'OEUM004746000000000000001',
      'OEUS530000000000000000001',
      'OEUN000000000000000000001',
    ]);
  });

  it('returns no rows when the query names an occupation the tables lack', () => {
    expect(compose('astronauts hourly mean wage')).toEqual({
      series: [],
      total: 0,
      capped: false,
      composed: true,
    });
  });

  it('returns no rows for an area filter that names no OEWS area', () => {
    expect(compose('registered nurses', { area: 'Narnia' }).total).toBe(0);
  });

  it('returns no rows under seasonal_adjustment true: OEWS publishes none', () => {
    expect(compose('registered nurses', { seasonal_adjustment: true }).total).toBe(0);
    expect(compose('registered nurses', { seasonal_adjustment: false }).total).toBe(15);
  });

  it.each([
    ['53', ['5300000', '0000000']],
    // A USPS code names its state, as the general area grammar reads it — never letters inside a name.
    ['WA', ['5300000', '0000000']],
    ['tx', ['4800000', '0000000']],
    ['42660', ['0042660', '5300000', '0000000']],
    ['0042660', ['0042660', '5300000', '0000000']],
    ['walla', ['0047460', '5300000', '0000000']],
  ])('reads area filter %j as the area it names', (area, expected) => {
    const areas = [
      ...new Set(ids('registered nurses employment', { area }).map((id) => parts(id).area)),
    ];
    expect(areas).toEqual(expected);
  });
});

describe('composeOewsSearch — data types', () => {
  const datatypes = (query: string) => [
    ...new Set(ids(query, { area: 'Seattle' }).map((id) => parts(id).datatype)),
  ];

  it.each([
    ['registered nurses', ['01', '03', '04']],
    ['registered nurses wages', ['01', '03', '04']],
    ['registered nurses employment', ['01']],
    ['registered nurses hourly mean wage', ['03']],
    ['registered nurses average wage', ['03', '04']],
    ['registered nurses salary', ['04', '13']],
    ['registered nurses median wage', ['08', '13']],
    ['registered nurses annual 90th percentile', ['15']],
    ['registered nurses employment per 1,000 jobs', ['16']],
    ['registered nurses jobs', ['01', '03', '04']],
    ['registered nurses employment percent relative standard error', ['02']],
  ])('%j composes data types %j', (query, expected) => {
    expect(datatypes(query)).toEqual(expected);
  });
});

describe('composeOewsSearch — scope and exact SeriesIDs', () => {
  it('does not apply to an unscoped query or another survey', () => {
    expect(
      composeOewsSearch(tables(), input('registered nurses', { survey: undefined })),
    ).toBeUndefined();
    expect(
      composeOewsSearch(tables(), input('registered nurses', { survey: 'LN' })),
    ).toBeUndefined();
  });

  it.each([undefined, 'OE', 'oe'])(
    'decodes an exact OEWS SeriesID into its row (survey %j)',
    (survey) => {
      const r = composeOewsSearch(tables(), input(' oeum004266000000029114103 ', { survey }));
      expect(r).toEqual({
        series: [
          {
            seriesId: 'OEUM004266000000029114103',
            title:
              'Hourly mean wage for Registered Nurses in All Industries in Seattle-Tacoma-Bellevue, WA',
            surveyAbbr: 'OE',
            areaName: 'Seattle-Tacoma-Bellevue, WA',
            itemName: 'Registered Nurses',
            seasonal: false,
            composed: true,
          },
        ],
        total: 1,
        capped: false,
        composed: true,
      });
    },
  );

  it.each([
    ['an unknown area', 'OEUM009999900000029114103'],
    ['an unknown occupation', 'OEUM004266000000099999903'],
    ['an unknown data type', 'OEUM004266000000029114118'],
    ['an areatype that is not the area’s', 'OEUS004266000000029114103'],
    ['seasonal S', 'OESM004266000000029114103'],
    ['an industry other than 000000', 'OEUN000000062200029114103'],
    ['the location quotient nationally', 'OEUN000000000000029114117'],
    ['a broad group below national', 'OEUM004266000000029112003'],
  ])('decodes no row for an ID with %s', (_, id) => {
    expect(composeOewsSearch(tables(), input(id, { survey: undefined }))).toBeUndefined();
    expect(composeOewsSearch(tables(), input(id))).toEqual({
      series: [],
      total: 0,
      capped: false,
      composed: true,
    });
  });

  it('applies the area and seasonal filters to a decoded ID', () => {
    const id = 'OEUM004266000000029114103';
    expect(
      composeOewsSearch(tables(), input(id, { survey: undefined, area: 'seattle' }))?.total,
    ).toBe(1);
    expect(
      composeOewsSearch(tables(), input(id, { survey: undefined, area: 'Texas' }))?.total,
    ).toBe(0);
    expect(
      composeOewsSearch(tables(), input(id, { survey: undefined, seasonal_adjustment: true }))
        ?.total,
    ).toBe(0);
  });

  it('pages a decoded ID like any result', () => {
    const r = composeOewsSearch(
      tables(),
      input('OEUM004266000000029114103', { survey: undefined, offset: 1 }),
    );
    expect(r).toMatchObject({ series: [], total: 1 });
  });
});

describe('composeOewsSearch — caller-sized text', () => {
  const parsed = tables();
  /** Compose `query` with an area filter as long as itself, then with none; both must apply. */
  const composeBoth = (query: string) => {
    for (const area of ['x'.repeat(query.length), undefined]) {
      if (!composeOewsSearch(parsed, input(query, { area }))) {
        throw new Error('composition did not apply');
      }
    }
  };

  it.each<[string, (n: number) => string]>([
    ['a long repeated query', (n) => 'registered nurses '.repeat(Math.ceil(n / 18))],
    ['a long digit run', (n) => '9'.repeat(n)],
    ['a long run of commas between digits', (n) => '1,'.repeat(n / 2)],
  ])('stays linear on %s', (label, text) => {
    expectLinearCpuTime(composeBoth, text, label, 100);
  });
});

describe('oewsFallbacks', () => {
  it.each([
    [
      'a metro row',
      'OEUM004266000000029114103',
      ['OEUS530000000000029114103', 'OEUN000000000000029114103'],
    ],
    [
      'a nonmetro row',
      'OEUM530000600000029114103',
      ['OEUS530000000000029114103', 'OEUN000000000000029114103'],
    ],
    ['a state row', 'OEUS530000000000029114103', ['OEUN000000000000029114103']],
    ['a national row', 'OEUN000000000000029114103', []],
    [
      'a metro location quotient (no national 17)',
      'OEUM004266000000029114117',
      ['OEUS530000000000029114117'],
    ],
    [
      'a metro broad group (no state row)',
      'OEUM004266000000029112003',
      ['OEUN000000000000029112003'],
    ],
    [
      'a state industry row (industry is national-only)',
      'OEUS530000062200029114103',
      ['OEUN000000062200029114103'],
    ],
    ['a SeriesID of another survey', 'LNS14000000', []],
  ])('names the state and national rows for %s', (_, id, expected) => {
    expect(oewsFallbacks(id, tables())).toEqual(expected);
  });

  it('names only the national row for a metro row when no tables are stored', () => {
    expect(oewsFallbacks('OEUM004266000000029114103', undefined)).toEqual([
      'OEUN000000000000029114103',
    ]);
  });
});
