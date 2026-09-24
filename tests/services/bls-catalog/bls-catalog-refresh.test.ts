/**
 * @fileoverview The hourly catalog refresh job (#84) on the framework's real
 * `schedulerService` and `node-cron`, driven by fake timers: a process running
 * past `BLS_CATALOG_CACHE_TTL_HOURS` re-harvests without a restart, searches
 * read the old index until the harvest completes, a tick never starts a second
 * harvest, and teardown stops the job. `bls_search_series` runs through
 * `runToolContract`, so the refreshed index is checked on `structuredContent`
 * and `content[]`.
 * @module tests/services/bls-catalog/bls-catalog-refresh.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { blsSearchSeriesTool } from '@/mcp-server/tools/definitions/bls-search-series.tool.js';
import {
  CATALOG_REFRESH_JOB_ID,
  catalogSurveyList,
  createCatalogStore,
  getBlsCatalogService,
  initBlsCatalogService,
  scheduleBlsCatalogRefresh,
  shutdownBlsCatalogService,
} from '@/services/bls-catalog/bls-catalog-service.js';

const coreConfig = {} as AppConfig;
const coreStorage = {} as StorageService;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let tmpDir: string;

/** Series already in the index: CE, CU, and LN rows. */
const OLD_ROWS = [
  ['CES0000000001', 'CE'],
  ['CUUR0000SA0', 'CU'],
  ['LNS14000000', 'LN'],
] as const;

const JT_SERIES =
  'series_id\tseasonal\tseries_title\r\n' +
  'JTS000000000000000JOL\tS\tJob openings total nonfarm\r\n' +
  'JTS000000000000000QUR\tS\tQuits rate total nonfarm\r\n';

async function seed(path: string, completedAt: Date): Promise<void> {
  const store = createCatalogStore(path);
  await store.applyBatch(
    OLD_ROWS.map(([id, survey]) => ({
      series_id: id,
      title: `Series ${id}`,
      survey_abbr: survey,
      area_name: null,
      item_name: null,
      seasonal: 1,
    })),
    [],
  );
  await store.writeState({
    status: 'complete',
    completedAt: completedAt.toISOString(),
    total: OLD_ROWS.length,
    checkpoint: catalogSurveyList(false),
  });
  await store.close();
}

/**
 * Serve jt.series once `gate` opens (or reject when the request aborts); every
 * other URL 404s at once. Returns the file names requested.
 */
function serveJt(gate: Promise<void>): string[] {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const u = String(url);
    const file = u.slice(u.lastIndexOf('/') + 1);
    requested.push(file);
    if (file !== 'jt.series') return Promise.resolve(new Response('', { status: 404 }));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      void gate.then(() => resolve(new Response(JT_SERIES)));
    });
  });
  return requested;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function startService(completedAt: Date, ttlHours: number): Promise<void> {
  const path = join(tmpDir, 'catalog.db');
  await seed(path, completedAt);
  vi.stubEnv('BLS_CATALOG_DB_PATH', path);
  vi.stubEnv('BLS_CATALOG_BASE_URL', 'https://download.bls.gov/pub/time.series');
  vi.stubEnv('BLS_CATALOG_CACHE_TTL_HOURS', String(ttlHours));
  resetServerConfig();
  initBlsCatalogService(coreConfig, coreStorage);
}

async function searchTool(args: { query: string; survey?: string }) {
  const result = await runToolContract(blsSearchSeriesTool, args as never, {
    context: { errors: blsSearchSeriesTool.errors },
  });
  const structured = result.structuredContent as {
    catalogSize: number;
    notice?: string;
    series: Array<{ seriesId: string }>;
  };
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { structured, text };
}

const count = (requested: string[], file: string) => requested.filter((f) => f === file).length;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-catalog-refresh-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: new Date('2026-09-23T10:30:00Z'),
  });
});

afterEach(async () => {
  await shutdownBlsCatalogService();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetServerConfig();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('hourly catalog refresh (#84)', () => {
  it('re-harvests once the TTL lapses, without a restart, serving the old index until it completes', async () => {
    await startService(new Date(), 1);
    const gate = deferred();
    const requested = serveJt(gate.promise);
    const svc = getBlsCatalogService();
    await svc.load();
    await scheduleBlsCatalogRefresh();
    expect(requested).toEqual([]);

    const before = await searchTool({ query: 'job openings', survey: 'JT' });
    expect(before.structured.catalogSize).toBe(3);
    expect(before.structured.notice).toContain('(indexed: CE, CU, LN)');
    expect(before.text).toContain('(indexed: CE, CU, LN)');

    // 11:00 — the index is half an hour old, inside the one-hour TTL.
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(requested).toEqual([]);

    // 12:00 — an hour and a half old: the tick starts a harvest.
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(() => expect(requested).toContain('jt.series'));
    const during = await searchTool({ query: 'CES0000000001' });
    expect(during.structured.series[0]?.seriesId).toBe('CES0000000001');
    expect(during.structured.catalogSize).toBe(3);

    // 13:00 — a tick while the 12:00 harvest is still in flight starts no second one.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(count(requested, 'jt.series')).toBe(1);

    gate.release();
    await svc.load(); // joins the in-flight harvest
    expect(count(requested, 'jt.series')).toBe(1);
    expect(svc.totalSeries).toBe(5);
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'JT', 'LN']);

    const after = await searchTool({ query: 'job openings', survey: 'JT' });
    expect(after.structured.catalogSize).toBe(5);
    expect(after.structured.series.map((s) => s.seriesId)).toContain('JTS000000000000000JOL');
    expect(after.text).toContain('JTS000000000000000JOL');

    // 14:00 — the refreshed index is fresh again.
    requested.length = 0;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requested).toEqual([]);
  });

  it('starts no second harvest when a tick lands during the boot harvest', async () => {
    await startService(new Date(Date.now() - 1_000 * HOUR), 168);
    vi.setSystemTime(new Date('2026-09-23T10:59:59Z'));
    const gate = deferred();
    const requested = serveJt(gate.promise);
    const svc = getBlsCatalogService();
    const load = vi.spyOn(svc, 'load');

    const boot = svc.load();
    await scheduleBlsCatalogRefresh();
    await vi.waitFor(() => expect(requested).toContain('jt.series'));

    await vi.advanceTimersByTimeAsync(2_000); // 11:00:01 — the tick fires mid-harvest
    // The tick called load() and was handed the boot's in-flight run.
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.results[1]?.value).toBe(boot);
    gate.release();
    await boot;
    await svc.load();

    expect(count(requested, 'jt.series')).toBe(1);
    expect(count(requested, 'cu.series')).toBe(1);
    expect(svc.indexedSurveys).toEqual(['CE', 'CU', 'JT', 'LN']);
  });

  it('is stopped by teardown, so no later tick runs', async () => {
    await startService(new Date(Date.now() - 1_000 * HOUR), 168);
    const gate = deferred();
    gate.release();
    const requested = serveJt(gate.promise);
    await scheduleBlsCatalogRefresh();
    expect(schedulerService.listJobs().map((j) => j.id)).toContain(CATALOG_REFRESH_JOB_ID);

    await shutdownBlsCatalogService();
    expect(schedulerService.listJobs().map((j) => j.id)).not.toContain(CATALOG_REFRESH_JOB_ID);
    // A live service over the stale index, so a surviving tick would harvest.
    initBlsCatalogService(coreConfig, coreStorage);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(requested).toEqual([]);
  });

  it('stops a tick’s in-flight harvest on teardown without an unhandled rejection', async () => {
    await startService(new Date(Date.now() - 1_000 * HOUR), 168);
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      requested.push(String(url));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    await scheduleBlsCatalogRefresh();
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));

    await shutdownBlsCatalogService();
    const check = createCatalogStore(join(tmpDir, 'catalog.db'));
    expect(await check.count()).toBe(OLD_ROWS.length);
    await check.close();
  });
});
