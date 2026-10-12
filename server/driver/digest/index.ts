/*
 * Document digest model and preparation: the public surface of
 * server/driver/digest.
 *
 * Original work for axya; distributed under AGPL-3.0. The modules re-exported
 * here are ported from nextdraw 1.7.5; each file's header names its source.
 *
 * Boundary (what a run loop calls):
 *
 *   prepareDocument(svgRoot: Element, ctx: PrepareContext): PreparedDocument | null
 *
 * runs nextdraw's prepare_document: page size and auto-rotation, viewBox
 * scaling, plob detection, SVG digest, rotation, clipping at bounds (or
 * hidden-line removal with options.hiding), path joining, supersampling,
 * then randomizeOptimize (random start + reordering).
 * It returns null when the page size is unusable. PrepareContext lists every
 * input: options (auto_rotate, hiding, model, random_start, reordering),
 * params (auto_rotate_ccw, bounds_tolerance, clip_to_page, curve_tolerance,
 * min_gap, model_name, overrides), bounds, the layer selection
 * (plot_status.resume.new.layer), the input's plotdata plob_version, the
 * random-start seed, a PlotWarnings sink, and an optional onStage hook.
 *
 * After it: digest.crop(pause_dist) for res_plot, and randomizeOptimize()
 * again for later copies (nextdraw re-randomizes and reorders per copy).
 */

export {
  DocDigest,
  LayerItem,
  LayerProperties,
  PathItem,
  PLOB_VERSION,
  findInt,
  polylineStringToList,
  vertexListToString,
} from "./pathObjects.ts";
export type { Vertex } from "./pathObjects.ts";
export { clipAtBounds, getClipBounds } from "./boundsclip.ts";
export type { ClipBoundsContext } from "./boundsclip.ts";
export { prepareDocument, randomizeOptimize } from "./prepare.ts";
export type { PrepareContext, PreparedDocument, Stage } from "./prepare.ts";
