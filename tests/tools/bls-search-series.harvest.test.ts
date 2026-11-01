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
import { tsv } from '../services/bls-catalog/oews-fixtures.js';

const BASE_URL = 'https://download.bls.gov/pub/time.series';

/** `initBlsCatalogService` takes the core handles positionally and reads neither. */
const coreConfig = {} as AppConfig;
const coreStorage = {} as StorageService;

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
      startYear: 2000,
      endYear: 2026,
      endPeriod: 'M07',
    });

    expect(text(result)).toContain(
      '**JTS000000060000000JOR** — JOLTS - Job openings - Total nonfarm - California - All size classes - Rate · California (Seasonally Adjusted) [JT]',
    );
    expect(text(result)).toContain(
      '**JTU000000060000000JOR** — JOLTS - Job openings - Total nonfarm - California - All size classes - Rate · California (Not Seasonally Adjusted) [JT]',
    );
    expect(text(result)).not.toContain('All areas');
    expect(text(result)).toContain('Coverage: 2000–2026 M07');
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

describe('bls_search_series while the catalog holds no series (#112)', () => {
  const search = () =>
    runToolContract(
      blsSearchSeriesTool,
      { query: 'job openings' },
      { context: { errors: blsSearchSeriesTool.errors } },
    );
  type ErrorEnvelope = {
    error: { code: number; message: string; data: { recovery?: { hint: string } } };
  };
  const envelope = (result: Awaited<ReturnType<typeof search>>) =>
    (result.structuredContent as ErrorEnvelope).error;

  /**
   * Hold every download until the returned release runs (or its request aborts);
   * requests keep their served bodies.
   */
  function holdDownloads(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serveNow = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        void gate.then(resolve);
      });
      return serveNow(url, init);
    });
    return release;
  }

  it('reports catalog_loading, retryable, during the first harvest and answers once it finishes', async () => {
    const release = holdDownloads();
    const loading = getBlsCatalogService().load(1);

    const during = await search();
    expect(during.isError).toBe(true);
    expect(during.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'catalog_loading', retryable: true },
      },
    });
    expect(envelope(during).data.recovery?.hint).toMatch(/retry/i);
    expect(text(during)).toContain('(reason catalog_loading · retryable)');
    expect(text(during)).not.toMatch(/restart|may have failed/i);

    release();
    await loading;
    const after = await search();
    expect(after.isError).toBeFalsy();
    expect(text(after)).toContain('JTS000000000000000JOL');
  });

  it('reports catalog_unavailable once every attempt comes back empty, and catalog_loading while the next check retries', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(new Response('', { status: 404 })),
    );
    const svc = getBlsCatalogService();
    await svc.load(1);

    const failed = await search();
    expect(failed.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError, data: { reason: 'catalog_unavailable' } },
    });
    expect(envelope(failed).message).toContain('all LABSTAT downloads returned empty');
    expect(envelope(failed).data.recovery?.hint).toMatch(/hourly/);
    expect(envelope(failed).data.recovery?.hint).toContain('BLS_CATALOG_BASE_URL');
    expect(text(failed)).toContain('(reason catalog_unavailable)');

    // The hourly tick's retry of the empty index is a harvest in flight again.
    const release = holdDownloads();
    const retry = svc.load(1);
    const retrying = await search();
    expect(retrying.structuredContent).toMatchObject({
      error: { data: { reason: 'catalog_loading', retryable: true } },
    });
    release();
    await retry;
    expect((await search()).structuredContent).toMatchObject({
      error: { data: { reason: 'catalog_unavailable' } },
    });
  });

  it('reports catalog_unavailable naming the failure when the load rejects, never catalog_loading', async () => {
    const svc = getBlsCatalogService();
    const store = (svc as unknown as { store: { applyBatch: (...args: never[]) => unknown } })
      .store;
    vi.spyOn(store, 'applyBatch').mockRejectedValue(
      new Error('SQLITE_FULL: database or disk is full'),
    );
    await expect(svc.load(1)).rejects.toThrow('SQLITE_FULL');

    const result = await search();
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'catalog_unavailable' } },
    });
    expect(envelope(result).message).toContain('SQLITE_FULL: database or disk is full');
    expect(text(result)).not.toContain('catalog_loading');
  });
});
