/*
 * The transcendental functions used by the digest (arc flattening and
 * rotate/skew transforms).
 *
 * Original work for axya; distributed under AGPL-3.0.
 *
 * nextdraw runs on CPython, whose math.sin/cos/tan/acos call the platform
 * libm. V8 uses its own fdlibm port. Neither is correctly rounded, and they
 * disagree by one ulp on some inputs (4 of the 45 distinct calls in the
 * oracle fixtures, on macOS). That difference is irreducible without the
 * platform's libm, so tests replace these entries with recorded CPython
 * results to compare everything downstream exactly; see test/helpers/digestLibm.ts.
 */

export interface Libm {
  sin: (x: number) => number;
  cos: (x: number) => number;
  tan: (x: number) => number;
  acos: (x: number) => number;
}

export const libm: Libm = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  acos: Math.acos,
};

/** Swap in other implementations (tests); returns a function that restores the previous ones. */
export function setLibm(fns: Partial<Libm>): () => void {
  const saved = { ...libm };
  Object.assign(libm, fns);
  return () => {
    Object.assign(libm, saved);
  };
}
