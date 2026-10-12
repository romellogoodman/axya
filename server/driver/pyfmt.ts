/**
 * Python-compatible number formatting.
 *
 * Python's fixed-point formatting ('{:.3f}', '%f') rounds the exact binary
 * value of a double to the requested digits, breaking exact ties to even.
 * JavaScript's toFixed breaks ties away from zero, so the two disagree on
 * values like 0.0625 -> "0.062" (Python) vs "0.063" (JS). Strings that
 * nextdraw writes into SVG files or messages must match exactly.
 */

/** Exact value of a finite double as [numerator, denominatorPowerOfTwo]: x = n / 2^k. */
function exactBinary(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (exp === 0) {
    e2 = -1074; // subnormal
  } else {
    mantissa |= 1n << 52n;
    e2 = exp - 1075;
  }
  if (e2 >= 0) return [sign * (mantissa << BigInt(e2)), 0];
  return [sign * mantissa, -e2];
}

/** Python format(x, `.${digits}f`). */
export function formatFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const [num, k] = exactBinary(x);
  const neg = num < 0n || Object.is(x, -0);
  const mag = num < 0n ? -num : num;
  // value * 10^digits = mag * 10^digits / 2^k; round half to even.
  const scaledNum = mag * 10n ** BigInt(digits);
  const den = 1n << BigInt(k);
  let q = scaledNum / den;
  const r = scaledNum % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  let s = q.toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, "0");
    s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }
  return neg ? `-${s}` : s;
}

/** Python repr() / str() of a float: shortest round-trip digits in Python's layout. */
export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  // toExponential() with no argument gives the shortest round-trip digits.
  const [mant, expStr] = Math.abs(x).toExponential().split("e");
  const exp = Number(expStr);
  const digits = mant.replace(".", "");
  const sign = x < 0 ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const intLen = exp + 1;
  if (digits.length <= intLen) return `${sign}${digits.padEnd(intLen, "0")}.0`;
  return `${sign}${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
}
