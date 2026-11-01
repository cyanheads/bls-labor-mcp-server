/**
 * @fileoverview Linear-time assertion for code that reads caller-sized text,
 * timed in thread CPU so a busy machine cannot fail it and a quadratic path
 * cannot pass it.
 * @module tests/services/bls-catalog/linear-time
 */

import { expect } from 'vitest';

/** 5K to 320K characters, doubling: a 64× span. */
const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];

/** Thread CPU milliseconds per call of `run`: the least of five rounds of `calls` calls each. */
function cpuMsPerCall(run: () => void, calls: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) run();
    const { user, system } = process.threadCpuUsage(start);
    best = Math.min(best, (user + system) / 1_000 / calls);
  }
  return best;
}

/**
 * Assert that `run` takes linear time in the length of `text(n)`. A size runs
 * only after every smaller one stayed under `maxCallMs` per call, so a
 * quadratic path fails at a small size rather than running for minutes. Each
 * size is timed over a batch reading 640K characters, so a small input is
 * timed per call across many calls. Linear growth predicts 64× across the
 * span and quadratic 4,096×; the bound is 256×, with the 5K time floored at
 * 1 µs, near the CPU clock's resolution.
 */
export function expectLinearCpuTime(
  run: (input: string) => void,
  text: (n: number) => string,
  label: string,
  maxCallMs: number,
): void {
  run(text(SIZES[0] ?? 0)); // warm the JIT
  let first = 0;
  let last = 0;
  for (const n of SIZES) {
    const input = text(n);
    last = cpuMsPerCall(() => run(input), 640_000 / n);
    expect(last, `${label} at ${n} characters`).toBeLessThan(maxCallMs);
    first ||= Math.max(last, 0.001);
  }
  expect(last / first, label).toBeLessThan(256);
}
