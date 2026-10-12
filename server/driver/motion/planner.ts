/*
 * Trajectory planning: junction speeds along a polyline, the S-curve
 * profile of each straight segment, and its conversion to T3/TD commands.
 *
 * Ported from nextdrawcore/motion.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/motion.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Parity notes. Python's array('f') stores float32, so every value written
 * to traj_dists, traj_vels, dist_array, vel_array and jerk_array goes
 * through Math.fround at the same point (motion.py:180-181, 542-545).
 * round() is half-even and gives ints (pyRound); int negation never gives
 * -0 (negInt). xyz_pos is mutated in place, as in Python, and each move's
 * seg_data holds a copy taken right after that move.
 */

import type { PlannerContext } from "./index.ts";
import { moveDistT3, rateT3 } from "./ebbCalc.ts";
import {
  calcJerk,
  scurveJerk,
  scurveJerk2,
  scurvePlan,
  scurveTime,
  striangle,
  t3SegData,
  tdSegData,
} from "./planUtils.ts";
import { checkLimitsTol, distance, dotProductXY } from "./plotUtils.ts";
import { isclose, negInt, pyMin, pyPow, pyRound, pySqrt } from "./pyMath.ts";
import {
  copyPen,
  type DataList,
  type MotionMove,
  type PenPosition,
  type SegmentResult,
  type T3Params,
  type TDParams,
  type TrajectoryItem,
} from "./types.ts";

/** Rounded-up distance of one step in low-/high-resolution mode (inches). */
export const MAX_STEP_DIST_LR = 0.000696;
export const MAX_STEP_DIST_HR = 0.000348;

/** compute_segment's input: (x_dest, y_dest, v_initial, v_final, ignore_limits). */
export type SegmentTarget = [number, number, number, number, boolean];

const f32 = Math.fround;

/** IndexError on a Python list read past its end. */
function at<T>(list: readonly T[], index: number): T {
  if (index < 0 || index >= list.length) {
    throw new RangeError("list index out of range");
  }
  return list[index];
}

/**
 * Plan a pen-down path: ['lower', null], the motion moves, ['raise', null].
 * Plans from a copy of pen.phys unless xyz_pos is given; in either case the
 * starting z_up is forced to false (and a given xyz_pos is mutated).
 */
export function trajectory(
  ctx: PlannerContext,
  vertexList: number[][],
  xyzPos: PenPosition | null = null
): TrajectoryItem[] | null {
  const moveList: TrajectoryItem[] = [];
  moveList.push(["lower", null]);

  if (xyzPos === null) xyzPos = copyPen(ctx.pen.phys);
  xyzPos.z_up = false;
  const middleMoves = planTrajectory(ctx, vertexList, xyzPos);

  // nextdraw quirk: plan_trajectory never returns None, so this guard is
  // dead; its (None, None) and (moves, data) tuples are spliced in below
  // as two list items each (motion.py:78-82).
  if (middleMoves === null) return null;

  moveList.push(...middleMoves);
  moveList.push(["raise", null]);
  return moveList;
}

/**
 * Junction-speed planning for a polyline, then compute_segment per kept
 * segment. Returns the concatenated moves, or a SegmentResult-shaped tuple
 * in the cases noted below.
 */
export function planTrajectory(
  ctx: PlannerContext,
  vertexList: number[][],
  xyzPos: PenPosition | null = null
): MotionMove[] | SegmentResult {
  let trajLength = vertexList.length;
  if (trajLength < 2) return [null, null];

  if (ctx.pen.phys.xpos === null) return [null, null];

  if (xyzPos === null) xyzPos = copyPen(ctx.pen.phys);

  const fPenUp = xyzPos.z_up;

  if (trajLength < 3) {
    const segmentInputData: SegmentTarget = [
      vertexList[1][0],
      vertexList[1][1],
      0,
      0,
      false,
    ];
    const moveList: MotionMove[] = [];
    const [moveTemp] = computeSegment(ctx, segmentInputData, xyzPos);
    if (moveTemp !== null) moveList.push(...moveTemp);
    return moveList;
  }

  let speedLimit = ctx.speed_pendown;
  if (fPenUp) speedLimit = ctx.speed_penup;

  const trajDists: number[] = [];
  const trajVels: number[] = [];
  const trajVectors: number[][] = [];
  const trimmedPath: number[][] = [];

  trajDists.push(f32(0.0));
  trajVels.push(f32(0.0));

  const minDist =
    ctx.params.resolution === 1 ? MAX_STEP_DIST_HR : MAX_STEP_DIST_LR;

  let lastIndex = 0;
  for (let i = 1; i < trajLength; i++) {
    const tmpDistX = vertexList[i][0] - vertexList[lastIndex][0];
    const tmpDistY = vertexList[i][1] - vertexList[lastIndex][1];
    const tmpDist = distance(tmpDistX, tmpDistY);

    if (tmpDist >= minDist) {
      trajDists.push(f32(tmpDist));
      trajVectors.push([tmpDistX / tmpDist, tmpDistY / tmpDist]);
      trimmedPath.push([vertexList[i][0], vertexList[i][1]]);
      lastIndex = i;
    }
  }

  trajLength = trajDists.length;

  if (trajLength < 2) return [null, null];

  if (trajLength < 3) {
    // nextdraw quirk: returns compute_segment's (moves, data) tuple rather
    // than its move list, so trajectory() splices in two non-move items
    // and the segment is never plotted (motion.py:228-231).
    const segmentInputData: SegmentTarget = [
      trimmedPath[0][0],
      trimmedPath[0][1],
      0,
      0,
      false,
    ];
    return computeSegment(ctx, segmentInputData, xyzPos);
  }

  const [jerkUp, jerkDown] = calcJerk(ctx);
  const jerkRate = fPenUp ? jerkUp : jerkDown;

  for (let i = 1; i < trajLength - 1; i++) {
    const segLength = at(trajDists, i);
    const vPrevExit = at(trajVels, i - 1);

    let vcurrentMax = scurvePlan(
      vPrevExit,
      speedLimit,
      jerkRate,
      segLength,
      0.007
    );

    // nextdraw quirk: skipping the append misaligns traj_vels; Python then
    // raises IndexError below. Unreachable for positive segment lengths.
    if (vcurrentMax === null) continue;

    let vec = at(trajVectors, i - 1);
    let velLen = distance(vec[0], vec[1]);
    const vJ1 = [vec[0] / velLen, vec[1] / velLen];

    vec = at(trajVectors, i);
    velLen = distance(vec[0], vec[1]);
    const vJ2 = [vec[0] / velLen, vec[1] / velLen];

    let cosineFactor = dotProductXY(vJ1, vJ2);
    if (cosineFactor < 0) cosineFactor = 0;

    if (vcurrentMax > speedLimit * 0.5) {
      vcurrentMax = pyMin(vcurrentMax, vcurrentMax * pyPow(cosineFactor, 4));
    } else if (vcurrentMax > speedLimit * 0.25) {
      vcurrentMax = pyMin(vcurrentMax, vcurrentMax * cosineFactor);
    }
    vcurrentMax = pyMin(vcurrentMax, speedLimit * 0.8);

    trajVels.push(f32(vcurrentMax));
  }

  trajVels.push(f32(0.0));

  for (let j = 1; j < trajLength; j++) {
    const i = trajLength - j;

    const vFinal = at(trajVels, i);
    const vInitial = at(trajVels, i - 1);
    const segLength = at(trajDists, i);

    if (
      segLength <= 0 ||
      vInitial < vFinal ||
      isclose(vInitial, vFinal, 1e-9, 1e-9)
    ) {
      // no deceleration check needed
    } else {
      const vInitMax = scurvePlan(
        vFinal,
        speedLimit,
        jerkRate,
        segLength,
        0.007
      );
      if (vInitMax === null) {
        throw new TypeError("'<' not supported between 'NoneType' and 'float'");
      }
      trajVels[i - 1] = f32(pyMin(vInitial, vInitMax));
    }
  }

  const moveList: MotionMove[] = [];
  for (let i = 0; i < trajLength - 1; i++) {
    const segmentInputData: SegmentTarget = [
      at(trimmedPath, i)[0],
      at(trimmedPath, i)[1],
      at(trajVels, i),
      at(trajVels, i + 1),
      false,
    ];
    const segment = computeSegment(ctx, segmentInputData, xyzPos);
    if (segment[0] !== null) {
      xyzPos = segment[1][0];
      moveList.push(...segment[0]);
    }
  }
  return moveList;
}

/**
 * Plan one straight segment from xyz_pos (default: a copy of pen.phys) to
 * the target with the given entry and exit speeds. Returns (moves,
 * [xyz_pos]) or (null, null) when there is no position, the move is under
 * one step, or no reduced-jerk profile fits.
 */
export function computeSegment(
  ctx: PlannerContext,
  data: SegmentTarget,
  xyzPos: PenPosition | null = null
): SegmentResult {
  let [xDest, yDest, viInchPerS, vfInchPerS] = data;
  const ignoreLimits = data[4];

  if (xyzPos === null) xyzPos = copyPen(ctx.pen.phys);

  const fCurrentX = xyzPos.xpos;
  if (fCurrentX === null) return [null, null];

  const fCurrentY = xyzPos.ypos as number;
  const fPenUp = xyzPos.z_up;

  let constantVelMode = false;
  if (ctx.params.const_speed && !fPenUp) constantVelMode = true;

  if (!ignoreLimits) {
    const tolerance = ctx.params.bounds_tolerance;
    let xBounded: boolean, yBounded: boolean;
    [xDest, xBounded] = checkLimitsTol(
      xDest,
      ctx.bounds[0][0],
      ctx.bounds[1][0],
      tolerance
    );
    [yDest, yBounded] = checkLimitsTol(
      yDest,
      ctx.bounds[0][1],
      ctx.bounds[1][1],
      tolerance
    );
    if (xBounded || yBounded) {
      ctx.warnings?.add_new("bounds", ctx.params.model_name);
    }
  }

  const deltaXInches = xDest - fCurrentX;
  const deltaYInches = yDest - fCurrentY;

  const motorDist1 = deltaXInches + deltaYInches;
  const motorDist2 = deltaXInches - deltaYInches;
  const motorSteps1 = pyRound(ctx.step_scale * motorDist1);
  const motorSteps2 = pyRound(ctx.step_scale * motorDist2);

  const motorDist1Rounded = motorSteps1 / (2.0 * ctx.step_scale);
  const motorDist2Rounded = motorSteps2 / (2.0 * ctx.step_scale);
  const deltaXInchesRounded = motorDist1Rounded + motorDist2Rounded;
  const deltaYInchesRounded = motorDist1Rounded - motorDist2Rounded;

  if (Math.abs(motorSteps1) < 1 && Math.abs(motorSteps2) < 1) {
    return [null, null];
  }

  const distInch = distance(deltaXInchesRounded, deltaYInchesRounded);

  const [jerkUp, jerkDown] = calcJerk(ctx);

  let speedLimit: number, jerkRate: number;
  if (fPenUp) {
    speedLimit = ctx.speed_penup;
    jerkRate = jerkUp;
  } else {
    speedLimit = ctx.speed_pendown;
    jerkRate = jerkDown;
  }

  if (constantVelMode) {
    viInchPerS = speedLimit;
    vfInchPerS = speedLimit;
  } else {
    viInchPerS = pyMin(viInchPerS, speedLimit);
    vfInchPerS = pyMin(vfInchPerS, speedLimit);
  }

  // 1: S-curve accelerating, 2: S-curve decelerating, 3: constant velocity
  const subsegArray: number[] = [];
  const distArray: number[] = [];
  const velArray: number[] = [];
  const jerkArray: number[] = [];

  let accelDistInch = 0;
  let decelDistInch = 0;

  let segCase = 0;
  let constSpeedTime: number;
  if (isclose(viInchPerS, 0)) {
    constSpeedTime = 100; // tags it as "not a short-time duration segment"
  } else {
    constSpeedTime = distInch / viInchPerS;
  }

  if (
    constantVelMode ||
    (isclose(viInchPerS, speedLimit) && isclose(vfInchPerS, speedLimit))
  ) {
    segCase = 3;
  } else if (
    isclose(viInchPerS, vfInchPerS, 1e-9, 1e-2) &&
    constSpeedTime < 0.013
  ) {
    segCase = 3;
  } else if (
    isclose(viInchPerS, vfInchPerS, 1e-9, 1e-2) &&
    constSpeedTime < 0.03 &&
    viInchPerS > speedLimit / 2
  ) {
    segCase = 3;
  } else {
    accelDistInch = scurvePlan(
      viInchPerS,
      speedLimit,
      jerkRate,
      null
    ) as number;
    decelDistInch = scurvePlan(
      vfInchPerS,
      speedLimit,
      jerkRate,
      null
    ) as number;

    const distSvm = accelDistInch + decelDistInch;

    let distSse: number;
    if (viInchPerS <= vfInchPerS) {
      distSse = scurvePlan(viInchPerS, vfInchPerS, jerkRate, null) as number;
    } else {
      distSse = scurvePlan(vfInchPerS, viInchPerS, jerkRate, null) as number;
    }

    // t_sse (motion.py:591, 606-607) is computed but never used; omitted.

    if (distInch >= distSvm) {
      if (isclose(viInchPerS, speedLimit)) {
        segCase = isclose(distInch, distSvm) ? 2 : 4;
      } else if (isclose(vfInchPerS, speedLimit)) {
        segCase = isclose(distInch, distSvm) ? 1 : 5;
      } else {
        segCase = 6;
      }
    } else if (
      isclose(viInchPerS, vfInchPerS, 1e-9, 1e-3) &&
      isclose(viInchPerS, 0, 1e-9, 1e-3)
    ) {
      segCase = 7;
    } else if (distInch > distSse) {
      segCase = 7;
    } else if (isclose(distInch, distSse, 1e-9, 1e-3)) {
      segCase = viInchPerS < vfInchPerS ? 1 : 2;
    }
  }

  jerkArray.push(f32(jerkRate));

  if (segCase === 1) {
    subsegArray.push(1);
  } else if (segCase === 2) {
    subsegArray.push(2);
  } else if (segCase === 3) {
    subsegArray.push(3);
  } else if (segCase === 4) {
    subsegArray.push(3);
    distArray.push(f32(distInch - decelDistInch));
    velArray.push(f32(speedLimit));
    subsegArray.push(2);
    jerkArray.push(f32(jerkRate));
  } else if (segCase === 5) {
    subsegArray.push(1);
    distArray.push(f32(accelDistInch));
    velArray.push(f32(speedLimit));
    subsegArray.push(3);
    jerkArray.push(f32(jerkRate));
  } else if (segCase === 6) {
    subsegArray.push(1);
    distArray.push(f32(accelDistInch));
    velArray.push(f32(speedLimit));
    subsegArray.push(3);
    distArray.push(f32(distInch - decelDistInch));
    velArray.push(f32(speedLimit));
    subsegArray.push(2);
    jerkArray.push(f32(jerkRate));
    jerkArray.push(f32(jerkRate));
  } else if (segCase === 7) {
    const vMid = striangle(
      viInchPerS,
      vfInchPerS,
      speedLimit,
      jerkRate,
      distInch
    );

    const time1 = scurveTime(viInchPerS, vMid, jerkRate);
    const time2 = scurveTime(vMid, vfInchPerS, jerkRate);

    let time3 = 0;
    const jTemp = scurveJerk(viInchPerS, vfInchPerS, distInch, jerkRate);
    if (jTemp !== null) time3 = scurveTime(viInchPerS, vfInchPerS, jTemp);

    if (time3 !== 0) {
      if (time1 + time2 > time3 || time1 + time2 < 0.012) segCase = 0;
    }

    if (segCase === 7) {
      accelDistInch = scurvePlan(viInchPerS, vMid, jerkRate, null) as number;
      subsegArray.push(1);
      distArray.push(f32(accelDistInch));
      velArray.push(f32(vMid));
      subsegArray.push(2);
      jerkArray.push(f32(jerkRate));
    }
  }

  if (segCase === 0) {
    let jTemp = scurveJerk(viInchPerS, vfInchPerS, distInch, jerkRate);
    if (jTemp === null) {
      jTemp = scurveJerk2(viInchPerS, vfInchPerS, distInch, jerkRate);
    }
    if (jTemp !== null) {
      jerkArray[jerkArray.length - 1] = f32(jTemp);
      subsegArray.push(viInchPerS < vfInchPerS ? 1 : 2);
    } else {
      // nextdraw quirk: the segment is dropped without moving; the next
      // segment starts from the true position (motion.py:786-789).
      return [null, null];
    }
  }

  return computeSubsegmentCmds(
    [
      viInchPerS,
      xyzPos,
      motorSteps1,
      motorSteps2,
      ctx.step_scale,
      vfInchPerS,
      distInch,
    ],
    subsegArray,
    distArray,
    velArray,
    jerkArray
  );
}

/**
 * compute_subsegment_cmds params: [vi (in/s), xyz_pos, motor_steps_1,
 * motor_steps_2, step_scale, vf (in/s), segment length (in)].
 */
export type SubsegmentParams = [
  number,
  PenPosition,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Turn a segment's subsegment plan (codes 1/2/3 with float32 distance,
 * speed and jerk arrays) into TD/T3 moves, advancing xyz_pos through the
 * firmware model after each one.
 */
export function computeSubsegmentCmds(
  params: SubsegmentParams,
  subsegArray: readonly number[],
  distArray: readonly number[],
  velArray: readonly number[],
  jerkArray: readonly number[]
): [MotionMove[], DataList] {
  const [
    viInchPerS,
    xyzPos,
    motorSteps1,
    motorSteps2,
    stepScale,
    vfInchPerS,
    segmentLengthInch,
  ] = params;

  const velocityScale = stepScale * (2147483648 / 25000);
  const jerkScale = (stepScale * 2147483648) / 25000 ** 3;
  const isrToSteps = 1.0 / 2147483648;

  const motorStepDist = distance(motorSteps1, motorSteps2);
  const vNorm1 = (Math.SQRT2 * motorSteps1) / motorStepDist;
  const vNorm2 = (Math.SQRT2 * motorSteps2) / motorStepDist;

  let prevMotor1 = 0;
  let prevMotor2 = 0;

  let prevVelIsr1 = pyRound(viInchPerS * velocityScale * vNorm1);
  let prevVelIsr2 = pyRound(viInchPerS * velocityScale * vNorm2);

  const moveList: MotionMove[] = [];
  const subsegmentCount = subsegArray.length;

  for (let index = 0; index < subsegmentCount; index++) {
    let motorDest1: number, motorDest2: number, subsegmentVf: number;
    if (index === subsegmentCount - 1) {
      motorDest1 = motorSteps1;
      motorDest2 = motorSteps2;
      subsegmentVf = vfInchPerS;
    } else {
      subsegmentVf = at(velArray, index);
      motorDest1 = pyRound(
        (motorSteps1 * at(distArray, index)) / segmentLengthInch
      );
      motorDest2 = pyRound(
        (motorSteps2 * at(distArray, index)) / segmentLengthInch
      );
    }

    const stepsSubseg1 = motorDest1 - prevMotor1;
    const stepsSubseg2 = motorDest2 - prevMotor2;

    const velIsr1 = pyRound(subsegmentVf * velocityScale * vNorm1);
    const velIsr2 = pyRound(subsegmentVf * velocityScale * vNorm2);

    const jerkRate = at(jerkArray, index);
    const jerk1 = jerkRate * jerkScale * vNorm1;
    const jerk2 = jerkRate * jerkScale * vNorm2;

    let t1 = 0;
    let t2 = 0;

    const code = subsegArray[index];
    if (code === 1 || code === 2) {
      // Two T3 halves: jerk +j then -j (accelerating) or the reverse.
      const accel = code === 1;
      const j1 = accel ? pyRound(jerk1) : negInt(pyRound(jerk1));
      const j2 = accel ? pyRound(jerk2) : negInt(pyRound(jerk2));

      if (j1 !== 0)
        t1 = pyRound(pySqrt(Math.abs((velIsr1 - prevVelIsr1) / j1)));
      if (j2 !== 0)
        t2 = pyRound(pySqrt(Math.abs((velIsr2 - prevVelIsr2) / j2)));

      // The axis that travels farther sets the time; max(t1, t2) would be
      // wrong when one axis does not move.
      const testDist1 = moveDistT3(t1, prevVelIsr1, 0, j1)[0];
      const testDist2 = moveDistT3(t2, prevVelIsr2, 0, j2)[0];
      const moveTime = Math.abs(testDist1) > Math.abs(testDist2) ? t1 : t2;

      if (moveTime === 0) continue;

      const a1 = accel ? pyRound(jerk1 * moveTime) : pyRound(-jerk1 * moveTime);
      const a2 = accel ? pyRound(jerk2 * moveTime) : pyRound(-jerk2 * moveTime);

      const vel1 = rateT3(moveTime, prevVelIsr1, 0, j1);
      const vel2 = rateT3(moveTime, prevVelIsr2, 0, j2);

      const tdParams: TDParams = [
        moveTime,
        prevVelIsr1,
        vel1 + a1,
        a1,
        j1,
        prevVelIsr2,
        vel2 + a2,
        a2,
        j2,
      ];

      let tdSteps1: number, tdSteps2: number, subsubsegInchesTd: number;
      [tdSteps1, tdSteps2, subsubsegInchesTd, prevVelIsr1, prevVelIsr2] =
        tdSegData(tdParams, xyzPos, stepScale);

      moveList.push(["TD", tdParams, [subsubsegInchesTd, copyPen(xyzPos)]]);

      prevMotor1 = prevMotor1 + tdSteps1;
      prevMotor2 = prevMotor2 + tdSteps2;
    } else if (code === 3) {
      // Constant velocity; the ceiling makes it overshoot slightly.
      if (velIsr1 !== 0) {
        t1 = Math.ceil(Math.abs(stepsSubseg1 / (velIsr1 * isrToSteps)));
      }
      if (velIsr2 !== 0) {
        t2 = Math.ceil(Math.abs(stepsSubseg2 / (velIsr2 * isrToSteps)));
      }

      const testDist1 = moveDistT3(t1, velIsr1, 0, 0)[0];
      const testDist2 = moveDistT3(t2, velIsr2, 0, 0)[0];
      const moveTime = Math.abs(testDist1) > Math.abs(testDist2) ? t1 : t2;

      if (moveTime === 0) continue;

      const t3Params: T3Params = [moveTime, velIsr1, 0, 0, velIsr2, 0, 0];

      let t3Steps1: number, t3Steps2: number, subsegInches: number;
      [t3Steps1, t3Steps2, subsegInches, prevVelIsr1, prevVelIsr2] = t3SegData(
        t3Params,
        xyzPos,
        stepScale
      );

      moveList.push(["T3", t3Params, [subsegInches, copyPen(xyzPos)]]);

      prevMotor1 = prevMotor1 + t3Steps1;
      prevMotor2 = prevMotor2 + t3Steps2;
    }
  }

  return [moveList, [xyzPos]];
}
