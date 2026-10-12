/** MT19937 and the plot optimizations against Python reference vectors. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DocDigest,
  LayerItem,
  PathItem,
} from "../server/driver/digest/pathObjects.ts";
import { PyRandom } from "../server/driver/optimize/mt19937.ts";
import {
  connectNearbyEnds,
  randomizeStart,
  reorder,
  supersample,
} from "../server/driver/optimize/optimizations.ts";
import { RTreeIndex } from "../server/driver/optimize/rtree.ts";
import type { Entry } from "../server/driver/optimize/rtree.ts";
import { VECTORS } from "./helpers/digestVectors.ts";

type MtRow = [string, number[], number[], string[], number[]];

test("PyRandom matches CPython's random for int seeds", () => {
  for (const [seed, words, floats, big, ranges] of VECTORS.mt as MtRow[]) {
    const r = new PyRandom(BigInt(seed));
    assert.deepStrictEqual(
      words.map(() => Number(r.getrandbits(32))),
      words,
      `seed ${seed} words`
    );
    assert.deepStrictEqual(
      floats.map(() => r.random()),
      floats,
      `seed ${seed} random()`
    );
    assert.deepStrictEqual(
      [1, 7, 31, 33, 64, 65].map((k) => r.getrandbits(k).toString()),
      big,
      `seed ${seed} getrandbits`
    );
    assert.deepStrictEqual(
      [1, 2, 3, 10, 99, 1000, 2 ** 31 - 1, 2 ** 32 + 1].map((n) =>
        r.randrange(n)
      ),
      ranges,
      `seed ${seed} randrange`
    );
  }
  const r = new PyRandom(170000000000);
  const long = VECTORS.mt_long as number[];
  assert.deepStrictEqual(
    long.map(() => Number(r.getrandbits(32))),
    long,
    "1500 words (crosses two state regenerations)"
  );
});

type Dump = [string, number[][]][][];
interface OptCase {
  input: Dump;
  gap: number;
  reordering: number;
  seed: number | null;
  joined: Dump;
  supersampled: Dump;
  randomized: Dump;
  reordered: Dump;
}

function build(dump: Dump): DocDigest {
  const d = new DocDigest();
  d.flat = true;
  dump.forEach((paths, li) => {
    const layer = new LayerItem();
    layer.name = String(li);
    layer.item_id = String(li);
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

const dump = (d: DocDigest): Dump =>
  d.layers.map((l) =>
    l.paths.map((p): [string, number[][]] => [p.item_id, p.subpaths[0]])
  );

test("connect_nearby_ends, supersample, randomize_start, reorder", () => {
  for (const [i, c] of (VECTORS.optimize as OptCase[]).entries()) {
    const d = build(c.input);
    connectNearbyEnds(d, c.gap, c.reordering);
    assert.deepStrictEqual(dump(d), c.joined, `case ${i} joined`);
    supersample(d, 0.002 / 3);
    assert.deepStrictEqual(dump(d), c.supersampled, `case ${i} supersampled`);
    if (c.seed !== null) randomizeStart(d, c.seed);
    assert.deepStrictEqual(dump(d), c.randomized, `case ${i} randomized`);
    reorder(d, c.reordering);
    assert.deepStrictEqual(dump(d), c.reordered, `case ${i} reordered`);
  }
});

test("rtree finds every touching box, splitting large nodes", () => {
  const entries: Entry[] = [];
  for (let i = 0; i < 200; i++) {
    const x = (i * 37) % 101;
    const y = (i * 53) % 89;
    entries.push([i, [x, y, x + 2, y + 2]]);
  }
  const index = new RTreeIndex(entries);
  assert.ok(index.subtrees.length === 4);
  const q = [10, 10, 30, 25] as const;
  const brute = entries
    .filter(
      ([, [a, b, c, e]]) => !(q[0] > c || q[1] > e || q[2] < a || q[3] < b)
    )
    .map(([i]) => i);
  assert.deepStrictEqual(
    [...index.intersection(q)].sort((a, b) => a - b),
    brute
  );
});
