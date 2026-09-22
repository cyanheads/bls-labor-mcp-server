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

import {
  defineMirror,
  type Migration,
  type Mirror,
  type MirrorLogger,
  type MirrorRunOptions,
  type MirrorStatus,
  type QueryFilter,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isAnnualAveragePeriod } from '@/services/bls-periods/period-codes.js';
import { observationsSync } from './ingester.js';
import type { MirrorSeriesResult, ObservationRow } from './types.js';

/** Re-export MirrorRunOptions for callers (subprocess.ts). */
export type { MirrorRunOptions };

// ---------------------------------------------------------------------------
// Latest-observation ordering
// ---------------------------------------------------------------------------

/**
 * True when `row` is a better answer to "latest" than `existing`.
 *
 * A real observation always beats an annual average. Ordering on (year, period)
 * alone would not: an average shares the year it summarizes and lexically
 * outranks the periods it is built from (`"M13" > "M12"`, `"Q05" > "Q04"`,
 * `"S03" > "S02"`), so the year's mean would be served as the current reading.
 * An average wins only against another average — for a series holding nothing
 * else, it is that series' only observation.
 *
 * Year is compared before period, and BLS years are 4-digit strings, so lexical
 * order is chronological. Within a series the real periods share a cadence
 * prefix (M01–M12, Q01–Q04, S01–S02), so lexical order is chronological there
 * too.
 */
function isLaterObservation(row: ObservationRow, existing: ObservationRow): boolean {
  const rowIsAverage = isAnnualAveragePeriod(row.period);
  const existingIsAverage = isAnnualAveragePeriod(existing.period);
  if (rowIsAverage !== existingIsAverage) return existingIsAverage;

  return row.year > existing.year || (row.year === existing.year && row.period > existing.period);
}

// ---------------------------------------------------------------------------
// Ingester logging
// ---------------------------------------------------------------------------

/**
 * Sink for the ingester's own records — the same framework logger the mirror
 * runner writes to. A harvest runs outside the request pipeline (cron job or
 * CLI script), so each call wraps its metadata in a fresh `RequestContext`, the
 * shape the framework logger expects.
 */
const INGESTER_LOG: MirrorLogger = {
  warning: (message, meta) =>
    logger.warning(
      message,
      requestContextService.createRequestContext({
        operation: 'bls-observations-sync',
        ...(meta && { additionalContext: meta }),
      }),
    ),
};

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * Drop the durable high-water mark so the next refresh re-reads every LABSTAT
 * file instead of skipping the ones whose `Last-Modified` predates it.
 *
 * A mirror synced before the ingester kept the `-` missing-value sentinel is
 * missing those rows, and nothing upstream changed to bring them back — without
 * this, the gap would persist for as long as BLS leaves the files alone. The
 * completion marker is untouched, so the mirror stays ready and keeps serving
 * while it re-reads. On a brand-new store the checkpoint is already NULL and
 * this is a no-op.
 */
const MIRROR_SENTINEL_BACKFILL: Migration = {
  version: 2,
  up: (handle) => {
    handle.exec('UPDATE mirror_sync_state SET checkpoint = NULL');
  },
};

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
        version: 2,
        migrations: [MIRROR_SENTINEL_BACKFILL],
      }),
      sync: (ctx) =>
        observationsSync(ctx, {
          catalogBaseUrl: this.catalogBaseUrl,
          userAgent: this.userAgent,
          log: INGESTER_LOG,
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

  /** Close the mirror's SQLite handle. A store never opened closes as a no-op. */
  shutdown(): Promise<void> {
    return this.mirror.close();
  }

  /**
   * Query observations for the given series IDs. Returns rows for all IDs that
   * have mirror data, and records which IDs had zero rows (for live fallback).
   * Optional year/period filter narrows results.
   *
   * Annual-average rows are dropped unless `annualAverage` is set. LABSTAT bakes
   * them into the bulk files unconditionally — no flag involved, unlike the live
   * API — so without this the mirror would answer an identical request with
   * extra rows the live path never returns.
   */
  async queryBySeries(opts: {
    annualAverage?: boolean;
    endYear?: number;
    seriesIds: string[];
    startYear?: number;
  }): Promise<MirrorSeriesResult> {
    const { seriesIds, startYear, endYear, annualAverage = false } = opts;

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

    /**
     * Coverage is judged before the annual-average filter: a series the mirror
     * holds is covered even if the filter empties it for this range, so a live
     * fetch isn't spent re-asking for rows the caller declined.
     */
    const foundIds = new Set(rows.map((r) => r.series_id as string));
    const missedIds = seriesIds.filter((id) => !foundIds.has(id));

    const observations = rows as unknown as ObservationRow[];

    return {
      observations: annualAverage
        ? observations
        : observations.filter((r) => !isAnnualAveragePeriod(r.period)),
      complete: missedIds.length === 0,
      missedIds,
    };
  }

  /**
   * Query the single most recent real observation for each series ID.
   *
   * Mirrors the live API's `?latest=true`, which never sends `annualaverage` and
   * so never answers with a year's mean. There is no opt-in here: an annual
   * average is not a candidate for "latest" — see {@link isLaterObservation}.
   */
  async queryLatest(seriesIds: string[]): Promise<MirrorSeriesResult> {
    const { rows } = await this.mirror.query({
      filters: [{ column: 'series_id', op: 'in', value: seriesIds } satisfies QueryFilter],
      sort: { column: 'year', direction: 'desc' },
      limit: 1_000_000,
      offset: 0,
    });

    // The store sorts on year only, so the winning row per series is chosen here.
    const latestBySeriesId = new Map<string, ObservationRow>();
    for (const raw of rows) {
      const row = raw as unknown as ObservationRow;
      const existing = latestBySeriesId.get(row.series_id);
      if (!existing || isLaterObservation(row, existing)) {
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

/**
 * Construct the mirror service from server configuration, or no-op when the
 * mirror is switched off. Takes no arguments: every input the mirror needs comes
 * from `getServerConfig()`, which lets the sync subprocess — which holds neither
 * core handle — call it the same way `setup()` does.
 */
export function initBlsObservationsService(): void {
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

/** Release the mirror's SQLite handle. Wired to `createApp({ teardown })`. */
export async function shutdownBlsObservationsService(): Promise<void> {
  const service = _service;
  _service = undefined;
  await service?.shutdown();
}
