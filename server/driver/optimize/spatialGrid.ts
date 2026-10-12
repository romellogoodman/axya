/*
 * Flat grid index for nearest-neighbor path-end search, used by reordering.
 *
 * Ported from plotink/spatial_grid.py 1.1,
 * docs/reference-apps/nextdraw-1.7.5/plotink/spatial_grid.py.
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

import { pyFloor, pyMax, pyMin } from "../svg/pycompat.ts";
import { squareDist } from "../svg/plotUtils.ts";
import type { Vertex } from "../svg/plotUtils.ts";

/** Entries are path ids: i for the start of path i, path_count + i for its end. */
export class SpatialGrid {
  grid: number[][] = [];
  adjacents: number[][] = [];
  lookup: number[] = [];
  path_count = 0;
  vertices: Vertex[][];
  reverse = false;
  bin_size_x = 1.0;
  bin_size_y = 1.0;
  xmin = -1.0;
  ymin = -1.0;
  bins_per_side = 3;

  /** `vertices` holds [first_vertex, last_vertex] for each path. */
  constructor(vertices: Vertex[][], binsPerSide: number, reverse: boolean) {
    this.vertices = vertices;
    this.reverse = reverse;
    this.bins_per_side = binsPerSide;
    this.path_count = vertices.length;
    const maxBin = binsPerSide - 1;
    this.findAdjacents();

    this.xmin = Infinity;
    this.ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    for (const [[x1, y1], [x2, y2]] of vertices) {
      this.xmin = pyMin(this.xmin, x1);
      xmax = pyMax(xmax, x1);
      this.ymin = pyMin(this.ymin, y1);
      ymax = pyMax(ymax, y1);
      if (reverse) {
        this.xmin = pyMin(this.xmin, x2);
        xmax = pyMax(xmax, x2);
        this.ymin = pyMin(this.ymin, y2);
        ymax = pyMax(ymax, y2);
      }
    }
    const shim = (xmax - this.xmin + ymax - this.ymin) / 200;
    this.xmin -= shim;
    this.ymin -= shim;
    xmax += shim;
    ymax += shim;
    this.bin_size_x = (xmax - this.xmin) / binsPerSide;
    this.bin_size_y = (ymax - this.ymin) / binsPerSide;

    this.lookup = new Array<number>(
      reverse ? 2 * this.path_count : this.path_count
    ).fill(0);
    this.grid = Array.from({ length: binsPerSide * binsPerSide }, () => []);

    vertices.forEach(([[x1, y1], [x2, y2]], i) => {
      let cell = this.cellOf(x1, y1, maxBin);
      this.grid[cell].push(i);
      this.lookup[i] = cell;
      if (reverse) {
        cell = this.cellOf(x2, y2, maxBin);
        this.grid[cell].push(this.path_count + i);
        this.lookup[this.path_count + i] = cell;
      }
    });
  }

  private cellOf(x: number, y: number, maxBin: number): number {
    // Python raises ZeroDivisionError when every endpoint coincides (bin size 0).
    if (this.bin_size_x === 0 || this.bin_size_y === 0) {
      throw new RangeError("float division by zero");
    }
    const xBin = pyMin(pyFloor((x - this.xmin) / this.bin_size_x), maxBin);
    const yBin = pyMin(pyFloor((y - this.ymin) / this.bin_size_y), maxBin);
    return xBin + this.bins_per_side * yBin;
  }

  findAdjacents(): void {
    const b = this.bins_per_side;
    const maxBin = b - 1;
    this.adjacents = Array.from({ length: b * b }, (_, i) => [i]);
    for (let row = 0; row < b; row++) {
      for (let col = 0; col < b; col++) {
        const i = col + row * b;
        const adj = this.adjacents[i];
        if (col > 0) {
          adj.push(i - 1);
          if (row > 0) adj.push(i - b - 1);
          if (row < maxBin) adj.push(i + b - 1);
        }
        if (col < maxBin) {
          adj.push(i + 1);
          if (row > 0) adj.push(i - b + 1);
          if (row < maxBin) adj.push(i + b + 1);
        }
        if (row > 0) adj.push(i - b);
        if (row < maxBin) adj.push(i + b);
      }
    }
  }

  private endpoint(pathIndex: number): Vertex {
    return pathIndex >= this.path_count
      ? this.vertices[pathIndex - this.path_count][1]
      : this.vertices[pathIndex][0];
  }

  /** Id of the path end nearest `v`, searching v's cell and its neighbors first. */
  nearest(v: Vertex): number | null {
    const maxBin = this.bins_per_side - 1;
    if (this.bin_size_x === 0 || this.bin_size_y === 0) {
      throw new RangeError("float division by zero");
    }
    const xBin = pyMax(
      pyMin(pyFloor((v[0] - this.xmin) / this.bin_size_x), maxBin),
      0
    );
    const yBin = pyMax(
      pyMin(pyFloor((v[1] - this.ymin) / this.bin_size_y), maxBin),
      0
    );
    const neighborhood =
      this.adjacents[xBin + this.bins_per_side * yBin].slice();

    let bestDist = Infinity;
    let best: number | null = null;
    for (const cell of neighborhood) {
      for (const idx of this.grid[cell]) {
        const d = squareDist(v, this.endpoint(idx));
        if (d < bestDist) {
          bestDist = d;
          best = idx;
        }
      }
    }
    // nextdraw quirk: `if best_index:` treats id 0 as "not found" and falls
    // through to the full scan, keeping best_dist (plotink/spatial_grid.py:217).
    if (best) return best;

    for (let cell = 0; cell < this.adjacents.length; cell++) {
      if (neighborhood.includes(cell)) continue;
      for (const idx of this.grid[cell]) {
        const d = squareDist(v, this.endpoint(idx));
        if (d < bestDist) {
          bestDist = d;
          best = idx;
        }
      }
    }
    return best;
  }

  /** Remove both ends of path `pathIndex` (< path_count) from the grid. */
  removePath(pathIndex: number): void {
    removeFirst(this.grid[this.lookup[pathIndex]], pathIndex);
    if (this.reverse) {
      const other = pathIndex + this.path_count;
      removeFirst(this.grid[this.lookup[other]], other);
    }
  }
}

function removeFirst(list: number[], value: number): void {
  const i = list.indexOf(value);
  if (i < 0) throw new RangeError("list.remove(x): x not in list");
  list.splice(i, 1);
}
