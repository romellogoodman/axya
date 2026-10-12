/*
 * Machine-facing commands of the NextDraw class: connect/disconnect, the
 * voltage check, setup modes (align, toggle, cycle, find_home), utility
 * commands (pen, motors, set/walk home, nickname, bootloader), and the
 * machine preparation at the start of plot_document.
 *
 * Ported from nextdrawcore/nextdraw.py (nextdraw 1.7.5): serial_connect,
 * query_ebb_voltage, setup_command, utility_command, disconnect and the
 * first lines of plot_document,
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Planned motion (go_to_position) goes through nd.planner.
 */

import { parseDist } from "../run/status.ts";
import type { MachineContext } from "./context.ts";
import {
  connect,
  enableMotors,
  exhaustQueue,
  queryVoltage,
  readStatusByte,
  writeStepOffsets,
} from "./status.ts";

/** NextDraw.serial_connect (nextdraw.py): status 101 when no machine is found. */
export async function serialConnect(
  nd: MachineContext,
  caller: string | null = null
): Promise<void> {
  if (await connect(nd, (t) => nd.user_message_fun(t), caller)) {
    nd.connected = true;
  } else {
    nd.plot_status.stopped = 101;
  }
}

/** NextDraw.query_ebb_voltage: acknowledge earlier power loss, then check supply. */
export async function queryEbbVoltage(nd: MachineContext): Promise<boolean> {
  await readStatusByte(nd);
  if (nd.plot_status.power) {
    await nd.machine.clearSteps();
    await nd.machine.varWrite(0, 12); // not homed
    await nd.machine.varWrite(0, 13); // power lost
    nd.plot_status.power = false;
  }
  nd.plot_status.button = false;
  nd.plot_status.limit = false;
  return await queryVoltage(nd);
}

/** NextDraw.disconnect: wait for motion (except in utility mode), then close. */
export async function disconnect(nd: MachineContext): Promise<void> {
  if (nd.options.mode !== "utility") await exhaustQueue(nd);
  await nd.machine.disconnect();
  nd.connected = false;
}

/** NextDraw.setup_command: align, toggle, cycle and find_home modes. */
export async function setupCommand(nd: MachineContext): Promise<void> {
  if (nd.options.preview) {
    nd.user_message_fun("Command unavailable while in preview mode.");
    return;
  }
  if (nd.machine.port === null) return;

  await queryEbbVoltage(nd);
  await nd.pen.servoInit(nd); // also performs "toggle"

  if (nd.options.mode === "align") {
    await nd.pen.penRaise(nd);
    await nd.machine.motorsDisable();
  } else if (nd.options.mode === "cycle") {
    await nd.pen.cycle(nd);
  } else if (nd.options.mode === "find_home") {
    if (nd.options.homing && nd.params.auto_home) {
      await enableMotors(nd);
      await nd.machine.varWrite(0, 12); // force homing
      await nd.homing.findHome();
    } else if (nd.params.auto_home) {
      nd.user_message_fun("Automatic homing is disabled in settings.");
    } else {
      nd.user_message_fun(
        "The selected plotter model, " +
          `${nd.params.model_name}, ` +
          "does not support automatic homing."
      );
    }
  }
}

/** NextDraw.utility_command: commands that need USB but no SVG. */
export async function utilityCommand(nd: MachineContext): Promise<void> {
  if (nd.options.preview) {
    nd.user_message_fun("Command unavailable while in preview mode.");
    return;
  }
  if (nd.machine.port === null) return;
  const cmd = nd.options.utility_cmd;

  if (cmd === "bootload") {
    if (await nd.machine.bootload()) {
      nd.user_message_fun(
        "Entering bootloader mode for firmware programming.\n" +
          "To resume normal operation, you may need to first\n" +
          "press the reset button or disconnect the machine from\n" +
          "both USB and power."
      );
      await disconnect(nd);
    } else {
      nd.user_message_fun("Failed while trying to enter bootloader.");
    }
    return;
  }

  if (cmd === "read_name") nd.user_message_fun(String(nd.machine.name));

  if (cmd.startsWith("write_name")) {
    const i = cmd.indexOf("write_name");
    const name = cmd.slice(i + "write_name".length).slice(0, 16);
    if (await nd.machine.writeNickname(name)) {
      nd.user_message_fun(
        name === ""
          ? 'Writing "blank" Nickname; setting to default.'
          : `Nickname "${name}" written.`
      );
      nd.user_message_fun("Rebooting EBB.");
    } else {
      nd.user_message_fun("Error encountered while writing nickname.");
    }
    await nd.machine.command("R"); // soft reset
    await nd.machine.reboot(); // required after writing the nickname
    await disconnect(nd);
    return;
  }

  await queryEbbVoltage(nd);
  if (cmd === "raise_pen" || cmd === "lower_pen") {
    await nd.pen.servoInit(nd); // the mode selects the goal state
  } else if (cmd === "enable_xy") {
    await enableMotors(nd);
  } else if (cmd === "disable_xy") {
    await nd.machine.motorsDisable();
  } else if (cmd === "set_home") {
    await nd.homing.setHome();
  } else if (
    ["walk_home", "walk_x", "walk_y", "walk_mmx", "walk_mmy"].includes(cmd)
  ) {
    await walk(nd, cmd);
  }
}

/**
 * walk_home returns to the true home; walk_x/y/mmx/mmy move the carriage by
 * `dist` while keeping its logical position, which shifts the plot origin
 * (nextdraw.py utility_command).
 */
async function walk(nd: MachineContext, cmd: string): Promise<void> {
  await nd.pen.servoInit(nd);
  await enableMotors(nd);
  if (!(await nd.homing.findHome())) return;
  await exhaustQueue(nd);

  if (cmd === "walk_home") {
    await writeStepOffsets(nd, 0, 0);
    await nd.homing.readPosition();
    await nd.planner.go_to_position(
      Math.min(nd.pen.phys.xpos, 0.01),
      Math.min(nd.pen.phys.ypos, 0.01),
      true
    );
    await nd.homing.precisionMoveTo(0, 0);
    return;
  }

  await nd.homing.readPosition();
  const xposTemp = nd.pen.phys.xpos;
  const yposTemp = nd.pen.phys.ypos;
  const defaultUnit = cmd === "walk_mmx" || cmd === "walk_mmy" ? "mm" : "in";

  let distInches: number;
  try {
    distInches = parseDist(nd.options.dist, defaultUnit);
  } catch (e) {
    nd.user_message_fun(`Error: ${(e as Error).message}`);
    return;
  }
  const dy = cmd === "walk_y" || cmd === "walk_mmy";
  await nd.homing.adjustOriginOffset(dy ? 0 : distInches, dy ? distInches : 0);
  await nd.planner.go_to_position(xposTemp, yposTemp, true);
  // Correction move to the exact step position, so errors don't accumulate.
  await nd.homing.precisionMoveTo(xposTemp, yposTemp);
}

/**
 * The machine preparation at the start of NextDraw.plot_document: voltage
 * check, servo setup, pen up, motors, homing. False means do not plot.
 */
export async function preparePlot(nd: MachineContext): Promise<boolean> {
  if (!nd.options.preview) {
    if (nd.machine.port === null) return false;
    if (!(await queryEbbVoltage(nd))) return false;
  }
  await nd.pen.servoInit(nd);
  await nd.pen.penRaise(nd);
  await enableMotors(nd);
  return await nd.homing.findHome();
}
