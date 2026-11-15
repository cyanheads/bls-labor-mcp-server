/**
 * @fileoverview Tests for CanvasBridge: registration, the register_as schema,
 * drop/sweep failure handling, and the one shared canvas per tenant. Every
 * suite runs against the real DuckDB canvas, with faults injected into the
 * acquired instance or the registry.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../../fixtures/duckdb-canvas.js';

const ROWS = [{ series_id: 'LNS14000000', year: '2024', period: 'M12', value: '4.1' }];
const ROW_SCHEMA: ColumnSchema[] = ['series_id', 'year', 'period', 'value'].map((name) => ({
  name,
  type: 'VARCHAR',
  nullable: true,
}));

/** Alter each canvas instance the bridge acquires from the real `canvas`, before use. */
function alterAcquired(canvas: DataCanvas, alter: (instance: CanvasInstance) => void): DataCanvas {
  const acquireShared = canvas.acquireShared.bind(canvas);
  vi.spyOn(canvas, 'acquireShared').mockImplementation(async (ctx, options) => {
    const instance = await acquireShared(ctx, options);
    if (instance) alter(instance);
    return instance;
  });
  return canvas;
}

/** A real canvas, a tenant context, and teardown, for one suite. */
function useDuckdbCanvas(tenantId: string) {
  const env = {} as { canvas: DataCanvas; ctx: ReturnType<typeof createMockContext> };
  beforeEach(() => {
    env.canvas = createDuckdbCanvas();
    env.ctx = createMockContext({ tenantId });
  });
  afterEach(async () => {
    await env.canvas.shutdown(env.ctx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });
  return env;
}

describe('CanvasBridge.registerDataframe', () => {
  const env = useDuckdbCanvas('test-tenant');

  /** Register `ROWS` through a bridge whose acquired instance fails registerTable with `error`. */
  const registerFailingWith = (error: Error, appliedScope?: string) =>
    new CanvasBridge(
      alterAcquired(env.canvas, (instance) => {
        instance.registerTable = () => Promise.reject(error);
      }),
    )
      .registerDataframe(env.ctx, {
        rows: ROWS,
        schema: ROW_SCHEMA,
        sourceTool: 'bls_get_series',
        queryParams: {},
        ...(appliedScope && { appliedScope }),
      })
      .catch((e: unknown) => e);

  it('registers every supplied row and stores only complete-table metadata (#54)', async () => {
    const bridge = new CanvasBridge(env.canvas);

    const registered = await bridge.registerDataframe(env.ctx, {
      rows: ROWS,
      schema: ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: { series_ids: ['LNS14000000'] },
    });

    expect(registered).toMatchObject({ rowCount: ROWS.length });
    const { result } = await bridge.query(env.ctx, `SELECT * FROM ${registered.tableName}`);
    expect(result.rows).toEqual(ROWS);
    const stored = await env.ctx.state.get<Record<string, unknown>>(
      `df-meta/${registered.tableName}`,
    );
    expect(stored).toMatchObject({ rowCount: ROWS.length, sourceTool: 'bls_get_series' });
    expect(stored).not.toHaveProperty('truncated');
    expect(stored).not.toHaveProperty('maxRows');
  });

  it('stores register_as metadata without materialization-cap fields (#54)', async () => {
    const bridge = new CanvasBridge(env.canvas);
    const { tableName } = await bridge.registerDataframe(env.ctx, {
      rows: ROWS,
      schema: ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    });

    const { meta } = await bridge.query(env.ctx, `SELECT series_id FROM ${tableName}`, {
      registerAs: 'analysis_result',
    });

    expect(meta).toMatchObject({ rowCount: 1, tableName: 'analysis_result' });
    expect(meta).not.toHaveProperty('truncated');
    expect(meta).not.toHaveProperty('maxRows');
    const stored = await env.ctx.state.get<Record<string, unknown>>('df-meta/analysis_result');
    expect(stored).not.toHaveProperty('truncated');
    expect(stored).not.toHaveProperty('maxRows');
  });

  it('throws canvas_registration_failed instead of swallowing an internal error (#46)', async () => {
    const error = await registerFailingWith(new Error('DuckDB appender rollback'));

    expect(error).toMatchObject({
      data: { reason: 'canvas_registration_failed', sourceTool: 'bls_get_series', rowCount: 1 },
    });
  });

  it('carries the caller-supplied scope into the failure message (#79)', async () => {
    // The caller knows the window it applied; the bridge only knows the rows.
    const error = await registerFailingWith(
      new Error('DuckDB appender rollback'),
      'The applied window was 2000–2019, end_year resolved from start_year.',
    );

    expect((error as Error).message).toContain(
      'The applied window was 2000–2019, end_year resolved from start_year.',
    );
  });

  it('preserves the underlying error as the cause', async () => {
    const underlying = new Error('DuckDB appender rollback');

    const error = await registerFailingWith(underlying);

    expect((error as { cause?: unknown }).cause).toBe(underlying);
  });

  it('does not claim canvas is unconfigured — canvas is present, the call failed', async () => {
    // canvas_unavailable's recovery ("set CANVAS_PROVIDER_TYPE=duckdb") is wrong here.
    const error = await registerFailingWith(new Error('transient write failure'));

    const data = (error as { data?: Record<string, unknown> }).data;
    expect(data?.reason).toBe('canvas_registration_failed');
    expect((error as Error).message).not.toMatch(/CANVAS_PROVIDER_TYPE/);
  });
});

/** BLS-shaped spill rows with the keys and value kinds `bls_get_series` writes. */
function spillRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [seriesId, base] of [
    ['LNS14000000', 4.1],
    ['CUUR0000SA0', 300.1],
  ] as const) {
    for (let year = 2020; year <= 2024; year++) {
      for (let month = 1; month <= 13; month++) {
        const value = (base + month / 10).toFixed(1);
        rows.push({
          series_id: seriesId,
          year: String(year),
          period: `M${String(month).padStart(2, '0')}`,
          is_annual_average: month === 13,
          value,
          available: true,
          value_numeric: Number(value),
        });
      }
    }
  }
  return rows;
}

const SPILL_ROW_SCHEMA: ColumnSchema[] = [
  { name: 'series_id', type: 'VARCHAR', nullable: true },
  { name: 'year', type: 'VARCHAR', nullable: true },
  { name: 'period', type: 'VARCHAR', nullable: true },
  { name: 'is_annual_average', type: 'BOOLEAN', nullable: true },
  { name: 'value', type: 'VARCHAR', nullable: true },
  { name: 'available', type: 'BOOLEAN', nullable: true },
  { name: 'value_numeric', type: 'DOUBLE', nullable: true },
];

/** Push a stored dataframe's expiry into the past so the next op sweeps it. */
async function expire(ctx: ReturnType<typeof createMockContext>, tableName: string) {
  const key = `df-meta/${tableName}`;
  const meta = await ctx.state.get<Record<string, unknown>>(key);
  await ctx.state.set(key, { ...meta, expiresAt: '2000-01-01T00:00:00.000Z' });
}

const logCalls = (ctx: ReturnType<typeof createMockContext>) =>
  (ctx.log as MockContextLogger).calls;

describe('CanvasBridge against the DuckDB canvas', () => {
  let canvas: DataCanvas;
  let ctx: ReturnType<typeof createMockContext>;
  let bridge: CanvasBridge;

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    ctx = createMockContext({ tenantId: 'bridge-duckdb' });
    bridge = new CanvasBridge(canvas);
  });

  afterEach(async () => {
    await canvas.shutdown(ctx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  const register = () =>
    bridge.registerDataframe(ctx, {
      rows: spillRows(),
      schema: SPILL_ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    });

  const tablePresent = async (tableName: string) => {
    const instance = await canvas.acquire(
      (await ctx.state.get<string>('canvas-id')) ?? undefined,
      ctx as unknown as Parameters<DataCanvas['acquire']>[1],
    );
    return (await instance.describe({ tableName })).length === 1;
  };

  it('keeps a clashing registration intact and accepts a different name (#115)', async () => {
    await bridge.query(ctx, 'SELECT 1 AS value', { registerAs: 'unemp' });

    const clash = bridge.query(ctx, 'SELECT 2 AS value', { registerAs: 'unemp' });
    await expect(clash).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'register_as_clash', tableName: 'unemp' },
    });
    await expect(clash).rejects.toThrow('Choose a different register_as name.');
    expect((await bridge.query(ctx, 'SELECT value FROM unemp')).result.rows).toEqual([
      { value: 1 },
    ]);
    expect(
      (await bridge.query(ctx, 'SELECT 2 AS value', { registerAs: 'unemp2' })).result.rows,
    ).toEqual([{ value: 2 }]);
  });

  describe('drop and the TTL sweep, provider healthy', () => {
    it('drops an existing dataframe: table and metadata both go', async () => {
      const { tableName } = await register();

      await expect(bridge.drop(ctx, tableName)).resolves.toBe(true);

      expect(await ctx.state.get(`df-meta/${tableName}`)).toBeNull();
      expect(await tablePresent(tableName)).toBe(false);
    });

    it('reports dropped=false for a name with neither a table nor metadata', async () => {
      await register();
      await expect(bridge.drop(ctx, 'df_NOPE0_NOPE0')).resolves.toBe(false);
    });

    it('sweeps an expired dataframe: table dropped, metadata removed', async () => {
      const { tableName } = await register();
      await expire(ctx, tableName);

      await expect(bridge.describe(ctx)).resolves.toEqual([]);

      expect(await ctx.state.get(`df-meta/${tableName}`)).toBeNull();
      expect(await tablePresent(tableName)).toBe(false);
      expect(logCalls(ctx).some((c) => c.msg === 'Expired dataframe swept')).toBe(true);
    });
  });
});

describe('CanvasBridge.query without register_as', () => {
  const env = useDuckdbCanvas('test-tenant');

  it('stores no metadata and never describes the result', async () => {
    const describeTable = vi.fn();
    const bridge = new CanvasBridge(
      alterAcquired(env.canvas, (instance) => {
        instance.describe = describeTable;
      }),
    );

    const { meta, result } = await bridge.query(env.ctx, 'SELECT 1 AS n');

    expect(result.rows).toEqual([{ n: 1 }]);
    expect(meta).toBeUndefined();
    expect(describeTable).not.toHaveBeenCalled();
    expect(await env.ctx.state.list('df-meta/')).toMatchObject({ items: [] });
  });
});

describe('CanvasBridge register_as schema comes from the canvas (#71)', () => {
  let canvas: DataCanvas;
  let ctx: ReturnType<typeof createMockContext>;
  let bridge: CanvasBridge;
  let spill: string;

  beforeEach(async () => {
    canvas = createDuckdbCanvas();
    ctx = createMockContext({ tenantId: 'bridge-71' });
    bridge = new CanvasBridge(canvas);
    ({ tableName: spill } = await bridge.registerDataframe(ctx, {
      rows: spillRows(),
      schema: SPILL_ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    }));
  });

  afterEach(async () => {
    await canvas.shutdown(ctx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  const schemaOf = async (sql: string, registerAs: string) =>
    (await bridge.query(ctx, sql, { registerAs })).meta?.columnSchema;

  it('stores the typed schema for the issue repro, in projection order', async () => {
    const schema = await schemaOf(
      `SELECT series_id, COUNT(*) AS periods, AVG(value_numeric) AS avg_value FROM ${spill} WHERE available AND NOT is_annual_average GROUP BY series_id`,
      'review_numeric_summary',
    );

    expect(schema?.map(({ name, type, nullable }) => ({ name, type, nullable }))).toEqual([
      { name: 'series_id', type: 'VARCHAR', nullable: true },
      { name: 'periods', type: 'BIGINT', nullable: true },
      { name: 'avg_value', type: 'DOUBLE', nullable: true },
    ]);
    const stored = await ctx.state.get<{ columnSchema: unknown }>('df-meta/review_numeric_summary');
    expect(stored?.columnSchema).toEqual(schema);
  });

  it('reports the canvas type for aggregates, comparisons, dates, and casts', async () => {
    const schema = await schemaOf(
      `SELECT SUM(value_numeric) AS s, MIN(value_numeric) AS lo, MAX(value_numeric) AS hi,
              STDDEV(value_numeric) AS sd, MAX(value_numeric) > 5 AS above5,
              MIN(make_date(CAST(year AS INTEGER), 1, 1)) AS first_day,
              MIN(CAST(year AS INTEGER)) AS first_year
       FROM ${spill}`,
      'typed_projection',
    );

    expect(schema?.map((c) => [c.name, c.type])).toEqual([
      ['s', 'DOUBLE'],
      ['lo', 'DOUBLE'],
      ['hi', 'DOUBLE'],
      ['sd', 'DOUBLE'],
      ['above5', 'BOOLEAN'],
      ['first_day', 'DATE'],
      ['first_year', 'INTEGER'],
    ]);
  });

  it('types a register_as chained off another register_as table', async () => {
    await bridge.query(
      ctx,
      `SELECT series_id, COUNT(*) AS periods, AVG(value_numeric) AS avg_value FROM ${spill} GROUP BY series_id`,
      { registerAs: 'level_one' },
    );

    const schema = await schemaOf(
      'SELECT MAX(periods) AS most_periods, AVG(avg_value) AS mean_of_means, COUNT(*) > 1 AS several FROM level_one',
      'level_two',
    );

    expect(schema?.map((c) => [c.name, c.type])).toEqual([
      ['most_periods', 'BIGINT'],
      ['mean_of_means', 'DOUBLE'],
      ['several', 'BOOLEAN'],
    ]);
  });

  it('fails the call and stores no metadata when the schema cannot be read', async () => {
    const faulty = new CanvasBridge(
      alterAcquired(canvas, (instance) => {
        instance.describe = () => Promise.reject(new Error('injected describe fault'));
      }),
    );

    await expect(
      faulty.query(ctx, `SELECT series_id FROM ${spill}`, { registerAs: 'unreadable' }),
    ).rejects.toThrow('injected describe fault');
    expect(await ctx.state.get('df-meta/unreadable')).toBeNull();
  });
});

describe('CanvasBridge drop and sweep failures keep metadata (#74)', () => {
  let canvas: DataCanvas;
  let ctx: ReturnType<typeof createMockContext>;
  let tableName: string;

  const failingDrop = () => Promise.reject(new Error('injected provider fault: DROP TABLE failed'));

  beforeEach(async () => {
    canvas = createDuckdbCanvas();
    ctx = createMockContext({
      tenantId: 'bridge-74',
      errors: [
        {
          reason: 'canvas_drop_failed',
          code: JsonRpcErrorCode.ServiceUnavailable,
          when: 'test contract',
          recovery: 'Retry the drop shortly; the dataframe and its metadata were kept.',
        },
      ],
    });
    ({ tableName } = await new CanvasBridge(canvas).registerDataframe(ctx, {
      rows: spillRows(),
      schema: SPILL_ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    }));
  });

  afterEach(async () => {
    await canvas.shutdown(ctx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  const metaPresent = async () => (await ctx.state.get(`df-meta/${tableName}`)) !== null;
  /** Count the table's rows on the canvas directly — a bridge op would sweep it first. */
  const rowCount = async () => {
    const instance = await canvas.acquire(
      (await ctx.state.get<string>('canvas-id')) ?? undefined,
      ctx as unknown as Parameters<DataCanvas['acquire']>[1],
    );
    const result = await instance.query(`SELECT COUNT(*) AS n FROM ${tableName}`);
    return Number(result.rows[0]?.n);
  };

  it('throws canvas_drop_failed and keeps the dataframe when the provider drop rejects', async () => {
    let fault = true;
    const bridge = new CanvasBridge(
      alterAcquired(canvas, (instance) => {
        const drop = instance.drop.bind(instance);
        instance.drop = (name) => (fault ? failingDrop() : drop(name));
      }),
    );

    const error = await bridge.drop(ctx, tableName).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_drop_failed', tableName },
    });
    expect((error as { cause?: Error }).cause?.message).toBe(
      'injected provider fault: DROP TABLE failed',
    );
    expect(await metaPresent()).toBe(true);
    expect(await rowCount()).toBe(130);

    fault = false;
    await expect(bridge.drop(ctx, tableName)).resolves.toBe(true);
    expect(await metaPresent()).toBe(false);
    await expect(rowCount()).rejects.toMatchObject({ data: { reason: 'missing_table' } });
  });

  /** Fail the registry lookup of the stored canvas id; minting still works. */
  const failStoredAcquire = () => {
    const acquire = canvas.acquire.bind(canvas);
    return vi
      .spyOn(canvas, 'acquire')
      .mockImplementation((id, ...rest) =>
        id === undefined
          ? acquire(id, ...rest)
          : Promise.reject(new Error('injected acquire fault')),
      );
  };

  it('throws canvas_drop_failed and keeps the stored canvas and metadata when the canvas cannot be resolved', async () => {
    const canvasId = await ctx.state.get<string>('canvas-id');
    const spy = failStoredAcquire();

    const error = await new CanvasBridge(canvas).drop(ctx, tableName).catch((e: unknown) => e);

    expect(error).toMatchObject({ data: { reason: 'canvas_drop_failed', tableName } });
    expect((error as { cause?: Error }).cause?.message).toBe('injected acquire fault');
    spy.mockRestore();
    expect(await ctx.state.get('canvas-id')).toBe(canvasId);
    expect(await metaPresent()).toBe(true);
    expect(await rowCount()).toBe(130);
  });

  it('lets a cancellation during the drop propagate unchanged', async () => {
    const controller = new AbortController();
    const cancellable = createMockContext({ tenantId: 'bridge-74', signal: controller.signal });
    Object.assign(cancellable, { state: ctx.state });
    const cancelled = timeout('Request cancelled.', { reason: 'cancelled' });
    const bridge = new CanvasBridge(
      alterAcquired(canvas, (instance) => {
        instance.drop = () => {
          controller.abort();
          return Promise.reject(cancelled);
        };
      }),
    );

    await expect(bridge.drop(cancellable, tableName)).rejects.toBe(cancelled);
    expect(await metaPresent()).toBe(true);
  });

  it('keeps an expired entry whose drop rejects, and the triggering op still succeeds', async () => {
    await expire(ctx, tableName);
    const bridge = new CanvasBridge(
      alterAcquired(canvas, (instance) => {
        instance.drop = failingDrop;
      }),
    );

    const listed = await bridge.describe(ctx);

    expect(listed.map((m) => m.tableName)).toEqual([tableName]);
    expect(await metaPresent()).toBe(true);
    expect(logCalls(ctx).filter((c) => c.level === 'warning')).toHaveLength(1);
    expect(logCalls(ctx).some((c) => c.msg === 'Expired dataframe swept')).toBe(false);
    expect(await rowCount()).toBe(130);
  });

  it('keeps an expired entry when its canvas cannot be resolved, and the op fails with that error', async () => {
    await expire(ctx, tableName);
    const spy = failStoredAcquire();

    await expect(new CanvasBridge(canvas).describe(ctx)).rejects.toThrow('injected acquire fault');

    spy.mockRestore();
    expect(await metaPresent()).toBe(true);
    expect(logCalls(ctx).some((c) => c.msg === 'Expired dataframe swept')).toBe(false);
    expect(await rowCount()).toBe(130);
  });

  it('rejects a reserved-word name as input rather than as a provider failure', async () => {
    const error = await new CanvasBridge(canvas).drop(ctx, 'select').catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'identifier_reserved' },
    });
  });
});

describe('CanvasBridge refuses a register_as that names a DuckDB system catalog', () => {
  const env = useDuckdbCanvas('bridge-catalog');
  let bridge: CanvasBridge;
  let staged: string;

  beforeEach(async () => {
    bridge = new CanvasBridge(env.canvas);
    ({ tableName: staged } = await bridge.registerDataframe(env.ctx, {
      rows: ROWS,
      schema: ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    }));
  });

  /** Every table and view on the tenant's canvas, read on the canvas directly. */
  const canvasTables = async () => {
    const instance = await env.canvas.acquire(
      (await env.ctx.state.get<string>('canvas-id')) ?? undefined,
      env.ctx as unknown as Parameters<DataCanvas['acquire']>[1],
    );
    return (await instance.describe()).map((table) => table.name).sort();
  };

  it('refuses duckdb_columns before staging, and a later register_as on the canvas still works', async () => {
    await expect(
      bridge.query(env.ctx, `SELECT series_id FROM ${staged}`, { registerAs: 'duckdb_columns' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'register_as_system_catalog', registerAs: 'duckdb_columns' },
      literals: ['duckdb_columns'],
    });

    expect(await canvasTables()).toEqual([staged]);
    expect(await env.ctx.state.get('df-meta/duckdb_columns')).toBeNull();
    const { meta } = await bridge.query(env.ctx, `SELECT series_id FROM ${staged}`, {
      registerAs: 'after_refusal',
    });
    expect(meta?.columnSchema.map((column) => column.name)).toEqual(['series_id']);
    expect(
      (await bridge.query(env.ctx, 'SELECT series_id FROM after_refusal')).result.rows,
    ).toEqual([{ series_id: 'LNS14000000' }]);
  });

  it.each(['pg_tables', 'PG_TABLES', 'Sqlite_Master', 'duckdb_views', 'information_schema'])(
    'refuses %s and stages nothing under it',
    async (registerAs) => {
      await expect(bridge.query(env.ctx, 'SELECT 1 AS n', { registerAs })).rejects.toMatchObject({
        data: { reason: 'register_as_system_catalog', registerAs },
        literals: [registerAs],
      });
      expect(await canvasTables()).toEqual([staged]);
    },
  );

  it('runs a blank register_as, as form-style clients send for an empty field, as a plain query', async () => {
    const { result, meta } = await bridge.query(env.ctx, 'SELECT 1 AS n', { registerAs: '' });

    expect(result.rows).toEqual([{ n: 1 }]);
    expect(meta).toBeUndefined();
    expect(await canvasTables()).toEqual([staged]);
  });

  it('refuses a quoted system catalog name as an invalid identifier and stages nothing', async () => {
    await expect(
      bridge.query(env.ctx, 'SELECT 1 AS n', { registerAs: '"pg_tables"' }),
    ).rejects.toMatchObject({ data: { reason: SQL_GATE_REASONS.identifierShape } });
    expect(await canvasTables()).toEqual([staged]);
  });

  it.each(['pg_tables_2025', 'my_pg_class', 'duckdb_columns_copy'])(
    'registers the near-miss name %s',
    async (registerAs) => {
      const { meta } = await bridge.query(env.ctx, 'SELECT 1 AS n', { registerAs });

      expect(meta?.tableName).toBe(registerAs);
      expect((await bridge.query(env.ctx, `SELECT n FROM ${registerAs}`)).result.rows).toEqual([
        { n: 1 },
      ]);
    },
  );
});

/** Let every pending microtask run, so queued calls reach the point they wait at. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CanvasBridge keeps one shared canvas per tenant (#135)', () => {
  let canvas: DataCanvas;
  let ctx: ReturnType<typeof createMockContext>;
  let bridge: CanvasBridge;
  const reqCtx = () => ctx as unknown as Parameters<DataCanvas['acquire']>[1];

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    ctx = createMockContext({ tenantId: 'bridge-135' });
    bridge = new CanvasBridge(canvas);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await canvas.shutdown(reqCtx());
  });

  const register = (on: ReturnType<typeof createMockContext> = ctx) =>
    bridge.registerDataframe(on, {
      rows: spillRows(),
      schema: SPILL_ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: {},
    });
  const metaKeys = async () => (await ctx.state.list('df-meta/')).items.map((item) => item.key);
  const dropSharedCanvas = async () =>
    canvas.drop((await ctx.state.get<string>('canvas-id')) as string, reqCtx());
  const answers = async (tableName: string) =>
    (await bridge.query(ctx, `SELECT COUNT(*) AS n FROM ${tableName}`)).result.rows;

  it('stages five concurrent first registrations on one canvas, each answering a query', async () => {
    const registered = await Promise.all(Array.from({ length: 5 }, () => register()));

    expect(canvas.countForTenant(reqCtx())).toBe(1);
    const storedId = await ctx.state.get<string>('canvas-id');
    for (const { tableName } of registered) {
      // COUNT is BIGINT, which canvas rows carry as a JSON string.
      expect(await answers(tableName)).toEqual([{ n: '130' }]);
    }
    expect(await ctx.state.get('canvas-id')).toBe(storedId);
    expect((await metaKeys()).sort()).toEqual(
      registered.map(({ tableName }) => `df-meta/${tableName}`).sort(),
    );
  });

  it('resolves a canvas id stored as a bare string under canvas-id, as 0.7.1 stored it', async () => {
    const legacy = await canvas.acquire(undefined, reqCtx());
    await ctx.state.set('canvas-id', legacy.canvasId);

    const { tableName } = await register();

    expect(await ctx.state.get('canvas-id')).toBe(legacy.canvasId);
    expect(canvas.countForTenant(reqCtx())).toBe(1);
    expect(await legacy.describe({ tableName })).toHaveLength(1);
  });

  describe('once the shared canvas is gone', () => {
    it('describe lists nothing, purges the stale metadata, and mints no canvas', async () => {
      const { tableName } = await register();
      await register();
      await dropSharedCanvas();

      await expect(bridge.describe(ctx, tableName)).resolves.toEqual([]);
      await expect(bridge.describe(ctx)).resolves.toEqual([]);

      expect(await metaKeys()).toEqual([]);
      expect(await ctx.state.get('canvas-id')).toBeNull();
      expect(canvas.countForTenant(reqCtx())).toBe(0);
    });

    it('drop reports nothing dropped, purges the metadata, and mints no canvas', async () => {
      const { tableName } = await register();
      await dropSharedCanvas();

      await expect(bridge.drop(ctx, tableName)).resolves.toBe(false);

      expect(await metaKeys()).toEqual([]);
      expect(canvas.countForTenant(reqCtx())).toBe(0);
    });

    it('the TTL sweep checks the canvas without minting one', async () => {
      const { tableName } = await register();
      await expire(ctx, tableName);
      await dropSharedCanvas();

      await expect(bridge.describe(ctx)).resolves.toEqual([]);

      expect(canvas.countForTenant(reqCtx())).toBe(0);
      expect(await metaKeys()).toEqual([]);
    });

    it('the TTL sweep drops from the canvas describe resolved, minting none when it dies mid-call', async () => {
      const { tableName } = await register();
      await expire(ctx, tableName);
      const acquireShared = canvas.acquireShared.bind(canvas);
      // The canvas is live when describe resolves it and gone by the time the sweep runs.
      vi.spyOn(canvas, 'acquireShared').mockImplementationOnce(async (...args) => {
        const instance = await acquireShared(...args);
        await dropSharedCanvas();
        return instance;
      });

      await bridge.describe(ctx);

      expect(canvas.countForTenant(reqCtx())).toBe(0);
    });

    it('the next staging replaces it, and describe lists only the table a query reaches', async () => {
      const stale = await register();
      const deadId = await ctx.state.get<string>('canvas-id');
      await dropSharedCanvas();

      const fresh = await register();

      expect((await bridge.describe(ctx)).map((meta) => meta.tableName)).toEqual([fresh.tableName]);
      expect(await ctx.state.get(`df-meta/${stale.tableName}`)).toBeNull();
      expect(await ctx.state.get('canvas-id')).not.toBe(deadId);
      expect(await answers(fresh.tableName)).toEqual([{ n: '130' }]);
    });
  });

  it('propagates a stored-canvas failure other than canvas_not_found and keeps the id and metadata', async () => {
    const { tableName } = await register();
    const storedId = await ctx.state.get<string>('canvas-id');
    const registryFault = serviceUnavailable('injected registry fault');
    const acquire = canvas.acquire.bind(canvas);
    const spy = vi
      .spyOn(canvas, 'acquire')
      .mockImplementation((id, ...rest) =>
        id === undefined ? acquire(id, ...rest) : Promise.reject(registryFault),
      );

    await expect(bridge.describe(ctx)).rejects.toBe(registryFault);
    await expect(bridge.query(ctx, 'SELECT 1 AS n')).rejects.toBe(registryFault);
    await expect(register()).rejects.toMatchObject({
      data: { reason: 'canvas_registration_failed' },
      cause: registryFault,
    });

    spy.mockRestore();
    expect(await ctx.state.get('canvas-id')).toBe(storedId);
    expect(await metaKeys()).toEqual([`df-meta/${tableName}`]);
    expect(canvas.countForTenant(reqCtx())).toBe(1);
    expect(await answers(tableName)).toEqual([{ n: '130' }]);
  });

  it('fails a cancelled call queued behind the mint as cancelled, and the others get the canvas', async () => {
    const mint = Promise.withResolvers<void>();
    const acquire = canvas.acquire.bind(canvas);
    vi.spyOn(canvas, 'acquire').mockImplementation(async (id, ...rest) => {
      if (id === undefined) await mint.promise;
      return acquire(id, ...rest);
    });
    const controller = new AbortController();
    const cancellable = Object.assign(
      createMockContext({ tenantId: 'bridge-135', signal: controller.signal }),
      { state: ctx.state },
    );

    const first = register();
    const cancelled = register(cancellable);
    const last = register();
    await settle();
    const reason = timeout('Request cancelled.', { reason: 'cancelled' });
    controller.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    mint.resolve();
    const staged = await Promise.all([first, last]);

    expect(canvas.countForTenant(reqCtx())).toBe(1);
    for (const { tableName } of staged) {
      expect(await answers(tableName)).toEqual([{ n: '130' }]);
    }
    expect(await metaKeys()).toHaveLength(2);
  });
});
