/*
 * Plot optimizations: the public surface of server/driver/optimize.
 *
 * Original work for axya; distributed under AGPL-3.0. The modules re-exported
 * here are ported from nextdraw 1.7.5 and plotink; each file's header names
 * its source and license.
 *
 * All functions take a flat DocDigest and edit it in place:
 *   connectNearbyEnds(digest, min_gap, reordering)
 *   supersample(digest, tolerance)            // nextdraw passes curve_tolerance / 3
 *   randomizeStart(digest, seed)              // CPython-exact MT19937 (PyRandom)
 *   reorder(digest, reordering)
 * A layer's `+g` code overrides `reordering` for that layer.
 */

export {
  concatenatePaths,
  connectNearbyEnds,
  randomizeStart,
  reorder,
  supersample,
} from "./optimizations.ts";
export { PyRandom } from "./mt19937.ts";
export { RTreeIndex } from "./rtree.ts";
export type { BBox, Entry } from "./rtree.ts";
export { SpatialGrid } from "./spatialGrid.ts";
