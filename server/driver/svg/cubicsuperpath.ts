/*
 * Cubic "superpaths": every path segment as a cubic Bezier, with arcs
 * approximated by cubic sectors.
 *
 * Ported from ink_extensions/cubicsuperpath.py (ink_extensions 1.x, as
 * installed for nextdraw 1.7.5): matprod, rotmat, applymat, norm, ArcToPath,
 * CubicSuperPath, unCubicSuperPath, parsePath, formatPath.
 * Copyright (C) 2005 Aaron Spike, aaron@ekips.org.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { libm } from "./libm.ts";
import { pyIntOfFloat, pyMax } from "./pycompat.ts";
import * as simplepath from "./simplepath.ts";
import type { PathCommand } from "./simplepath.ts";

export type Point = number[];
/** [control point before, vertex, control point after] */
export type SuperPoint = Point[];
export type SubPath = SuperPoint[];
export type CubicSuperPath = SubPath[];

type Mat2 = number[][];

function matprod(mlist: Mat2[]): Mat2 {
  let prod = mlist[0];
  for (const m of mlist.slice(1)) {
    const a00 = prod[0][0] * m[0][0] + prod[0][1] * m[1][0];
    const a01 = prod[0][0] * m[0][1] + prod[0][1] * m[1][1];
    const a10 = prod[1][0] * m[0][0] + prod[1][1] * m[1][0];
    const a11 = prod[1][0] * m[0][1] + prod[1][1] * m[1][1];
    prod = [
      [a00, a01],
      [a10, a11],
    ];
  }
  return prod;
}

function rotmat(teta: number): Mat2 {
  return [
    [libm.cos(teta), -libm.sin(teta)],
    [libm.sin(teta), libm.cos(teta)],
  ];
}

function applymat(mat: Mat2, pt: Point): void {
  const x = mat[0][0] * pt[0] + mat[0][1] * pt[1];
  const y = mat[1][0] * pt[0] + mat[1][1] * pt[1];
  pt[0] = x;
  pt[1] = y;
}

function norm(pt: Point): number {
  return Math.sqrt(pt[0] * pt[0] + pt[1] * pt[1]);
}

/** Python math.acos: raises ValueError outside [-1, 1] instead of returning NaN. */
function pyAcos(x: number): number {
  if (x < -1 || x > 1) throw new RangeError("math domain error");
  return libm.acos(x);
}

/** Python true division: raises ZeroDivisionError on a zero divisor. */
function pyDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("float division by zero");
  return a / b;
}

/**
 * ArcToPath. Out-of-range radii are not scaled up as SVG requires; the
 * center distance is clamped instead (`sqrt(max(0, 1 - d/4))`).
 */
export function arcToPath(p1: Point, params: number[]): SuperPoint[] {
  const A = p1.slice();
  const [rx, ry, tetaDeg, longflag, sweepflag, x2, y2] = params;
  const teta = (tetaDeg * Math.PI) / 180.0;
  const B = [x2, y2];
  if (rx === 0 || ry === 0 || (A[0] === B[0] && A[1] === B[1])) {
    return [
      [A.slice(), A.slice(), A.slice()],
      [B.slice(), B.slice(), B.slice()],
    ];
  }
  let mat = matprod([
    rotmat(teta),
    [
      [1 / rx, 0],
      [0, 1 / ry],
    ],
    rotmat(-teta),
  ]);
  applymat(mat, A);
  applymat(mat, B);
  const k = [-(B[1] - A[1]), B[0] - A[0]];
  let d = k[0] * k[0] + k[1] * k[1];
  k[0] = pyDiv(k[0], Math.sqrt(d));
  k[1] = pyDiv(k[1], Math.sqrt(d));
  d = Math.sqrt(pyMax(0, 1 - d / 4));
  if (longflag === sweepflag) d *= -1;
  const O = [(B[0] + A[0]) / 2 + d * k[0], (B[1] + A[1]) / 2 + d * k[1]];
  const OA = [A[0] - O[0], A[1] - O[1]];
  const OB = [B[0] - O[0], B[1] - O[1]];
  let start = pyAcos(pyDiv(OA[0], norm(OA)));
  if (OA[1] < 0) start *= -1;
  let end = pyAcos(pyDiv(OB[0], norm(OB)));
  if (OB[1] < 0) end *= -1;

  if (sweepflag && start > end) end += 2 * Math.PI;
  if (!sweepflag && start < end) end -= 2 * Math.PI;

  const nbSectors = pyIntOfFloat((Math.abs(start - end) * 2) / Math.PI) + 1;
  const dTeta = (end - start) / nbSectors;
  const v = (4 * libm.tan(dTeta / 4)) / 3;
  const p: SuperPoint[] = [];
  for (let i = 0; i < nbSectors + 1; i++) {
    const angle = start + i * dTeta;
    const c = libm.cos(angle);
    const s = libm.sin(angle);
    const v1 = [O[0] + c - -v * s, O[1] + s + -v * c];
    const pt = [O[0] + c, O[1] + s];
    const v2 = [O[0] + c - v * s, O[1] + s + v * c];
    p.push([v1, pt, v2]);
  }
  p[0][0] = p[0][1].slice();
  p[p.length - 1][2] = p[p.length - 1][1].slice();

  mat = matprod([
    rotmat(teta),
    [
      [rx, 0],
      [0, ry],
    ],
    rotmat(-teta),
  ]);
  for (const pts of p) {
    applymat(mat, pts[0]);
    applymat(mat, pts[1]);
    applymat(mat, pts[2]);
  }
  return p;
}

/** CubicSuperPath: convert parsePath output to cubic superpaths. */
export function cubicSuperPath(simple: PathCommand[]): CubicSuperPath {
  const csp: CubicSuperPath = [];
  let subpath = -1;
  let subpathstart: Point = [];
  let last: Point = [];
  let lastctrl: Point = [];
  const at = (i: number): SubPath => {
    // Python list indexing: -1 is the last item; an empty list raises.
    const idx = i < 0 ? csp.length + i : i;
    if (idx < 0 || idx >= csp.length) {
      throw new RangeError("list index out of range");
    }
    return csp[idx];
  };
  for (const [cmd, params] of simple) {
    if (cmd === "M") {
      if (last.length)
        at(subpath).push([lastctrl.slice(), last.slice(), last.slice()]);
      subpath += 1;
      csp.push([]);
      subpathstart = params.slice();
      last = params.slice();
      lastctrl = params.slice();
    } else if (cmd === "L") {
      at(subpath).push([lastctrl.slice(), last.slice(), last.slice()]);
      last = params.slice();
      lastctrl = params.slice();
    } else if (cmd === "C") {
      at(subpath).push([lastctrl.slice(), last.slice(), params.slice(0, 2)]);
      last = params.slice(-2);
      lastctrl = params.slice(2, 4);
    } else if (cmd === "Q") {
      const q0 = last.slice();
      const q1 = params.slice(0, 2);
      const q2 = params.slice(2, 4);
      const x0 = q0[0];
      const x1 = (1 / 3) * q0[0] + (2 / 3) * q1[0];
      const x2 = (2 / 3) * q1[0] + (1 / 3) * q2[0];
      const x3 = q2[0];
      const y0 = q0[1];
      const y1 = (1 / 3) * q0[1] + (2 / 3) * q1[1];
      const y2 = (2 / 3) * q1[1] + (1 / 3) * q2[1];
      const y3 = q2[1];
      at(subpath).push([lastctrl.slice(), [x0, y0], [x1, y1]]);
      last = [x3, y3];
      lastctrl = [x2, y2];
    } else if (cmd === "A") {
      const arcp = arcToPath(last.slice(), params.slice());
      arcp[0][0] = lastctrl.slice();
      last = arcp[arcp.length - 1][1];
      lastctrl = arcp[arcp.length - 1][0];
      at(subpath).push(...arcp.slice(0, -1));
    } else if (cmd === "Z") {
      at(subpath).push([lastctrl.slice(), last.slice(), last.slice()]);
      last = subpathstart.slice();
      lastctrl = subpathstart.slice();
    }
  }
  at(subpath).push([lastctrl.slice(), last.slice(), last.slice()]);
  return csp;
}

export function unCubicSuperPath(csp: CubicSuperPath): PathCommand[] {
  const a: PathCommand[] = [];
  for (const subpath of csp) {
    if (subpath.length) {
      a.push(["M", subpath[0][1].slice()]);
      for (let i = 1; i < subpath.length; i++) {
        a.push([
          "C",
          [...subpath[i - 1][2], ...subpath[i][0], ...subpath[i][1]],
        ]);
      }
    }
  }
  return a;
}

export function parsePath(d: string): CubicSuperPath {
  return cubicSuperPath(simplepath.parsePath(d));
}

export function formatPath(p: CubicSuperPath): string {
  return simplepath.formatPath(unCubicSuperPath(p));
}
