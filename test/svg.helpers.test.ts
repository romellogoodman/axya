/** SVG-digest helpers against Python reference vectors (test/helpers/digestVectors.ts). */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import { formatFixed } from "../server/driver/pyfmt.ts";
import { parsePath as cspParse } from "../server/driver/svg/cubicsuperpath.ts";
import { formatExp, isclose } from "../server/driver/svg/pycompat.ts";
import {
  clipSegment,
  getLengthInches,
  parseLengthWithUnits,
  pointsEqual,
  subdivideCubicPath,
  supersample,
  unitsToUserUnits,
  vbScale2,
} from "../server/driver/svg/plotUtils.ts";
import { formatPath, parsePath } from "../server/driver/svg/simplepath.ts";
import { parseStyle } from "../server/driver/svg/simplestyle.ts";
import {
  composeTransform,
  formatTransform,
  invertTransform,
  parseTransform,
} from "../server/driver/svg/simpletransform.ts";
import { LayerProperties } from "../server/driver/digest/pathObjects.ts";
import {
  convertCircleEllipseToPath,
  viewBoxTransform,
} from "../server/driver/svg/digest.ts";
import { setLibm } from "../server/driver/svg/libm.ts";
import { digestLibmReplay } from "./helpers/digestLibm.ts";
import { VECTORS } from "./helpers/digestVectors.ts";

type Outcome<T> = { ok: T } | { error: string };

function checkOutcome<T>(want: Outcome<T>, run: () => T, msg: string): void {
  if ("error" in want) {
    assert.throws(run, `${msg}: expected ${want.error}`);
  } else {
    assert.deepStrictEqual(run(), want.ok, msg);
  }
}

const v = <T>(key: string) => VECTORS[key] as T;

// Replay CPython's libm results where V8 differs by an ulp (see svg.libm.test.ts).
let restore = () => {};
before(() => {
  restore = setLibm(digestLibmReplay(v<[string, number, number][]>("libm")));
});
after(() => restore());

test("simplepath.parsePath", () => {
  for (const [d, want] of v<[string, Outcome<unknown>][]>("simplepath")) {
    checkOutcome(want, () => parsePath(d), JSON.stringify(d));
  }
});

test("simplepath.formatPath round trip", () => {
  for (const [d, want] of v<[string, Outcome<string>][]>("formatPath")) {
    checkOutcome(want, () => formatPath(parsePath(d)), JSON.stringify(d));
  }
});

test("cubicsuperpath.parsePath (arcs, quadratics, closepath)", () => {
  for (const [d, want] of v<[string, Outcome<unknown>][]>("cubicsuperpath")) {
    checkOutcome(want, () => cspParse(d), JSON.stringify(d));
  }
});

test("simpletransform.parseTransform", () => {
  for (const [t, want] of v<[string, Outcome<unknown>][]>("transform")) {
    checkOutcome(want, () => parseTransform(t), JSON.stringify(t));
  }
});

test("composeTransform, invertTransform, formatTransform", () => {
  for (const [a, b, c, inv, fmt] of v<number[][][][]>("compose")) {
    assert.deepStrictEqual(composeTransform(a, b), c);
    assert.deepStrictEqual(invertTransform(a), inv);
    assert.equal(formatTransform(a), fmt as unknown as string);
  }
});

test("simplestyle.parseStyle", () => {
  for (const [s, want] of v<[string, Outcome<[string, string][]>][]>("style")) {
    checkOutcome(
      want,
      () => [...parseStyle(s)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      JSON.stringify(s)
    );
  }
});

test("parseLengthWithUnits, unitsToUserUnits, getLengthInches", () => {
  for (const [s, pl, uu, uuPct] of v<
    [string, unknown[], number | null, number | null][]
  >("lengths")) {
    assert.deepStrictEqual(parseLengthWithUnits(s), pl, s);
    assert.deepStrictEqual(unitsToUserUnits(s), uu, s);
    assert.deepStrictEqual(unitsToUserUnits(s, 300.0), uuPct, s);
  }
  for (const [s, inches] of v<[string, number | null][]>("inches")) {
    assert.deepStrictEqual(getLengthInches(s), inches, s);
  }
});

test("vb_scale_2 with preserveAspectRatio", () => {
  for (const [[vb, par, w, h], want] of v<
    [[string | null, string | null, number, number], number[] | null][]
  >("vbscale")) {
    assert.deepStrictEqual(vbScale2(vb, par, w, h), want, `${vb} ${par}`);
  }
});

test("subdivideCubicPath", () => {
  for (const [sp, tol, want] of v<[number[][][], number, number[][][]][]>(
    "subdivide"
  )) {
    const got = structuredClone(sp);
    subdivideCubicPath(got, tol);
    assert.deepStrictEqual(got, want);
  }
});

test("plot_utils.supersample", () => {
  for (const [verts, tol, want] of v<[number[][], number, number[][]][]>(
    "supersample"
  )) {
    const got = structuredClone(verts);
    supersample(got, tol);
    assert.deepStrictEqual(got, want);
  }
});

test("clip_segment", () => {
  for (const [seg, bounds, accept, out] of v<
    [number[][], number[][], boolean, number[][]][]
  >("clip")) {
    assert.deepStrictEqual(clipSegment(seg, bounds), [accept, out]);
  }
});

test("points_equal (math.isclose)", () => {
  for (const [a, b, want] of v<[number[], number[], boolean][]>("isclose")) {
    assert.equal(pointsEqual(a, b), want);
  }
  assert.equal(isclose(Infinity, Infinity), true);
  assert.equal(isclose(NaN, NaN), false);
});

test("LayerProperties.parse and compose", () => {
  for (const [name, want] of v<[string, Outcome<Record<string, unknown>>][]>(
    "layernames"
  )) {
    checkOutcome(
      want,
      () => {
        const p = new LayerProperties();
        p.parse(name);
        return { ...p, compose: p.compose() };
      },
      JSON.stringify(name)
    );
  }
});

test("'{:.6E}' / '{:.2E}' / '{:.0E}' formatting", () => {
  for (const [x, e6, e2, e0, f] of v<
    [number | string, string, string, string, string][]
  >("formatExp")) {
    const n = typeof x === "string" ? Number(x.replace("inf", "Infinity")) : x;
    assert.equal(formatExp(n, 6), e6, String(x));
    assert.equal(formatExp(n, 2), e2, String(x));
    assert.equal(formatExp(n, 0), e0, String(x));
    assert.equal(formatFixed(n, 6), f, String(x));
  }
});

function el(xml: string): Element {
  return new DOMParser().parseFromString(xml, "text/xml")
    .documentElement as Element;
}

test("circle path data rounds through '%f'", () => {
  const d = convertCircleEllipseToPath(
    el(
      '<circle xmlns="http://www.w3.org/2000/svg" cx="0.0078125" cy="1" r="0.5"/>'
    )
  );
  assert.equal(
    d,
    "M 0.507812,1.000000 A 0.500000,0.500000 0 1 1 -0.492188,1.000000 A 0.500000,0.500000 0 1 1 0.507812,1.000000"
  );
});

test("viewBox transform keeps 7 significant digits", () => {
  const root = el(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8in" height="6in"/>'
  );
  const { vb, transform } = viewBoxTransform(root, 8, 6);
  assert.deepStrictEqual(vb, [1 / 96, 1 / 96, 0, 0]);
  assert.equal(transform[0][0], 0.01041667);
});
