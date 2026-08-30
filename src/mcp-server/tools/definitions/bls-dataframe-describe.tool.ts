/**
 * @fileoverview List the canvas dataframes materialized by bls_get_series,
 * with provenance, TTL, row count, and column schema. Requires
 * CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/bls-dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const blsDataframeDescribeTool = tool('bls_dataframe_describe', {
  title: 'Describe BLS Dataframes',
  description:
    'List canvas dataframes materialized by bls_get_series, with provenance (source tool, query parameters), TTL, row count, and column schema. Use before writing SQL to confirm column names. Lazy-sweeps expired tables before responding. Requires CANVAS_PROVIDER_TYPE=duckdb.',
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

  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Optional table name (df_XXXXX_XXXXX) to describe a single dataframe. Omit to list all active dataframes.',
      ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Canvas table name (df_XXXXX_XXXXX).'),
            source_tool: z.string().describe('Tool that produced this dataframe.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe('Input parameters the source tool was called with.'),
            created_at: z.string().describe('ISO 8601 creation timestamp.'),
            expires_at: z.string().describe('ISO 8601 expiry timestamp (sliding TTL).'),
            row_count: z.number().describe('Rows materialized in the dataframe.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB column type (VARCHAR, BIGINT, DOUBLE, ...).'),
                    nullable: z.boolean().describe('Whether the column permits NULL.'),
                  })
                  .describe('Schema descriptor for one column in the dataframe.'),
              )
              .describe('Column schema — all BLS dataframe columns are nullable.'),
          })
          .describe('Metadata for one canvas dataframe.'),
      )
      .describe('Active dataframes for this tenant, newest first.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const entries = await bridge.describe(ctx, input.name);
    return {
      dataframes: entries.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        column_schema: meta.columnSchema.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    if (result.dataframes.length === 0) {
      return [{ type: 'text', text: 'No active dataframes.' }];
    }
    const lines: string[] = [`**${result.dataframes.length} active dataframe(s):**\n`];
    for (const df of result.dataframes) {
      lines.push(`### ${df.name}`);
      lines.push(`- Source: ${df.source_tool}`);
      lines.push(`- Rows: ${df.row_count}`);
      lines.push(`- Created: ${df.created_at} — Expires: ${df.expires_at}`);
      const params = Object.entries(df.query_params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      if (params) lines.push(`- Params: ${params}`);
      const cols = df.column_schema
        .map((c) => `${c.name}:${c.type}${c.nullable ? ' (nullable)' : ''}`)
        .join(', ');
      lines.push(`- Columns: ${cols}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
