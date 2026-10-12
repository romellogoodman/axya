import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers/machineHarness.ts";
import { caseNames, loadGolden } from "./helpers/fixtures.ts";

// layers.svg switches to temporary (+h) heights mid-plot and has a layer delay
// right after one raise; the run-loop tests cover those cases.
const usesLayerCodes = (name: string) => {
  const svg = loadGolden(name).case.svg;
  return typeof svg === "string" && svg.endsWith("/layers.svg");
};

const spLines = (name: string) =>
  loadGolden(name)
    .commands.map(([ms, line], i, all) => ({ ms, line, next: all[i + 1] }))
    .filter(({ line }) => /^SP,[01],/.test(line));

for (const name of caseNames().filter((n) => !usesLayerCodes(n))) {
  const sps = spLines(name);
  if (sps.length === 0) continue;

  test(`pen timing matches oracle: ${name}`, () => {
    const h = makeHarness(name);
    h.nd.pen.heights.update(h.nd);
    const { raise_time, lower_time } = h.nd.pen.heights.times;
    const quiet = ["utility", "align", "cycle"].includes(h.nd.options.mode);

    for (const { ms, line, next } of sps) {
      const [, dir, delay] = line.split(",");
      const vTime = Number(delay);
      assert.equal(vTime, dir === "1" ? raise_time : lower_time, line);
      // servo_init's SP (followed by SC,8) never sleeps; raise/lower do.
      if (!next || next[1].startsWith("SC,8")) continue;
      const expected = vTime > 50 && !quiet ? vTime - 30 : 0;
      assert.ok(Math.abs(next[0] - ms - expected) < 0.01, `${line} at ${ms}`);
    }
  });
}

test("penRaise/penLower sleep v_time - 30 ms in plot mode only", async () => {
  const h = makeHarness("plot-pen-settings"); // raise 273 ms, lower 1100 ms
  const { nd, clock, fake } = h;
  nd.machine.port = fake;
  nd.pen.heights.update(nd);
  nd.pen.phys.z_up = true;

  await nd.pen.penLower(nd);
  assert.ok(Math.abs(clock.now() - 1070) < 1e-3);
  await nd.pen.penLower(nd); // already down: nothing sent
  await nd.pen.penRaise(nd);
  assert.ok(Math.abs(clock.now() - (1070 + 243)) < 1e-3);
  assert.deepEqual(
    fake.log.map(([, l]) => l),
    ["SP,0,1100,2", "SP,1,273,2"]
  );
  assert.equal(nd.pen.status.lifts, 1);

  nd.options.mode = "cycle";
  const before = clock.now();
  await nd.pen.penLower(nd);
  assert.equal(clock.now(), before);
});

test("pen lowering is skipped once the plot is stopped", async () => {
  const h = makeHarness("plot-basic");
  h.nd.machine.port = h.fake;
  h.nd.pen.heights.update(h.nd);
  h.nd.plot_status.stopped = 102;
  await h.nd.pen.penLower(h.nd);
  assert.deepEqual(h.fake.log, []);
  assert.equal(h.nd.pen.phys.z_up, null);
});
