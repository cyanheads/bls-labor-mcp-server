/**
 * @fileoverview Off-loads BLS observation mirror sync into a separate OS process.
 *
 * The observation harvest writes rows synchronously to SQLite (both `bun:sqlite`
 * and `better-sqlite3` are synchronous drivers). Running those writes on the
 * server's event loop blocks every concurrent tool call for the duration of the
 * page flush. This module spawns the sync in a child process via
 * `process.execPath`; WAL lets the server's reader connection keep serving
 * throughout. See issue #26.
 *
 * Dual role:
 *   - Imported by `src/index.ts` for {@link runObservationsSubprocess} — the
 *     parent spawn helper the in-process HTTP cron calls.
 *   - Run directly (`<runtime> dist/services/bls-observations/subprocess.js`)
 *     as the child entry point — the bottom guard runs one refresh and exits.
 *
 * @module services/bls-observations/subprocess
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { getBlsObservationsService } from './bls-observations-service.js';

/** Grace period after SIGTERM before escalating to SIGKILL (ms). */
const SIGKILL_GRACE_MS = 30_000;

/** Default child timeout: 2 hours — large surveys take time. */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Tracks the in-flight child so overlapping cron ticks are no-ops. */
let activeChild: ChildProcess | undefined;

// ---------------------------------------------------------------------------
// Parent side — spawn + supervise the child
// ---------------------------------------------------------------------------

/**
 * Spawn one mirror sync in a child process and resolve when it exits.
 * Never rejects — a failed harvest is logged and swallowed so a cron tick
 * can't crash the server. A no-op (with a warning) when a sync is already running.
 */
export function runObservationsSubprocess(opts: {
  timeoutMs?: number;
  log: MirrorLogger;
}): Promise<void> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, log } = opts;

  if (activeChild) {
    log.warning?.('Observations mirror sync already running; skipping this tick');
    return Promise.resolve();
  }

  const entry = fileURLToPath(new URL('./subprocess.js', import.meta.url));

  return new Promise<void>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.error?.('Observations subprocess failed to spawn', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolvePromise();
      return;
    }

    activeChild = child;
    log.info?.('Observations subprocess started', { pid: child.pid, timeoutMs });

    forwardLines(child.stdout, (line) => relayChildLine(log, line));
    forwardLines(child.stderr, (line) => log.error?.(line));

    let timedOut = false;
    const sigterm = setTimeout(() => {
      timedOut = true;
      log.warning?.('Observations subprocess exceeded timeout; sending SIGTERM', { timeoutMs });
      child.kill('SIGTERM');
    }, timeoutMs);
    const sigkill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.error?.('Observations subprocess did not exit after SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, timeoutMs + SIGKILL_GRACE_MS);

    const settle = () => {
      clearTimeout(sigterm);
      clearTimeout(sigkill);
      activeChild = undefined;
      resolvePromise();
    };

    child.on('error', (err) => {
      log.error?.('Observations subprocess error', { error: err.message });
      settle();
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        log.info?.('Observations subprocess completed', { code });
      } else if (timedOut) {
        log.error?.('Observations subprocess terminated on timeout', { code, signal });
      } else {
        log.error?.('Observations subprocess exited non-zero', { code, signal });
      }
      settle();
    });
  });
}

/** True when the subprocess module is currently running a sync (parent side). */
export function isObservationsSyncRunning(): boolean {
  return activeChild !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers (shared parent/child)
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

function forwardLines(stream: NodeJS.ReadableStream | null, sink: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) sink(line);
  });
  stream.on('end', () => {
    if (buffer.trim()) sink(buffer);
  });
}

function relayChildLine(log: MirrorLogger, line: string): void {
  let level: LogLevel = 'info';
  let message = line;
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed && typeof parsed.msg === 'string') {
      message = parsed.msg;
      if (isLogLevel(parsed.level)) level = parsed.level;
      const { level: _level, msg: _msg, ...rest } = parsed;
      if (Object.keys(rest).length > 0) meta = rest;
    }
  } catch {
    // Not JSON — forward verbatim
  }
  const sink =
    level === 'error'
      ? log.error
      : level === 'warning'
        ? log.warning
        : level === 'notice'
          ? log.notice
          : level === 'debug'
            ? log.debug
            : log.info;
  sink?.(message, meta);
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'notice' ||
    value === 'warning' ||
    value === 'error'
  );
}

// ---------------------------------------------------------------------------
// Child side — run one sync run and exit
// ---------------------------------------------------------------------------

/** Logger that emits one JSON object per line on stdout for the parent to relay. */
function makeChildLogger(): MirrorLogger {
  const emit = (level: LogLevel, msg: string, meta?: object): void => {
    process.stdout.write(`${JSON.stringify({ level, msg, ...(meta ?? {}) })}\n`);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    notice: (m, meta) => emit('notice', m, meta),
    warning: (m, meta) => emit('warning', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

/** True when this module is the process entry point (spawned directly). */
function isMainEntry(): boolean {
  const entryArg = process.argv[1];
  return entryArg != null && fileURLToPath(import.meta.url) === resolve(entryArg);
}

if (isMainEntry()) {
  const log = makeChildLogger();
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log.warning?.(`Received ${sig}; aborting observations sync`);
      controller.abort(new Error(`Aborted by ${sig}`));
    });
  }

  // Determine sync mode from CLI arg: --init for full harvest, default refresh
  const args = process.argv.slice(2);
  const mode = args.includes('--init') ? 'init' : 'refresh';

  const cfg = getServerConfig();
  if (!cfg.observationsMirrorEnabled) {
    log.warning?.(
      'Observations mirror not enabled (BLS_OBSERVATIONS_MIRROR_ENABLED=false); exiting',
    );
    process.exit(0);
  }

  getBlsObservationsService()
    .runSync({ mode, signal: controller.signal })
    .then((result) => {
      log.info?.('Observations sync complete', result);
      process.exit(0);
    })
    .catch((err: unknown) => {
      log.error?.('Observations sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
