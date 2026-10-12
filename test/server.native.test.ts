/**
 * The server's PlotterManager over the native driver, against the fake EBB
 * on a virtual clock: plotting, manual commands, pause/resume, stop and
 * estimates, end to end through the same code paths the REST API uses.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { VirtualClock } from "../server/driver/ebb/transport.ts";
import { NativeDriver } from "../server/drivers/native.js";
import { PlotterManager } from "../server/plotter.js";
import { pausedAtMm } from "../server/plotdata.js";
import { fixtureUrl, loadGolden } from "./helpers/fixtures.ts";
import { FakeEbbTransport, fakePortProvider } from "./sim/fakeEbb.ts";

function setup(svgName = "square-circle.svg") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axya-native-"));
  const configPath = path.join(dir, "nextdraw.conf.py");
  fs.writeFileSync(configPath, "model = 8\n");
  const uploads = path.join(dir, "uploads");
  fs.mkdirSync(uploads);
  fs.copyFileSync(fixtureUrl(`svg/${svgName}`), path.join(uploads, svgName));
  const clock = new VirtualClock();
  const fake = new FakeEbbTransport(clock, { homed: true, motors_on: true });
  const driver = new NativeDriver({
    configPath,
    ports: fakePortProvider(fake),
    clock,
  });
  const plotter = new PlotterManager({
    configPath,
    uploadsDir: uploads,
    driver,
  });
  return { plotter, fake, file: path.join(uploads, svgName), name: svgName };
}

function settled(plotter: PlotterManager): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (plotter.state !== "plotting") {
        plotter.off("change", check);
        resolve();
      }
    };
    plotter.on("change", check);
    check();
  });
}

test("plot reproduces nextdraw's command stream and reports completion", async () => {
  const { plotter, fake, name, file } = setup();
  plotter.plot(name);
  await settled(plotter);
  assert.equal(plotter.state, "idle");
  assert.equal(plotter.progress, 100);
  assert.equal(plotter.connected, true);
  assert.deepEqual(plotter.status().machine, {
    firmware: "3.1.7",
    nickname: null,
  });
  const want = loadGolden("plot-basic").commands.map(([, l]) => l);
  assert.deepEqual(
    fake.log.map(([, l]) => l),
    want
  );
  assert.equal(
    pausedAtMm(fs.readFileSync(file, "utf8")),
    null,
    "no resume data after a full plot"
  );
});

test("pen up matches nextdraw's raise_pen", async () => {
  const { plotter, fake } = setup();
  await plotter.pen("up");
  assert.deepEqual(
    fake.log.map(([, l]) => l),
    loadGolden("util-raise-pen").commands.map(([, l]) => l)
  );
});

test("pause saves a resume point; resume finishes the plot", async () => {
  const { plotter, name, file } = setup("shapes.svg");
  const onChange = () => {
    if (plotter.state === "plotting" && plotter.progress >= 30) plotter.pause();
  };
  plotter.on("change", onChange);
  plotter.plot(name);
  await settled(plotter);
  plotter.off("change", onChange);
  assert.equal(plotter.state, "paused");
  const at = pausedAtMm(fs.readFileSync(file, "utf8"));
  assert.ok(at !== null && at > 0, `paused at ${at} mm`);

  plotter.resume();
  await settled(plotter);
  assert.equal(plotter.state, "idle");
  assert.equal(plotter.progress, 100);
  assert.equal(pausedAtMm(fs.readFileSync(file, "utf8")), null);
});

test("plot on a paused file starts over instead of silently doing nothing", async () => {
  const { plotter, fake, name } = setup("shapes.svg");
  const onChange = () => {
    if (plotter.state === "plotting" && plotter.progress >= 20) plotter.pause();
  };
  plotter.on("change", onChange);
  plotter.plot(name);
  await settled(plotter);
  plotter.off("change", onChange);
  assert.equal(plotter.state, "paused");

  const before = fake.log.length;
  plotter.plot(name);
  await settled(plotter);
  assert.equal(plotter.state, "idle");
  assert.equal(plotter.progress, 100);
  assert.ok(
    fake.log
      .slice(before)
      .some(([, l]) => l.startsWith("T3") || l.startsWith("TD"))
  );
});

test("stop ends the plot and discards the resume point", async () => {
  const { plotter, name, file } = setup("shapes.svg");
  const onChange = () => {
    if (plotter.state === "plotting" && plotter.progress >= 10) plotter.stop();
  };
  plotter.on("change", onChange);
  plotter.plot(name);
  await settled(plotter);
  plotter.off("change", onChange);
  assert.equal(plotter.state, "idle");
  assert.ok(plotter.progress < 100);
  assert.equal(pausedAtMm(fs.readFileSync(file, "utf8")), null);
});

test("estimate reports nextdraw's preview figures", async () => {
  const { plotter, name } = setup();
  const est = await plotter.estimate(name);
  assert.match(est.time, /Seconds|Minutes/);
  assert.match(est.drawDistance, /^\d+\.\d{3} m$/);
  assert.match(est.travelDistance, /^\d+\.\d{3} m$/);
});

test("no plotter attached is reported as disconnected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axya-native-"));
  const configPath = path.join(dir, "nextdraw.conf.py");
  fs.writeFileSync(configPath, "model = 8\n");
  const driver = new NativeDriver({
    configPath,
    ports: {
      list: async () => [],
      open: async () => Promise.reject(new Error("none")),
    },
    clock: new VirtualClock(),
  });
  const plotter = new PlotterManager({ configPath, uploadsDir: dir, driver });
  await assert.rejects(plotter.pen("up"), /No plotter connected/);
  assert.equal(plotter.connected, false);
});
