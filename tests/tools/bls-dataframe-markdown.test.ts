/**
 * @fileoverview The dataframe tools' content[] read back through a CommonMark
 * parser with GFM tables: dataframe names, query cells and column names, the
 * truncation notice, and the error messages that quote a name — each through
 * the assembled tool result on a real DuckDB canvas (#133).
 * @module tests/tools/bls-dataframe-markdown.test
 */

import type { ColumnSchema, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blsDataframeDescribeTool } from '@/mcp-server/tools/definitions/bls-dataframe-describe.tool.js';
import { blsDataframeDropTool } from '@/mcp-server/tools/definitions/bls-dataframe-drop.tool.js';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';
import { quotedText, readBack, tableRows } from '../fixtures/markdown-read-back.js';

/** Every inline run's read-back text, in document order. */
const inlineTexts = (markdown: string) => readBack(markdown).map((block) => block.text);

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('dataframe tools read back through CommonMark/GFM (#133)', () => {
  let canvas: DataCanvas;
  let tenant: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    tenant = createMockContext({ tenantId: 'markdown-133' });
    initCanvasBridge(canvas);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    initCanvasBridge(undefined);
    await canvas.shutdown(tenant as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  /** `definition`, run as the tenant, on the state where the bridge keeps the canvas id. */
  function onTenantState<T extends { handler: (input: never, ctx: never) => unknown }>(
    definition: T,
  ): T {
    const handler = definition.handler as unknown as (input: unknown, ctx: object) => unknown;
    return {
      ...definition,
      handler: (input: unknown, ctx: object) =>
        handler(input, { ...ctx, state: tenant.state, tenantId: tenant.tenantId }),
    } as unknown as T;
  }

  const query = onTenantState(blsDataframeQueryTool);
  const describeTool = onTenantState(blsDataframeDescribeTool);
  const drop = onTenantState(blsDataframeDropTool);
  const run = runToolContract;

  const stage = (rows: Record<string, unknown>[], schema: ColumnSchema[]) =>
    getCanvasBridge()!.registerDataframe(tenant, {
      rows,
      schema,
      sourceTool: 'bls_get_series',
      queryParams: { series_ids: ['IPUAN311___W200000000'] },
    });

  describe('bls_dataframe_query cells and column names', () => {
    const VALUES = [
      'IPUAN311___W200000000',
      'LNS14000000',
      'a|b',
      'x\\|y',
      '|',
      '_a_',
      ' leading',
      'trailing ',
      ' ',
      'tick`in',
      '`',
      'C:\\tmp',
      '<b>x</b>',
      '&amp;',
      '-0.2',
    ];

    it('reads every string cell and column name back exactly, and no pipe splits a row', async () => {
      const { tableName } = await stage(
        VALUES.map((value, i) => ({ a__b: value, n: i })),
        [
          { name: 'a__b', type: 'VARCHAR', nullable: true },
          { name: 'n', type: 'INTEGER', nullable: true },
        ],
      );

      const result = await run(query, {
        sql: `SELECT a__b, n FROM ${tableName} ORDER BY n`,
      });

      const rows = tableRows(textOf(result));
      expect(textOf(result)).toContain('| `a__b` | n |');
      expect(rows[0]).toEqual(['a__b', 'n']);
      expect(rows.slice(1)).toEqual(VALUES.map((value, i) => [value, String(i)]));
    });

    it('leaves a cell escaping would not alter as plain text, and spans the rest', async () => {
      const { tableName } = await stage(
        [
          { series_id: 'LNS14000000' },
          { series_id: 'IPUAN311___W200000000' },
          { series_id: 'a|b' },
        ],
        [{ name: 'series_id', type: 'VARCHAR', nullable: true }],
      );

      const text = textOf(await run(query, { sql: `SELECT series_id FROM ${tableName}` }));

      expect(text).toContain('| LNS14000000 |');
      expect(text).toContain('| `IPUAN311___W200000000` |');
      expect(text).toContain('| `a\\|b` |');
    });

    it('keeps a row on one line when a cell holds a line break, as its JSON string', async () => {
      const { tableName } = await stage(
        [{ note: 'first\nsecond', n: 1 }],
        [
          { name: 'note', type: 'VARCHAR', nullable: true },
          { name: 'n', type: 'INTEGER', nullable: true },
        ],
      );

      const result = await run(query, { sql: `SELECT note, n FROM ${tableName}` });

      expect(result.structuredContent).toMatchObject({ rows: [{ note: 'first\nsecond', n: 1 }] });
      expect(tableRows(textOf(result))).toEqual([
        ['note', 'n'],
        [JSON.stringify('first\nsecond'), '1'],
      ]);
    });
  });

  it('renders a register_as name as a code span that reads back exactly, in the result and the notice', async () => {
    const { tableName } = await stage(
      Array.from({ length: 5 }, (_, n) => ({ n })),
      [{ name: 'n', type: 'INTEGER', nullable: true }],
    );

    const result = await run(query, {
      sql: `SELECT n FROM ${tableName}`,
      register_as: '_a_',
      preview: 2,
    });

    const structured = result.structuredContent as { expires_at: string; notice: string };
    const text = textOf(result);
    expect(text).toContain('Registered as `_a_`');
    expect(inlineTexts(text)[0]?.split('\n')[0]).toBe(
      `Registered as _a_ (expires ${structured.expires_at}).`,
    );
    expect(quotedText(text)).toBe(structured.notice);
  });

  it('renders every dataframe name, column name, and parameter in describe as code that reads back', async () => {
    const { tableName } = await stage(
      [{ series_id: 'IPUAN311___W200000000' }],
      [{ name: 'series_id', type: 'VARCHAR', nullable: true }],
    );
    await run(query, {
      sql: `SELECT series_id AS __id FROM ${tableName}`,
      register_as: 'cpi__2024',
    });

    const result = await run(describeTool, {});

    const text = textOf(result);
    expect(text).toContain('### `cpi__2024`');
    expect(text).toContain('- Columns: `__id`:VARCHAR (nullable)');
    expect(text).toContain('- Params: series_ids=`["IPUAN311___W200000000"]`');
    const lines = inlineTexts(text);
    expect(lines).toContain('cpi__2024');
    expect(lines).toContain(tableName);
    expect(lines).toContain('Columns: __id:VARCHAR (nullable)');
    expect(lines).toContain(
      `Params: sql=${JSON.stringify(`SELECT series_id AS __id FROM ${tableName}`)}`,
    );
    expect(lines).toContain('Params: series_ids=["IPUAN311___W200000000"]');
  });

  it('renders the dropped and the unmatched name as code that reads back', async () => {
    await run(query, { sql: 'SELECT 1 AS n', register_as: '_tmp' });

    const dropped = textOf(await run(drop, { name: '_tmp' }));
    const missing = textOf(await run(drop, { name: '__nope__' }));

    expect(dropped).toBe('Dropped `_tmp`.');
    expect(inlineTexts(dropped)).toEqual(['Dropped _tmp.']);
    expect(missing).toBe('`__nope__` not found.');
    expect(inlineTexts(missing)).toEqual(['__nope__ not found.']);
  });

  describe('error messages quoting a dataframe name the caller sends back', () => {
    /** The error line of `content[]`, read back, beside `structuredContent.error.message`. */
    const errorLine = (result: Awaited<ReturnType<typeof runToolContract>>) => ({
      readBack: inlineTexts(textOf(result))[0],
      message: `Error: ${(result.structuredContent as { error: { message: string } }).error.message}`,
    });

    it('register_as_clash names the clashing name as code', async () => {
      await run(query, { sql: 'SELECT 1 AS n', register_as: 'cpi__2024' });

      const clash = await run(query, {
        sql: 'SELECT 2 AS n',
        register_as: 'cpi__2024',
      });

      expect(clash.structuredContent).toMatchObject({
        error: { data: { reason: 'register_as_clash' } },
      });
      expect(textOf(clash)).toContain('`cpi__2024`');
      const { readBack: line, message } = errorLine(clash);
      expect(line).toBe(message);
    });

    it('missing_table names the missing table as code', async () => {
      await stage([{ n: 1 }], [{ name: 'n', type: 'INTEGER', nullable: true }]);

      const missing = await run(query, { sql: 'SELECT * FROM cpi__missing' });

      expect(missing.structuredContent).toMatchObject({
        error: { data: { reason: 'missing_table', tableName: 'cpi__missing' } },
      });
      expect(textOf(missing)).toContain('`cpi__missing`');
      expect(textOf(missing)).not.toContain('"`cpi__missing`"');
      expect(textOf(missing)).toContain('bls_dataframe_describe');
      const { readBack: line, message } = errorLine(missing);
      expect(line).toBe(message);
      expect(message).toBe(
        'Error: Canvas table cpi__missing does not exist. The table may have expired, been dropped, or the name may be mistyped.',
      );
    });

    it('canvas_drop_failed names the dataframe as code', async () => {
      await run(query, { sql: 'SELECT 1 AS n', register_as: '_tmp' });
      const acquireShared = canvas.acquireShared.bind(canvas);
      vi.spyOn(canvas, 'acquireShared').mockImplementation(async (ctx, options) => {
        const instance = await acquireShared(ctx, options);
        if (instance) instance.drop = () => Promise.reject(new Error('injected provider fault'));
        return instance;
      });

      const failed = await run(drop, { name: '_tmp' });

      expect(failed.structuredContent).toMatchObject({
        error: { data: { reason: 'canvas_drop_failed', tableName: '_tmp' } },
      });
      expect(textOf(failed)).toContain('`_tmp`');
      const { readBack: line, message } = errorLine(failed);
      expect(line).toBe(message);
    });
  });
});
