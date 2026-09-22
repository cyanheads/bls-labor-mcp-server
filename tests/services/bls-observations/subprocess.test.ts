/**
 * @fileoverview Tests for the subprocess module — the parent-side overlap guard
 * and spawn supervision, plus the child entry itself. `node:child_process.spawn`
 * is mocked (via `vi.hoisted`) so no real child process is launched; the child
 * entry runs in-process against a temp-file mirror and a stubbed LABSTAT fetch,
 * which is what makes it the real entry path rather than a mock of it.
 * @module tests/services/bls-observations/subprocess.test
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { resetServerConfig } from '@/config/server-config.js';
import { isBlsObservationsServiceReady } from '@/services/bls-observations/bls-observations-service.js';
import {
  isObservationsSyncRunning,
  makeChildLogger,
  runObservationsChildSync,
  runObservationsSubprocess,
} from '@/services/bls-observations/subprocess.js';

function makeLogger(): MirrorLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: (msg: string) => warnings.push(msg),
    error: vi.fn(),
  };
}

describe('isObservationsSyncRunning', () => {
  it('returns false when no subprocess is running', () => {
    expect(isObservationsSyncRunning()).toBe(false);
  });
});

describe('runObservationsSubprocess overlap guard', () => {
  it('skips a second call while a subprocess is already active', async () => {
    // A fake child that never emits 'exit' keeps the first run in flight.
    const mockChild = {
      pid: 99999,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
      on: vi.fn().mockReturnThis(),
    };
    spawnMock.mockReturnValue(mockChild);

    const log1 = makeLogger();
    const log2 = makeLogger();

    // First call starts and stays pending (the child never exits).
    const p1 = runObservationsSubprocess({ timeoutMs: 60_000, log: log1 });

    // Second concurrent call must be a no-op that warns about the overlap.
    await runObservationsSubprocess({ timeoutMs: 60_000, log: log2 });
    expect(log2.warnings.some((w) => w.includes('already running'))).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Resolve the first call by firing the captured 'exit' handler.
    const exitCall = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'exit',
    );
    const exitHandler = exitCall?.[1] as
      | ((code: number | null, signal: string | null) => void)
      | undefined;
    exitHandler?.(0, null);
    await p1;
  });
});

// ---------------------------------------------------------------------------
// Child entry (#72)
// ---------------------------------------------------------------------------

/** One survey's worth of LABSTAT rows, including a `-` sentinel row (#58). */
const DATA_FILE = [
  'series_id\tyear\tperiod\tvalue\tfootnote_codes',
  'CUUR0000SA0\t2024\tM12\t315.6\t',
  'CUUR0000SA0\t2024\tM11\t-\t9',
].join('\n');

/** Serve the first survey from a fixture and 404 the rest — no LABSTAT traffic. */
function stubLabstat(): void {
  vi.stubGlobal('fetch', (url: string | URL) => {
    const u = String(url);
    const headers = { 'Last-Modified': 'Mon, 06 Jan 2025 06:00:00 GMT' };
    if (u.includes('/cu/cu.txt')) {
      return Promise.resolve(new Response('cu.data.1.AllItems\n', { status: 200, headers }));
    }
    if (u.includes('/cu/cu.data.')) {
      return Promise.resolve(new Response(DATA_FILE, { status: 200, headers }));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

/** Collect what the child writes to stdout while `run` is in flight. */
async function captureStdout(run: () => Promise<number>): Promise<{
  code: number;
  records: Array<Record<string, unknown>>;
}> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await run();
    const lines = chunks.join('').split('\n').filter(Boolean);
    return { code, records: lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  } finally {
    spy.mockRestore();
  }
}

describe('runObservationsChildSync — the child entry (#72)', () => {
  let dir: string;
  const never = new AbortController().signal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bls-child-entry-'));
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_ENABLED', 'true');
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_PATH', join(dir, 'obs.db'));
    vi.stubEnv('BLS_CATALOG_BASE_URL', 'https://labstat.invalid/pub/time.series');
    resetServerConfig();
    stubLabstat();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetServerConfig();
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstraps an empty mirror path with --init and exits 0', async () => {
    const code = await runObservationsChildSync(['--init'], makeLogger(), never);

    expect(code).toBe(0);
    expect(await readdir(dir)).toContain('obs.db');
  });

  it('writes only JSON lines, the completion one carrying all four counters', async () => {
    const { code, records } = await captureStdout(() =>
      runObservationsChildSync(['--init'], makeChildLogger(), never),
    );

    expect(code).toBe(0);
    for (const record of records) {
      expect(typeof record.level).toBe('string');
      expect(typeof record.msg).toBe('string');
    }
    expect(records.find((r) => r.msg === 'Observations sync complete')).toMatchObject({
      level: 'info',
      pagesFetched: expect.any(Number),
      recordsApplied: 2,
      tombstonesApplied: 0,
      total: 2,
    });
  });

  it('resolves a bare invocation to refresh mode, which honours the stored checkpoint', async () => {
    expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);

    const { code, records } = await captureStdout(() =>
      runObservationsChildSync([], makeChildLogger(), never),
    );

    // An init seeds the checkpoint; a refresh skips every file no newer than it.
    expect(code).toBe(0);
    expect(records.find((r) => r.msg === 'Observations sync complete')).toMatchObject({
      pagesFetched: 0,
      recordsApplied: 0,
    });
  });

  it('routes an init failure to the structured failure record, not a stack trace', async () => {
    vi.stubEnv('BLS_CATALOG_BASE_URL', 'not-a-url');
    resetServerConfig();

    const { code, records } = await captureStdout(() =>
      runObservationsChildSync(['--init'], makeChildLogger(), never),
    );

    expect(code).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      msg: 'Observations sync failed',
      error: expect.any(String),
    });
  });

  it('routes a runSync rejection to the same failure record', async () => {
    // A directory is not a database — the store fails to open inside runSync.
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_PATH', dir);
    resetServerConfig();

    const { code, records } = await captureStdout(() =>
      runObservationsChildSync(['--init'], makeChildLogger(), never),
    );

    expect(code).toBe(1);
    expect(records.filter((r) => r.msg === 'Observations sync complete')).toHaveLength(0);
    expect(records.filter((r) => r.msg === 'Observations sync failed')).toHaveLength(1);
  });

  it('warns once and constructs no mirror when the flag is off', async () => {
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_ENABLED', 'false');
    resetServerConfig();
    const log = makeLogger();

    const code = await runObservationsChildSync(['--init'], log, never);

    expect(code).toBe(0);
    expect(log.warnings).toHaveLength(1);
    expect(isBlsObservationsServiceReady()).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});
