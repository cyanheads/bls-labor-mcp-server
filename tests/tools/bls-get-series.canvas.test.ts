/**
 * @fileoverview `bls_get_series` spills through the real CanvasBridge onto a
 * real DuckDB canvas, then `bls_dataframe_describe` and `bls_dataframe_query`
 * read the table back. Only the BLS API service is faked, so the spill schema
 * under test is the one DuckDB actually created (#97).
 * @module tests/tools/bls-get-series.canvas.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blsDataframeDescribeTool } from '@/mcp-server/tools/definitions/bls-dataframe-describe.tool.js';
import { blsDataframeQueryTool } from '@/mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { blsGetSeriesTool } from '@/mcp-server/tools/definitions/bls-get-series.tool.js';
import type { SeriesData } from '@/services/bls-api/types.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas } from '../fixtures/duckdb-canvas.js';

const fetchSeriesMock = vi.fn();

vi.mock('@/services/bls-api/bls-api-service.js', () => ({
  getBlsApiService: () => ({ fetchSeries: fetchSeriesMock }),
}));

type Observation = SeriesData['observations'][number];

/** 900 monthly observations — enough JSON to cross the inline budget and spill. */
function spillingSeries(
  value: (i: number) => string,
  extra: Partial<Observation> = {},
): SeriesData {
  return {
    seriesId: 'CES0000000001',
    title: 'All employees, thousands, total nonfarm',
    observations: Array.from({ length: 900 }, (_, i) => ({
      year: String(1950 + Math.floor(i / 12)),
      period: `M${String((i % 12) + 1).padStart(2, '0')}`,
      periodName: 'January',
      value: value(i),
      footnotes: ['P: Preliminary figure subject to revision in a later release'],
      ...extra,
    })),
  };
}

/**
 * One context per tool, each typed for that tool's error contract, all sharing
 * one tenant state — the bridge keeps the canvas id and dataframe metadata there.
 */
function toolContexts() {
  const series = createMockContext({ tenantId: 'spill-97', errors: blsGetSeriesTool.errors });
  const shared = { state: series.state };
  return {
    series,
    describe: Object.assign(
      createMockContext({ tenantId: 'spill-97', errors: blsDataframeDescribeTool.errors }),
      shared,
    ),
    query: Object.assign(
      createMockContext({ tenantId: 'spill-97', errors: blsDataframeQueryTool.errors }),
      shared,
    ),
  };
}

describe('bls_get_series spill schema on the DuckDB canvas (#97)', () => {
  let canvas: DataCanvas;
  let ctx: ReturnType<typeof toolContexts>;

  beforeEach(() => {
    canvas = createDuckdbCanvas();
    initCanvasBridge(canvas);
    ctx = toolContexts();
  });

  afterEach(async () => {
    initCanvasBridge(undefined);
    await canvas.shutdown(ctx.series as unknown as Parameters<DataCanvas['shutdown']>[0]);
  });

  /** Spill `series`, then describe the table through the tool contract. */
  async function spillAndDescribe(series: SeriesData, calculations?: boolean) {
    fetchSeriesMock.mockResolvedValue([series]);
    const spilled = await blsGetSeriesTool.handler(
      blsGetSeriesTool.input.parse({
        series_ids: [series.seriesId],
        ...(calculations !== undefined && { calculations }),
      }),
      ctx.series,
    );
    expect(spilled.spilled).toBe(true);
    const name = spilled.dataset!.name;
    const described = blsDataframeDescribeTool.output.parse(
      await blsDataframeDescribeTool.handler(
        blsDataframeDescribeTool.input.parse({ name }),
        ctx.describe,
      ),
    );
    const types = Object.fromEntries(
      described.dataframes[0]!.column_schema.map((c) => [c.name, c.type]),
    );
    const text = (blsDataframeDescribeTool.format!(described)[0] as { text: string }).text;
    return { name, types, text };
  }

  const query = async (sql: string) =>
    blsDataframeQueryTool.handler(blsDataframeQueryTool.input.parse({ sql }), ctx.query);

  it('keeps the non-numeric columns at their current types', async () => {
    const { types } = await spillAndDescribe(spillingSeries((i) => (4 + i / 100).toFixed(2)));

    expect(types).toMatchObject({
      series_id: 'VARCHAR',
      series_title: 'VARCHAR',
      area: 'VARCHAR',
      item: 'VARCHAR',
      seasonal: 'VARCHAR',
      year: 'VARCHAR',
      period: 'VARCHAR',
      period_name: 'VARCHAR',
      is_annual_average: 'BOOLEAN',
      value: 'VARCHAR',
      available: 'BOOLEAN',
      footnotes: 'VARCHAR',
    });
  });

  it('types value_numeric DOUBLE for a fractional batch', async () => {
    const { types } = await spillAndDescribe(spillingSeries((i) => (4 + i / 100).toFixed(2)));
    expect(types.value_numeric).toBe('DOUBLE');
  });

  it('types value_numeric DOUBLE for a whole-number batch', async () => {
    const { name, types, text } = await spillAndDescribe(
      spillingSeries((i) => String(159_000 + i)),
    );

    expect(types.value_numeric).toBe('DOUBLE');
    expect(text).toContain('value_numeric:DOUBLE');
    const result = await query(`SELECT AVG(value_numeric) / 2 AS half FROM ${name}`);
    expect(result.rows[0]?.half).toBeCloseTo((159_000 + 159_899) / 4);
  });

  it('types value_numeric DOUBLE for an all-unavailable batch, and AVG over it runs', async () => {
    const { name, types } = await spillAndDescribe(spillingSeries(() => '-', { available: false }));

    expect(types.value_numeric).toBe('DOUBLE');
    const result = await query(`SELECT AVG(value_numeric) AS mean FROM ${name}`);
    expect(result.rows).toEqual([{ mean: null }]);
  });

  it('types every calculation column DOUBLE, so arithmetic needs no CAST', async () => {
    const calcs: Partial<Observation> = {
      netChange1Month: '0.1',
      netChange3Month: '-0.2',
      netChange6Month: '0.3',
      netChange12Month: '1.5',
      pctChange1Month: '0.2',
      pctChange3Month: '0.6',
      pctChange6Month: '1.2',
      pctChange12Month: '2.9',
    };
    const { name, types, text } = await spillAndDescribe(
      spillingSeries((i) => (300 + i / 10).toFixed(1), calcs),
      true,
    );

    for (const column of [
      'net_change_1m',
      'net_change_3m',
      'net_change_6m',
      'net_change_12m',
      'pct_change_1m',
      'pct_change_3m',
      'pct_change_6m',
      'pct_change_12m',
    ]) {
      expect(types[column], column).toBe('DOUBLE');
      expect(text).toContain(`${column}:DOUBLE`);
    }
    const result = await query(
      `SELECT pct_change_12m * 2 AS doubled, net_change_3m + 1 AS shifted FROM ${name} LIMIT 1`,
    );
    expect(result.rows[0]).toEqual({ doubled: 5.8, shifted: 0.8 });
  });

  it('stores a calculation value that is not a number as NULL', async () => {
    const { name } = await spillAndDescribe(
      spillingSeries((i) => (300 + i / 10).toFixed(1), { pctChange12Month: '-' }),
      true,
    );

    const result = await query(`SELECT COUNT(pct_change_12m) AS rows_with_value FROM ${name}`);
    // COUNT is BIGINT, which canvas rows carry as a JSON string.
    expect(result.rows).toEqual([{ rows_with_value: '0' }]);
  });

  it('stores NULL, not 0, in value_numeric for an available observation with a blank value', async () => {
    const { name } = await spillAndDescribe(
      spillingSeries((i) => (i % 10 === 0 ? '' : (4 + i / 100).toFixed(2))),
    );

    const blank = await query(
      `SELECT COUNT(*) AS n FROM ${name} WHERE available AND value = '' AND value_numeric IS NULL`,
    );
    const zero = await query(`SELECT COUNT(*) AS n FROM ${name} WHERE value_numeric = 0`);
    // COUNT is BIGINT, which canvas rows carry as a JSON string.
    expect(blank.rows).toEqual([{ n: '90' }]);
    expect(zero.rows).toEqual([{ n: '0' }]);
  });

  it('keeps the inline observations on BLS strings', async () => {
    fetchSeriesMock.mockResolvedValue([
      spillingSeries((i) => (300 + i / 10).toFixed(1), { pctChange12Month: '2.9' }),
    ]);

    const spilled = await blsGetSeriesTool.handler(
      blsGetSeriesTool.input.parse({ series_ids: ['CES0000000001'], calculations: true }),
      ctx.series,
    );

    expect(spilled.series[0]!.observations[0]).toMatchObject({
      value: '300.0',
      pctChange12Month: '2.9',
    });
  });
});
