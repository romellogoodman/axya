/**
 * V8's Math.sin/cos/tan/acos against CPython's (macOS libm) results on every
 * input the digest fixtures and vectors exercise. They are not bit-identical
 * (neither is correctly rounded), so this bounds the one irreducible
 * difference: at most one ulp. The stage and helper tests replay the CPython
 * values to compare everything downstream exactly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PYTHON_LIBM } from "./helpers/digestLibm.ts";
import { VECTORS } from "./helpers/digestVectors.ts";

function ulpDistance(a: number, b: number): number {
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  const ia = view.getBigInt64(0);
  const ib = view.getBigInt64(8);
  // Map sign-magnitude to a monotonic integer line.
  const ord = (i: bigint) => (i < 0n ? -(i & 0x7fffffffffffffffn) : i);
  const d = ord(ia) - ord(ib);
  return Number(d < 0n ? -d : d);
}

test("V8 Math trig is within 1 ulp of CPython's libm on all recorded inputs", () => {
  const rows = [
    ...PYTHON_LIBM,
    ...(VECTORS.libm as ["sin" | "cos" | "tan" | "acos", number, number][]),
  ];
  let differing = 0;
  for (const [fn, x, want] of rows) {
    const got = Math[fn](x);
    const d = ulpDistance(got, want);
    assert.ok(d <= 1, `${fn}(${x}): V8 ${got}, CPython ${want}`);
    if (d) differing += 1;
  }
  // A handful differ; if none did, the replay tables could be dropped.
  assert.ok(
    differing > 0 && differing < rows.length / 4,
    `${differing} of ${rows.length}`
  );
});
