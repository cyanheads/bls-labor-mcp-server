/**
 * @fileoverview Run a single-statement SELECT against canvas dataframes
 * registered by bls_get_series. Layered SQL gate: framework (single-statement →
 * SELECT only → plan-walk allowlist + denied table functions) plus bridge-layer
 * denial of DuckDB system catalogs. Requires CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/bls-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const blsDataframeQueryTool = tool('bls_dataframe_query', {
  title: 'Query BLS Dataframes',
  description:
    'Run a single-statement SELECT against the canvas dataframes registered by bls_get_series. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied at the bridge layer — use bls_dataframe_describe to list available dataframes. Supports JOINs, aggregates, window functions, and CTEs. Optional register_as persists the result as a new dataframe with a fresh TTL for chained analysis. Canvas SQL operations consume zero BLS API quota. Requires CANVAS_PROVIDER_TYPE=duckdb.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment and restart to enable dataframe tools.',
    },
  ],

  input: z
    .object({
      sql: z
        .string()
        .min(1)
        .describe(
          "Single-statement SELECT against df_<id> tables on the shared canvas. Reference dataframes by the names returned in bls_get_series responses or listed by bls_dataframe_describe. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Example: SELECT series_id, year, period, value FROM df_AAAAA_BBBBB WHERE year >= '2020' ORDER BY year DESC.",
        ),
      register_as: z
        .string()
        .optional()
        .describe(
          'When set, persist the query result as a new dataframe under this name. Fresh TTL — not inherited from parent tables. Use to chain analyses without re-running source SQL or consuming additional BLS quota.',
        ),
      preview: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe(
          'Inline row preview count. Defaults to row_limit. Set lower (e.g. 50) when chaining via register_as and only a sample is needed immediately.',
        ),
      row_limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(1000)
        .describe(
          'Hard cap on rows materialized in the response (default 1000, max 10000). Full results live on-canvas under register_as when provided.',
        ),
    })
    .refine(({ preview, row_limit }) => preview === undefined || preview <= row_limit, {
      message: 'preview must be less than or equal to row_limit.',
      path: ['preview'],
    }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe(
        'Rows materialized by the query. Exact when register_as is used; otherwise equals row_limit when truncated is true.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized rows, bounded by preview / row_limit.'),
    registered_as: z
      .string()
      .optional()
      .describe('Set when register_as was supplied and the result was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe('ISO 8601 expiry for the newly registered dataframe, when applicable.'),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when the returned rows were capped.'),
    shown: z.number().optional().describe('Number of rows returned inline.'),
    cap: z.number().optional().describe('The preview or row_limit cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results were capped by preview or row_limit — names which parameter was the binding limiter and suggests how to retrieve the rest. Absent when all rows fit in the response.',
      ),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview: input.preview }),
      rowLimit: input.row_limit,
      sourceTool: 'bls_dataframe_query',
      queryParams: { sql: input.sql },
    });

    ctx.log.info('Dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    const capped = result.truncated === true || result.rowCount > result.rows.length;
    if (capped) {
      if (input.preview !== undefined && input.preview < input.row_limit) {
        ctx.enrich.truncated({
          shown: result.rows.length,
          cap: input.preview,
          guidance:
            result.truncated === true
              ? `Query output exceeded row_limit=${input.row_limit}; only ${result.rows.length} rows were returned (capped by preview=${input.preview}). Use register_as to persist all rows to canvas.`
              : `Query produced ${result.rowCount} rows but only ${result.rows.length} were returned (capped by preview=${input.preview}). Increase preview or use register_as to persist all rows to canvas.`,
        });
      } else {
        ctx.enrich.truncated({
          shown: result.rows.length,
          cap: input.row_limit,
          guidance:
            result.truncated === true
              ? `Query output exceeded row_limit=${input.row_limit}; only ${result.rows.length} rows were materialized. Use register_as to persist all rows to canvas, or increase row_limit (max 10000).`
              : `Query produced ${result.rowCount} rows but only ${result.rows.length} were returned (capped by row_limit=${input.row_limit}). Use register_as to persist all rows to canvas, or increase row_limit (max 10000).`,
        });
      }
    }

    return {
      columns: result.columns,
      row_count: result.rowCount,
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as \`${result.registered_as}\` (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }
    const cappedNote =
      result.row_count > result.rows.length
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    lines.push(`**${result.row_count} rows**${cappedNote}\n`);

    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const header = `| ${result.columns.join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v == null) return '';
        if (typeof v === 'string') return v.replace(/\|/g, '\\|');
        if (typeof v === 'object') return JSON.stringify(v).replace(/\|/g, '\\|');
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
