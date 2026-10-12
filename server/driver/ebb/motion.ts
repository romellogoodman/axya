/*
 * EiBotBoard (firmware 3.x) motion and I/O command wrappers.
 *
 * Ported from plotink/ebb3_motion.py 0.2 (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/plotink/ebb3_motion.py.
 * Copyright (c) 2025 Windell H. Oskay, Bantam Tools. MIT License:
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
 *
 * Arguments are formatted with JavaScript's String(); every caller in
 * nextdraw passes Python ints here, whose str() is identical.
 */

import { EBB3 } from "./ebb3.ts";

/** QE reply value -> EM resolution code (ebb3_motion.py:184). */
const RES_MAP: Record<number, number> = { 16: 1, 8: 2, 4: 3, 2: 4, 1: 5, 0: 0 };

function decodeRes(field: string): number {
  const res = RES_MAP[Number(field.trim())];
  if (res === undefined || field.trim() === "")
    throw new RangeError(`KeyError: ${field}`); // Python's res_map[...] lookup
  return res;
}

export class EBBMotionWrap extends EBB3 {
  private get idle(): boolean {
    return this.port === null || this.err !== null;
  }

  /** Pause the EBB's queue for pause_time ms using SM moves of at most 750 ms. */
  async timedPause(pauseTime: number): Promise<void> {
    if (this.idle) return;
    while (pauseTime > 0) {
      const delay = pauseTime > 750 ? 750 : Math.max(pauseTime, 1);
      await this.command(`SM,${delay},0,0`);
      pauseTime -= delay;
    }
  }

  /** `SM,duration,axis1,axis2`. Note the argument order: axis 1 is delta_y. */
  async xyMove(
    deltaX: number,
    deltaY: number,
    duration: number
  ): Promise<void> {
    if (this.idle) return;
    await this.command(`SM,${duration},${deltaY},${deltaX}`);
  }

  async absMove(
    rate: number,
    position1: number | null = null,
    position2: number | null = null
  ): Promise<void> {
    if (this.idle) return;
    if (position1 !== null && position2 !== null) {
      await this.command(`HM,${rate},${position1},${position2}`);
    } else {
      await this.command(`HM,${rate}`);
    }
  }

  async motorsDisable(): Promise<void> {
    if (this.idle) return;
    await this.command("EM,0,0");
  }

  /** EM at the given resolution codes (0 off, 1 = 16x ... 5 = full step). */
  async motorsEnable(resolution1: number, resolution2: number): Promise<void> {
    if (this.idle) return;
    resolution1 = Math.min(Math.max(Math.trunc(resolution1), 0), 5);
    resolution2 = Math.min(Math.max(Math.trunc(resolution2), 0), 5);

    // Enabling only one motor needs CU,50,0 to allow it.
    if (resolution1 !== resolution2 && resolution1 * resolution2 === 0) {
      await this.command("CU,50,0");
    }
    // Enabling only motor 2: set the global resolution through motor 1 first.
    if (resolution1 === 0 && resolution2 !== 0) {
      let oldRes = 0;
      const motorRes = await this.motorsQueryEnabled();
      if (motorRes === null) return;
      if (motorRes[1] !== 0) oldRes = motorRes[1];
      if (motorRes[0] !== 0) oldRes = motorRes[0];
      if (oldRes !== resolution2) {
        await this.command(`EM,${resolution2},${resolution2}`);
      }
    }
    await this.command(`EM,${resolution1},${resolution2}`);
  }

  /** Motor enable states as EM resolution codes, or null on error. */
  async motorsQueryEnabled(): Promise<[number, number] | null> {
    if (this.idle) return null;
    const response = await this.query("QE");
    if (response === null) return null;
    const list = response.split(",");
    return [decodeRes(list[0]), decodeRes(list[1] ?? "")];
  }

  /** Global step position from QS, or null on error. */
  async querySteps(): Promise<[number, number] | null> {
    if (this.idle) return null;
    const result = await this.query("QS");
    if (this.err || result === null) return null;
    const list = result.trim().split(",");
    return [Number.parseInt(list[0], 10), Number.parseInt(list[1], 10)];
  }

  async clearSteps(): Promise<void> {
    if (this.idle) return;
    await this.command("CS");
  }

  async clearAccumulators(): Promise<void> {
    if (this.idle) return;
    await this.command("T3,1,0,0,0,0,0,0,3");
  }

  async penLower(penDelay: number, pin: number | null = null): Promise<void> {
    if (this.idle) return;
    await this.command(pin ? `SP,0,${penDelay},${pin}` : `SP,0,${penDelay}`);
  }

  async penRaise(penDelay: number, pin: number | null = null): Promise<void> {
    if (this.idle) return;
    await this.command(pin ? `SP,1,${penDelay},${pin}` : `SP,1,${penDelay}`);
  }

  /** Configure port B pin: state 0/1, direction 0 output / 1 input. */
  async dioBConfig(
    pin: number,
    state: number,
    direction: number
  ): Promise<void> {
    if (this.idle) return;
    await this.command(`PO,B,${pin},${state}`);
    await this.command(`PD,B,${pin},${direction}`);
  }

  async dioBSet(pin: number, state: number): Promise<void> {
    if (this.idle) return;
    await this.command(`PO,B,${pin},${state}`);
  }

  async dioBRead(pin: number): Promise<boolean | null> {
    if (this.idle) return null;
    const response = await this.query(`PI,B,${pin}`);
    if (response === null) return null;
    return Number.parseInt(response, 10) !== 0;
  }

  /** SC,5: pen-down servo position. */
  async penPosDown(servoMax: number): Promise<void> {
    if (this.idle) return;
    await this.command(`SC,5,${servoMax}`);
  }

  /** SC,4: pen-up servo position. */
  async penPosUp(servoMin: number): Promise<void> {
    if (this.idle) return;
    await this.command(`SC,4,${servoMin}`);
  }

  async penRateDown(rate: number): Promise<void> {
    if (this.idle) return;
    await this.command(`SC,12,${rate}`);
  }

  async penRateUp(rate: number): Promise<void> {
    if (this.idle) return;
    await this.command(`SC,11,${rate}`);
  }

  async servoTimeout(
    timeoutMs: number,
    state: number | null = null
  ): Promise<void> {
    if (this.idle) return;
    await this.command(
      state === null ? `SR,${timeoutMs}` : `SR,${timeoutMs},${state}`
    );
  }

  /** Is the motor supply above threshold (default 250)? null on a malformed reply. */
  async queryVoltage(threshold: number | null = null): Promise<boolean | null> {
    if (this.idle) return null;
    if (threshold === null) threshold = 250;
    const reply = await this.query("QC");
    // nextdraw quirk: a failed QC makes Python call None.split and raise
    // (ebb3_motion.py:371).
    if (reply === null) throw new TypeError("QC query failed");
    const split = splitOnce(reply, ",");
    if (split.length <= 1) return null;
    return Number.parseInt(split[1], 10) >= threshold;
  }

  async queryCurrent(): Promise<[number | null, number | null]> {
    if (this.idle) return [null, null];
    const reply = await this.query("QC");
    if (reply === null) throw new TypeError("QC query failed");
    const split = splitOnce(reply, ",");
    if (split.length > 1)
      return [Number.parseInt(split[0], 10), Number.parseInt(split[1], 10)];
    return [null, null];
  }
}

function splitOnce(s: string, sep: string): string[] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}
