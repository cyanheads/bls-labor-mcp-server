/**
 * @fileoverview Linear-time assertions for code that reads caller-sized text,
 * timed in thread CPU so a busy machine cannot fail them and a quadratic path
 * cannot pass them. Sizes double from 5K to 320K characters, a 64× span over
 * which linear growth predicts 64× and quadratic 4,096×. Each size is timed in
 * rounds, every round re-timing the 5K baseline beside it so the pair shares
 * one core's speed, and keeps the least growth across those pairs, since a
 * pause only adds time. Each size is checked against the 256× growth bound and
 * its per-call CPU bound before the next runs, so a quadratic path fails at a
 * small size rather than running for minutes.
 * @module tests/fixtures/linear-time
 */

import { expect } from 'vitest';

/** 5K to 320K characters, doubling: a 64× span. */
const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000] as const;
const [BASE] = SIZES;
/** Rounds per size; the least is kept. */
const ROUNDS = 3;
/** Growth over the 5K baseline allowed at any size: linear predicts at most 64×, quadratic 4,096×. */
const MAX_GROWTH = 256;
/** Thread CPU milliseconds a batch of synchronous calls on the baseline fills, far above the clock's 1 µs resolution. */
const BATCH_MS = 0.5;

/** A caller-text shape: its label and a function returning `n` characters of it. */
export type TextShape = [label: string, text: (n: number) => string];

/** A size's least CPU milliseconds per call, and its least growth over the input it was paired with. */
export interface CpuPair {
  growth: number;
  ms: number;
}

/** `unit` repeated to exactly `n` characters. */
export function repeatTo(unit: string, n: number): string {
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

/** The two line-break shapes every timing suite carries. */
export const LINE_BREAK_SHAPES: readonly TextShape[] = [
  // `.` cannot cross the break, so a scan that gives up at the end of input runs to the break from every start instead.
  ['one long line ending in a break', (n) => `${repeatTo('§1 x', n - 2)}\ny`],
  // A break every few characters, where a multiline or per-token whitespace scan restarts.
  ['line breaks throughout', (n) => repeatTo('  \r\n', n)],
];

/** Thread CPU milliseconds per call over `calls` synchronous calls of `run`. */
function cpuMsPerCall(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < calls; i++) run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1_000 / calls;
}

/** Thread CPU milliseconds of one awaited call of `run`. */
async function cpuMsOf(run: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  await run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1_000;
}

function expectStep(label: string, n: number, { growth, ms }: CpuPair, maxCallMs: number): void {
  expect(ms, `${label}: CPU ms per call at ${n} characters`).toBeLessThan(maxCallMs);
  expect(growth, `${label}: growth from ${BASE} to ${n} characters`).toBeLessThan(MAX_GROWTH);
}

/**
 * Assert that synchronous `run` takes linear time in the length of `text(n)`.
 * The baseline is timed per call over a batch that fills {@link BATCH_MS} of
 * CPU, and each larger size over a batch reading as many characters, so a
 * small input is timed across many calls. Run the calling test with a
 * per-test timeout of `0`: Vitest cannot interrupt a synchronous body and only
 * compares its wall time afterwards, which fails linear work on a loaded
 * machine, while the per-size checks here stop a super-linear one.
 */
export function expectLinearCpuTime(
  run: (input: string) => void,
  text: (n: number) => string,
  label: string,
  maxCallMs: number,
): void {
  const base = text(BASE);
  let baseCalls = 1;
  // Doubles the batch until it fills BATCH_MS, warming the JIT on the way.
  while (cpuMsPerCall(() => run(base), baseCalls) * baseCalls < BATCH_MS) baseCalls *= 2;
  for (const n of SIZES) {
    const input = text(n);
    const calls = Math.max(1, Math.round((baseCalls * BASE) / n));
    run(input); // A first call can flatten or hash the new string.
    let ms = Number.POSITIVE_INFINITY;
    let growth = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round++) {
      const baseMs = cpuMsPerCall(() => run(base), baseCalls);
      const sizeMs = cpuMsPerCall(() => run(input), calls);
      ms = Math.min(ms, sizeMs);
      growth = Math.min(growth, sizeMs / baseMs);
    }
    expectStep(label, n, { growth, ms }, maxCallMs);
  }
}

/**
 * Time awaited `run` on `small` and `large` side by side, one call per
 * measurement, after one untimed call on each. Returns the least CPU
 * milliseconds of the `large` call and its least growth over the `small`
 * call timed beside it.
 */
export async function cpuPairAsync(
  run: (input: string) => Promise<unknown>,
  small: string,
  large: string,
): Promise<CpuPair> {
  await run(small);
  await run(large);
  let ms = Number.POSITIVE_INFINITY;
  let growth = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round++) {
    const smallMs = await cpuMsOf(() => run(small));
    const largeMs = await cpuMsOf(() => run(large));
    ms = Math.min(ms, largeMs);
    growth = Math.min(growth, largeMs / smallMs);
  }
  return { growth, ms };
}

/**
 * Assert that awaited `run` takes linear time in the length of `text(n)`, as
 * {@link expectLinearCpuTime} does, timing one call per measurement. The
 * calling test keeps Vitest's default timeout, so keep the ladder's total CPU
 * well under a second.
 */
export async function expectLinearCpuTimeAsync(
  run: (input: string) => Promise<unknown>,
  text: (n: number) => string,
  label: string,
  maxCallMs: number,
): Promise<void> {
  const base = text(BASE);
  for (const n of SIZES) expectStep(label, n, await cpuPairAsync(run, base, text(n)), maxCallMs);
}
