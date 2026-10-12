/*
 * SVG parsing and digest: the public surface of server/driver/svg.
 *
 * Original work for axya; distributed under AGPL-3.0. The modules re-exported
 * here are ported from nextdraw 1.7.5, plotink and ink_extensions; each
 * file's header names its source and license.
 *
 * Boundary:
 * - DigestSVG(ctx).processSvg(root, [s_x, s_y, layer], transform) turns an
 *   @xmldom/xmldom <svg> element into a DocDigest (inches). DigestContext
 *   names everything it reads: params.curve_tolerance,
 *   params.overrides.curve_tolerance, svg_width/svg_height (inches) and a
 *   PlotWarnings sink for text/image/unsupported-element warnings.
 * - docProps(root, auto_rotate) and viewBoxTransform(root, w, h) are the
 *   NextDraw.get_doc_props / prepare_document steps that produce those inputs.
 * - verifyPlob(...) decides whether an input is already a plob.
 * Most callers want prepareDocument in server/driver/digest instead.
 *
 * libm/setLibm: the trig functions used for arcs and rotate/skew transforms.
 * V8 and CPython's platform libm differ by up to one ulp; tests replay
 * CPython's values through setLibm.
 */

export {
  DigestSVG,
  docProps,
  verifyPlob,
  viewBoxTransform,
  inheritStyle,
  convertRectToPath,
  convertLineToPath,
  convertPolylinePolygonToPath,
  convertCircleEllipseToPath,
} from "./digest.ts";
export type { DigestContext, DocProps, StyleDict } from "./digest.ts";
export { libm, setLibm } from "./libm.ts";
export type { Libm } from "./libm.ts";
export * as simplepath from "./simplepath.ts";
export * as cubicsuperpath from "./cubicsuperpath.ts";
export * as simpletransform from "./simpletransform.ts";
export * as plotUtils from "./plotUtils.ts";
