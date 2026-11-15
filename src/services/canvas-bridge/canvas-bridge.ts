/**
 * @fileoverview Adapter between BLS tools and the framework DataCanvas
 * primitive. Keeps one shared canvas per tenant through
 * `DataCanvas.acquireShared`, generates `df_XXXXX_XXXXX` table names, registers
 * rows under the caller's declared schema, stores the canvas-reported schema
 * for `register_as` results, tracks per-table TTL + provenance in `ctx.state`,
 * and lazy-sweeps expired tables on every public op.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  assertNoSystemCatalogs,
  assertValidIdentifier,
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Per-table provenance + TTL metadata persisted in `ctx.state`. */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
  createdAt: string;
  expiresAt: string;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
}

export interface RegisterDataframeResult {
  columnSchema: ColumnSchema[];
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

export function toDatasetField(registered: RegisterDataframeResult): {
  name: string;
  row_count: number;
  expires_at: string;
} {
  return {
    name: registered.tableName,
    row_count: registered.rowCount,
    expires_at: registered.expiresAt,
  };
}

export interface RegisterDataframeOptions {
  /**
   * One caller-written sentence naming the request parameters these rows cover.
   * Appended to the failure message and to its recovery hint, so an agent whose
   * spill failed sees the bounds it can narrow — including any the calling
   * handler resolved rather than the caller supplying.
   */
  appliedScope?: string;
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  /**
   * The table's columns, declared by the caller that built the rows. Declared
   * rather than inferred, so a column's type does not depend on which values a
   * batch happened to hold.
   */
  schema: ColumnSchema[];
  sourceTool: string;
}

export interface BridgeQueryOptions {
  preview?: number;
  queryParams?: Record<string, unknown>;
  registerAs?: string;
  rowLimit?: number;
  sourceTool?: string;
}

const META_PREFIX = 'df-meta/';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class CanvasBridge {
  constructor(private readonly canvas: DataCanvas) {}

  /**
   * Register `options.rows` as a canvas table and return its handle.
   *
   * Throws on failure rather than returning a sentinel. Callers register a
   * dataframe precisely because the rows do not fit inline, so a swallowed
   * failure would leave them returning a truncated preview that reads as a
   * complete result. `canvas_registration_failed` is deliberately distinct from
   * `canvas_unavailable`: canvas is configured here — only this call failed, so
   * "enable canvas" is the wrong recovery to hand back. A cancelled call fails
   * as cancelled.
   */
  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult> {
    try {
      const instance = await this.stagingCanvas(ctx);
      await this.sweepExpired(ctx, instance);
      const tableName = this.mintTableName();
      const { schema } = options;

      const result = await instance.registerTable(tableName, options.rows, { schema });

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        columnSchema: schema,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);

      ctx.log.info('Dataframe registered', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });

      return {
        tableName: result.tableName,
        rowCount: result.rowCount,
        expiresAt: meta.expiresAt,
        columnSchema: schema,
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('Dataframe registration failed', {
        error: error instanceof Error ? error.message : String(error),
        sourceTool: options.sourceTool,
      });
      const scope = options.appliedScope ? ` ${options.appliedScope}` : '';
      const declared = ctx.recoveryFor('canvas_registration_failed');
      throw serviceUnavailable(
        `Canvas is configured but registering the ${options.rows.length}-row dataframe for ${options.sourceTool} failed, so the full result set cannot be returned.${scope}`,
        {
          reason: 'canvas_registration_failed',
          sourceTool: options.sourceTool,
          rowCount: options.rows.length,
          ...(scope && 'recovery' in declared
            ? { recovery: { hint: `${declared.recovery.hint}${scope}` } }
            : declared),
        },
        { cause: error },
      );
    }
  }

  /**
   * List stored dataframe metadata, newest first. Never mints a canvas: with no
   * live one, its records are purged and nothing is listed.
   */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    const instance = await this.liveCanvas(ctx);
    if (!instance) return [];
    await this.sweepExpired(ctx, instance);
    if (tableName) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    const registerAs = options.registerAs;
    // Blank registers nothing, as the canvas reads it: form-style clients send "" for an empty field.
    if (registerAs) {
      /**
       * The framework's catalog gate, run on the name alone, refuses it before
       * anything is staged: a table under a system catalog's name is one no
       * later query may reference. The identifier rule runs first, so the gate
       * only ever reads a name of at most 63 characters.
       */
      assertValidIdentifier(registerAs, 'table');
      try {
        assertNoSystemCatalogs(registerAs);
      } catch (error) {
        throw validationError(
          `register_as ${registerAs} names a DuckDB system catalog, which canvas SQL cannot reference; nothing was staged.`,
          { reason: 'register_as_system_catalog', registerAs },
          { cause: error, literals: [registerAs] },
        );
      }
    }

    const instance = await this.stagingCanvas(ctx);
    await this.sweepExpired(ctx, instance);

    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        ...(options.preview !== undefined && { preview: options.preview }),
        ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
        ...(registerAs !== undefined && { registerAs }),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (error) {
      if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
      // The name the caller sends back renders as a code span (`literals`), never escaped.
      if (error.data?.reason === 'register_as_clash' && registerAs !== undefined) {
        throw new McpError(
          error.code,
          `Canvas table ${registerAs} already exists. Choose a different register_as name.`,
          error.data,
          { cause: error, literals: [registerAs] },
        );
      }
      const missing = error.data?.tableName;
      if (error.data?.reason === 'missing_table' && typeof missing === 'string') {
        // The framework quotes the name and points at a generic describe tool; name ours.
        throw new McpError(
          error.code,
          `Canvas table ${missing} does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
          {
            ...error.data,
            recovery: {
              hint: 'Re-run the tool that produced this table to stage it again, or list the currently staged tables with bls_dataframe_describe.',
            },
          },
          { cause: error, literals: [missing] },
        );
      }
      throw error;
    }

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      /**
       * `QueryResult` carries column names only; the canvas's own describe of
       * the materialized table is the schema. A failed read fails the call
       * rather than storing a guessed one. No `signal`: an abort here would
       * leave the materialized table with no record, which the sweep never
       * reaches.
       */
      const [table] = await instance.describe({ tableName: result.tableName });
      if (!table) {
        throw new Error(`Canvas reported no table ${result.tableName} after registering it.`);
      }
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      meta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool ?? 'bls_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        columnSchema: table.columns,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
    }

    return meta ? { result, meta } : { result };
  }

  /**
   * Drop a dataframe's table, then its metadata. Metadata goes only once the
   * canvas confirms the drop or the table's absence, so a failed drop never
   * leaves a live table that describe no longer lists and the sweep no longer
   * reaches. `canvas_drop_failed` keeps both for a retry. With no live canvas
   * there is nothing to drop: its records are purged and the result is false.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    // A name that can never be a table is an input error, not a provider failure.
    assertValidIdentifier(tableName, 'table');
    const dropFailed = (error: unknown) =>
      ctx.signal.aborted
        ? error
        : serviceUnavailable(
            `Dropping dataframe ${tableName} failed; the dataframe and its metadata were kept.`,
            {
              reason: 'canvas_drop_failed',
              retryable: true,
              tableName,
              ...ctx.recoveryFor('canvas_drop_failed'),
            },
            { cause: error, literals: [tableName] },
          );

    let instance: CanvasInstance | undefined;
    try {
      instance = await this.liveCanvas(ctx);
    } catch (error) {
      throw dropFailed(error);
    }
    if (!instance) return false;
    await this.sweepExpired(ctx, instance);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;

    let dropped: boolean;
    try {
      dropped = await instance.drop(tableName);
    } catch (error) {
      throw dropFailed(error);
    }
    await ctx.state.delete(metaKey);
    return dropped || hadMeta;
  }

  /**
   * Drop expired dataframes from `instance`, the live canvas the triggering
   * operation resolved. An entry whose drop fails keeps its metadata and is
   * retried by the next operation; the sweep never fails the operation that
   * triggered it.
   */
  private async sweepExpired(ctx: Context, instance: CanvasInstance): Promise<void> {
    const nowIso = new Date().toISOString();
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      try {
        await instance.drop(meta.tableName);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.log.warning('TTL sweep kept an expired dataframe it could not drop', {
          tableName: meta.tableName,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired dataframe swept', {
        tableName: meta.tableName,
        expiredAt: meta.expiresAt,
      });
    }
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  /**
   * The tenant's shared canvas for staging, minted once under concurrent first
   * calls. The id lives in `ctx.state` under `canvas-id`, the key 0.7.1 wrote.
   * A stored id that fails for any reason other than `canvas_not_found`
   * propagates and keeps the id and every record: a replacement would orphan
   * every table the stored canvas still holds.
   */
  private stagingCanvas(ctx: Context): Promise<CanvasInstance> {
    return this.canvas.acquireShared(ctx, { onReplace: () => this.purgeMeta(ctx) });
  }

  /** The live shared canvas, or `undefined` without minting one. */
  private liveCanvas(ctx: Context): Promise<CanvasInstance | undefined> {
    return this.canvas.acquireShared(ctx, {
      create: false,
      onReplace: () => this.purgeMeta(ctx),
    });
  }

  /**
   * Delete every dataframe record. Runs only when no live canvas is found, so
   * every record names a table on a dead canvas. Idempotent: the framework
   * reruns it when it, the mint, or the call holding the turn fails.
   */
  private async purgeMeta(ctx: Context): Promise<void> {
    const keys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) keys.push(key);
    if (keys.length > 0) await ctx.state.deleteMany(keys);
  }

  private mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }
}

let _bridge: CanvasBridge | undefined;

export function initCanvasBridge(canvas: DataCanvas | undefined): void {
  _bridge = canvas ? new CanvasBridge(canvas) : undefined;
}

export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
