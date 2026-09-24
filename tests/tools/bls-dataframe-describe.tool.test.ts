/**
 * @fileoverview Tests for bls_dataframe_describe tool.
 * @module tests/tools/bls-dataframe-describe.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blsDataframeDescribeTool } from '@/mcp-server/tools/definitions/bls-dataframe-describe.tool.js';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';

describe('blsDataframeDescribeTool', () => {
  beforeEach(() => {
    // No canvas — tests the unavailable path
    initCanvasBridge(undefined);
  });

  it('throws canvas_unavailable when canvas is not configured', async () => {
    const ctx = createMockContext({ errors: blsDataframeDescribeTool.errors });
    const input = blsDataframeDescribeTool.input.parse({});

    await expect(blsDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('formats empty dataframe list', () => {
    const output = { dataframes: [] };
    const blocks = blsDataframeDescribeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active dataframes');
  });

  it('formats dataframe entries with nullable column schema', () => {
    const output = {
      dataframes: [
        {
          name: 'df_AAAAA_BBBBB',
          source_tool: 'bls_get_series',
          query_params: { series_ids: ['LNS14000000'] },
          created_at: '2026-05-21T10:00:00.000Z',
          expires_at: '2026-05-22T10:00:00.000Z',
          row_count: 24,
          column_schema: [
            { name: 'series_id', type: 'VARCHAR', nullable: true },
            { name: 'value', type: 'DOUBLE', nullable: true },
          ],
        },
      ],
    };
    const blocks = blsDataframeDescribeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_AAAAA_BBBBB');
    expect(text).toContain('24');
    expect(text).toContain('nullable');
    expect(text).toContain('series_id');
  });

  it('formats query_params as key=value pairs', () => {
    const output = {
      dataframes: [
        {
          name: 'df_AAAAA_BBBBB',
          source_tool: 'bls_get_series',
          query_params: { series_ids: ['LNS14000000'], start_year: 2020, calculations: true },
          created_at: '2026-05-21T10:00:00.000Z',
          expires_at: '2026-05-22T10:00:00.000Z',
          row_count: 10,
          column_schema: [],
        },
      ],
    };
    const blocks = blsDataframeDescribeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('series_ids');
    expect(text).toContain('LNS14000000');
  });

  it('output schema validates empty dataframes array', () => {
    const output = { dataframes: [] };
    expect(() => blsDataframeDescribeTool.output.parse(output)).not.toThrow();
  });

  it('optional name field passes parse', () => {
    // Zod schema should accept both with and without name
    expect(() => blsDataframeDescribeTool.input.parse({})).not.toThrow();
    expect(() => blsDataframeDescribeTool.input.parse({ name: 'df_AAAAA_BBBBB' })).not.toThrow();
  });
});

describe('blsDataframeDescribeTool over the DuckDB canvas', () => {
  let canvas: DataCanvas;
  const teardownCtx = createMockContext({ tenantId: 'default' });

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    initCanvasBridge(canvas);
  });

  afterEach(async () => {
    initCanvasBridge(undefined);
    await canvas.shutdown(teardownCtx as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  it('rejects a name outside the dataframe-name rule with that rule, on both surfaces (#99)', async () => {
    for (const name of ['bad-name!', 'df-AAAAA-BBBBB', 'a.b', ' 1abc ']) {
      const result = await runToolContract(blsDataframeDescribeTool, { name });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_dataframe_name' },
        },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Dataframe names are canvas identifiers');
      expect(text).toContain('df_XXXXX_XXXXX');
      expect(text).not.toContain('Key contains invalid characters');
    }
  });

  it('reports register_as column types on structuredContent and content[] (#71)', async () => {
    // Both tool contexts share one tenant state, where the bridge keeps its metadata.
    const queryCtx = createMockContext({
      tenantId: 'describe-71',
      errors: blsDataframeQueryTool.errors,
    });
    const ctx = Object.assign(
      createMockContext({ tenantId: 'describe-71', errors: blsDataframeDescribeTool.errors }),
      { state: queryCtx.state },
    );
    const { tableName } = await getCanvasBridge()!.registerDataframe(ctx, {
      rows: Array.from({ length: 24 }, (_, i) => ({
        series_id: i < 12 ? 'LNS14000000' : 'CUUR0000SA0',
        year: '2024',
        available: true,
        is_annual_average: false,
        value_numeric: 4 + i / 10,
      })),
      schema: [
        { name: 'series_id', type: 'VARCHAR', nullable: true },
        { name: 'year', type: 'VARCHAR', nullable: true },
        { name: 'available', type: 'BOOLEAN', nullable: true },
        { name: 'is_annual_average', type: 'BOOLEAN', nullable: true },
        { name: 'value_numeric', type: 'DOUBLE', nullable: true },
      ],
      sourceTool: 'bls_get_series',
      queryParams: {},
    });
    await blsDataframeQueryTool.handler(
      blsDataframeQueryTool.input.parse({
        sql: `SELECT series_id, COUNT(*) AS periods, AVG(value_numeric) AS avg_value FROM ${tableName} WHERE available AND NOT is_annual_average GROUP BY series_id`,
        register_as: 'review_numeric_summary',
      }),
      queryCtx,
    );

    const structured = blsDataframeDescribeTool.output.parse(
      await blsDataframeDescribeTool.handler(
        blsDataframeDescribeTool.input.parse({ name: 'review_numeric_summary' }),
        ctx,
      ),
    );

    expect(structured.dataframes).toHaveLength(1);
    expect(structured.dataframes[0]).toMatchObject({
      name: 'review_numeric_summary',
      source_tool: 'bls_dataframe_query',
      row_count: 2,
      column_schema: [
        { name: 'series_id', type: 'VARCHAR', nullable: true },
        { name: 'periods', type: 'BIGINT', nullable: true },
        { name: 'avg_value', type: 'DOUBLE', nullable: true },
      ],
    });
    const text = (blsDataframeDescribeTool.format!(structured)[0] as { text: string }).text;
    expect(text).toContain(
      'Columns: series_id:VARCHAR (nullable), periods:BIGINT (nullable), avg_value:DOUBLE (nullable)',
    );
  });

  it('treats a blank or whitespace-only name as omitted and lists every dataframe, on both surfaces', async () => {
    const ctx = createMockContext({
      tenantId: 'describe-blank',
      errors: blsDataframeDescribeTool.errors,
    });
    const register = () =>
      getCanvasBridge()!.registerDataframe(ctx, {
        rows: [{ series_id: 'LNS14000000' }],
        schema: [{ name: 'series_id', type: 'VARCHAR', nullable: true }],
        sourceTool: 'bls_get_series',
        queryParams: {},
      });
    const names = [(await register()).tableName, (await register()).tableName];

    for (const name of ['', '   ']) {
      const structured = blsDataframeDescribeTool.output.parse(
        await blsDataframeDescribeTool.handler(blsDataframeDescribeTool.input.parse({ name }), ctx),
      );

      expect(structured.dataframes.map((d) => d.name).sort()).toEqual([...names].sort());
      const text = (blsDataframeDescribeTool.format!(structured)[0] as { text: string }).text;
      expect(text).toContain('**2 active dataframe(s):**');
      for (const table of names) expect(text).toContain(`### ${table}`);
    }
  });

  it('describes nothing for a well-formed name that matches no dataframe', async () => {
    const result = await runToolContract(blsDataframeDescribeTool, { name: 'df_NOPE0_NOPE0' });

    expect(result.structuredContent).toEqual({ dataframes: [] });
    expect((result.content[0] as { text: string }).text).toBe('No active dataframes.');
  });
});
