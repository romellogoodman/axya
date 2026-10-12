/**
 * Hidden-line removal (server/driver/digest/clipping.ts and its Clipper
 * port) reproduces nextdraw's clipping.py and pyclipper exactly. Vectors:
 * test/oracle/clipping_vectors.py (see its docstring for what they cover).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { ClipPathsProcess } from "../server/driver/digest/clipping.ts";
import {
  ClipperException,
  ClipperRangeError,
  PT_CLIP,
  PT_SUBJECT,
  PyOverflowError,
  PyValueError,
  Pyclipper,
  cleanPolygon,
  fma,
  scaleToClipper,
} from "../server/driver/digest/clippingClipper.ts";
import type { PyPath } from "../server/driver/digest/clippingClipper.ts";
import { PySet } from "../server/driver/digest/clippingPyset.ts";
import { LayerItem, PathItem } from "../server/driver/digest/pathObjects.ts";

interface PathSpec {
  item_id: string;
  fill: string | null;
  stroke: string | null;
  fill_rule: string | null;
  subpaths: number[][][];
}
interface LayerSpec {
  item_id: string;
  name: string;
  paths: PathSpec[];
}
type OutPath = [
  string,
  string | null,
  string | null,
  string | null,
  number[][][],
];
interface ProcessCase {
  layers: LayerSpec[];
  bounds: number[][] | null;
  clip_on: boolean;
  out?: { item_id: string; paths: OutPath[] }[];
  error?: string;
}
interface ClipperCase {
  clip: PyPath[];
  subj: PyPath[];
  closed: boolean;
  ct: number;
  sft: number;
  cft: number;
  out?: PyPath[];
  clean?: PyPath[];
  error?: string;
}
interface Vectors {
  process: ProcessCase[];
  clipper: ClipperCase[];
  pyset: { ops: [string, number | number[]][]; order: number[] }[];
  fma: [number, number, number, number][];
  boundary: ClipperCase[];
}

const V = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/clipping-vectors.json.gz", import.meta.url)
    )
  ).toString("utf8")
) as Vectors;

function toLayers(specs: LayerSpec[]): LayerItem[] {
  return specs.map((s) => {
    const layer = new LayerItem();
    layer.item_id = s.item_id;
    layer.name = s.name;
    layer.parseName();
    layer.paths = s.paths.map((p) =>
      PathItem.fromAttrs({
        subpaths: p.subpaths.map((sp) => sp.map((v) => [...v])),
        stroke: p.stroke,
        fill: p.fill,
        fill_rule: p.fill_rule,
        item_id: p.item_id,
      })
    );
    return layer;
  });
}

/** Python exception class name for an error the port throws. */
function pyErrorName(err: unknown): string {
  if (err instanceof TypeError) return "TypeError";
  if (err instanceof Error && err.message.startsWith("KeyError"))
    return "KeyError";
  throw err;
}

test("ClipPathsProcess.run matches clipping.py", () => {
  let grid = 0;
  for (const [n, c] of V.process.entries()) {
    let got: { item_id: string; paths: OutPath[] }[] | undefined;
    let error: string | undefined;
    try {
      const layers = new ClipPathsProcess().run(
        toLayers(c.layers),
        c.bounds,
        c.clip_on
      );
      got = layers.map((l) => ({
        item_id: l.item_id,
        paths: l.paths.map((p): OutPath => [
          p.item_id,
          p.stroke,
          p.fill,
          p.fill_rule,
          p.subpaths,
        ]),
      }));
    } catch (err) {
      error = pyErrorName(err);
    }
    assert.equal(error, c.error, `case ${n}: error`);
    if (c.out) assert.deepStrictEqual(got, c.out, `case ${n}`);
    if (c.layers.some((l) => l.paths.length >= 500)) grid++;
  }
  assert.ok(grid >= 3, "spatial-grid cases present");
});

function checkClipperCases(cases: ClipperCase[]): void {
  for (const [n, c] of cases.entries()) {
    try {
      const pc = new Pyclipper();
      pc.AddPaths(c.clip, PT_CLIP, true);
      pc.AddPaths(c.subj, PT_SUBJECT, c.closed);
      const out = pc.execute2Paths(c.ct, c.sft, c.cft);
      assert.equal(c.error, undefined, `case ${n}: pyclipper raised`);
      assert.deepStrictEqual(out, c.out, `case ${n}: Execute2`);
      assert.deepStrictEqual(
        out.map((p) => cleanPolygon(p)),
        c.clean,
        `case ${n}: CleanPolygon`
      );
    } catch (err) {
      if (!(err instanceof ClipperException)) throw err;
      assert.equal(err.message, c.error, `case ${n}`);
    }
  }
}

test("Pyclipper Execute2 and CleanPolygon match pyclipper 1.4.0", () => {
  checkClipperCases(V.clipper);
});

test("PySet iterates in CPython's order", () => {
  for (const [n, c] of V.pyset.entries()) {
    const s = new PySet();
    for (const [op, arg] of c.ops) {
      if (op === "a") s.add(arg as number);
      else if (op === "d") s.discard(arg as number);
      else {
        const other = new PySet();
        for (const k of arg as number[]) other.add(k);
        s.update(other);
      }
    }
    assert.deepEqual([...s], c.order, `case ${n}`);
  }
});

test("fma rounds once, as math.fma does", () => {
  for (const [a, b, c, want] of V.fma) {
    assert.ok(Object.is(fma(a, b, c), want), `fma(${a}, ${b}, ${c})`);
  }
});

test("coordinates: exact up to 2^52 - 1 in clipper space, refused beyond", () => {
  // pyclipper accepts |v| <= 2^62 - 1; the port computes exactly only to
  // 2^52 - 1 and refuses more. nextdraw scales inches by 2^31, so that is
  // |coordinate| < 2^21 inches.
  checkClipperCases(V.boundary);
  const edge = 2 ** 52 - 1;
  const tri = (s: number): PyPath[] => [
    [
      [0, 0],
      [s, 0],
      [0, 1],
    ],
  ];
  new Pyclipper().AddPaths(tri(edge), PT_CLIP, true);
  new Pyclipper().AddPaths(tri(-edge), PT_CLIP, true);
  assert.throws(
    () => new Pyclipper().AddPaths(tri(edge + 1), PT_CLIP, true),
    ClipperRangeError
  );
  assert.throws(
    () => new Pyclipper().AddPaths(tri(-edge - 1), PT_CLIP, true),
    ClipperRangeError
  );
  // scale_to_clipper: NaN raises ValueError (nextdraw crashes); infinity
  // and 2^63 or more raise OverflowError (nextdraw drops the path).
  assert.throws(() => scaleToClipper([[[NaN, 0]]]), PyValueError);
  assert.throws(() => scaleToClipper([[[2 ** 32, 0]]]), PyOverflowError);
  assert.throws(() => scaleToClipper([[[1e300, 0]]]), PyOverflowError);
  assert.deepStrictEqual(scaleToClipper([[[-(2 ** 32), -0, -1e-12]]]), [
    [[-(2 ** 63), 0, 0]],
  ]);
  // In inches: 2^21 scales to 2^52 (refused); the next double down is in.
  assert.deepStrictEqual(scaleToClipper([[[2 ** 21, -(2 ** 21)]]]), [
    [[2 ** 52, -(2 ** 52)]],
  ]);
  const inches = (x: number) =>
    scaleToClipper([
      [
        [0, 0],
        [x, 0],
        [0, 1],
      ],
    ]);
  assert.throws(
    () => new Pyclipper().AddPaths(inches(2 ** 21), PT_CLIP, true),
    ClipperRangeError
  );
  new Pyclipper().AddPaths(inches(2 ** 21 - 2 ** -32), PT_CLIP, true);
});

test("calculateBounds: clip_to_page lowers the caller's bounds too (shallow copy)", () => {
  // Values from nextdraw's ClipPathsProcess.calculate_bounds.
  const phys = [
    [-1e-9, -1e-9],
    [11.810000001, 8.580000001],
  ];
  const b = ClipPathsProcess.calculateBounds(
    phys,
    3.937007874015748,
    5.905511811023622,
    true,
    false
  );
  assert.deepStrictEqual(b, [
    [-1e-9, -1e-9],
    [5.905511812023622, 3.9370078750157482],
  ]);
  assert.notEqual(b, phys);
  assert.equal(b[1], phys[1]);
  const rotated = [
    [-1e-9, -1e-9],
    [11.810000001, 8.580000001],
  ];
  ClipPathsProcess.calculateBounds(rotated, 6.0, 4.0, true, true);
  assert.deepStrictEqual(rotated[1], [6.000000001, 4.000000001]);
  const unclipped = [
    [-1e-9, -1e-9],
    [11.810000001, 8.580000001],
  ];
  ClipPathsProcess.calculateBounds(unclipped, 6.0, 4.0, false, true);
  assert.deepStrictEqual(unclipped[1], [11.810000001, 8.580000001]);
});
