/**
 * @fileoverview Run a single-statement SELECT against canvas dataframes
 * registered by bls_get_series or an earlier register_as. Layered SQL gate:
 * framework (text scan → single statement → SELECT only → parse-tree check →
 * plan-walk allowlist + denied functions) plus bridge-layer
 * denial of DuckDB system catalogs. Unavailable when CANVAS_PROVIDER_TYPE=none.
 * @module mcp-server/tools/definitions/bls-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const blsDataframeQueryTool = tool('bls_dataframe_query', {
  title: 'Query BLS Dataframes',
  description:
    'Run a single-statement SELECT against the canvas dataframes registered by bls_get_series or by an earlier register_as. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied at the bridge layer — use bls_dataframe_describe to list available dataframes. Supports JOINs, aggregates, window functions, and CTEs. Optional register_as persists the result as a new dataframe with a fresh TTL for chained analysis. Canvas SQL operations consume zero BLS API quota.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested register_as name already identifies a dataframe.',
      recovery: 'Choose a different register_as name; the existing dataframe is unchanged.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment and restart to enable dataframe tools.',
    },
  ],

  input: z.object({
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
      .optional()
      .describe(
        'Inline row preview count, clamped to the applied row_limit (at most 10000) with notice. Defaults to row_limit. Set lower (e.g. 50) when chaining via register_as and only a sample is needed immediately.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .default(1000)
      .describe(
        'Response row limit (default 1000); requests above 10000 are clamped with notice. Full results live on-canvas under register_as when provided.',
      ),
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
      .describe(
        'ISO 8601 expiry fixed at the new dataframe’s creation, when applicable; reads do not extend it.',
      ),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when the returned rows were capped.'),
    shown: z.number().optional().describe('Number of rows returned inline.'),
    cap: z.number().optional().describe('The preview or row_limit cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Requested and applied limits when clamped, plus guidance when preview or row_limit capped the result and how to retrieve the rest. Absent when limits were unchanged and all rows fit.',
      ),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    const rowLimit = Math.min(input.row_limit, 10000);
    const preview = Math.min(input.preview ?? rowLimit, rowLimit);
    const clampNotice =
      input.row_limit !== rowLimit || (input.preview !== undefined && input.preview !== preview)
        ? `Limits: requested row_limit=${input.row_limit}, preview=${input.preview ?? 'default'}; applied row_limit=${rowLimit}, preview=${preview}.`
        : undefined;
    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview }),
      rowLimit,
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
      let guidance: string;
      if (preview < rowLimit) {
        guidance = meta?.tableName
          ? `The complete result is materialized in dataframe ${meta.tableName}; increase preview only to return more rows inline.`
          : result.truncated === true
            ? `Query output exceeded row_limit=${rowLimit}; only ${result.rows.length} rows were returned (capped by preview=${preview}). Use register_as to persist all rows to canvas.`
            : `Query produced ${result.rowCount} rows but only ${result.rows.length} were returned (capped by preview=${preview}). Increase preview or use register_as to persist all rows to canvas.`;
      } else {
        guidance = meta?.tableName
          ? `The complete result is materialized in dataframe ${meta.tableName}; query that dataframe with a narrower SELECT to retrieve more rows inline.`
          : result.truncated === true
            ? `Query output exceeded row_limit=${rowLimit}; only ${result.rows.length} rows were materialized. Use register_as to persist all rows to canvas, or increase row_limit (max 10000).`
            : `Query produced ${result.rowCount} rows but only ${result.rows.length} were returned (capped by row_limit=${rowLimit}). Use register_as to persist all rows to canvas, or increase row_limit (max 10000).`;
      }
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap: preview,
        guidance: `${clampNotice ? `${clampNotice} ` : ''}${guidance}`,
      });
    } else if (clampNotice) {
      ctx.enrich.notice(clampNotice);
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

    const header = `| ${result.columns.map(escapeMarkdownInline).join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v == null) return '';
        if (typeof v === 'string') return escapeMarkdownInline(v);
        if (typeof v === 'object') return escapeMarkdownInline(JSON.stringify(v));
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
