/** DocDigest model operations (crop, rotate, plob I/O) against Python vectors. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import {
  DocDigest,
  LayerItem,
  PathItem,
  childElements,
  lxmlTag,
  pyAttrib,
} from "../server/driver/digest/pathObjects.ts";
import { randomizeStart } from "../server/driver/optimize/optimizations.ts";
import { VECTORS } from "./helpers/digestVectors.ts";

type Dump = [string, number[][]][][];

function build(dump: Dump, names?: string[]): DocDigest {
  const d = new DocDigest();
  d.flat = true;
  dump.forEach((paths, li) => {
    const layer = new LayerItem();
    layer.name = names ? names[li] : String(li);
    layer.item_id = String(li);
    if (names) layer.parseName();
    for (const [id, verts] of paths) {
      const p = new PathItem();
      p.item_id = id;
      p.subpaths = [structuredClone(verts)];
      layer.paths.push(p);
    }
    d.layers.push(layer);
  });
  return d;
}

interface CropCase {
  input: Dump;
  names: string[];
  seed: number;
  distance: number;
  layers: [string, Record<string, unknown>, [string, number[][]][]][];
}

test("crop (resume) after randomize_start, keeping vertex aliasing", () => {
  for (const [i, c] of (VECTORS.crop as CropCase[]).entries()) {
    // Rebuild the pre-randomized digest by re-running randomize_start from the
    // same seed on the dump's own (un-aliased) order is not possible, so the
    // input dump is the randomized state; recreate the alias that
    // randomize_start leaves (first and last vertex are one array) when closed.
    const d = build(c.input, c.names);
    for (const layer of d.layers) {
      for (const p of layer.paths) {
        const v = p.subpaths[0];
        if (v.length >= 3 && p.closed()) v[v.length - 1] = v[0];
      }
    }
    d.crop(c.distance);
    const got = d.layers.map((l) => [
      l.name,
      { ...l.props },
      l.paths.map((p): [string, number[][]] => [
        p.item_id,
        structuredClone(p.subpaths[0]),
      ]),
    ]);
    assert.deepStrictEqual(got, c.layers, `case ${i}`);
  }
});

test("randomize_start aliases the new first and last vertex", () => {
  const d = build([
    [
      [
        "a",
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    ],
  ]);
  randomizeStart(d, 3);
  const v = d.layers[0].paths[0].subpaths[0];
  assert.equal(v[0], v[v.length - 1]);
});

interface RotateCase {
  ccw: boolean;
  input: Dump;
  width: number;
  height: number;
  viewbox: string;
  subpaths: number[][][][][];
}

test("rotate (both directions; drops 1-vertex subpaths)", () => {
  for (const c of VECTORS.rotate as RotateCase[]) {
    const d = build(c.input);
    d.width = 6.0;
    d.height = 9.5;
    d.layers[0].paths[0].subpaths.push([[1.0, 2.0]]);
    d.rotate(c.ccw);
    assert.equal(d.width, c.width);
    assert.equal(d.height, c.height);
    assert.equal(d.viewbox, c.viewbox);
    assert.deepStrictEqual(
      d.layers.map((l) => l.paths.map((p) => p.subpaths)),
      c.subpaths
    );
  }
});

interface PlobCase {
  input: Dump;
  attrs: Record<string, string>;
  children: [
    string,
    Record<string, string>,
    [string, Record<string, string>][],
  ][];
  from_mm: string;
  reparsed: {
    width: number;
    height: number;
    viewbox: string;
    name: string;
    layers: [string, string | null, [string, number[][][]][]][];
  };
}

test("to_plob element tree", () => {
  const c = VECTORS.plob as PlobCase;
  const d = build(c.input);
  d.layers[0].name = "__digest-root__";
  d.layers[1].name = "3+s40+g2 pens";
  d.layers[1].parseName();
  d.width = 4.0;
  d.height = 3.0;
  d.viewbox = "0 0 4.000000 3.000000";
  d.name = "doc.svg";
  d.metadata.k = "v";
  const root = d.toPlob().documentElement as Element;
  assert.deepStrictEqual(pyAttrib(root), c.attrs);
  assert.deepStrictEqual(
    childElements(root).map((n) => [
      lxmlTag(n),
      pyAttrib(n),
      childElements(n).map((g) => [lxmlTag(g), pyAttrib(g)]),
    ]),
    c.children
  );
});

test("from_plob with unit rescaling", () => {
  const c = VECTORS.plob as PlobCase;
  const root = new DOMParser().parseFromString(c.from_mm, "text/xml")
    .documentElement as Element;
  const d = new DocDigest();
  d.fromPlob(root, 4.0, 3.0);
  assert.deepStrictEqual(
    {
      width: d.width,
      height: d.height,
      viewbox: d.viewbox,
      name: d.name,
      layers: d.layers.map((l) => [
        l.name,
        l.item_id,
        l.paths.map((p) => [p.item_id, p.subpaths]),
      ]),
    },
    c.reparsed
  );
});
