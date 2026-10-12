/*
 * Hidden-line removal: clip paths by the filled paths drawn above them, and
 * by the plot bounds.
 *
 * Ported from nextdrawcore/clipping.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/clipping.py.
 * clipping.py carries no notice of its own; nextdrawcore's is:
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Paths are kept in pyclipper's integer space (inches * 2^31). Subpaths and
 * their points are plain arrays shared by reference exactly where Python
 * shares lists, because adjust_horizontal_segments and _rejoin edit them in
 * place. Sets of path indices are CPython sets (clippingPyset.ts), since
 * their iteration order decides the order of split pieces.
 */

import { PathItem } from "./pathObjects.ts";
import type { LayerItem } from "./pathObjects.ts";
import { RTreeIndex } from "../optimize/rtree.ts";
import type { BBox, Entry } from "../optimize/rtree.ts";
import { pyMin } from "../svg/pycompat.ts";
import {
  CT_DIFFERENCE,
  CT_INTERSECTION,
  ClipperException,
  PFT_EVENODD,
  PFT_NONZERO,
  PT_CLIP,
  PT_SUBJECT,
  PyOverflowError,
  Pyclipper,
  cleanPolygon,
  scaleFromClipper,
  scaleToClipper,
} from "./clippingClipper.ts";
import { PySet } from "./clippingPyset.ts";

type Point = number[];
type Subpath = Point[];
type BBox4 = [number, number, number, number];

const FILL = "fill";
const STROKE = "stroke";
type PathType = typeof FILL | typeof STROKE;

/** Python's str(x).lower() for a style value (None prints as "None"). */
function strLower(x: string | null): string {
  return String(x ?? "None").toLowerCase();
}

/** _SpatialGrid (clipping.py:36-132): a 2D hash grid of bounding boxes. */
class SpatialGrid {
  private xmin = 0;
  private ymin = 0;
  private cell_w = 0;
  private cell_h = 0;
  private nx = 0;
  private ny = 0;
  private cells = new Map<number, PySet>();

  constructor(bboxes: BBox4[]) {
    if (!bboxes.length) return;

    let xmin = bboxes[0][0];
    let ymin = bboxes[0][1];
    let xmax = bboxes[0][2];
    let ymax = bboxes[0][3];
    for (const b of bboxes) {
      if (b[0] < xmin) xmin = b[0];
      if (b[1] < ymin) ymin = b[1];
      if (b[2] > xmax) xmax = b[2];
      if (b[3] > ymax) ymax = b[3];
    }

    const width = Math.max(xmax - xmin, 1);
    const height = Math.max(ymax - ymin, 1);
    const margin = Math.max(width, height) * 0.001 + 1;
    this.xmin = xmin - margin;
    this.ymin = ymin - margin;

    const totalW = width + 2 * margin;
    const totalH = height + 2 * margin;

    const dim = Math.max(4, Math.trunc(Math.sqrt(bboxes.length)));
    this.nx = dim;
    this.ny = dim;
    this.cell_w = totalW / dim;
    this.cell_h = totalH / dim;

    bboxes.forEach((bbox, idx) => this.doInsert(idx, bbox));
  }

  private cellRange(bbox: BBox4): BBox4 {
    const x0 = Math.trunc((bbox[0] - this.xmin) / this.cell_w);
    const y0 = Math.trunc((bbox[1] - this.ymin) / this.cell_h);
    const x1 = Math.trunc((bbox[2] - this.xmin) / this.cell_w);
    const y1 = Math.trunc((bbox[3] - this.ymin) / this.cell_h);
    const nx = this.nx - 1;
    const ny = this.ny - 1;
    return [
      Math.max(0, Math.min(x0, nx)),
      Math.max(0, Math.min(y0, ny)),
      Math.max(0, Math.min(x1, nx)),
      Math.max(0, Math.min(y1, ny)),
    ];
  }

  private doInsert(idx: number, bbox: BBox4): void {
    const [x0, y0, x1, y1] = this.cellRange(bbox);
    for (let cx = x0; cx <= x1; cx++) {
      const base = cx * this.ny;
      for (let cy = y0; cy <= y1; cy++) {
        const key = base + cy;
        const cell = this.cells.get(key);
        if (cell !== undefined) cell.add(idx);
        else this.cells.set(key, new PySet([idx]));
      }
    }
  }

  insert(idx: number, bbox: BBox4): void {
    if (this.nx > 0) this.doInsert(idx, bbox);
  }

  remove(idx: number, bbox: BBox4): void {
    if (this.nx === 0) return;
    const [x0, y0, x1, y1] = this.cellRange(bbox);
    for (let cx = x0; cx <= x1; cx++) {
      const base = cx * this.ny;
      for (let cy = y0; cy <= y1; cy++) {
        this.cells.get(base + cy)?.discard(idx);
      }
    }
  }

  query(bbox: BBox4): PySet {
    if (this.nx === 0) return new PySet();
    const [x0, y0, x1, y1] = this.cellRange(bbox);
    const result = new PySet();
    for (let cx = x0; cx <= x1; cx++) {
      const base = cx * this.ny;
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(base + cy);
        if (cell !== undefined) result.update(cell);
      }
    }
    return result;
  }
}

function bboxesOverlap(a: BBox4, b: BBox4): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/** ClipPathsProcess (clipping.py:135-391). NOTE: does not preserve stroke direction. */
export class ClipPathsProcess {
  /**
   * layers: ordered bottom to top. bounds: [[x_min, y_min], [x_max, y_max]].
   * Returns the layers, with their paths replaced.
   */
  run(
    layers: LayerItem[],
    bounds: number[][] | null = null,
    clipOn = true
  ): LayerItem[] {
    const extracted = this.extractPaths(layers);
    let paths = extracted[0];
    const layerDict = extracted[1];

    if (clipOn) {
      paths = ClipPathsProcess.clip(paths);
      // ANTI-FRAGMENTATION: flatten non-filled multi-subpath paths back into
      // separate path objects.
      paths = ClipPathsProcess.flattenNonfilledPaths(paths);
    }

    if (bounds !== null) {
      // clip using the boundary
      paths = ClippingPathItem.fromBounds(bounds).clipMany(paths);
      paths = ClipPathsProcess.flattenNonfilledPaths(paths);
    }

    return ClipPathsProcess.reconstructLayers(paths, layerDict, layers);
  }

  static clip(paths: ClippingPathItem[]): ClippingPathItem[] {
    if (paths.length <= 1) return [...paths];
    // The spatial grid wins for large counts; the list is faster for small ones.
    if (paths.length >= 500) return ClipPathsProcess.clipWithGrid(paths);
    return ClipPathsProcess.clipLinear(paths);
  }

  /** _clip_linear (clipping.py:187-234) */
  private static clipLinear(paths: ClippingPathItem[]): ClippingPathItem[] {
    let clippedPaths = [...paths];

    // bbox_cache is keyed by id(); every live path's entry is current, so
    // keying by object is equivalent.
    const bboxCache = new Map<ClippingPathItem, BBox4>();
    for (const p of clippedPaths) bboxCache.set(p, p.calculateBbox());

    let i = 1;
    while (i < clippedPaths.length) {
      if (clippedPaths[i].is_filled) {
        const clipper = clippedPaths[i];
        let clipperBbox = bboxCache.get(clipper);
        if (clipperBbox === undefined) clipperBbox = clipper.calculateBbox();

        const intersectingPathIds = new Set<number>();
        for (let j = 0; j < i; j++) {
          let cb = bboxCache.get(clippedPaths[j]);
          if (cb === undefined) {
            cb = clippedPaths[j].calculateBbox();
            bboxCache.set(clippedPaths[j], cb);
          }
          if (bboxesOverlap(clipperBbox, cb)) intersectingPathIds.add(j);
        }

        if (!intersectingPathIds.size) {
          i += 1;
          continue;
        }

        const returnedPaths = clipper.clipMany(
          clippedPaths.slice(0, i),
          intersectingPathIds
        );

        for (const p of returnedPaths) bboxCache.set(p, p.calculateBbox());

        clippedPaths = [...returnedPaths, ...clippedPaths.slice(i)];
        i = returnedPaths.length;
      }
      i += 1;
    }
    return clippedPaths;
  }

  /** _clip_with_grid (clipping.py:236-302) */
  private static clipWithGrid(paths: ClippingPathItem[]): ClippingPathItem[] {
    const allPaths = [...paths];
    const nOriginal = allPaths.length;

    // z_rank: original paths get rank = index; clipped results inherit the
    // minimum rank of their parents.
    const zRank: number[] = [];
    for (let k = 0; k < nOriginal; k++) zRank.push(k);

    const live = new Set<number>(zRank);

    const bboxCache = allPaths.map((p) => p.calculateBbox());

    const grid = new SpatialGrid(bboxCache);

    for (let i = 1; i < nOriginal; i++) {
      if (!live.has(i) || !allPaths[i].is_filled) continue;

      const clipperBbox = bboxCache[i];
      const myRank = zRank[i];

      const candidates = grid.query(clipperBbox);

      const intersectingIndices: number[] = [];
      for (const j of candidates) {
        if (j === i || !live.has(j)) continue;
        if (zRank[j] >= myRank) continue;
        if (bboxesOverlap(clipperBbox, bboxCache[j]))
          intersectingIndices.push(j);
      }

      if (!intersectingIndices.length) continue;

      // Only pass intersecting paths
      const intersectingPaths = intersectingIndices.map((j) => allPaths[j]);
      const allIds = new Set<number>(intersectingPaths.map((_, k) => k));
      const clippedResults = allPaths[i].clipMany(intersectingPaths, allIds);

      const minRank = Math.min(...intersectingIndices.map((j) => zRank[j]));
      for (const j of intersectingIndices) {
        live.delete(j);
        grid.remove(j, bboxCache[j]);
      }

      for (const result of clippedResults) {
        const newIdx = allPaths.length;
        allPaths.push(result);
        zRank.push(minRank);
        live.add(newIdx);
        const bbox = result.calculateBbox();
        bboxCache.push(bbox);
        grid.insert(newIdx, bbox);
      }
    }

    // Collect results in z-order
    const liveList = [...live].sort((a, b) => zRank[a] - zRank[b] || a - b);
    return liveList.map((idx) => allPaths[idx]);
  }

  /**
   * calculate_bounds (clipping.py:304-323). Returns physicalBounds' shallow
   * copy, clipped to the document when clipToPage.
   */
  static calculateBounds(
    physicalBounds: number[][],
    svgHeight: number,
    svgWidth: number,
    clipToPage = false,
    rotatePage = false
  ): number[][] {
    const docBounds = rotatePage
      ? [svgHeight + 1e-9, svgWidth + 1e-9]
      : [svgWidth + 1e-9, svgHeight + 1e-9];

    // nextdraw quirk: copy() is shallow, so clipping to the page also
    // lowers the caller's physical bounds, which nextdraw goes on to plot
    // with (nextdrawcore/clipping.py:319-322).
    const bounds = [...physicalBounds];
    if (clipToPage) {
      bounds[1][0] = pyMin(docBounds[0], bounds[1][0]); // x maximum
      bounds[1][1] = pyMin(docBounds[1], bounds[1][1]); // y maximum
    }
    return bounds;
  }

  /** _extract_paths (clipping.py:336-350) */
  private extractPaths(
    layers: LayerItem[]
  ): [ClippingPathItem[], Map<string, PathItem[]>] {
    const paths: (ClippingPathItem | null)[] = [];
    const layerDict = new Map<string, PathItem[]>();
    for (const layer of layers) {
      layerDict.set(layer.item_id, []);
      for (const path of layer.paths)
        paths.push(ClippingPathItem.fromPathItem(path, layer.item_id));
    }
    return [
      ClipPathsProcess.flattenNonfilledPaths(
        paths.filter((p): p is ClippingPathItem => p !== null)
      ),
      layerDict,
    ];
  }

  /** _reconstruct_layers (clipping.py:352-369) */
  private static reconstructLayers(
    paths: ClippingPathItem[],
    layerDict: Map<string, PathItem[]>,
    layers: LayerItem[]
  ): LayerItem[] {
    const pathIdCounts = new Map<string, number>();

    for (const path of paths) {
      const list =
        path.layer_id === false ? undefined : layerDict.get(path.layer_id);
      if (list !== undefined) {
        const id = (path.path_item as PathItem).item_id;
        pathIdCounts.set(id, (pathIdCounts.get(id) ?? 0) + 1);
        list.push(path.toPathItem(pathIdCounts.get(id)) as PathItem);
      }
    }
    // nextdraw quirk: layers sharing an item_id share one path list
    // (nextdrawcore/clipping.py:341, :367).
    for (const layer of layers)
      layer.paths = layerDict.get(layer.item_id) as PathItem[];

    return layers;
  }

  /** _flatten_nonfilled_paths (clipping.py:371-391) */
  static flattenNonfilledPaths(paths: ClippingPathItem[]): ClippingPathItem[] {
    const newPaths: ClippingPathItem[] = [];
    for (const path of paths) {
      if (path.is_filled) {
        // cannot be flattened
        newPaths.push(path);
        continue;
      }

      if (path.subpaths.length === 1) {
        newPaths.push(path);
        continue;
      }

      for (const subpath of path.subpaths) {
        newPaths.push(
          ClippingPathItem.fromCpath(path, [subpath], path.is_stroked, false)
        );
      }
    }
    return newPaths;
  }
}

/** _ClippingPathItem_pyclipper (clipping.py:427-990) */
export class ClippingPathItem {
  static readonly fill_rule_map = new Map<string | null, number>([
    [null, PFT_NONZERO], // default
    ["nonzero", PFT_NONZERO],
    ["evenodd", PFT_EVENODD],
  ]);

  path_item: PathItem | "bounds";
  layer_id: string | false;
  subpaths: Subpath[];
  is_stroked: boolean;
  is_filled: boolean;
  clip_op: number;
  /** Set only when filled; null where Python passes fill_rule=None. */
  fill_rule?: number | null;

  /** Do not use this constructor directly; use the static from* methods. */
  constructor(
    pathItem: PathItem | "bounds",
    layerId: string | false,
    subpaths: Subpath[],
    isStroked: boolean,
    isFilled: boolean,
    opts: { clip_op?: number; fill_rule?: number | null } = {}
  ) {
    this.path_item = pathItem;
    this.layer_id = layerId;
    this.subpaths = subpaths;
    this.is_stroked = isStroked;
    this.is_filled = isFilled;

    this.clip_op = "clip_op" in opts ? (opts.clip_op as number) : CT_DIFFERENCE;

    const fillRule = "fill_rule" in opts ? opts.fill_rule : PFT_NONZERO;
    if (this.is_filled) this.fill_rule = fillRule;

    this.adjustHorizontalSegments();
  }

  /**
   * adjust_horizontal_segments (clipping.py:456-471): bump the second point
   * of each horizontal segment by +/-1 unit, in place.
   */
  adjustHorizontalSegments(): void {
    let epsilon = 1;
    for (const subpath of this.subpaths) {
      let i = 1;
      while (i < subpath.length) {
        if (subpath[i][1] === subpath[i - 1][1]) {
          subpath[i] = [subpath[i][0], subpath[i][1] + epsilon]; // bump y
          epsilon *= -1; // flip epsilon sign to avoid accumulation
        }
        i += 1;
      }
    }
  }

  /** calculate_bbox (clipping.py:473-511): (xmin, ymin, xmax, ymax) in clipper space. */
  calculateBbox(subpathIndex: number | null = null): BBox4 {
    if (!this.subpaths.length) return [0, 0, 0, 0];

    const subpathsToProcess =
      subpathIndex !== null ? [this.subpaths[subpathIndex]] : this.subpaths;

    // nextdraw quirk: an empty first subpath gives (0, 0, 0, 0) for the
    // whole path (nextdrawcore/clipping.py:490-492).
    const firstSubpath = subpathsToProcess[0];
    if (!firstSubpath.length) return [0, 0, 0, 0];

    const firstPoint = firstSubpath[0];
    let xmin = firstPoint[0];
    let xmax = firstPoint[0];
    let ymin = firstPoint[1];
    let ymax = firstPoint[1];

    for (const subpath of subpathsToProcess) {
      for (const point of subpath) {
        const x = point[0];
        const y = point[1];
        if (x < xmin) xmin = x;
        else if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        else if (y > ymax) ymax = y;
      }
    }
    return [xmin, ymin, xmax, ymax];
  }

  static bboxesIntersect(bbox1: BBox4, bbox2: BBox4): boolean {
    const [x1Min, y1Min, x1Max, y1Max] = bbox1;
    const [x2Min, y2Min, x2Max, y2Max] = bbox2;
    if (x1Max < x2Min || x2Max < x1Min) return false;
    if (y1Max < y2Min || y2Max < y1Min) return false;
    return true;
  }

  /** are_subpaths_independent (clipping.py:527-560): fewer than 5% of subpath bbox pairs overlap. */
  areSubpathsIndependent(): boolean {
    if (this.subpaths.length <= 1) return true;

    const bboxes = this.subpaths.map((_, i) => this.calculateBbox(i));

    let overlapCount = 0;
    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        if (ClippingPathItem.bboxesIntersect(bboxes[i], bboxes[j]))
          overlapCount += 1;
      }
    }

    const totalPairs = (bboxes.length * (bboxes.length - 1)) / 2;
    const overlapRatio = totalPairs > 0 ? overlapCount / totalPairs : 0;
    return overlapRatio < 0.05;
  }

  createSingleSubpathClipper(subpathIdx: number): ClippingPathItem {
    return ClippingPathItem.fromCpath(
      this,
      [this.subpaths[subpathIdx]],
      false,
      true
    );
  }

  /** from_path_item (clipping.py:571-589) */
  static fromPathItem(
    pathItem: PathItem,
    layerId: string
  ): ClippingPathItem | null {
    let fillRule: number | null = null;
    if (pathItem.fill) {
      const rule = ClippingPathItem.fill_rule_map.get(pathItem.fill_rule);
      if (rule === undefined)
        throw new Error(`KeyError: ${JSON.stringify(pathItem.fill_rule)}`);
      fillRule = rule;
    }

    let subpaths: Subpath[];
    try {
      subpaths = scaleToClipper(pathItem.subpaths);
    } catch (err) {
      // An infinite coordinate, or one of 2^32 inches or more: the path is
      // dropped (its warning is logged below the logger's level).
      if (err instanceof PyOverflowError) return null;
      throw err;
    }

    const isFilled = strLower(pathItem.fill) !== "none";

    return new ClippingPathItem(
      pathItem,
      layerId,
      subpaths,
      pathItem.hasStroke(),
      isFilled,
      { fill_rule: fillRule }
    );
  }

  /** from_cpath (clipping.py:591-597): fill_rule and clip_op revert to their defaults. */
  static fromCpath(
    cpath: ClippingPathItem,
    subpaths: Subpath[],
    isStroked: boolean,
    isFilled: boolean
  ): ClippingPathItem {
    return new ClippingPathItem(
      shallowCopy(cpath.path_item),
      cpath.layer_id,
      subpaths,
      isStroked,
      isFilled
    );
  }

  /** from_bounds (clipping.py:599-612) */
  static fromBounds(bounds: number[][]): ClippingPathItem {
    const [[xMin, yMin], [xMax, yMax]] = bounds;
    const rect = [
      [xMin, yMin],
      [xMax, yMin],
      [xMax, yMax],
      [xMin, yMax],
      [xMin, yMin],
    ];
    const subpaths = scaleToClipper([rect]);
    return new ClippingPathItem("bounds", false, subpaths, false, true, {
      clip_op: CT_INTERSECTION,
    });
  }

  /** to_path_item (clipping.py:614-631) */
  toPathItem(itemIdCount = 1): PathItem | null {
    if (this.layer_id === false) return null;
    const source = this.path_item as PathItem;
    const pathItem = shallowCopy(source);
    pathItem.subpaths = scaleFromClipper(this.subpaths);
    pathItem.fill = this.is_filled ? source.fill : null;
    pathItem.fill_rule = this.is_filled ? source.fill_rule : null;
    pathItem.stroke = this.is_stroked ? source.stroke : null;

    // use item_id_count to generate unique item_id's
    if (itemIdCount === 1) pathItem.item_id = source.item_id;
    else pathItem.item_id = `${source.item_id}_${itemIdCount}`;

    return pathItem;
  }

  /** clip_many (clipping.py:633-650): clip clippees using this path. */
  clipMany(
    clippees: ClippingPathItem[],
    intersectingPathIds: Set<number> | null = null
  ): ClippingPathItem[] {
    if (!clippees.length) return [];

    // Per-subpath clipping is safe when the clipper's subpaths are
    // independent (e.g. separate circles), not when they form holes.
    if (this.subpaths.length > 1 && this.areSubpathsIndependent())
      return this.clipManyPerSubpath(clippees);
    return this.clipManyAllSubpaths(clippees, intersectingPathIds);
  }

  /** _clip_many_all_subpaths (clipping.py:652-695) */
  private clipManyAllSubpaths(
    clippees: ClippingPathItem[],
    intersectingPathIds: Set<number> | null
  ): ClippingPathItem[] {
    // Only membership is used, so a JavaScript Set will do here.
    const ids = intersectingPathIds ?? this.findIntersectingClippees(clippees);

    const results: ClippingPathItem[] = [];

    // Process paths in original order to preserve ordering
    clippees.forEach((clippee, i) => {
      if (ids.has(i)) {
        if (clippee.is_filled) results.push(...this.clipFilled(clippee));
        if (clippee.is_stroked) results.push(...this.clipStroked(clippee));
      } else if (this.clip_op === CT_DIFFERENCE) {
        // Hidden-line removal keeps non-intersecting paths; bounds clipping
        // (CT_INTERSECTION) drops them.
        if (clippee.is_filled && clippee.is_stroked) {
          results.push(
            ClippingPathItem.fromCpath(clippee, clippee.subpaths, false, true)
          );
          results.push(
            ClippingPathItem.fromCpath(clippee, clippee.subpaths, true, false)
          );
        } else results.push(clippee);
      }
    });

    return results;
  }

  /** _find_intersecting_clippees (clipping.py:697-719) */
  private findIntersectingClippees(clippees: ClippingPathItem[]): Set<number> {
    const clipperBboxes: BBox4[] = [];
    this.subpaths.forEach((sp, i) => {
      if (sp.length) clipperBboxes.push(this.calculateBbox(i));
    });

    const ids = new Set<number>();
    clippees.forEach((clippee, pathIdx) => {
      for (let s = 0; s < clippee.subpaths.length; s++) {
        if (!clippee.subpaths[s].length) continue;
        const [xmin, ymin, xmax, ymax] = clippee.calculateBbox(s);
        if (
          clipperBboxes.some(
            ([x1, y1, x2, y2]) =>
              !(x1 > xmax || y1 > ymax || x2 < xmin || y2 < ymin)
          )
        ) {
          ids.add(pathIdx);
          break;
        }
      }
    });
    return ids;
  }

  /** _clip_many_per_subpath (clipping.py:721-859) */
  private clipManyPerSubpath(clippees: ClippingPathItem[]): ClippingPathItem[] {
    // Build a spatial index of clippee subpaths once
    let subpathId = 0;
    const idToPathIdx = new Map<number, number>();
    const spatialIndexData: Entry[] = [];

    clippees.forEach((clippee, pathIdx) => {
      for (let s = 0; s < clippee.subpaths.length; s++) {
        if (!clippee.subpaths[s].length) continue;
        const bbox = clippee.calculateBbox(s);
        spatialIndexData.push([subpathId, bbox]);
        idToPathIdx.set(subpathId, pathIdx);
        subpathId += 1;
      }
    });

    const spatialIndex = new RTreeIndex(spatialIndexData);

    // Python dict; only its keys' membership and sorted order matter.
    const clippeeMap = new Map<number, ClippingPathItem>();
    clippees.forEach((c, i) => clippeeMap.set(i, c));

    let nextSplitId = -1; // monotonic counter for split-path IDs

    // Process each clipper subpath separately
    for (let c = 0; c < this.subpaths.length; c++) {
      if (!this.subpaths[c].length) continue;

      const clipperSubpathBbox = this.calculateBbox(c);
      const intersectingSubpathIds = rtreeIntersection(
        spatialIndex,
        clipperSubpathBbox
      );

      if (!intersectingSubpathIds.size) continue;
      const intersectingPathIds = new PySet();
      for (const sid of intersectingSubpathIds)
        intersectingPathIds.add(idToPathIdx.get(sid) as number);

      const singleClipper = this.createSingleSubpathClipper(c);

      // Clip only the intersecting paths by this single subpath. The
      // iteration order of the set decides the split pieces' ids.
      const newClippeeMap = new Map<number, ClippingPathItem>();
      for (const clippeeId of intersectingPathIds) {
        const clippee = clippeeMap.get(clippeeId);
        if (clippee === undefined) continue; // already fully clipped

        let clippedResults: ClippingPathItem[] = [];
        if (clippee.is_filled)
          clippedResults = singleClipper.clipFilled(clippee);
        if (clippee.is_stroked) {
          const strokedResults = singleClipper.clipStroked(clippee);
          if (clippedResults.length) clippedResults.push(...strokedResults);
          else clippedResults = strokedResults;
        }

        const numResults = clippedResults.length;
        if (numResults >= 1) {
          newClippeeMap.set(clippeeId, clippedResults[0]);
          for (const extra of clippedResults.slice(1)) {
            newClippeeMap.set(nextSplitId, extra);
            nextSplitId -= 1;
          }
        }
      }

      for (const clippeeId of intersectingPathIds) {
        const replacement = newClippeeMap.get(clippeeId);
        if (replacement !== undefined) clippeeMap.set(clippeeId, replacement);
        else clippeeMap.delete(clippeeId); // fully clipped
      }

      for (const [clippeeId, clippee] of newClippeeMap) {
        if (clippeeId < 0) clippeeMap.set(clippeeId, clippee);
      }
    }

    // Original paths in order, then split pieces (most negative id first)
    const keys = [...clippeeMap.keys()];
    const positiveIds = keys.filter((k) => k >= 0).sort((a, b) => a - b);
    const negativeIds = keys.filter((k) => k < 0).sort((a, b) => a - b);
    const results: ClippingPathItem[] = [];
    for (const i of [...positiveIds, ...negativeIds]) {
      const clippee = clippeeMap.get(i) as ClippingPathItem;
      if (clippee.is_filled && clippee.is_stroked) {
        // A path that was never clipped: split into filled-only and stroked-only.
        results.push(
          ClippingPathItem.fromCpath(clippee, clippee.subpaths, false, true)
        );
        results.push(
          ClippingPathItem.fromCpath(clippee, clippee.subpaths, true, false)
        );
      } else results.push(clippee);
    }
    return results;
  }

  clipFilled(clippee: ClippingPathItem): ClippingPathItem[] {
    return this.clip(clippee, FILL, completeTheLoop);
  }

  clipStroked(clippee: ClippingPathItem): ClippingPathItem[] {
    return this.clip(clippee, STROKE, rejoin);
  }

  /** clip (clipping.py:870-895): all results grouped into one multi-subpath path. */
  private clip(
    clippee: ClippingPathItem,
    pathType: PathType,
    postclipProcess: (paths: Subpath[]) => Subpath[]
  ): ClippingPathItem[] {
    // use a dummy fill rule if clippee is not filled
    const clippeeFillRule = clippee.is_filled
      ? (clippee.fill_rule as number | null)
      : PFT_NONZERO;

    let results = this.usePyclipperToClip(clippee, clippeeFillRule, pathType);
    results = postclipProcess(results);

    if (results.length === 0) return [];

    return [
      ClippingPathItem.fromCpath(
        clippee,
        results,
        pathType === STROKE,
        pathType === FILL
      ),
    ];
  }

  /** _use_pyclipper_to_clip (clipping.py:897-922) */
  private usePyclipperToClip(
    clippee: ClippingPathItem,
    clippeeFillRule: number | null,
    pathType: PathType
  ): Subpath[] {
    try {
      const pclip = new Pyclipper();
      // pyclipper requires clippers to be "closed", so closed=True even for
      // open, filled paths
      pclip.AddPaths(this.subpaths, PT_CLIP, true);
      pclip.AddPaths(clippee.subpaths, PT_SUBJECT, pathType === FILL);
      // Cython converts None to a PolyFillType with a TypeError, which
      // nextdraw does not catch.
      if (clippeeFillRule === null || this.fill_rule == null)
        throw new TypeError("an integer is required");
      return pclip.execute2Paths(this.clip_op, clippeeFillRule, this.fill_rule);
    } catch (err) {
      if (!(err instanceof ClipperException)) throw err;
      // pyclipper does not handle paths of length zero; nextdraw then keeps
      // the clippee's subpaths (the same lists) unclipped. Its warning is
      // logged below the logger's level, so is never shown.
      return [...clippee.subpaths];
    }
  }

  /** __repr__-style summary, for debugging. */
  toString(): string {
    const source =
      typeof this.path_item === "string"
        ? this.path_item
        : this.path_item.item_id;
    return `ClippingPathItem(source=${source}, layer_id=${this.layer_id}, is_stroked=${this.is_stroked}, is_filled=${this.is_filled})`;
  }
}

/** Python's copy(obj) for a PathItem (or the "bounds" string). */
function shallowCopy<T extends PathItem | "bounds">(item: T): T {
  if (typeof item === "string") return item;
  return Object.assign(new PathItem(), item) as T;
}

/**
 * rtree.Index.intersection as a CPython set: ids.add() per leaf entry,
 * then ids |= subtree result, as plotink/rtree.py builds it.
 */
function rtreeIntersection(index: RTreeIndex, bbox: BBox): PySet {
  const ids = new PySet();
  const [x1, y1, x2, y2] = bbox;
  for (const [i, [xmin, ymin, xmax, ymax]] of index.bboxes) {
    const disjoint = x1 > xmax || y1 > ymax || x2 < xmin || y2 < ymin;
    if (!disjoint) ids.add(i);
  }
  for (const t of index.subtrees) {
    const disjoint = x1 > t.xmax || y1 > t.ymax || x2 < t.xmin || y2 < t.ymin;
    if (!disjoint) ids.update(rtreeIntersection(t, bbox));
  }
  return ids;
}

/**
 * _complete_the_loop (clipping.py:924-930): pyclipper drops a closed
 * path's repeated last point; PathItem states it.
 */
function completeTheLoop(paths: Subpath[]): Subpath[] {
  const cleaned = paths.map((path) =>
    path.length > 2 ? cleanPolygon(path) : path
  );
  return cleaned.map((path) => [...path, ...path.slice(0, 1)]);
}

/**
 * _rejoin (clipping.py:932-976): join open paths whose ends meet (Y may be
 * off by one from the horizontal adjustment). Edits `paths` and reverses
 * its lists in place.
 */
function rejoin(paths: Subpath[]): Subpath[] {
  const almostEqual = (a: Point, b: Point): boolean => {
    if (a[0] !== b[0]) return false;
    if (Math.abs(a[1] - b[1]) > 1) return false;
    return true;
  };
  // path_a + path_b[1:]: avoid duplicate coordinates
  const join2 = (a: Subpath, b: Subpath): Subpath => [...a, ...b.slice(1)];

  let i = 0;
  while (i < paths.length) {
    let j = i + 1;
    while (j < paths.length) {
      let joined = true;
      const pi = paths[i];
      const pj = paths[j];
      if (almostEqual(pi[0], pj[0])) {
        pi.reverse();
        paths[i] = join2(pi, pj);
      } else if (almostEqual(pi[0], pj[pj.length - 1])) {
        paths[i] = join2(pj, pi);
      } else if (almostEqual(pi[pi.length - 1], pj[0])) {
        paths[i] = join2(pi, pj);
      } else if (almostEqual(pi[pi.length - 1], pj[pj.length - 1])) {
        pj.reverse();
        paths[i] = join2(pi, pj);
      } else joined = false;

      if (joined) paths.splice(j, 1);
      else j += 1;
    }
    i += 1;
  }
  return paths;
}
