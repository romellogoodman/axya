/**
 * Rebuilds the planner state nextdraw had at each recorded planner call
 * (see test/oracle/README.md, "Stage fixtures").
 *
 * Settings come from the stage snapshot, or for utility walks (which never
 * reach prepare_document) from the default config plus the case options.
 * step_scale and the speeds follow serial_utils.enable_motors. Layer +s
 * speeds are replayed by matching the k-th trajectory call to the k-th
 * plottable path (subpaths[0] with two or more vertices) of the final
 * digest, which is the order plot_doc_digest plots them in.
 */

import {
  createConfig,
  updateOptions,
  type Options,
  type Params,
  type Bounds,
} from "../../server/driver/config.ts";
import {
  motionScales,
  type PenPosition,
  type PlannerContext,
} from "../../server/driver/motion/index.ts";
import { loadGolden, loadStages, type PlannerCall } from "./fixtures.ts";

export interface PlannerCase {
  name: string;
  options: Options;
  params: Params;
  bounds: Bounds;
  calls: PlannerCall[];
  /** layer +s speed (or null) for each call, by owning trajectory */
  layerSpeeds: (number | null)[];
}

export function loadPlannerCase(name: string): PlannerCase {
  const stages = loadStages(name);
  const calls = stages.planner ?? [];
  let options: Options, params: Params, bounds: Bounds;
  if (stages.params) {
    options = stages.options as unknown as Options;
    params = stages.params as unknown as Params;
    bounds = stages.bounds;
  } else {
    const c = loadGolden(name).case;
    const state = createConfig(c.params as Partial<Params>);
    Object.assign(state.options, c.options);
    updateOptions(state);
    ({ options, params, bounds } = state);
  }

  // Layer speed of each plottable path, in plot order.
  const pathSpeeds: (number | null)[] = [];
  const digest = stages.digest?.at(-1)?.[1];
  for (const layer of digest?.layers ?? []) {
    const speed = (layer.props.speed as number | null) ?? null;
    for (const path of layer.paths) {
      if ((path.subpaths[0]?.length ?? 0) >= 2) pathSpeeds.push(speed);
    }
  }
  const anySpeed = pathSpeeds.some((s) => s !== null);

  // A compute_segment belongs to the next trajectory entry when it is
  // pen-down (nested in plan_trajectory); pen-up travel ignores speed_pendown.
  const layerSpeeds: (number | null)[] = [];
  let trajIndex = 0;
  for (const call of calls) {
    layerSpeeds.push(anySpeed ? (pathSpeeds[trajIndex] ?? null) : null);
    if (call.fn === "trajectory") trajIndex++;
  }
  return { name, options, params, bounds, calls, layerSpeeds };
}

export interface RecordedWarnings {
  list: [string, string | undefined][];
  add_new(warningName: string, value?: string): void;
}

export function contextFor(
  pc: PlannerCase,
  index: number,
  phys: PenPosition
): PlannerContext & { warnings: RecordedWarnings } {
  const scales = motionScales(pc.options, pc.params, pc.layerSpeeds[index]);
  const list: [string, string | undefined][] = [];
  return {
    options: pc.options,
    params: pc.params,
    bounds: pc.bounds,
    ...scales,
    pen: { phys },
    warnings: {
      list,
      add_new(warningName: string, value?: string) {
        list.push([warningName, value]);
      },
    },
  };
}

/** A recorded PenPosition as the port's type. */
export function pen(record: Record<string, unknown>): PenPosition {
  return {
    xpos: record.xpos as number | null,
    ypos: record.ypos as number | null,
    z_up: record.z_up as boolean | null,
    accum1: record.accum1 as number,
    accum2: record.accum2 as number,
    homed: record.homed as boolean,
  };
}
