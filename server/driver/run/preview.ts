/*
 * Preview mode: time estimation bookkeeping and the "% Preview" layer that
 * draws planned pen-up and pen-down travel into the output SVG.
 *
 * Ported from nextdrawcore/preview.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/preview.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Not ported: the velocity charts (VelocityChart is disabled in nextdraw
 * unless edited in source); only its time-estimate side effect remains.
 */

import type { Element } from "@xmldom/xmldom";
import type { Move } from "../motion/types.ts";
import { formatFixed } from "../pyfmt.ts";
import { formatStyle } from "../svg/simplestyle.ts";
import {
  composeTransform,
  formatTransform,
  parseTransform,
} from "../svg/simpletransform.ts";
import { formatExp } from "../svg/pycompat.ts";
import { ND_NS, SVG_NS, newPrefix, removeWithTail } from "./status.ts";

export const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** The NextDraw fields preview reads. */
export interface PreviewContext {
  options: { preview: boolean; rendering: boolean | number; digest: number };
  params: {
    preview_paths: number;
    preview_color_up: string;
    preview_color_down: string;
    auto_rotate_ccw: boolean;
  };
  pen: {
    phys: { xpos: number | null; ypos: number | null; z_up: boolean | null };
    status: { preview_pen_state: number };
  };
  plot_status: { stats: { pt_estimate: number } };
  rotate_page: boolean;
  svg_width: number;
  svg_height: number;
  vb_stash: [number, number, number, number];
}

/** format_precision_width: stroke widths can't use exponent notation. */
export function formatPrecisionWidth(width: number, units = ""): string {
  let formatted: string;
  if (width >= 1.0) formatted = formatFixed(width, 3);
  else if (width >= 0.1) formatted = formatFixed(width, 4);
  else if (width >= 0.01) formatted = formatFixed(width, 5);
  else if (width >= 0.001) formatted = formatFixed(width, 6);
  else if (width >= 0.0001) formatted = formatFixed(width, 7);
  else
    formatted = formatFixed(
      width,
      Math.trunc(Math.ceil(-Math.log10(width)) + 3)
    );
  return formatted + units;
}

const f3 = (x: number | null) => formatFixed(x as number, 3);

/** Children of `parent` that are Inkscape layers labelled "% Preview". */
function previewLayers(parent: Element): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    const isG =
      el.localName === "g" && (el.namespaceURI === SVG_NS || !el.namespaceURI);
    if (
      isG &&
      el.getAttributeNS(INKSCAPE_NS, "groupmode") === "layer" &&
      el.getAttributeNS(INKSCAPE_NS, "label") === "% Preview"
    ) {
      out.push(el);
    }
  }
  return out;
}

export class Preview {
  path_data_pu: string[] = [];
  path_data_pd: string[] = [];

  reset(): void {
    this.path_data_pu = [];
    this.path_data_pd = [];
  }

  /** The planner's VelocityChart hook: pen moves add settle time to the estimate. */
  v_chart = {
    rest: (
      nd: {
        options: { preview: boolean };
        plot_status: { stats: { pt_estimate: number } };
      },
      vTime: number
    ) => {
      if (!nd.options.preview) return;
      nd.plot_status.stats.pt_estimate += vTime;
    },
  };

  private enabled(nd: PreviewContext): boolean {
    return Boolean(nd.options.rendering) && Boolean(nd.params.preview_paths);
  }

  /** Shared tail of log_sm/t3/td_move. `repeatStart` is log_td_move's extra vertex. */
  private log(
    nd: PreviewContext,
    xNew: number,
    yNew: number,
    repeatStart: boolean
  ): void {
    const { phys, status } = nd.pen;
    const xOld = phys.xpos;
    const yOld = phys.ypos;
    if (phys.z_up) {
      if (nd.params.preview_paths > 1) {
        if (status.preview_pen_state !== 1) {
          this.path_data_pu.push(`M${f3(xOld)} ${f3(yOld)}`);
          status.preview_pen_state = 1;
        }
        this.path_data_pu.push(` ${f3(xNew)} ${f3(yNew)}`);
      }
    } else if (nd.params.preview_paths === 1 || nd.params.preview_paths === 3) {
      if (status.preview_pen_state !== 0) {
        this.path_data_pd.push(`M${f3(xOld)} ${f3(yOld)}`);
        status.preview_pen_state = 0;
      } else if (repeatStart) {
        // nextdraw quirk: log_td_move (preview.py) repeats the start vertex.
        this.path_data_pd.push(` ${f3(xOld)} ${f3(yOld)}`);
      }
      this.path_data_pd.push(` ${f3(xNew)} ${f3(yNew)}`);
    }
  }

  logSmMove(nd: PreviewContext, move: Move): void {
    if (!this.enabled(nd)) return;
    const seg = move[2] as unknown as [number, number];
    this.log(nd, seg[0], seg[1], false);
  }

  logT3Move(nd: PreviewContext, move: Move): void {
    if (!this.enabled(nd)) return;
    const pos = (
      move[2] as unknown as [number, { xpos: number; ypos: number }]
    )[1];
    this.log(nd, pos.xpos, pos.ypos, false);
  }

  logTdMove(nd: PreviewContext, move: Move): void {
    if (!this.enabled(nd)) return;
    const pos = (
      move[2] as unknown as [number, { xpos: number; ypos: number }]
    )[1];
    this.log(nd, pos.xpos, pos.ypos, true);
  }

  findPreviewTransform(nd: PreviewContext): string {
    let previewTransform = "";
    if (nd.rotate_page) {
      if (nd.params.auto_rotate_ccw) {
        previewTransform = "rotate(90)";
        previewTransform += `translate(0, ${formatExp(-nd.svg_width, 6)})`;
      } else {
        previewTransform = "rotate(-90)";
        previewTransform += `translate(${formatExp(-nd.svg_height, 6)},0)`;
      }
    }
    const [sX, sY, oX, oY] = nd.vb_stash;
    const transform2 = formatTransform(
      parseTransform(
        `translate(${formatExp(-oX, 6)},${formatExp(-oY, 6)}) ` +
          `scale(${formatExp(1.0 / sX, 6)},${formatExp(1.0 / sY, 6)})`
      )
    );
    return formatTransform(
      composeTransform(
        parseTransform(transform2),
        parseTransform(previewTransform)
      )
    );
  }

  /** render: replace any "% Preview" layer with one drawn from this run's moves. */
  render(nd: PreviewContext, svg: Element): void {
    if (!nd.options.preview) return;
    for (const node of previewLayers(svg)) removeWithTail(node);
    if (!this.enabled(nd)) return;

    const doc = svg.ownerDocument;
    if (!doc) return;
    const transform = this.findPreviewTransform(nd);
    // nextdraw creates these with the bare tag "g"; lxml then writes them with
    // no xmlns="" undeclaration, so they read back as SVG elements.
    const make = (parent: Element, tag: string) => {
      const el = doc.createElementNS(SVG_NS, tag);
      parent.appendChild(el);
      return el;
    };
    const layer = make(svg, "g");
    // lxml declares a namespace at first use unless an ancestor already does.
    const inkPrefix = svg.lookupPrefix(INKSCAPE_NS);
    const prefix = inkPrefix ?? newPrefix(doc, svg);
    if (!inkPrefix)
      layer.setAttributeNS(XMLNS_NS, `xmlns:${prefix}`, INKSCAPE_NS);
    if (nd.options.digest) {
      layer.setAttribute("data-transform", transform);
      layer.setAttribute(
        "transform",
        formatTransform([
          [1.0, 0.0, 0.0],
          [0.0, 1.0, 0.0],
        ])
      );
    } else {
      layer.setAttribute("transform", transform);
    }
    const setLayer = (el: Element, label: string) => {
      el.setAttributeNS(INKSCAPE_NS, `${prefix}:groupmode`, "layer");
      el.setAttributeNS(INKSCAPE_NS, `${prefix}:label`, label);
    };
    const subUp = make(layer, "g");
    const subDown = make(layer, "g");
    setLayer(layer, "% Preview");
    setLayer(subDown, "Pen-down movement");
    setLayer(subUp, "Pen-up movement");

    const widthDu = Math.min(nd.svg_width, nd.svg_height) / 1000.0;
    if (widthDu === 0) return;
    const style = new Map<string, string>([
      ["stroke-width", formatPrecisionWidth(widthDu)],
      ["fill", "none"],
      ["stroke-linejoin", "round"],
      ["stroke-linecap", "round"],
    ]);
    const addPath = (parent: Element, color: string, data: string[]) => {
      style.set("stroke", color);
      const path = make(parent, "path");
      path.setAttribute("style", formatStyle(style));
      path.setAttribute("d", data.join(" "));
    };
    if (nd.params.preview_paths > 1)
      addPath(subUp, nd.params.preview_color_up, this.path_data_pu);
    if (nd.params.preview_paths === 1 || nd.params.preview_paths === 3) {
      addPath(subDown, nd.params.preview_color_down, this.path_data_pd);
    }
  }
}

/** Elements anywhere under `root` in the SVG namespace with this local name. */
function descendantsSvg(root: Element, local: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const child = n as Element;
      if (child.namespaceURI === SVG_NS && child.localName === local)
        out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** lxml's svg.remove(node): only direct children; anything else raises. */
function removeChildOf(svg: Element, node: Element): void {
  if (node.parentNode !== svg)
    throw new Error("Element is not a child of this node.");
  removeWithTail(node);
}

/** strip_data: remove plot data and preview layers from the document. */
export function stripData(svg: Element): void {
  for (const slug of ["WCB", "MergeData", "plotdata", "eggbot"]) {
    for (const node of descendantsSvg(svg, slug)) removeChildOf(svg, node);
  }
  const direct = (ns: string, local: string) => {
    const out: Element[] = [];
    for (let n = svg.firstChild; n; n = n.nextSibling) {
      const el = n as Element;
      if (n.nodeType === 1 && el.namespaceURI === ns && el.localName === local)
        out.push(el);
    }
    return out;
  };
  for (const node of direct(ND_NS, "plotdata")) removeWithTail(node);
  for (const node of direct("https://bantam.tools/ndm", "data"))
    removeWithTail(node);
  for (const node of descendantsSvg(svg, "g")) {
    if (node.getAttributeNS(INKSCAPE_NS, "label") === "% Preview")
      removeChildOf(svg, node);
  }
}
