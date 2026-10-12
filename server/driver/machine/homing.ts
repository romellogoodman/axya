/*
 * Homing and origin handling: NextDraw limit-switch homing, position
 * read-back, origin offsets, and precision moves.
 *
 * Ported from nextdrawcore/homing.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/homing.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools. MIT License:
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
 */

import { roundHalfEven } from "../motion/ebbCalc.ts";
import type { MachineContext } from "./context.ts";
import {
  absMoveWrapper,
  exhaustQueue,
  readStatusByte,
  readStepOffsets,
  readStepPosition,
  writeStepOffsets,
} from "./status.ts";

/** Absolute (A, B) motor steps for an (X, Y) position in inches (homing.py:35-49). */
export function xyToStepPos(
  nd: Pick<MachineContext, "params">,
  xIn: number,
  yIn: number
): [number, number] {
  if (nd.params.resolution === 2) {
    xIn /= 2;
    yIn /= 2;
  }
  const k = 2 * nd.params.native_res_factor;
  return [roundHalfEven(k * (xIn + yIn)), roundHalfEven(k * (xIn - yIn))];
}

/** (X, Y) inches for an (A, B) motor step position (homing.py:52-66). */
export function stepsToXyPos(
  nd: Pick<MachineContext, "params">,
  aSteps: number,
  bSteps: number
): [number, number] {
  let x = (aSteps + bSteps) / (4 * nd.params.native_res_factor);
  let y = (aSteps - bSteps) / (4 * nd.params.native_res_factor);
  if (nd.params.resolution === 2) {
    x *= 2;
    y *= 2;
  }
  return [x, y];
}

const distance = (x: number, y: number) => Math.sqrt(x * x + y * y);

export class HomingClass {
  static readonly SPEED_FAST = 2; // in/s, coarse
  static readonly SPEED_FINE = 0.25; // in/s
  static readonly SPEED_SLOW = 0.1; // in/s
  static readonly SIDE_DIST = 6; // mm step-off before moving back

  failed = false;
  paused = false;
  step_scale: number | null = null;
  nd: MachineContext;
  message_fun: (text: string) => void;
  speed_fine = HomingClass.SPEED_FINE;
  res = 0; // 1 high, 2 low resolution

  constructor(nd: MachineContext, messageFun: (text: string) => void) {
    this.nd = nd;
    this.message_fun = messageFun;
  }

  /**
   * Home if needed (homing.py:86-139). Already homed (QL,12): read position.
   * Otherwise run limit-switch homing when enabled and supported, and in all
   * cases declare the current position home.
   */
  async findHome(): Promise<boolean> {
    const nd = this.nd;
    if (nd.options.preview) return true;

    const doAutoHoming = nd.options.homing && nd.params.auto_home;

    if (nd.machine.port === null || nd.machine.err !== null) {
      await this.markFailed();
      return false;
    }

    if (await nd.machine.varRead(12)) {
      await this.readPosition();
      return true;
    }

    if (doAutoHoming) {
      if (nd.warnings.has("voltage")) {
        nd.warnings.addNew("homing_voltage");
        await this.markFailed();
        return false;
      }
      if (nd.params.skip_voltage_check) {
        if (!(await nd.machine.queryVoltage(200))) {
          nd.warnings.addNew("homing_voltage");
          await this.markFailed();
          return false;
        }
      }

      this.step_scale = nd.step_scale;
      this.res = nd.params.resolution === 1 ? 1 : 2;

      await this.rhmHoming();
      if (this.failed) {
        await this.markFailed();
        return false;
      }
      await nd.machine.clearSteps();
      await this.lhmHoming();
    }

    if (this.failed) {
      await this.markFailed();
      return false;
    }
    await this.setHome();
    return true;
  }

  async markFailed(): Promise<void> {
    const nd = this.nd;
    this.failed = true;
    if (nd.plot_status.stopped === 0) {
      nd.plot_status.stopped = nd.warnings.has("voltage") ? 105 : 106;
    }
    if (nd.machine.port === null || nd.machine.err !== null) return;
    await nd.machine.varWrite(0, 12); // not homed
  }

  /**
   * Wait until motion stops, the timeout passes, or the button is pressed
   * (then E-stop with ES). Polls QG every 2 ms (homing.py:156-202).
   */
  async block(timeoutMs: number | null = null): Promise<void> {
    if (this.failed) return;
    const nd = this.nd;
    // nextdraw quirk: with no timeout, time_left is never decremented, so the
    // documented 1 s default never expires (homing.py:175-202).
    let timeLeft = timeoutMs === null ? 1000 : timeoutMs;

    for (;;) {
      const qg = await readStatusByte(nd);

      if (nd.plot_status.button) {
        this.message_fun("Homing interrupted by button press.");
        this.paused = true;
        this.failed = true;
        await nd.machine.query("ES");
        return;
      }

      // nextdraw quirk: a failed QG read makes Python evaluate `None & 15`
      // and raise TypeError out of homing (homing.py:190).
      if (qg === null)
        throw new TypeError(
          "unsupported operand type(s) for &: 'NoneType' and 'int'"
        );
      if ((qg & 15) === 0) return;
      if (timeLeft <= 0) {
        this.failed = true;
        this.message_fun("Timeout at block function in homing routine.");
        return;
      }
      if (timeLeft < 10) {
        await nd.clock.sleep(timeLeft);
        timeLeft = 0;
      } else {
        await nd.clock.sleep(2);
        if (timeoutMs !== null) timeLeft -= 2;
      }
    }
  }

  /** After motion stops, read PI,B,1: 1 pressed or absent, 0 not pressed, 2 error. */
  async queryLimitSwitch(): Promise<number> {
    const nd = this.nd;
    if (nd.machine.port === null || nd.machine.err !== null) return 2;
    await this.block();
    const response = await nd.machine.dioBRead(1);
    if (response === null) {
      this.message_fun("Error reading serial data in Homing process.");
      this.failed = true;
      return 2;
    }
    return response ? 1 : 0;
  }

  async moveXyInch(
    xInches: number,
    yInches: number,
    timeMs: number
  ): Promise<void> {
    if (this.failed || this.paused) return;
    const scale = this.step_scale as number;
    const steps1 = roundHalfEven(scale * (xInches + yInches));
    const steps2 = roundHalfEven(scale * (xInches - yInches));
    await this.nd.machine.xyMove(steps2, steps1, timeMs);
  }

  /**
   * Move left with the right-hand motor only until the limit switch trips.
   * Returns the apparent distance in inches, or -1 (homing.py:243-295).
   */
  async leftUntilBump(speed: number, maxDist: number): Promise<number> {
    const nd = this.nd;
    if (this.failed || this.paused) {
      this.failed = true;
      return -1;
    }
    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Error: Limit switch not ready.)"
      );
      return -1;
    }
    if (nd.warnings.has("voltage")) {
      nd.warnings.addNew("homing_voltage");
      return -1;
    }

    await this.block();
    await nd.machine.motorsEnable(this.res, 0); // M2 off; EM clears steps
    await this.block();
    await this.enableLimitDetection();

    const timeMs = Math.abs(Math.trunc((1000 * maxDist) / speed));
    // Moves diagonally (half distance) until Y = 0, then left.
    await this.moveXyInch(-maxDist, 0, timeMs);

    await this.block();
    const limitOccurred = nd.plot_status.limit;
    await nd.machine.command("CU,51,0");

    if (!limitOccurred && !this.paused) {
      this.failed = true;
      this.message_fun(
        'Automatic homing failed with a "limit not found" error.\n\n' +
          "This could indicate that you have the wrong plotter selected.\n" +
          "You are presently configured for the " +
          `${nd.params.model_name}.`
      );
      return -1;
    }
    const steps = await nd.machine.querySteps();
    // nextdraw quirk: Python indexes the QS result without a None check.
    if (steps === null)
      throw new TypeError("'NoneType' object is not subscriptable");
    return Math.abs(steps[1] / (this.step_scale as number));
  }

  /** Step 6 mm right, check, 3.5 mm left, check (homing.py:297-323; unused by nextdraw). */
  async backOffPlusX(speed: number): Promise<void> {
    if (this.failed || this.paused) return;
    await this.nd.machine.motorsEnable(this.res, this.res);
    let step = 6 / 25.4;
    await this.moveXyInch(step, 0, Math.trunc(1000 * Math.abs(step / speed)));
    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed.\n" +
          "(Error: Limit switch not detected. " +
          "Is your model selected correctly?)"
      );
      return;
    }
    step = 3.5 / 25.4;
    await this.moveXyInch(-step, 0, Math.trunc(1000 * Math.abs(step / speed)));
    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Error: Limit switch position error.)"
      );
    }
  }

  /** Back off right 6 mm, left 3.5 mm, then a fine move left until the switch (homing.py:325-363). */
  async rhmHomingFine(): Promise<number> {
    if (this.failed || this.paused) return -1;
    const leftCoarseDist = 7; // mm

    await this.nd.machine.motorsEnable(this.res, this.res);
    let step = 6 / 25.4;
    await this.moveXyInch(
      step,
      0,
      Math.trunc(1000 * Math.abs(step / HomingClass.SPEED_FAST))
    );
    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Error: Limit switch not detected.)"
      );
      return -1;
    }
    step = leftCoarseDist / 2 / 25.4;
    await this.moveXyInch(
      -step,
      0,
      Math.trunc(1000 * Math.abs(step / HomingClass.SPEED_FAST))
    );
    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Error: Limit switch position error.)"
      );
    }
    if (this.failed) return -1;
    return await this.leftUntilBump(this.speed_fine, leftCoarseDist / 25.4);
  }

  /** Right-hand-motor homing, stages 1-3 (homing.py:365-514). */
  async rhmHoming(): Promise<void> {
    const nd = this.nd;
    const [, yMax] = nd.bounds[1];
    const xMax = nd.bounds[1][0];

    await nd.machine.dioBConfig(1, 1, 1); // B1 input, pulled high
    await nd.machine.command("CU,50,0");

    let firstCoarseDist: number;
    if ((await this.queryLimitSwitch()) === 1) {
      firstCoarseDist = 0.05; // already against the switch
    } else {
      // Twice the diagonal (one motor moves at half rate) plus extra X travel.
      let maxDist = 2 * yMax + (xMax - yMax);
      maxDist += 0.5;
      const apparent = await this.leftUntilBump(
        HomingClass.SPEED_FAST,
        maxDist
      );
      if (this.failed) return;
      firstCoarseDist = apparent / 2;
    }

    let dist = await this.rhmHomingFine(); // ~0.0984 in (2.5 mm) when Y = 0
    if (this.failed) return;

    const firstDistClose = dist < 0.15;
    dist = await this.rhmHomingFine();
    if (dist < 0) {
      this.failed = true;
      return;
    }
    if (dist <= 0.0984) return;
    if (firstDistClose && dist < 0.12) return;
    if (dist < 0.15) {
      const dist2 = await this.rhmHomingFine();
      if (dist2 > 0.12) {
        this.failed = true;
        this.message_fun("Homing failed");
      }
      return;
    }

    // Stage 3: big move right, then coarse and fine moves left again.
    let remaining = yMax - firstCoarseDist;
    remaining -= 2.5 / 25.4;
    remaining = Math.max(remaining, 0);

    const rightMoveDist = remaining;
    await nd.machine.motorsEnable(this.res, this.res);
    await this.moveXyInch(
      remaining,
      0,
      Math.trunc((1000 * remaining) / HomingClass.SPEED_FAST)
    );
    const maxDist = 2 * (rightMoveDist + 0.1);
    const coarseDist = await this.leftUntilBump(
      HomingClass.SPEED_FAST,
      maxDist
    );
    if (coarseDist < 0) {
      this.message_fun(
        "Error: Homing failed at second coarse move; no limit found."
      );
      this.failed = true;
      return;
    }

    dist = await this.rhmHomingFine();
    if (dist < 0) {
      this.message_fun("Error; limit not found");
      return;
    }
    if (dist <= 0.0984) return;
    if (dist < 0.15) {
      const dist2 = await this.rhmHomingFine();
      if (dist2 > 0.12) {
        this.message_fun("Error: Homing failed (not found; secondary)");
        this.failed = true;
      }
    }
  }

  /** Left-hand-motor precision stage (homing.py:516-569). */
  async lhmHoming(): Promise<void> {
    const nd = this.nd;
    const scale = this.step_scale as number;
    await nd.machine.motorsEnable(this.res, this.res);

    let step = HomingClass.SIDE_DIST / 25.4;
    const motorSteps1 = roundHalfEven(scale * (step + step));
    let timeMs = Math.trunc(1000 * Math.abs(step / HomingClass.SPEED_FAST));
    await nd.machine.xyMove(0, motorSteps1, timeMs);

    // First half of the leftward move at fast speed.
    step = HomingClass.SIDE_DIST / 2 / 25.4;
    const timeMs1 = Math.trunc(1000 * Math.abs(step / HomingClass.SPEED_FAST));
    let motorSteps2 = roundHalfEven(scale * (-2 * step));
    await nd.machine.xyMove(motorSteps2, 0, timeMs1);

    // Second half at fine speed, until the limit switch.
    step = HomingClass.SIDE_DIST / 25.4;
    timeMs = Math.trunc(1000 * Math.abs(step / this.speed_fine));
    motorSteps2 = roundHalfEven(scale * (-2 * step));

    if ((await this.queryLimitSwitch()) === 1) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Limit switch not ready; Precision stage)"
      );
      return;
    }
    await this.enableLimitDetection();
    await nd.machine.xyMove(motorSteps2, 0, timeMs);

    await this.block();
    const limitOccurred = nd.plot_status.limit;
    await nd.machine.command("CU,51,0");
    if (!limitOccurred) {
      this.failed = true;
      this.message_fun(
        "Automatic homing failed. (Limit not found; precision stage)"
      );
      return;
    }
    await nd.machine.xyMove(motorSteps1, -motorSteps1, 4 * timeMs1);
    await this.block();
  }

  /** Arm the firmware's limit stop on PB1 high (homing.py:571-575). */
  async enableLimitDetection(): Promise<void> {
    await this.nd.machine.command("CU,52,2"); // target: bit 1 high
    await this.nd.machine.command("CU,51,2"); // mask: PB1
    this.nd.plot_status.limit = false;
  }

  /** Set pen.phys x/y from QS minus the origin offset; clear accumulators (homing.py:577-601). */
  async readPosition(): Promise<void> {
    const nd = this.nd;
    if (nd.options.preview) {
      nd.pen.phys.accum1 = 0;
      nd.pen.phys.accum2 = 0;
    }
    if (nd.machine.port === null || nd.machine.err !== null) return;

    await exhaustQueue(nd);
    const pos = await nd.machine.querySteps();
    const offset = await readStepOffsets(nd);
    if (pos === null || offset === null) {
      this.message_fun("Error reading step positions.");
      return;
    }
    const offsetXy = stepsToXyPos(nd, offset[0] / 1000, offset[1] / 1000);
    const posXy = stepsToXyPos(nd, pos[0], pos[1]);
    nd.pen.phys.xpos = posXy[0] - offsetXy[0];
    nd.pen.phys.ypos = posXy[1] - offsetXy[1];
    nd.pen.phys.accum1 = 0;
    nd.pen.phys.accum2 = 0;
    await nd.machine.clearAccumulators();
  }

  /** Make the current position the true home and clear the origin offset (homing.py:603-613). */
  async setHome(): Promise<void> {
    await exhaustQueue(this.nd);
    await this.nd.machine.clearSteps();
    await writeStepOffsets(this.nd, 0, 0);
    await this.nd.machine.varWrite(1, 12); // homed
    await this.readPosition();
  }

  /**
   * Shift the origin offset by (delta_x, delta_y) inches; the logical
   * position drops by that amount (homing.py:615-639).
   */
  async adjustOriginOffset(deltaX: number, deltaY: number): Promise<void> {
    const offset = await readStepOffsets(this.nd);
    if (offset === null) {
      this.message_fun("Error reading step positions.");
      return;
    }
    const offsetXy = stepsToXyPos(this.nd, offset[0] / 1000, offset[1] / 1000);
    const offsetX = offsetXy[0] + deltaX;
    const offsetY = offsetXy[1] + deltaY;
    const ab = xyToStepPos(this.nd, offsetX * 1000, offsetY * 1000);
    await writeStepOffsets(this.nd, ab[0], ab[1]);
    await this.readPosition();
  }

  async xyToStepPosWithOffset(
    xDest: number,
    yDest: number
  ): Promise<[number, number] | null> {
    const offset = await readStepOffsets(this.nd);
    if (offset === null) return null;
    const offsetXy = stepsToXyPos(this.nd, offset[0] / 1000, offset[1] / 1000);
    return xyToStepPos(this.nd, xDest + offsetXy[0], yDest + offsetXy[1]);
  }

  /**
   * Absolute HM move to (x, y) inches relative to the origin offset, skipped
   * when already there; then read the position back (homing.py:659-701).
   */
  async precisionMoveTo(
    xDest: number,
    yDest: number,
    rate = 3000
  ): Promise<void> {
    const nd = this.nd;
    const dest = await this.xyToStepPosWithOffset(xDest, yDest);
    if (dest === null) return;
    const stats = nd.plot_status.stats;
    const drip = nd.plot_status.resume.drip;

    if (nd.options.preview) {
      const moveDist = distance(
        xDest - nd.pen.phys.xpos,
        yDest - nd.pen.phys.ypos
      );
      stats.addDist(Boolean(nd.pen.phys.z_up), drip, moveDist);
      const read = (await this.xyToStepPosWithOffset(
        nd.pen.phys.xpos,
        nd.pen.phys.ypos
      )) as [number, number];
      const steps = Math.max(
        Math.abs(read[0] - dest[0]),
        Math.abs(read[1] - dest[1])
      );
      stats.pt_estimate += 1000 * (steps / rate);
      nd.pen.phys.xpos = xDest;
      nd.pen.phys.ypos = yDest;
      return;
    }

    const read = await readStepPosition(nd);
    if (read === null) return;
    if (!(dest[0] === read[0] && dest[1] === read[1])) {
      await absMoveWrapper(nd, dest[0], dest[1], rate);
      const d = stepsToXyPos(
        nd,
        Math.abs(dest[0] - read[0]),
        Math.abs(dest[1] - read[1])
      );
      stats.addDist(Boolean(nd.pen.phys.z_up), drip, distance(d[0], d[1]));
    }
    await this.readPosition();
  }
}
