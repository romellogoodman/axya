/*
 * CPython-compatible Mersenne Twister: random.seed(int), getrandbits,
 * random(), and randrange(n), bit-exact with CPython 3.x.
 *
 * Ported from CPython's Modules/_randommodule.c (init_genrand,
 * init_by_array, genrand_uint32, random_seed for int arguments,
 * random_random, getrandbits) and Lib/random.py (randrange,
 * _randbelow_with_getrandbits). Those derive from the MT19937 reference
 * code, Copyright (C) 1997 - 2002, Makoto Matsumoto and Takuji Nishimura,
 * BSD-licensed; CPython is under the Python Software Foundation License.
 * Original TypeScript for axya, distributed under AGPL-3.0.
 *
 * nextdraw uses only random.seed(int) and random.randrange(n)
 * (nextdrawcore/plot_optimizations.py:243-252).
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed?: number | bigint | null) {
    this.seed(seed ?? null);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const len = key.length;
    for (let k = N > len ? N : len; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= len) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /**
   * random.seed(a) for an int `a` (abs value, split into 32-bit words, least
   * significant first). null seeds from the OS, as Python does.
   */
  seed(a: number | bigint | null): void {
    if (a === null) {
      const words = new Uint32Array(N);
      crypto.getRandomValues(words);
      this.initByArray(Array.from(words));
      return;
    }
    if (typeof a === "number" && !Number.isInteger(a)) {
      // Python hashes float seeds; nextdraw only passes ints.
      throw new TypeError("PyRandom.seed supports integer seeds only");
    }
    let n = BigInt(a);
    if (n < 0n) n = -n;
    const key: number[] = [];
    if (n === 0n) key.push(0);
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    this.initByArray(key);
  }

  /** genrand_uint32 */
  genrandUint32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      const y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53-bit float in [0, 1). */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** random.getrandbits(k), as a bigint (words filled least significant first). */
  getrandbits(k: number): bigint {
    if (k < 0) throw new RangeError("number of bits must be non-negative");
    if (k === 0) return 0n;
    if (k <= 32) return BigInt(this.genrandUint32() >>> (32 - k));
    let result = 0n;
    let shift = 0n;
    for (let remaining = k; remaining > 0; remaining -= 32) {
      let r = this.genrandUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      result |= BigInt(r) << shift;
      shift += 32n;
    }
    return result;
  }

  /** _randbelow_with_getrandbits(n), n > 0 */
  randbelow(n: number): number {
    const big = BigInt(n);
    const k = big.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= big) r = this.getrandbits(k);
    return Number(r);
  }

  /** random.randrange(stop) */
  randrange(stop: number): number {
    if (!Number.isInteger(stop))
      throw new TypeError("randrange() needs an integer");
    if (stop > 0) return this.randbelow(stop);
    throw new RangeError("empty range for randrange()");
  }
}
