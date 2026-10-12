/** Helpers for digest-stage tests: snapshots in the oracle's shape, and case inputs. */

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import type { DocDigest } from "../../server/driver/digest/pathObjects.ts";
import type { PrepareContext } from "../../server/driver/digest/prepare.ts";
import type { Bounds, Options, Params } from "../../server/driver/config.ts";
import { PlotWarnings } from "../../server/driver/warnings.ts";
import {
  type DigestSnapshot,
  type Stages,
  fixtureUrl,
  loadGolden,
} from "./fixtures.ts";

/** A DocDigest in the shape test/oracle/run.py digest_json records. */
export function digestSnapshot(d: DocDigest): DigestSnapshot {
  return {
    width: d.width,
    height: d.height,
    flat: d.flat,
    layers: d.layers.map((l) => ({
      name: l.name,
      item_id: l.item_id,
      props: { ...l.props },
      paths: l.paths.map((p) => ({
        item_id: p.item_id,
        stroke: p.stroke,
        fill: p.fill,
        fill_rule: p.fill_rule,
        subpaths: p.subpaths.map((s) =>
          s.map((v) => [v[0], v[1]] as [number, number])
        ),
      })),
    })),
  };
}

/** The SVG text a case was run on. */
export function caseSvgText(name: string): string {
  const svg = loadGolden(name).case.svg;
  if (svg === undefined) throw new Error(`case ${name} has no SVG`);
  if (typeof svg === "object") {
    const out = loadGolden(svg.from).output_svg;
    if (out === undefined)
      throw new Error(`case ${svg.from} has no output_svg`);
    return out;
  }
  // Goldens store paths relative to the repository root.
  return readFileSync(fixtureUrl(`../../${svg}`), "utf8");
}

export function parseSvgRoot(text: string): Element {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  return doc.documentElement as Element;
}

function plotdataAttr(root: Element, name: string): string | null {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    const el = n as Element;
    if (
      n.nodeType === 1 &&
      el.localName === "plotdata" &&
      el.hasAttribute(name)
    ) {
      return el.getAttribute(name);
    }
  }
  return null;
}

/**
 * Pipeline context for a recorded case, using the oracle's resolved
 * settings. The layer, plob version and seed come from the case's mode and
 * the input's <plotdata>, as nextdraw's plot_status would set them.
 */
export function caseContext(stages: Stages, root: Element): PrepareContext {
  const options = stages.options as unknown as Options;
  const params = stages.params as unknown as Params;
  let layer = -1;
  if (options.mode === "layers") layer = options.layer;
  const pauseRef = plotdataAttr(root, "pause_ref");
  if (
    options.mode === "res_plot" &&
    pauseRef !== null &&
    Number(pauseRef) >= 0
  ) {
    layer = Number(plotdataAttr(root, "layer"));
  }
  let seed: number | null = null;
  if (options.random_start) {
    // The oracle's virtual clock starts at 1.7e9 s: int(time.time() * 100).
    seed =
      options.mode === "res_plot"
        ? Number(plotdataAttr(root, "rand_seed"))
        : 170000000000;
  }
  return {
    options,
    params,
    bounds: stages.bounds as Bounds,
    layer,
    plob_version: plotdataAttr(root, "plob_version"),
    rand_seed: seed,
    warnings: new PlotWarnings(),
  };
}
