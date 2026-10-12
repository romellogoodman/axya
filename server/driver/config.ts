/*
 * Driver configuration: default parameters, plot options, and option
 * validation.
 *
 * Ported from nextdrawcore/nextdraw_conf.py, nextdraw_options/common_options.py
 * and NextDraw.update_options (nextdrawcore/nextdraw.py) in nextdraw 1.7.5,
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Names keep nextdraw's snake_case so each value can be traced to the
 * reference and compared against the oracle's recorded options and params.
 */

import { applyModelAndHandling } from "./models.ts";
import { formatFloat } from "./pyfmt.ts";

/** Values that, when non-null, replace model/handling/motor-derived params. */
export interface Overrides {
  model_name: string | null;
  travel_x: number | null;
  travel_y: number | null;
  jerk_pen_up: number | null;
  jerk_pen_down: number | null;
  speed_limit: number | null;
  speed_up: number | null; // accepted but never applied by nextdraw
  auto_home: boolean | null;
  z_motor: number | null;
  servo_pin: number | null;
  servo_max: number | null;
  servo_min: number | null;
  servo_sweep_time: number | null;
  servo_move_min: number | null;
  servo_move_slope: number | null;
  resolution: number | null;
  curve_tolerance: number | null;
  const_speed: boolean | null;
}

/** Per-plot options (the CLI/Inkscape-settable layer). */
export interface Options {
  mode: string; // plot, layers, res_plot, align, toggle, cycle, find_home, utility, sysinfo, version
  utility_cmd: string;
  dist: string; // walk / offset distance; may carry a unit suffix
  offset_start: boolean;
  layer: number;
  layer_option: number;
  copies: number; // 0: continuous
  speed_pendown: number;
  speed_penup: number;
  accel: number;
  pen_pos_down: number;
  pen_pos_up: number;
  pen_rate_lower: number;
  pen_rate_raise: number;
  report_time: boolean;
  homing: boolean;
  page_delay: number; // seconds
  preview: boolean;
  rendering: boolean;
  model: number;
  penlift: number;
  port_config: number;
  port: string | null;
  setup_type: string;
  auto_rotate: boolean;
  random_start: boolean;
  hiding: boolean;
  reordering: number; // 0, 1, 2, 4
  digest: number;
  webhook: boolean;
  webhook_url: string | null;
  submode: string;
  handling: number; // 1-4
}

/** Machine and behavior parameters (nextdraw_conf.py plus derived values). */
export interface Params {
  // nextdraw_conf.py defaults that seed Options
  mode: string;
  handling: number;
  speed_pendown: number;
  speed_penup: number;
  accel: number;
  pen_pos_up: number;
  pen_pos_down: number;
  pen_rate_raise: number;
  pen_rate_lower: number;
  report_time: boolean;
  default_layer: number;
  utility_cmd: string;
  dist: number;
  offset_start: boolean;
  copies: number;
  page_delay: number;
  preview: boolean;
  rendering: boolean;
  model: number;
  penlift: number;
  port: string | null;
  port_config: number;
  homing: boolean;
  auto_rotate: boolean;
  reordering: number;
  random_start: boolean;
  hiding: boolean;
  webhook: boolean;
  webhook_url: string | null;
  digest: number;
  progress: boolean;
  // config-file-only settings
  pause_warning: boolean;
  servo_timeout: number; // ms
  check_updates: boolean;
  use_b3_out: boolean;
  sync_b3: boolean;
  auto_rotate_ccw: boolean;
  options_message: boolean;
  report_lifts: boolean;
  auto_clip_lift: boolean;
  preview_paths: number;
  preview_color_up: string;
  preview_color_down: string;
  skip_voltage_check: boolean;
  clip_to_page: boolean;
  min_gap: number; // inches; negative disables path joining
  pen_delay_up: number; // ms
  pen_delay_down: number; // ms
  overrides: Overrides;
  native_res_factor: number; // steps per inch along native axes
  max_step_rate: number; // steps per ms
  speed_lim_xy_lr: number; // in/s, low resolution
  speed_lim_xy_hr: number; // in/s, high resolution
  button_interval: number; // s
  bounds_tolerance: number; // inches
  // derived by applyModelAndHandling
  model_old: number;
  handling_old: number;
  z_motor_old: number;
  model_name: string;
  travel_x: number;
  travel_y: number;
  jerk_derate: number;
  auto_home: boolean;
  z_motor: number;
  resolution: number;
  jerk_pen_down: number;
  const_speed: boolean;
  curve_tolerance: number;
  speed_limit: number;
  speed_up: number;
  jerk_pen_up: number;
  servo_pin: number;
  servo_max: number;
  servo_min: number;
  servo_sweep_time: number;
  servo_move_min: number;
  servo_move_slope: number;
}

export type Bounds = [[number, number], [number, number]];

/** The configuration slice of nextdraw's NextDraw object. */
export interface ConfigState {
  options: Options;
  params: Params;
  bounds: Bounds;
}

export function defaultOverrides(): Overrides {
  return {
    model_name: null,
    travel_x: null,
    travel_y: null,
    jerk_pen_up: null,
    jerk_pen_down: null,
    speed_limit: null,
    speed_up: null,
    auto_home: null,
    z_motor: null,
    servo_pin: null,
    servo_max: null,
    servo_min: null,
    servo_sweep_time: null,
    servo_move_min: null,
    servo_move_slope: null,
    resolution: null,
    curve_tolerance: null,
    const_speed: null,
  };
}

/** nextdraw_conf.py defaults; derived values are filled in by applyModelAndHandling. */
export function defaultParams(): Params {
  return {
    mode: "plot",
    handling: 1,
    speed_pendown: 25,
    speed_penup: 75,
    accel: 75,
    pen_pos_up: 60,
    pen_pos_down: 40,
    pen_rate_raise: 75,
    pen_rate_lower: 50,
    report_time: false,
    default_layer: 1,
    utility_cmd: "read_name",
    dist: 1.0,
    offset_start: false,
    copies: 1,
    page_delay: 15,
    preview: false,
    rendering: true,
    model: 8,
    penlift: 1,
    port: null,
    port_config: 0,
    homing: true,
    auto_rotate: true,
    reordering: 0,
    random_start: false,
    hiding: false,
    webhook: false,
    webhook_url: null,
    digest: 0,
    progress: false,
    pause_warning: true,
    servo_timeout: 60000,
    check_updates: true,
    use_b3_out: false,
    sync_b3: true,
    auto_rotate_ccw: true,
    options_message: true,
    report_lifts: false,
    auto_clip_lift: true,
    preview_paths: 3,
    preview_color_up: "LightPink",
    preview_color_down: "Blue",
    skip_voltage_check: false,
    clip_to_page: true,
    min_gap: 0.006,
    pen_delay_up: 0,
    pen_delay_down: 0,
    overrides: defaultOverrides(),
    native_res_factor: 1016.0,
    max_step_rate: 24.995,
    speed_lim_xy_lr: 17.3958,
    speed_lim_xy_hr: 8.6979,
    button_interval: 0.05,
    bounds_tolerance: 0.003,
    model_old: -1,
    handling_old: -1,
    z_motor_old: -1,
    model_name: "",
    travel_x: 0,
    travel_y: 0,
    jerk_derate: 1,
    auto_home: false,
    z_motor: 0,
    resolution: 1,
    jerk_pen_down: 0,
    const_speed: false,
    curve_tolerance: 0,
    speed_limit: 0,
    speed_up: 0,
    jerk_pen_up: 0,
    servo_pin: 0,
    servo_max: 0,
    servo_min: 0,
    servo_sweep_time: 0,
    servo_move_min: 0,
    servo_move_slope: 0,
  };
}

/** Option defaults seeded from params, as common_options.py does. */
export function defaultOptions(params: Params): Options {
  return {
    mode: params.mode,
    utility_cmd: params.utility_cmd,
    dist: formatFloat(params.dist), // Python str(float)
    offset_start: params.offset_start,
    layer: params.default_layer,
    layer_option: 1,
    copies: params.copies,
    speed_pendown: params.speed_pendown,
    speed_penup: params.speed_penup,
    accel: params.accel,
    pen_pos_down: params.pen_pos_down,
    pen_pos_up: params.pen_pos_up,
    pen_rate_lower: params.pen_rate_lower,
    pen_rate_raise: params.pen_rate_raise,
    report_time: params.report_time,
    homing: params.homing,
    page_delay: params.page_delay,
    preview: params.preview,
    rendering: params.rendering,
    model: params.model,
    penlift: params.penlift,
    port_config: params.port_config,
    port: params.port,
    setup_type: "align",
    auto_rotate: params.auto_rotate,
    random_start: params.random_start,
    hiding: params.hiding,
    reordering: params.reordering,
    digest: params.digest,
    webhook: params.webhook,
    webhook_url: params.webhook_url,
    submode: "none",
    handling: params.handling,
  };
}

/**
 * A fresh configuration, as NextDraw.__init__ builds it: defaults, then any
 * param changes (config file), then options derived from params, then the
 * initial model/handling application.
 */
export function createConfig(paramChanges: Partial<Params> = {}): ConfigState {
  const params = defaultParams();
  const { overrides, ...rest } = paramChanges;
  Object.assign(params, rest);
  if (overrides) Object.assign(params.overrides, overrides);
  const state: ConfigState = {
    options: defaultOptions(params),
    params,
    bounds: [
      [0, 0],
      [0, 0],
    ],
  };
  applyModelAndHandling(state, true);
  return state;
}

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

/** NextDraw.update_options: apply the model and clamp user inputs. */
export function updateOptions(state: ConfigState): void {
  const { options, params } = state;
  if (options.model) {
    applyModelAndHandling(state);
    state.bounds = [
      [-1e-9, -1e-9],
      [params.travel_x + 1e-9, params.travel_y + 1e-9],
    ];
  }
  options.pen_pos_up = clamp(options.pen_pos_up, 0, 100);
  options.pen_pos_down = clamp(options.pen_pos_down, 0, 100);
  options.pen_rate_raise = clamp(options.pen_rate_raise, 1, 100);
  options.pen_rate_lower = clamp(options.pen_rate_lower, 1, 100);
  options.speed_pendown = clamp(options.speed_pendown, 1, 100);
  options.speed_penup = clamp(options.speed_penup, 1, 100);
  options.accel = clamp(options.accel, 1, 100);
}
