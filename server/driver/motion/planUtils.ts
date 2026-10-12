/*
 * S-curve planning primitives and the firmware-model helpers that track
 * where each T3/TD command leaves the carriage.
 *
 * Ported from nextdrawcore/plan_utils.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/plan_utils.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Units are inches and seconds, except the seg-data helpers, which take
 * EBB rate units (2^31 per step per 40 us tick). The derivation of the
 * S-curve relations is in plan_utils.py:172-293.
 */

import { solve } from "./cubicEqn.ts";
import { moveDistT3, rateT3 } from "./ebbCalc.ts";
import { isComplex, isclose, pyMax, pyMin, pyRound, pySqrt } from "./pyMath.ts";
import type { PenPosition, TDParams, T3Params } from "./types.ts";

/** Unused by nextdraw 1.7.5; kept for parity with plan_utils.Z_MAP. */
export const Z_MAP: readonly number[] = [
  -0.473, -0.468, -0.463, -0.458, -0.452, -0.447, -0.441, -0.434, -0.428,
  -0.421, -0.414, -0.407, -0.399, -0.392, -0.384, -0.376, -0.368, -0.359, -0.35,
  -0.341, -0.332, -0.323, -0.314, -0.304, -0.294, -0.284, -0.274, -0.264,
  -0.254, -0.243, -0.232, -0.222, -0.211, -0.2, -0.188, -0.177, -0.166, -0.154,
  -0.143, -0.131, -0.119, -0.108, -0.096, -0.084, -0.072, -0.06, -0.048, -0.036,
  -0.024, -0.012, 0.0, 0.012, 0.024, 0.036, 0.048, 0.06, 0.072, 0.084, 0.096,
  0.108, 0.119, 0.131, 0.143, 0.154, 0.166, 0.177, 0.188, 0.2, 0.211, 0.222,
  0.232, 0.243, 0.254, 0.264, 0.274, 0.284, 0.294, 0.304, 0.314, 0.323, 0.332,
  0.341, 0.35, 0.359, 0.368, 0.376, 0.384, 0.392, 0.399, 0.407, 0.414, 0.421,
  0.428, 0.434, 0.441, 0.447, 0.452, 0.458, 0.463, 0.468, 0.473,
];

/** The settings calc_layer_speeds reads, plus the step_scale it writes. */
export interface LayerSpeedRef {
  options: { speed_pendown: number; speed_penup: number };
  params: {
    max_step_rate: number;
    resolution: number;
    native_res_factor: number;
    speed_limit: number;
  };
  step_scale: number;
}

/**
 * Dead code in nextdraw 1.7.5 (serial_utils.enable_motors computes the
 * speeds the planner actually uses); ported for completeness. Returns
 * [speed_penup, speed_pendown, max_step_up, max_step_down] and sets
 * ref.step_scale.
 */
export function calcLayerSpeeds(
  ref: LayerSpeedRef,
  layerSpeed: number | null
): [number, number, number, number] {
  let speedPendown = layerSpeed ? layerSpeed : ref.options.speed_pendown;
  speedPendown = pyMin(speedPendown, 100);
  speedPendown = pyMax(speedPendown, 1);
  // nextdraw quirk: re-reads the option, discarding its min(..., 100) clamp
  // from the line before (plan_utils.py:77-79).
  let speedPenup = pyMax(ref.options.speed_penup, 1);

  let maxStepDown = ref.params.max_step_rate * speedPendown * 10;
  let maxStepUp = ref.params.max_step_rate * speedPenup * 10;

  if (ref.params.resolution === 1) {
    ref.step_scale = 2.0 * ref.params.native_res_factor;
    speedPendown = (speedPendown * ref.params.speed_limit) / 100.0;
    speedPenup = (speedPenup * ref.params.speed_limit) / 100.0;
  } else {
    ref.step_scale = ref.params.native_res_factor;
    speedPenup = (speedPenup * ref.params.speed_limit) / 100.0;
    speedPendown = (speedPendown * ref.params.speed_limit) / 100.0;
  }
  maxStepDown = pyRound(maxStepDown);
  maxStepUp = pyRound(maxStepUp);
  return [speedPenup, speedPendown, maxStepUp, maxStepDown];
}

/** The settings calc_jerk reads. */
export interface JerkSettings {
  options: { accel: number };
  params: { jerk_pen_down: number; jerk_pen_up: number };
}

/** Pen-up and pen-down jerk in in/s^3: [jerk_penup, jerk_pendown]. */
export function calcJerk(ref: JerkSettings): [number, number] {
  let accelScaled = pyMin(ref.options.accel, 100) / 100.0;
  accelScaled = accelScaled * accelScaled * accelScaled;
  const jerkPendown = ref.params.jerk_pen_down * accelScaled;
  const jerkPenup = ref.params.jerk_pen_up * accelScaled;
  return [jerkPenup, jerkPendown];
}

/**
 * With dist null: the distance needed to go from v_in to v_max. Otherwise
 * the highest speed reachable from v_in within dist (equivalently, the
 * highest initial speed that can slow to v_in within dist), capped at v_max.
 * null when no solution exists.
 */
export function scurvePlan(
  vIn: number | null,
  vMax: number | null,
  jM: number | null,
  dist: number | null = null,
  minTime: number | null = null
): number | null {
  if (vIn === null || vMax === null || jM === null) return null;

  vIn = Math.abs(vIn);
  vMax = Math.abs(vMax);
  jM = Math.abs(jM);

  if (jM === 0) jM = 1000;

  let tM = pySqrt(Math.abs(vMax - vIn) / jM);
  let dMax = 2 * vIn * tM + jM * tM * tM * tM;

  if (dist === null && isclose(tM, 0)) return 0;

  if (minTime !== null) {
    if (tM < minTime / 2) {
      tM = minTime / 2;
      const jerkNew = Math.abs(vMax - vIn) / (tM * tM);
      dMax = 2 * vIn * tM + jerkNew * tM * tM * tM;
    }
  }

  if (dist === null) return dMax;

  dist = Math.abs(dist);

  if (dist >= dMax || isclose(dist, dMax)) return vMax;

  tM = 1e100;
  const result = solve(jM, 0, 2 * vIn, -dist);
  for (const item of result) {
    if (isComplex(item)) continue;
    if (0 < item && item <= tM) tM = item;
  }

  if (tM > 1e90) return null;

  if (minTime !== null) {
    if (tM < minTime / 2) {
      tM = minTime / 2;
      if (vIn !== 0) {
        if (dist / vIn < minTime) {
          return pyMax((dist - vIn * tM) / tM, 0);
        }
      }
      jM = Math.abs(dist - 2 * vIn * tM) / (tM * tM * tM);
    }
  }

  return pyMin(vMax, vIn + jM * tM * tM);
}

/**
 * Reduced jerk for a single S-curve from v_start to v_end over dist, by
 * bisection on the midpoint time; null if 50 iterations do not converge.
 */
export function scurveJerk(
  vStart: number,
  vEnd: number,
  dist: number,
  maxJerk: number
): number | null {
  return scurveJerkSearch(vStart, vEnd, dist, maxJerk, 0.003, 1.25);
}

/** scurve_jerk with a 2 ms floor and 1.3x jerk leniency. */
export function scurveJerk2(
  vStart: number,
  vEnd: number,
  dist: number,
  maxJerk: number
): number | null {
  return scurveJerkSearch(vStart, vEnd, dist, maxJerk, 0.002, 1.3);
}

// plan_utils.py:375-488: scurve_jerk and scurve_jerk2 differ only in these
// two constants.
function scurveJerkSearch(
  vStart: number,
  vEnd: number,
  dist: number,
  maxJerk: number,
  tmFloor: number,
  leniency: number
): number | null {
  const vI = pyMin(vStart, vEnd);
  const vF = pyMax(vStart, vEnd);

  let tmLower: number;
  if (vI === 0) tmLower = pyMax(tmFloor, dist / (2 * 0.001));
  else tmLower = pyMax(tmFloor, dist / (2 * vI));
  const jerkDen = maxJerk * leniency;
  if (jerkDen === 0) throw new RangeError("float division by zero");
  let tmUpper = pySqrt((vF - vI) / jerkDen);
  let tM = tmLower + tmUpper / 10;

  let iteration = 0;
  while (iteration < 50) {
    const jTemp = Math.abs(dist - 2 * vI * tM) / (tM * tM * tM);
    const vFTemp = vI + jTemp * tM * tM;

    if (isclose(vFTemp, vF, 1e-9, 1e-6)) return jTemp;

    if (vFTemp > vF) tmUpper = tM;
    else tmLower = tM;

    tM = (tmLower + tmUpper) / 2.0;
    iteration += 1;
  }
  return null;
}

/** Duration (s) of an S-curve from v_i to v_f at the given jerk; 0 if jerk is 0. */
export function scurveTime(vI: number, vF: number, jerk: number): number {
  if (jerk === 0) return 0;
  return 2 * pySqrt(Math.abs((vF - vI) / jerk));
}

/**
 * Approximate [rate_in, rate_mid1, rate_mid2, rate_end] (in/s at the 1016
 * steps/in scale nextdraw assumes here) of a TD move. Debug aid only.
 */
export function scurveSpeeds(
  tdMov: TDParams | [...TDParams, number]
): [number, number, number, number] {
  const [time, v1a, v1b, a1, j1, v2a, v2b, a2, j2] = tdMov;
  const distance = (x: number, y: number) => Math.sqrt(x * x + y * y);

  const rateIn = (distance(v1a, v2a) * 25) / 2147483648;
  let vel1 = rateT3(time, v1a, 0, j1);
  let vel2 = rateT3(time, v2a, 0, j2);
  const rateMid1 = (distance(vel1, vel2) * 25) / 2147483648;
  vel1 = rateT3(time, v1b, a1, 0 - j1);
  vel2 = rateT3(time, v2b, a2, 0 - j2);
  const rateMid2 = (distance(v1b, v2b) * 25) / 2147483648;
  const rateEnd = (distance(vel1, vel2) * 25) / 2147483648;
  return [rateIn, rateMid1, rateMid2, rateEnd];
}

/**
 * Highest speed reachable mid-move between v_i and v_f within dist, by
 * bisection between max(v_i, v_f) and v_max.
 */
export function striangle(
  vI: number,
  vF: number,
  vMax: number,
  jerk: number,
  dist: number
): number {
  let lowerBound = pyMax(vI, vF);
  let upperBound = vMax;

  // nextdraw quirk: the loop has no iteration cap (plan_utils.py:560). Once
  // an iteration leaves both bounds unchanged, every later one repeats it
  // exactly and Python would spin forever; throwing there changes no
  // output that Python can produce.
  for (;;) {
    const testV = (lowerBound + upperBound) / 2.0;
    const testDist =
      (scurvePlan(vI, testV, jerk, null) as number) +
      (scurvePlan(vF, testV, jerk, null) as number);

    if (isclose(testDist, dist, 1e-9, 1e-5)) return testV;
    const before = [lowerBound, upperBound];
    if (testDist > dist) upperBound = testV;
    else lowerBound = testV;
    if (Object.is(before[0], lowerBound) && Object.is(before[1], upperBound)) {
      throw new Error("striangle: bisection cannot converge (nextdraw hangs)");
    }
  }
}

/**
 * Apply a TD command to xyz_pos through the firmware model (two T3 halves).
 * Returns [steps1, steps2, inches moved, final rate1, final rate2].
 */
export function tdSegData(
  tdParams: TDParams,
  xyzPos: PenPosition,
  stepScale: number
): [number, number, number, number, number] {
  const [moveTime, v1a, v1b, a1, j1, v2a, v2b, a2, j2] = tdParams;
  const stepDivisor = stepScale * 2.0;

  let tdSteps1A: number, tdSteps2A: number;
  [tdSteps1A, xyzPos.accum1] = moveDistT3(moveTime, v1a, 0, j1, xyzPos.accum1);
  [tdSteps2A, xyzPos.accum2] = moveDistT3(moveTime, v2a, 0, j2, xyzPos.accum2);

  let mDist1 = tdSteps1A / stepDivisor;
  let mDist2 = tdSteps2A / stepDivisor;
  let xDelta = mDist1 + mDist2;
  let yDelta = mDist1 - mDist2;
  let subsegInches = pySqrt(xDelta * xDelta + yDelta * yDelta);

  xyzPos.xpos = (xyzPos.xpos as number) + xDelta;
  xyzPos.ypos = (xyzPos.ypos as number) + yDelta;

  let tdSteps1B: number, tdSteps2B: number;
  [tdSteps1B, xyzPos.accum1] = moveDistT3(
    moveTime,
    v1b,
    a1,
    0 - j1,
    xyzPos.accum1
  );
  [tdSteps2B, xyzPos.accum2] = moveDistT3(
    moveTime,
    v2b,
    a2,
    0 - j2,
    xyzPos.accum2
  );

  mDist1 = tdSteps1B / stepDivisor;
  mDist2 = tdSteps2B / stepDivisor;
  xDelta = mDist1 + mDist2;
  yDelta = mDist1 - mDist2;
  subsegInches += pySqrt(xDelta * xDelta + yDelta * yDelta);

  xyzPos.xpos = xyzPos.xpos + xDelta;
  xyzPos.ypos = xyzPos.ypos + yDelta;

  const rate1 = rateT3(moveTime, v1b, a1, 0 - j1);
  const rate2 = rateT3(moveTime, v2b, a2, 0 - j2);

  return [
    tdSteps1A + tdSteps1B,
    tdSteps2A + tdSteps2B,
    subsegInches,
    rate1,
    rate2,
  ];
}

/**
 * Apply a T3 command to xyz_pos through the firmware model. Returns
 * [steps1, steps2, inches moved, final rate1, final rate2].
 */
export function t3SegData(
  t3Params: T3Params,
  xyzPos: PenPosition,
  stepScale: number
): [number, number, number, number, number] {
  const fCurrentX = xyzPos.xpos as number;
  const fCurrentY = xyzPos.ypos as number;

  const [moveTime, v1, a1, j1, v2, a2, j2] = t3Params;

  let t3Steps1: number, t3Steps2: number;
  [t3Steps1, xyzPos.accum1] = moveDistT3(moveTime, v1, a1, j1, xyzPos.accum1);
  [t3Steps2, xyzPos.accum2] = moveDistT3(moveTime, v2, a2, j2, xyzPos.accum2);

  const mDist1 = t3Steps1 / (stepScale * 2.0);
  const mDist2 = t3Steps2 / (stepScale * 2.0);
  const xDelta = mDist1 + mDist2;
  const yDelta = mDist1 - mDist2;
  const subsegInches = pySqrt(xDelta * xDelta + yDelta * yDelta);

  xyzPos.xpos = fCurrentX + xDelta;
  xyzPos.ypos = fCurrentY + yDelta;

  const rate1 = rateT3(moveTime, v1, a1, j1);
  const rate2 = rateT3(moveTime, v2, a2, j2);

  return [t3Steps1, t3Steps2, subsegInches, rate1, rate2];
}
