/**
 * @fileoverview Schema-migration tests for the observations mirror store. Runs
 * against the real framework `sqliteMirrorStore` on a temp-file database — the
 * migration's whole job is to mutate persisted state, so a stubbed store would
 * assert nothing. Covers #58: a mirror synced before the sentinel-row fix keeps
 * a checkpoint that makes the next refresh skip every unchanged file, so the
 * missing rows would never be backfilled.
 * @module tests/services/bls-observations/mirror-migration.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlsObservationsService } from '@/services/bls-observations/bls-observations-service.js';

const PRIOR_CHECKPOINT = '2026-01-15T06:00:00.000Z';
const COMPLETED_AT = '2026-01-15T06:04:11.000Z';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bls-mirror-migration-'));
  dbPath = join(dir, 'bls-observations.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function newService(): BlsObservationsService {
  return new BlsObservationsService(dbPath, 'https://example.invalid', 'test-agent/1.0');
}

/**
 * Build the state a pre-fix mirror leaves on disk: the framework's sync-state
 * row carrying a completed run and its high-water mark, stamped at schema
 * version 1. Only the two tables the migration reads are created — the service's
 * own open runs the current declarative DDL over the top.
 */
async function seedPriorSchemaVersion(): Promise<void> {
  const handle = await openSqliteHandle(dbPath);
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mirror_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL, cursor TEXT, checkpoint TEXT,
      started_at TEXT, completed_at TEXT, total INTEGER, error TEXT
    );
    INSERT OR IGNORE INTO mirror_sync_state(id, status) VALUES (1, 'pending');
    UPDATE mirror_sync_state
       SET status = 'complete', checkpoint = '${PRIOR_CHECKPOINT}',
           completed_at = '${COMPLETED_AT}', total = 4242;
    INSERT INTO schema_version(version, applied_at) VALUES (1, '${COMPLETED_AT}');
  `);
  handle.close();
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
