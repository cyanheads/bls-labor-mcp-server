/**
 * @fileoverview Tests for the linear-time helper itself: it rejects a quadratic
 * path at a small size, judges growth against a baseline timed beside each
 * size, and reads thread CPU rather than the wall clock.
 * @module tests/fixtures/linear-time.test
 */

import { describe, expect, it } from 'vitest';
import { expectLinearCpuTime } from './linear-time.js';

let sink = 0;

/** Linear work over `input`, `factor` passes. */
function linear(input: string, factor = 1): void {
  let h = 0;
  for (let k = 0; k < factor; k++) {
    for (let i = 0; i < input.length; i++) h = (h + input.charCodeAt(i)) | 0;
  }
  sink ^= h;
}

/** Quadratic work: `n / 16` passes over the first `n / 64` characters. */
function quadratic(input: string): void {
  let h = 0;
  const m = input.length >> 6;
  for (let i = 0; i < input.length; i += 16) {
    for (let j = 0; j < m; j++) h = (h + input.charCodeAt(j)) | 0;
  }
  sink ^= h;
}

const text = (n: number) => 'x'.repeat(n);

describe('expectLinearCpuTime', () => {
  it('rejects a quadratic path before it reaches the largest size', () => {
    let largest = 0;
    expect(() =>
      expectLinearCpuTime(
        (input) => {
          largest = Math.max(largest, input.length);
          quadratic(input);
        },
        text,
        'quadratic',
        60_000,
      ),
    ).toThrow(/growth/);
    expect(largest).toBeLessThan(320_000);
  }, 0);

  it('passes linear work that slows down after the baseline is calibrated, as on a slower core', () => {
    let factor = 1;
    expectLinearCpuTime(
      (input) => {
        if (input.length > 5_000) factor = 8;
        linear(input, factor);
      },
      text,
      'slower core',
      1_000,
    );
  }, 0);

  it('passes linear work that also waits off-CPU in proportion to its input', () => {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    expectLinearCpuTime(
      (input) => {
        linear(input);
        if (input.length > 5_000) Atomics.wait(cell, 0, 0, input.length / 20_000);
      },
      text,
      'off-CPU wait',
      1_000,
    );
  }, 0);
});

// Biome counts a write-only `sink` as unused.
void sink;
