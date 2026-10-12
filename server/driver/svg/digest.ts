/*
 * SVG document to DocDigest: traversal, style inheritance, shape-to-path
 * conversion, curve flattening, and plob verification.
 *
 * Ported from nextdrawcore/digest_svg.py (nextdraw 1.7.5) and the document
 * set-up in NextDraw.get_doc_props / prepare_document
 * (nextdrawcore/nextdraw.py:592-606, :995-1012),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import type { Element } from "@xmldom/xmldom";
import type { ConfigState, Params } from "../config.ts";
import { findCurveTolerance } from "../models.ts";
import { formatFixed } from "../pyfmt.ts";
import { pyFloat } from "../run/status.ts";
import type { PlotWarnings } from "../warnings.ts";
import {
  DocDigest,
  LayerItem,
  PathItem,
  PLOB_VERSION,
  childElements,
  getPlainAttr,
  lxmlTag,
  pyAttrib,
} from "../digest/pathObjects.ts";
import type { Vertex } from "../digest/pathObjects.ts";
import { cubicSuperPath } from "./cubicsuperpath.ts";
import type { CubicSuperPath } from "./cubicsuperpath.ts";
import { formatExp, pySplit, pyStrip } from "./pycompat.ts";
import {
  PX_PER_INCH,
  getLengthInches,
  parseLengthWithUnits,
  subdivideCubicPath,
  unitsToUserUnits,
  vbScale2,
} from "./plotUtils.ts";
import { formatPath, parsePath } from "./simplepath.ts";
import type { PathCommand } from "./simplepath.ts";
import { composeTransform, parseTransform } from "./simpletransform.ts";
import type { Matrix } from "./simpletransform.ts";
import { parseStyle } from "./simplestyle.ts";

const SVG = "{http://www.w3.org/2000/svg}";
const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd";

/** What the digest needs from nextdraw's NextDraw object. */
export interface DigestContext {
  /** params.curve_tolerance and params.overrides.curve_tolerance */
  params: Pick<Params, "curve_tolerance" | "overrides">;
  /** Document size in inches (from docProps). */
  svg_width: number;
  svg_height: number;
  /** Receives text, image and unsupported-element warnings. */
  warnings: PlotWarnings;
}

export interface StyleDict {
  fill: string | null;
  stroke: string | null;
  "fill-rule": string | null;
  visibility: string | null;
  display: string | null;
}

const tagIs = (tag: string, ...names: string[]) =>
  names.some((n) => tag === n || tag === SVG + n);

// ---------------------------------------------------------------------------
// Shape-to-path conversion (digest_svg.py:51-211)

function orZero(v: number | null): number {
  return v !== null ? v : 0.0;
}

export function convertRectToPath(
  el: Element,
  docWidth100 = 1.0,
  docHeight100 = 1.0
): string {
  const x = orZero(unitsToUserUnits(getPlainAttr(el, "x") ?? "0", docWidth100));
  const y = orZero(
    unitsToUserUnits(getPlainAttr(el, "y") ?? "0", docHeight100)
  );
  let rX = orZero(unitsToUserUnits(getPlainAttr(el, "rx"), docWidth100));
  const width = orZero(
    unitsToUserUnits(getPlainAttr(el, "width"), docWidth100)
  );
  let rY = orZero(unitsToUserUnits(getPlainAttr(el, "ry"), docHeight100));
  const height = orZero(
    unitsToUserUnits(getPlainAttr(el, "height"), docHeight100)
  );

  const calcR = (attr: number, twiceMax: number) => {
    if (twiceMax <= 0) return 0;
    const half = twiceMax * 0.5;
    return half < attr ? half : attr;
  };
  // nextdraw quirk: a missing rx/ry has already become 0.0 above, so rx and
  // ry never default to each other (nextdrawcore/digest_svg.py:70-85).
  rX = calcR(rX, width);
  rY = calcR(rY, height);

  const instr: PathCommand[] = [];
  if (rX > 0 || rY > 0) {
    instr.push(["M ", [x + rX, y]]);
    instr.push([" L ", [x + width - rX, y]]);
    instr.push([" A ", [rX, rY, 0, 0, 1, x + width, y + rY]]);
    instr.push([" L ", [x + width, y + height - rY]]);
    instr.push([" A ", [rX, rY, 0, 0, 1, x + width - rX, y + height]]);
    instr.push([" L ", [x + rX, y + height]]);
    instr.push([" A ", [rX, rY, 0, 0, 1, x, y + height - rY]]);
    instr.push([" L ", [x, y + rY]]);
    instr.push([" A ", [rX, rY, 0, 0, 1, x + rX, y]]);
  } else {
    instr.push(["M ", [x, y]]);
    instr.push([" L ", [x + width, y]]);
    instr.push([" L ", [x + width, y + height]]);
    instr.push([" L ", [x, y + height]]);
    instr.push([" L ", [x, y]]);
  }
  return formatPath(instr);
}

export function convertLineToPath(
  el: Element,
  docWidth100 = 1.0,
  docHeight100 = 1.0
): string {
  const [x1, x2] = ["x1", "x2"].map((a) =>
    orZero(unitsToUserUnits(getPlainAttr(el, a) ?? "0", docWidth100))
  );
  const [y1, y2] = ["y1", "y2"].map((a) =>
    orZero(unitsToUserUnits(getPlainAttr(el, a) ?? "0", docHeight100))
  );
  return formatPath([
    ["M ", [x1, y1]],
    [" L ", [x2, y2]],
  ]);
}

export function convertPolylinePolygonToPath(el: Element): string {
  const pl = pyStrip(getPlainAttr(el, "points") ?? "");
  if (pl === "") return "";
  const pa = pySplit(pl.replaceAll(",", " "));
  if (!pa.length) return "";
  if (pa.length < 4) return "";
  let d = "M " + pa[0] + " " + pa[1];
  let i = 2;
  while (i < pa.length - 1) {
    d += " L " + pa[i] + " " + pa[i + 1];
    i += 2;
  }
  if (tagIs(lxmlTag(el), "polygon")) d += " Z";
  return d;
}

export function convertCircleEllipseToPath(
  el: Element,
  docWidth100 = 1.0,
  docHeight100 = 1.0,
  diagonal100 = 1.0
): string {
  let rX: number | null;
  let rY: number | null;
  if (tagIs(lxmlTag(el), "circle")) {
    rX = unitsToUserUnits(getPlainAttr(el, "r") ?? "0", diagonal100);
    rY = rX;
  } else {
    rX = unitsToUserUnits(getPlainAttr(el, "rx") ?? "0", diagonal100);
    rY = unitsToUserUnits(getPlainAttr(el, "ry") ?? "0", diagonal100);
  }
  const rx = orZero(rX);
  const ry = orZero(rY);
  if (rx === 0 || ry === 0) return "";
  const cX = orZero(
    unitsToUserUnits(getPlainAttr(el, "cx") ?? "0", docWidth100)
  );
  const cY = orZero(
    unitsToUserUnits(getPlainAttr(el, "cy") ?? "0", docHeight100)
  );
  const f = (v: number) => formatFixed(v, 6);
  const startX = cX + rx;
  const leftX = cX - rx;
  // nextdraw quirk: the arc end points and radii pass through '%f', so they
  // are rounded to 6 decimal places in user units (digest_svg.py:205-209).
  return (
    `M ${f(startX)},${f(cY)} ` +
    `A ${f(rx)},${f(ry)} ` +
    `0 1 1 ${f(leftX)},${f(cY)} ` +
    `A ${f(rx)},${f(ry)} ` +
    `0 1 1 ${f(startX)},${f(cY)}`
  );
}

// ---------------------------------------------------------------------------
// Style inheritance (digest_svg.py:801-837)

export function inheritStyle(
  parentStyle: StyleDict | null,
  nodeStyle: Map<string, string | null> | null,
  visibility: string | null
): StyleDict {
  const defaults: StyleDict = {
    fill: null,
    stroke: null,
    "fill-rule": null,
    visibility: "visible",
    display: null,
  };
  const parent = parentStyle ?? defaults;
  const out: StyleDict = { ...parent };
  if (visibility) out.visibility = visibility;
  if (nodeStyle === null) return out;
  for (const attrib of [
    "fill",
    "stroke",
    "fill-rule",
    "visibility",
    "display",
  ] as const) {
    const value = nodeStyle.get(attrib);
    if (value) {
      out[attrib] = value === "inherit" ? parent[attrib] : value;
    }
  }
  return out;
}

/** apply_transform_to_path: apply a 2x3 matrix to every superpath point. */
export function applyTransformToPath(mat: Matrix, path: CubicSuperPath): void {
  const [[m00, m01, m02], [m10, m11, m12]] = mat;
  for (const comp of path) {
    for (const ctl of comp) {
      for (const point of ctl) {
        const x = point[0];
        const y = point[1];
        point[0] = m00 * x + m01 * y + m02;
        point[1] = m10 * x + m11 * y + m12;
      }
    }
  }
}

// Elements that the traversal skips silently (digest_svg.py:675-693).
const IGNORED_TAGS = new Set([
  `${SVG}defs`,
  "defs",
  "namedview",
  `{${SODIPODI_NS}}namedview`,
  "eggbot",
  "WCB",
  "MergeData",
  `${SVG}eggbot`,
  `${SVG}WCB`,
  `${SVG}MergeData`,
  `${SVG}title`,
  "title",
  `${SVG}desc`,
  "desc",
  `${SVG}pattern`,
  "pattern",
  `${SVG}radialGradient`,
  "radialGradient",
  `${SVG}linearGradient`,
  "linearGradient",
  `${SVG}style`,
  "style",
  `${SVG}cursor`,
  "cursor",
  `${SVG}font`,
  "font",
  `${SVG}view`,
  "view",
  `{${INKSCAPE_NS}}templateinfo`,
  `${SVG}color-profile`,
  "color-profile",
  `${SVG}foreignObject`,
  "foreignObject",
  "{https://bantam.tools/ndm}data",
]);

/** All elements of the document with id == `id`, in document order (XPath //*[@id=...]). */
function elementsById(start: Element, id: string): Element[] {
  if (id.includes('"')) throw new SyntaxError("Invalid expression");
  let root: Element = start;
  while (root.parentNode && root.parentNode.nodeType === 1) {
    root = root.parentNode as Element;
  }
  const out: Element[] = [];
  const walk = (el: Element) => {
    if (getPlainAttr(el, "id") === id) out.push(el);
    for (const c of childElements(el)) walk(c);
  };
  walk(root);
  return out;
}

/** DigestSVG: walks an SVG document and builds a DocDigest. */
export class DigestSVG {
  ctx: DigestContext;
  use_tag_nest_level = 0;
  current_layer: LayerItem = null as unknown as LayerItem;
  current_layer_name = "";
  next_id = 0;
  doc_digest = new DocDigest();
  bezier_tolerance = 0.005;
  layer_selection = -2;
  doc_width_100 = 0;
  doc_height_100 = 0;
  diagonal_100 = 0;

  constructor(ctx: DigestContext) {
    this.ctx = ctx;
  }

  /**
   * process_svg. `digestParams` is [s_x, s_y, layer_selection]; a
   * layer_selection >= 0 digests only layers with that number.
   */
  processSvg(
    root: Element,
    digestParams: [number, number, number],
    matCurrent: Matrix | null = null
  ): DocDigest {
    const [scaleX, scaleY, layerSelection] = digestParams;
    this.layer_selection = layerSelection;
    this.doc_digest.width = this.ctx.svg_width;
    this.doc_digest.height = this.ctx.svg_height;
    this.bezier_tolerance = this.ctx.params.curve_tolerance / 3;
    this.doc_digest.viewbox = `0 0 ${formatFixed(this.doc_digest.width, 6)} ${formatFixed(this.doc_digest.height, 6)}`;
    this.doc_width_100 = this.doc_digest.width / scaleX;
    this.doc_height_100 = this.doc_digest.height / scaleY;
    this.diagonal_100 =
      Math.sqrt(this.doc_width_100 ** 2 + this.doc_height_100 ** 2) /
      Math.sqrt(2);

    const docname = root.getAttributeNS(SODIPODI_NS, "docname");
    if (docname) this.doc_digest.name = docname;

    const rootLayer = new LayerItem();
    rootLayer.name = "__digest-root__";
    rootLayer.item_id = String(this.next_id);
    this.next_id += 1;
    this.doc_digest.layers.push(rootLayer);
    this.current_layer = rootLayer;
    this.current_layer_name = rootLayer.name;

    this.traverse(childElements(root), null, matCurrent);
    return this.doc_digest;
  }

  private layerTolerance(): number {
    const handling = this.current_layer.props.handling;
    const fallback = this.ctx.params.curve_tolerance / 3;
    if (handling === null) return fallback;
    // findCurveTolerance reads only params.overrides.
    const t = findCurveTolerance(
      { params: this.ctx.params } as ConfigState,
      handling
    );
    return t !== null ? t / 3 : fallback;
  }

  traverse(
    nodes: Element[],
    parentStyle: StyleDict | null,
    matCurrent: Matrix | null
  ): void {
    if (matCurrent === null) {
      matCurrent = [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
      ];
    }
    for (const node of nodes) {
      const tag = lxmlTag(node);
      const visibility = getPlainAttr(node, "visibility");
      const elementStyle: Map<string, string | null> = parseStyle(
        getPlainAttr(node, "style")
      );
      for (const key of ["fill", "stroke", "fill-rule"]) {
        if (!elementStyle.has(key))
          elementStyle.set(key, getPlainAttr(node, key));
      }
      const style = inheritStyle(parentStyle, elementStyle, visibility);

      if (style.display === "none") continue;
      if (getPlainAttr(node, "display") === "none") continue;

      const trans = getPlainAttr(node, "transform");
      const matNew =
        trans === null
          ? matCurrent
          : composeTransform(matCurrent, parseTransform(trans));

      if (tagIs(tag, "g")) {
        if (
          this.current_layer_name === "__digest-root__" &&
          node.getAttributeNS(INKSCAPE_NS, "groupmode") === "layer"
        ) {
          let layerName = node.getAttributeNS(INKSCAPE_NS, "label");
          if (!node.hasAttributeNS(INKSCAPE_NS, "label")) {
            layerName = `Auto-Layer ${this.next_id}`;
          }
          const newLayer = new LayerItem();
          newLayer.name = layerName as string;
          newLayer.parseName();
          if (newLayer.props.skip) continue;
          if (this.layer_selection >= 0) {
            if (newLayer.props.number === null) continue;
            if (this.layer_selection !== newLayer.props.number) continue;
          }
          newLayer.item_id = String(this.next_id);
          this.next_id += 1;
          if (this.current_layer.paths.length === 0)
            this.doc_digest.layers.pop();
          this.doc_digest.layers.push(newLayer);
          this.current_layer = newLayer;
          this.current_layer_name = String(layerName);
          this.bezier_tolerance = this.layerTolerance();

          this.traverse(childElements(node), style, matNew);

          const rootLayer = new LayerItem();
          rootLayer.name = "__digest-root__";
          rootLayer.item_id = String(this.next_id);
          this.next_id += 1;
          this.doc_digest.layers.push(rootLayer);
          this.current_layer = rootLayer;
          this.current_layer_name = rootLayer.name;
        } else {
          this.traverse(childElements(node), style, matNew);
        }
        continue;
      }

      if (tagIs(tag, "symbol")) {
        if (this.use_tag_nest_level > 0)
          this.traverse(childElements(node), style, matNew);
        continue;
      }
      if (tagIs(tag, "a") || tagIs(tag, "switch")) {
        this.traverse(childElements(node), style, matNew);
        continue;
      }
      if (tagIs(tag, "use")) {
        // nextdraw quirk: only xlink:href is honored; SVG 2 `href` is not
        // (nextdrawcore/digest_svg.py:602).
        if (node.hasAttributeNS(XLINK_NS, "href")) {
          const refid = node.getAttributeNS(XLINK_NS, "href") as string;
          const refnodes = elementsById(
            node,
            Array.from(refid).slice(1).join("")
          );
          const xVal = pyFloat(getPlainAttr(node, "x") ?? "0");
          const yVal = pyFloat(getPlainAttr(node, "y") ?? "0");
          let matNew2 = matNew;
          if (xVal !== 0 || yVal !== 0) {
            // nextdraw quirk: the offset is round-tripped through '{:.6E}',
            // keeping 7 significant digits (digest_svg.py:612-615).
            matNew2 = composeTransform(
              matNew,
              parseTransform(
                `translate(${formatExp(xVal, 6)},${formatExp(yVal, 6)})`
              )
            );
          }
          this.use_tag_nest_level += 1;
          this.traverse(refnodes, style, matNew2);
          this.use_tag_nest_level -= 1;
        }
        continue;
      }

      if (
        this.layer_selection >= 0 &&
        this.current_layer_name === "__digest-root__"
      ) {
        continue;
      }
      if (style.visibility === "hidden" || style.visibility === "collapse")
        continue;

      // nextdraw quirk: only the namespaced tag is accepted for <path>,
      // unlike the other shapes (digest_svg.py:634).
      if (tag === `${SVG}path`) {
        this.digestPath(getPlainAttr(node, "d"), style, matNew);
        continue;
      }
      if (tagIs(tag, "rect")) {
        const d = convertRectToPath(
          node,
          this.doc_width_100,
          this.doc_height_100
        );
        if (d) this.digestPath(d, style, matNew);
        continue;
      }
      if (tagIs(tag, "line")) {
        const d = convertLineToPath(
          node,
          this.doc_width_100,
          this.doc_height_100
        );
        if (d) this.digestPath(d, style, matNew);
        continue;
      }
      if (tagIs(tag, "polyline", "polygon")) {
        const d = convertPolylinePolygonToPath(node);
        if (d) this.digestPath(d, style, matNew);
        continue;
      }
      if (tagIs(tag, "ellipse", "circle")) {
        const d = convertCircleEllipseToPath(
          node,
          this.doc_width_100,
          this.doc_height_100,
          this.diagonal_100
        );
        if (d) this.digestPath(d, style, matNew);
        continue;
      }
      if (tagIs(tag, "metadata")) {
        Object.assign(this.doc_digest.metadata, pyAttrib(node));
        continue;
      }
      if (
        tagIs(tag, "plotdata") ||
        tag === "{https://bantam.tools/nd}plotdata"
      ) {
        Object.assign(this.doc_digest.plotdata, pyAttrib(node));
        continue;
      }
      if (IGNORED_TAGS.has(tag)) continue;
      if (tagIs(tag, "text", "flowRoot")) {
        this.ctx.warnings.addNew("text", this.current_layer_name);
        continue;
      }
      if (tagIs(tag, "image")) {
        this.ctx.warnings.addNew("image", this.current_layer_name);
        continue;
      }
      const parts = tag.split("}");
      this.ctx.warnings.addNew(
        parts[parts.length - 1],
        this.current_layer_name
      );
    }
  }

  /**
   * digest_path: parse, transform and flatten one path's data, then append
   * it to the current layer (or return it when returnPathItem is true).
   */
  digestPath(
    pathD: string | null,
    style: StyleDict,
    matTransform: Matrix,
    returnPathItem = false
  ): PathItem | undefined {
    if (pathD === null) return;
    pathD = pyStrip(pathD);
    if (pathD === "") return;

    const parsed = cubicSuperPath(parsePath(pathD));
    if (parsed.length === 0) return;
    applyTransformToPath(matTransform, parsed);

    const subpaths: Vertex[][] = [];
    for (const subpath of parsed) {
      subdivideCubicPath(subpath, this.bezier_tolerance);
      if (subpath.length < 2) continue;
      subpaths.push(subpath.map((v) => [v[1][0], v[1][1]]));
    }
    if (subpaths.length === 0) return;

    const newPath = new PathItem();
    newPath.fill = style.fill;
    newPath.stroke = style.stroke;
    newPath.fill_rule = style["fill-rule"];
    newPath.item_id = String(this.next_id);
    this.next_id += 1;
    newPath.subpaths = subpaths;
    if (!subpaths.some((s) => s.length !== 2)) newPath.fill = null;

    if (returnPathItem) return newPath;
    this.current_layer.paths.push(newPath);
  }
}

// ---------------------------------------------------------------------------
// Document set-up (nextdraw.py get_doc_props and prepare_document)

export interface DocProps {
  svg_width: number; // inches
  svg_height: number; // inches
  doc_units: string | null;
  rotate_page: boolean;
}

/** get_doc_props: page size in inches, or null when the size is unusable. */
export function docProps(root: Element, autoRotate: boolean): DocProps | null {
  const svgHeight = getLengthInches(getPlainAttr(root, "height"));
  const svgWidth = getLengthInches(getPlainAttr(root, "width"));
  let docUnits: string | null = null;
  const ws = getPlainAttr(root, "width");
  if (ws) docUnits = parseLengthWithUnits(ws)[1];
  if (svgHeight === null || svgWidth === null) return null;
  return {
    svg_width: svgWidth,
    svg_height: svgHeight,
    doc_units: docUnits,
    rotate_page: autoRotate && svgHeight > svgWidth,
  };
}

/**
 * The viewBox scaling as nextdraw applies it: [s_x, s_y, o_x, o_y] and the
 * document transform. 1/96 inch per user unit without a valid viewBox.
 */
export function viewBoxTransform(
  root: Element,
  svgWidth: number,
  svgHeight: number
): { vb: [number, number, number, number]; transform: Matrix } {
  const out = vbScale2(
    getPlainAttr(root, "viewBox"),
    getPlainAttr(root, "preserveAspectRatio"),
    svgWidth,
    svgHeight
  );
  const vb: [number, number, number, number] = out ?? [
    1.0 / PX_PER_INCH,
    1.0 / PX_PER_INCH,
    0.0,
    0.0,
  ];
  const [sX, sY, oX, oY] = vb;
  // nextdraw quirk: the scale and offset pass through '{:.6E}', keeping only
  // 7 significant digits (nextdrawcore/nextdraw.py:605-606).
  const e = (v: number) => formatExp(v, 6);
  const transform = parseTransform(
    `scale(${e(sX)},${e(sY)}) translate(${e(oX)},${e(oY)})`
  );
  return { vb, transform };
}

// ---------------------------------------------------------------------------
// Plob verification (digest_svg.py:840-951)

const PLOTTABLE = new Set(
  ["polyline", "path", "line", "rect", "circle", "ellipse", "polygon"].flatMap(
    (t) => [t, SVG + t]
  )
);

function hasPlottableElements(el: Element): boolean {
  if (PLOTTABLE.has(lxmlTag(el))) return true;
  return childElements(el).some(hasPlottableElements);
}

function descendants(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    out.push(e);
    for (const c of childElements(e)) walk(c);
  };
  walk(el);
  return out;
}

/** verify_plob: may this SVG be plotted as a plob, skipping the digest? */
export function verifyPlob(
  svg: Element,
  model: number,
  bounds: number[][],
  svgWidth: number,
  svgHeight: number
): boolean {
  let nodes = childElements(svg).filter(
    (n) => lxmlTag(n) === "{https://bantam.tools/nd}plotdata"
  );
  if (!nodes.length) {
    let root = svg;
    while (root.parentNode && root.parentNode.nodeType === 1) {
      root = root.parentNode as Element;
    }
    nodes = descendants(root).filter((n) => {
      const t = lxmlTag(n);
      return t === `${SVG}plotdata` || t === "plotdata";
    });
  }
  if (!nodes.length) return false;
  const dataNode = nodes[0];
  const svgModel = getPlainAttr(dataNode, "model");
  const plobVersion = getPlainAttr(dataNode, "plob_version");
  if (!svgModel) return false;
  if (!plobVersion || plobVersion !== PLOB_VERSION) return false;

  const viewbox = getPlainAttr(svg, "viewBox");
  if (viewbox !== null) {
    if (!pyStrip(viewbox)) return false;
    try {
      const coords = pySplit(viewbox).map(pyFloat);
      if (coords.length !== 4 || coords[2] <= 0 || coords[3] <= 0) return false;
    } catch {
      return false;
    }
  }

  for (const node of childElements(svg)) {
    const tag = lxmlTag(node);
    if (tagIs(tag, "g")) {
      if (!node.hasAttributeNS(INKSCAPE_NS, "label")) {
        if (hasPlottableElements(node)) return false;
        continue;
      }
      const name = node.getAttributeNS(INKSCAPE_NS, "label") as string;
      if (name.length > 0 && name[0] === "%") continue;
      if (getPlainAttr(node, "transform")) return false;
      for (const sub of childElements(node)) {
        if (getPlainAttr(sub, "transform")) return false;
        if (tagIs(lxmlTag(sub), "polyline")) continue;
        return false;
      }
    } else if (
      [
        `${SVG}defs`,
        "defs",
        "metadata",
        `${SVG}metadata`,
        `{${SODIPODI_NS}}namedview`,
        "plotdata",
        `${SVG}plotdata`,
        "{https://bantam.tools/ndm}data",
        "{https://bantam.tools/nd}plotdata",
      ].includes(tag)
    ) {
      continue;
    } else {
      return false;
    }
  }

  // int(svg_model): Python int() of the attribute string.
  const m = pyStrip(svgModel).replace(/(?<=\d)_(?=\d)/g, "");
  if (!/^[+-]?\d+$/.test(m))
    throw new RangeError(`invalid literal for int(): '${svgModel}'`);
  if (Number(m) === model) return true;
  const [, [xTravel, yTravel]] = bounds;
  return svgWidth <= xTravel && svgHeight <= yTravel;
}
