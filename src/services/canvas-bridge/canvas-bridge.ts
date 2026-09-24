/**
 * @fileoverview Adapter between BLS tools and the framework DataCanvas
 * primitive. Holds one shared canvas per tenant, generates `df_XXXXX_XXXXX`
 * table names, registers rows under the caller's declared schema, stores the
 * canvas-reported schema for `register_as` results, tracks per-table TTL +
 * provenance in `ctx.state`, and lazy-sweeps expired tables on every public op.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  assertValidIdentifier,
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
const CANVAS_ID_KEY = 'canvas-id';
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
   * "enable canvas" is the wrong recovery to hand back.
   */
  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult> {
    try {
      await this.sweepExpired(ctx);
      const instance = await this.acquireSharedCanvas(ctx);
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

  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
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
    await this.sweepExpired(ctx);
    const instance = await this.acquireSharedCanvas(ctx);

    const registerAs = options.registerAs;
    const result = await instance.query(sql, {
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(registerAs !== undefined && { registerAs }),
      denySystemCatalogs: true,
      signal: ctx.signal,
    });

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      /**
       * `QueryResult` carries column names only; the canvas's own describe of
       * the materialized table is the schema. A failed read fails the call
       * rather than storing a guessed one.
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
   * reaches. `canvas_drop_failed` keeps both for a retry.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    // A name that can never be a table is an input error, not a provider failure.
    assertValidIdentifier(tableName, 'table');
    await this.sweepExpired(ctx);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;

    let dropped: boolean;
    try {
      const instance = await this.acquireSharedCanvas(ctx);
      dropped = await instance.drop(tableName);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw serviceUnavailable(
        `Dropping dataframe ${tableName} failed; the dataframe and its metadata were kept.`,
        {
          reason: 'canvas_drop_failed',
          retryable: true,
          tableName,
          ...ctx.recoveryFor('canvas_drop_failed'),
        },
        { cause: error },
      );
    }
    await ctx.state.delete(metaKey);
    return dropped || hadMeta;
  }

  /**
   * Drop expired dataframes. An entry whose drop fails keeps its metadata and
   * is retried by the next operation; the sweep never fails the operation
   * that triggered it.
   */
  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      try {
        instance ??= await this.acquireSharedCanvas(ctx);
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
   * Resolve the tenant's shared canvas, minting a replacement only when the
   * stored one no longer exists. Any other acquire failure propagates: a
   * replacement would orphan every table the stored canvas still holds.
   */
  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const reqCtx = ctx as unknown as Parameters<DataCanvas['acquire']>[1];
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, reqCtx);
      } catch (error) {
        if (!(error instanceof McpError && error.data?.reason === 'canvas_not_found')) throw error;
        await ctx.state.delete(CANVAS_ID_KEY);
      }
    }
    const instance = await this.canvas.acquire(undefined, reqCtx);
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
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
