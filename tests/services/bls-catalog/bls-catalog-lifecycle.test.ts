/**
 * @fileoverview Catalog index lifecycle (#84): stale-row removal after a
 * harvest, the persisted survey list that makes a configuration change
 * re-harvest inside the TTL, chunked deletes that leave searches unblocked, and
 * a shutdown that stops an in-flight harvest. Every case runs the real
 * `sqliteMirrorStore` on disk; LABSTAT files are served per file name through a
 * fetch mock, and any URL not served 404s.
 * @module tests/services/bls-catalog/bls-catalog-lifecycle.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorRow, MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlsCatalogService,
  catalogSurveyList,
  createCatalogStore,
} from '@/services/bls-catalog/bls-catalog-service.js';

const BASE = 'https://download.bls.gov/pub/time.series';
const HOUR = 3_600_000;

let tmpDir: string;
let dbCounter = 0;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-catalog-lifecycle-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

const dbPath = () => join(tmpDir, `catalog-${dbCounter++}.db`);

function row(seriesId: string, survey: string): MirrorRow {
  return {
    series_id: seriesId,
    title: `Series ${seriesId}`,
    survey_abbr: survey,
    area_name: null,
    item_name: null,
    seasonal: 0,
  };
}

/** A `.series` file listing `ids`, with the upstream `series_title` column. */
function seriesFile(ids: readonly string[]): string {
  return `series_id\tseasonal\tseries_title\r\n${ids.map((id) => `${id}\tU\tSeries ${id}\r\n`).join('')}`;
}

/**
 * Persist an index holding `rows`, completed `ageHours` ago, with `list` as the
 * stored survey list (`undefined` writes none, as releases before it did).
 */
async function seed(
  path: string,
  rows: MirrorRow[],
  opts: { ageHours?: number; list?: string | undefined } = {},
): Promise<void> {
  const store = createCatalogStore(path);
  for (let i = 0; i < rows.length; i += 5_000) {
    await store.applyBatch(rows.slice(i, i + 5_000), []);
  }
  await store.writeState({
    status: 'complete',
    completedAt: new Date(Date.now() - (opts.ageHours ?? 0) * HOUR).toISOString(),
    total: rows.length,
    ...('list' in opts ? { checkpoint: opts.list } : { checkpoint: catalogSurveyList(false) }),
  });
  await store.close();
}

type Served = string | ((init: RequestInit | undefined) => Promise<Response>);

/** Serve `files` by file name; every other URL 404s. Returns the file names requested. */
function serve(files: Record<string, Served>): string[] {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const u = String(url);
    const file = u.slice(u.lastIndexOf('/') + 1);
    requested.push(file);
    const body = files[file];
    if (typeof body === 'function') return body(init);
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 }),
    );
  });
  return requested;
}

/** The service's own store, spied on (pass-through) to observe its writes. */
function storeOf(svc: BlsCatalogService): MirrorStore {
  return (svc as unknown as { store: MirrorStore }).store;
}

async function ids(svc: BlsCatalogService, wanted: string[]): Promise<string[]> {
  return [...(await svc.lookupByIds(wanted)).keys()].sort();
}

describe('stale rows after a harvest (#84)', () => {
  it('removes a survey’s indexed series that its current .series file no longer lists', async () => {
    const path = dbPath();
    await seed(path, [row('WPU0111', 'WP'), row('WPU12410301', 'WP'), row('JTS1', 'JT')], {
      ageHours: 1_000,
    });
    serve({ 'wp.series': seriesFile(['WPU0111', 'WPU0112']) });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(await ids(svc, ['WPU0111', 'WPU0112', 'WPU12410301', 'JTS1'])).toEqual([
      'JTS1',
      'WPU0111',
      'WPU0112',
    ]);
    expect(svc.totalSeries).toBe(3);
    await svc.shutdown();
  });

  it.each([
    ['the request fails', () => Promise.reject(new Error('socket hang up'))],
    ['it returns non-200', () => Promise.resolve(new Response('busy', { status: 503 }))],
    [
      'its header lacks a series_id column',
      () => Promise.resolve(new Response('<html>\r\n<body>maintenance</body>\r\n</html>\r\n')),
    ],
    [
      // A close-delimited response cut short resolves with the partial body on
      // Node and Bun alike; its last line is a fragment ("WPU01").
      'ends mid-line, as a download cut short does',
      () => Promise.resolve(new Response(`${seriesFile(['WPU0111'])}WPU01`)),
    ],
  ])('keeps a survey’s rows when its .series file %s', async (_, wpSeries) => {
    const path = dbPath();
    await seed(path, [row('WPU0111', 'WP'), row('WPU12410301', 'WP')], { ageHours: 1_000 });
    serve({ 'wp.series': wpSeries, 'jt.series': seriesFile(['JTS1']) });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(await ids(svc, ['WPU0111', 'WPU12410301', 'JTS1'])).toEqual([
      'JTS1',
      'WPU0111',
      'WPU12410301',
    ]);
    // Nothing parsed out of the body: the index is exactly the kept rows plus JT's.
    expect(svc.totalSeries).toBe(3);
    await svc.shutdown();
  });

  it('deletes nothing when the harvest applies no rows, including OE rows with the opt-in off', async () => {
    const path = dbPath();
    await seed(path, [row('WPU0111', 'WP'), row('OEUN0000000000000000001', 'OE')], {
      ageHours: 1_000,
    });
    serve({});

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(svc.totalSeries).toBe(2);
    expect(svc.indexedSurveys).toEqual(['OE', 'WP']);
    await svc.shutdown();
  });
});

describe('configuration changes inside the TTL (#84)', () => {
  it('removes OE rows on the first harvest after the opt-in turns off', async () => {
    const path = dbPath();
    await seed(path, [row('OEUN0000000000000000001', 'OE'), row('JTS1', 'JT')], {
      list: catalogSurveyList(true),
    });
    const requested = serve({ 'jt.series': seriesFile(['JTS1']) });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(requested).toContain('jt.series');
    expect(requested).not.toContain('oe.series');
    expect(svc.indexedSurveys).toEqual(['JT']);
    expect(svc.totalSeries).toBe(1);
    await svc.shutdown();
  });

  it('re-harvests with OES when the opt-in turns on, then serves the result without fetching', async () => {
    const path = dbPath();
    await seed(path, [row('JTS1', 'JT')]);
    const requested = serve({
      'jt.series': seriesFile(['JTS1']),
      'oe.series': seriesFile(['OEUN0000000000000000001']),
    });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, true);
    await svc.load(1);
    expect(requested).toContain('oe.series');
    expect(svc.indexedSurveys).toEqual(['JT', 'OE']);
    await svc.shutdown();

    requested.length = 0;
    const next = new BlsCatalogService(BASE, 'ua/1.0', path, 168, true);
    await next.load(1);
    expect(requested).toEqual([]);
    expect(next.indexedSurveys).toEqual(['JT', 'OE']);
    await next.shutdown();
  });

  it('re-harvests a fresh index whose sync state carries no survey list', async () => {
    const path = dbPath();
    await seed(path, [row('JTS1', 'JT')], { list: undefined });
    const requested = serve({ 'jt.series': seriesFile(['JTS1', 'JTS2']) });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(requested).toContain('jt.series');
    expect(svc.totalSeries).toBe(2);
    await svc.shutdown();
  });

  it('keeps a fresh index with the configured survey list as it is', async () => {
    const path = dbPath();
    await seed(path, [row('JTS1', 'JT')]);
    const requested = serve({});

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    await svc.load(1);

    expect(requested).toEqual([]);
    expect(svc.totalSeries).toBe(1);
    await svc.shutdown();
  });
});

describe('bounded chunks (#84)', () => {
  const MANY = 12_001;
  const wpIds = Array.from({ length: MANY }, (_, i) => `WPU${String(i).padStart(6, '0')}`);

  it('deletes stale rows across several chunks, each transaction at most 5,000 rows', async () => {
    const path = dbPath();
    await seed(
      path,
      [...wpIds.map((id) => row(id, 'WP')), ...wpIds.map((id) => row(`OE${id}`, 'OE'))],
      { ageHours: 1_000 },
    );
    serve({ 'wp.series': seriesFile(['WPU000000']) });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    const applyBatch = vi.spyOn(storeOf(svc), 'applyBatch');
    await svc.load(1);

    const deletes = applyBatch.mock.calls.map(([, tombstones]) => tombstones.length);
    expect(deletes.filter((n) => n > 0).length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...deletes)).toBeLessThanOrEqual(5_000);
    expect(deletes.reduce((a, b) => a + b, 0)).toBe(2 * MANY - 1);
    expect(svc.totalSeries).toBe(1);
    expect(svc.indexedSurveys).toEqual(['WP']);
    await svc.shutdown();
  });

  it.each([
    ['upserts', () => ({ 'wp.series': seriesFile(wpIds) }), (records: number) => records > 0],
    [
      'deletes',
      () => ({ 'wp.series': seriesFile(['WPU000000']) }),
      (_: number, tombstones: number) => tombstones > 0,
    ],
  ])(
    'lets a search issued during multi-chunk %s finish before the last chunk',
    async (_, files, isChunk) => {
      const path = dbPath();
      await seed(path, [row('JTS1', 'JT'), ...wpIds.map((id) => row(id, 'WP'))], {
        ageHours: 1_000,
      });
      serve(files());

      const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
      const events: string[] = [];
      const store = storeOf(svc);
      const applyBatch = store.applyBatch.bind(store);
      vi.spyOn(store, 'applyBatch').mockImplementation(async (records, tombstones) => {
        if (isChunk(records.length, tombstones.length)) {
          if (!events.includes('chunk')) {
            setImmediate(() => {
              void svc
                .search({
                  query: 'JTS1',
                  survey: undefined,
                  area: undefined,
                  seasonal_adjustment: undefined,
                  limit: 5,
                })
                .then(() => events.push('search'));
            });
          }
          events.push('chunk');
        }
        await applyBatch(records, tombstones);
      });
      await svc.load(1);

      expect(events.filter((e) => e === 'chunk').length).toBeGreaterThanOrEqual(3);
      expect(events.indexOf('search')).toBeGreaterThan(0);
      expect(events.indexOf('search')).toBeLessThan(events.lastIndexOf('chunk'));
      await svc.shutdown();
    },
  );
});

describe('shutdown during a harvest (#84)', () => {
  it('stops the harvest: no write follows shutdown(), and load() does not report success', async () => {
    const path = dbPath();
    await seed(path, [row('JTS1', 'JT'), row('WPU0111', 'WP')], { ageHours: 1_000 });
    const completedBefore = await (async () => {
      const s = createCatalogStore(path);
      const state = await s.readState();
      await s.close();
      return state.completedAt;
    })();

    /** Hangs until the request's signal aborts, as a slow download would. */
    const hang = (init: RequestInit | undefined) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const requested = serve({
      'cu.series': seriesFile(['CUUR0000SA0']),
      'ln.series': hang,
      'la.series': hang,
      'pc.series': hang,
    });

    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    const store = storeOf(svc);
    const applyBatch = vi.spyOn(store, 'applyBatch');
    const writeState = vi.spyOn(store, 'writeState');
    const loading = svc.load(1);
    const settled = loading.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    await vi.waitFor(() => expect(requested).toContain('ln.series'));
    expect(applyBatch).toHaveBeenCalled(); // the first batch landed before shutdown
    const writesAtShutdown = applyBatch.mock.calls.length + writeState.mock.calls.length;

    const started = Date.now();
    await svc.shutdown();
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(await settled).toMatch(/shut ?down/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applyBatch.mock.calls.length + writeState.mock.calls.length).toBe(writesAtShutdown);

    const check = createCatalogStore(path);
    expect((await check.readState()).completedAt).toBe(completedBefore);
    await check.close();
  });
});
