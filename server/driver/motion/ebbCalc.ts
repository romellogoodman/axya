/*
 * Firmware-exact motion arithmetic for the EiBotBoard T3 command.
 *
 * Ported from plotink/ebb_calc.py 1.1.0 (move_dist_t3, rate_t3, max_rate_t3),
 * docs/reference-apps/nextdraw-1.7.5/plotink/ebb_calc.py.
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
 *
 * The Python original mixes Decimal (prec 20), float, and int arithmetic;
 * each function below reproduces that mix operation by operation, because
 * the planner feeds these results forward and any one-off difference
 * changes every later command. The legacy LM/LT helpers (move_dist_lt,
 * calculate_lm) serve EBB 2.x only and are not ported.
 */

import { Dec } from "./decimal20.ts";

/** One full step in accumulator units (2^31). */
export const EBB_ACCUMULATOR_MAX = 2147483648;
const ACC_MAX_BIG = 2147483648n;

/** Python's round() on a float: nearest integer, ties to even. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Python int(x) on a float: truncate toward zero. */
const trunc = Math.trunc;

/**
 * Steps taken and final accumulator after `time` ISR ticks of a T3 move on
 * one axis. `accum` is the starting accumulator, or "clear" for a move whose
 * Clear flag is set (the firmware then starts at 0, or 2^31-1 when the first
 * steps go negative). Returns [steps, accumulator].
 */
export function moveDistT3(
  time: number,
  rate: number,
  accel: number,
  jerk: number,
  accum: number | "clear" = "clear"
): [number, number] {
  time = trunc(time);
  rate = trunc(rate);
  accel = trunc(accel);
  jerk = trunc(jerk);
  if (time === 0) return [0, 0];

  const halfAccel = trunc(accel / 2);
  const jerkOverSix = trunc(jerk / 6);

  let start: number;
  if (accum === "clear") {
    start = 0;
    let tempRate = rate - halfAccel + jerkOverSix + accel;
    if (tempRate < 0) {
      start = 2147483647;
    } else if (tempRate === 0) {
      tempRate = accel + jerk;
      if (tempRate < 0) start = 2147483647;
      else if (tempRate === 0 && jerk < 0) start = 2147483647;
    }
  } else {
    start = trunc(accum);
  }

  const rateD = Dec.of(rate);
  const accelD = Dec.of(accel);
  const jerkD = Dec.of(jerk);
  const timeD = Dec.of(time);
  const two = Dec.of(2);
  const six = Dec.of(6);
  const accelHalf = accelD.div(two);
  const jerkSixth = jerkD.div(six);

  // rate + accel/2 - int(accel/2) + int(jerk/6) - jerk/6, evaluated left to right
  const rateEffective = rateD
    .add(accelHalf)
    .sub(Dec.of(halfAccel))
    .add(Dec.of(jerkOverSix))
    .sub(jerkSixth);

  // accum + T*(rate_eff + T*(accel/2 + T*(jerk/6))), innermost first
  const accumFinal = Dec.of(start).add(
    timeD.mul(rateEffective.add(timeD.mul(accelHalf.add(timeD.mul(jerkSixth)))))
  );

  const rounded = accumFinal.toIntegerHalfUp();
  // Python: math.floor(int / int) -- true division to a correctly rounded float.
  const pos = Math.floor(Number(rounded) / EBB_ACCUMULATOR_MAX);
  const remainder = rounded - ACC_MAX_BIG * BigInt(pos);
  return [pos, Number(remainder)];
}

/**
 * Step rate on one axis after `time` ticks of a T3 move (time 0 gives the
 * rate before the move starts).
 */
export function rateT3(
  time: number,
  rate: number,
  accel: number,
  jerk: number
): number {
  time = trunc(time);
  if (time === 0) return rate + accel + jerk;
  const intPart = trunc(rate) - trunc(accel / 2) + trunc(jerk / 6);
  const linear = (trunc(accel) - jerk / 2) * time;
  // jerk*time*time is exact integer math in Python before the true division.
  const quadratic = Number(BigInt(jerk) * BigInt(time) * BigInt(time)) / 2;
  return roundHalfEven(intPart + linear + quadratic);
}

/** Largest |rate| reached during a T3 move on one axis. */
export function maxRateT3(
  time: number,
  rate: number,
  accel: number,
  jerk: number
): number {
  time = trunc(time);
  const vStart = Math.abs(rateT3(1, rate, accel, jerk));
  if (time <= 1) return vStart;
  const vEnd = Math.abs(rateT3(time, rate, accel, jerk));
  if (jerk === 0) return Math.max(vStart, vEnd);
  const tMid = (jerk / 2 - accel) / jerk;
  if (1.5 < tMid && tMid < time - 1.5) {
    const vMid = Math.abs(rateT3(Math.ceil(tMid), rate, accel, jerk));
    return Math.max(vStart, vEnd, vMid);
  }
  return Math.max(vStart, vEnd);
}
