/**
 * @fileoverview Tests for CanvasBridge registration failure handling.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { CanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const ROWS = [{ series_id: 'LNS14000000', year: '2024', period: 'M12', value: '4.1' }];

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
      .registerDataframe(ctx, { rows: ROWS, sourceTool: 'bls_get_series', queryParams: {} })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      data: { reason: 'canvas_registration_failed', sourceTool: 'bls_get_series', rowCount: 1 },
    });
  });

  it('preserves the underlying error as the cause', async () => {
    const underlying = new Error('DuckDB appender rollback');
    const bridge = new CanvasBridge(canvasFailingWith(underlying));
    // tenantId enables ctx.state, so the failure under test is registerTable's
    // rather than a state error thrown before the provider is ever reached.
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const error = await bridge
      .registerDataframe(ctx, { rows: ROWS, sourceTool: 'bls_get_series', queryParams: {} })
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
      .registerDataframe(ctx, { rows: ROWS, sourceTool: 'bls_get_series', queryParams: {} })
      .catch((e: unknown) => e);

    const data = (error as { data?: Record<string, unknown> }).data;
    expect(data?.reason).not.toBe('canvas_unavailable');
    expect((error as Error).message).not.toMatch(/CANVAS_PROVIDER_TYPE/);
  });
});
