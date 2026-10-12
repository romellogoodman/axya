/*
 * The slice of nextdraw's NextDraw object that the machine layer reads and
 * writes. Field names mirror the Python attributes (nd_ref.options,
 * nd_ref.machine, nd_ref.plot_status, ...) so the integrator's NextDraw port
 * can implement this interface directly.
 *
 * Not itself a port; see the ported modules alongside for provenance.
 */

import type { ConfigState } from "../config.ts";
import type { Clock } from "../ebb/transport.ts";
import type { EBBMotionWrap } from "../ebb/motion.ts";
import type { PlotWarnings } from "../warnings.ts";
import type { PlotStatus } from "../run/status.ts";
import type { PenHandler } from "./pen.ts";
import type { HomingClass } from "./homing.ts";

/**
 * Motion-planner entry points the machine layer needs but does not own.
 * go_to_position is NextDraw.go_to_position (nextdraw.py): plan a pen-up
 * straight move with motion.compute_segment and feed it with dripfeed.
 */
export interface PlannerHooks {
  go_to_position(
    x_dest: number,
    y_dest: number,
    ignore_limits?: boolean
  ): Promise<void>;
}

/** Preview hook used by pen raise/lower in preview mode (preview.py VelocityChart.rest). */
export interface PreviewHooks {
  v_chart: { rest(nd_ref: MachineContext, v_time: number): void };
}

export interface MachineContext extends ConfigState {
  machine: EBBMotionWrap;
  clock: Clock;
  pen: PenHandler;
  homing: HomingClass;
  warnings: PlotWarnings;
  plot_status: Pick<
    PlotStatus,
    | "stopped"
    | "button"
    | "limit"
    | "power"
    | "connection"
    | "monitor"
    | "resume"
    | "stats"
  >;
  planner: PlannerHooks;
  preview: PreviewHooks;
  /** Set by enable_motors (serial_utils.py:171-218). */
  step_scale: number;
  speed_pendown: number;
  speed_penup: number;
  use_layer_speed: boolean;
  layer_speed_pendown: number;
  connected: boolean; // Python API flag
  user_message_fun(text: string): void;
  /** Software pause (SIGINT/SIGTERM or UI) requested. */
  receive_pause_request(): boolean;
}
