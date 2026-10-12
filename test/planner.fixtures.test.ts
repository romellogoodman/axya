import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSegment,
  trajectory,
  type SegmentTarget,
} from "../server/driver/motion/index.ts";
import { stageNames } from "./helpers/fixtures.ts";
import { contextFor, loadPlannerCase, pen } from "./helpers/plannerFixtures.ts";

for (const name of stageNames()) {
  test(`planner matches oracle: ${name}`, () => {
    const pc = loadPlannerCase(name);
    pc.calls.forEach((call, i) => {
      const where = `${name} #${i} ${call.fn}`;
      const start = pen(call.start);
      const end = pen(call.end);
      if (call.fn === "trajectory") {
        // Called with xyz_pos=None: plans from a copy of pen.phys.
        const ctx = contextFor(pc, i, start);
        const out = trajectory(ctx, call.in as number[][]);
        assert.deepStrictEqual(out, call.out, where);
        assert.deepStrictEqual(ctx.pen.phys, end, `${where} end`);
        return;
      }
      // xyz_pos was passed (and mutated) unless the recorded end equals the
      // start; when it equals, planning from pen.phys gives the same result.
      const passed = !isDeepStrictEqual(start, end);
      const ctx = contextFor(pc, i, passed ? pen(call.start) : start);
      const xyz = passed ? pen(call.start) : null;
      const [moves, data] = computeSegment(ctx, call.in as SegmentTarget, xyz);
      assert.deepStrictEqual(moves, call.out, where);
      assert.deepStrictEqual([data], call.extra, `${where} extra`);
      assert.deepStrictEqual(passed ? xyz : ctx.pen.phys, end, `${where} end`);
    });
  });
}

function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}
