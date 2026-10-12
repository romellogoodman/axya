import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSegment,
  formatMove,
  trajectory,
  type SegmentTarget,
  formatSM,
  formatT3,
  formatTD,
  type Move,
} from "../server/driver/motion/index.ts";
import { loadGolden } from "./helpers/fixtures.ts";
import { contextFor, loadPlannerCase, pen } from "./helpers/plannerFixtures.ts";

// The planner emits only T3 and TD. SM lines in the streams are homing
// moves and timed pauses, and this T3 is homing.read_position's
// accumulator clear.
const CLEAR_T3 = "T3,1,0,0,0,0,0,0,3";

const isPlannerMotion = (line: string) =>
  /^(T3|TD),/.test(line) && line !== CLEAR_T3;

const CASES = [
  "plot-basic",
  "plot-shapes",
  "plot-dense-reorder-2",
  "plot-handling-4",
  "plot-fast",
  "plot-handling-2",
  "plot-handling-3",
  "plot-layers-all",
  "plot-shapes-model2",
  "plot-offpage-noclip",
  "util-walk-mmx",
  "util-walk-mmy-neg",
];

for (const name of CASES) {
  test(`motion commands match golden stream: ${name}`, () => {
    const pc = loadPlannerCase(name);
    // Executed moves: top-level calls only. go_to_position's compute_segment
    // is called with xyz_pos=None (start == end); the ones nested inside
    // plan_trajectory are already part of their trajectory's output.
    const expected: string[] = [];
    pc.calls.forEach((call, i) => {
      const nested =
        call.fn === "compute_segment" &&
        JSON.stringify(call.start) !== JSON.stringify(call.end);
      if (nested) return;
      const ctx = contextFor(pc, i, pen(call.start));
      const moves =
        call.fn === "trajectory"
          ? trajectory(ctx, call.in as number[][])
          : computeSegment(ctx, call.in as SegmentTarget)[0];
      for (const move of (moves ?? []) as Move[]) {
        const line = formatMove(move);
        if (line !== null) expected.push(line);
      }
    });
    const golden = loadGolden(name)
      .commands.map(([, line]) => line)
      .filter(isPlannerMotion);
    assert.ok(expected.length > 0);
    assert.deepStrictEqual(expected, golden);
  });
}

test("formatters print fields in nextdraw's order", () => {
  assert.equal(
    formatT3([709, 1610290530, 0, 0, -5, 0, 0]),
    "T3,709,1610290530,0,0,-5,0,0"
  );
  assert.equal(
    formatTD([713, 0, 805877203, 2257228, 3166, 0, 0, -0, 0]),
    "TD,713,0,805877203,2257228,3166,0,0,0,0"
  );
  // ['SM', (steps2, steps1, ms)] goes out as SM,ms,steps1,steps2.
  assert.equal(formatSM([20, -10, 750]), "SM,750,-10,20");
  assert.equal(formatMove(["lower", null]), null);
  assert.throws(() => formatT3([1.5, 0, 0, 0, 0, 0, 0]), TypeError);
});
