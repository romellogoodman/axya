/**
 * SVG Parsing and Transformation
 *
 * Converts SVG files into polylines suitable for pen plotter motion planning.
 */

import { flattenSVG } from "flatten-svg";
import { reorder as sortPaths } from "optimize-paths";
import { defaultDevice } from "./planning.js";

/**
 * Parse an SVG string into polylines
 *
 * @param {string} svgString - The SVG content as a string
 * @returns {{ paths: Array<Array<{x: number, y: number}>>, width: number, height: number, viewBox: {x: number, y: number, width: number, height: number} | null }}
 */
export function parseSVG(svgString) {
  // Parse SVG string into DOM
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");

  // Check for parse errors
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("Invalid SVG: " + parserError.textContent);
  }

  const svg = doc.querySelector("svg");
  if (!svg) {
    throw new Error("No SVG element found");
  }

  // Get SVG dimensions
  const width = parseFloat(svg.getAttribute("width")) || 0;
  const height = parseFloat(svg.getAttribute("height")) || 0;

  // Parse viewBox
  let viewBox = null;
  const viewBoxAttr = svg.getAttribute("viewBox");
  if (viewBoxAttr) {
    const [vbX, vbY, vbWidth, vbHeight] = viewBoxAttr.split(/[\s,]+/).map(Number);
    viewBox = { x: vbX, y: vbY, width: vbWidth, height: vbHeight };
  }

  // Flatten SVG to polylines
  const lines = flattenSVG(svg, {
    maxError: 0.1, // Approximation tolerance
  });

  // Convert to our format and filter out empty paths
  const paths = lines
    .map((line) => line.points.map(([x, y]) => ({ x, y })))
    .filter((path) => path.length >= 2);

  return { paths, width, height, viewBox };
}

/**
 * Scale paths to fit within the given paper size with margins
 *
 * @param {Array<Array<{x: number, y: number}>>} paths - Input paths in SVG coordinates
 * @param {Object} options - Scaling options
 * @param {number} options.paperWidth - Paper width in mm
 * @param {number} options.paperHeight - Paper height in mm
 * @param {number} options.marginMm - Margin in mm
 * @param {boolean} options.fitPage - If true, scale to fit; if false, use 1 SVG px = 1/96 inch
 * @param {boolean} options.sortPaths - If true, reorder/reverse paths to minimize pen-up travel
 * @param {number} options.svgWidth - Original SVG width
 * @param {number} options.svgHeight - Original SVG height
 * @param {{x: number, y: number, width: number, height: number} | null} options.viewBox - SVG viewBox
 * @param {Object} options.device - Device hardware config
 * @returns {Array<Array<{x: number, y: number}>>} Paths in plotter step coordinates
 */
export function scalePaths(paths, options) {
  const {
    paperWidth,
    paperHeight,
    marginMm = 20,
    fitPage = true,
    sortPaths: shouldSort = true,
    device = defaultDevice,
  } = options;

  if (paths.length === 0) {
    return [];
  }

  // Calculate available drawing area in mm
  const drawWidth = paperWidth - 2 * marginMm;
  const drawHeight = paperHeight - 2 * marginMm;

  // Find bounding box of all paths
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const path of paths) {
    for (const point of path) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  const pathWidth = maxX - minX;
  const pathHeight = maxY - minY;

  // Handle edge cases: no valid points or degenerate bounding box
  if (!isFinite(pathWidth) || !isFinite(pathHeight) || pathWidth <= 0 || pathHeight <= 0) {
    return [];
  }

  let scale, offsetX, offsetY;

  if (fitPage) {
    // Scale to fit within drawable area while maintaining aspect ratio
    scale = Math.min(drawWidth / pathWidth, drawHeight / pathHeight);

    // Center the drawing
    const scaledWidth = pathWidth * scale;
    const scaledHeight = pathHeight * scale;
    offsetX = marginMm + (drawWidth - scaledWidth) / 2;
    offsetY = marginMm + (drawHeight - scaledHeight) / 2;
  } else {
    // Use CSS standard: 1 SVG px = 1/96 inch = 0.2645833 mm
    const pxToMm = 25.4 / 96;
    scale = pxToMm;
    offsetX = marginMm;
    offsetY = marginMm;
  }

  // Apply transformation: translate to origin, scale, translate to paper
  const stepsPerMm = device.stepsPerMm;

  const scaled = paths.map((path) =>
    path.map((point) => ({
      x: ((point.x - minX) * scale + offsetX) * stepsPerMm,
      y: ((point.y - minY) * scale + offsetY) * stepsPerMm,
    }))
  );

  // Reorder (and reverse where helpful) to minimize pen-up travel.
  // Done post-scaling so distances are in real plotter units.
  return shouldSort ? sortPaths(scaled) : scaled;
}

/**
 * Common paper sizes in mm (landscape orientation)
 */
export const PaperSizes = {
  // US sizes
  Letter: { width: 279.4, height: 215.9, name: "Letter" },
  Legal: { width: 355.6, height: 215.9, name: "Legal" },
  Tabloid: { width: 431.8, height: 279.4, name: "Tabloid" },

  // ANSI sizes
  "ANSI A": { width: 279.4, height: 215.9, name: "ANSI A" },
  "ANSI B": { width: 431.8, height: 279.4, name: "ANSI B" },

  // Arch sizes
  "Arch A": { width: 304.8, height: 228.6, name: "Arch A" },
  "Arch B": { width: 457.2, height: 304.8, name: "Arch B" },

  // ISO A sizes
  A4: { width: 297, height: 210, name: "A4" },
  A3: { width: 420, height: 297, name: "A3" },

};

/**
 * Supported plotters with max drawing area (mm) and device settings
 *
 * Device settings:
 * - stepsPerMm: stepper motor resolution
 * - penServoMin: servo PWM for pen down (100%)
 * - penServoMax: servo PWM for pen up (0%)
 */
const axidrawDevice = {
  stepsPerMm: 5,
  penServoMin: 7500,
  penServoMax: 28000,
};

// NextDraw uses brushless servo with same EBB protocol
const nextdrawDevice = {
  stepsPerMm: 5,
  penServoMin: 7500,
  penServoMax: 28000,
};

export const Plotters = {
  // AxiDraw
  "AxiDraw V3": {
    maxWidth: 300,
    maxHeight: 218,
    name: "AxiDraw V3",
    device: axidrawDevice,
  },
  "AxiDraw SE/A3": {
    maxWidth: 430,
    maxHeight: 297,
    name: "AxiDraw SE/A3",
    device: axidrawDevice,
  },

  // Bantam NextDraw
  "NextDraw 8511": {
    maxWidth: 279.4,
    maxHeight: 215.9,
    name: "NextDraw 8511",
    device: nextdrawDevice,
  },
  "NextDraw 1117": {
    maxWidth: 431.8,
    maxHeight: 279.4,
    name: "NextDraw 1117",
    device: nextdrawDevice,
  },
  "NextDraw 2234": {
    maxWidth: 863.6,
    maxHeight: 558.8,
    name: "NextDraw 2234",
    device: nextdrawDevice,
  },
};

/**
 * Get portrait version of a paper size
 */
export function portraitSize(size) {
  if (size.width > size.height) {
    return { width: size.height, height: size.width, name: size.name };
  }
  return size;
}

/**
 * Get landscape version of a paper size
 */
export function landscapeSize(size) {
  if (size.width < size.height) {
    return { width: size.height, height: size.width, name: size.name };
  }
  return size;
}
