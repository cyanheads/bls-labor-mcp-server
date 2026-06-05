/**
 * @fileoverview BLS observations mirror service. Wraps the framework's
 * `defineMirror` / `sqliteMirrorStore` to provide a persistent, self-refreshing
 * local mirror of LABSTAT `{survey}.data.*` observation files, bypassing the
 * 500/day BLS API quota. Default OFF — enable with
 * `BLS_OBSERVATIONS_MIRROR_ENABLED=true`. Requires a one-time bootstrap before
 * serving mirror traffic. Falls back to the live BLS API when not ready (or when
 * a requested series has no mirror rows) unless
 * `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=false`.
 * @module services/bls-observations/bls-observations-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  defineMirror,
  type Mirror,
  type MirrorRunOptions,
  type MirrorStatus,
  type QueryFilter,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { getServerConfig } from '@/config/server-config.js';
import { observationsSync } from './ingester.js';
import type { MirrorSeriesResult } from './types.js';

/** Re-export MirrorRunOptions for callers (subprocess.ts). */
export type { MirrorRunOptions };

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class BlsObservationsService {
  private readonly mirror: Mirror;
  private readonly catalogBaseUrl: string;
  private readonly userAgent: string;

  constructor(mirrorPath: string, catalogBaseUrl: string, userAgent: string) {
    this.catalogBaseUrl = catalogBaseUrl;
    this.userAgent = userAgent;

    this.mirror = defineMirror({
      name: 'bls-observations',
      store: sqliteMirrorStore({
        path: mirrorPath,
        table: 'bls_observations',
        primaryKey: 'row_key',
        columns: {
          row_key: 'TEXT',
          series_id: 'TEXT',
          year: 'TEXT',
          period: 'TEXT',
          value: 'TEXT',
          footnote_codes: 'TEXT',
        },
        fts: [], // no FTS — queries are series_id-filtered point lookups
        indexes: [{ columns: ['series_id', 'year', 'period'] }],
      }),
      sync: (ctx) =>
        observationsSync(ctx, {
          catalogBaseUrl: this.catalogBaseUrl,
          userAgent: this.userAgent,
        }),
    });
  }

  /** Run a sync (init or refresh). Resolves when complete. */
  runSync(options: MirrorRunOptions): Promise<SyncResult> {
    return this.mirror.runSync(options);
  }

  /** True once a full sync has ever completed. */
  ready(): Promise<boolean> {
    return this.mirror.ready();
  }

  /** Current sync status. */
  status(): Promise<MirrorStatus> {
    return this.mirror.status();
  }

  /**
   * Query observations for the given series IDs. Returns rows for all IDs that
   * have mirror data, and records which IDs had zero rows (for live fallback).
   * Optional year/period filter narrows results.
   */
  async queryBySeries(opts: {
    seriesIds: string[];
    startYear?: number;
    endYear?: number;
  }): Promise<MirrorSeriesResult> {
    const { seriesIds, startYear, endYear } = opts;

    const filters: QueryFilter[] = [{ column: 'series_id', op: 'in', value: seriesIds }];
    if (startYear !== undefined) {
      filters.push({ column: 'year', op: 'gte', value: String(startYear) });
    }
    if (endYear !== undefined) {
      filters.push({ column: 'year', op: 'lte', value: String(endYear) });
    }

    const { rows } = await this.mirror.query({
      filters,
      sort: { column: 'year', direction: 'desc' },
      limit: 1_000_000, // effectively unbounded — series_id filter is the real gate
      offset: 0,
    });

    // Determine which requested IDs are covered
    const foundIds = new Set(rows.map((r) => r['series_id'] as string));
    const missedIds = seriesIds.filter((id) => !foundIds.has(id));

    return {
      observations: rows as unknown as import('./types.js').ObservationRow[],
      complete: missedIds.length === 0,
      missedIds,
    };
  }

  /**
   * Query the single most recent observation for each series ID.
   * Returns the latest row per ID (highest year+period lexicographically).
   */
  async queryLatest(seriesIds: string[]): Promise<MirrorSeriesResult> {
    const { rows } = await this.mirror.query({
      filters: [{ column: 'series_id', op: 'in', value: seriesIds } satisfies QueryFilter],
      sort: { column: 'year', direction: 'desc' },
      limit: 1_000_000,
      offset: 0,
    });

    // Pick the most recent row per series_id by (year, period). The store sorts on
    // year only, so the latest period within the newest year must be compared
    // explicitly — within a series all periods share a prefix (e.g. M01..M12), so
    // lexical comparison is correct.
    const latestBySeriesId = new Map<string, import('./types.js').ObservationRow>();
    for (const raw of rows) {
      const row = raw as unknown as import('./types.js').ObservationRow;
      const existing = latestBySeriesId.get(row.series_id);
      if (
        !existing ||
        row.year > existing.year ||
        (row.year === existing.year && row.period > existing.period)
      ) {
        latestBySeriesId.set(row.series_id, row);
      }
    }

    const observations = [...latestBySeriesId.values()];
    const foundIds = new Set(observations.map((r) => r.series_id));
    const missedIds = seriesIds.filter((id) => !foundIds.has(id));

    return {
      observations,
      complete: missedIds.length === 0,
      missedIds,
    };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: BlsObservationsService | undefined;

export function initBlsObservationsService(_config: AppConfig, _storage: StorageService): void {
  const cfg = getServerConfig();
  if (!cfg.observationsMirrorEnabled) {
    // Not enabled — don't create the mirror store (avoids opening SQLite on startup).
    return;
  }
  _service = new BlsObservationsService(
    cfg.observationsMirrorPath,
    cfg.catalogBaseUrl,
    cfg.userAgent,
  );
}

export function getBlsObservationsService(): BlsObservationsService {
  if (!_service) {
    throw new Error(
      'BlsObservationsService not initialized — ensure BLS_OBSERVATIONS_MIRROR_ENABLED=true and call initBlsObservationsService() in setup()',
    );
  }
  return _service;
}

/** Whether the service has been initialized (mirror enabled and init called). */
export function isBlsObservationsServiceReady(): boolean {
  return _service !== undefined;
}
