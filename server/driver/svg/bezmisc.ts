/*
 * Bezier helpers used by curve flattening.
 *
 * Ported from ink_extensions/bezmisc.py (ink_extensions 1.x, as installed
 * for nextdraw 1.7.5): tpoint, beziersplitatt.
 * Copyright (C) 2010 Nick Drobchenko, nick@cnc-club.ru
 * Copyright (C) 2005 Aaron Spike, aaron@ekips.org
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

export type Pt = readonly number[];
export type Bezier = [Pt, Pt, Pt, Pt];

export function tpoint(param1: Pt, param2: Pt, t: number): Pt {
  const [x1, y1] = param1;
  const [x2, y2] = param2;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** de Casteljau split of a cubic at t. */
export function beziersplitatt(param1: Bezier, t: number): [Bezier, Bezier] {
  const [b0, b1, b2, b3] = param1;
  const m1 = tpoint(b0, b1, t);
  const m2 = tpoint(b1, b2, t);
  const m3 = tpoint(b2, b3, t);
  const m4 = tpoint(m1, m2, t);
  const m5 = tpoint(m2, m3, t);
  const m = tpoint(m4, m5, t);
  return [
    [[b0[0], b0[1]], m1, m4, m],
    [m, m5, m3, [b3[0], b3[1]]],
  ];
}
