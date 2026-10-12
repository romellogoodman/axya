import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createConfig,
  updateOptions,
  type Params,
} from "../server/driver/config.ts";
import { loadGolden, loadStages, stageNames } from "./helpers/fixtures.ts";

// Options that nextdraw itself rewrites between update_options and
// prepare_document (resume restores them from <plotdata>); covered by the
// run-loop port, not here.
const RESUME_CASES = (name: string) =>
  loadGolden(name).case.options.mode === "res_plot";

// Utility cases (walks) never reach prepare_document, so they record planner
// calls but no settings snapshot.
const hasSettings = (name: string) => loadStages(name).params !== undefined;

for (const name of stageNames().filter(
  (n) => !RESUME_CASES(n) && hasSettings(n)
)) {
  test(`config matches oracle: ${name}`, () => {
    const { case: c } = loadGolden(name);
    const stages = loadStages(name);
    const state = createConfig(c.params as Partial<Params>);
    Object.assign(state.options, c.options);
    updateOptions(state);
    state.options.page_delay = Math.max(state.options.page_delay, 0);

    for (const [key, expected] of Object.entries(stages.params)) {
      assert.ok(key in state.params, `params.${key} missing from port`);
      assert.deepEqual(
        state.params[key as keyof Params],
        expected,
        `params.${key}`
      );
    }
    for (const [key, expected] of Object.entries(stages.options)) {
      if (key === "ids" || key === "selected_nodes") continue; // inkex bookkeeping
      assert.deepEqual(
        state.options[key as keyof typeof state.options],
        expected,
        `options.${key}`
      );
    }
    assert.deepEqual(state.bounds, stages.bounds);
  });
}
