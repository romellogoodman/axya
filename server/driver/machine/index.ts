/*
 * Machine layer: pen lift, status byte, motors, homing and origin, and the
 * machine-facing NextDraw commands, over the EBB layer (../ebb).
 *
 * Context. Every function takes a MachineContext (context.ts), the slice of
 * nextdraw's NextDraw object it touches, with Python attribute names:
 *   options, params, bounds    ConfigState from ../config.ts
 *   machine                    EBBMotionWrap (serial link)
 *   clock                      Clock: host-side sleeps (pen settle, polls)
 *   pen, homing                PenHandler, HomingClass
 *   warnings                   PlotWarnings (../warnings.ts)
 *   plot_status                PlotStatus (../run/status.ts) or a subset:
 *                              stopped, button, limit, power, connection,
 *                              monitor, resume.drip, stats
 *   planner.go_to_position(x, y, ignore_limits)
 *                              plan + dripfeed a pen-up move (owned by the
 *                              motion/run phases; used by walk commands)
 *   preview.v_chart.rest(nd, ms)   preview-mode pen timing
 *   step_scale, speed_pendown, speed_penup   set by enableMotors
 *   use_layer_speed, layer_speed_pendown, connected
 *   user_message_fun(text), receive_pause_request()
 *
 * Public API
 *   status.ts   connect, queryVoltage, readStatusByte, exhaustQueue,
 *               absMoveWrapper, enableMotors, readStepPosition,
 *               readStepOffsets, writeStepOffsets      (serial_utils.py)
 *   pen.ts      PenHandler (servoInit, penRaise, penLower, cycle,
 *               setTempHeight, endTempHeight, servoRevert), PenPosition,
 *               PenHeight, PenLiftTiming, PenStatus    (pen_handling.py)
 *   homing.ts   HomingClass (findHome, setHome, readPosition,
 *               adjustOriginOffset, precisionMoveTo, block, ...),
 *               xyToStepPos, stepsToXyPos              (homing.py)
 *   utility.ts  serialConnect, queryEbbVoltage, disconnect, setupCommand,
 *               utilityCommand, preparePlot            (nextdraw.py)
 *   createMachineContext: a standalone context with defaults.
 */

import type { ConfigState } from "../config.ts";
import type { EBBMotionWrap } from "../ebb/motion.ts";
import { realClock, type Clock } from "../ebb/transport.ts";
import { PlotStatus } from "../run/status.ts";
import { PlotWarnings } from "../warnings.ts";
import type { MachineContext, PlannerHooks } from "./context.ts";
import { HomingClass } from "./homing.ts";
import { PenHandler } from "./pen.ts";

export * from "./context.ts";
export * from "./status.ts";
export * from "./pen.ts";
export * from "./homing.ts";
export * from "./utility.ts";

export interface MachineContextInit {
  config: ConfigState;
  machine: EBBMotionWrap;
  clock?: Clock;
  planner?: PlannerHooks;
  message?: (text: string) => void;
  receivePauseRequest?: () => boolean;
}

/** A context for driving the machine without the rest of the NextDraw port. */
export function createMachineContext(init: MachineContextInit): MachineContext {
  const message = init.message ?? (() => {});
  const nd = {
    ...init.config,
    machine: init.machine,
    clock: init.clock ?? realClock,
    pen: new PenHandler(),
    warnings: new PlotWarnings(),
    plot_status: new PlotStatus(),
    planner: init.planner ?? {
      go_to_position: async () => {
        throw new Error("no motion planner attached");
      },
    },
    preview: { v_chart: { rest: () => {} } },
    step_scale: 0,
    speed_pendown: 0,
    speed_penup: 0,
    use_layer_speed: false,
    layer_speed_pendown: -1,
    connected: false,
    user_message_fun: message,
    receive_pause_request: init.receivePauseRequest ?? (() => false),
  } as Omit<MachineContext, "homing"> as MachineContext;
  nd.homing = new HomingClass(nd, message);
  return nd;
}
