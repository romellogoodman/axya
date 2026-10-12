import { test } from "node:test";
import assert from "node:assert/strict";
import {
  goldenPlanner,
  makeHarness,
  messageLines,
  runCase,
  teardown,
} from "./helpers/machineHarness.ts";

// Cases whose whole stream is machine setup/teardown (no planned motion).
const FULL = [
  "plot-cold-homing-fail-out-of-range",
  "plot-low-voltage",
  "util-raise-pen",
  "util-lower-pen",
  "util-toggle",
  "util-cycle",
  "util-align",
  "util-enable-xy",
  "util-disable-xy",
  "util-set-home",
  "util-find-home-cold",
];

// Plot cases: the port's setup must equal the golden's opening lines, up to
// the first planned plot motion.
const SETUP = [
  "plot-basic",
  "plot-cold-homing",
  "plot-no-homing-option",
  "plot-shapes-model2",
  "plot-shapes-model1-penlift3",
  "plot-pen-settings",
];

// Walks: setup and teardown by the port, the pen-up move from the golden.
const WALKS = [
  "util-walk-home",
  "util-walk-mmx",
  "util-walk-mmy-neg",
  "util-walk-x-inch",
];

for (const name of FULL) {
  test(`machine sequence matches oracle: ${name}`, async () => {
    const h = makeHarness(name);
    assert.equal(await runCase(h), "done");
    assert.deepEqual(h.fake.log, h.golden.commands);
    assert.deepEqual(messageLines(h.messages), h.golden.messages);
    assert.equal(h.nd.plot_status.stopped, h.golden.status_code);
    assert.deepEqual(h.fake.steps, h.golden.final_steps);
    assert.deepEqual(h.fake.ram, h.golden.final_ram);
  });
}

for (const name of WALKS) {
  test(`walk sequence matches oracle: ${name}`, async () => {
    const h = makeHarness(name, goldenPlanner);
    assert.equal(await runCase(h), "done");
    assert.deepEqual(h.fake.log, h.golden.commands);
    assert.deepEqual(messageLines(h.messages), h.golden.messages);
    assert.deepEqual(h.fake.steps, h.golden.final_steps);
    assert.deepEqual(h.fake.ram, h.golden.final_ram);
  });
}

for (const name of SETUP) {
  test(`plot setup matches oracle: ${name}`, async () => {
    const h = makeHarness(name);
    assert.equal(await runCase(h), "planned");
    const n = h.fake.log.length;
    assert.deepEqual(h.fake.log, h.golden.commands.slice(0, n));
    assert.match(h.golden.commands[n][1], /^(T3|TD),/);
  });

  test(`plot teardown matches oracle: ${name}`, async () => {
    // Replay everything up to precision_move_to(0, 0) into the fake, then let
    // the port finish: precision_move_to, servo_revert, disconnect.
    const h = makeHarness(name);
    const cmds = h.golden.commands;
    let start = cmds.length - 1;
    while (!(cmds[start][1] === "QL,24" && cmds[start - 1][1] !== "QS"))
      start--;
    for (const [, line] of cmds.slice(0, start)) h.fake.replay(line);
    h.fake.log = [];

    const { nd } = h;
    nd.machine.port = h.fake;
    nd.machine.caller = "nextdraw";
    nd.pen.phys.z_up = true;
    await nd.homing.precisionMoveTo(0, 0);
    await teardown(nd);
    assert.deepEqual(
      h.fake.log.map(([, l]) => l),
      cmds.slice(start).map(([, l]) => l)
    );
    assert.deepEqual(h.fake.steps, h.golden.final_steps);
    assert.deepEqual(h.fake.ram, h.golden.final_ram);
  });
}
