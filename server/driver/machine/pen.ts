/*
 * Pen-lift handling: servo setup, raise/lower with timing, pen state cached
 * in EBB RAM, temporary (per-layer) heights, and the XYZ pen position.
 *
 * Ported from nextdrawcore/pen_handling.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/pen_handling.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { roundHalfEven } from "../motion/ebbCalc.ts";
import type { MachineContext } from "./context.ts";
import { exhaustQueue, readStatusByte } from "./status.ts";

/** XYZ pen position (pen_handling.py:45-67). */
export class PenPosition {
  xpos = 0;
  ypos = 0;
  z_up: boolean | null = null; // null: unknown
  accum1 = 0;
  accum2 = 0;
  homed = false;

  reset(): void {
    Object.assign(this, new PenPosition());
  }

  resetZ(): void {
    this.z_up = null;
  }
}

/**
 * Raise and lower durations in ms (pen_handling.py:118-160): a fourth-power
 * blend of the servo's fast-move time and its slow sweep time, plus the
 * configured extra delay, never negative.
 */
export class PenLiftTiming {
  raise_time: number | null = null;
  lower_time: number | null = null;

  update(nd: MachineContext, penDownPos: number): void {
    const vDist = Math.abs(nd.options.pen_pos_up - penDownPos);
    const slope = nd.params.servo_move_slope;
    const min = nd.params.servo_move_min;
    const sweep = nd.params.servo_sweep_time;

    const blend = (rate: number) =>
      Math.trunc(
        ((slope * vDist + min) ** 4 + ((sweep * vDist) / rate) ** 4) ** 0.25
      );

    let vTime = blend(nd.options.pen_rate_raise);
    if (vDist < 0.9) vTime = 0; // equal heights: no move time
    vTime += nd.params.pen_delay_up;
    this.raise_time = Math.max(0, vTime);

    vTime = blend(nd.options.pen_rate_lower);
    if (vDist < 0.9) vTime = 0;
    vTime += nd.params.pen_delay_down;
    this.lower_time = Math.max(0, vTime);
  }
}

/** Pen-down height in use, possibly a layer's temporary one (pen_handling.py:70-115). */
export class PenHeight {
  pen_pos_down: number | null = null;
  use_temp_pen_height = false;
  times = new PenLiftTiming();

  update(nd: MachineContext): void {
    if (!this.use_temp_pen_height) this.pen_pos_down = nd.options.pen_pos_down;
    this.times.update(nd, this.pen_pos_down as number);
    nd.pen.status.init_goal[0] = nd.options.pen_pos_up;
    nd.pen.status.init_goal[1] = this.pen_pos_down;
  }

  /** Begin a temporary height; true if it changed. */
  setTempHeight(nd: MachineContext, tempHeight: number): boolean {
    this.use_temp_pen_height = true;
    if (this.pen_pos_down === tempHeight) return false;
    this.pen_pos_down = tempHeight;
    this.times.update(nd, tempHeight);
    return true;
  }

  /** Return to the configured height; true if it changed. */
  endTempHeight(nd: MachineContext): boolean {
    this.use_temp_pen_height = false;
    if (this.pen_pos_down === nd.options.pen_pos_down) return false;
    this.pen_pos_down = nd.options.pen_pos_down;
    this.times.update(nd, this.pen_pos_down);
    return true;
  }
}

/** [pen_pos_up, pen_pos_down, z_motor, pen_up] */
export type ServoState = [number | null, number | null, number, boolean | null];

/** Pen lift status (pen_handling.py:163-189). */
export class PenStatus {
  preview_pen_state = -1; // 0 down, 1 up, -1 changed
  lifts = 0;
  init_state: ServoState = [-1, -1, -1, null];
  init_goal: ServoState = [-1, -1, -1, null];

  reset(): void {
    this.preview_pen_state = -1;
    this.lifts = 0;
  }

  report(nd: MachineContext, messageFun: (text: string) => void): void {
    if (!(nd.options.report_time && nd.params.report_lifts)) return;
    messageFun(`Number of pen lifts: ${this.lifts}\n`);
  }
}

const sameState = (a: ServoState, b: ServoState, i: number) => a[i] === b[i];

/** Pen lifting, lowering and status (pen_handling.py:192-493). */
export class PenHandler {
  heights = new PenHeight();
  status = new PenStatus();
  phys = new PenPosition();
  turtle = new PenPosition();

  reset(): void {
    this.status.reset();
    this.heights.use_temp_pen_height = false;
  }

  /** Host-side wait after SP so the queue stays shallow (pen_handling.py:231-233). */
  private async settle(nd: MachineContext, vTime: number): Promise<void> {
    if (
      vTime > 50 &&
      !["utility", "align", "cycle"].includes(nd.options.mode)
    ) {
      await nd.clock.sleep(vTime - 30);
    }
  }

  async penRaise(nd: MachineContext): Promise<void> {
    this.status.preview_pen_state = -1;
    if (this.phys.z_up) return; // already up

    this.status.lifts += 1;
    const vTime = this.heights.times.raise_time as number;
    const servoPin = nd.params.servo_pin;

    if (nd.options.preview) {
      nd.preview.v_chart.rest(nd, vTime);
    } else {
      await nd.machine.penRaise(vTime, servoPin);
      await this.settle(nd, vTime);
      if (nd.params.use_b3_out) {
        if (nd.params.sync_b3) await exhaustQueue(nd);
        await nd.machine.dioBSet(3, 0);
      }
    }
    this.phys.z_up = true;
  }

  async penLower(nd: MachineContext): Promise<void> {
    this.status.preview_pen_state = -1;
    if (this.phys.z_up !== null && !this.phys.z_up) return; // known down
    if (nd.plot_status.stopped) return;

    const vTime = this.heights.times.lower_time as number;
    const servoPin = nd.params.servo_pin;

    if (nd.options.preview) {
      nd.preview.v_chart.rest(nd, vTime);
    } else {
      await nd.machine.penLower(vTime, servoPin);
      await this.settle(nd, vTime);
      if (nd.params.use_b3_out) {
        if (nd.params.sync_b3) await exhaustQueue(nd);
        await nd.machine.dioBSet(3, 1);
      }
    }
    this.phys.z_up = false;
  }

  /** Lower, hold 500 ms, raise. Setup utility only. */
  async cycle(nd: MachineContext): Promise<void> {
    await this.penLower(nd);
    await nd.machine.timedPause(500);
    await this.penRaise(nd);
  }

  async setTempHeight(nd: MachineContext, tempHeight: number): Promise<void> {
    if (this.heights.setTempHeight(nd, tempHeight)) await this.servoInit(nd);
  }

  async endTempHeight(nd: MachineContext): Promise<void> {
    if (this.heights.endTempHeight(nd)) await this.servoInit(nd);
  }

  /**
   * Decode the servo setup cached in RAM slots 10/11 (1-101 standard,
   * 102-202 brushless, 0 never set) and the QG pen bit (pen_handling.py:290-341).
   */
  async findPenState(nd: MachineContext): Promise<void> {
    const codeUp = await nd.machine.varRead(10);
    const codeDown = await nd.machine.varRead(11);
    const state = this.status.init_state;

    if (codeUp === null || codeDown === null) {
      state[0] = -1;
      state[1] = -1;
      return;
    }

    if (nd.params.z_motor) {
      if (codeUp > 101 && codeDown > 101) state[2] = 1;
    } else if (codeUp < 102 && codeDown < 102) {
      state[2] = 0;
    }

    state[0] = codeUp === 0 ? -1 : codeUp > 101 ? codeUp - 102 : codeUp - 1;
    state[1] =
      codeDown === 0 ? -1 : codeDown > 101 ? codeDown - 102 : codeDown - 1;

    const qg = await readStatusByte(nd);
    // Python's `None & 16` raises TypeError, caught as "assume pen up".
    state[3] = qg === null ? true : Boolean(qg & 16);
  }

  /**
   * Configure the servo and put the pen in a known state (pen_handling.py:343-471).
   * Always sends SC,11/12 (rates) and SC,4/5 (positions); skips SP, SC,8, SR
   * and the RAM writes when the cached setup matches and the pen is already
   * where this mode wants it.
   */
  async servoInit(nd: MachineContext): Promise<void> {
    this.heights.update(nd);
    if (nd.options.preview) this.phys.z_up = true;
    if (nd.options.preview || nd.machine.port === null) return;

    const penDown = this.heights.pen_pos_down as number;
    let codeUp = 1 + nd.options.pen_pos_up;
    let codeDown = 1 + penDown;

    const goal = this.status.init_goal;
    goal[0] = nd.options.pen_pos_up;
    goal[1] = penDown;

    let pwmPeriod: number;
    if (nd.params.z_motor) {
      pwmPeriod = 0.03; // "ms / 100", since rates are in %
      goal[2] = 1;
      codeUp += 101;
      codeDown += 101;
    } else {
      pwmPeriod = 0.24; // 8 channels × 3 ms, / 100
      goal[2] = 0;
    }

    await this.findPenState(nd);
    const state = this.status.init_state;

    const servoInitialized =
      sameState(state, goal, 0) &&
      sameState(state, goal, 1) &&
      sameState(state, goal, 2);

    if (servoInitialized) {
      this.phys.z_up = state[3];
      goal[3] = state[3];
    }

    const { mode, utility_cmd } = nd.options;
    if (
      (mode === "utility" && utility_cmd === "lower_pen") ||
      (mode === "toggle" && Boolean(this.phys.z_up)) ||
      mode === "cycle"
    ) {
      goal[3] = false;
    } else if (
      !servoInitialized ||
      mode === "toggle" ||
      (mode === "utility" && utility_cmd === "raise_pen")
    ) {
      goal[3] = true;
    }

    const servoMin = nd.params.servo_min;
    const servoPin = nd.params.servo_pin;
    const servoRange = nd.params.servo_max - servoMin;
    const servoSlope = servoRange / 100.0;
    const servoRateScale =
      (servoRange * pwmPeriod) / nd.params.servo_sweep_time;

    await nd.machine.penRateUp(
      roundHalfEven(servoRateScale * nd.options.pen_rate_raise)
    );
    await nd.machine.penRateDown(
      roundHalfEven(servoRateScale * nd.options.pen_rate_lower)
    );

    if (nd.params.use_b3_out) await nd.machine.dioBConfig(3, 0, 0);

    await nd.machine.penPosUp(
      roundHalfEven(servoMin + servoSlope * nd.options.pen_pos_up)
    );
    await nd.machine.penPosDown(roundHalfEven(servoMin + servoSlope * penDown));

    if (servoInitialized && this.phys.z_up !== null) {
      if (this.phys.z_up === goal[3]) return;
    }

    if (!goal[3]) {
      await nd.machine.penLower(
        this.heights.times.lower_time as number,
        servoPin
      );
      if (nd.params.use_b3_out) await nd.machine.dioBSet(3, 1);
      this.phys.z_up = false;
    }
    if (goal[3]) {
      await nd.machine.penRaise(
        this.heights.times.raise_time as number,
        servoPin
      );
      if (nd.params.use_b3_out) await nd.machine.dioBSet(3, 0);
      this.phys.z_up = true;
    }

    if (nd.params.z_motor) {
      await nd.machine.command("SC,8,1"); // 1 PWM channel
    } else {
      await nd.machine.command("SC,8,8"); // 8 PWM channels
      await nd.machine.servoTimeout(nd.params.servo_timeout, null); // standard servo only
    }

    this.status.init_state = [...goal];
    await nd.machine.varWrite(codeUp, 10);
    await nd.machine.varWrite(codeDown, 11);
  }

  /**
   * Restore the pen-down position after a pause's SP,3 made it equal to
   * pen-up (pen_handling.py:474-493).
   */
  async servoRevert(nd: MachineContext): Promise<void> {
    if (this.phys.z_up === null) return;
    this.heights.update(nd);
    const servoMin = nd.params.servo_min;
    const servoSlope = (nd.params.servo_max - servoMin) / 100.0;
    await exhaustQueue(nd);
    await nd.machine.penPosDown(
      roundHalfEven(
        servoMin + servoSlope * (this.heights.pen_pos_down as number)
      )
    );
  }
}
