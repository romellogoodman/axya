/**
 * CPython (macOS libm) results for every sin/cos/tan/acos call the digest
 * makes on the oracle fixtures, recorded by wrapping the math functions in
 * ink_extensions.cubicsuperpath and simpletransform while running each stage
 * case through test/oracle/run.py (Python 3.14.7, macOS arm64).
 *
 * V8's Math functions differ from these by one ulp on a few inputs (see
 * server/driver/svg/libm.ts). digestLibmReplay() substitutes the recorded
 * values so the stage tests can compare everything downstream exactly.
 */

import type { Libm } from "../../server/driver/svg/libm.ts";

type Fn = "sin" | "cos" | "tan" | "acos";

export const PYTHON_LIBM: [Fn, number, number][] = [
  ["acos", -1.0, 3.141592653589793],
  ["acos", -0.9999999999999999, 3.141592638688632],
  ["acos", -0.2919660488924069, 1.8670781361661803],
  ["acos", 0.9915276001614838, 0.1302642739583117],
  ["acos", 1.0, 0.0],
  ["cos", -6.152921033221274, 0.9915276001614837],
  ["cos", -4.7243067342029095, 0.011917471701454324],
  ["cos", -3.295692435184545, -0.9881501062233802],
  ["cos", -1.8670781361661803, -0.29196604889240685],
  ["cos", -0.5235987755982988, 0.8660254037844387],
  ["cos", 0.0, 1.0],
  ["cos", 0.2617993877991494, 0.9659258262890683],
  ["cos", 0.5235987755982988, 0.8660254037844387],
  ["cos", 0.7853981633974483, 0.7071067811865476],
  ["cos", 1.0471975511965976, 0.5000000000000001],
  ["cos", 1.0471975561636515, 0.49999999569840525],
  ["cos", 2.0943951023931953, -0.49999999999999983],
  ["cos", 2.094395112327303, -0.5000000086031895],
  ["cos", 3.141592653589793, -1.0],
  ["cos", 3.1415926684909543, -0.9999999999999999],
  ["cos", 4.1887902047863905, -0.5000000000000004],
  ["cos", 5.235987755982988, 0.49999999999999933],
  ["cos", 6.283185307179586, 1.0],
  ["sin", -6.152921033221274, 0.1298961820763374],
  ["sin", -4.7243067342029095, 0.9999289844125157],
  ["sin", -3.295692435184545, 0.15349061069238856],
  ["sin", -1.8670781361661803, -0.9564286833288496],
  ["sin", -0.5235987755982988, -0.49999999999999994],
  ["sin", 0.0, 0.0],
  ["sin", 0.2617993877991494, 0.25881904510252074],
  ["sin", 0.5235987755982988, 0.49999999999999994],
  ["sin", 0.7853981633974483, 0.7071067811865475],
  ["sin", 1.0471975511965976, 0.8660254037844386],
  ["sin", 1.0471975561636515, 0.8660254062679655],
  ["sin", 2.0943951023931953, 0.8660254037844387],
  ["sin", 2.094395112327303, 0.8660253988173848],
  ["sin", 3.141592653589793, 1.2246467991473532e-16],
  ["sin", 3.1415926684909543, -1.4901161071382976e-8],
  ["sin", 4.1887902047863905, -0.8660254037844384],
  ["sin", 5.235987755982988, -0.866025403784439],
  ["sin", 6.283185307179586, -2.4492935982947064e-16],
  ["tan", -0.35715357475459114, -0.3731566166678645],
  ["tan", 0.2617993877991494, 0.2679491924311227],
  ["tan", 0.2617993890409129, 0.2679491937620408],
  ["tan", 0.3490658503988659, 0.36397023426620234],
];

/** Libm overrides that return the recorded CPython value for recorded inputs. */
export function digestLibmReplay(
  extra: [string, number, number][] = []
): Partial<Libm> {
  const table = new Map<string, number>();
  for (const [fn, x, r] of [...PYTHON_LIBM, ...extra])
    table.set(`${fn}:${x}`, r);
  const replay = (fn: Fn) => (x: number) =>
    table.get(`${fn}:${x}`) ?? Math[fn](x);
  return {
    sin: replay("sin"),
    cos: replay("cos"),
    tan: replay("tan"),
    acos: replay("acos"),
  };
}
