/*
 * Tick-by-tick model of the EiBotBoard motion ISR for timed moves (T3, TD,
 * LT), written from the firmware source vendored at
 * docs/reference-apps/ebb-firmware/source/ebb.c:
 *
 *   - parse (process_low_level_move, ebb.c:2245-2510):
 *       rate' = rate - accel/2 + jerk/6   (C integer division, toward zero)
 *       Clear decision from rate' + accel, then accel + jerk, then jerk
 *       accel' = accel - jerk
 *   - each 40 µs tick (ebb.c:770-830):
 *       accel' += jerk; rate' += accel'; acc += rate'
 *       if bit 31 of acc is set: clear it and step in the direction of rate'
 *   - Clear loads acc = 0, or 0x7FFFFFFF when the move starts negative
 *     (ebb.c:1381-1396).
 *
 * All registers are 32-bit and wrap. Test-only: used to check that the
 * driver's firmware-exact prediction (ebbCalc.moveDistT3) agrees with what
 * the board actually does, and that planned motion stays in bounds.
 */

export interface AxisMove {
  rate: number;
  accel: number;
  jerk: number;
}

export interface AxisResult {
  steps: number; // net position change
  stepCount: number; // steps taken, either direction
  acc: number; // final accumulator
  rate: number; // final rate register
}

const i32 = (x: number) => x | 0;

/** Does a cleared accumulator start "negative" (0x7FFFFFFF)? ebb.c:2387-2425 */
function needsNegativeAccumulator(
  adjRate: number,
  accel: number,
  jerk: number
): boolean {
  let rateTemp = i32(adjRate + accel);
  if (rateTemp < 0) return true;
  if (rateTemp === 0) {
    rateTemp = i32(accel + jerk);
    if (rateTemp < 0) return true;
    if (rateTemp === 0 && jerk < 0) return true;
  }
  return false;
}

/**
 * Run one axis of a timed move for `intervals` ticks.
 * `startAcc` is the accumulator carried from the previous move, or "clear".
 */
export function simulateAxis(
  intervals: number,
  move: AxisMove,
  startAcc: number | "clear"
): AxisResult {
  let rate = i32(
    move.rate - Math.trunc(move.accel / 2) + Math.trunc(move.jerk / 6)
  );
  let acc: number;
  if (startAcc === "clear") {
    acc = needsNegativeAccumulator(rate, move.accel, move.jerk)
      ? 0x7fffffff
      : 0;
  } else {
    acc = startAcc >>> 0;
  }
  let accel = i32(move.accel - move.jerk);
  const jerk = i32(move.jerk);
  let steps = 0;
  let stepCount = 0;
  for (let t = 0; t < intervals; t++) {
    accel = i32(accel + jerk);
    rate = i32(rate + accel);
    acc = (acc + rate) >>> 0;
    if (acc & 0x80000000) {
      acc &= 0x7fffffff;
      steps += rate < 0 ? -1 : 1;
      stepCount += 1;
    }
  }
  return { steps, stepCount, acc, rate };
}

/** Two-axis machine state: global step counters and accumulators. */
export class EbbSim {
  steps: [number, number] = [0, 0];
  acc: [number, number] = [0, 0];

  /** Execute one command line; returns false for non-motion commands. */
  exec(line: string): boolean {
    const [name, ...rest] = line.split(",");
    const n = rest.map(Number);
    switch (name) {
      case "T3": {
        const clear = n[7] ?? 0;
        this.timed(
          n[0],
          [
            { rate: n[1], accel: n[2], jerk: n[3] },
            { rate: n[4], accel: n[5], jerk: n[6] },
          ],
          clear
        );
        return true;
      }
      case "TD": {
        // TD expands to two T3s (ebb.html#TD):
        //   T3,Intervals,Rate1A,0,Jerk1,Rate2A,0,Jerk2[,Clear]
        //   T3,Intervals,Rate1B,Accel1,-Jerk1,Rate2B,Accel2,-Jerk2,0
        const [t, r1a, r1b, a1, j1, r2a, r2b, a2, j2] = n;
        const clear = n[9] ?? 0;
        this.timed(
          t,
          [
            { rate: r1a, accel: 0, jerk: j1 },
            { rate: r2a, accel: 0, jerk: j2 },
          ],
          clear
        );
        this.timed(
          t,
          [
            { rate: r1b, accel: a1, jerk: -j1 },
            { rate: r2b, accel: a2, jerk: -j2 },
          ],
          0
        );
        return true;
      }
      case "LT": {
        const clear = n[5] ?? 0;
        this.timed(
          n[0],
          [
            { rate: n[1], accel: n[2], jerk: 0 },
            { rate: n[3], accel: n[4], jerk: 0 },
          ],
          clear
        );
        return true;
      }
      case "SM": {
        this.steps[0] += n[1];
        this.steps[1] += n[2] ?? 0;
        return true;
      }
      case "HM": {
        this.steps = n.length >= 3 ? [n[1], n[2]] : [0, 0];
        this.acc = [0, 0];
        return true;
      }
      case "EM":
      case "CS":
        this.steps = [0, 0];
        this.acc = [0, 0];
        return false;
      default:
        return false;
    }
  }

  private timed(intervals: number, axes: [AxisMove, AxisMove], clear: number) {
    for (const i of [0, 1] as const) {
      const start = clear & (1 << i) ? "clear" : this.acc[i];
      const r = simulateAxis(intervals, axes[i], start);
      this.steps[i] += r.steps;
      this.acc[i] = r.acc;
    }
  }
}
