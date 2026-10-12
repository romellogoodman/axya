/*
 * Fake EiBotBoard (firmware 3.x) as a Transport: a TypeScript port of
 * test/oracle/fake_ebb.py. Same state model and replies: legacy/future
 * syntax, QG bits (pen down 0x10, button 0x20, limit 0x80), SL/QL RAM, QE
 * from EM codes, QS step tracking (firmware-exact T3 via moveDistT3), EM/CS
 * resets, and the limit switch at physical X = 0 (CU,51 mask, CU,52 target,
 * PI,B,1, SM truncated where the switch closes).
 *
 * Test infrastructure only: replies are immediate (readLine never waits and
 * never advances the clock), as in the oracle.
 */

import {
  moveDistT3,
  roundHalfEven,
} from "../../server/driver/motion/ebbCalc.ts";
import type {
  Clock,
  PortInfo,
  PortProvider,
  Transport,
} from "../../server/driver/ebb/transport.ts";

export const FIRMWARE_VERSION = "EBBv13_and_above EB Firmware Version 3.1.7";

/** QE reply value (microstep multiplier) for each EM resolution code. */
const EM_TO_QE: Record<number, number> = {
  0: 0,
  1: 16,
  2: 8,
  3: 4,
  4: 2,
  5: 1,
};

export interface FakeEbbSettings {
  homed?: boolean;
  motors_on?: boolean;
  voltage?: number;
  pause_after_moves?: number | null;
  start_x_mm?: number;
  step_scale?: number;
  firmware?: string;
}

/** Python round(x, 3) for the log timestamps. */
const round3 = (x: number) => roundHalfEven(x * 1000) / 1000;

export class FakeEbbTransport implements Transport {
  clock: Clock;
  future_syntax = false;
  rx: string[] = [];
  log: [number, string][] = [];
  ram: number[] = new Array(32).fill(0);
  voltage: number;
  pen_up = true;
  motors: [number, number];
  steps: [number, number] = [0, 0];
  accum: [number, number] = [0, 0];
  moves = 0;
  pause_after_moves: number | null;
  button = false;
  x_phys: number;
  limit_mask = 0;
  limit_target = 0;
  limit_triggered = false;
  firmware: string;
  is_open = true;

  constructor(clock: Clock, settings: FakeEbbSettings = {}) {
    const {
      homed = true,
      motors_on = true,
      voltage = 900,
      pause_after_moves = null,
      start_x_mm = 60.0,
      step_scale = 2032,
      firmware = FIRMWARE_VERSION,
    } = settings;
    this.clock = clock;
    if (homed) {
      this.ram[12] = 1;
      this.ram[13] = 1;
    }
    this.voltage = voltage;
    this.motors = motors_on ? [1, 1] : [0, 0];
    this.pause_after_moves = pause_after_moves;
    this.x_phys = (start_x_mm / 25.4) * step_scale;
    this.firmware = firmware;
  }

  // --- Transport ---

  async writeLine(line: string): Promise<void> {
    if (!this.is_open) throw new Error("port closed");
    for (const part of (line + "\r").split("\r")) {
      if (part) this.handle(part);
    }
  }

  async readLine(_timeoutMs: number): Promise<string | null> {
    // Lines are queued with their endings; strip only the final "\n" as
    // pyserial's readline would keep it and the caller strips.
    const line = this.rx.shift();
    return line === undefined ? null : line.replace(/\n$/, "");
  }

  async flushInput(): Promise<void> {
    this.rx = [];
  }

  async close(): Promise<void> {
    this.is_open = false;
  }

  /** Feed a recorded command line, discarding its reply. */
  replay(line: string): void {
    this.handle(line);
    this.rx = [];
  }

  // --- protocol ---

  private reply(text: string): void {
    this.rx.push(text + (this.future_syntax ? "\n" : "\r\n"));
  }

  private handle(line: string): void {
    this.log.push([round3(this.clock.now()), line]);
    const parts = line.split(",");
    const name = parts[0].toUpperCase();
    const args = parts.slice(1);

    if (name === "V") {
      this.reply(this.firmware);
      return;
    }
    if (name === "CU" && args[0] === "10" && args[1] === "1") {
      this.reply(""); // the mode switch answers with a bare newline
      this.future_syntax = true;
      return;
    }
    const query = this.queries[name];
    if (query) {
      query(args);
      return;
    }
    if (["SM", "T3", "TD", "HM", "LM", "LT", "L3", "XM"].includes(name)) {
      this.motion(name, args);
    } else if (name === "SP") {
      if (args[0] === "1" || args[0] === "3") this.pen_up = true;
      else if (args[0] === "0") this.pen_up = false;
    } else if (name === "EM") {
      this.motors = [
        pyInt(args[0]),
        args.length > 1 ? pyInt(args[1]) : this.motors[1],
      ];
      this.steps = [0, 0]; // EM clears step counters, accumulators and limit trigger
      this.accum = [0, 0];
      this.limit_triggered = false;
    } else if (name === "CS") {
      this.steps = [0, 0];
      this.accum = [0, 0];
    } else if (name === "CU" && args[0] === "51") {
      this.limit_mask = pyInt(args[1]);
      if (this.limit_mask === 0) this.limit_triggered = false;
    } else if (name === "CU" && args[0] === "52") {
      this.limit_target = pyInt(args[1]);
    } else if (name === "SL") {
      this.ram[pyInt(args[1])] = pyInt(args[0]) & 0xff;
    }
    this.reply(name); // future syntax: echo the command name
  }

  private queries: Record<string, (args: string[]) => void> = {
    QG: () => {
      let status = this.pen_up ? 0 : 0x10;
      if (this.limit_triggered) status |= 0x80;
      if (this.button) {
        status |= 0x20;
        this.button = false; // button flag clears on read
      }
      this.reply(`QG,${status.toString(16).toUpperCase().padStart(2, "0")}`);
    },
    QT: () => this.reply("QT,"),
    QL: (args) => this.reply(`QL,${this.ram[pyInt(args[0])]}`),
    QE: () =>
      this.reply(`QE,${EM_TO_QE[this.motors[0]]},${EM_TO_QE[this.motors[1]]}`),
    QS: () => this.reply(`QS,${this.steps[0]},${this.steps[1]}`),
    QC: () => this.reply(`QC,300,${this.voltage}`),
    QU: () => this.reply("QU,0"), // every queued command has already "executed"
    PI: () => this.reply(`PI,${this.switchPressed() ? 1 : 0}`),
    ES: () => this.reply("ES,0"),
  };

  private switchPressed(): boolean {
    return this.x_phys <= 0;
  }

  /** Physical X change for commanded motor steps d1, d2. */
  private moveX(d1: number, d2: number): number {
    return ((this.motors[0] ? d1 : 0) + (this.motors[1] ? d2 : 0)) / 2;
  }

  private motion(name: string, args: string[]): void {
    const nums = args.map(pyInt);
    if (this.limit_triggered && name !== "HM") return; // latched: motion ignored
    if (name === "SM") {
      const d1 = nums[1];
      const d2 = nums.length > 2 ? nums[2] : 0;
      const dx = this.moveX(d1, d2);
      let frac = 1.0;
      if (
        this.limit_mask &&
        dx < 0 &&
        this.x_phys + dx <= 0 &&
        0 < this.x_phys
      ) {
        frac = this.x_phys / -dx; // stop where the switch closes
        this.limit_triggered = true;
      }
      this.steps[0] += roundHalfEven(d1 * frac);
      this.steps[1] += roundHalfEven(d2 * frac);
      this.x_phys += dx * frac;
    } else if (name === "HM") {
      const target: [number, number] =
        nums.length >= 3 ? [nums[1], nums[2]] : [0, 0];
      this.x_phys += this.moveX(
        target[0] - this.steps[0],
        target[1] - this.steps[1]
      );
      this.steps = target;
      this.accum = [0, 0];
    } else if (name === "T3") {
      const clear = nums.length > 7 ? nums[7] : 0;
      this.t3(
        nums[0],
        [nums[1], nums[2], nums[3]],
        [nums[4], nums[5], nums[6]],
        clear
      );
    } else if (name === "TD") {
      const [ticks, r1a, r1b, a1, j1, r2a, r2b, a2, j2] = nums;
      const clear = nums.length > 9 ? nums[9] : 0;
      this.t3(ticks, [r1a, 0, j1], [r2a, 0, j2], clear);
      this.t3(ticks, [r1b, a1, -j1], [r2b, a2, -j2], 0);
    }
    this.moves += 1;
    if (
      this.pause_after_moves !== null &&
      this.moves === this.pause_after_moves
    )
      this.button = true;
  }

  private t3(
    ticks: number,
    axis1: [number, number, number],
    axis2: [number, number, number],
    clear: number
  ): void {
    [axis1, axis2].forEach(([rate, accel, jerk], i) => {
      const start = clear & (1 << i) ? "clear" : this.accum[i];
      const [steps, accum] = moveDistT3(ticks, rate, accel, jerk, start);
      this.steps[i] += steps;
      this.accum[i] = accum;
      this.x_phys += i === 0 ? this.moveX(steps, 0) : this.moveX(0, steps);
    });
  }
}

function pyInt(s: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new RangeError(`int('${s}')`);
  return Number(s);
}

/** A PortProvider exposing one fake EBB, as the oracle patches comports(). */
export function fakePortProvider(fake: FakeEbbTransport): PortProvider {
  const info: PortInfo = {
    device: "/dev/fake-ebb",
    description: "EiBotBoard",
    hwid: "USB VID:PID=04D8:FD92",
  };
  return {
    list: async () => [info],
    open: async () => {
      fake.is_open = true;
      return fake;
    },
  };
}
