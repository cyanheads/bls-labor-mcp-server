/**
 * @fileoverview List the canvas dataframes materialized by bls_get_series or
 * bls_dataframe_query register_as, with provenance, TTL, row count, and column
 * schema. Requires CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/bls-dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const blsDataframeDescribeTool = tool('bls_dataframe_describe', {
  title: 'Describe BLS Dataframes',
  description:
    'List canvas dataframes materialized by bls_get_series or by bls_dataframe_query register_as, with provenance (source tool, query parameters), TTL, row count, and column schema. Use before writing SQL to confirm column names and types. Lazy-sweeps expired tables before responding. Requires CANVAS_PROVIDER_TYPE=duckdb.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment and restart to enable dataframe tools.',
    },
    {
      reason: 'invalid_dataframe_name',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'name is not blank and is not a canvas identifier, so no dataframe can carry it.',
      recovery:
        'Pass a df_XXXXX_XXXXX name from bls_get_series or a register_as name from bls_dataframe_query, or omit name to list every dataframe.',
    },
  ],

  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Optional dataframe name to describe a single dataframe — a df_XXXXX_XXXXX name from bls_get_series, or a register_as name from bls_dataframe_query. Omit, or leave blank, to list all active dataframes.',
      ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Canvas table name — df_XXXXX_XXXXX, or the register_as name given.'),
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
                    type: z
                      .string()
                      .describe(
                        'Column type as the canvas reports it: VARCHAR, INTEGER, BIGINT, DOUBLE, BOOLEAN, DATE, TIMESTAMP, JSON, or BLOB. A register_as column of another DuckDB type (DECIMAL, HUGEINT from SUM over integers, SMALLINT, a list) reports VARCHAR, though SQL still sees its real type.',
                      ),
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
    // Form-style clients send "" for an empty field, so a blank name means omitted.
    const name = input.name?.trim() || undefined;
    if (name !== undefined && !CANVAS_IDENTIFIER_REGEX.test(name)) {
      throw ctx.fail(
        'invalid_dataframe_name',
        'Dataframe names are canvas identifiers: a letter or underscore, then letters, digits, or underscores, at most 63 characters — a df_XXXXX_XXXXX name from bls_get_series or a bls_dataframe_query register_as name.',
        { ...ctx.recoveryFor('invalid_dataframe_name') },
      );
    }

    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const entries = await bridge.describe(ctx, name);
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
