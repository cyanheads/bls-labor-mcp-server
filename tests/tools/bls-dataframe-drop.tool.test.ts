/**
 * @fileoverview Tests for bls_dataframe_drop tool.
 * @module tests/tools/bls-dataframe-drop.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blsDataframeDropTool } from '@/mcp-server/tools/definitions/bls-dataframe-drop.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';

describe('blsDataframeDropTool', () => {
  beforeEach(() => {
    initCanvasBridge(undefined);
  });

  it('throws canvas_unavailable when canvas is not configured', async () => {
    const ctx = createMockContext({ errors: blsDataframeDropTool.errors });
    const input = blsDataframeDropTool.input.parse({ name: 'df_AAAAA_BBBBB' });

    await expect(blsDataframeDropTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('formats dropped=true result', () => {
    const blocks = blsDataframeDropTool.format!({ name: 'df_AAAAA_BBBBB', dropped: true });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_AAAAA_BBBBB');
    expect(text).toContain('Dropped');
  });

  it('formats dropped=false result', () => {
    const blocks = blsDataframeDropTool.format!({ name: 'df_XXXXX_YYYYY', dropped: false });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not found');
  });

  it('rejects empty name', () => {
    expect(() => blsDataframeDropTool.input.parse({ name: '' })).toThrow();
  });

  it('output schema validates correctly', () => {
    expect(() =>
      blsDataframeDropTool.output.parse({ name: 'df_AAAAA_BBBBB', dropped: true }),
    ).not.toThrow();
    expect(() =>
      blsDataframeDropTool.output.parse({ name: 'df_AAAAA_BBBBB', dropped: false }),
    ).not.toThrow();
  });
});

describe('blsDataframeDropTool over the DuckDB canvas', () => {
  let canvas: DataCanvas;
  const teardownCtx = createMockContext({ tenantId: 'default' });

  beforeEach(() => {
    canvas = createDuckdbCanvas();
  });

  afterEach(async () => {
    initCanvasBridge(undefined);
    await canvas.shutdown(teardownCtx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  it('fails with a retryable canvas_drop_failed on both surfaces when the provider drop rejects (#74)', async () => {
    initCanvasBridge({
      acquire: async (...args: Parameters<DataCanvas['acquire']>) => {
        const instance = await canvas.acquire(...args);
        instance.drop = () => Promise.reject(new Error('injected provider fault'));
        return instance;
      },
    } as unknown as DataCanvas);

    const result = await runToolContract(blsDataframeDropTool, { name: 'df_AAAAA_BBBBB' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'canvas_drop_failed',
          retryable: true,
          tableName: 'df_AAAAA_BBBBB',
          recovery: { hint: expect.stringContaining('Retry') },
        },
      },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('df_AAAAA_BBBBB');
    expect(text).toContain('Retry');
    expect(text).not.toContain('Dropped');
  });

  it('rejects a name outside the dataframe-name rule with that rule, on both surfaces (#99)', async () => {
    initCanvasBridge(canvas);

    for (const name of ['bad-name!', 'df-AAAAA-BBBBB', '1abc', `a${'b'.repeat(63)}`]) {
      const result = await runToolContract(blsDataframeDropTool, { name });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('df_XXXXX_XXXXX');
      expect(text).not.toContain('Key contains invalid characters');
    }
  });

  it('accepts minted and register_as-style names (#99)', async () => {
    initCanvasBridge(canvas);

    for (const name of [
      'df_AB1CD_EF2GH',
      'review_numeric_summary',
      '_scratch',
      `a${'b'.repeat(62)}`,
    ]) {
      const result = await runToolContract(blsDataframeDropTool, { name });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ name, dropped: false });
      expect((result.content[0] as { text: string }).text).toBe(`${name} not found.`);
    }
  });
});
