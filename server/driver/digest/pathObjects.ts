/*
 * The document digest: a simplified, plot-ready model of an SVG document
 * (layers of polylines, in inches), its layer-name syntax, and the "plob"
 * (plot object) SVG subset it reads and writes.
 *
 * Ported from nextdrawcore/path_objects.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/path_objects.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Vertices are mutable [x, y] arrays and, as in Python, may be shared between
 * paths after joining or random-start rotation; code that edits a vertex in
 * place (crop_by_distance) sees that aliasing exactly as nextdraw does.
 */

import { DOMParser } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import { formatFixed } from "../pyfmt.ts";
import { pyFloat } from "../run/status.ts";
import { pySplit } from "../svg/pycompat.ts";
import {
  parseLengthWithUnits,
  pointsEqual,
  pointsNear,
} from "../svg/plotUtils.ts";
import type { Vertex } from "../svg/plotUtils.ts";

export type { Vertex };

export const PLOB_BASE = `<?xml version="1.0" standalone="no"?>
<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:nd="https://bantam.tools/nd"
   version="1.1">
   </svg>
`;

export const PLOB_VERSION = "1";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
export const SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd";
export const ND_NS = "https://bantam.tools/nd";

export class PathItem {
  subpaths: Vertex[][] = null as unknown as Vertex[][];
  stroke: string | null = null;
  fill: string | null = null;
  fill_rule: string | null = null;
  item_id: string = null as unknown as string;
  flat_length: number | null = null;

  static fromAttrs(attrs: {
    subpaths?: Vertex[][];
    stroke?: string | null;
    fill?: string | null;
    fill_rule?: string | null;
    item_id?: string;
  }): PathItem {
    const p = new PathItem();
    if (attrs.subpaths !== undefined) p.subpaths = attrs.subpaths;
    p.stroke = attrs.stroke ?? null;
    p.fill = attrs.fill ?? null;
    p.fill_rule = attrs.fill_rule ?? null;
    if (attrs.item_id !== undefined) p.item_id = attrs.item_id;
    return p;
  }

  toString(): string | null {
    return vertexListToString(this.subpaths[0]);
  }

  fromString(polylineString: string | null): void {
    this.subpaths = [polylineStringToList(polylineString) as Vertex[]];
  }

  firstPoint(): Vertex | null {
    if (this.subpaths !== null) return this.subpaths[0][0];
    return null;
  }

  lastPoint(): Vertex | null {
    if (this.subpaths && this.subpaths.length) {
      const sp = this.subpaths[0];
      return sp[sp.length - 1];
    }
    return null;
  }

  /** Length of the first subpath, cached in flat_length. */
  length(): number {
    if (this.subpaths === null) return 0;
    if (this.flat_length !== null) return this.flat_length;
    const subpath = this.subpaths[0];
    const last = subpath.length - 1;
    let total = 0;
    for (let i = 0; i < last; i++) {
      const dx = subpath[i + 1][0] - subpath[i][0];
      const dy = subpath[i + 1][1] - subpath[i][1];
      total += Math.sqrt(dx * dx + dy * dy);
    }
    this.flat_length = total;
    return total;
  }

  /** Remove the first `target` inches of the first subpath. */
  cropByDistance(target: number): void {
    if (this.subpaths === null) return;
    if (target < 0) return;
    const subpath = this.subpaths[0];
    const last = subpath.length - 1;
    let subpathLength = 0;
    let index = 0;
    let dx = NaN;
    let dy = NaN;
    let segDist: number | undefined;
    while (index < last) {
      dx = subpath[index + 1][0] - subpath[index][0];
      dy = subpath[index + 1][1] - subpath[index][1];
      segDist = Math.sqrt(dx * dx + dy * dy);
      if (subpathLength + segDist > target) break;
      index += 1;
      subpathLength += segDist;
    }
    if (index === last) {
      subpath.splice(0, subpath.length);
      this.flat_length = null;
      return;
    }
    if (segDist === undefined) {
      throw new ReferenceError(
        "local variable 'this_seg_dist' referenced before assignment"
      );
    }
    const fraction = (target - subpathLength) / segDist;
    dx = dx * fraction;
    dy = dy * fraction;
    // nextdraw quirk: edits the vertex in place, so a vertex shared with
    // another position (randomize_start duplicates its new endpoint) moves
    // too (nextdrawcore/path_objects.py:221-222).
    subpath[index][0] = subpath[index][0] + dx;
    subpath[index][1] = subpath[index][1] + dy;
    subpath.splice(0, index);
    this.flat_length = null;
  }

  /** True for a single subpath whose ends are within 1e-4 inch. */
  closed(): boolean {
    if (this.subpaths && this.subpaths.length) {
      if (this.subpaths.length === 1) {
        const sp = this.subpaths[0];
        return pointsNear(sp[0], sp[sp.length - 1], 0.00000001);
      }
    }
    return false;
  }

  hasStroke(): boolean {
    return String(this.stroke ?? "None").toLowerCase() !== "none";
  }

  reverse(): void {
    if (this.subpaths && this.subpaths.length === 1) this.subpaths[0].reverse();
  }

  static equalListsOfPoints(a: Vertex[], b: Vertex[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!pointsEqual(a[i], b[i])) return false;
    }
    return true;
  }
}

/** Python str.isdigit() restricted to decimal digits (Unicode Nd). */
function isDigits(chars: string[]): boolean {
  return chars.length > 0 && chars.every((c) => /^\p{Nd}$/u.test(c));
}

/** Value of a Unicode Nd digit: its offset in its run of ten. */
function digitValue(c: string): number {
  let cp = c.codePointAt(0) as number;
  let offset = 0;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    offset += 1;
  }
  return offset % 10;
}

/**
 * find_int: leading decimal integer of a string (as code points).
 * Returns [value, remainder] or [null, original].
 */
export function findInt(name: string[]): [number | null, string[]] {
  let numLen = 0;
  for (let pos = 1; pos <= name.length; pos++) {
    if (isDigits(name.slice(0, pos))) numLen = pos;
    else break;
  }
  if (numLen === 0) return [null, name];
  let value = 0;
  for (const c of name.slice(0, numLen)) value = value * 10 + digitValue(c);
  return [value, name.slice(numLen)];
}

/** Properties encoded in a layer name (see docs/prior-art/nextdraw-driver.md §3.4). */
export class LayerProperties {
  skip = false;
  number: number | null = null;
  pause = false;
  delay: number | null = null;
  speed: number | null = null;
  height: number | null = null;
  handling: number | null = null;
  reorder: number | null = null;
  text = "";

  parse(layerName: string | null): void {
    if (!layerName) return;
    // nextdraw quirk: `layer_name.strip()` discards its result, so leading
    // whitespace defeats the '%' and '!' checks (nextdrawcore/path_objects.py:318).
    let chars = Array.from(layerName);
    if (chars[0] === "%") {
      this.skip = true;
      this.text = chars.slice(1).join("");
      return;
    }
    if (chars[0] === "!") {
      this.pause = true;
      chars = chars.slice(1);
    }
    let remainder: string[];
    [this.number, remainder] = findInt(chars);

    while (remainder.length >= 3) {
      const key = remainder.slice(0, 2).join("").toLowerCase();
      if (["+h", "+s", "+d", "+m", "+g"].includes(key)) {
        remainder = remainder.slice(2);
        let n: number | null;
        [n, remainder] = findInt(remainder);
        if (n !== null) {
          if (key === "+d" && n > 0) this.delay = n;
          if (key === "+h" && n >= 0 && n <= 100) this.height = n;
          if (key === "+s" && n >= 1 && n <= 110) this.speed = n;
          if (key === "+m" && n >= 1 && n <= 4) this.handling = n;
          if (key === "+g" && n >= 0 && n <= 4) this.reorder = n;
        }
      } else {
        this.text = remainder.join("");
        break;
      }
    }
  }

  compose(): string {
    let s = "";
    if (this.skip) return "%" + this.text;
    if (this.pause) s = "!";
    if (this.number !== null) s += `${this.number}`;
    if (this.delay !== null) s += `+d${this.delay}`;
    if (this.height !== null) s += `+h${this.height}`;
    if (this.speed !== null) s += `+s${this.speed}`;
    if (this.handling !== null) s += `+m${this.handling}`;
    if (this.reorder !== null) s += `+g${this.reorder}`;
    return s + this.text;
  }
}

export class LayerItem {
  name = "";
  paths: PathItem[] = [];
  item_id: string = null as unknown as string;
  props = new LayerProperties();

  /** Split multi-subpath paths into one PathItem per subpath; drop styles. */
  flatten(): void {
    if (!this.paths.length) return;
    const newPaths: PathItem[] = [];
    for (const path of this.paths) {
      if (path.subpaths.length === 1) {
        path.stroke = null;
        path.fill = null;
        path.fill_rule = null;
        newPaths.push(path);
        continue;
      }
      let counter = 0;
      for (const subpath of path.subpaths) {
        const np = new PathItem();
        np.item_id = path.item_id + "_f" + String(counter);
        counter += 1;
        np.subpaths = [subpath];
        newPaths.push(np);
      }
    }
    this.paths = newPaths;
  }

  parseName(layerName: string | null = null): void {
    this.props.parse(layerName === null ? this.name : layerName);
  }

  composeName(): string {
    return this.props.compose();
  }
}

export class DocDigest {
  name = "";
  width = 0; // inches
  height = 0; // inches
  viewbox = "";
  plotdata: Record<string, string> = { plob_version: PLOB_VERSION };
  metadata: Record<string, string> = {};
  flat = false;
  layers: LayerItem[] = [];

  flatten(): void {
    if (this.flat) return;
    if (!this.layers.length) return;
    for (const layer of this.layers) layer.flatten();
    this.flat = true;
  }

  /** Remove paths without a stroke (hidden-line removal). */
  removeUnstroked(): void {
    for (const layer of this.layers) {
      layer.paths = layer.paths.filter(
        (p) => String(p.stroke ?? "None").toLowerCase() !== "none"
      );
    }
  }

  /** In layers mode (layerNumber >= 0), drop layers with other numbers. */
  layerFilter(layerNumber: number): void {
    if (layerNumber < 0) return;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const n = this.layers[i].props.number;
      if (n === null || n !== layerNumber) this.layers.splice(i, 1);
    }
  }

  /** Rotate the document 90 degrees (portrait to landscape). */
  rotate(rotateCcw = true): void {
    const oldWidth = this.width;
    this.width = this.height;
    this.height = oldWidth;
    this.viewbox = `0 0 ${formatFixed(this.width, 6)} ${formatFixed(this.height, 6)}`;
    for (const layer of this.layers) {
      for (const path of layer.paths) {
        const newSubpaths: Vertex[][] = [];
        for (const vertexList of path.subpaths) {
          if (vertexList.length < 2) {
            vertexList.splice(0, vertexList.length);
            continue;
          }
          newSubpaths.push(
            vertexList.map(([vx, vy]) =>
              rotateCcw ? [vy, this.height - vx] : [this.width - vy, vx]
            )
          );
        }
        path.subpaths = newSubpaths;
      }
    }
  }

  /**
   * to_plob: the digest as a plob document. Flattens the digest first.
   * Child elements are created without a namespace, as lxml's
   * SubElement(plob, 'g') does; serialization is left to the caller.
   */
  toPlob(): Document {
    const doc = new DOMParser().parseFromString(PLOB_BASE, "text/xml");
    const plob = doc.documentElement as Element;
    plob.setAttribute("encoding", "UTF-8");
    plob.setAttribute("width", `${formatFixed(this.width, 6)}in`);
    plob.setAttribute("height", `${formatFixed(this.height, 6)}in`);
    plob.setAttribute("viewBox", String(this.viewbox));
    plob.setAttributeNS(SODIPODI_NS, "sodipodi:docname", this.name);

    if (!this.flat) this.flatten();

    const meta = doc.createElementNS(null, "metadata");
    for (const [k, v] of Object.entries(this.metadata))
      setPyAttr(meta, k, String(v));
    plob.appendChild(meta);

    const plotdata = doc.createElementNS(ND_NS, "nd:plotdata");
    for (const [k, v] of Object.entries(this.plotdata))
      setPyAttr(plotdata, k, String(v));
    plob.appendChild(plotdata);

    for (const layer of this.layers) {
      const g = doc.createElementNS(null, "g");
      g.setAttributeNS(INKSCAPE_NS, "inkscape:groupmode", "layer");
      if (layer.name === "__digest-root__") {
        g.setAttributeNS(INKSCAPE_NS, "inkscape:label", layer.name);
      } else {
        let label = layer.composeName();
        if (label === "") label = `layer_${layer.item_id}`;
        g.setAttributeNS(INKSCAPE_NS, "inkscape:label", label);
        g.setAttribute("id", layer.item_id);
      }
      plob.appendChild(g);
      for (const path of layer.paths) {
        const points = vertexListToString(path.subpaths[0]);
        if (points) {
          const pl = doc.createElementNS(null, "polyline");
          pl.setAttribute("id", path.item_id);
          pl.setAttribute("points", points);
          g.appendChild(pl);
        }
      }
    }
    return doc;
  }

  /**
   * from_plob: replace this digest's contents with a plob's. When the
   * document size in inches is given, coordinates are rescaled from the
   * plob's units to inches.
   */
  fromPlob(
    plob: Element,
    svgWidthInches: number | null = null,
    svgHeightInches: number | null = null
  ): void {
    this.name = "";
    this.width = 0;
    this.height = 0;
    this.viewbox = "";
    this.plotdata = {};
    this.metadata = {};
    this.layers = [];
    this.flat = true;

    const docname = plob.getAttributeNS(SODIPODI_NS, "docname");
    if (docname) this.name = docname;

    let scale = 1.0;
    let ls = getPlainAttr(plob, "width");
    if (ls) {
      const [value] = parseLengthWithUnits(ls);
      if (svgWidthInches !== null && value) {
        scale = svgWidthInches / value;
        this.width = svgWidthInches;
      } else {
        this.width = value as number;
      }
    }
    ls = getPlainAttr(plob, "height");
    if (ls) {
      const [value] = parseLengthWithUnits(ls);
      if (svgHeightInches !== null && value) this.height = svgHeightInches;
      else this.height = value as number;
    }

    const vb = getPlainAttr(plob, "viewBox");
    if (vb) {
      if (scale !== 1.0) {
        // Python's str.split(), then float(): a bad value raises.
        const coords = pySplit(vb).map(pyFloat);
        this.viewbox = coords.map((c) => formatFixed(c * scale, 6)).join(" ");
      } else {
        this.viewbox = vb;
      }
    }

    for (const node of childElements(plob)) {
      const tag = lxmlTag(node);
      if (tag === "g" || tag === `{${SVG_NS}}g`) {
        const nameTemp = node.getAttributeNS(INKSCAPE_NS, "label");
        if (!nameTemp) continue;
        const layer = new LayerItem();
        layer.item_id = getPlainAttr(node, "id") as string;
        layer.name = nameTemp;
        layer.parseName();
        if (nameTemp[0] === "%") continue;
        for (const sub of childElements(node)) {
          const st = lxmlTag(sub);
          if (st === "polyline" || st === `{${SVG_NS}}polyline`) {
            const path = new PathItem();
            path.fromString(getPlainAttr(sub, "points"));
            if (scale !== 1.0) {
              for (const subpath of path.subpaths) {
                // Python iterates the list; a None subpath raises TypeError.
                if (subpath === null)
                  throw new TypeError("'NoneType' object is not iterable");
                for (let i = 0; i < subpath.length; i++) {
                  subpath[i] = [subpath[i][0] * scale, subpath[i][1] * scale];
                }
              }
            }
            path.item_id = getPlainAttr(sub, "id") as string;
            layer.paths.push(path);
          }
        }
        this.layers.push(layer);
      }
      if (tag === "metadata") this.metadata = pyAttrib(node);
      if (tag === "plotdata") this.plotdata = pyAttrib(node);
    }
  }

  /**
   * Remove the first `distance` inches of pen-down travel, for resuming a
   * plot. For use on a flat digest after optimizations.
   */
  crop(distance: number): void {
    if (distance <= 0) return;
    let distSoFar = 0;
    let spliceMade = false;
    for (const layer of this.layers) {
      let startIndex = 0;
      for (const path of layer.paths) {
        const pathLength = path.length();
        const skipTol = Math.min(pathLength / 100, 0.001);
        if (distSoFar + pathLength <= distance + skipTol) {
          distSoFar += pathLength;
          startIndex += 1;
          layer.props.delay = null;
          continue;
        }
        if (distance > distSoFar) {
          layer.props.delay = null;
          path.cropByDistance(distance - distSoFar);
        }
        layer.props.pause = false;
        spliceMade = true;
        break;
      }
      layer.paths = layer.paths.slice(startIndex);
      if (layer.paths.length === 0) layer.name = "__MARKED_FOR_DELETION__";
      if (spliceMade) break;
    }
    this.layers = this.layers.filter(
      (l) => l.name !== "__MARKED_FOR_DELETION__"
    );
  }

  /** Total pen-down length of a flat digest. */
  length(): number {
    let total = 0;
    for (const layer of this.layers) {
      for (const path of layer.paths) total += path.length();
    }
    return total;
  }
}

/** vertex_list_to_string: polyline "points" with '%f' coordinates, or null. */
export function vertexListToString(vertexList: Vertex[] | null): string | null {
  if (!vertexList || vertexList.length < 2) return null;
  return vertexList
    .map((v) => `${formatFixed(v[0], 6)},${formatFixed(v[1], 6)}`)
    .join(" ");
}

/** polyline_string_to_list: parse polyline "points", or null on any error. */
export function polylineStringToList(s: string | null): Vertex[] | null {
  if (!s) return null;
  try {
    return pySplit(s).map((x) => x.split(",").map(pyFloat));
  } catch {
    return null;
  }
}

/** lxml-style tag: "{namespace}local" or "local". */
export function lxmlTag(el: Element): string {
  return el.namespaceURI
    ? `{${el.namespaceURI}}${el.localName}`
    : (el.localName as string);
}

/** Element children only (lxml also yields comments and PIs, which nextdraw ignores). */
export function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

/** lxml element.get(name) for an attribute in no namespace; null when absent. */
export function getPlainAttr(el: Element, name: string): string | null {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (!a.namespaceURI && a.localName === name && a.prefix === null)
      return a.value;
  }
  return null;
}

/** dict(node.attrib): keys in lxml "{ns}name" form, document order. */
export function pyAttrib(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
    const key = a.namespaceURI
      ? `{${a.namespaceURI}}${a.localName}`
      : (a.localName as string);
    out[key] = a.value;
  }
  return out;
}

/** element.set(key, value) with a possibly "{ns}name" key. */
function setPyAttr(el: Element, key: string, value: string): void {
  const m = /^\{([^}]*)\}(.*)$/.exec(key);
  if (m) el.setAttributeNS(m[1], m[2], value);
  else el.setAttribute(key, value);
}
