import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Dec } from "../server/driver/motion/decimal20.ts";
import {
  maxRateT3,
  moveDistT3,
  rateT3,
  roundHalfEven,
} from "../server/driver/motion/ebbCalc.ts";

interface Vector {
  in: [number, number, number, number, number | "clear"];
  move: [number, number];
  rate: number;
  max: number;
}

const { vectors } = JSON.parse(
  readFileSync(
    new URL("./fixtures/ebb-calc-vectors.json", import.meta.url),
    "utf8"
  )
) as { vectors: Vector[] };

test("moveDistT3 matches plotink ebb_calc for every vector", () => {
  for (const v of vectors) {
    const [t, r, a, j, acc] = v.in;
    assert.deepEqual(
      moveDistT3(t, r, a, j, acc),
      v.move,
      `move_dist_t3${JSON.stringify(v.in)}`
    );
  }
});

test("rateT3 matches plotink ebb_calc for every vector", () => {
  for (const v of vectors) {
    const [t, r, a, j] = v.in;
    assert.equal(
      rateT3(t, r, a, j),
      v.rate,
      `rate_t3${JSON.stringify(v.in.slice(0, 4))}`
    );
  }
});

test("maxRateT3 matches plotink ebb_calc for every vector", () => {
  for (const v of vectors) {
    const [t, r, a, j] = v.in;
    assert.equal(
      maxRateT3(t, r, a, j),
      v.max,
      `max_rate_t3${JSON.stringify(v.in.slice(0, 4))}`
    );
  }
});

test("roundHalfEven follows Python round()", () => {
  assert.deepEqual(
    [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4999999, 2.5000001].map(roundHalfEven),
    [0, 2, 2, 0, -2, -2, 2, 3]
  );
});

test("Dec rounds to 20 significant digits, half-even", () => {
  // 1/3 and 2/3 at prec 20
  assert.equal(Dec.of(1).div(Dec.of(3)).toString(), "33333333333333333333e-20");
  assert.equal(Dec.of(2).div(Dec.of(3)).toString(), "66666666666666666667e-20");
  // exact tie at the 21st digit rounds to even
  const tie = Dec.of(10n ** 20n + 5n).add(Dec.of(0)); // 21 digits ...0005 -> drop one digit
  assert.equal(tie.toIntegerTrunc(), 10n ** 20n); // 10000000000000000000|5 -> even (…0)
  const tieUp = Dec.of(10n ** 20n + 15n).add(Dec.of(0));
  assert.equal(tieUp.toIntegerTrunc(), 10n ** 20n + 20n); // …1|5 -> …2
  assert.equal(Dec.of(-7).div(Dec.of(2)).toIntegerHalfUp(), -4n);
  assert.equal(Dec.of(7).div(Dec.of(2)).toIntegerHalfUp(), 4n);
});
