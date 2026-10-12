/*
 * Units, viewBox scaling, bounds and clipping, curve subdivision, and
 * vertex-reduction helpers.
 *
 * Ported from plotink/plot_utils.py 0.5.0 (checkLimits, checkLimitsTol,
 * point_in_bounds, clip_code, clip_segment, constrainLimits, distance,
 * getLengthInches, parseLengthWithUnits, unitsToUserUnits,
 * subdivideCubicPath, four_points_in_tolerance, points_in_tolerance,
 * supersample, _validate_viewbox, vb_scale_2, points_equal, points_near,
 * square_dist), docs/reference-apps/nextdraw-1.7.5/plotink/plot_utils.py.
 * Copyright (c) 2025 Windell H. Oskay, Bantam Tools. MIT License:
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

import { pyFloat } from "../run/status.ts";
import { beziersplitatt } from "./bezmisc.ts";
import type { Bezier } from "./bezmisc.ts";
import type { SubPath } from "./cubicsuperpath.ts";
import { isclose, pyMax, pyMin, pySplit, pyStrip } from "./pycompat.ts";

export const PX_PER_INCH = 96.0;

export type Vertex = number[];
export type BoundsRect = number[][]; // [[x_min, y_min], [x_max, y_max]]

export function checkLimits(
  value: number,
  lower: number,
  upper: number
): [number, boolean] {
  if (value > upper) return [upper, true];
  if (value < lower) return [lower, true];
  return [value, false];
}

export function checkLimitsTol(
  value: number,
  lower: number,
  upper: number,
  tolerance: number
): [number, boolean] {
  if (value > upper) {
    if (value > upper + tolerance) return [upper, true];
    return [upper, false];
  }
  if (value < lower) {
    if (value < lower - tolerance) return [lower, true];
    return [lower, false];
  }
  return [value, false];
}

export function pointInBounds(
  point: Vertex,
  bounds: BoundsRect,
  tolerance = 1e-9
): boolean {
  const [x, y] = point;
  const [[xMin, yMin], [xMax, yMax]] = bounds;
  if (x < xMin - tolerance) return false;
  if (y < yMin - tolerance) return false;
  if (x > xMax + tolerance) return false;
  if (y > yMax + tolerance) return false;
  return true;
}

export function clipCode(
  x: number,
  y: number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): number {
  let code = 0;
  if (x < xMin) code = 1;
  if (x > xMax) code |= 2;
  if (y < yMin) code |= 4;
  if (y > yMax) code |= 8;
  return code;
}

/** Cohen-Sutherland clip of [[x1, y1], [x2, y2]]; returns [accept, segment]. */
export function clipSegment(
  segment: Vertex[],
  bounds: BoundsRect
): [boolean, Vertex[]] {
  let x1 = segment[0][0];
  let y1 = segment[0][1];
  let x2 = segment[1][0];
  let y2 = segment[1][1];
  const xMin = bounds[0][0];
  const yMin = bounds[0][1];
  const xMax = bounds[1][0];
  const yMax = bounds[1][1];
  let iterations = 0;

  for (;;) {
    const code1 = clipCode(x1, y1, xMin, xMax, yMin, yMax);
    const code2 = clipCode(x2, y2, xMin, xMax, yMin, yMax);
    if (code1 === 0 && code2 === 0) return [true, segment];
    if (code1 & code2) return [false, segment];
    if (iterations > 3) return [true, segment];

    const code = code1 !== 0 ? code1 : code2;
    // The code is non-zero, so one branch always assigns.
    let xNew = 0;
    let yNew = 0;
    if (code & 1) {
      xNew = xMin;
      const slope = pyDivide(y2 - y1, x2 - x1);
      yNew = slope * (xMin - x1) + y1;
    } else if (code & 2) {
      xNew = xMax;
      const slope = pyDivide(y2 - y1, x2 - x1);
      yNew = slope * (xMax - x1) + y1;
    } else if (code & 4) {
      yNew = yMin;
      const slope = pyDivide(x2 - x1, y2 - y1);
      xNew = slope * (yMin - y1) + x1;
    } else if (code & 8) {
      yNew = yMax;
      const slope = pyDivide(x2 - x1, y2 - y1);
      xNew = slope * (yMax - y1) + x1;
    }
    if (code === code1) {
      x1 = xNew;
      y1 = yNew;
    } else {
      x2 = xNew;
      y2 = yNew;
    }
    segment = [
      [x1, y1],
      [x2, y2],
    ];
    iterations += 1;
  }
}

function pyDivide(a: number, b: number): number {
  if (b === 0) throw new RangeError("float division by zero");
  return a / b;
}

export function constrainLimits(
  value: number,
  lower: number,
  upper: number
): number {
  return pyMax(lower, pyMin(upper, value));
}

export function distance(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** parseLengthWithUnits: [value, units] or [null, null]. */
export function parseLengthWithUnits(
  stringToParse: string | null
): [number, string] | [null, null] {
  if (stringToParse === null) return [null, null];
  let units = "px";
  let s = pyStrip(stringToParse);
  const last2 = s.slice(-2);
  const last1 = s.slice(-1);
  if (last2 === "px") {
    s = s.slice(0, -2);
  } else if (["in", "mm", "cm", "pt", "pc"].includes(last2)) {
    s = s.slice(0, -2);
    units = last2;
  } else if (last1 === "Q" || last1 === "q") {
    s = s.slice(0, -1);
    units = "Q";
  } else if (last1 === "%") {
    units = "%";
    s = s.slice(0, -1);
  }
  try {
    return [pyFloat(s), units];
  } catch {
    return [null, null];
  }
}

/** getLengthInches, given the attribute's value (null when absent). */
export function getLengthInches(stringToParse: string | null): number | null {
  if (stringToParse) {
    const [value, unit] = parseLengthWithUnits(stringToParse);
    if (value === null) return null;
    if (unit === "in") return value;
    if (unit === "mm") return value / 25.4;
    if (unit === "cm") return value / 2.54;
    if (unit === "Q" || unit === "q") return value / (40.0 * 2.54);
    if (unit === "pc") return value / 6.0;
    if (unit === "pt") return value / 72.0;
    if (unit === "" || unit === "px") return value / 96.0;
  }
  return null;
}

export function unitsToUserUnits(
  inputString: string | null,
  percentRef: number | null = null
): number | null {
  const [value, unit] = parseLengthWithUnits(inputString);
  if (value === null) return null;
  if (unit === "" || unit === "px") return value;
  if (unit === "in") return value * PX_PER_INCH;
  if (unit === "mm") return (value * PX_PER_INCH) / 25.4;
  if (unit === "cm") return (value * PX_PER_INCH) / 2.54;
  if (unit === "Q" || unit === "q") return (value * PX_PER_INCH) / 101.6;
  if (unit === "pc") return (value * PX_PER_INCH) / 6.0;
  if (unit === "pt") return (value * PX_PER_INCH) / 72.0;
  if (unit === "%") {
    if (percentRef) return (value * percentRef) / 100.0;
    return value / 100.0;
  }
  return null;
}

/**
 * subdivideCubicPath: split cubic segments at t=0.5 until both control
 * points lie within `flat` of the chord. Mutates `sp` in place.
 */
export function subdivideCubicPath(sp: SubPath, flat: number, i = 1): void {
  if (flat <= 0) return;
  for (;;) {
    let p0, p1, p2, p3;
    for (;;) {
      if (i >= sp.length) return;
      p0 = sp[i - 1][1];
      p1 = sp[i - 1][2];
      p2 = sp[i][0];
      p3 = sp[i][1];
      if (!fourPointsInTolerance(p0, p1, p2, p3, flat)) break;
      i += 1;
    }
    const [one, two] = beziersplitatt([p0, p1, p2, p3] as Bezier, 0.5);
    sp[i - 1][2] = one[1] as number[];
    sp[i][0] = two[2] as number[];
    sp.splice(i, 0, [one[2], one[3], two[1]] as number[][]);
  }
}

function pointWithinTolerance(
  px: number,
  py: number,
  seg0x: number,
  seg0y: number,
  seg1x: number,
  seg1y: number,
  sdx: number,
  sdy: number,
  segLenSq: number,
  tolSq: number,
  tolTimesSegLenSq: number
): boolean {
  const dx0 = px - seg0x;
  const dy0 = py - seg0y;
  const temp1 = dx0 * sdx + dy0 * sdy;
  if (temp1 <= 0) return !(dx0 * dx0 + dy0 * dy0 >= tolSq);
  if (segLenSq <= temp1) {
    const dx1 = px - seg1x;
    const dy1 = py - seg1y;
    return !(dx1 * dx1 + dy1 * dy1 >= tolSq);
  }
  if (segLenSq === 0) return false;
  const temp = dx0 * sdy - sdx * dy0;
  return !(temp * temp >= tolTimesSegLenSq);
}

/** four_points_in_tolerance: are p1 and p2 within tolerance of p0->p3? */
export function fourPointsInTolerance(
  p0: readonly number[],
  p1: readonly number[],
  p2: readonly number[],
  p3: readonly number[],
  tolerance: number
): boolean {
  const tolSq = tolerance * tolerance;
  const seg0x = p0[0];
  const seg0y = p0[1];
  const seg1x = p3[0];
  const seg1y = p3[1];
  const sdx = seg1x - seg0x;
  const sdy = seg1y - seg0y;
  const segLenSq = sdx * sdx + sdy * sdy;
  const tolTimes = tolSq * segLenSq;
  return (
    pointWithinTolerance(
      p1[0],
      p1[1],
      seg0x,
      seg0y,
      seg1x,
      seg1y,
      sdx,
      sdy,
      segLenSq,
      tolSq,
      tolTimes
    ) &&
    pointWithinTolerance(
      p2[0],
      p2[1],
      seg0x,
      seg0y,
      seg1x,
      seg1y,
      sdx,
      sdy,
      segLenSq,
      tolSq,
      tolTimes
    )
  );
}

/**
 * points_in_tolerance: is every interior vertex of `pts` within tolerance of
 * the segment from the first to the last vertex?
 */
export function pointsInTolerance(
  pts: readonly Vertex[],
  tolerance: number,
  start = 0,
  end = pts.length
): boolean {
  if (end - start < 3) return true;
  const tolSq = tolerance * tolerance;
  const seg0x = pts[start][0];
  const seg0y = pts[start][1];
  const seg1x = pts[end - 1][0];
  const seg1y = pts[end - 1][1];
  const sdx = seg1x - seg0x;
  const sdy = seg1y - seg0y;
  const segLenSq = sdx * sdx + sdy * sdy;
  const tolTimes = tolSq * segLenSq;
  if (end - start === 3) {
    // Python's three-point fast path tests `< tol` where the loop tests
    // `>= tol`; the two differ only for NaN, but keep both.
    const [px, py] = pts[start + 1];
    const dx0 = px - seg0x;
    const dy0 = py - seg0y;
    const temp1 = dx0 * sdx + dy0 * sdy;
    if (temp1 <= 0) return dx0 * dx0 + dy0 * dy0 < tolSq;
    if (segLenSq <= temp1) {
      const dx1 = px - seg1x;
      const dy1 = py - seg1y;
      return dx1 * dx1 + dy1 * dy1 < tolSq;
    }
    if (segLenSq === 0) return false;
    const temp = dx0 * sdy - sdx * dy0;
    return temp * temp < tolTimes;
  }
  for (let k = start + 1; k < end - 1; k++) {
    const [px, py] = pts[k];
    const dx0 = px - seg0x;
    const dy0 = py - seg0y;
    const temp1 = dx0 * sdx + dy0 * sdy;
    if (temp1 <= 0) {
      if (dx0 * dx0 + dy0 * dy0 >= tolSq) return false;
      continue;
    }
    if (segLenSq <= temp1) {
      const dx1 = px - seg1x;
      const dy1 = py - seg1y;
      if (dx1 * dx1 + dy1 * dy1 >= tolSq) return false;
      continue;
    }
    if (segLenSq === 0) return false;
    const temp = dx0 * sdy - sdx * dy0;
    if (temp * temp >= tolTimes) return false;
  }
  return true;
}

/** supersample: drop vertices that lie within tolerance of a longer chord. */
export function supersample(vertices: Vertex[], tolerance: number): void {
  if (vertices.length <= 2) return;
  if (tolerance <= 0) return;
  let startIndex = 0;
  let len = vertices.length;
  while (startIndex < len - 2) {
    let endIndex = startIndex + 2;
    // vertices[start:end+1] in Python; the slice end is clamped to the length.
    while (
      pointsInTolerance(
        vertices,
        tolerance,
        startIndex,
        Math.min(endIndex + 1, len)
      ) &&
      endIndex < len
    ) {
      endIndex += 1;
    }
    if (endIndex > startIndex + 2) {
      vertices.splice(startIndex + 1, endIndex - 1 - (startIndex + 1));
      len = vertices.length;
    }
    startIndex += 1;
  }
}

function validateViewbox(
  viewboxString: string | null,
  docWidth: number,
  docHeight: number
): number[] | null {
  if (viewboxString === null) return null;
  const vb = pySplit(pyStrip(viewboxString).replaceAll(",", " "));
  if (vb.length < 4) return null;
  let vals: number[];
  try {
    vals = vb.slice(0, 4).map(pyFloat);
  } catch {
    return null;
  }
  if (!vals.every(Number.isFinite)) return null;
  const [minX, minY, width, height] = vals;
  if (width <= 0 || height <= 0) return null;
  if (docWidth <= 0 || docHeight <= 0) return null;
  return [minX, minY, width, height, docWidth, docHeight];
}

/**
 * vb_scale_2: [s_x, s_y, o_x, o_y] for a valid viewBox, else null. A user
 * point maps to inches as s * (p + o).
 */
export function vbScale2(
  viewboxString: string | null,
  preserveAspectRatio: string | null,
  docWidth: number,
  docHeight: number
): [number, number, number, number] | null {
  const validated = validateViewbox(viewboxString, docWidth, docHeight);
  if (validated === null) return null;
  const [minX, minY, width, height, dWidth, dHeight] = validated;
  const arDoc = dHeight / dWidth;
  const arVb = height / width;
  let parMos = "meet";
  let parAlign = "xmidymid";
  if (preserveAspectRatio !== null) {
    const parList = pySplit(preserveAspectRatio);
    if (parList.length > 0) parAlign = parList[0].toLowerCase();
    if (parList.length > 1) parMos = parList[1].toLowerCase();
  }

  if (parAlign === "none") {
    return [dWidth / width, dHeight / height, -minX, -minY];
  }

  if (
    (arDoc >= arVb && parMos === "meet") ||
    (arDoc < arVb && parMos === "slice")
  ) {
    const sX = dWidth / width;
    const oX = -minX;
    const scaledVbHeight = arDoc * width;
    const excessHeight = scaledVbHeight - height;
    let oY: number;
    if (["xminymin", "xmidymin", "xmaxymin"].includes(parAlign)) {
      oY = -minY;
    } else if (["xminymax", "xmidymax", "xmaxymax"].includes(parAlign)) {
      oY = -minY + excessHeight;
    } else {
      oY = -minY + excessHeight / 2;
    }
    return [sX, sX, oX, oY];
  }

  const sY = dHeight / height;
  const oY = -minY;
  const scaledVbWidth = height / arDoc;
  const excessWidth = scaledVbWidth - width;
  let oX: number;
  if (["xminymin", "xminymid", "xminymax"].includes(parAlign)) {
    oX = -minX;
  } else if (["xmaxymin", "xmaxymid", "xmaxymax"].includes(parAlign)) {
    oX = -minX + excessWidth;
  } else {
    oX = -minX + excessWidth / 2;
  }
  return [sY, sY, oX, oY];
}

export function pointsEqual(a: Vertex, b: Vertex): boolean {
  return isclose(a[0], b[0]) && isclose(a[1], b[1]);
}

export function pointsNear(
  a: Vertex,
  b: Vertex,
  squaredTolerance: number
): boolean {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy < squaredTolerance;
}

export function squareDist(a: Vertex, b: Vertex): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}
