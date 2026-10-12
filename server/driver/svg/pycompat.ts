/*
 * Python semantics that the SVG digest and optimizations depend on:
 * str.strip()/split() whitespace, min()/max() tie and NaN behavior,
 * math.isclose, and '{:.6E}' formatting.
 *
 * Original work for axya (no upstream source); distributed under AGPL-3.0.
 * Number formatting for '%f' and repr() lives in server/driver/pyfmt.ts;
 * float() parsing lives in server/driver/run/status.ts (pyFloat).
 */

/** Characters for which Python's str.isspace() is true (also re's \s). */
export const PY_WS =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const SPLIT_RE = new RegExp(`[${PY_WS}]+`);

/** Python str.strip() with no arguments. */
export function pyStrip(s: string): string {
  return s.replace(STRIP_RE, "");
}

/** Python str.split() with no arguments. */
export function pySplit(s: string): string[] {
  const t = pyStrip(s);
  return t === "" ? [] : t.split(SPLIT_RE);
}

/** Python min(a, b): returns a unless b < a (so NaN and ±0 ties keep a). */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/** Python max(a, b): returns a unless b > a. */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a;
}

/** Python math.isclose(a, b) with rel_tol=1e-9, abs_tol=0 (CPython's algorithm). */
export function isclose(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(1e-9 * b) || diff <= Math.abs(1e-9 * a) || diff <= 0;
}

/** Python math.floor on a float (raises on inf/NaN, as CPython does). */
export function pyFloor(x: number): number {
  if (!Number.isFinite(x)) {
    throw new RangeError(
      Number.isNaN(x)
        ? "cannot convert float NaN to integer"
        : "cannot convert float infinity to integer"
    );
  }
  return Math.floor(x);
}

/** Python int(x) for a float: truncation toward zero (raises on inf/NaN). */
export function pyIntOfFloat(x: number): number {
  return pyFloor(Math.abs(x)) * (x < 0 ? -1 : 1) || 0;
}

/** Exact decimal digits of |x| (finite) and the position of the decimal point. */
function exactDecimal(x: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (exp === 0) {
    e2 = -1074;
  } else {
    mant |= 1n << 52n;
    e2 = exp - 1075;
  }
  if (e2 >= 0) {
    const s = (mant << BigInt(e2)).toString();
    return { digits: s, point: s.length };
  }
  const s = (mant * 5n ** BigInt(-e2)).toString();
  return { digits: s, point: s.length + e2 };
}

/** Python format(x, `.${precision}E`): exact value, ties to even. */
export function formatExp(x: number, precision: number): string {
  if (Number.isNaN(x)) return "NAN";
  const neg = x < 0 || Object.is(x, -0);
  const sign = neg ? "-" : "";
  if (!Number.isFinite(x)) return `${sign}INF`;
  let digits: string;
  let exp10: number;
  if (x === 0) {
    digits = "0".repeat(precision + 1);
    exp10 = 0;
  } else {
    const { digits: all, point } = exactDecimal(x);
    const first = all.search(/[1-9]/);
    const sig = all.slice(first).replace(/0+$/, "");
    exp10 = point - first - 1;
    const n = precision + 1;
    let head = BigInt(sig.slice(0, n).padEnd(n, "0"));
    const rest = sig.slice(n);
    if (rest.length > 0) {
      const r0 = rest.charCodeAt(0) - 48;
      const tie = r0 === 5 && /^5$/.test(rest);
      if (r0 > 5 || (r0 === 5 && !tie) || (tie && head % 2n === 1n)) {
        head += 1n;
      }
    }
    digits = head.toString();
    if (digits.length > n) {
      digits = digits.slice(0, n);
      exp10 += 1;
    }
  }
  const mant =
    precision > 0 ? `${digits[0]}.${digits.slice(1)}` : digits.slice(0, 1);
  const e = Math.abs(exp10).toString().padStart(2, "0");
  return `${sign}${mant}E${exp10 < 0 ? "-" : "+"}${e}`;
}
