/**
 * End to end: every oracle case run through the native driver (NextDraw)
 * against the fake EBB on a virtual clock must reproduce nextdraw's command
 * stream, messages, status code, final machine state, statistics and
 * output SVG exactly.
 *
 * Trig calls replay CPython's recorded results (see test/helpers/digestLibm.ts),
 * the one known source of last-bit differences between libm and V8.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setLibm } from "../server/driver/svg/libm.ts";
import { digestLibmReplay } from "./helpers/digestLibm.ts";
import { caseNames } from "./helpers/fixtures.ts";
import { messageLines } from "./helpers/machineHarness.ts";
import { runOracleCase } from "./helpers/oracleRun.ts";

let restore = () => {};
before(() => {
  restore = setLibm(digestLibmReplay());
});
after(() => restore());

for (const name of caseNames()) {
  test(`native driver reproduces oracle: ${name}`, async () => {
    const { golden, fake, messages, result } = await runOracleCase(name);
    const got = fake.log.map(([, l]) => l);
    const want = golden.commands.map(([, l]) => l);
    const first = got.findIndex((l, i) => l !== want[i]);
    assert.equal(
      first === -1 && got.length === want.length
        ? -1
        : first === -1
          ? Math.min(got.length, want.length)
          : first,
      -1,
      `first divergence at command ${first}: got ${JSON.stringify(got.slice(first, first + 3))}, ` +
        `want ${JSON.stringify(want.slice(first, first + 3))}`
    );
    assert.deepEqual(fake.log, golden.commands, "command timing");
    assert.deepEqual(messageLines(messages), golden.messages, "messages");
    assert.equal(result.status_code, golden.status_code, "status code");
    assert.deepEqual(fake.steps, golden.final_steps, "final steps");
    assert.deepEqual(fake.ram, golden.final_ram, "final EBB RAM");
    if (golden.stats) {
      assert.deepEqual(
        {
          time_estimate: result.time_estimate,
          distance_pendown: result.distance_pendown,
          distance_total: result.distance_total,
          pen_lifts: result.pen_lifts,
        },
        golden.stats,
        "stats"
      );
      assert.equal(result.output_svg, golden.output_svg, "output SVG");
    }
  });
}
