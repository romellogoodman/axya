/**
 * Minimal decimal arithmetic matching Python's `decimal` module with
 * `getcontext().prec = 20` and the default ROUND_HALF_EVEN context.
 *
 * nextdraw's firmware-exact step prediction (plotink/ebb_calc.py) is computed
 * in that context, so every intermediate result is rounded to 20 significant
 * digits. Reproducing those roundings, not exact rational math, is what makes
 * the port's command stream identical to the reference.
 *
 * Values are immutable: coefficient × 10^exponent, kept normalized (no
 * trailing zeros in the coefficient). Python keeps trailing zeros, but they
 * never change a value, and rounding to N significant digits depends only on
 * the value.
 */

const PREC = 20;
const TEN = 10n;

function digits(n: bigint): number {
  return (n < 0n ? -n : n).toString().length;
}

export class Dec {
  readonly c: bigint;
  readonly e: number;

  private constructor(c: bigint, e: number) {
    this.c = c;
    this.e = e;
  }

  static of(value: number | bigint): Dec {
    if (typeof value === "number" && !Number.isInteger(value)) {
      throw new RangeError(`Dec.of expects an integer, got ${value}`);
    }
    return Dec.normalize(BigInt(value), 0);
  }

  private static normalize(c: bigint, e: number): Dec {
    if (c === 0n) return new Dec(0n, 0);
    while (c % TEN === 0n) {
      c /= TEN;
      e += 1;
    }
    return new Dec(c, e);
  }

  /** Round coefficient c × 10^e to PREC significant digits, half-even. */
  private static round(c: bigint, e: number, sticky = false): Dec {
    const n = digits(c);
    if (n <= PREC && !sticky) return Dec.normalize(c, e);
    const drop = Math.max(n - PREC, 0);
    if (drop === 0) return Dec.normalize(c, e); // sticky bits below an exact PREC-digit value never round
    const p = TEN ** BigInt(drop);
    const neg = c < 0n;
    const mag = neg ? -c : c;
    let hi = mag / p;
    const lo = mag % p;
    const half = p / 2n;
    if (lo > half || (lo === half && (sticky || hi % 2n === 1n))) hi += 1n;
    return Dec.normalize(neg ? -hi : hi, e + drop);
  }

  private static align(a: Dec, b: Dec): [bigint, bigint, number] {
    const e = Math.min(a.e, b.e);
    return [a.c * TEN ** BigInt(a.e - e), b.c * TEN ** BigInt(b.e - e), e];
  }

  add(b: Dec): Dec {
    const [x, y, e] = Dec.align(this, b);
    return Dec.round(x + y, e);
  }

  sub(b: Dec): Dec {
    const [x, y, e] = Dec.align(this, b);
    return Dec.round(x - y, e);
  }

  mul(b: Dec): Dec {
    return Dec.round(this.c * b.c, this.e + b.e);
  }

  div(b: Dec): Dec {
    if (b.c === 0n) throw new RangeError("Dec division by zero");
    if (this.c === 0n) return new Dec(0n, 0);
    const neg = this.c < 0n !== b.c < 0n;
    const num = this.c < 0n ? -this.c : this.c;
    const den = b.c < 0n ? -b.c : b.c;
    // Scale so the integer quotient carries at least PREC + 2 digits.
    const k = Math.max(PREC + 2 - (digits(num) - digits(den)), 0);
    const scaled = num * TEN ** BigInt(k);
    const q = scaled / den;
    const sticky = scaled % den !== 0n;
    return Dec.round(neg ? -q : q, this.e - b.e - k, sticky);
  }

  /** Integer value, rounded half away from zero (Decimal.quantize(1, ROUND_HALF_UP)). */
  toIntegerHalfUp(): bigint {
    if (this.e >= 0) return this.c * TEN ** BigInt(this.e);
    const p = TEN ** BigInt(-this.e);
    const neg = this.c < 0n;
    const mag = neg ? -this.c : this.c;
    let q = mag / p;
    if ((mag % p) * 2n >= p) q += 1n;
    return neg ? -q : q;
  }

  /** Integer value, truncated toward zero (Python int(Decimal)). */
  toIntegerTrunc(): bigint {
    if (this.e >= 0) return this.c * TEN ** BigInt(this.e);
    return this.c / TEN ** BigInt(-this.e);
  }

  /** Nearest double, as Python float(Decimal). */
  toNumber(): number {
    return Number(this.toString());
  }

  toString(): string {
    return `${this.c}e${this.e}`;
  }
}
