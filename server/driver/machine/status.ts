/*
 * Machine status and motor helpers: connection setup, the QG status byte,
 * waiting for the motion queue, motor enable and speed scales, step
 * position and origin-offset RAM.
 *
 * Ported from nextdrawcore/serial_utils.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/serial_utils.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import type { MachineContext } from "./context.ts";

/** Open the port and apply connection-time settings (serial_utils.py:37-69). */
export async function connect(
  nd: MachineContext,
  messageFun: (text: string) => void,
  caller: string | null = null
): Promise<boolean> {
  if (nd.options.port_config === 1) nd.options.port = null;
  if (!nd.options.port) {
    await nd.machine.connect(null, caller);
  } else {
    nd.options.port = String(nd.options.port).replace(/^"+|"+$/g, "");
    await nd.machine.connect(nd.options.port, caller);
  }

  if (nd.machine.port === null) {
    const modelName = nd.options.model !== 0 ? nd.params.model_name : "machine";
    const failed = "Failed to connect to " + modelName;
    messageFun(
      nd.options.port ? `${failed} ${nd.options.port}.` : failed + "."
    );
    return false;
  }

  await nd.machine.command("CU,3,1"); // data-low LED
  await nd.machine.command("CU,4,16"); // FIFO depth 16
  await nd.machine.command("CU,50,0"); // allow stepper freewheeling
  return true;
}

/** Spot-check the motor supply (serial_utils.py:72-88). */
export async function queryVoltage(nd: MachineContext): Promise<boolean> {
  if (nd.params.skip_voltage_check) return true;
  if (nd.machine.port !== null && !nd.options.preview) {
    if (!(await nd.machine.queryVoltage(200))) {
      nd.warnings.addNew("voltage");
      if (!nd.plot_status.power) {
        // Only on first sight of the power-lost condition.
        await nd.machine.varWrite(0, 12); // not homed
        await nd.machine.varWrite(0, 13); // power lost
        await nd.machine.clearSteps();
        nd.plot_status.power = true;
      }
      return false;
    }
  }
  return true;
}

/**
 * Read QG and act on its flags: bit 7 limit, bit 6 power lost, bit 5 button
 * (serial_utils.py:91-126). A single unreadable reply is tolerated; a second
 * flags a lost connection.
 */
export async function readStatusByte(
  nd: MachineContext
): Promise<number | null> {
  if (nd.options.preview) return null;

  const qg = await nd.machine.queryStatusbyte();
  if (nd.machine.err !== null) {
    nd.plot_status.connection = true;
    return null;
  }
  if (qg === null) {
    if (nd.plot_status.monitor) nd.plot_status.connection = true;
    nd.plot_status.monitor = true;
    return null;
  }

  if (qg & 128) nd.plot_status.limit = true;
  if (qg & 32) nd.plot_status.button = true;
  if (qg & 64 && !nd.params.skip_voltage_check) {
    if (!nd.plot_status.power) {
      await nd.machine.varWrite(0, 12);
      await nd.machine.varWrite(0, 13);
      await nd.machine.clearSteps();
    }
    nd.plot_status.power = true;
  }
  return qg;
}

/** Wait, polling QG every 50 ms, until the motion queue is empty (serial_utils.py:129-153). */
export async function exhaustQueue(nd: MachineContext): Promise<void> {
  if (nd.machine.port === null) return;
  for (;;) {
    if (nd.receive_pause_request()) break;
    const qg = await readStatusByte(nd);
    if (qg === null) return;
    if ((qg & 15) === 0 || nd.plot_status.button) return;
    await nd.clock.sleep(50);
  }
}

/** HM to an absolute (A, B) step position; short corrections only (serial_utils.py:155-168). */
export async function absMoveWrapper(
  nd: MachineContext,
  pos1: number,
  pos2: number,
  rate: number
): Promise<void> {
  if (nd.options.preview || nd.machine.port === null) return;
  await nd.machine.absMove(rate, Math.trunc(pos1), Math.trunc(pos2));
}

/**
 * Enable motors at the configured resolution and set step_scale and the
 * pen-up/down speeds (serial_utils.py:171-218).
 */
export async function enableMotors(nd: MachineContext): Promise<void> {
  const localSpeedPendown = nd.use_layer_speed
    ? nd.layer_speed_pendown
    : nd.options.speed_pendown;

  let res1 = 0;
  let res2 = 0;
  if (!nd.options.preview) {
    await readStatusByte(nd);
    await nd.machine.command("CU,60,135"); // power monitoring, threshold ~4 V

    const response = await nd.machine.motorsQueryEnabled();
    if (response === null) return;
    // nextdraw quirk: QE is sent a second time for the values it uses
    // (serial_utils.py:188-191).
    const again = await nd.machine.motorsQueryEnabled();
    if (again === null)
      throw new TypeError("cannot unpack non-iterable NoneType");
    [res1, res2] = again;

    await readStatusByte(nd); // mainly to clear a set power flag
    if (nd.plot_status.power) {
      await nd.machine.varWrite(0, 12); // not homed
      nd.plot_status.power = false;
    }
  }

  if (nd.params.resolution === 1) {
    if (!nd.options.preview && !(res1 === 1 && res2 === 1)) {
      await nd.machine.motorsEnable(1, 1); // 16x microstepping
      await nd.machine.varWrite(0, 12);
      await nd.machine.clearSteps(); // EM already cleared them
    }
    nd.step_scale = 2.0 * nd.params.native_res_factor;
    nd.speed_pendown = (localSpeedPendown * nd.params.speed_limit) / 100.0;
    nd.speed_penup = (nd.options.speed_penup * nd.params.speed_up) / 100.0;
  } else {
    if (!nd.options.preview && !(res1 === 2 && res2 === 2)) {
      await nd.machine.motorsEnable(2, 2); // 8x microstepping
      await nd.machine.varWrite(0, 12);
      await nd.machine.clearSteps();
    }
    nd.step_scale = nd.params.native_res_factor;
    nd.speed_penup = (nd.options.speed_penup * nd.params.speed_up) / 100.0;
    nd.speed_pendown = (localSpeedPendown * nd.params.speed_limit) / 100.0;
  }
}

/** QS after the queue empties (serial_utils.py:221-229). */
export async function readStepPosition(
  nd: MachineContext
): Promise<[number, number] | null> {
  if (nd.machine.port !== null && !nd.options.preview) {
    await exhaustQueue(nd);
    return await nd.machine.querySteps();
  }
  return null;
}

/** Origin offsets (steps × 1000) from RAM slots 24-27 and 28-31 (serial_utils.py:232-242). */
export async function readStepOffsets(
  nd: MachineContext
): Promise<[number, number] | null> {
  if (nd.options.preview) return [0, 0];
  if (nd.machine.port !== null) {
    const m1 = await nd.machine.varReadInt32(24);
    const m2 = await nd.machine.varReadInt32(28);
    // nextdraw quirk: var_read_int32 can return False, which passes the
    // "None not in offsets" check and then acts as 0 (serial_utils.py:240).
    if (m1 !== null && m2 !== null) return [Number(m1), Number(m2)];
  }
  return null;
}

export async function writeStepOffsets(
  nd: MachineContext,
  offset1: number,
  offset2: number
): Promise<boolean> {
  if (nd.machine.port !== null && !nd.options.preview) {
    const ok1 = await nd.machine.varWriteInt32(offset1, 24);
    const ok2 = await nd.machine.varWriteInt32(offset2, 28);
    if (ok1 !== false && ok2 !== false) return true;
  }
  return false;
}
