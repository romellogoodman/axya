/*
 * Plot status: resume data stored in the SVG (<nd:plotdata>), distance and
 * time statistics, and the pause-position cache.
 *
 * Ported from nextdrawcore/plot_status.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/plot_status.py, and
 * plotink/text_utils.py format_hms (MIT, (c) 2024 Windell H. Oskay, Bantam Tools).
 * Copyright 2026 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Not ported: ProgressBar (tqdm output for the CLI only; nextdraw enables it
 * only when called from its CLI with --progress, and axya reports progress
 * itself).
 */

import type { Element } from "@xmldom/xmldom";
import { roundHalfEven } from "../motion/ebbCalc.ts";
import { formatFixed } from "../pyfmt.ts";

export const ND_NS = "https://bantam.tools/nd";
export const SVG_NS = "http://www.w3.org/2000/svg";

/** plot_status.parse_dist: distance string with optional mm/cm/in suffix, in inches. */
export function parseDist(
  distStr: string | number,
  defaultUnit: "in" | "mm" | "cm"
): number {
  const s = String(distStr).trim().toLowerCase();
  if (s.endsWith("mm")) return pyFloat(s.slice(0, -2)) / 25.4;
  if (s.endsWith("cm")) return pyFloat(s.slice(0, -2)) / 2.54;
  if (s.endsWith("in")) return pyFloat(s.slice(0, -2));
  if (s && /[a-z]/i.test(s[s.length - 1]))
    throw new RangeError(`Unknown unit in '${distStr}'`);
  if (defaultUnit === "mm") return pyFloat(s) / 25.4;
  if (defaultUnit === "cm") return pyFloat(s) / 2.54;
  return pyFloat(s);
}

/** Python float(str) for decimal literals (whitespace and underscores allowed). */
export function pyFloat(s: string): number {
  const t = s.trim().replace(/(?<=\d)_(?=\d)/g, "");
  const special = t.toLowerCase().replace(/^[+-]/, "");
  if (special === "inf" || special === "infinity")
    return t.startsWith("-") ? -Infinity : Infinity;
  if (special === "nan") return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
    throw new RangeError(`could not convert string to float: '${s}'`);
  }
  return Number(t);
}

/** Python int(str). */
export function pyInt(s: string): number {
  const t = s.trim().replace(/(?<=\d)_(?=\d)/g, "");
  if (!/^[+-]?\d+$/.test(t))
    throw new RangeError(`invalid literal for int(): '${s}'`);
  return Number(t);
}

/** plotink text_utils.format_hms */
export function formatHms(duration: number, milliseconds = false): string {
  if (milliseconds) duration = duration / 1000.0;
  if (duration < 10) return `${formatFixed(duration, 3)} Seconds`;
  const rounded = roundHalfEven(duration);
  if (rounded < 60) return `${String(rounded).padStart(2, "0")} Seconds`;
  let minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  if (rounded < 3600)
    return `${minutes}:${String(seconds).padStart(2, "0")} (Minutes, seconds)`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return (
    `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` +
    " (Hours, minutes, seconds)"
  );
}

/** Values stored in the <plotdata> element. Distances in inches. */
export class SVGPlotData {
  application = "";
  auto_rot = 0;
  handling = 0;
  hiding = 0;
  layer = -2; // < 0: plot all layers; -2: default
  model = 0;
  reordering = 0; // stored as attribute "optim"
  pause_dist = -1; // < 0: no resume data
  pause_ref = -1;
  pause_warn = 0;
  plob_version = "n/a";
  rand_seed = 1;
  rand_start = 0;

  reset(): void {
    Object.assign(this, new SVGPlotData());
  }

  /** Plot finished normally: nothing to resume. */
  clean(): void {
    this.layer = -2;
    this.pause_dist = -1;
  }
}

/** Direct children of `parent` with the given namespace and local name. */
function childrenNS(parent: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    const el = n as Element;
    if (n.nodeType === 1 && el.namespaceURI === ns && el.localName === local)
      out.push(el);
  }
  return out;
}

/** All descendants (any depth) with local name "plotdata" in the SVG namespace or none. */
function legacyPlotdata(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const child = n as Element;
      if (
        child.localName === "plotdata" &&
        (child.namespaceURI === SVG_NS || !child.namespaceURI)
      ) {
        out.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** lxml's remove(): the element goes, and so does its tail text. */
export function removeWithTail(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  let next = el.nextSibling;
  while (next && (next.nodeType === 3 || next.nodeType === 4)) {
    const after = next.nextSibling;
    parent.removeChild(next);
    next = after;
  }
  parent.removeChild(el);
}

/** Resume bookkeeping: what was read from the file (old) and what to write (new). */
export class ResumeStatus {
  read = false;
  written = false;
  old = new SVGPlotData();
  new = new SVGPlotData();
  update_needed = false;
  button_timestamp = 0;
  drip = new DripCache();

  reset(now: number): void {
    this.read = false;
    this.written = false;
    this.update_needed = false;
    this.button_timestamp = now;
    this.old.reset();
    this.new.reset();
    this.drip.reset();
  }

  /** read_from_svg: pause_dist/pause_ref are stored as integer µm. */
  readFromSvg(svg: Element): void {
    this.read = false;
    let nodes = childrenNS(svg, ND_NS, "plotdata");
    if (nodes.length === 0) nodes = legacyPlotdata(svg);
    const node = nodes[0];
    if (!node) return;
    const attr = (name: string): string | null =>
      node.hasAttribute(name) ? node.getAttribute(name) : null;
    const int = (name: string): number => {
      const v = attr(name);
      if (v === null) throw new TypeError(name); // Python int(None) -> TypeError
      return pyInt(v);
    };
    try {
      this.old.application = attr("application") ?? "";
      this.old.auto_rot = int("auto_rot");
      this.old.handling = int("handling");
      this.old.hiding = int("hiding");
      this.old.layer = int("layer");
      this.old.model = int("model");
      this.old.reordering = int("optim");
      this.old.pause_dist = int("pause_dist") / 25400;
      this.old.pause_ref = int("pause_ref") / 25400;
      this.old.pause_warn = int("pause_warn");
      this.old.plob_version = attr("plob_version") ?? "n/a";
      const seed = attr("rand_seed");
      if (seed === null) throw new TypeError("rand_seed");
      this.old.rand_seed = Math.trunc(pyFloat(seed));
      this.old.rand_start = int("rand_start");
      this.read = true;
    } catch (err) {
      // nextdraw catches only TypeError (a missing attribute) and drops the node.
      if (!(err instanceof TypeError)) throw err;
      if (node.parentNode === svg) removeWithTail(node);
    }
  }

  /** write_to_svg: replace any existing plotdata with the new values (once per run). */
  writeToSvg(svg: Element): void {
    if (this.written) return;
    for (const node of childrenNS(svg, ND_NS, "plotdata")) removeWithTail(node);
    for (const node of childrenNS(svg, SVG_NS, "plotdata"))
      removeWithTail(node);
    const doc = svg.ownerDocument;
    if (!doc) throw new Error("plotdata: SVG root has no owner document");
    // lxml reuses an in-scope prefix for the namespace, else invents ns0.
    const inScope = svg.lookupPrefix(ND_NS);
    const prefix = inScope ?? "ns0";
    const node = doc.createElementNS(ND_NS, `${prefix}:plotdata`);
    if (!inScope) node.setAttributeNS("http://www.w3.org/2000/xmlns/", `xmlns:${prefix}`, ND_NS);
    if (this.new.application === "") this.new.application = "nextdraw";
    const n = this.new;
    node.setAttribute("application", n.application);
    node.setAttribute("auto_rot", String(n.auto_rot));
    node.setAttribute("handling", String(n.handling));
    node.setAttribute("hiding", String(n.hiding));
    node.setAttribute("layer", String(n.layer));
    node.setAttribute("model", String(n.model));
    node.setAttribute("optim", String(n.reordering));
    node.setAttribute(
      "pause_dist",
      String(roundHalfEven(n.pause_dist * 25400))
    );
    node.setAttribute("pause_ref", String(roundHalfEven(n.pause_ref * 25400)));
    node.setAttribute("pause_warn", String(n.pause_warn));
    node.setAttribute("plob_version", String(n.plob_version));
    node.setAttribute("rand_seed", String(n.rand_seed));
    node.setAttribute("rand_start", String(n.rand_start));
    svg.appendChild(node);
    this.written = true;
  }

  copyOld(): void {
    Object.assign(this.new, this.old);
  }

  /** Message if a new plot is started on a file that holds pause data, else null. */
  pauseWarning(
    pauseWarningEnabled: boolean,
    guiCaller: boolean
  ): string | null {
    if (!this.old.pause_warn) return null;
    if (!(pauseWarningEnabled && this.old.pause_dist >= 0)) return null;
    let text = "This document looks like it was paused while plotting.\n\n";
    if (guiCaller) {
      text +=
        "To resume plotting, use the Resume function instead.\n" +
        "To start from the beginning of the file, run this again.";
    } else {
      text +=
        "To resume a plot, use the res_plot mode.\n" +
        "Or, to start from the beginning of the file, \n" +
        " (1) Plot the output SVG from this command or \n" +
        " (2) use the strip_data utility command.";
    }
    return text;
  }

  /** remove_pause_warning: keep the plot data but clear the warning flag. */
  removePauseWarning(svg: Element, secondary: boolean): void {
    this.copyOld();
    this.new.pause_warn = 0;
    if (!secondary) this.writeToSvg(svg);
  }
}

/** Distance and time statistics. Distances in inches, times in ms. */
export class PlotStats {
  up_travel_inch = 0; // current page
  down_travel_inch = 0; // current page
  up_travel_tot = 0;
  down_travel_tot = 0;
  pt_estimate = 0; // all pages, ms
  page_delays = 0; // ms
  layer_delays = 0; // ms

  reset(): void {
    Object.assign(this, new PlotStats());
  }

  nextPage(): void {
    this.up_travel_tot += this.up_travel_inch;
    this.down_travel_tot += this.down_travel_inch;
    this.up_travel_inch = 0;
    this.down_travel_inch = 0;
  }

  /** add_dist: credit a segment's distance; pen-down moves also feed the pause cache. */
  addDist(
    penUp: boolean,
    drip: DripCache,
    distanceInch: number,
    tD = false
  ): void {
    if (penUp) {
      this.up_travel_inch += distanceInch;
      drip.push(0);
    } else {
      this.down_travel_inch += distanceInch;
      if (tD) drip.push(0); // a TD is two queued T3s; count the distance in one of them
      drip.push(distanceInch);
    }
  }

  /**
   * report: fold the page into totals and, if report_time is set, emit the
   * summary lines. `endedAt` is the "Ended at" timestamp text for real plots.
   */
  report(
    options: {
      copies: number;
      preview: boolean;
      random_start: boolean;
      page_delay: number;
      report_time: boolean;
    },
    message: (text: string) => void,
    elapsedTime: number,
    endedAt: () => string
  ): void {
    this.up_travel_tot += this.up_travel_inch;
    this.down_travel_tot += this.down_travel_inch;
    if (options.copies > 1 && options.preview && !options.random_start) {
      // Identical pages: estimate one page and multiply.
      this.down_travel_tot = options.copies * this.down_travel_inch;
      this.up_travel_tot = options.copies * this.up_travel_inch;
      this.page_delays = 1000 * options.page_delay * (options.copies - 1);
      this.layer_delays *= options.copies;
      this.pt_estimate *= options.copies;
      this.pt_estimate += this.page_delays;
    }
    if (!options.report_time) return;
    const dDist = 0.0254 * this.down_travel_tot;
    const uDist = 0.0254 * this.up_travel_tot;
    const tDist = dDist + uDist;
    let delayText = "";
    const elapsedText = formatHms(elapsedTime);
    if (this.layer_delays > 0) {
      delayText =
        ",\nincluding added delays of: " +
        formatHms(this.page_delays + this.layer_delays, true);
    } else if (this.page_delays > 0) {
      delayText =
        ",\nincluding page delays of: " + formatHms(this.page_delays, true);
    }
    if (options.preview) {
      message(
        "Estimated print time: " + formatHms(this.pt_estimate, true) + delayText
      );
      message(`Length of path to draw: ${formatFixed(dDist, 3)} m`);
      message(`Pen-up travel distance: ${formatFixed(uDist, 3)} m`);
      message(`Total movement distance: ${formatFixed(tDist, 3)} m`);
      message("This estimate took " + elapsedText + "\n");
    } else {
      message("Elapsed time: " + elapsedText + delayText);
      message("Ended at: " + endedAt());
      message(`Length of path drawn: ${formatFixed(dDist, 2)} m`);
      message(`Total distance moved: ${formatFixed(tDist, 2)} m\n`);
    }
  }
}

/**
 * Recent pen-down distances (newest first, at most 16, the EBB FIFO depth),
 * used to back the pause position out of moves still queued on the board.
 */
export class DripCache {
  dist_deque: number[] = [];
  last_move: unknown = null;

  reset(): void {
    this.dist_deque = [];
    this.last_move = null;
  }

  push(distance: number): void {
    this.dist_deque.unshift(distance);
    if (this.dist_deque.length > 16) this.dist_deque.length = 16;
  }

  /**
   * queued_dist: subtract the distance of the `queueCount` newest moves
   * (still in the FIFO when the pause hit) from the pen-down travel.
   */
  queuedDist(
    queueCount: number | null,
    stats: PlotStats,
    resuming: boolean,
    resumeBaseline: number
  ): void {
    if (queueCount === null) return; // USB error reading QU,6
    let offset = 0;
    for (const d of this.dist_deque.slice(0, queueCount)) offset += d;
    stats.down_travel_inch -= offset;
    // Don't let the pause position fall below the resume baseline.
    if (resuming)
      stats.down_travel_inch = Math.max(stats.down_travel_inch, resumeBaseline);
  }
}

/** Why a plot stopped, and machine-condition flags seen during it. */
export class PlotStatus {
  copies_to_plot = 1;
  stopped = 0; // status code; see nextdraw.py pause_check
  secondary = false;
  called_externally = false;
  cli_api = false;
  delay_between_copies = false;
  button = false;
  limit = false;
  power = false;
  connection = false;
  monitor = false;
  port: string | null = null;
  resume = new ResumeStatus();
  stats = new PlotStats();

  applyDefaults(): void {
    this.port = null;
    this.stopped = 0;
    this.delay_between_copies = false;
  }

  reset(now: number): void {
    this.applyDefaults();
    this.resume.reset(now);
    this.button = false;
    this.limit = false;
    this.power = false;
    this.connection = false;
    this.monitor = false;
  }
}
