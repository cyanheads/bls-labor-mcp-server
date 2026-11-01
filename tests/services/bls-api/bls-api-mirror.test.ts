/**
 * @fileoverview Mirror-path normalization tests for BlsApiService: mirror rows
 * reach callers in the live API's observation shape — the `-` sentinel, request
 * order, period names, and decoded footnotes (#118) — and with the `measure`
 * the catalog index decoded (#127), through the service and through the
 * bls_get_series and bls_get_latest tools that render them.
 * @module tests/services/bls-api/bls-api-mirror.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryBySeries = vi.fn();
const queryLatest = vi.fn();
const footnoteTables = vi.fn();
const lookupByIds = vi.fn();

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    observationsMirrorEnabled: true,
    observationsMirrorFallbackLive: false,
  }),
}));

vi.mock('@/services/bls-observations/bls-observations-service.js', () => ({
  isBlsObservationsServiceReady: () => true,
  getBlsObservationsService: () => ({
    ready: () => Promise.resolve(true),
    queryBySeries,
    queryLatest,
    footnoteTables,
  }),
}));

vi.mock('@/services/bls-catalog/bls-catalog-service.js', () => ({
  getBlsCatalogService: () => ({ isLoaded: true, lookupByIds }),
}));

import { blsGetLatestTool } from '@/mcp-server/tools/definitions/bls-get-latest.tool.js';
import { blsGetSeriesTool } from '@/mcp-server/tools/definitions/bls-get-series.tool.js';
import { BlsApiService, initBlsApiService } from '@/services/bls-api/bls-api-service.js';
import type { BlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';
import type { ObservationRow } from '@/services/bls-observations/types.js';
import { tsv } from '../bls-catalog/oews-fixtures.js';

beforeEach(() => {
  footnoteTables.mockReset().mockResolvedValue(new Map());
  // The catalog index holds no metadata unless a test seeds it.
  lookupByIds.mockReset().mockResolvedValue(new Map());
});

describe('BlsApiService mirror observation normalization', () => {
  it('marks the LABSTAT missing-value sentinel unavailable (#58)', async () => {
    queryBySeries.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [
        {
          row_key: 'LNS14000000|2025|M10',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M10',
          value: '-',
          footnote_codes: '9',
        },
      ],
    });

    const result = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['LNS14000000'], startYear: 2025, endYear: 2025 },
      createMockContext(),
    );

    expect(result[0]!.observations[0]).toMatchObject({
      value: '-',
      available: false,
      footnotes: ['9'],
    });
  });

  it('queries the mirror over the resolved window it was handed (#76)', async () => {
    // The handler resolves a one-sided range once, before the fetch options
    // exist, so the mirror and the live API read the same window — the mirror
    // must forward whichever bounds arrive rather than deriving its own.
    queryBySeries.mockResolvedValue({ complete: true, missedIds: [], observations: [] });

    await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['WPUFD49104'], annualAverage: false, startYear: 2000, endYear: 2019 },
      createMockContext(),
    );

    expect(queryBySeries).toHaveBeenCalledWith({
      seriesIds: ['WPUFD49104'],
      annualAverage: false,
      startYear: 2000,
      endYear: 2019,
    });
  });

  it('keeps normalization intact when the response is reconciled to request order (#73)', async () => {
    queryBySeries.mockResolvedValue({
      complete: false,
      missedIds: ['ABSENT001'],
      observations: [
        {
          row_key: 'LNS14000000|2025|M11',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M11',
          value: '4.2',
          footnote_codes: '',
        },
        {
          row_key: 'LNS14000000|2025|M10',
          series_id: 'LNS14000000',
          year: '2025',
          period: 'M10',
          value: '-',
          footnote_codes: '9',
        },
      ],
    });

    const result = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
      { seriesIds: ['ABSENT001', 'LNS14000000'], startYear: 2025, endYear: 2025 },
      createMockContext(),
    );

    expect(result.map((s) => s.seriesId)).toEqual(['ABSENT001', 'LNS14000000']);
    expect(result[0]!.observations).toEqual([]);
    expect(result[1]!.observations).toMatchObject([
      { period: 'M11', value: '4.2', available: true },
      { period: 'M10', value: '-', available: false, footnotes: ['9'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Period names and footnote text (#118)
// ---------------------------------------------------------------------------

const CI_T = 'No units were initiated this reference period.';
const CI_U =
  'See Footnote U on <a href="/eci/overview/eci-labstat-footnotes.htm#U" target="new">www.bls.gov/eci/overview/eci-labstat-footnotes.htm</a>.';

/** The CI survey's `ci.footnote` table, as the mirror store returns it. */
const CI_TABLE: ReadonlyMap<string, string> = new Map([
  ['T', CI_T],
  ['U', CI_U],
]);

function row(
  series_id: string,
  year: string,
  period: string,
  value: string,
  footnote_codes = '',
): ObservationRow {
  return {
    row_key: `${series_id}|${year}|${period}`,
    series_id,
    year,
    period,
    value,
    footnote_codes,
  };
}

/** Serve `rows` from the mirror's series query, as complete coverage. */
function mirrorServes(...rows: ObservationRow[]): void {
  queryBySeries.mockResolvedValue({ complete: true, missedIds: [], observations: rows });
}

/** The mirror's footnote tables: every listed series decodes against `table`. */
function footnoteTablesFor(table: ReadonlyMap<string, string>, ...seriesIds: string[]): void {
  footnoteTables.mockResolvedValue(new Map(seriesIds.map((id) => [id, table])));
}

async function fetchFromMirror(...seriesIds: string[]) {
  return await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchSeries(
    { seriesIds, startYear: 2024, endYear: 2026 },
    createMockContext(),
  );
}

describe('BlsApiService mirror period names and footnotes (#118)', () => {
  it('names a mirror row’s period as the live API does, and names no unknown code', async () => {
    mirrorServes(
      row('CIU1010000000000A', '2026', 'Q03', '3.4'),
      row('CIU1010000000000A', '2026', 'Q99', '3.5'),
    );

    const [series] = await fetchFromMirror('CIU1010000000000A');

    expect(series!.observations).toEqual([
      { year: '2026', period: 'Q99', value: '3.5', available: true },
      { year: '2026', period: 'Q03', value: '3.4', available: true, periodName: '3rd Quarter' },
    ]);
  });

  it('decodes a footnote code against its survey’s table, rendered `code: text`', async () => {
    mirrorServes(row('CIU1010000000000R', '2026', 'Q03', '-', 'T'));
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const [series] = await fetchFromMirror('CIU1010000000000R');

    expect(footnoteTables).toHaveBeenCalledWith(['CIU1010000000000R']);
    expect(series!.observations).toEqual([
      {
        year: '2026',
        period: 'Q03',
        value: '-',
        available: false,
        periodName: '3rd Quarter',
        footnotes: [`T: ${CI_T}`],
      },
    ]);
  });

  it('keeps the live key order: year, period, value, available, periodName, footnotes', async () => {
    mirrorServes(row('CIU1010000000000R', '2026', 'Q03', '-', 'T'));
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const [series] = await fetchFromMirror('CIU1010000000000R');

    expect(Object.keys(series!.observations[0]!)).toEqual([
      'year',
      'period',
      'value',
      'available',
      'periodName',
      'footnotes',
    ]);
  });

  it('splits a comma-separated cell in order, rendering a code its table lacks bare', async () => {
    mirrorServes(row('CIU1010000000000P', '2025', 'Q03', '-', 'U,9, T'));
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000P');

    const [series] = await fetchFromMirror('CIU1010000000000P');

    expect(series!.observations[0]!.footnotes).toEqual([`U: ${CI_U}`, '9', `T: ${CI_T}`]);
  });

  it('serves bare codes for a survey that publishes no footnote table', async () => {
    // EC publishes no ec.footnote; the store holds no table for its series.
    mirrorServes(row('ECU10001I', '2026', 'Q03', '3.4', 'P'));

    const [series] = await fetchFromMirror('ECU10001I');

    expect(series!.observations[0]!.footnotes).toEqual(['P']);
  });

  it.each([
    ['an empty cell', ''],
    ['a cell holding only separators', ' , ,'],
  ])('carries no footnotes key for %s', async (_case, codes) => {
    mirrorServes(row('CIU1010000000000R', '2026', 'Q03', '3.4', codes));
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const [series] = await fetchFromMirror('CIU1010000000000R');

    expect(series!.observations[0]).not.toHaveProperty('footnotes');
  });

  it('reads no footnote table when no served row carries a code', async () => {
    mirrorServes(
      row('CIU1010000000000A', '2026', 'Q03', '3.4'),
      row('CIU1010000000000R', '2026', 'Q02', '2.1'),
    );

    await fetchFromMirror('CIU1010000000000A', 'CIU1010000000000R');

    expect(footnoteTables).not.toHaveBeenCalled();
  });

  it('reads the tables only for the series whose rows carry codes', async () => {
    mirrorServes(
      row('CIU1010000000000A', '2026', 'Q03', '3.4'),
      row('CIU1010000000000R', '2026', 'Q03', '-', 'T'),
    );
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    await fetchFromMirror('CIU1010000000000A', 'CIU1010000000000R');

    expect(footnoteTables).toHaveBeenCalledTimes(1);
    expect(footnoteTables).toHaveBeenCalledWith(['CIU1010000000000R']);
  });

  it('decodes a mirror-served latest observation the same way', async () => {
    queryLatest.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [row('CIU1010000000000R', '2026', 'Q03', '-', 'T')],
    });
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const latest = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchLatest(
      'CIU1010000000000R',
      createMockContext(),
    );

    expect(latest.observations).toEqual([
      {
        year: '2026',
        period: 'Q03',
        value: '-',
        available: false,
        periodName: '3rd Quarter',
        footnotes: [`T: ${CI_T}`],
      },
    ]);
  });
});

describe('mirror-served period names and footnotes through the tools (#118)', () => {
  beforeEach(() => {
    initBlsApiService({} as AppConfig, undefined);
  });

  it('bls_get_series carries them in structuredContent and its Period and Notes columns', async () => {
    mirrorServes(
      row('CIU1010000000000R', '2026', 'Q03', '-', 'T'),
      row('CIU1010000000000R', '2026', 'Q02', '2.1'),
    );
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CIU1010000000000R'],
      start_year: 2026,
      end_year: 2026,
    });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const text = blsGetSeriesTool.format!(result).map((block) =>
      'text' in block ? block.text : '',
    );

    expect(result.series[0]!.observations).toEqual([
      {
        year: '2026',
        period: 'Q03',
        value: '-',
        available: false,
        periodName: '3rd Quarter',
        footnotes: [`T: ${CI_T}`],
      },
      { year: '2026', period: 'Q02', value: '2.1', available: true, periodName: '2nd Quarter' },
    ]);
    expect(text.join('\n')).toContain(`| 3rd Quarter 2026 | Q03 | Unavailable (-) | T: ${CI_T} |`);
    expect(text.join('\n')).toContain('| 2nd Quarter 2026 | Q02 | 2.1 |  |');
  });

  it('bls_get_latest carries them in structuredContent and its rendered observation', async () => {
    queryLatest.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [row('CIU1010000000000R', '2026', 'Q03', '-', 'T')],
    });
    footnoteTablesFor(CI_TABLE, 'CIU1010000000000R');

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['CIU1010000000000R'] });
    const result = await blsGetLatestTool.handler(input, ctx);
    const text = blsGetLatestTool.format!(result)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');

    expect(result.results[0]!.latestObservation).toMatchObject({
      period: 'Q03',
      periodName: '3rd Quarter',
      footnotes: [`T: ${CI_T}`],
    });
    expect(text).toContain('3rd Quarter 2026');
    expect(text).toContain(`Footnotes: T: ${CI_T}`);
  });
});

// ---------------------------------------------------------------------------
// Measure (#127)
// ---------------------------------------------------------------------------

/** A CI row as the catalog index holds it: `ci.estimate` decodes the measure. */
const CI_CATALOG: CatalogSeries = {
  seriesId: 'CIU1010000000000A',
  title: 'Total compensation for all civilian workers, 12-month percent change, current dollars',
  surveyAbbr: 'CI',
  areaName: 'United States (National)',
  itemName: 'Total compensation',
  measure: 'Total compensation',
  seasonal: false,
};

/** A JT row: BLS publishes no measure for JOLTS, so the index decodes none. */
const JT_CATALOG: CatalogSeries = {
  seriesId: 'JTS000000000000000JOL',
  title:
    'JOLTS - Job openings - Total nonfarm - Total US - All size classes - Level - In Thousands',
  surveyAbbr: 'JT',
  areaName: 'Total US',
  seasonal: true,
};

/** The catalog index holds `rows`, keyed by SeriesID. */
function catalogHolds(...rows: CatalogSeries[]): void {
  lookupByIds.mockResolvedValue(new Map(rows.map((r) => [r.seriesId, r])));
}

describe('BlsApiService mirror-served measure (#127)', () => {
  it('reports the measure the catalog index decoded, beside the other catalog fields', async () => {
    mirrorServes(row('CIU1010000000000A', '2026', 'Q03', '3.4'));
    catalogHolds(CI_CATALOG);

    const [series] = await fetchFromMirror('CIU1010000000000A');

    expect(lookupByIds).toHaveBeenCalledWith(['CIU1010000000000A']);
    expect(series).toMatchObject({
      seriesId: 'CIU1010000000000A',
      title: CI_CATALOG.title,
      area: 'United States (National)',
      item: 'Total compensation',
      measure: 'Total compensation',
      seasonal: 'Not Seasonally Adjusted',
      source: 'mirror',
    });
  });

  it('carries no measure for a series whose catalog row has none', async () => {
    mirrorServes(row('JTS000000000000000JOL', '2026', 'M08', '7208'));
    catalogHolds(JT_CATALOG);

    const [series] = await fetchFromMirror('JTS000000000000000JOL');

    expect(series).toMatchObject({ title: JT_CATALOG.title, area: 'Total US' });
    expect(series).not.toHaveProperty('measure');
  });

  it('reports the measure on a mirror-served latest observation', async () => {
    queryLatest.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [row('CIU1010000000000A', '2026', 'Q03', '3.4')],
    });
    catalogHolds(CI_CATALOG);

    const latest = await new BlsApiService('', 'https://example.invalid', 'test-agent').fetchLatest(
      'CIU1010000000000A',
      createMockContext(),
    );

    expect(latest).toMatchObject({ measure: 'Total compensation', source: 'mirror' });
  });
});

describe('mirror-served measure through the tools (#127)', () => {
  beforeEach(() => {
    initBlsApiService({} as AppConfig, undefined);
  });

  it('bls_get_series carries it in structuredContent and a Measure line, only where decoded', async () => {
    mirrorServes(
      row('CIU1010000000000A', '2026', 'Q03', '3.4'),
      row('JTS000000000000000JOL', '2026', 'M08', '7208'),
    );
    catalogHolds(CI_CATALOG, JT_CATALOG);

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['CIU1010000000000A', 'JTS000000000000000JOL'],
      start_year: 2026,
      end_year: 2026,
    });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const text = blsGetSeriesTool.format!(result)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    const [ciSection = '', jtSection = ''] = text.split('### ').slice(1);

    expect(result.series[0]).toMatchObject({
      seriesId: 'CIU1010000000000A',
      measure: 'Total compensation',
    });
    expect(result.series[1]).not.toHaveProperty('measure');
    expect(ciSection).toContain('Item: Total compensation\nMeasure: Total compensation\n');
    expect(jtSection).toMatch(/^JTS000000000000000JOL — /);
    expect(jtSection).not.toContain('Measure:');
  });

  it('bls_get_latest carries it in structuredContent and a Measure line', async () => {
    queryLatest.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [row('CIU1010000000000A', '2026', 'Q03', '3.4')],
    });
    catalogHolds(CI_CATALOG);

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['CIU1010000000000A'] });
    const result = await blsGetLatestTool.handler(input, ctx);
    const text = blsGetLatestTool.format!(result)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');

    expect(result.results[0]).toMatchObject({
      seriesId: 'CIU1010000000000A',
      measure: 'Total compensation',
    });
    expect(text).toContain('Measure: Total compensation');
  });
});

/** Real la.* rows and the whole `la.measure` table (2026-11-01). */
const LA_FILES: Record<string, string> = {
  'la.series': tsv(
    [
      'series_id                     ',
      'area_type_code',
      'area_code',
      'measure_code',
      'seasonal',
      'srd_code',
      'series_title',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    [
      'LASST530000000000008          ',
      'A',
      'ST5300000000000',
      '08',
      'S',
      '53',
      'Labor Force Participation Rate: Washington (S)',
      '',
      '1976',
      'M01',
      '2026',
      'M09',
    ],
    [
      'LAUCN530330000000003          ',
      'F',
      'CN5303300000000',
      '03',
      'U',
      '53',
      'Unemployment Rate: King County, WA (U)',
      '',
      '1990',
      'M01',
      '2026',
      'M09',
    ],
  ),
  'la.area': tsv(
    ['area_type_code', 'area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
    ['A', 'ST5300000000000', 'Washington', '0', 'T', '7845'],
    ['F', 'CN5303300000000', 'King County, WA', '0', 'T', '7891'],
  ),
  'la.measure': tsv(
    ['measure_code', 'measure_text'],
    ['03', 'unemployment rate'],
    ['04', 'unemployment'],
    ['05', 'employment'],
    ['06', 'labor force'],
    ['07', 'employment-population ratio'],
    ['08', 'labor force participation rate'],
    ['09', 'civilian noninstitutional population'],
  ),
};

/**
 * LAUS series the mirror serves, with catalog metadata from a real harvest of
 * the la.* files: the measure the tools render is the one the harvest decoded
 * from `la.measure`, the string BLS's API returns as `measure_data_type`.
 */
describe('mirror-served LAUS measure from a harvested catalog, through the tools (#127)', () => {
  let dir: string;
  let catalog: BlsCatalogService;

  beforeEach(async () => {
    initBlsApiService({} as AppConfig, undefined);
    const actual = await vi.importActual<
      typeof import('@/services/bls-catalog/bls-catalog-service.js')
    >('@/services/bls-catalog/bls-catalog-service.js');
    dir = await mkdtemp(join(tmpdir(), 'bls-mirror-la-'));
    const labstat = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const body = LA_FILES[String(url).split('/').at(-1) ?? ''];
      return new Response(body ?? '', { status: body === undefined ? 404 : 200 });
    });
    catalog = new actual.BlsCatalogService(
      'https://download.bls.gov/pub/time.series',
      'ua/1.0',
      join(dir, 'catalog.db'),
      168,
      false,
    );
    await catalog.load(1);
    labstat.mockRestore();
    lookupByIds.mockImplementation((ids: string[]) => catalog.lookupByIds(ids));
  });

  afterEach(async () => {
    await catalog.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('bls_get_series carries each series’ measure in structuredContent and a Measure line', async () => {
    mirrorServes(
      row('LASST530000000000008', '2024', 'M12', '62.9'),
      row('LAUCN530330000000003', '2024', 'M12', '3.6'),
    );

    const ctx = createMockContext({ errors: blsGetSeriesTool.errors });
    const input = blsGetSeriesTool.input.parse({
      series_ids: ['LASST530000000000008', 'LAUCN530330000000003'],
      start_year: 2024,
      end_year: 2024,
    });
    const result = await blsGetSeriesTool.handler(input, ctx);
    const text = blsGetSeriesTool.format!(result)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    const [stateSection = '', countySection = ''] = text.split('### ').slice(1);

    expect(result.series.map((s) => [s.seriesId, s.area, s.measure])).toEqual([
      ['LASST530000000000008', 'Washington', 'labor force participation rate'],
      ['LAUCN530330000000003', 'King County, WA', 'unemployment rate'],
    ]);
    expect(stateSection).toMatch(/^LASST530000000000008 — /);
    expect(stateSection).toContain('Area: Washington\nMeasure: labor force participation rate\n');
    expect(countySection).toMatch(/^LAUCN530330000000003 — /);
    expect(countySection).toContain('Area: King County, WA\nMeasure: unemployment rate\n');
  });

  it('bls_get_latest carries the measure in structuredContent and a Measure line', async () => {
    queryLatest.mockResolvedValue({
      complete: true,
      missedIds: [],
      observations: [row('LASST530000000000008', '2024', 'M12', '62.9')],
    });

    const ctx = createMockContext({ errors: blsGetLatestTool.errors });
    const input = blsGetLatestTool.input.parse({ series_ids: ['LASST530000000000008'] });
    const result = await blsGetLatestTool.handler(input, ctx);
    const text = blsGetLatestTool.format!(result)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');

    expect(result.results[0]).toMatchObject({
      seriesId: 'LASST530000000000008',
      area: 'Washington',
      measure: 'labor force participation rate',
    });
    expect(text).toContain('Area: Washington\nMeasure: labor force participation rate\n');
  });
});
