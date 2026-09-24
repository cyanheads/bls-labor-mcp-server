/**
 * @fileoverview End-to-end tests for bls_search_series over a real harvested
 * catalog: LABSTAT fixtures are served at their download.bls.gov URLs, the
 * catalog service parses and indexes them into SQLite, and the tool runs through
 * `runToolContract` so both `structuredContent` and `content[]` are asserted.
 * Covers the synthesized JOLTS titles and state-as-area decoding end to end.
 * @module tests/tools/bls-search-series.harvest.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { blsSearchSeriesTool } from '@/mcp-server/tools/definitions/bls-search-series.tool.js';
import {
  getBlsCatalogService,
  initBlsCatalogService,
  shutdownBlsCatalogService,
} from '@/services/bls-catalog/bls-catalog-service.js';

const BASE_URL = 'https://download.bls.gov/pub/time.series';

/** `initBlsCatalogService` takes the core handles positionally and reads neither. */
const coreConfig = {} as AppConfig;
const coreStorage = {} as StorageService;

function tsv(...rows: string[][]): string {
  return `${rows.map((r) => r.join('\t')).join('\r\n')}\r\n`;
}

const PERIODS = ['', '2000', 'M12', '2026', 'M07'];

/** Real jt.* rows (2026-09-23): national, California, and Midwest-region series. */
const JT_FILES: Record<string, string> = {
  'jt.series': tsv(
    [
      'series_id                     ',
      'seasonal',
      'industry_code',
      'state_code',
      'area_code',
      'sizeclass_code',
      'dataelement_code',
      'ratelevel_code',
      'footnote_codes',
      'begin_year',
      'begin_period',
      'end_year',
      'end_period',
    ],
    ['JTS000000000000000JOL         ', 'S', '000000', '00', '00000', '00', 'JO', 'L', ...PERIODS],
    ['JTS000000000000000QUR         ', 'S', '000000', '00', '00000', '00', 'QU', 'R', ...PERIODS],
    ['JTS000000060000000JOL         ', 'S', '000000', '06', '00000', '00', 'JO', 'L', ...PERIODS],
    ['JTS000000060000000JOR         ', 'S', '000000', '06', '00000', '00', 'JO', 'R', ...PERIODS],
    ['JTU000000060000000JOR         ', 'U', '000000', '06', '00000', '00', 'JO', 'R', ...PERIODS],
    ['JTS000000MW0000000HIL         ', 'S', '000000', 'MW', '00000', '00', 'HI', 'L', ...PERIODS],
  ),
  'jt.dataelement': tsv(
    ['dataelement_code', 'dataelement_text', 'display_level', 'selectable', 'sort_sequence'],
    ['HI', 'Hires', '0', 'T', '2'],
    ['JO', 'Job openings', '0', 'T', '1'],
    ['QU', 'Quits', '1', 'T', '4'],
  ),
  'jt.industry': tsv(
    ['industry_code', 'industry_text', 'display_level', 'selectable', 'sort_sequence'],
    ['000000', 'Total nonfarm', '0', 'T', '1'],
  ),
  'jt.state': tsv(
    ['state_code', 'state_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00', 'Total US', '0', 'T', '1'],
    ['06', 'California', '2', 'T', '10'],
    ['MW', 'Midwest region', '1', 'T', '4'],
  ),
  'jt.sizeclass': tsv(
    ['sizeclass_code', 'sizeclass_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00', 'All size classes', '0', 'T', '1'],
  ),
  'jt.ratelevel': tsv(
    ['ratelevel_code', 'ratelevel_text', 'display_level', 'selectable', 'sort_sequence'],
    ['L', 'Level - In Thousands', '0', 'T', '2'],
    ['R', 'Rate', '0', 'T', '1'],
  ),
  // Served so the "All areas" assertions can fail: `area_code` is the constant
  // `00000` on every jt.series row and must never supply the area.
  'jt.area': tsv(
    ['area_code', 'area_text', 'display_level', 'selectable', 'sort_sequence'],
    ['00000', 'All areas', '0', 'T', '1'],
  ),
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-search-harvest-'));
  resetServerConfig();
  vi.stubEnv('BLS_CATALOG_BASE_URL', BASE_URL);
  vi.stubEnv('BLS_CATALOG_DB_PATH', join(tmpDir, 'catalog.db'));
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    const body = JT_FILES[u.slice(u.lastIndexOf('/') + 1)];
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 }),
    );
  });
  initBlsCatalogService(coreConfig, coreStorage);
});

afterEach(async () => {
  await shutdownBlsCatalogService();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetServerConfig();
  await rm(tmpDir, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe('bls_search_series over a harvested JOLTS catalog', () => {
  beforeEach(async () => {
    await getBlsCatalogService().load(1);
  });

  it('returns California JOLTS rows with the state as the area on both surfaces', async () => {
    const result = await runToolContract(
      blsSearchSeriesTool,
      { query: 'job openings', survey: 'JT', area: 'California' },
      { context: { errors: blsSearchSeriesTool.errors } },
    );

    expect(result.isError).toBeFalsy();
    const { series } = result.structuredContent as { series: Array<Record<string, string>> };
    expect(series.map((s) => s.seriesId).sort()).toEqual([
      'JTS000000060000000JOL',
      'JTS000000060000000JOR',
      'JTU000000060000000JOR',
    ]);
    expect(series.find((s) => s.seriesId === 'JTS000000060000000JOR')).toEqual({
      seriesId: 'JTS000000060000000JOR',
      title: 'JOLTS - Job openings - Total nonfarm - California - All size classes - Rate',
      survey: 'JT',
      area: 'California',
      seasonal: 'Seasonally Adjusted',
    });

    expect(text(result)).toContain(
      '**JTS000000060000000JOR** — JOLTS - Job openings - Total nonfarm - California - All size classes - Rate · California (Seasonally Adjusted) [JT]',
    );
    expect(text(result)).toContain(
      '**JTU000000060000000JOR** — JOLTS - Job openings - Total nonfarm - California - All size classes - Rate · California (Not Seasonally Adjusted) [JT]',
    );
    expect(text(result)).not.toContain('All areas');
  });

  it('discloses the cap when more JOLTS rows match than the limit returns', async () => {
    const result = await runToolContract(
      blsSearchSeriesTool,
      { query: 'job openings', survey: 'JT', limit: 1 },
      { context: { errors: blsSearchSeriesTool.errors } },
    );

    const structured = result.structuredContent as {
      series: Array<{ seriesId: string }>;
      totalCount: number;
      truncated?: boolean;
    };
    expect(structured.series).toHaveLength(1);
    expect(structured.totalCount).toBeGreaterThan(1);
    expect(structured.truncated).toBe(true);
    expect(text(result)).toContain('1 series returned');
  });

  it('explains an empty result for a region the survey does not carry', async () => {
    const result = await runToolContract(
      blsSearchSeriesTool,
      { query: 'job openings', survey: 'JT', area: 'Puerto Rico' },
      { context: { errors: blsSearchSeriesTool.errors } },
    );

    const structured = result.structuredContent as { series: unknown[]; notice?: string };
    expect(structured.series).toEqual([]);
    expect(structured.notice).toBe(
      'No matching series found. Try removing the survey/area/seasonal filter or broadening the query.',
    );
    expect(text(result)).toContain('No matching series found.');
  });

  it('rejects a blank query as invalid params', async () => {
    const result = await runToolContract(
      blsSearchSeriesTool,
      { query: '   ' },
      { context: { errors: blsSearchSeriesTool.errors } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
});

describe('bls_search_series before the catalog harvest', () => {
  it('fails with catalog_unavailable until the index has loaded', async () => {
    const result = await runToolContract(
      blsSearchSeriesTool,
      { query: 'job openings' },
      { context: { errors: blsSearchSeriesTool.errors } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'catalog_unavailable' } },
    });
    expect(text(result)).toContain('catalog_unavailable');
  });
});
