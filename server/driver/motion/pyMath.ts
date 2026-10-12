/*
 * CPython numeric semantics the planner port depends on: math.isclose,
 * builtin min/max on two arguments, round() and unary minus on values that
 * Python holds as ints, and libm pow.
 *
 * Original to axya (no upstream source); licensed AGPL-3.0 as part of axya.
 */

import { roundHalfEven } from "./ebbCalc.ts";

/** math.isclose(a, b, rel_tol=1e-9, abs_tol=0.0), as in Modules/mathmodule.c. */
export function isclose(
  a: number,
  b: number,
  relTol = 1e-9,
  absTol = 0
): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return (
    diff <= Math.abs(relTol * b) ||
    diff <= Math.abs(relTol * a) ||
    diff <= absTol
  );
}

/** Builtin min(a, b): keeps the first argument unless the second is smaller. */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/** Builtin max(a, b): keeps the first argument unless the second is larger. */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a;
}

/**
 * round(x) on a float, giving the int Python returns. Python ints have no
 * negative zero, so -0 is normalised to 0 for fixture comparisons.
 */
export function pyRound(x: number): number {
  return roundHalfEven(x) + 0;
}

/** Unary minus on a Python int (never -0). */
export function negInt(x: number): number {
  return 0 - x;
}

/**
 * float ** float through libm pow. V8's Math.pow agreed with CPython on
 * macOS for every sampled exponent except 2, where V8 (fdlibm) returns x*x
 * and macOS libm pow is not always correctly rounded. See cubicEqn.ts for
 * the one place that matters.
 */
export const pyPow = Math.pow;

/** A Python complex value; only ever filtered out by the planner. */
export interface Complex {
  re: number;
  im: number;
}

export function isComplex(value: number | Complex): value is Complex {
  return typeof value !== "number";
}

/** math.sqrt: raises ValueError (here: throws) on negative input. */
export function pySqrt(x: number): number {
  if (x < 0) throw new RangeError("math domain error");
  return Math.sqrt(x);
}

/** float / float: raises ZeroDivisionError (here: throws) on a zero divisor. */
export function pyDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("float division by zero");
  return a / b;
}
