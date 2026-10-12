/*
 * SVG path-data parsing into absolute M/L/C/Q/A/Z commands.
 *
 * Ported from ink_extensions/simplepath.py (ink_extensions 1.x, as installed
 * for nextdraw 1.7.5): parse_string, parsePath, formatPath.
 * Copyright (C) 2005 Aaron Spike, aaron@ekips.org.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { formatFloat } from "../pyfmt.ts";
import { pyFloat } from "../run/status.ts";
import { pyIntOfFloat } from "./pycompat.ts";

export type PathCommand = [string, number[]];

const LEX_REX = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;

// Built from the same parts as simplepath.NUMBER_REX so alternation order matches.
const DIGITS = "(?:[0-9]+)";
const SIGN = "[+-]";
const EXPONENT = `(?:[eE]${SIGN}?${DIGITS})`;
const FRACTIONAL = `(?:${DIGITS}?\\.${DIGITS}|${DIGITS}\\.)`;
const FLOATING = `(?:${FRACTIONAL}${EXPONENT}?|${DIGITS}${EXPONENT})`;
const NUMBER_REX = new RegExp(`(?:${SIGN}?${FLOATING}|${SIGN}?${DIGITS})`, "g");

type Coord = "x" | "y" | "r" | "a" | "s" | 0;

const PATHDEFS: Record<string, [number, Coord[]]> = {
  M: [2, ["x", "y"]],
  L: [2, ["x", "y"]],
  H: [1, ["x"]],
  V: [1, ["y"]],
  C: [6, ["x", "y", "x", "y", "x", "y"]],
  S: [4, ["x", "y", "x", "y"]],
  Q: [4, ["x", "y", "x", "y"]],
  T: [2, ["x", "y"]],
  A: [7, ["r", "r", "a", 0, "s", "x", "y"]],
  Z: [0, []],
};

const IMPLICIT_NEXT_CMDS: Record<string, string> = {
  M: "L",
  m: "l",
  L: "L",
  l: "l",
  H: "H",
  h: "h",
  V: "V",
  v: "v",
  C: "C",
  c: "c",
  S: "S",
  s: "s",
  Q: "Q",
  q: "q",
  T: "T",
  t: "t",
  A: "A",
  a: "a",
  Z: "L",
  z: "l",
};

/** simplepath.parse_string: (command, args) pairs, implicit repeats expanded. */
export function parseString(pathD: string): [string, number[]][] {
  const out: [string, number[]][] = [];
  for (const m of pathD.matchAll(LEX_REX)) {
    let cmd = m[1];
    const args = (m[2].match(NUMBER_REX) ?? []).map(pyFloat);
    let numParams = PATHDEFS[cmd.toUpperCase()][0];
    const next = IMPLICIT_NEXT_CMDS[cmd];
    let i = 0;
    while (i < args.length || numParams === 0) {
      // nextdraw quirk: a short argument list ends parsing of the whole path,
      // not just this command (ink_extensions/simplepath.py:111-112).
      if (args.slice(i, i + numParams).length !== numParams) return out;
      out.push([cmd, args.slice(i, i + numParams)]);
      i += numParams;
      cmd = next;
      numParams = PATHDEFS[cmd.toUpperCase()][0];
    }
  }
  return out;
}

/**
 * simplepath.parsePath: absolute coordinates; H/V become L, S becomes C,
 * T becomes Q. Arc flags are truncated with int(), as in Python.
 */
export function parsePath(d: string): PathCommand[] {
  const retval: PathCommand[] = [];
  let pen: number[] = [0.0, 0.0];
  let subPathStart = pen;
  let lastControl = pen;
  let lastCommand = "";

  for (const [cmd, args] of parseString(d)) {
    const cmdUpper = cmd.toUpperCase();
    if (!lastCommand && cmdUpper !== "M") {
      throw new Error("Invalid path, must begin with moveto.");
    }
    const coords = PATHDEFS[cmdUpper][1];
    const relative = cmd !== cmdUpper;
    const params: number[] = [];
    args.forEach((value, index) => {
      // The arc's flag parameters are cast with int(); everything else float().
      let param =
        cmdUpper === "A" && (index === 3 || index === 4)
          ? pyIntOfFloat(value)
          : value;
      if (relative) {
        if (coords[index] === "x") param += pen[0];
        else if (coords[index] === "y") param += pen[1];
      }
      params.push(param);
    });
    let outputCommand = cmdUpper;

    if (outputCommand === "H" || outputCommand === "V") {
      if (outputCommand === "H") params.push(pen[1]);
      if (outputCommand === "V") params.unshift(pen[0]);
      outputCommand = "L";
    }
    if (outputCommand === "S" || outputCommand === "T") {
      params.unshift(pen[1] + (pen[1] - lastControl[1]));
      params.unshift(pen[0] + (pen[0] - lastControl[0]));
      if (outputCommand === "S") outputCommand = "C";
      if (outputCommand === "T") outputCommand = "Q";
    }

    if (outputCommand === "M") {
      subPathStart = params.slice(0, 2);
      pen = subPathStart;
    }
    if (outputCommand === "Z") {
      pen = subPathStart;
    } else {
      pen = params.slice(-2);
    }

    if (outputCommand === "Q" || outputCommand === "C") {
      lastControl = params.slice(-4, -2);
    } else {
      lastControl = pen;
    }
    lastCommand = cmdUpper;
    retval.push([outputCommand, params]);
  }
  return retval;
}

/**
 * simplepath.formatPath: values written with Python's str(). Arc flags are
 * Python ints after parsePath, so they print without ".0". (Other int
 * parameters, such as the literal 0 rotation in nextdraw's rect arcs, print
 * as floats here; the text differs but parses to the same values.)
 */
export function formatPath(a: PathCommand[]): string {
  return a
    .map(([cmd, params]) => {
      const isArc = cmd.trim().toUpperCase() === "A";
      const parts = params.map((p, i) =>
        isArc && (i === 3 || i === 4) && Number.isInteger(p)
          ? String(p)
          : formatFloat(p)
      );
      return cmd + parts.join(" ");
    })
    .join("");
}
