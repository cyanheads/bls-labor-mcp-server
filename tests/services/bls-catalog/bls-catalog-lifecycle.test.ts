/**
 * @fileoverview Catalog index lifecycle (#84): stale-row removal after a
 * harvest, the persisted survey list that makes a configuration change
 * re-harvest inside the TTL, chunked deletes that leave searches unblocked, and
 * a shutdown that stops an in-flight harvest. The streamed `.series` read
 * (#126): rows written as the body arrives, a body past the string limit, the
 * stale-row listing kept in SQLite, a body cut short or failed mid-read, the
 * code tables checked before any row, the header and stall deadlines, and
 * each `.series` request opened only once the previous body is done with.
 * Every case runs the real `sqliteMirrorStore` on disk; LABSTAT files are
 * served per file name through a fetch mock, and any URL not served 404s.
 * @module tests/services/bls-catalog/bls-catalog-lifecycle.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorRow, MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlsCatalogService,
  catalogSurveyAbbrs,
  catalogSurveyList,
  createCatalogStore,
} from '@/services/bls-catalog/bls-catalog-service.js';
import { OE_TABLE_FILES } from './oews-fixtures.js';

const BASE = 'https://download.bls.gov/pub/time.series';
const HOUR = 3_600_000;

let tmpDir: string;
let dbCounter = 0;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bls-catalog-lifecycle-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.useRealTimers();
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

const DIMENSION_KEYS = [
  'area_code',
  'item_code',
  'group_code',
  'state_code',
  'dataelement_code',
  'industry_code',
  'sizeclass_code',
  'ratelevel_code',
  'occupation_code',
  'periodicity_code',
  'datatype_code',
];
const CODE_TABLE = `${DIMENSION_KEYS.join('\t')}\tlabel_text\n${DIMENSION_KEYS.map(() => 'x').join('\t')}\tDecoded label\n`;
const SERIES_HEADER = `series_id\tseasonal\tseries_title\t${DIMENSION_KEYS.join('\t')}\r\n`;

/** `.series` rows for `ids`, CRLF-terminated, titled `Series {id}` unless `title` names one. */
function seriesRows(ids: readonly string[], title?: string): string {
  return ids
    .map(
      (id) =>
        `${id}\tU\t${title ?? `Series ${id}`}\t${DIMENSION_KEYS.map(() => 'x').join('\t')}\r\n`,
    )
    .join('');
}

/** A `.series` file listing `ids`, with the upstream `series_title` column. */
function seriesFile(ids: readonly string[]): string {
  return `${SERIES_HEADER}${seriesRows(ids)}`;
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
    const abbr = file.split('.')[0];
    const body =
      files[file] ??
      (!file.endsWith('.series') && files[`${abbr}.series`] ? CODE_TABLE : undefined);
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
    // No delete and no fragment row: the index is exactly the kept rows plus JT's.
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

  it('re-harvests with OES when the opt-in turns on and retries the incomplete configured set', async () => {
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
    expect(requested).toContain('oe.series');
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

    // No survey is re-harvested; the OE code tables, which it does not hold, are requested.
    expect(requested.sort()).toEqual(['oe.area', 'oe.datatype', 'oe.occupation']);
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

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Hangs until the request's signal aborts, as a slow download would. */
function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

describe('shutdown during a harvest (#84)', () => {
  it('stops the harvest: no write follows shutdown(), and load() does not report success', async () => {
    /**
     * Fake timers the test never advances: no request deadline can fire, so
     * shutdown() can settle only by aborting the hung downloads.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const path = dbPath();
    await seed(path, [row('JTS1', 'JT'), row('WPU0111', 'WP')], { ageHours: 1_000 });
    const completedBefore = await (async () => {
      const s = createCatalogStore(path);
      const state = await s.readState();
      await s.close();
      return state.completedAt;
    })();

    const lnRequested = deferred();
    serve({
      'cu.series': seriesFile(['CUUR0000SA0']),
      'ln.series': (init) => {
        lnRequested.resolve();
        return hang(init);
      },
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

    await lnRequested.promise;
    expect(applyBatch).toHaveBeenCalled(); // the first batch landed before shutdown
    const writesAtShutdown = applyBatch.mock.calls.length + writeState.mock.calls.length;

    await svc.shutdown();
    expect(await settled).toMatch(/shut ?down/i);
    // shutdown() waits the harvest out; one more event-loop turn lets any stray continuation run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(applyBatch.mock.calls.length + writeState.mock.calls.length).toBe(writesAtShutdown);
    expect(vi.getTimerCount()).toBe(0); // no request deadline is left armed

    const check = createCatalogStore(path);
    expect((await check.readState()).completedAt).toBe(completedBefore);
    await check.close();
  });
});

describe('streamed .series reads (#126)', () => {
  const wpIds = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `WPU${String(from + i).padStart(6, '0')}`);

  /** Every stderr line the service wrote, in order. */
  const stderrLines = () =>
    vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk));

  /**
   * A response body handed out one chunk per read — `highWaterMark: 0`, so no
   * chunk is pulled ahead of the reader. `onPull(i)` runs as chunk `i` is
   * pulled and lands `delayMs` later, when set; past the last chunk the body
   * ends, errors with `end`, or with `'stall'` waits until the request aborts.
   * Aborting the request errors it, as it does under Node and Bun.
   */
  function chunked(
    chunks: Iterable<string | Uint8Array<ArrayBuffer>>,
    init: RequestInit | undefined,
    opts: {
      delayMs?: number;
      end?: Error | 'stall';
      onPull?: (i: number) => void;
      onCancel?: () => void;
    } = {},
  ): Response {
    let pulls = 0;
    const pending = chunks[Symbol.iterator]();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
        pull(controller): Promise<void> | undefined {
          opts.onPull?.(pulls++);
          const next = pending.next();
          if (!next.done) {
            const chunk = next.value;
            const enqueue = () =>
              controller.enqueue(
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
              );
            if (opts.delayMs === undefined) {
              enqueue();
              return;
            }
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                enqueue();
                resolve();
              }, opts.delayMs);
            });
          }
          if (opts.end === 'stall') return new Promise<void>(() => {});
          if (opts.end) controller.error(opts.end);
          else controller.close();
          return;
        },
        ...(opts.onCancel && { cancel: opts.onCancel }),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: 200 });
  }

  it('writes rows while the body streams: the first chunk’s rows land before the last chunk is read', async () => {
    const first = wpIds(5_000);
    let writtenAtLastPull: number | undefined;
    serve({
      'wp.series': (init) =>
        Promise.resolve(
          chunked([`${SERIES_HEADER}${seriesRows(first)}`, seriesRows(['WPU999999'])], init, {
            onPull: (i) => {
              if (i === 1) writtenAtLastPull = written();
            },
          }),
        ),
    });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    const applyBatch = vi.spyOn(storeOf(svc), 'applyBatch');
    const written = () => applyBatch.mock.calls.reduce((n, [records]) => n + records.length, 0);

    await svc.load(1);
    expect(writtenAtLastPull).toBe(5_000);
    expect(svc.totalSeries).toBe(5_001);
    expect(await ids(svc, ['WPU000000', 'WPU004999', 'WPU999999'])).toEqual([
      'WPU000000',
      'WPU004999',
      'WPU999999',
    ]);
    await svc.shutdown();
  });

  it('indexes a .series body larger than the longest string Node can hold', async () => {
    // Each row is padded past 1 MiB with trailing spaces, which field trimming drops.
    const MAX_NODE_STRING = 536_870_888;
    const rowCount = 513;
    const ids = wpIds(rowCount);
    const padding = new Uint8Array(1 << 20).fill(0x20);
    let served = 0;
    /** One line per chunk, built as it is pulled, so the test never holds the body either. */
    function* lines(): Generator<Uint8Array<ArrayBuffer>> {
      const header = new TextEncoder().encode(SERIES_HEADER);
      served += header.length;
      yield header;
      for (const id of ids) {
        const text = new TextEncoder().encode(seriesRows([id]).slice(0, -2)); // without its CRLF
        const line = new Uint8Array(text.length + padding.length + 2);
        line.set(text);
        line.set(padding, text.length);
        line.set([0x0d, 0x0a], text.length + padding.length);
        served += line.length;
        yield line;
      }
    }
    serve({ 'wp.series': (init) => Promise.resolve(chunked(lines(), init)) });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    await svc.load(1);

    expect(served).toBeGreaterThan(MAX_NODE_STRING);
    expect(svc.totalSeries).toBe(rowCount);
    const rows = await svc.lookupByIds([ids[0] ?? '', ids.at(-1) ?? '']);
    expect([...rows.values()].map((s) => s.title)).toEqual([
      `Series ${ids[0]}`,
      `Series ${ids.at(-1)}`,
    ]);
    await svc.shutdown();
  }, 60_000);

  it('keeps the listed SeriesIDs in a TEMP table filled with each upsert chunk, and drops it after the stale-row pass', async () => {
    const path = dbPath();
    const listedIds = wpIds(12_001);
    const seeded = [row('WPUSTALE', 'WP'), ...listedIds.slice(0, 10).map((id) => row(id, 'WP'))];
    await seed(path, seeded, { ageHours: 1_000 });
    serve({ 'wp.series': seriesFile(listedIds) });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    const store = storeOf(svc);
    const applyBatch = store.applyBatch.bind(store);
    const tempTables = async () =>
      (await store.raw())
        .prepare<{ name: string }>(`SELECT name FROM sqlite_temp_master WHERE type = 'table'`)
        .all()
        .map((t) => t.name);
    const listedAtUpsert: number[] = [];
    vi.spyOn(store, 'applyBatch').mockImplementation(async (records, tombstones) => {
      if (records.length > 0) {
        const [table, ...others] = await tempTables();
        expect(others).toEqual([]);
        const count = (await store.raw())
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM temp.${table}`)
          .get();
        listedAtUpsert.push(count?.n ?? -1);
      }
      await applyBatch(records, tombstones);
    });

    await svc.load(1);
    expect(listedAtUpsert).toEqual([5_000, 10_000, 12_001]);
    expect(await tempTables()).toEqual([]);
    expect(await ids(svc, ['WPUSTALE', 'WPU000000', 'WPU012000'])).toEqual([
      'WPU000000',
      'WPU012000',
    ]);
    expect(svc.totalSeries).toBe(12_001);
    await svc.shutdown();
  });

  it.each([
    [
      'ends mid-line',
      (init: RequestInit | undefined) =>
        chunked([`${SERIES_HEADER}${seriesRows(['WPU0111', 'WPU0999'])}WPU09`], init),
      '[bls-labor-mcp-server] Catalog: wp.series ends mid-line — a truncated download; rows from its complete lines are written, and none of its indexed rows are removed.\n',
    ],
    [
      'errors mid-read',
      (init: RequestInit | undefined) =>
        chunked([`${SERIES_HEADER}${seriesRows(['WPU0111', 'WPU0999'])}WPU09`], init, {
          end: new Error('connection reset'),
        }),
      '[bls-labor-mcp-server] Catalog: wp.series unavailable (body read failed: connection reset) — its indexed rows are kept; next retry at the next hourly check.\n',
    ],
  ])(
    'a body that %s writes its complete lines, never its last one, deletes nothing, and is retried at the next check',
    async (_, wpSeries, line) => {
      const path = dbPath();
      await seed(path, [row('WPU0111', 'WP'), row('WPU12410301', 'WP')], { ageHours: 1_000 });
      const requested = serve({
        'wp.series': (init) => Promise.resolve(wpSeries(init)),
        'jt.series': seriesFile(['JTS1']),
      });
      const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
      await svc.load(1);

      expect(await ids(svc, ['WPU0111', 'WPU0999', 'WPU09', 'WPU12410301'])).toEqual([
        'WPU0111',
        'WPU0999',
        'WPU12410301',
      ]);
      expect(stderrLines()).toContain(line);

      requested.length = 0;
      await svc.load(1); // the next check: WP retries with the failed surveys; JT is current
      expect(requested).toContain('wp.series');
      expect(requested).not.toContain('jt.series');
      await svc.shutdown();
    },
  );

  it.each([
    [
      'ends mid-line',
      (init: RequestInit | undefined) =>
        chunked([`${SERIES_HEADER}${seriesRows(['OEUN0000000000000000001'])}OEUN0`], init),
    ],
    [
      'errors mid-read',
      (init: RequestInit | undefined) =>
        chunked([`${SERIES_HEADER}${seriesRows(['OEUN0000000000000000001'])}OEUN0`], init, {
          end: new Error('connection reset'),
        }),
    ],
  ])(
    'a survey with no indexed rows keeps none from a body that %s, so OE search stays composed',
    async (_, oeSeries) => {
      const path = dbPath();
      // An index without OE rows, then the opt-in turns on: OE is harvested for the first time.
      await seed(path, [row('WPU0111', 'WP')], { ageHours: 1_000 });
      serve({
        ...OE_TABLE_FILES,
        'oe.series': (init) => Promise.resolve(oeSeries(init)),
        'wp.series': seriesFile(['WPU0111']),
      });
      const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, true);
      await svc.load(1);

      expect(await ids(svc, ['OEUN0000000000000000001', 'WPU0111'])).toEqual(['WPU0111']);
      expect(svc.searchCoverage('oe')).toEqual({ searchCoverage: 'composed' });
      expect(svc.totalSeries).toBe(1);
      await svc.shutdown();
    },
  );

  it.each([
    [
      'a header without series_id',
      { 'wp.item': CODE_TABLE },
      '[bls-labor-mcp-server] Catalog: wp.series has no series_id header column — its indexed rows are kept.\n',
      `seasonal\tseries_title\t${DIMENSION_KEYS.join('\t')}\r\n`,
    ],
    [
      'a declared code table that fails',
      { 'wp.item': () => Promise.resolve(new Response('', { status: 404 })) },
      '[bls-labor-mcp-server] Catalog: wp.item unavailable (HTTP 404) — its indexed rows are kept.\n',
      SERIES_HEADER,
    ],
    [
      'a declared code table without its label column',
      { 'wp.item': `${DIMENSION_KEYS.join('\t')}\nx\n` },
      '[bls-labor-mcp-server] Catalog: wp.item header lacks group_code + item_code or a *_text/*_name label, or has no usable rows.\n',
      SERIES_HEADER,
    ],
  ])('writes no row for %s and stops reading at the header', async (_, files, line, header) => {
    const path = dbPath();
    await seed(path, [row('WPU0111', 'WP')], { ageHours: 1_000 });
    let pulls = 0;
    const cancelled = deferred();
    serve({
      ...files,
      'wp.series': (init) =>
        Promise.resolve(
          chunked([header, seriesRows(wpIds(10)), seriesRows(wpIds(10, 10))], init, {
            onPull: () => pulls++,
            onCancel: cancelled.resolve,
          }),
        ),
    });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
    const applyBatch = vi.spyOn(storeOf(svc), 'applyBatch');
    await svc.load(1);

    expect(applyBatch.mock.calls.flatMap(([records]) => records)).toEqual([]);
    expect(stderrLines()).toContain(line);
    await cancelled.promise;
    expect(pulls).toBe(1);
    expect(await ids(svc, ['WPU0111', 'WPU000000'])).toEqual(['WPU0111']);
    await svc.shutdown();
  });

  it('reads the declared code tables before the .series body', async () => {
    const events: string[] = [];
    serve({
      'wp.item': (init) =>
        Promise.resolve(chunked([CODE_TABLE], init, { onPull: () => events.push('wp.item') })),
      'wp.series': (init) =>
        Promise.resolve(
          chunked([seriesFile(['WPU0111'])], init, { onPull: () => events.push('wp.series') }),
        ),
    });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    await svc.load(1);

    expect(events[0]).toBe('wp.item');
    expect(events).toContain('wp.series');
    expect(await ids(svc, ['WPU0111'])).toEqual(['WPU0111']);
    await svc.shutdown();
  });

  it('parses CRLF endings and multi-byte titles split at every byte as from one string', async () => {
    const title = 'Índice — año 2026';
    const text = `${SERIES_HEADER}${seriesRows(['WPU0111', 'WPU0112'], title)}`;
    const perByte = Array.from(new TextEncoder().encode(text), (b) => Uint8Array.of(b));
    serve({ 'wp.series': (init) => Promise.resolve(chunked(perByte, init)) });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    await svc.load(1);

    const rows = await svc.lookupByIds(['WPU0111', 'WPU0112']);
    expect([...rows.values()].map((s) => [s.seriesId, s.title])).toEqual([
      ['WPU0111', title],
      ['WPU0112', title],
    ]);
    await svc.shutdown();
  });

  describe('deadlines', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('indexes a body that keeps arriving long past 30 s, each chunk inside the stall deadline', async () => {
      const chunks = [SERIES_HEADER, ...wpIds(5).map((id) => seriesRows([id]))];
      const firstPull = deferred();
      serve({
        // Each chunk lands 20 s after the read that asked for it: 120 s in all.
        'wp.series': (init) =>
          Promise.resolve(
            chunked(chunks, init, { delayMs: 20_000, onPull: () => firstPull.resolve() }),
          ),
      });
      const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
      const loading = svc.load(1);
      await firstPull.promise;
      for (let step = 0; step < chunks.length; step++) await vi.advanceTimersByTimeAsync(20_000);
      await loading;

      expect(svc.totalSeries).toBe(5);
      expect(stderrLines().some((l) => l.includes('wp.series unavailable'))).toBe(false);
      await svc.shutdown();
    });

    it('fails a body that stalls past the chunk deadline as a body read, keeping the rows it delivered', async () => {
      const path = dbPath();
      await seed(path, [row('WPU0111', 'WP')], { ageHours: 1_000 });
      const stalled = deferred();
      serve({
        'wp.series': (init) =>
          Promise.resolve(
            chunked([`${SERIES_HEADER}${seriesRows(['WPU0999'])}`], init, {
              end: 'stall',
              onPull: (i) => {
                if (i === 1) stalled.resolve();
              },
            }),
          ),
      });
      const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
      const loading = svc.load(1);
      await stalled.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      await loading;

      expect(stderrLines()).toContain(
        '[bls-labor-mcp-server] Catalog: wp.series unavailable (body read failed: No data for 60000 ms) — its indexed rows are kept; next retry at the next hourly check.\n',
      );
      expect(await ids(svc, ['WPU0111', 'WPU0999'])).toEqual(['WPU0111', 'WPU0999']);
      await svc.shutdown();
    });

    it('fails a .series request whose headers never arrive at the header deadline', async () => {
      const path = dbPath();
      await seed(path, [row('WPU0111', 'WP')], { ageHours: 1_000 });
      const requested = deferred();
      serve({
        'wp.series': (init) => {
          requested.resolve();
          return hang(init);
        },
      });
      const svc = new BlsCatalogService(BASE, 'ua/1.0', path, 168, false);
      const loading = svc.load(1);
      await requested.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await loading;

      expect(stderrLines()).toContain(
        '[bls-labor-mcp-server] Catalog: wp.series unavailable (request failed: No response within 30000 ms) — its indexed rows are kept; next retry at the next hourly check.\n',
      );
      expect(await ids(svc, ['WPU0111'])).toEqual(['WPU0111']);
      await svc.shutdown();
    });
  });
});

describe('.series requests opened one at a time (#126)', () => {
  /** A response the fake handed out, and how its body ended: read to its end, cancelled, or neither. */
  interface Handed {
    cancelled: boolean;
    ended: boolean;
    file: string;
  }

  const cuIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `CUUR${String(i).padStart(6, '0')}`);

  /**
   * Serve `files` by file name, and every code table of a served survey as
   * `CODE_TABLE`; every other URL 404s. Each body is handed out 16 KiB per read
   * (`highWaterMark: 0`, so nothing is pulled ahead of the reader) and ignores
   * the request's abort, so only the harvest itself can end it. `overlaps`
   * records each `.series` request that arrived while an earlier `.series`
   * body was neither read to its end nor cancelled.
   */
  function serveTracked(files: Record<string, string>): { handed: Handed[]; overlaps: string[] } {
    const handed: Handed[] = [];
    const overlaps: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      const u = String(url);
      const file = u.slice(u.lastIndexOf('/') + 1);
      const abbr = file.split('.')[0];
      if (file.endsWith('.series')) {
        const open = handed.filter((h) => h.file.endsWith('.series') && !h.ended && !h.cancelled);
        if (open.length > 0) overlaps.push(`${file} while ${open.map((h) => h.file).join(', ')}`);
      }
      const text =
        files[file] ??
        (!file.endsWith('.series') && files[`${abbr}.series`] !== undefined
          ? CODE_TABLE
          : undefined);
      const record: Handed = { file, ended: false, cancelled: false };
      handed.push(record);
      const bytes = new TextEncoder().encode(text ?? '');
      let offset = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= bytes.length) {
              record.ended = true;
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(offset, offset + 16_384));
            offset += 16_384;
          },
          cancel() {
            record.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return Promise.resolve(new Response(body, { status: text === undefined ? 404 : 200 }));
    });
    return { handed, overlaps };
  }

  const unsettled = (handed: Handed[]) =>
    handed.filter((h) => !h.ended && !h.cancelled).map((h) => h.file);
  const seriesRequests = (handed: Handed[]) =>
    handed.filter((h) => h.file.endsWith('.series')).map((h) => h.file);

  it('requests each survey’s .series only once the previous survey’s body was read or cancelled', async () => {
    const { handed, overlaps } = serveTracked({
      'cu.series': seriesFile(cuIds(2_000)), // read across several reads
      'ce.series': '<html>\r\n<body>maintenance</body>\r\n</html>\r\n', // refused at its header
      'la.series': seriesFile(['LAUST530000000000003']), // the next batch
      'wp.series': seriesFile(['WPU0111']),
    });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    await svc.load(1);

    expect(overlaps).toEqual([]);
    expect(seriesRequests(handed)).toEqual(catalogSurveyAbbrs(false).map((a) => `${a}.series`));
    expect(unsettled(handed)).toEqual([]);
    const indexed = ['CUUR000000', 'CUUR001999', 'LAUST530000000000003', 'WPU0111'];
    expect(await ids(svc, indexed)).toEqual(indexed);
    await svc.shutdown();
  });

  it.each([
    ['shutdown() stops the harvest', 'stop'],
    ['a write fails', 'fail'],
  ] as const)('leaves no response unread and uncancelled when %s mid-batch', async (_, mode) => {
    const { handed } = serveTracked({
      'cu.series': seriesFile(cuIds(5_001)), // its first chunk of rows is written mid-body
      'ap.series': seriesFile(['APU0000701111']), // the same batch
    });
    const svc = new BlsCatalogService(BASE, 'ua/1.0', dbPath(), 168, false);
    const store = storeOf(svc);
    const applyBatch = store.applyBatch.bind(store);
    let tripped = false;
    let stopping: Promise<void> | undefined;
    vi.spyOn(store, 'applyBatch').mockImplementation(async (records, tombstones) => {
      if (records.length > 0 && !tripped) {
        tripped = true;
        if (mode === 'fail') throw new Error('disk I/O error');
        await applyBatch(records, tombstones);
        stopping = svc.shutdown();
        return;
      }
      await applyBatch(records, tombstones);
    });
    const settled = await svc.load(1).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    // The store failed, not the survey: the load rejects naming it, as #112 reports it.
    expect(settled).toMatch(mode === 'stop' ? /stopped by shutdown/ : /disk I\/O error/);
    await (stopping ?? svc.shutdown());
    expect(unsettled(handed)).toEqual([]);
    expect(seriesRequests(handed)).toEqual(['cu.series']);
  });
});
