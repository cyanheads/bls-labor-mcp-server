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

describe('CanvasBridge.registerDataframe', () => {
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
