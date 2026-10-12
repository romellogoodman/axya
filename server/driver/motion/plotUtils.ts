/*
 * The plotink geometry helpers the planner calls.
 *
 * Ported from plotink/plot_utils.py (distance, dotProductXY, checkLimitsTol),
 * docs/reference-apps/nextdraw-1.7.5/plotink/plot_utils.py.
 * Copyright (c) 2025 Windell H. Oskay, Bantam Tools. MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/** sqrt(x*x + y*y); deliberately not Math.hypot, which rounds differently. */
export function distance(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Dot product of two 2-vectors, clamped to [-1, 1]. */
export function dotProductXY(a: number[], b: number[]): number {
  const temp = a[0] * b[0] + a[1] * b[1];
  if (temp > 1) return 1;
  if (temp < -1) return -1;
  return temp;
}

/**
 * Clamp value to [lower, upper]; the flag is true only when it was beyond
 * the range by more than tolerance.
 */
export function checkLimitsTol(
  value: number,
  lower: number,
  upper: number,
  tolerance: number
): [number, boolean] {
  if (value > upper) {
    if (value > upper + tolerance) return [upper, true];
    return [upper, false];
  }
  if (value < lower) {
    if (value < lower - tolerance) return [lower, true];
    return [lower, false];
  }
  return [value, false];
}
