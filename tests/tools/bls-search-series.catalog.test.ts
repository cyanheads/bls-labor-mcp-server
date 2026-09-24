/**
 * @fileoverview End-to-end tests for bls_search_series over a real seeded
 * SQLite catalog: the service loads a pre-built index (warm path, no harvest)
 * and the tool runs through `runToolContract`, so the filter normalization,
 * the SQL candidate query, the rescore, offset paging, and the enrichment
 * notices all run for real on both `structuredContent` and `content[]`.
 * @module tests/tools/bls-search-series.catalog.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { blsSearchSeriesTool } from '@/mcp-server/tools/definitions/bls-search-series.tool.js';
import {
  createCatalogStore,
  getBlsCatalogService,
  initBlsCatalogService,
  SURVEY_ABBRS,
  shutdownBlsCatalogService,
} from '@/services/bls-catalog/bls-catalog-service.js';
import type { CatalogSeries } from '@/services/bls-catalog/types.js';

/** `initBlsCatalogService` takes the core handles positionally and reads neither. */
const coreConfig = {} as AppConfig;
const coreStorage = {} as StorageService;

interface SearchStructured {
  areaFilter?: string;
  cap?: number;
  capped: boolean;
  catalogSize: number;
  limitApplied: number;
  nextOffset?: number;
  notice?: string;
  offsetApplied?: number;
  series: Array<{ seriesId: string; area?: string; survey: string }>;
  shown?: number;
  surveyFilter?: string;
  totalCount: number;
  truncated?: boolean;
}

const pad = (n: number, width = 4) => String(n).padStart(width, '0');

/** 120 national LN rows that all match "unemployment rate", ranked by bm25 then insertion. */
const LN_ROWS: CatalogSeries[] = Array.from({ length: 120 }, (_, i) => ({
  seriesId: `LNTEST${pad(i)}`,
  title: `Unemployment rate, test group ${i}`,
  surveyAbbr: 'LN',
  seasonal: i % 2 === 0,
}));

/**
 * 1,001 decoys that outrank the Seattle rows on bm25 for "unemployment rate" —
 * the term-frequency-heavy titles fill the whole 1,000-row candidate window.
 */
const DECOYS: CatalogSeries[] = Array.from({ length: 1001 }, (_, i) => ({
  seriesId: `LADECOY${pad(i, 5)}`,
  title: `Unemployment rate unemployment rate ${i}`,
  surveyAbbr: 'LA',
  seasonal: false,
}));

const SEATTLE_ROWS: CatalogSeries[] = [
  {
    seriesId: 'LAUCT536300000000003',
    title: 'Unemployment Rate: Seattle city, WA (U)',
    surveyAbbr: 'LA',
    seasonal: false,
    areaName: 'Seattle city, WA',
  },
  {
    seriesId: 'LAUMT534266000000003',
    title: 'Unemployment Rate: Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area (U)',
    surveyAbbr: 'LA',
    seasonal: false,
    areaName: 'Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area',
  },
  {
    seriesId: 'LASST530000000000003',
    title: 'Unemployment Rate: Washington (S)',
    surveyAbbr: 'LA',
    seasonal: true,
    areaName: 'Washington',
  },
];

const CU_ROWS: CatalogSeries[] = [
  {
    seriesId: 'CUUR0000SA0',
    title: 'All items in U.S. city average, all urban consumers, not seasonally adjusted',
    surveyAbbr: 'CU',
    seasonal: false,
    areaName: 'U.S. city average',
    itemName: 'All items',
  },
  {
    seriesId: 'CUURS49DSA0',
    title: 'All items in Seattle-Tacoma-Bellevue, WA, all urban consumers, not seasonally adjusted',
    surveyAbbr: 'CU',
    seasonal: false,
    areaName: 'Seattle-Tacoma-Bellevue, WA',
    itemName: 'All items',
  },
];

const CE_ROWS: CatalogSeries[] = [
  {
    seriesId: 'CES0000000001',
    title: 'All employees, thousands, total nonfarm, seasonally adjusted',
    surveyAbbr: 'CE',
    seasonal: true,
    itemName: 'Total nonfarm',
  },
  // No decoded area: only its title carries the place name.
  {
    seriesId: 'CETESTSEA01',
    title: 'Insured unemployment rate, Seattle area test series',
    surveyAbbr: 'CE',
    seasonal: false,
  },
];

const ALL_ROWS = [...LN_ROWS, ...DECOYS, ...SEATTLE_ROWS, ...CU_ROWS, ...CE_ROWS];

/** Survey codes present in the seeded index. */
const INDEXED = 'CE, CU, LA, LN';

let tmpDir: string;

async function seedCatalog(dbPath: string, rows: CatalogSeries[]): Promise<void> {
  const store = createCatalogStore(dbPath);
  await store.applyBatch(
    rows.map((s) => ({
      series_id: s.seriesId,
      title: s.title,
      survey_abbr: s.surveyAbbr,
      area_name: s.areaName ?? null,
      item_name: s.itemName ?? null,
      seasonal: s.seasonal ? 1 : 0,
    })),
    [],
  );
  await store.writeState({
    status: 'complete',
    completedAt: new Date().toISOString(),
    total: rows.length,
  });
  await store.close();
}

/** Point the service at a freshly seeded index and load it. Any fetch fails the load loudly. */
async function startService(env: Record<string, string> = {}): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-search-catalog-'));
  const dbPath = join(tmpDir, 'catalog.db');
  await seedCatalog(dbPath, ALL_ROWS);
  resetServerConfig();
  vi.stubEnv('BLS_CATALOG_DB_PATH', dbPath);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  initBlsCatalogService(coreConfig, coreStorage);
  await getBlsCatalogService().load(1);
}

async function stopService(): Promise<void> {
  await shutdownBlsCatalogService();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetServerConfig();
  await rm(tmpDir, { recursive: true, force: true });
}

/** Run the tool on raw arguments — deliberately untyped, so invalid shapes reach the schema. */
async function call(args: { query: string; [key: string]: unknown }) {
  const input = args as Parameters<typeof runToolContract<typeof blsSearchSeriesTool>>[1];
  const result = await runToolContract(blsSearchSeriesTool, input, {
    context: { errors: blsSearchSeriesTool.errors },
  });
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { result, structured: result.structuredContent as SearchStructured, text };
}

const ids = (s: SearchStructured) => s.series.map((x) => x.seriesId);

describe('bls_search_series over a seeded catalog', () => {
  beforeAll(() => startService());
  afterAll(() => stopService());

  it('loads the seeded index without fetching', () => {
    expect(getBlsCatalogService().totalSeries).toBe(ALL_ROWS.length);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  describe('offset omitted (characterization)', () => {
    it('returns the first page with total, truncation, shown, and cap', async () => {
      const { structured } = await call({ query: 'unemployment rate', survey: 'LN' });
      expect(structured.series).toHaveLength(10);
      expect(ids(structured)).toEqual(LN_ROWS.slice(0, 10).map((s) => s.seriesId));
      expect(structured.totalCount).toBe(120);
      expect(structured.truncated).toBe(true);
      expect(structured.shown).toBe(10);
      expect(structured.cap).toBe(10);
      expect(structured.capped).toBe(false);
      expect(structured.surveyFilter).toBe('LN');
    });

    it('returns a complete list with no truncation fields', async () => {
      const { structured } = await call({ query: 'all items', survey: 'CU' });
      expect(ids(structured).sort()).toEqual(['CUUR0000SA0', 'CUURS49DSA0']);
      expect(structured.totalCount).toBe(2);
      expect(structured.truncated).toBeUndefined();
      expect(structured.notice).toBeUndefined();
    });
  });

  describe('survey/area normalization (#70)', () => {
    it.each(['', ' ', '   '])(
      'treats survey %j as absent: same result, no echo',
      async (survey) => {
        const omitted = await call({ query: 'all items' });
        const blank = await call({ query: 'all items', survey });
        expect(ids(blank.structured)).toEqual(ids(omitted.structured));
        expect(blank.structured.totalCount).toBe(omitted.structured.totalCount);
        expect(blank.structured).not.toHaveProperty('surveyFilter');
        expect(blank.text).not.toContain('surveyFilter');
      },
    );

    it.each(['', ' ', '   '])('treats area %j as absent: same result, no echo', async (area) => {
      const omitted = await call({ query: 'unemployment rate' });
      const blank = await call({ query: 'unemployment rate', area });
      expect(ids(blank.structured)).toEqual(ids(omitted.structured));
      expect(blank.structured.totalCount).toBe(omitted.structured.totalCount);
      expect(blank.structured).not.toHaveProperty('areaFilter');
      expect(blank.text).not.toContain('areaFilter');
    });

    it.each([' CU ', 'cu', ' cu '])('applies survey %j as CU and echoes "CU"', async (survey) => {
      const canonical = await call({ query: 'all items', survey: 'CU' });
      const padded = await call({ query: 'all items', survey });
      expect(padded.structured.series.length).toBeGreaterThan(0);
      expect(ids(padded.structured)).toEqual(ids(canonical.structured));
      expect(padded.structured.totalCount).toBe(canonical.structured.totalCount);
      expect(padded.structured.surveyFilter).toBe('CU');
      expect(padded.text).toContain('**surveyFilter:** CU');
    });

    it('applies a padded area as its trimmed value and echoes the trimmed value', async () => {
      const canonical = await call({ query: 'unemployment rate', area: 'Seattle' });
      const padded = await call({ query: 'unemployment rate', area: ' Seattle ' });
      expect(padded.structured.series.length).toBeGreaterThan(0);
      expect(ids(padded.structured)).toEqual(ids(canonical.structured));
      expect(padded.structured.totalCount).toBe(canonical.structured.totalCount);
      expect(padded.structured.areaFilter).toBe('Seattle');
    });

    it('never gives the remove-the-filter notice for a blank filter', async () => {
      const { structured, text } = await call({ query: 'zzzqqq', survey: '  ', area: '' });
      expect(structured.series).toEqual([]);
      expect(structured.notice).not.toContain('Try removing');
      expect(structured.notice).toContain('Try broadening the query');
      expect(text).not.toContain('Try removing');
    });
  });

  describe('offset paging (#62)', () => {
    const unpaged = LN_ROWS.map((s) => s.seriesId);

    it('offset 0 returns the same series, totalCount, and truncated as omitting it', async () => {
      const omitted = await call({ query: 'unemployment rate', survey: 'LN', limit: 50 });
      const zero = await call({ query: 'unemployment rate', survey: 'LN', limit: 50, offset: 0 });
      expect(ids(zero.structured)).toEqual(ids(omitted.structured));
      expect(zero.structured.totalCount).toBe(omitted.structured.totalCount);
      expect(zero.structured.truncated).toBe(omitted.structured.truncated);
      expect(zero.structured.offsetApplied).toBe(0);
      expect(zero.structured.nextOffset).toBe(50);
      expect(zero.structured.notice).toBe(
        'Showing results 1–50 of 120. Pass offset: 50 for the next page.',
      );
    });

    it('pages a mid-list slice with offsetApplied, nextOffset, and next-page guidance on both surfaces', async () => {
      const { structured, text } = await call({
        query: 'unemployment rate',
        survey: 'LN',
        limit: 50,
        offset: 50,
      });
      expect(ids(structured)).toEqual(unpaged.slice(50, 100));
      expect(structured).toMatchObject({
        totalCount: 120,
        offsetApplied: 50,
        nextOffset: 100,
        truncated: true,
        shown: 50,
        cap: 50,
        limitApplied: 50,
      });
      expect(structured.notice).toBe(
        'Showing results 51–100 of 120. Pass offset: 100 for the next page.',
      );
      expect(text).toContain('**50 series returned:**');
      expect(text).toContain('**LNTEST0050**');
      expect(text).toContain('Showing results 51–100 of 120. Pass offset: 100 for the next page.');
      expect(text).toContain('**offsetApplied:** 50');
      expect(text).toContain('**nextOffset:** 100');
    });

    it('concatenates pages past the second into the unpaged list with no gaps or duplicates', async () => {
      const pages: string[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined) {
        const { structured } = await call({
          query: 'unemployment rate',
          survey: 'LN',
          limit: 25,
          offset,
        });
        pages.push(...ids(structured));
        offset = structured.nextOffset;
        calls++;
      }
      expect(calls).toBe(5);
      expect(pages).toEqual(unpaged);
    });

    it('returns totalCount - offset rows on the last page, with no nextOffset or truncation', async () => {
      const { structured, text } = await call({
        query: 'unemployment rate',
        survey: 'LN',
        limit: 50,
        offset: 100,
      });
      expect(ids(structured)).toEqual(unpaged.slice(100));
      expect(structured.series).toHaveLength(20);
      expect(structured.offsetApplied).toBe(100);
      expect(structured).not.toHaveProperty('nextOffset');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toBeUndefined();
      expect(text).toContain('**20 series returned:**');
    });

    it('gives a distinct past-the-end notice when offset >= totalCount', async () => {
      for (const offset of [120, 500]) {
        const { structured, text } = await call({
          query: 'unemployment rate',
          survey: 'LN',
          limit: 50,
          offset,
        });
        expect(structured.series).toEqual([]);
        expect(structured.totalCount).toBe(120);
        expect(structured.offsetApplied).toBe(offset);
        expect(structured).not.toHaveProperty('nextOffset');
        expect(structured.notice).toBe(
          `Offset ${offset} is past the last of 120 results. Pass an offset below 120 (offset 0 is the first page).`,
        );
        expect(structured.notice).not.toContain('broaden');
        expect(structured.notice).not.toContain('Try removing');
        expect(text).toContain(`Offset ${offset} is past the last of 120 results.`);
        expect(text).not.toContain('No matching series');
      }
    });

    it('says the pool is capped on the last page of a capped list', async () => {
      const first = await call({ query: 'unemployment rate', survey: 'LA', limit: 50 });
      expect(first.structured.capped).toBe(true);
      const total = first.structured.totalCount;
      const lastOffset = Math.floor((total - 1) / 50) * 50;
      const { structured, text } = await call({
        query: 'unemployment rate',
        survey: 'LA',
        limit: 50,
        offset: lastOffset,
      });
      expect(structured.series).toHaveLength(total - lastOffset);
      expect(structured).not.toHaveProperty('nextOffset');
      expect(structured.notice).toContain('candidate pool is capped');
      expect(structured.notice).toContain('Narrow the query');
      expect(text).toContain('candidate pool is capped');
    });

    it.each([-1, 1.5, '10'])('rejects offset %j as invalid params', async (offset) => {
      const { result } = await call({ query: 'unemployment rate', offset });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    });
  });

  describe('surveys outside the index (#64)', () => {
    it.each(['EN', 'en', ' en '])(
      'names the indexed surveys for survey %j instead of blaming the query',
      async (survey) => {
        const { structured, text } = await call({ query: 'employment', survey });
        expect(structured.series).toEqual([]);
        expect(structured.surveyFilter).toBe('EN');
        expect(structured.notice).toBe(
          `Survey EN has no series in the offline catalog index (indexed: ${INDEXED}). Use bls_list_surveys for valid codes; series in other surveys are fetchable by SeriesID via bls_get_series.`,
        );
        expect(text).toContain(`(indexed: ${INDEXED})`);
      },
    );

    it('names BLS_CATALOG_INCLUDE_OES=true for OE while the opt-in is off', async () => {
      const { structured } = await call({ query: 'registered nurses wage', survey: 'OE' });
      expect(structured.notice).toContain('Survey OE has no series in the offline catalog index');
      expect(structured.notice).toContain('BLS_CATALOG_INCLUDE_OES=true');
    });

    it('keeps the filter notice for an indexed survey with no match', async () => {
      const { structured } = await call({ query: 'zzzqqq', survey: 'CE' });
      expect(structured.series).toEqual([]);
      expect(structured.notice).toBe(
        'No matching series found. Try removing the survey/area/seasonal filter or broadening the query.',
      );
    });
  });

  describe('area filter before the candidate cap (#69)', () => {
    it('returns every area match under 1,000 outranking decoys, never an empty capped page', async () => {
      const { structured } = await call({ query: 'unemployment rate', area: 'Seattle', limit: 50 });
      expect(ids(structured).sort()).toEqual([
        'CETESTSEA01',
        'LAUCT536300000000003',
        'LAUMT534266000000003',
      ]);
      expect(structured.totalCount).toBe(3);
      expect(structured.capped).toBe(false);
      expect(structured.areaFilter).toBe('Seattle');
    });

    it('combines survey and area', async () => {
      const { structured } = await call({
        query: 'unemployment rate',
        survey: 'LA',
        area: 'Seattle',
      });
      expect(ids(structured).sort()).toEqual(['LAUCT536300000000003', 'LAUMT534266000000003']);
      expect(structured.totalCount).toBe(2);
    });

    it('pages the area-filtered list and counts only it', async () => {
      const first = await call({ query: 'unemployment rate', area: 'Seattle', limit: 2 });
      const second = await call({
        query: 'unemployment rate',
        area: 'Seattle',
        limit: 2,
        offset: 2,
      });
      expect(first.structured.totalCount).toBe(3);
      expect(first.structured.nextOffset).toBe(2);
      expect(second.structured.series).toHaveLength(1);
      expect([...ids(first.structured), ...ids(second.structured)].sort()).toEqual([
        'CETESTSEA01',
        'LAUCT536300000000003',
        'LAUMT534266000000003',
      ]);
    });
  });

  describe('advertised survey codes (#64)', () => {
    const codes = new Set(SURVEY_ABBRS.map((a) => a.toUpperCase()));
    const surveyDescription =
      blsSearchSeriesTool.input.shape.survey.description ?? '(missing .describe())';

    it.each([
      ['tool description', blsSearchSeriesTool.description],
      ['survey .describe()', surveyDescription],
    ])('the %s names no code outside SURVEY_ABBRS and qualifies OE as opt-in', (_, text) => {
      const named = [...text.matchAll(/\b[A-Z]{2}\b/g)].map((m) => m[0]);
      const surveyCodes = named.filter((c) => !['ID', 'US'].includes(c));
      expect(surveyCodes.length).toBeGreaterThan(0);
      expect(surveyCodes.filter((c) => !codes.has(c))).toEqual([]);
      expect(text).toMatch(/OE[^.]*BLS_CATALOG_INCLUDE_OES=true/);
    });
  });
});

describe('bls_search_series with the OES opt-in on but no OE rows indexed (#64)', () => {
  beforeAll(() => startService({ BLS_CATALOG_INCLUDE_OES: 'true' }));
  afterAll(() => stopService());

  it('gives the not-indexed notice without the opt-in instruction', async () => {
    const { structured } = await call({ query: 'registered nurses wage', survey: 'OE' });
    expect(structured.series).toEqual([]);
    expect(structured.notice).toBe(
      `Survey OE has no series in the offline catalog index (indexed: ${INDEXED}). Use bls_list_surveys for valid codes; series in other surveys are fetchable by SeriesID via bls_get_series.`,
    );
  });
});
