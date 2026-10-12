/*
 * Motion planner public API: S-curve trajectory planning and the EBB
 * T3/TD command strings it produces.
 *
 * motionScales is ported from nextdrawcore/serial_utils.py (enable_motors,
 * the step-scale and speed part) in nextdraw 1.7.5,
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/serial_utils.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * PlannerContext lists every nd_ref field motion.py and plan_utils.py read
 * (and the one they write, warnings). The run loop owns it and keeps it
 * current; the planner never changes it except for the bounds warning.
 *
 *   options.accel            calc_jerk. Clamped to 1..100 by update_options.
 *   params.resolution        1 or 2; picks the trim threshold in plan_trajectory.
 *   params.const_speed       pen-down constant-speed mode (handling 4).
 *   params.bounds_tolerance  clamp slack before compute_segment warns.
 *   params.jerk_pen_up/down  in/s^3 before the accel derate (calc_jerk).
 *   params.model_name        only passed to the bounds warning.
 *     All params come from models.apply_model_and_handling (via
 *     update_options); see config.ts.
 *   bounds                   [[-1e-9, -1e-9], [travel_x + 1e-9, travel_y + 1e-9]],
 *                            set by update_options.
 *   step_scale               steps per inch of belt: 2032 (resolution 1) or
 *                            1016 (resolution 2). Set by enable_motors.
 *   speed_pendown            in/s; enable_motors: (layer +s speed if the
 *                            current layer has one, else options.speed_pendown)
 *                            * params.speed_limit / 100. Recomputed by
 *                            eval_layer_props at each layer start and again
 *                            when plot_doc_digest restores the speed after
 *                            the layer.
 *   speed_penup              in/s; enable_motors: options.speed_penup *
 *                            params.speed_up / 100.
 *   pen.phys                 the live PenPosition. Only read: copied when no
 *                            xyz_pos is passed, and plan_trajectory refuses to
 *                            plan while pen.phys.xpos is null. dripfeed
 *                            commits each move's snapshot to it.
 *   warnings.add_new         optional; receives ("bounds", model_name) when
 *                            compute_segment clamps a target by more than
 *                            bounds_tolerance.
 *
 * motionScales() computes step_scale and both speeds exactly as
 * enable_motors does.
 */

import type { Bounds, Options, Params } from "../config.ts";
import type { PenPosition } from "./types.ts";

export interface PlannerContext {
  options: Pick<Options, "accel">;
  params: Pick<
    Params,
    | "resolution"
    | "const_speed"
    | "bounds_tolerance"
    | "jerk_pen_up"
    | "jerk_pen_down"
    | "model_name"
  >;
  bounds: Bounds;
  step_scale: number;
  speed_pendown: number;
  speed_penup: number;
  pen: { phys: PenPosition };
  warnings?: { add_new(warningName: string, value?: string): void };
}

export interface MotionScales {
  step_scale: number;
  speed_pendown: number;
  speed_penup: number;
}

/**
 * serial_utils.enable_motors (serial_utils.py:179-218), minus the EBB I/O.
 * layerSpeedPendown is nd_ref.layer_speed_pendown when use_layer_speed is
 * set, else null.
 */
export function motionScales(
  options: Pick<Options, "speed_pendown" | "speed_penup">,
  params: Pick<
    Params,
    "resolution" | "native_res_factor" | "speed_limit" | "speed_up"
  >,
  layerSpeedPendown: number | null = null
): MotionScales {
  const localSpeedPendown =
    layerSpeedPendown !== null ? layerSpeedPendown : options.speed_pendown;
  if (params.resolution === 1) {
    return {
      step_scale: 2.0 * params.native_res_factor,
      speed_pendown: (localSpeedPendown * params.speed_limit) / 100.0,
      speed_penup: (options.speed_penup * params.speed_up) / 100.0,
    };
  }
  return {
    step_scale: params.native_res_factor,
    speed_pendown: (localSpeedPendown * params.speed_limit) / 100.0,
    speed_penup: (options.speed_penup * params.speed_up) / 100.0,
  };
}

export {
  trajectory,
  planTrajectory,
  computeSegment,
  computeSubsegmentCmds,
  MAX_STEP_DIST_HR,
  MAX_STEP_DIST_LR,
  type SegmentTarget,
} from "./planner.ts";
export {
  calcJerk,
  scurvePlan,
  scurveJerk,
  scurveJerk2,
  scurveTime,
  striangle,
  tdSegData,
  t3SegData,
} from "./planUtils.ts";
export { formatMove, formatT3, formatTD, formatSM } from "./commands.ts";
export * from "./types.ts";
