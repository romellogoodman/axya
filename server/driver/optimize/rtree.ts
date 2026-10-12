/*
 * One-shot quadtree-style bounding-box index, used by path joining.
 *
 * Ported from plotink/rtree.py 1.2 (written by Michal Migurski),
 * docs/reference-apps/nextdraw-1.7.5/plotink/rtree.py.
 */
/*
 * Copyright (c) 2024 Windell H. Oskay, Bantam Tools. MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

import { pyMax, pyMin } from "../svg/pycompat.ts";

export type BBox = readonly [number, number, number, number]; // xmin, ymin, xmax, ymax
export type Entry = readonly [number, BBox];

const LEAF_SIZE = 16;
const DUPLICATION_LIMIT = 1.5;

export class RTreeIndex {
  bboxes: Entry[] = [];
  subtrees: RTreeIndex[] = [];
  xmin = Infinity;
  ymin = Infinity;
  xmax = -Infinity;
  ymax = -Infinity;

  constructor(bboxes: Entry[]) {
    let cx = 0;
    let cy = 0;
    const n = bboxes.length;
    for (const [, [xmin, ymin, xmax, ymax]] of bboxes) {
      cx += (xmin / 2 + xmax / 2) / n;
      cy += (ymin / 2 + ymax / 2) / n;
      this.xmin = pyMin(this.xmin, xmin);
      this.ymin = pyMin(this.ymin, ymin);
      this.xmax = pyMax(this.xmax, xmax);
      this.ymax = pyMax(this.ymax, ymax);
    }
    if (n <= LEAF_SIZE) {
      this.bboxes = bboxes;
      return;
    }
    // A bbox goes into every quadrant it touches, center lines included.
    const sub: Entry[][] = [
      bboxes.filter(([, [x1, y1]]) => x1 <= cx && y1 <= cy),
      bboxes.filter(([, [, y1, x2]]) => x2 >= cx && y1 <= cy),
      bboxes.filter(([, [x1, , , y2]]) => x1 <= cx && y2 >= cy),
      bboxes.filter(([, [, , x2, y2]]) => x2 >= cx && y2 >= cy),
    ];
    const lens = sub.map((s) => s.length);
    if (
      Math.max(...lens) === n ||
      lens.reduce((a, b) => a + b, 0) > DUPLICATION_LIMIT * n
    ) {
      this.bboxes = bboxes;
    } else {
      this.subtrees = sub.map((s) => new RTreeIndex(s));
    }
  }

  /** Ids of all boxes that intersect `bbox` (edges touching count). */
  intersection(bbox: BBox, ids: Set<number> = new Set()): Set<number> {
    const [x1, y1, x2, y2] = bbox;
    for (const [i, [xmin, ymin, xmax, ymax]] of this.bboxes) {
      const disjoint = x1 > xmax || y1 > ymax || x2 < xmin || y2 < ymin;
      if (!disjoint) ids.add(i);
    }
    for (const t of this.subtrees) {
      const disjoint = x1 > t.xmax || y1 > t.ymax || x2 < t.xmin || y2 < t.ymin;
      if (!disjoint) t.intersection(bbox, ids);
    }
    return ids;
  }
}
