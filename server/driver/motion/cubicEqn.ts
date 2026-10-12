/*
 * Closed-form cubic root solver (www.1728.org/cubic2.htm).
 *
 * Ported from nextdrawcore/cubic_eqn.py 1.0.0 (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/cubic_eqn.py.
 * Created by     :    Shril Kumar [(shril.iitdhn@gmail.com),(github.com/shril)] &
 *                     Devojoyti Halder [(devjyoti.itachi@gmail.com),(github.com/devojoyti)]
 * Lightly modified by Windell H. Oskay, 2023, to remove numpy.
 * Released by its authors as freeware for any use; distributed in nextdraw
 * under the GNU General Public License v2 or (at your option) any later
 * version; distributed here under AGPL-3.0 as part of axya.
 *
 * Python's `x ** y` on floats is libm pow; pyPow (V8's Math.pow) matched
 * CPython on macOS bit for bit for the exponents 1/3 and 3 over 200k
 * samples. `g ** 2.0` is the exception: macOS pow(x, 2) is not correctly
 * rounded (about 0.14% of inputs, always where x*x lies within 0.006 ulp of
 * a rounding midpoint), while V8 returns x*x. That quantity is irreducible
 * without Apple's pow; the planner only ever sees it after float32 storage
 * (traj_vels), where the 1-ulp difference vanishes. See test/planner*.test.ts.
 */

import { type Complex, pyDiv, pyPow, pySqrt } from "./pyMath.ts";

export type Root = number | Complex;

// Python 3.14 mixed real/complex arithmetic (no promotion of the real operand).
const cmulReal = (k: number, im: number): Complex => ({
  re: k * 0,
  im: k * im,
});

export function solve(a: number, b: number, c: number, d: number): Root[] {
  if (a === 0 && b === 0) {
    return [pyDiv(-d * 1.0, c)];
  } else if (a === 0) {
    let D = c * c - 4.0 * b * d;
    if (D >= 0) {
      D = pySqrt(D);
      const x1 = pyDiv(-c + D, 2.0 * b);
      const x2 = pyDiv(-c - D, 2.0 * b);
      return [x1, x2];
    }
    D = pySqrt(-D);
    const den = 2.0 * b;
    if (den === 0) throw new RangeError("complex division by zero");
    const j = cmulReal(D, 1);
    return [
      { re: (-c + j.re) / den, im: j.im / den },
      { re: (-c - j.re) / den, im: -j.im / den },
    ];
  }

  const f = findF(a, b, c);
  const g = findG(a, b, c, d);
  const h = findH(g, f);

  if (f === 0 && g === 0 && h === 0) {
    let x: number;
    if (d / a >= 0) {
      x = pyPow(d / (1.0 * a), 1 / 3.0) * -1;
    } else {
      x = pyPow(-d / (1.0 * a), 1 / 3.0);
    }
    return [x, x, x];
  } else if (h <= 0) {
    const i = pySqrt(pyPow(g, 2.0) / 4.0 - h);
    const j = pyPow(i, 1 / 3.0);
    const cosArg = -pyDiv(g, 2 * i);
    if (!(cosArg >= -1 && cosArg <= 1))
      throw new RangeError("math domain error");
    const k = Math.acos(cosArg);
    const L = j * -1;
    const M = Math.cos(k / 3.0);
    const N = Math.sqrt(3) * Math.sin(k / 3.0);
    const P = (b / (3.0 * a)) * -1;

    const x1 = 2 * j * Math.cos(k / 3.0) - b / (3.0 * a);
    const x2 = L * (M + N) + P;
    const x3 = L * (M - N) + P;
    return [x1, x2, x3];
  }
  // nextdraw quirk: a NaN h matches no branch and solve() returns None,
  // which scurve_plan then fails to iterate (cubic_eqn.py:64-96).
  if (!(h > 0)) throw new TypeError("'NoneType' object is not iterable");
  const R = -(g / 2.0) + pySqrt(h);
  let S: number;
  if (R >= 0) S = pyPow(R, 1 / 3.0);
  else S = pyPow(-R, 1 / 3.0) * -1;
  const T = -(g / 2.0) - pySqrt(h);
  let U: number;
  if (T >= 0) U = pyPow(T, 1 / 3.0);
  else U = pyPow(-T, 1 / 3.0) * -1;

  const x1 = S + U - b / (3.0 * a);
  const m = -(S + U) / 2 - b / (3.0 * a);
  const im = cmulReal((S - U) * Math.sqrt(3), 0.5);
  const x2: Complex = { re: m + im.re, im: im.im };
  const x3: Complex = { re: m - im.re, im: -im.im };
  return [x1, x2, x3];
}

function findF(a: number, b: number, c: number): number {
  return ((3.0 * c) / a - pyPow(b, 2.0) / pyPow(a, 2.0)) / 3.0;
}

function findG(a: number, b: number, c: number, d: number): number {
  return (
    ((2.0 * pyPow(b, 3.0)) / pyPow(a, 3.0) -
      (9.0 * b * c) / pyPow(a, 2.0) +
      (27.0 * d) / a) /
    27.0
  );
}

function findH(g: number, f: number): number {
  return pyPow(g, 2.0) / 4.0 + pyPow(f, 3.0) / 27.0;
}
