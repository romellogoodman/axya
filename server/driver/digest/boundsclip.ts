/*
 * Clip a flattened digest at the plot boundaries.
 *
 * Ported from nextdrawcore/boundsclip.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/boundsclip.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { clipSegment, pointInBounds } from "../svg/plotUtils.ts";
import type { BoundsRect, Vertex } from "../svg/plotUtils.ts";
import type { DocDigest } from "./pathObjects.ts";

/**
 * clip_at_bounds: clip every path at [phyBounds[0], min(phyBounds[1],
 * docBounds)] (docBounds only when docClip), splitting paths that leave and
 * re-enter. Flattens the digest first. Returns true when travel past the
 * physical limits (by more than warnTol, in +X or +Y) was clipped.
 */
export function clipAtBounds(
  digest: DocDigest,
  phyBounds: BoundsRect,
  docBounds: number[],
  warnTol: number,
  docClip = true
): boolean {
  let clipWarnX = true;
  let clipWarnY = true;
  let outOfBounds = false;
  let [xMax, yMax] = phyBounds[1];
  if (docClip) {
    const [pageMaxX, pageMaxY] = docBounds;
    if (xMax >= pageMaxX) {
      clipWarnX = false;
      xMax = pageMaxX;
    }
    if (yMax >= pageMaxY) {
      clipWarnY = false;
      yMax = pageMaxY;
    }
  }
  const clipBounds = [phyBounds[0], [xMax, yMax]];
  const xMaxWarn = xMax + warnTol;
  const yMaxWarn = yMax + warnTol;

  digest.flatten();

  for (const layer of digest.layers) {
    for (const path of layer.paths) {
      const input = path.subpaths[0];
      const newSubpaths: Vertex[][] = [];
      let sub: Vertex[] = [];
      let first = true;
      let prevIn = false;
      let prevVertex: Vertex = [];

      for (const vertex of input) {
        const [vX, vY] = vertex;
        let inBounds = pointInBounds(vertex, clipBounds, 0);
        if (!inBounds && !outOfBounds) {
          if (clipWarnX && vX > xMaxWarn) outOfBounds = true;
          if (clipWarnY && vY > yMaxWarn) outOfBounds = true;
        }
        if (first) {
          if (inBounds) sub.push(vertex);
        } else if (inBounds && prevIn) {
          sub.push(vertex);
        } else {
          const [accept, seg] = clipSegment([prevVertex, vertex], clipBounds);
          if (accept) {
            if (inBounds && !prevIn) {
              if (sub.length > 0) {
                newSubpaths.push(sub);
                sub = [];
              }
              sub.push([seg[0][0], seg[0][1]]);
              sub.push([seg[1][0], seg[1][1]]);
            }
            if (prevIn && !inBounds) {
              sub.push([seg[1][0], seg[1][1]]);
              newSubpaths.push(sub);
              sub = [];
            }
            if (!prevIn && !inBounds) {
              if (sub.length > 0) {
                newSubpaths.push(sub);
                sub = [];
              }
              sub.push([seg[0][0], seg[0][1]]);
              sub.push([seg[1][0], seg[1][1]]);
              newSubpaths.push(sub);
              sub = [];
            }
          } else {
            inBounds = false;
          }
        }
        first = false;
        prevVertex = vertex;
        prevIn = inBounds;
      }
      if (sub.length > 0) newSubpaths.push(sub);
      path.subpaths = newSubpaths;
    }
    layer.flatten();
  }
  return outOfBounds;
}

/** What get_clip_bounds needs from the NextDraw object. */
export interface ClipBoundsContext {
  rotate_page: boolean;
  svg_width: number;
  svg_height: number;
  bounds: BoundsRect;
  clip_to_page: boolean;
}

/** get_clip_bounds: the effective clipping rectangle. */
export function getClipBounds(ctx: ClipBoundsContext): BoundsRect {
  const docBounds = ctx.rotate_page
    ? [ctx.svg_height, ctx.svg_width]
    : [ctx.svg_width, ctx.svg_height];
  let [xMax, yMax] = ctx.bounds[1];
  if (ctx.clip_to_page) {
    if (xMax >= docBounds[0]) xMax = docBounds[0];
    if (yMax >= docBounds[1]) yMax = docBounds[1];
  }
  return [ctx.bounds[0], [xMax, yMax]];
}
