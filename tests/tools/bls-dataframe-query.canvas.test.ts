/**
 * @fileoverview Query ceiling and register_as contracts against a real
 * DuckDB-backed canvas.
 * @module tests/tools/bls-dataframe-query.canvas.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';

/** The query tool, run against `tenant`'s state, where the bridge keeps the canvas id. */
function onTenantState(tenant: ReturnType<typeof createMockContext>) {
  return {
    ...blsDataframeQueryTool,
    handler: (
      input: Parameters<typeof blsDataframeQueryTool.handler>[0],
      ctx: Parameters<typeof blsDataframeQueryTool.handler>[1],
    ) =>
      blsDataframeQueryTool.handler(input, {
        ...ctx,
        state: tenant.state,
        tenantId: tenant.tenantId,
      }),
  };
}

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('bls_dataframe_query on the DuckDB canvas', () => {
  let canvas: ReturnType<typeof createDuckdbCanvas>;
  let context: ReturnType<typeof createMockContext>;
  let tool: ReturnType<typeof onTenantState>;

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    context = createMockContext({ tenantId: 'query-canvas' });
    initCanvasBridge(canvas);
    tool = onTenantState(context);
  });

  afterEach(async () => {
    initCanvasBridge(undefined);
    await canvas.shutdown(context as unknown as Parameters<typeof canvas.shutdown>[0]);
  });

  it('preserves the complete registered result across clamped and zero previews', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
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
          'The complete result is materialized in the registered_as dataframe',
        ),
      });
      expect(JSON.stringify(first.content)).toContain(
        'requested row_limit=20000, preview=20000; applied row_limit=10000, preview=10000',
      );
      expect(textOf(first)).toContain('Registered as `complete_result`');
      expect(textOf(first)).toContain(
        'The complete result is materialized in the registered_as dataframe',
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
      fetch.mockRestore();
    }
  });

  it('refuses a register_as that names a DuckDB system catalog on both surfaces, and the next register_as works', async () => {
    const refused = await runToolContract(tool, {
      sql: 'SELECT 1 AS n',
      register_as: 'duckdb_columns',
    });

    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'register_as_system_catalog',
          registerAs: 'duckdb_columns',
          recovery: {
            hint: blsDataframeQueryTool.errors?.find(
              (entry) => entry.reason === 'register_as_system_catalog',
            )?.recovery,
          },
        },
      },
    });
    expect(textOf(refused)).toContain('`duckdb_columns`');

    const next = await runToolContract(tool, { sql: 'SELECT 2 AS n', register_as: 'next_one' });
    expect(next.isError).toBeFalsy();
    expect(next.structuredContent).toMatchObject({ registered_as: 'next_one', rows: [{ n: 2 }] });
  });
});
