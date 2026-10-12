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
 * nextdraw `model` config values → travel area (mm). Travel is copied in
 * inches from nextdrawcore/nextdraw_options/models.py (nextdraw 1.x).
 */
const plotter = (name, xIn, yIn) => ({
  name,
  width: xIn * 25.4,
  height: yIn * 25.4,
});
export const PLOTTER_MODELS = {
  1: plotter("AxiDraw V3 or SE/A4", 11.81, 8.58),
  2: plotter("AxiDraw V3/A3 or SE/A3", 16.93, 11.69),
  3: plotter("AxiDraw V3 XLX", 23.42, 8.58),
  4: plotter("AxiDraw MiniKit", 6.3, 4.0),
  5: plotter("AxiDraw SE/A1", 34.02, 23.39),
  6: plotter("AxiDraw SE/A2", 23.39, 17.01),
  7: plotter("AxiDraw V3/B6", 7.48, 5.51),
  8: plotter("NextDraw 8511", 11.81, 8.58),
  9: plotter("NextDraw 1117", 16.93, 11.69),
  10: plotter("NextDraw 2234", 34.02, 23.39),
};

/** Common paper sizes in mm (landscape: width > height) */
export const PAPER_SIZES = {
  Letter: { width: 279.4, height: 215.9 },
  Legal: { width: 355.6, height: 215.9 },
  Tabloid: { width: 431.8, height: 279.4 },
  A4: { width: 297, height: 210 },
  A3: { width: 420, height: 297 },
  "Arch A": { width: 304.8, height: 228.6 },
  "Arch B": { width: 457.2, height: 304.8 },
};

export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
