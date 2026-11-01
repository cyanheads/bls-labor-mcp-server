/**
 * @fileoverview Schema-migration tests for the observations mirror store. Runs
 * against the real framework `sqliteMirrorStore` on a temp-file database — the
 * migration's whole job is to mutate persisted state, so a stubbed store would
 * assert nothing. Covers #58: a mirror synced before the sentinel-row fix keeps
 * a checkpoint that makes the next refresh skip every unchanged file, so the
 * missing rows would never be backfilled. Covers #124 the same way: a mirror
 * synced before listing-based discovery holds a checkpoint newer than files the
 * listing newly names. Covers #118: an existing store gains the footnote table.
 * @module tests/services/bls-observations/mirror-migration.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlsObservationsService } from '@/services/bls-observations/bls-observations-service.js';
import { type FakeLabstat, fakeLabstat } from './labstat-fake.js';

const PRIOR_CHECKPOINT = '2026-01-15T06:00:00.000Z';
const COMPLETED_AT = '2026-01-15T06:04:11.000Z';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bls-mirror-migration-'));
  dbPath = join(dir, 'bls-observations.db');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function newService(): BlsObservationsService {
  return new BlsObservationsService(
    dbPath,
    'https://labstat.invalid/pub/time.series',
    'test-agent/1.0',
  );
}

/** The sync state a seeded store holds; the defaults describe a completed run. */
interface SeededState {
  checkpoint?: string | null;
  completedAt?: string | null;
  cursor?: string | null;
  status?: string;
  version?: number;
}

/**
 * Build the state an older mirror leaves on disk: the framework's sync-state
 * row — by default a completed run and its high-water mark — stamped at schema
 * `version` (1 unless given). Only the two tables the migration reads are
 * created — the service's own open runs the current declarative DDL over the top.
 */
async function seedPriorSchemaVersion({
  version = 1,
  status = 'complete',
  checkpoint = PRIOR_CHECKPOINT,
  completedAt = COMPLETED_AT,
  cursor = null,
}: SeededState = {}): Promise<void> {
  const handle = await openSqliteHandle(dbPath);
  handle.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  handle.exec(`CREATE TABLE IF NOT EXISTS mirror_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL, cursor TEXT, checkpoint TEXT,
      started_at TEXT, completed_at TEXT, total INTEGER, error TEXT
    )`);
  handle
    .prepare(
      `INSERT INTO mirror_sync_state(id, status, cursor, checkpoint, completed_at, total)
       VALUES (1, ?, ?, ?, ?, 4242)`,
    )
    .run(status, cursor, checkpoint, completedAt);
  handle
    .prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)')
    .run(version, COMPLETED_AT);
  handle.close();
}

/** Serve `labstat` in place of download.bls.gov for the rest of the test. */
function stubLabstat(labstat: FakeLabstat): void {
  vi.stubGlobal('fetch', fakeLabstat(labstat).fetch);
}

describe('observations mirror schema migration (#58)', () => {
  it('clears a pre-fix checkpoint so the next refresh re-reads every file', async () => {
    await seedPriorSchemaVersion();

    const service = newService();
    const status = await service.status();
    await service.shutdown();

    expect(status.checkpoint).toBeUndefined();
  });

  it('keeps the completion marker, so the mirror keeps serving while it re-reads', async () => {
    await seedPriorSchemaVersion();

    const service = newService();
    const status = await service.status();
    await service.shutdown();

    expect(status.completedAt).toBe(COMPLETED_AT);
    expect(status.total).toBe(4242);
    expect(status.ready).toBe(true);
  });

  it('clears the checkpoint exactly once — a later refresh advances it for good', async () => {
    await seedPriorSchemaVersion();

    const first = newService();
    await first.status();
    await first.shutdown();

    // Stand in for the refresh that runs after the migration and re-stamps the mark.
    const postFix = await openSqliteHandle(dbPath);
    postFix.exec(`UPDATE mirror_sync_state SET checkpoint = '2026-02-01T06:00:00.000Z'`);
    postFix.close();

    const second = newService();
    const status = await second.status();
    await second.shutdown();

    expect(status.checkpoint).toBe('2026-02-01T06:00:00.000Z');
  });

  it('leaves a brand-new store with nothing to clear', async () => {
    const service = newService();
    const status = await service.status();
    await service.shutdown();

    expect(status.checkpoint).toBeUndefined();
    expect(status.completedAt).toBeUndefined();
    expect(status.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #124 — files the directory listing newly names
// ---------------------------------------------------------------------------

const HEADER = 'series_id\tyear\tperiod\tvalue\tfootnote_codes';
const CU_ROWS = [HEADER, 'CUUR0000SA0\t2026\tM09\t324.4\t'].join('\n');
const PC_ROWS = [HEADER, 'PCU221122221122\t2026\tM09\t123.4\t'].join('\n');

/** When the PC files `{abbr}.txt`-based discovery never read were last published. */
const PC_PUBLISHED = 'Thu, 15 Oct 2026 07:30:00 GMT';

/** A checkpoint a mirror stamped before listing-based discovery, newer than {@link PC_PUBLISHED}. */
const PRE_LISTING_CHECKPOINT = '2026-10-30T12:30:00.000Z';

/** Every stored row of one series, as `year period value`. */
async function storedRows(service: BlsObservationsService, seriesId: string): Promise<string[]> {
  const { observations } = await service.queryBySeries({ seriesIds: [seriesId] });
  return observations.map((o) => `${o.year} ${o.period} ${o.value}`);
}

describe('observations mirror schema migration — listing discovery (#124)', () => {
  it('reads a newly listed file older than the stored checkpoint on the next refresh, keeping the rows already stored', async () => {
    const labstat: FakeLabstat = {
      cu: {
        'cu.data.1.AllItems': { body: CU_ROWS, lastModified: 'Thu, 01 Oct 2026 12:00:00 GMT' },
      },
    };
    stubLabstat(labstat);
    const before = newService();
    await before.runSync({ mode: 'init' });
    await before.shutdown();

    // Rewind to what the previous release leaves: schema version 2, a checkpoint
    // past every file the PC listing serves, and no PC rows.
    const handle = await openSqliteHandle(dbPath);
    handle.exec('UPDATE schema_version SET version = 2');
    handle.exec(`UPDATE mirror_sync_state SET checkpoint = '${PRE_LISTING_CHECKPOINT}'`);
    handle.exec('DROP TABLE IF EXISTS bls_footnotes');
    handle.close();
    labstat.pc = { 'pc.data.0.Current': { body: PC_ROWS, lastModified: PC_PUBLISHED } };

    const after = newService();
    try {
      await after.runSync({ mode: 'refresh' });

      expect(await storedRows(after, 'PCU221122221122')).toEqual(['2026 M09 123.4']);
      expect(await storedRows(after, 'CUUR0000SA0')).toEqual(['2026 M09 324.4']);
    } finally {
      await after.shutdown();
    }
  });

  it('clears a version-2 checkpoint and keeps the completion marker, so the mirror keeps serving', async () => {
    await seedPriorSchemaVersion({ version: 2, checkpoint: PRE_LISTING_CHECKPOINT });

    const service = newService();
    const status = await service.status();
    await service.shutdown();

    expect(status.checkpoint).toBeUndefined();
    expect(status.completedAt).toBe(COMPLETED_AT);
    expect(status.ready).toBe(true);
  });

  it("drops an interrupted init's resume cursor, whose file index named a different file list", async () => {
    // `0:1:0` resumes the first survey at its second file, which skips the first.
    await seedPriorSchemaVersion({
      version: 2,
      status: 'error',
      checkpoint: null,
      completedAt: null,
      cursor: '0:1:0',
    });
    stubLabstat({
      cu: {
        'cu.data.0.Current': { body: CU_ROWS, lastModified: PC_PUBLISHED },
        'cu.data.1.AllItems': { body: HEADER, lastModified: PC_PUBLISHED },
      },
    });

    const service = newService();
    try {
      await service.runSync({ mode: 'init' });

      expect(await storedRows(service, 'CUUR0000SA0')).toEqual(['2026 M09 324.4']);
    } finally {
      await service.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// #118 — the footnote table
// ---------------------------------------------------------------------------

describe('observations mirror schema migration — footnote table (#118)', () => {
  it.each([
    ['an existing store', () => seedPriorSchemaVersion({ version: 2 })],
    ['a brand-new store', () => Promise.resolve()],
  ])('gives %s an empty footnote table', async (_case, seed) => {
    await seed();

    const service = newService();
    try {
      expect(await service.footnoteTables(['CUUR0000SA0'])).toEqual(new Map());
    } finally {
      await service.shutdown();
    }
  });
});
