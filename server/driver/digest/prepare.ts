/*
 * Document preparation: SVG to an optimized, plot-ready DocDigest.
 *
 * Ported from NextDraw.get_doc_props, prepare_document and
 * randomize_optimize (nextdrawcore/nextdraw.py:570-694, :995-1012,
 * nextdraw 1.7.5), docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import type { Element } from "@xmldom/xmldom";
import type { Bounds, Options, Params } from "../config.ts";
import type { PlotWarnings } from "../warnings.ts";
import {
  DigestSVG,
  docProps,
  verifyPlob,
  viewBoxTransform,
} from "../svg/digest.ts";
import {
  connectNearbyEnds,
  randomizeStart,
  reorder,
  supersample,
} from "../optimize/optimizations.ts";
import { clipAtBounds } from "./boundsclip.ts";
import { DocDigest } from "./pathObjects.ts";

export type Stage =
  | "process_svg"
  | "rotate"
  | "flatten"
  | "clip_at_bounds"
  | "connect_nearby_ends"
  | "supersample"
  | "randomize_start"
  | "reorder";

/** Everything prepare_document reads from the NextDraw object. */
export interface PrepareContext {
  options: Pick<
    Options,
    "auto_rotate" | "hiding" | "model" | "random_start" | "reordering"
  >;
  params: Pick<
    Params,
    | "auto_rotate_ccw"
    | "bounds_tolerance"
    | "clip_to_page"
    | "curve_tolerance"
    | "min_gap"
    | "model_name"
    | "overrides"
  >;
  bounds: Bounds;
  /** plot_status.resume.new.layer: -1 (or -2) for all layers, else the layer number. */
  layer: number;
  /**
   * plot_status.resume.old.plob_version: the plotdata's plob_version, or
   * null without plotdata. Any non-empty value makes nextdraw try the plob path.
   */
  plob_version: string | null;
  /** Seed for random_start: int(time.time()*100), or the stored rand_seed when resuming. */
  rand_seed: number | bigint | null;
  warnings: PlotWarnings;
  /** Called after each pipeline stage, with the live digest (for tests and tracing). */
  onStage?: (stage: Stage, digest: DocDigest) => void;
}

export interface PreparedDocument {
  digest: DocDigest;
  svg_width: number;
  svg_height: number;
  rotate_page: boolean;
  doc_units: string | null;
  /** [s_x, s_y, o_x, o_y]: nextdraw's vb_stash */
  vb_stash: [number, number, number, number];
  /** True when the input was a valid plob, so no processing was done. */
  valid_plob: boolean;
}

/** Thrown after process_svg (and rotate) when options.hiding is set. */
export class HidingNotPortedError extends Error {
  constructor() {
    super("Hidden-line removal (options.hiding) is not ported yet");
    this.name = "HidingNotPortedError";
  }
}

/**
 * prepare_document: returns null when the document has no usable size
 * (nextdraw logs an error and stops). Does not crop for res_plot; call
 * digest.crop(pause_dist) afterwards, as nextdraw does.
 */
export function prepareDocument(
  svg: Element,
  ctx: PrepareContext
): PreparedDocument | null {
  const props = docProps(svg, ctx.options.auto_rotate);
  if (props === null) return null;
  const { svg_width, svg_height, rotate_page } = props;
  const { vb, transform } = viewBoxTransform(svg, svg_width, svg_height);
  const [sX, sY] = vb;
  const stage = (s: Stage, d: DocDigest) => ctx.onStage?.(s, d);
  const result = (
    digest: DocDigest,
    valid_plob: boolean
  ): PreparedDocument => ({
    digest,
    svg_width,
    svg_height,
    rotate_page,
    doc_units: props.doc_units,
    vb_stash: vb,
    valid_plob,
  });

  if (
    ctx.plob_version &&
    verifyPlob(svg, ctx.options.model, ctx.bounds, svg_width, svg_height)
  ) {
    const digest = new DocDigest();
    digest.fromPlob(svg, svg_width, svg_height);
    digest.layerFilter(ctx.layer);
    return result(digest, true);
  }

  const digester = new DigestSVG({
    params: ctx.params,
    svg_width,
    svg_height,
    warnings: ctx.warnings,
  });
  const digest = digester.processSvg(
    svg,
    [sX, sY, ctx.options.hiding ? -2 : ctx.layer],
    transform
  );
  stage("process_svg", digest);

  if (rotate_page) {
    digest.rotate(ctx.params.auto_rotate_ccw);
    stage("rotate", digest);
  }

  if (ctx.options.hiding) throw new HidingNotPortedError();

  const docBounds = rotate_page
    ? [svg_height + 1e-9, svg_width + 1e-9]
    : [svg_width + 1e-9, svg_height + 1e-9];
  // clip_at_bounds flattens first; doing it here only exposes the stage.
  digest.flatten();
  stage("flatten", digest);
  const outOfBounds = clipAtBounds(
    digest,
    ctx.bounds,
    docBounds,
    ctx.params.bounds_tolerance,
    ctx.params.clip_to_page
  );
  stage("clip_at_bounds", digest);
  if (outOfBounds) ctx.warnings.addNew("bounds", ctx.params.model_name);

  connectNearbyEnds(digest, ctx.params.min_gap, ctx.options.reordering);
  stage("connect_nearby_ends", digest);
  supersample(digest, ctx.params.curve_tolerance / 3);
  stage("supersample", digest);
  randomizeOptimize(digest, ctx);
  return result(digest, false);
}

/** randomize_optimize: random start points (if enabled), then reordering. */
export function randomizeOptimize(
  digest: DocDigest,
  ctx: Pick<PrepareContext, "options" | "rand_seed" | "onStage">
): void {
  if (ctx.options.random_start) {
    randomizeStart(digest, ctx.rand_seed);
    ctx.onStage?.("randomize_start", digest);
  }
  reorder(digest, ctx.options.reordering);
  ctx.onStage?.("reorder", digest);
}
