/**
 * SVG parsing for preview rendering.
 *
 * The backend plots the SVG via `nextdraw` at its native size — this module
 * only parses paths so the canvas preview can show them against the
 * plotter's travel area.
 */

import { flattenSVG } from "flatten-svg";

/** SVG user units → mm (CSS: 1px = 1/96 in) */
const PX_TO_MM = 25.4 / 96;

const UNIT_MM = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: PX_TO_MM,
  "": PX_TO_MM,
};

function lengthToMm(attr) {
  if (!attr) return 0;
  const m = String(attr).match(/^([\d.]+)\s*([a-z%]*)$/i);
  if (!m) return 0;
  const [, num, unit] = m;
  return Number(num) * (UNIT_MM[unit.toLowerCase()] ?? PX_TO_MM);
}

/**
 * Parse an SVG string into polylines in mm coordinates.
 */
export function parseSVG(svgString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");

  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("Invalid SVG: " + parserError.textContent);

  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("No SVG element found");

  const widthMm = lengthToMm(svg.getAttribute("width"));
  const heightMm = lengthToMm(svg.getAttribute("height"));

  // flatten-svg emits points in SVG user units. Scale to mm using the
  // ratio of declared physical width to viewBox width (or px→mm if no viewBox).
  const viewBoxAttr = svg.getAttribute("viewBox");
  let unitToMm = PX_TO_MM;
  if (viewBoxAttr && widthMm > 0) {
    const vbW = Number(viewBoxAttr.split(/[\s,]+/)[2]);
    if (vbW > 0) unitToMm = widthMm / vbW;
  }

  const lines = flattenSVG(svg, { maxError: 0.1 });
  const paths = lines
    .map((line) =>
      line.points.map(([x, y]) => ({ x: x * unitToMm, y: y * unitToMm }))
    )
    .filter((path) => path.length >= 2);

  return { paths, widthMm, heightMm };
}

/**
 * nextdraw `model` config values → travel area (mm).
 * See https://bantam.tools/nd_cli/#model
 */
export const PLOTTER_MODELS = {
  1: { name: "AxiDraw V2/V3/SE-A4", width: 300, height: 218 },
  2: { name: "AxiDraw V3/A3 or SE/A3", width: 430, height: 297 },
  3: { name: "AxiDraw V3 XLX", width: 595, height: 218 },
  4: { name: "AxiDraw MiniKit", width: 160, height: 101 },
  5: { name: "AxiDraw SE/A1", width: 864, height: 594 },
  6: { name: "AxiDraw SE/A2", width: 594, height: 432 },
  7: { name: "AxiDraw V3/B6", width: 190, height: 127 },
  8: { name: "NextDraw 8511", width: 279.4, height: 215.9 },
  9: { name: "NextDraw 1117", width: 431.8, height: 279.4 },
  10: { name: "NextDraw 2234", width: 863.6, height: 558.8 },
};

/** Common paper sizes in mm (landscape: width > height) */
export const PaperSizes = {
  Letter:   { width: 279.4, height: 215.9 },
  Legal:    { width: 355.6, height: 215.9 },
  Tabloid:  { width: 431.8, height: 279.4 },
  A4:       { width: 297,   height: 210   },
  A3:       { width: 420,   height: 297   },
  "Arch A": { width: 304.8, height: 228.6 },
  "Arch B": { width: 457.2, height: 304.8 },
};

export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
