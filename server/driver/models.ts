/*
 * Plotter models, handling modes and pen-lift motors, and the logic that
 * applies them to the active parameters.
 *
 * Ported from nextdrawcore/nextdraw_options/models.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw_options/models.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import type { ConfigState } from "./config.ts";

/** Pen-lift motor types (servo PWM values in units of 1/12 MHz ≈ 83.3 ns). */
export interface ZMotor {
  motor_name: string;
  pin: number; // EBB I/O pin driving the motor
  max: number; // PWM width at 100% (pen up)
  min: number; // PWM width at 0% (pen down)
  sweep_time: number; // ms to sweep the full range
  move_min: number; // minimum ms for any non-zero pen move
  move_slope: number; // additional ms per % of travel
}

export const Z_MOTORS: readonly ZMotor[] = [
  {
    motor_name: "Standard servo",
    pin: 1,
    max: 27831,
    min: 9855,
    sweep_time: 200,
    move_min: 45,
    move_slope: 2.69,
  },
  {
    motor_name: "Narrow-band brushless servo",
    pin: 2,
    max: 12600,
    min: 5400,
    sweep_time: 70,
    move_min: 20,
    move_slope: 1.28,
  },
];

/** Handling modes: how the machine is driven (motion-quality presets). */
export interface Handler {
  name: string;
  resolution: number; // 1: high (2874 steps/in), 2: low (1437 steps/in)
  jerk: number; // nominal pen-down jerk, in/s^3; 0 means constant speed
  speed: number; // pen-down speed limit, in/s
  speed_up: number; // pen-up speed limit, in/s
  tolerance: number; // allowed curve-sampling error, inches
}

export const HANDLERS: readonly Handler[] = [
  {
    name: "No handler selected",
    resolution: 0,
    jerk: 0,
    speed: 0,
    speed_up: 0,
    tolerance: 0,
  },
  {
    name: "Technical drawing",
    resolution: 1,
    jerk: 20000,
    speed: 8.6979,
    speed_up: 8.6979,
    tolerance: 0.002,
  },
  {
    name: "Handwriting",
    resolution: 2,
    jerk: 90000,
    speed: 7,
    speed_up: 12,
    tolerance: 0.008,
  },
  {
    name: "Sketching",
    resolution: 2,
    jerk: 14000,
    speed: 12,
    speed_up: 12,
    tolerance: 0.005,
  },
  {
    name: "Constant speed",
    resolution: 1,
    jerk: 0,
    speed: 3.0,
    speed_up: 8.6979,
    tolerance: 0.002,
  },
];

/** Plotter hardware models, indexed by the `model` option (1-10). */
export interface Plotter {
  model_name: string;
  travel_x: number; // inches
  travel_y: number; // inches
  jerk_pen_up_hi: number; // max pen-up jerk, high resolution, in/s^3
  jerk_pen_up_lo: number; // max pen-up jerk, low resolution, in/s^3
  jerk_derate: number; // pen-down jerk derating factor
  auto_home: boolean; // supports limit-switch homing
  z_motor: number; // index into Z_MOTORS
}

const plotter = (
  model_name: string,
  travel_x: number,
  travel_y: number,
  jerk_pen_up_hi: number,
  jerk_pen_up_lo: number,
  jerk_derate: number,
  auto_home: boolean,
  z_motor: number
): Plotter => ({
  model_name,
  travel_x,
  travel_y,
  jerk_pen_up_hi,
  jerk_pen_up_lo,
  jerk_derate,
  auto_home,
  z_motor,
});

export const PLOTTERS: readonly Plotter[] = [
  plotter("No model selected", 0, 0, 0, 0, 1, false, 1),
  plotter("AxiDraw V3 or SE/A4", 11.81, 8.58, 19000, 13000, 1.0, false, 0),
  plotter("AxiDraw V3/A3 or SE/A3", 16.93, 11.69, 17000, 12000, 0.9, false, 0),
  plotter("AxiDraw V3 XLX", 23.42, 8.58, 18000, 13000, 1.0, false, 0),
  plotter("AxiDraw MiniKit", 6.3, 4.0, 6000, 6000, 0.6, false, 0),
  plotter("AxiDraw SE/A1", 34.02, 23.39, 13000, 8000, 0.6, false, 0),
  plotter("AxiDraw SE/A2", 23.39, 17.01, 16000, 10000, 0.7, false, 0),
  plotter("AxiDraw V3/B6", 7.48, 5.51, 14000, 14000, 1.0, false, 0),
  plotter(
    "Bantam Tools NextDraw™ 8511",
    11.81,
    8.58,
    19000,
    13000,
    1.0,
    true,
    1
  ),
  plotter(
    "Bantam Tools NextDraw™ 1117",
    16.93,
    11.69,
    17000,
    12000,
    0.9,
    true,
    1
  ),
  plotter(
    "Bantam Tools NextDraw™ 2234",
    34.02,
    23.39,
    13000,
    8000,
    0.6,
    true,
    1
  ),
];

/**
 * Apply model-specific values, the handling mode, the pen-lift motor, and
 * any `overrides` to `params`. Model, handling and motor values are only
 * re-applied when they change (tracked by *_old); overrides always apply.
 */
export function applyModelAndHandling(
  state: ConfigState,
  initialize = false
): void {
  const { options, params } = state;
  const o = params.overrides;
  if (initialize) {
    params.model_old = -1;
    params.handling_old = -1;
    params.z_motor_old = -1;
  }

  const model = options.model;
  if (model === 0) return; // model not set

  if (model !== params.model_old) {
    const p = PLOTTERS[model];
    if (!p || model < 0)
      throw new RangeError(`Invalid plotter model: ${model}`);
    params.model_old = model;
    params.model_name = p.model_name;
    params.travel_x = p.travel_x;
    params.travel_y = p.travel_y;
    params.jerk_derate = p.jerk_derate;
    params.auto_home = p.auto_home;
    params.z_motor = p.z_motor;
    if (options.penlift === 3) params.z_motor = 1; // brushless upgrade
  }

  const handling = options.handling;
  if (handling !== 0 && handling !== params.handling_old) {
    const h = HANDLERS[handling];
    if (!h || handling < 0)
      throw new RangeError(`Invalid handling mode: ${handling}`);
    params.handling_old = handling;
    params.resolution = h.resolution;
    params.jerk_pen_down = h.jerk * params.jerk_derate;
    params.const_speed = h.jerk === 0;
    params.curve_tolerance = h.tolerance;
    const lim =
      params.resolution === 2 ? params.speed_lim_xy_lr : params.speed_lim_xy_hr;
    params.speed_limit = Math.min(h.speed, lim);
    params.speed_up = Math.min(h.speed_up, lim);
  }

  const p = PLOTTERS[model];
  params.jerk_pen_up =
    params.resolution === 2 ? p.jerk_pen_up_lo : p.jerk_pen_up_hi;

  if (o.model_name !== null) params.model_name = o.model_name;
  if (o.travel_x !== null) params.travel_x = o.travel_x;
  if (o.travel_y !== null) params.travel_y = o.travel_y;
  if (o.jerk_pen_up !== null) params.jerk_pen_up = o.jerk_pen_up;
  if (o.auto_home !== null) params.auto_home = o.auto_home;
  if (o.resolution !== null) params.resolution = o.resolution;
  if (o.curve_tolerance !== null) params.curve_tolerance = o.curve_tolerance;
  if (o.const_speed !== null) params.const_speed = o.const_speed;
  if (o.jerk_pen_down !== null) params.jerk_pen_down = o.jerk_pen_down;
  if (o.speed_limit !== null) params.speed_limit = o.speed_limit;
  // Note: nextdraw never applies overrides.speed_up; kept that way for parity.
  if (o.z_motor !== null) params.z_motor = o.z_motor;

  const zMotor = params.z_motor;
  if (zMotor !== params.z_motor_old) {
    const z = Z_MOTORS[zMotor];
    if (!z) throw new RangeError(`Invalid pen-lift motor: ${zMotor}`);
    params.z_motor_old = zMotor;
    params.servo_pin = z.pin;
    params.servo_max = z.max;
    params.servo_min = z.min;
    params.servo_sweep_time = z.sweep_time;
    params.servo_move_min = z.move_min;
    params.servo_move_slope = z.move_slope;
  }

  if (o.servo_pin !== null) params.servo_pin = o.servo_pin;
  if (o.servo_max !== null) params.servo_max = o.servo_max;
  if (o.servo_min !== null) params.servo_min = o.servo_min;
  if (o.servo_sweep_time !== null) params.servo_sweep_time = o.servo_sweep_time;
  if (o.servo_move_min !== null) params.servo_move_min = o.servo_move_min;
  if (o.servo_move_slope !== null) params.servo_move_slope = o.servo_move_slope;
}

/** Curve tolerance for a handling mode (layer `+m` codes), honoring overrides. */
export function findCurveTolerance(
  state: ConfigState,
  handlingMode: number
): number | null {
  if (![1, 2, 3, 4].includes(handlingMode)) return null;
  const override = state.params.overrides.curve_tolerance;
  return override !== null ? override : HANDLERS[handlingMode].tolerance;
}
