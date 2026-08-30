/**
 * @fileoverview Adapter between BLS tools and the framework DataCanvas
 * primitive. Holds one shared canvas per tenant, generates `df_XXXXX_XXXXX`
 * table names, derives all-nullable schemas (sparse BLS columns must not trip
 * NOT NULL appender rollbacks), tracks per-table TTL + provenance in `ctx.state`,
 * and lazy-sweeps expired tables on every public op.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
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

export function deriveAllNullableSchema(rows: Record<string, unknown>[]): ColumnSchema[] {
  // inferSchemaFromRows emits nullable: true for every column (mcp-ts-core ≥ 0.10.4),
  // so sparse BLS columns never trip a NOT NULL appender rollback when this schema is
  // passed explicitly to registerTable.
  return inferSchemaFromRows(rows);
}

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
      const schema = deriveAllNullableSchema(options.rows);

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
      throw serviceUnavailable(
        `Canvas is configured but registering the ${options.rows.length}-row dataframe for ${options.sourceTool} failed, so the full result set cannot be returned.`,
        {
          reason: 'canvas_registration_failed',
          sourceTool: options.sourceTool,
          rowCount: options.rows.length,
          ...ctx.recoveryFor('canvas_registration_failed'),
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
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      meta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool ?? 'bls_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        columnSchema: result.columns.map((name) => ({
          name,
          type: 'VARCHAR',
          nullable: true,
        })),
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
    }

    return meta ? { result, meta } : { result };
  }

  async drop(ctx: Context, tableName: string): Promise<boolean> {
    await this.sweepExpired(ctx);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);

    try {
      const instance = await this.acquireSharedCanvas(ctx);
      const dropped = await instance.drop(tableName);
      return dropped || hadMeta;
    } catch (error) {
      ctx.log.warning('Canvas drop failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
      return hadMeta;
    }
  }

  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      instance ??= await this.acquireSharedCanvas(ctx).catch(() => undefined);
      if (instance) {
        try {
          await instance.drop(meta.tableName);
        } catch (error) {
          ctx.log.warning('TTL sweep drop failed', {
            tableName: meta.tableName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const reqCtx = ctx as unknown as Parameters<DataCanvas['acquire']>[1];
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, reqCtx);
      } catch {
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
