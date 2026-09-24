/**
 * @fileoverview Tests for CanvasBridge: registration failures, the register_as
 * schema, and drop/sweep failure handling. Schema and drop behavior run against
 * the real DuckDB canvas, with faults injected into the acquired instance.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { CanvasInstance, ColumnSchema, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
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

/** Minimal DataCanvas fake whose acquired instance fails on registerTable. */
function canvasFailingWith(error: Error): DataCanvas {
  return {
    acquire: vi.fn().mockResolvedValue({
      canvasId: 'canvas-1',
      registerTable: vi.fn().mockRejectedValue(error),
      query: vi.fn(),
      drop: vi.fn(),
    }),
  } as unknown as DataCanvas;
}

/** Minimal DataCanvas fake that captures every row passed to registerTable. */
function successfulCanvas(registerTable: ReturnType<typeof vi.fn>): DataCanvas {
  return {
    acquire: vi.fn().mockResolvedValue({
      canvasId: 'canvas-1',
      registerTable,
      query: vi.fn(),
      drop: vi.fn(),
    }),
  } as unknown as DataCanvas;
}

describe('CanvasBridge.registerDataframe', () => {
  it('registers every supplied row and stores only complete-table metadata (#54)', async () => {
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'df_AAAAA_BBBBB',
      rowCount: ROWS.length,
    });
    const bridge = new CanvasBridge(successfulCanvas(registerTable));
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const registered = await bridge.registerDataframe(ctx, {
      rows: ROWS,
      schema: ROW_SCHEMA,
      sourceTool: 'bls_get_series',
      queryParams: { series_ids: ['LNS14000000'] },
    });

    expect(registerTable).toHaveBeenCalledWith(
      expect.any(String),
      ROWS,
      expect.objectContaining({ schema: expect.any(Array) }),
    );
    expect(registered).toMatchObject({ rowCount: ROWS.length, tableName: 'df_AAAAA_BBBBB' });
    const stored = await ctx.state.get<Record<string, unknown>>('df-meta/df_AAAAA_BBBBB');
    expect(stored).toMatchObject({ rowCount: ROWS.length, sourceTool: 'bls_get_series' });
    expect(stored).not.toHaveProperty('truncated');
    expect(stored).not.toHaveProperty('maxRows');
  });

  it('stores register_as metadata without materialization-cap fields (#54)', async () => {
    const query = vi.fn().mockResolvedValue({
      columns: ['series_id'],
      rowCount: 1,
      rows: [{ series_id: 'LNS14000000' }],
      tableName: 'analysis_result',
    });
    const canvas = {
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'canvas-1',
        query,
        describe: vi.fn().mockResolvedValue([
          {
            name: 'analysis_result',
            kind: 'table',
            rowCount: 1,
            columns: [{ name: 'series_id', type: 'VARCHAR', nullable: true }],
          },
        ]),
        drop: vi.fn(),
      }),
    } as unknown as DataCanvas;
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await bridge.query(ctx, 'SELECT series_id FROM df_AAAAA_BBBBB', {
      registerAs: 'analysis_result',
    });

    expect(meta).toMatchObject({ rowCount: 1, tableName: 'analysis_result' });
    expect(meta).not.toHaveProperty('truncated');
    expect(meta).not.toHaveProperty('maxRows');
    const stored = await ctx.state.get<Record<string, unknown>>('df-meta/analysis_result');
    expect(stored).not.toHaveProperty('truncated');
    expect(stored).not.toHaveProperty('maxRows');
  });

  it('throws canvas_registration_failed instead of swallowing an internal error (#46)', async () => {
    const bridge = new CanvasBridge(canvasFailingWith(new Error('DuckDB appender rollback')));
    // tenantId enables ctx.state, so the failure under test is registerTable's
    // rather than a state error thrown before the provider is ever reached.
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await bridge
      .registerDataframe(ctx, {
        rows: ROWS,
        schema: ROW_SCHEMA,
        sourceTool: 'bls_get_series',
        queryParams: {},
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      data: { reason: 'canvas_registration_failed', sourceTool: 'bls_get_series', rowCount: 1 },
    });
  });

  it('carries the caller-supplied scope into the failure message (#79)', async () => {
    // The caller knows the window it applied; the bridge only knows the rows.
    const bridge = new CanvasBridge(canvasFailingWith(new Error('DuckDB appender rollback')));
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await bridge
      .registerDataframe(ctx, {
        rows: ROWS,
        schema: ROW_SCHEMA,
        sourceTool: 'bls_get_series',
        queryParams: {},
        appliedScope: 'The applied window was 2000–2019, end_year resolved from start_year.',
      })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain(
      'The applied window was 2000–2019, end_year resolved from start_year.',
    );
  });

  it('preserves the underlying error as the cause', async () => {
    const underlying = new Error('DuckDB appender rollback');
    const bridge = new CanvasBridge(canvasFailingWith(underlying));
    // tenantId enables ctx.state, so the failure under test is registerTable's
    // rather than a state error thrown before the provider is ever reached.
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await bridge
      .registerDataframe(ctx, {
        rows: ROWS,
        schema: ROW_SCHEMA,
        sourceTool: 'bls_get_series',
        queryParams: {},
      })
      .catch((e: unknown) => e);

    expect((error as { cause?: unknown }).cause).toBe(underlying);
  });

  it('does not claim canvas is unconfigured — canvas is present, the call failed', async () => {
    // canvas_unavailable's recovery ("set CANVAS_PROVIDER_TYPE=duckdb") is wrong here.
    const bridge = new CanvasBridge(canvasFailingWith(new Error('transient write failure')));
    // tenantId enables ctx.state, so the failure under test is registerTable's
    // rather than a state error thrown before the provider is ever reached.
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await bridge
      .registerDataframe(ctx, {
        rows: ROWS,
        schema: ROW_SCHEMA,
        sourceTool: 'bls_get_series',
        queryParams: {},
      })
      .catch((e: unknown) => e);

    const data = (error as { data?: Record<string, unknown> }).data;
    expect(data?.reason).not.toBe('canvas_unavailable');
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

/** Wrap a real canvas so each acquired instance can be altered before use. */
function wrapAcquire(canvas: DataCanvas, alter: (instance: CanvasInstance) => void): DataCanvas {
  return {
    acquire: async (...args: Parameters<DataCanvas['acquire']>) => {
      const instance = await canvas.acquire(...args);
      alter(instance);
      return instance;
    },
  } as unknown as DataCanvas;
}

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

    it('removes metadata and reports dropped when its canvas already expired', async () => {
      const { tableName } = await register();
      const canvasId = await ctx.state.get<string>('canvas-id');
      await canvas.drop(canvasId!, ctx as unknown as Parameters<DataCanvas['drop']>[1]);

      await expect(bridge.drop(ctx, tableName)).resolves.toBe(true);
      expect(await ctx.state.get(`df-meta/${tableName}`)).toBeNull();
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
  it('stores no metadata and never describes the result', async () => {
    const describeTable = vi.fn();
    const canvas = {
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'canvas-1',
        query: vi.fn().mockResolvedValue({ columns: ['n'], rowCount: 1, rows: [{ n: 1 }] }),
        describe: describeTable,
        drop: vi.fn(),
      }),
    } as unknown as DataCanvas;
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await new CanvasBridge(canvas).query(ctx, 'SELECT 1 AS n');

    expect(meta).toBeUndefined();
    expect(describeTable).not.toHaveBeenCalled();
    expect(await ctx.state.list('df-meta/')).toMatchObject({ items: [] });
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

    expect(schema).toEqual([
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
      wrapAcquire(canvas, (instance) => {
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
      wrapAcquire(canvas, (instance) => {
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

  it('throws canvas_drop_failed and keeps metadata when the canvas cannot be acquired', async () => {
    const unreachable = {
      acquire: () => Promise.reject(new Error('injected acquire fault')),
    } as unknown as DataCanvas;

    await expect(new CanvasBridge(unreachable).drop(ctx, tableName)).rejects.toMatchObject({
      data: { reason: 'canvas_drop_failed', tableName },
    });
    expect(await metaPresent()).toBe(true);
  });

  it('keeps the stored canvas when acquiring it fails for a reason other than not-found', async () => {
    const canvasId = await ctx.state.get<string>('canvas-id');
    const flaky = {
      acquire: (id: string | undefined, reqCtx: Parameters<DataCanvas['acquire']>[1]) =>
        id === undefined
          ? canvas.acquire(id, reqCtx)
          : Promise.reject(new Error('injected acquire fault')),
    } as unknown as DataCanvas;

    await expect(new CanvasBridge(flaky).drop(ctx, tableName)).rejects.toMatchObject({
      data: { reason: 'canvas_drop_failed' },
    });
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
      wrapAcquire(canvas, (instance) => {
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
      wrapAcquire(canvas, (instance) => {
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

  it('keeps an expired entry when the canvas is unavailable, and the triggering op still succeeds', async () => {
    await expire(ctx, tableName);
    const unreachable = {
      acquire: () => Promise.reject(new Error('injected acquire fault')),
    } as unknown as DataCanvas;

    const listed = await new CanvasBridge(unreachable).describe(ctx);

    expect(listed.map((m) => m.tableName)).toEqual([tableName]);
    expect(await metaPresent()).toBe(true);
    expect(logCalls(ctx).filter((c) => c.level === 'warning')).toHaveLength(1);
    expect(logCalls(ctx).some((c) => c.msg === 'Expired dataframe swept')).toBe(false);
  });

  it('rejects a reserved-word name as input rather than as a provider failure', async () => {
    const error = await new CanvasBridge(canvas).drop(ctx, 'select').catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'identifier_reserved' },
    });
  });
});
