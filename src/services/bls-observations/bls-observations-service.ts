/**
 * @fileoverview BLS observations mirror service. Wraps the framework's
 * `defineMirror` / `sqliteMirrorStore` to provide a persistent, self-refreshing
 * local mirror of LABSTAT `{survey}.data.*` observation files, bypassing the
 * 500/day BLS API quota. Default OFF — enable with
 * `BLS_OBSERVATIONS_MIRROR_ENABLED=true`. Requires a one-time bootstrap before
 * serving mirror traffic. Falls back to the live BLS API when not ready (or when
 * a requested series has no mirror rows) unless
 * `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=false`. Beside the rows, the store
 * keeps each survey's footnote code table, read on every sync, so callers can
 * decode the codes the rows carry.
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
  type SyncContext,
  type SyncPage,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { isAnnualAveragePeriod } from '@/services/bls-periods/period-codes.js';
import { type IngesterOptions, observationsSync, syncFootnoteTables } from './ingester.js';
import type { MirrorSeriesResult, ObservationRow, SyncGaps } from './types.js';

/** Re-export MirrorRunOptions for callers (subprocess.ts). */
export type { MirrorRunOptions };

/** A completed sync's counters, with what it did not cover. */
export type ObservationsSyncResult = SyncResult & SyncGaps;

// ---------------------------------------------------------------------------
// Latest-observation ordering
// ---------------------------------------------------------------------------

/**
 * True when `row` is a better answer to "latest" than `existing`.
 *
 * A real observation always beats an annual average. Ordering on (year, period)
 * alone would not: an average shares the year it summarizes and lexically
 * outranks the periods it is built from (`"M13" > "M12"`, `"Q05" > "Q04"`,
 * `"S03" > "S02"`), so the annual summary would be served as the current reading.
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

/**
 * Drop the high-water mark, and an interrupted init's resume cursor, so the
 * next run reads every data file the survey directory listings name.
 *
 * Data files come from each survey's directory listing, no longer from its
 * `{abbr}.txt` description, which misnamed or omitted many of them (all 71 of
 * PC's, ten of CE's, one each of WP's and JT's). A mirror synced before that
 * holds a checkpoint newer than those files, and a refresh skips every file no
 * newer than it — without this, each would arrive only when BLS next republishes
 * it. A resume cursor indexes the old file list, so resuming from it could skip
 * a file or start one partway through; an init without a cursor starts over.
 * Stored rows stay (a re-read upserts them) and the completion marker is
 * untouched, so the mirror keeps serving while it re-reads.
 */
const MIRROR_LISTING_DISCOVERY_RESET: Migration = {
  version: 3,
  up: (handle) => {
    handle.exec('UPDATE mirror_sync_state SET checkpoint = NULL, cursor = NULL');
  },
};

/**
 * Each survey's `{abbr}.footnote` code table, replaced on every sync and decoded
 * into observations at read time. The rows store only codes, so keeping the
 * text beside them needs no backfill, and BLS's rewording reaches every row on
 * the next sync whether or not a data file changed.
 */
const MIRROR_FOOTNOTE_TABLE: Migration = {
  version: 4,
  up: (handle) => {
    handle.exec(`CREATE TABLE IF NOT EXISTS bls_footnotes (
      survey TEXT NOT NULL,
      code TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (survey, code)
    ) WITHOUT ROWID`);
  },
};

/** The survey a SeriesID belongs to: BLS SeriesIDs open with the survey's two-letter code. */
function surveyOf(seriesId: string): string {
  return seriesId.slice(0, 2).toLowerCase();
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class BlsObservationsService {
  private readonly mirror: Mirror;
  private readonly ingester: IngesterOptions;
  /** Gaps the last completed sync reported; `defineMirror` runs one sync at a time. */
  private lastGaps: SyncGaps | undefined;

  /**
   * `log` receives the sync's records — the runner's and the ingester's. The
   * sync subprocess passes its stdout logger; a server that only queries the
   * mirror passes none, and the runner falls back to the framework logger.
   */
  constructor(mirrorPath: string, catalogBaseUrl: string, userAgent: string, log?: MirrorLogger) {
    this.ingester = { catalogBaseUrl, userAgent, ...(log && { log }) };

    this.mirror = defineMirror({
      name: 'bls-observations',
      ...(log && { logger: log }),
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
        version: 4,
        migrations: [
          MIRROR_SENTINEL_BACKFILL,
          MIRROR_LISTING_DISCOVERY_RESET,
          MIRROR_FOOTNOTE_TABLE,
        ],
      }),
      sync: (ctx) => this.harvest(ctx),
    });
  }

  /**
   * One sync run: replace the footnote tables, then run the ingester, keeping
   * the gaps it returns for {@link runSync}.
   */
  private async *harvest(ctx: SyncContext): AsyncGenerator<SyncPage> {
    await syncFootnoteTables(
      this.ingester,
      (survey, footnotes) => this.saveFootnotes(survey, footnotes),
      ctx.signal,
    );
    this.lastGaps = yield* observationsSync(ctx, this.ingester);
  }

  /** Replace one survey's stored footnote table. */
  private async saveFootnotes(
    survey: string,
    footnotes: ReadonlyMap<string, string>,
  ): Promise<void> {
    const db = await this.mirror.raw();
    db.transaction(() => {
      db.prepare('DELETE FROM bls_footnotes WHERE survey = ?').run(survey);
      const insert = db.prepare('INSERT INTO bls_footnotes (survey, code, text) VALUES (?, ?, ?)');
      for (const [code, text] of footnotes) insert.run(survey, code, text);
    });
  }

  /**
   * Footnote text by code, keyed by series ID, for each of `seriesIds` whose
   * survey has a stored table. The table is the survey's — a SeriesID names its
   * survey in its first two letters — so a survey added to the harvest decodes
   * with no change here. A series whose survey publishes no table, or whose
   * table no sync has read yet, is absent: its codes stay bare.
   */
  async footnoteTables(seriesIds: string[]): Promise<Map<string, ReadonlyMap<string, string>>> {
    const surveys = [...new Set(seriesIds.map(surveyOf))];
    const db = await this.mirror.raw();
    const rows = db
      .prepare<{ code: string; survey: string; text: string }>(
        `SELECT survey, code, text FROM bls_footnotes WHERE survey IN (${surveys.map(() => '?').join(', ')})`,
      )
      .all(...surveys);

    const bySurvey = new Map<string, Map<string, string>>();
    for (const { survey, code, text } of rows) {
      let table = bySurvey.get(survey);
      if (!table) {
        table = new Map();
        bySurvey.set(survey, table);
      }
      table.set(code, text);
    }
    return new Map(
      seriesIds.flatMap((id): Array<[string, ReadonlyMap<string, string>]> => {
        const table = bySurvey.get(surveyOf(id));
        return table ? [[id, table]] : [];
      }),
    );
  }

  /**
   * Run a sync (init or refresh). Resolves when complete, with the listing and
   * data files it could not read and the surveys that listed none.
   */
  async runSync(options: MirrorRunOptions): Promise<ObservationsSyncResult> {
    const result = await this.mirror.runSync(options);
    const gaps = this.lastGaps;
    if (!gaps) throw new Error('Observations sync completed without reporting its gaps');
    return { ...result, ...gaps };
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
   * so never answers with a supplemental annual summary. There is no opt-in here: an annual
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
 * mirror is switched off. Every input the mirror needs comes from
 * `getServerConfig()`, which lets the sync subprocess — which holds neither
 * core handle — call it the same way `setup()` does. The subprocess, which runs
 * the syncs, passes the logger they write through.
 */
export function initBlsObservationsService(log?: MirrorLogger): void {
  const cfg = getServerConfig();
  if (!cfg.observationsMirrorEnabled) {
    // Not enabled — don't create the mirror store (avoids opening SQLite on startup).
    return;
  }
  _service = new BlsObservationsService(
    cfg.observationsMirrorPath,
    cfg.catalogBaseUrl,
    cfg.userAgent,
    log,
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
