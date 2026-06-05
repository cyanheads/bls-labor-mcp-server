/**
 * @fileoverview Tests for the subprocess module — the overlap guard and the
 * parent-side spawn supervision. `node:child_process.spawn` is mocked (via
 * `vi.hoisted`) so no real child process is launched.
 * @module tests/services/bls-observations/subprocess.test
 */

import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  isObservationsSyncRunning,
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
    const exitHandler = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'exit',
    )?.[1] as ((code: number | null, signal: string | null) => void) | undefined;
    exitHandler?.(0, null);
    await p1;
  });
});
