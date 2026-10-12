/*
 * Data shapes shared by the planner and its callers: the pen position the
 * planner threads through a path, and the move lists it returns.
 *
 * Ported from nextdrawcore/pen_handling.py (PenPosition) and the move-list
 * format of nextdrawcore/motion.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/.
 * Copyright 2025 Windell H. Oskay, Bantam Tools
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

/**
 * pen_handling.PenPosition: XYZ position in inches plus the EBB step
 * accumulators (2^31 = one step) carried between motion commands.
 */
export interface PenPosition {
  xpos: number | null;
  ypos: number | null;
  z_up: boolean | null; // null: unknown
  accum1: number;
  accum2: number;
  homed: boolean;
}

/** copy.copy(PenPosition): a plain shallow snapshot. */
export function copyPen(pos: PenPosition): PenPosition {
  return {
    xpos: pos.xpos,
    ypos: pos.ypos,
    z_up: pos.z_up,
    accum1: pos.accum1,
    accum2: pos.accum2,
    homed: pos.homed,
  };
}

/** [distance moved (in), pen position after the command]. */
export type SegData = [number, PenPosition];

/** T3 params: [ticks, rate1, accel1, jerk1, rate2, accel2, jerk2]. */
export type T3Params = [number, number, number, number, number, number, number];

/** TD params: [ticks, rate1A, rate1B, accel1, jerk1, rate2A, rate2B, accel2, jerk2]. */
export type TDParams = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** SM params as dripfeed reads them: [steps2, steps1, ms]. */
export type SMParams = [number, number, number];

export type MotionMove =
  | ["T3", T3Params, SegData]
  | ["TD", TDParams, SegData]
  | ["SM", SMParams, unknown[]];

export type PenMove = ["lower", null] | ["raise", null];

export type Move = MotionMove | PenMove;

/** compute_segment's second return value: [final xyz_pos]. */
export type DataList = [PenPosition];

/** compute_segment's return value: (move_list, data_list) or (None, None). */
export type SegmentResult = [MotionMove[], DataList] | [null, null];

/**
 * An element of the list trajectory() returns. Normally a Move; the
 * single-segment quirk in plan_trajectory (motion.py:228-231) splices in the
 * two halves of a compute_segment result instead, which dripfeed ignores.
 */
export type TrajectoryItem = Move | MotionMove[] | DataList | null;
