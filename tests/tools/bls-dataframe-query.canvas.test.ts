/**
 * @fileoverview Query ceiling contracts against a real DuckDB-backed canvas.
 * @module tests/tools/bls-dataframe-query.canvas.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';

describe('query clamps with real DuckDB', () => {
  it('preserves the complete registered result across clamped and zero previews', async () => {
    const canvas = createDuckdbCanvas();
    const context = createMockContext({ tenantId: 'query-clamps' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
    initCanvasBridge(canvas);
    const tool = {
      ...blsDataframeQueryTool,
      handler: (
        input: Parameters<typeof blsDataframeQueryTool.handler>[0],
        ctx: Parameters<typeof blsDataframeQueryTool.handler>[1],
      ) =>
        blsDataframeQueryTool.handler(input, {
          ...ctx,
          state: context.state,
          tenantId: context.tenantId,
        }),
    };
    try {
      const source = await getCanvasBridge()!.registerDataframe(context, {
        rows: Array.from({ length: 10001 }, (_, value) => ({ value })),
        schema: [{ name: 'value', type: 'INTEGER', nullable: false }],
        sourceTool: 'bls_get_series',
        queryParams: {},
      });
      const first = await runToolContract(tool, {
        sql: `SELECT * FROM ${source.tableName}`,
        register_as: 'complete_result',
        row_limit: 20000,
        preview: 20000,
      });
      expect(first.structuredContent).toMatchObject({
        row_count: 10001,
        registered_as: 'complete_result',
        shown: 10000,
        cap: 10000,
        notice: expect.stringContaining(
          'The complete result is materialized in dataframe complete_result',
        ),
      });
      expect(JSON.stringify(first.content)).toContain(
        'requested row_limit=20000, preview=20000; applied row_limit=10000, preview=10000',
      );
      expect(JSON.stringify(first.content)).toContain(
        'The complete result is materialized in dataframe complete_result',
      );
      const second = await runToolContract(tool, {
        sql: 'SELECT * FROM complete_result',
        register_as: 'zero_preview',
        preview: 0,
      });
      expect(second.structuredContent).toMatchObject({
        row_count: 10001,
        rows: [],
        shown: 0,
        cap: 0,
      });
      const count = await runToolContract(tool, {
        sql: 'SELECT COUNT(*) AS count FROM zero_preview',
      });
      expect(count.structuredContent).toMatchObject({ rows: [{ count: '10001' }] });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      initCanvasBridge(undefined);
      fetch.mockRestore();
      await canvas.shutdown(context as unknown as Parameters<typeof canvas.shutdown>[0]);
    }
  });
});
