import { test } from "node:test";
import assert from "node:assert/strict";
import { scurvePlan, striangle } from "../server/driver/motion/planUtils.ts";
import {
  isclose,
  pyMax,
  pyMin,
  pyRound,
} from "../server/driver/motion/pyMath.ts";
import { motionScales } from "../server/driver/motion/index.ts";
import { createConfig } from "../server/driver/config.ts";

test("striangle throws where nextdraw would loop forever", () => {
  // dist beyond what reaching v_max allows: the bisection pins at v_max.
  const vMax = 2;
  const reach = 2 * (scurvePlan(0, vMax, 8000, null) as number);
  assert.throws(() => striangle(0, 0, vMax, 8000, reach * 2), /converge/);
  // A reachable distance still converges.
  const v = striangle(0, 0, vMax, 8000, reach / 2);
  assert.ok(v > 0 && v < vMax);
});

test("math.isclose semantics", () => {
  assert.equal(isclose(0, 1e-300), false); // abs_tol defaults to 0
  assert.equal(isclose(1, 1 + 1e-10), true);
  assert.equal(isclose(0.5, 0.5005, 1e-9, 1e-3), true);
  assert.equal(isclose(Infinity, Infinity), true);
  assert.equal(isclose(Infinity, 1e308), false);
});

test("round() and min/max follow Python", () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(-2.5), -2);
  assert.ok(Object.is(pyRound(-0.0), 0));
  assert.ok(Object.is(pyRound(-0.4), 0));
  assert.ok(Object.is(pyMin(0, -0), 0)); // keeps the first of equals
  assert.ok(Object.is(pyMax(-0, 0), -0));
});

test("motionScales matches enable_motors for the default config", () => {
  const { options, params } = createConfig();
  const s = motionScales(options, params);
  assert.equal(s.step_scale, 2032);
  assert.equal(s.speed_pendown, (25 * 8.6979) / 100.0);
  assert.equal(s.speed_penup, (75 * 8.6979) / 100.0);
  const layer = motionScales(options, params, 110);
  assert.equal(layer.speed_pendown, (110 * 8.6979) / 100.0);
  const lowRes = motionScales(options, { ...params, resolution: 2 });
  assert.equal(lowRes.step_scale, 1016);
});
