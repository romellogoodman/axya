/**
 * Resume data in uploaded SVGs. nextdraw stores pause state in an
 * <nd:plotdata> element and refuses a fresh plot of a file that holds it
 * (exiting 0 with nothing plotted), so axya clears it whenever the user
 * starts over or cancels a paused plot.
 */

import fs from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { stripData } from "./driver/run/preview.ts";
import { ResumeStatus } from "./driver/run/status.ts";

export function stripPlotDataText(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  stripData(doc.documentElement);
  return new XMLSerializer().serializeToString(doc);
}

/** Remove resume data from an SVG file in place; no-op if there is none. */
export function stripPlotDataFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.includes("plotdata")) return;
  fs.writeFileSync(filePath, stripPlotDataText(text));
}

/** Pen-down distance (mm) at which a file was paused, or null. */
export function pausedAtMm(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const resume = new ResumeStatus();
  resume.readFromSvg(doc.documentElement);
  return resume.read && resume.old.pause_dist >= 0
    ? resume.old.pause_dist * 25.4
    : null;
}
