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
import { SURVEY_ABBRS } from '@/services/bls-catalog/bls-catalog-service.js';
import {
  BlsObservationsService,
  isBlsObservationsServiceReady,
} from '@/services/bls-observations/bls-observations-service.js';
import {
  isObservationsSyncRunning,
  makeChildLogger,
  runObservationsChildSync,
  runObservationsSubprocess,
} from '@/services/bls-observations/subprocess.js';
import { type FakeLabstat, fakeLabstat } from './labstat-fake.js';

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

describe('runObservationsSubprocess exit logging (#117)', () => {
  it.each([
    [0, 'info', 'Observations subprocess completed'],
    [2, 'warning', 'Observations subprocess completed with gaps'],
    [1, 'error', 'Observations subprocess exited non-zero'],
  ] as const)('logs child exit %i at %s level', async (code, level, message) => {
    const mockChild = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
      on: vi.fn().mockReturnThis(),
    };
    spawnMock.mockReturnValue(mockChild);
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };

    const run = runObservationsSubprocess({ timeoutMs: 60_000, log });
    const exitHandler = mockChild.on.mock.calls.find((call) => call[0] === 'exit')?.[1] as (
      code: number | null,
      signal: string | null,
    ) => void;
    exitHandler(code, null);
    await run;

    expect(log[level]).toHaveBeenCalledWith(expect.stringContaining(message), expect.anything());
    // Every exit outcome's message, so a second outcome logged at another level is caught.
    const outcome = /^Observations subprocess (completed|exited|terminated)/;
    for (const other of ['info', 'warning', 'error'] as const) {
      if (other !== level) {
        expect(log[other].mock.calls.filter(([m]) => outcome.test(String(m)))).toEqual([]);
      }
    }
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

/** A data file's header with no rows. */
const NO_ROWS = 'series_id\tyear\tperiod\tvalue\tfootnote_codes';

const PUBLISHED = 'Mon, 06 Jan 2025 06:00:00 GMT';

/**
 * LABSTAT for every mirrored survey, held so a test can republish or break a
 * file between runs: the first survey serves {@link DATA_FILE}, every other one
 * a data file with no rows. No LABSTAT traffic.
 */
let labstat: FakeLabstat;
let fake: ReturnType<typeof fakeLabstat>;

function stubLabstat(): void {
  labstat = Object.fromEntries(
    SURVEY_ABBRS.map((abbr) => [
      abbr,
      {
        [`${abbr}.data.1.AllItems`]: {
          body: abbr === 'cu' ? DATA_FILE : NO_ROWS,
          lastModified: PUBLISHED,
        },
      },
    ]),
  );
  fake = fakeLabstat(labstat);
  vi.stubGlobal('fetch', fake.fetch);
}

/** The stored sync state of the mirror at `path`, read through a fresh service. */
async function mirrorState(path: string): Promise<{ checkpoint?: string; ready: boolean }> {
  const service = new BlsObservationsService(path, 'https://labstat.invalid', 'test-agent');
  try {
    const { checkpoint, ready } = await service.status();
    return { ready, ...(checkpoint !== undefined && { checkpoint }) };
  } finally {
    await service.shutdown();
  }
}

/** Every stored row of one series, as `year period value`. */
async function mirrorRows(path: string, seriesId: string): Promise<string[]> {
  const service = new BlsObservationsService(path, 'https://labstat.invalid', 'test-agent');
  try {
    const { observations } = await service.queryBySeries({
      seriesIds: [seriesId],
      annualAverage: true,
    });
    return observations.map((o) => `${o.year} ${o.period} ${o.value}`).sort();
  } finally {
    await service.shutdown();
  }
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
    expect((await mirrorState(join(dir, 'obs.db'))).checkpoint).toBe('2025-01-06T06:00:00.000Z');
  });

  describe('the checkpoint advances only after a run reads every listed file (#117)', () => {
    const DB = (): string => join(dir, 'obs.db');
    const AP_FILE = [NO_ROWS, 'APU0000701111\t2024\tM12\t1.000\t'].join('\n');

    /**
     * CU publishes at noon and AP that evening; on day 2 each adds a row. CU
     * comes first in the harvest, so a refresh reads AP's newer file after
     * CU's — the order in which a per-survey checkpoint stranded CU.
     */
    function publish(day: 1 | 2): void {
      labstat.cu = {
        'cu.data.1.AllItems': {
          body: day === 1 ? DATA_FILE : `${DATA_FILE}\nCUUR0000SA0\t2025\tM01\t317.0\t`,
          lastModified: `${day === 1 ? 'Sun, 01' : 'Mon, 02'} Nov 2026 12:00:00 GMT`,
        },
      };
      labstat.ap = {
        'ap.data.1.AllItems': {
          body: day === 1 ? AP_FILE : `${AP_FILE}\nAPU0000701111\t2025\tM01\t1.100\t`,
          lastModified: `${day === 1 ? 'Sun, 01' : 'Mon, 02'} Nov 2026 18:00:00 GMT`,
        },
      };
    }

    it('holds the checkpoint through a refresh whose survey file fails, then ingests it once restored', async () => {
      publish(1);
      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);
      expect((await mirrorState(DB())).checkpoint).toBe('2026-11-01T18:00:00.000Z');

      publish(2);
      labstat.cu!['cu.data.1.AllItems']!.status = 404;
      expect(await runObservationsChildSync([], makeLogger(), never)).toBe(2);
      expect((await mirrorState(DB())).checkpoint).toBe('2026-11-01T18:00:00.000Z');
      expect(await mirrorRows(DB(), 'APU0000701111')).toContain('2025 M01 1.100');

      delete labstat.cu!['cu.data.1.AllItems']!.status;
      expect(await runObservationsChildSync([], makeLogger(), never)).toBe(0);
      expect(await mirrorRows(DB(), 'CUUR0000SA0')).toContain('2025 M01 317.0');
      expect((await mirrorState(DB())).checkpoint).toBe('2026-11-02T18:00:00.000Z');
    });

    it('completes a degraded init ready with no checkpoint, and the next refresh ingests what it missed', async () => {
      publish(1);
      labstat.cu!['cu.data.1.AllItems']!.status = 404;
      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(2);
      expect(await mirrorState(DB())).toEqual({ ready: true });

      delete labstat.cu!['cu.data.1.AllItems']!.status;
      expect(await runObservationsChildSync([], makeLogger(), never)).toBe(0);
      expect(await mirrorRows(DB(), 'CUUR0000SA0')).toEqual(['2024 M11 -', '2024 M12 315.6']);
      expect(await mirrorState(DB())).toEqual({
        ready: true,
        checkpoint: '2026-11-01T18:00:00.000Z',
      });
    });

    it.each([
      ['a listing that fails', { '': { status: 404 } }, '2026-11-01T18:00:00.000Z'],
      ['a listing naming no data files', { 'cu.series': {} }, '2026-11-02T18:00:00.000Z'],
    ])(
      'exits 2 on %s, holding the checkpoint only when a file went unread',
      async (_case, cuFiles, checkpoint) => {
        publish(1);
        expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);

        publish(2);
        labstat.cu = cuFiles;
        expect(await runObservationsChildSync([], makeLogger(), never)).toBe(2);
        expect((await mirrorState(DB())).checkpoint).toBe(checkpoint);
      },
    );

    it('leaves the checkpoint unchanged when a refresh is aborted after an earlier survey was applied', async () => {
      publish(1);
      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);

      publish(2);
      const controller = new AbortController();
      vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/ap/ap.data.')) controller.abort(new Error('Aborted by SIGTERM'));
        return fake.fetch(url, init);
      });

      const { code, records } = await captureStdout(() =>
        runObservationsChildSync([], makeChildLogger(), controller.signal),
      );

      expect(code).toBe(1);
      expect(await mirrorRows(DB(), 'CUUR0000SA0')).toContain('2025 M01 317.0');
      expect((await mirrorState(DB())).checkpoint).toBe('2026-11-01T18:00:00.000Z');
      expect(records.find((r) => r.msg === 'Mirror sync failed')).toMatchObject({
        level: 'error',
        mode: 'refresh',
      });
    });

    it('writes each unread file and the run outcome to stdout as JSON lines', async () => {
      publish(1);
      labstat.cu!['cu.data.1.AllItems']!.status = 404;

      const { code, records } = await captureStdout(() =>
        runObservationsChildSync(['--init'], makeChildLogger(), never),
      );

      expect(code).toBe(2);
      expect(records.filter((r) => r.level === 'warning' && r.survey === 'cu')).toEqual([
        expect.objectContaining({
          url: 'https://labstat.invalid/pub/time.series/cu/cu.data.1.AllItems',
          status: 404,
        }),
      ]);
      expect(records.find((r) => r.msg === 'Mirror sync complete')).toMatchObject({
        level: 'info',
        mode: 'init',
      });
      expect(records.at(-1)).toMatchObject({
        level: 'warning',
        msg: 'Observations sync completed with gaps',
        recordsApplied: 1,
        unreadFiles: 1,
        surveysWithoutDataFiles: [],
        checkpointHeld: true,
      });
    });
  });

  describe('footnote tables are read on every run and kept in the store (#118)', () => {
    const DB = (): string => join(dir, 'obs.db');
    const TABLE_HEADER = 'footnote_code\tfootnote_text';

    /** The stored footnote table CUUR0000SA0 decodes against, read through a fresh service. */
    async function cuFootnotes(): Promise<ReadonlyMap<string, string> | undefined> {
      const service = new BlsObservationsService(DB(), 'https://labstat.invalid', 'test-agent');
      try {
        return (await service.footnoteTables(['CUUR0000SA0'])).get('CUUR0000SA0');
      } finally {
        await service.shutdown();
      }
    }

    function publishFootnotes(text: string): void {
      labstat.cu!['cu.footnote'] = {
        body: `${TABLE_HEADER}\r\n9\t${text}\r\nR\tRevised\r\n`,
        lastModified: PUBLISHED,
      };
    }

    it('stores the table an init reads, decoding codes for every series of the survey', async () => {
      publishFootnotes('Data unavailable due to the 2025 lapse in appropriations');

      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);

      expect(await cuFootnotes()).toEqual(
        new Map([
          ['9', 'Data unavailable due to the 2025 lapse in appropriations'],
          ['R', 'Revised'],
        ]),
      );
    });

    it('replaces the stored text on a refresh that reads no data file, leaving the checkpoint alone', async () => {
      publishFootnotes('First wording');
      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);
      const { checkpoint } = await mirrorState(DB());

      publishFootnotes('Second wording');
      const { code, records } = await captureStdout(() =>
        runObservationsChildSync([], makeChildLogger(), never),
      );

      expect(code).toBe(0);
      expect(records.find((r) => r.msg === 'Observations sync complete')).toMatchObject({
        recordsApplied: 0,
      });
      expect((await cuFootnotes())?.get('9')).toBe('Second wording');
      expect((await mirrorState(DB())).checkpoint).toBe(checkpoint);
    });

    it('keeps the stored copy when a refresh cannot read the table, without counting it unread', async () => {
      publishFootnotes('Kept wording');
      expect(await runObservationsChildSync(['--init'], makeLogger(), never)).toBe(0);

      labstat.cu!['cu.data.1.AllItems'] = {
        body: `${DATA_FILE}\nCUUR0000SA0\t2025\tM01\t317.0\t`,
        lastModified: 'Mon, 02 Nov 2026 12:00:00 GMT',
      };
      labstat.cu!['cu.footnote']!.status = 403;
      const log = makeLogger();

      expect(await runObservationsChildSync([], log, never)).toBe(0);
      expect((await cuFootnotes())?.get('9')).toBe('Kept wording');
      expect((await mirrorState(DB())).checkpoint).toBe('2026-11-02T12:00:00.000Z');
      expect(log.warnings).toEqual([
        expect.stringContaining('LABSTAT footnote table unread; any stored copy stays in use'),
      ]);
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
