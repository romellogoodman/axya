/*
 * Plot optimizations on a flat DocDigest: joining nearby path ends,
 * vertex supersampling, random start points for closed paths, and greedy
 * nearest-neighbor reordering.
 *
 * Ported from nextdrawcore/plot_optimizations.py 1.3.0 (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/plot_optimizations.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import type { DocDigest, PathItem } from "../digest/pathObjects.ts";
import * as plotUtils from "../svg/plotUtils.ts";
import type { Vertex } from "../svg/plotUtils.ts";
import { PyRandom } from "./mt19937.ts";
import { RTreeIndex } from "./rtree.ts";
import type { BBox, Entry } from "./rtree.ts";
import { SpatialGrid } from "./spatialGrid.ts";

/** Append second to first, dropping the junction vertex when the two are equal. */
export function concatenatePaths(first: PathItem, second: PathItem): PathItem {
  const a = first.subpaths[0];
  if (
    plotUtils.pointsEqual(
      first.lastPoint() as Vertex,
      second.firstPoint() as Vertex
    )
  ) {
    first.subpaths[0] = a.slice(0, -1).concat(second.subpaths[0]);
  } else {
    first.subpaths[0] = a.concat(second.subpaths[0]);
  }
  return first;
}

const sortedIds = (s: Set<number>) => [...s].sort((a, b) => a - b);

/**
 * connect_nearby_ends: join paths whose ends lie within minGap (disabled
 * when minGap < 0 or the layer's reordering is 4; reversal allowed for 2, 3).
 */
export function connectNearbyEnds(
  digest: DocDigest,
  minGap: number,
  reorderingType: number
): void {
  if (minGap < 0) return;
  const squareGap = minGap * minGap;
  const pointBounds = (p: Vertex): BBox => [
    p[0] - minGap,
    p[1] - minGap,
    p[0] + minGap,
    p[1] + minGap,
  ];

  for (const layer of digest.layers) {
    const local = layer.props.reorder ?? reorderingType;
    if (local === 4) continue;
    const reverse = local === 2 || local === 3;
    const paths = layer.paths;
    const count = paths.length;
    if (count < 2) continue;

    const entries: Entry[] = [
      ...paths.map((p, i): Entry => [i, pointBounds(p.firstPoint() as Vertex)]),
      ...paths.map((p, i): Entry => [
        i + count,
        pointBounds(p.lastPoint() as Vertex),
      ]),
    ];
    const index = new RTreeIndex(entries);
    const query = (p: Vertex) => sortedIds(index.intersection(pointBounds(p)));

    const consumed = new Set<number>();
    const newPaths: PathItem[] = [];
    let pathIndex = 0;
    while (consumed.size < count) {
      if (consumed.has(pathIndex)) {
        pathIndex += 1;
        continue;
      }
      consumed.add(pathIndex);
      let thisPath = paths[pathIndex];

      let pathEnd = thisPath.lastPoint() as Vertex;
      let endList = query(pathEnd);
      let pathStart = thisPath.firstPoint() as Vertex;
      let startList = query(pathStart);

      let tracing = true;
      while (tracing) {
        tracing = false;
        for (const hit of endList) {
          const next = hit % count;
          if (consumed.has(next)) continue;
          const pathNext = paths[next];
          if (
            plotUtils.pointsNear(
              pathEnd,
              pathNext.firstPoint() as Vertex,
              squareGap
            )
          ) {
            thisPath = concatenatePaths(thisPath, pathNext);
            pathEnd = pathNext.lastPoint() as Vertex;
            endList = query(pathEnd);
            consumed.add(next);
            tracing = true;
            break;
          }
          if (!reverse) continue;
          if (
            plotUtils.pointsNear(
              pathEnd,
              pathNext.lastPoint() as Vertex,
              squareGap
            )
          ) {
            pathEnd = pathNext.firstPoint() as Vertex;
            endList = query(pathEnd);
            pathNext.reverse();
            thisPath = concatenatePaths(thisPath, pathNext);
            consumed.add(next);
            tracing = true;
            break;
          }
        }
      }

      tracing = true;
      while (tracing) {
        tracing = false;
        for (const hit of startList) {
          const next = hit % count;
          if (consumed.has(next)) continue;
          const pathNext = paths[next];
          if (
            plotUtils.pointsNear(
              pathStart,
              pathNext.lastPoint() as Vertex,
              squareGap
            )
          ) {
            // nextdraw quirk: the joined path is the PathItem that was
            // prepended, so its id is kept (plot_optimizations.py:191).
            thisPath = concatenatePaths(pathNext, thisPath);
            pathStart = pathNext.firstPoint() as Vertex;
            startList = query(pathStart);
            consumed.add(next);
            tracing = true;
            break;
          }
          if (!reverse) continue;
          if (
            plotUtils.pointsNear(
              pathStart,
              pathNext.firstPoint() as Vertex,
              squareGap
            )
          ) {
            pathStart = pathNext.lastPoint() as Vertex;
            startList = query(pathStart);
            pathNext.reverse();
            thisPath = concatenatePaths(pathNext, thisPath);
            consumed.add(next);
            tracing = true;
            break;
          }
        }
      }
      newPaths.push(thisPath);
    }
    layer.paths = newPaths;
  }
}

/**
 * randomize_start: rotate each closed path (>= 3 vertices) to begin at a
 * random vertex, using Python's MT19937 seeded with `seed`.
 */
export function randomizeStart(
  digest: DocDigest,
  seed: number | bigint | null = null,
  rng: PyRandom = new PyRandom()
): void {
  rng.seed(seed);
  for (const layer of digest.layers) {
    for (const path of layer.paths) {
      const v = path.subpaths[0];
      if (v.length < 3) continue;
      if (path.closed()) {
        const r = rng.randrange(v.length - 1);
        // Shares vertex objects (the new first and last vertex are the same
        // array), exactly as the Python list slicing does.
        path.subpaths[0] = v.slice(r).concat(v.slice(1, r + 1));
      }
    }
  }
}

/** supersample: drop vertices within `tolerance` of a longer chord. */
export function supersample(digest: DocDigest, tolerance: number): void {
  if (tolerance <= 0) return;
  for (const layer of digest.layers) {
    for (const path of layer.paths)
      plotUtils.supersample(path.subpaths[0], tolerance);
  }
}

/**
 * reorder: greedy nearest-neighbor path order within each layer, starting
 * from (0, 0) for every layer (reordering 1; 2 and 3 also allow reversal).
 */
export function reorder(digest: DocDigest, reorderingType: number): void {
  for (const layer of digest.layers) {
    const local = layer.props.reorder ?? reorderingType;
    if (![1, 2, 3].includes(local)) continue;
    const reverse = local === 2 || local === 3;
    const available = layer.paths.length;
    if (available <= 1) continue;

    const endpoints = layer.paths.map((p) => [
      p.firstPoint() as Vertex,
      p.lastPoint() as Vertex,
    ]);
    const bins = reverse
      ? 4 + Math.floor(Math.sqrt(available / 25))
      : 4 + Math.floor(Math.sqrt(available / 50));
    const grid = new SpatialGrid(endpoints, bins, reverse);

    const tour: [number, boolean][] = [];
    let vertex: Vertex = [0, 0];
    for (;;) {
      let nearest = grid.nearest(vertex);
      if (nearest === null) break;
      let rev: boolean;
      if (nearest >= available) {
        nearest -= available;
        rev = true;
        vertex = endpoints[nearest][0];
      } else {
        rev = false;
        vertex = endpoints[nearest][1];
      }
      tour.push([nearest, rev]);
      grid.removePath(nearest);
    }

    const out: PathItem[] = [];
    for (const [n, rev] of tour) {
      const p = layer.paths[n];
      if (rev) p.reverse();
      out.push(p);
    }
    layer.paths = out;
  }
}
