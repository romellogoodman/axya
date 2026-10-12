/*
 * Inline CSS style attribute parsing.
 *
 * Ported from ink_extensions/simplestyle.py (ink_extensions 1.x, as installed
 * for nextdraw 1.7.5): parseStyle, formatStyle.
 * Copyright (C) 2005 Aaron Spike, aaron@ekips.org.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { pyStrip } from "./pycompat.ts";

/**
 * parseStyle. A declaration with no colon, or more than one, throws (Python's
 * dict() raises ValueError on such pairs), e.g. `background:url(a:b)`.
 */
export function parseStyle(s: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (s === null) return out;
  for (const item of s.split(";")) {
    if (!pyStrip(item).length) continue;
    const pair = item.split(":").map(pyStrip);
    if (pair.length !== 2) {
      throw new RangeError(
        `dictionary update sequence element has length ${pair.length}; 2 is required`
      );
    }
    out.set(pair[0], pair[1]);
  }
  return out;
}

export function formatStyle(a: Map<string, string>): string {
  return [...a].map(([att, val]) => `${att}:${val}`).join(";");
}
