/*
 * SVG transform-attribute parsing and 2x3 matrix composition.
 *
 * Ported from ink_extensions/simpletransform.py (ink_extensions 1.x, as
 * installed for nextdraw 1.7.5): parseTransform, formatTransform,
 * invertTransform, composeTransform, applyTransformToPoint,
 * applyTransformToPath.
 * Copyright (C) 2006 Jean-Francois Barraud, barraud@math.univ-lille1.fr
 * Copyright (C) 2010 Alvin Penner, penner@vaxxine.com
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { formatFixed } from "../pyfmt.ts";
import { pyFloat } from "../run/status.ts";
import { libm } from "./libm.ts";
import { PY_WS, pySplit, pyStrip } from "./pycompat.ts";
import type { CubicSuperPath, Point } from "./cubicsuperpath.ts";

/** [[a, c, e], [b, d, f]]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Matrix = number[][];

export const IDENTITY: Matrix = [
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
];

const TRANSFORM_RE = new RegExp(
  `^(translate|scale|rotate|skewX|skewY|matrix)[${PY_WS}]*\\(([^)]*)\\)[${PY_WS}]*,?`
);

/**
 * parseTransform. Malformed input throws, as the Python does (AttributeError,
 * ValueError, IndexError), rather than being ignored.
 */
export function parseTransform(
  transf: string | null | undefined,
  mat: Matrix = IDENTITY
): Matrix {
  if (transf === "" || transf === null || transf === undefined) return mat;
  const stransf = pyStrip(transf);
  const result = TRANSFORM_RE.exec(stransf);
  if (!result) {
    throw new TypeError("'NoneType' object has no attribute 'group'");
  }
  const kind = result[1];
  const body = result[2];
  const args = () => pySplit(body.replaceAll(",", " "));
  const arg = (list: string[], i: number) => {
    if (i >= list.length) throw new RangeError("list index out of range");
    return pyFloat(list[i]);
  };
  let matrix: Matrix;
  if (kind === "translate") {
    const a = args();
    const dx = arg(a, 0);
    const dy = a.length === 1 ? 0.0 : arg(a, 1);
    matrix = [
      [1, 0, dx],
      [0, 1, dy],
    ];
  } else if (kind === "scale") {
    const a = args();
    const sx = arg(a, 0);
    const sy = a.length === 1 ? sx : arg(a, 1);
    matrix = [
      [sx, 0, 0],
      [0, sy, 0],
    ];
  } else if (kind === "rotate") {
    const a = args();
    const angle = (arg(a, 0) * Math.PI) / 180;
    let cx = 0.0;
    let cy = 0.0;
    if (a.length !== 1) {
      if (a.length !== 3) {
        throw new RangeError("wrong number of values to unpack");
      }
      cx = pyFloat(a[1]);
      cy = pyFloat(a[2]);
    }
    matrix = [
      [libm.cos(angle), -libm.sin(angle), cx],
      [libm.sin(angle), libm.cos(angle), cy],
    ];
    matrix = composeTransform(matrix, [
      [1, 0, -cx],
      [0, 1, -cy],
    ]);
  } else if (kind === "skewX") {
    const angle = (pyFloat(body) * Math.PI) / 180;
    matrix = [
      [1, libm.tan(angle), 0],
      [0, 1, 0],
    ];
  } else if (kind === "skewY") {
    const angle = (pyFloat(body) * Math.PI) / 180;
    matrix = [
      [1, 0, 0],
      [libm.tan(angle), 1, 0],
    ];
  } else {
    const a = args();
    if (a.length !== 6) {
      throw new RangeError("wrong number of values to unpack");
    }
    const [a11, a21, a12, a22, v1, v2] = a.map(pyFloat);
    matrix = [
      [a11, a12, v1],
      [a21, a22, v2],
    ];
  }

  matrix = composeTransform(mat, matrix);
  const end = result[0].length;
  if (end < stransf.length) return parseTransform(stransf.slice(end), matrix);
  return matrix;
}

export function formatTransform(mat: Matrix): string {
  const f = (x: number) => formatFixed(x, 6);
  return `matrix(${f(mat[0][0])},${f(mat[1][0])},${f(mat[0][1])},${f(mat[1][1])},${f(mat[0][2])},${f(mat[1][2])})`;
}

export function invertTransform(mat: Matrix): Matrix {
  const det = mat[0][0] * mat[1][1] - mat[0][1] * mat[1][0];
  if (det !== 0) {
    const a11 = mat[1][1] / det;
    const a12 = -mat[0][1] / det;
    const a21 = -mat[1][0] / det;
    const a22 = mat[0][0] / det;
    const a13 = -(a11 * mat[0][2] + a12 * mat[1][2]);
    const a23 = -(a21 * mat[0][2] + a22 * mat[1][2]);
    return [
      [a11, a12, a13],
      [a21, a22, a23],
    ];
  }
  return [
    [0, 0, -mat[0][2]],
    [0, 0, -mat[1][2]],
  ];
}

export function composeTransform(M1: Matrix, M2: Matrix): Matrix {
  const a11 = M1[0][0] * M2[0][0] + M1[0][1] * M2[1][0];
  const a12 = M1[0][0] * M2[0][1] + M1[0][1] * M2[1][1];
  const a21 = M1[1][0] * M2[0][0] + M1[1][1] * M2[1][0];
  const a22 = M1[1][0] * M2[0][1] + M1[1][1] * M2[1][1];
  const v1 = M1[0][0] * M2[0][2] + M1[0][1] * M2[1][2] + M1[0][2];
  const v2 = M1[1][0] * M2[0][2] + M1[1][1] * M2[1][2] + M1[1][2];
  return [
    [a11, a12, v1],
    [a21, a22, v2],
  ];
}

export function applyTransformToPoint(mat: Matrix, pt: Point): void {
  const x = mat[0][0] * pt[0] + mat[0][1] * pt[1] + mat[0][2];
  const y = mat[1][0] * pt[0] + mat[1][1] * pt[1] + mat[1][2];
  pt[0] = x;
  pt[1] = y;
}

export function applyTransformToPath(mat: Matrix, path: CubicSuperPath): void {
  for (const comp of path) {
    for (const ctl of comp) {
      for (const pt of ctl) applyTransformToPoint(mat, pt);
    }
  }
}
