import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../server/driver/ebb/transport.ts";
import { FakeEbbTransport, type FakeEbbSettings } from "./sim/fakeEbb.ts";
import { caseNames, loadGolden } from "./helpers/fixtures.ts";

// Replaying each recorded stream must leave the TS fake in the same final
// state as the Python fake that recorded it.
for (const name of caseNames()) {
  test(`fake EBB replays golden stream: ${name}`, async () => {
    const g = loadGolden(name);
    const fake = new FakeEbbTransport(
      new VirtualClock(),
      g.case.fake as FakeEbbSettings
    );
    for (const [, line] of g.commands) {
      await fake.writeLine(line);
      while ((await fake.readLine(1000)) !== null);
    }
    assert.deepEqual(fake.steps, g.final_steps);
    assert.deepEqual(fake.ram, g.final_ram);
  });
}

test("fake EBB replies in legacy then future syntax", async () => {
  const fake = new FakeEbbTransport(new VirtualClock());
  await fake.writeLine("v");
  assert.equal(
    await fake.readLine(0),
    "EBBv13_and_above EB Firmware Version 3.1.7\r"
  );
  await fake.writeLine("CU,10,1");
  assert.equal(await fake.readLine(0), "\r"); // bare newline, sent before the switch
  await fake.writeLine("QG");
  assert.equal(await fake.readLine(0), "QG,00");
  await fake.writeLine("SP,0,47,2");
  assert.equal(await fake.readLine(0), "SP");
  await fake.writeLine("QG");
  assert.equal(await fake.readLine(0), "QG,10");
  assert.equal(await fake.readLine(0), null);
});

test("fake EBB limit switch stops SM and latches", async () => {
  const fake = new FakeEbbTransport(new VirtualClock(), { start_x_mm: 1 });
  for (const line of ["CU,10,1", "CU,52,2", "CU,51,2", "SM,100,-200,-200"]) {
    await fake.writeLine(line);
  }
  // x = 80 steps, dx = -200: stops 40% of the way.
  assert.deepEqual(fake.steps, [-80, -80]);
  assert.ok(fake.limit_triggered);
  await fake.writeLine("SM,100,-200,-200"); // ignored while latched
  assert.deepEqual(fake.steps, [-80, -80]);
  await fake.flushInput();
  await fake.writeLine("QG");
  assert.equal(await fake.readLine(0), "QG,80");
  await fake.writeLine("PI,B,1");
  assert.equal(await fake.readLine(0), "PI,1");
});
