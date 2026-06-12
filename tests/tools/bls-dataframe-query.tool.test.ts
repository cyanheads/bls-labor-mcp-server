/**
 * @fileoverview Tests for bls_dataframe_query tool.
 * @module tests/tools/bls-dataframe-query.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';

const mockQuery = vi.fn();
let canvasBridgeEnabled = false;

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  initCanvasBridge: vi.fn(),
  getCanvasBridge: () => (canvasBridgeEnabled ? { query: mockQuery } : null),
}));

describe('blsDataframeQueryTool', () => {
  beforeEach(() => {
    canvasBridgeEnabled = false;
    mockQuery.mockReset();
  });

  it('throws canvas_unavailable when canvas is not configured', async () => {
    canvasBridgeEnabled = false;
    const ctx = createMockContext({ errors: blsDataframeQueryTool.errors });
    const input = blsDataframeQueryTool.input.parse({ sql: 'SELECT 1' });

    await expect(blsDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('returns query results within row_limit with no enrichment notice', async () => {
    canvasBridgeEnabled = true;
    mockQuery.mockResolvedValue({
      result: {
        columns: ['series_id', 'value'],
        rowCount: 2,
        rows: [
          { series_id: 'LNS14000000', value: '4.1' },
          { series_id: 'CES0000000001', value: '159000' },
        ],
      },
      meta: undefined,
    });

    const ctx = createMockContext();
    const input = blsDataframeQueryTool.input.parse({
      sql: 'SELECT series_id, value FROM df_AAAAA',
    });
    const result = await blsDataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('enriches with notice naming row_limit when it is the binding cap', async () => {
    canvasBridgeEnabled = true;
    mockQuery.mockResolvedValue({
      result: {
        columns: ['series_id'],
        rowCount: 5000,
        rows: Array.from({ length: 1000 }, (_, i) => ({ series_id: `S${i}` })),
      },
      meta: undefined,
    });

    const ctx = createMockContext();
    const input = blsDataframeQueryTool.input.parse({ sql: 'SELECT series_id FROM df_AAAAA' });
    await blsDataframeQueryTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.notice).toContain('row_limit');
    expect(enriched.notice).not.toContain('preview');
  });

  it('enriches with notice naming preview when it is the binding cap (not row_limit)', async () => {
    canvasBridgeEnabled = true;
    mockQuery.mockResolvedValue({
      result: {
        columns: ['series_id'],
        rowCount: 5000,
        rows: Array.from({ length: 3 }, (_, i) => ({ series_id: `S${i}` })),
      },
      meta: undefined,
    });

    const ctx = createMockContext();
    // preview=3 is below row_limit default (1000) — preview is the binding cap.
    const input = blsDataframeQueryTool.input.parse({
      sql: 'SELECT series_id FROM df_AAAAA',
      preview: 3,
    });
    await blsDataframeQueryTool.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.notice).toBeDefined();
    expect(enriched.notice).toContain('preview=3');
    expect(enriched.notice).not.toContain('row_limit');
  });

  it('formats query results as markdown table', () => {
    const output = {
      columns: ['series_id', 'value'],
      row_count: 2,
      rows: [
        { series_id: 'LNS14000000', value: '4.1' },
        { series_id: 'CES0000000001', value: '159000' },
      ],
    };
    const blocks = blsDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('series_id');
    expect(text).toContain('4.1');
    expect(text).toContain('LNS14000000');
  });

  it('formats empty result set', () => {
    const output = {
      columns: ['series_id'],
      row_count: 0,
      rows: [],
    };
    const blocks = blsDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No rows');
  });

  it('includes registered_as and expires_at when present', () => {
    const output = {
      columns: ['series_id'],
      row_count: 1,
      rows: [{ series_id: 'X' }],
      registered_as: 'df_CCCCC_DDDDD',
      expires_at: '2026-05-22T00:00:00.000Z',
    };
    const blocks = blsDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_CCCCC_DDDDD');
  });

  it('rejects empty sql string', () => {
    expect(() => blsDataframeQueryTool.input.parse({ sql: '' })).toThrow();
  });

  it('rejects row_limit below 1', () => {
    expect(() => blsDataframeQueryTool.input.parse({ sql: 'SELECT 1', row_limit: 0 })).toThrow();
  });

  it('rejects row_limit above 10000', () => {
    expect(() =>
      blsDataframeQueryTool.input.parse({ sql: 'SELECT 1', row_limit: 10001 }),
    ).toThrow();
  });

  it('rejects preview above 10000', () => {
    expect(() => blsDataframeQueryTool.input.parse({ sql: 'SELECT 1', preview: 10001 })).toThrow();
  });

  it('formats rows with pipe-escaped cell values', () => {
    const output = {
      columns: ['label'],
      row_count: 1,
      rows: [{ label: 'a|b' }],
    };
    const blocks = blsDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Pipe in cell value must be escaped
    expect(text).toContain('a\\|b');
  });

  it('formats null cell values as empty string', () => {
    const output = {
      columns: ['value'],
      row_count: 1,
      rows: [{ value: null }],
    };
    const blocks = blsDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // null cell → empty table cell
    expect(text).toContain('|  |');
  });

  // Security: SQL injection attempt via SQL input is passed through to the canvas bridge
  // (the framework gate blocks it); verify it doesn't crash the tool input validation
  it('accepts arbitrary SQL string without input validation error', () => {
    const injectionSql =
      'SELECT * FROM df_AAAAA; DROP TABLE df_BBBBB; SELECT * FROM information_schema.tables';
    expect(() => blsDataframeQueryTool.input.parse({ sql: injectionSql })).not.toThrow();
    // The actual denial happens in the canvas bridge / framework SQL gate, not the Zod schema
  });

  // Security: system catalog access is denied via denySystemCatalogs: true in the bridge
  // (delegated to framework sqlGate since 0.10.4). The tool must propagate the
  // system_catalog_access reason code unchanged — no swallowing or rewrapping.
  it('propagates system_catalog_access reason code from the bridge gate', async () => {
    canvasBridgeEnabled = true;
    const catalogError = Object.assign(new Error('system catalog denied'), {
      data: { reason: 'system_catalog_access', catalog: 'information_schema' },
    });
    mockQuery.mockRejectedValue(catalogError);

    const ctx = createMockContext();
    const input = blsDataframeQueryTool.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(blsDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'system_catalog_access' },
    });
  });
});
