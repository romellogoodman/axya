import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { simulateAxis } from "./sim/ebbSim.ts";
import { moveDistT3 } from "../server/driver/motion/ebbCalc.ts";

const REGRESSION = new URL(
  "../docs/reference-apps/ebb-firmware/regression-tests/",
  import.meta.url
);
const GOLDEN = new URL("./fixtures/golden/", import.meta.url);

/** Commands from a firmware regression script's command_list, paired with CSV rows. */
function regressionCases(script: string, csv: string) {
  const src = readFileSync(new URL(script, REGRESSION), "utf8");
  const list = src.slice(
    src.indexOf("command_list = ["),
    src.indexOf("]", src.indexOf("command_list = ["))
  );
  const commands = [...list.matchAll(/"((?:T3|LT),[^"]+)"/g)].map((m) => m[1]);
  const rows = readFileSync(new URL(csv, REGRESSION), "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const f = line.split(",");
      const get = (k: string) => Number(f[f.indexOf(k) + 1]);
      return {
        T: get("T"),
        S: get("S"),
        C: get("C"),
        R: get("R"),
        P: get("P"),
      };
    });
  assert.equal(
    commands.length,
    rows.length,
    `${script}: commands vs ${csv} rows`
  );
  return commands.map((cmd, i) => ({ cmd, expected: rows[i] }));
}

/**
 * In the firmware's ISR test mode (CU,250,1) a move's optional last
 * parameter is the starting accumulator; without it the accumulators are
 * cleared. Only axis 1 is reported.
 */
function runTestMode(cmd: string) {
  const [name, ...rest] = cmd.split(",");
  const n = rest.map(Number);
  const isT3 = name === "T3";
  const axis = isT3
    ? { rate: n[1], accel: n[2], jerk: n[3] }
    : { rate: n[1], accel: n[2], jerk: 0 };
  const accParam = isT3 ? n[7] : n[5];
  const r = simulateAxis(
    n[0],
    axis,
    accParam === undefined ? "clear" : accParam
  );
  return { T: n[0], S: r.stepCount, C: r.acc, R: r.rate, P: r.steps };
}

for (const [script, csv] of [
  ["python_send_T3_20230507.py", "T3_20230507_ActualOutput.csv"],
  ["python_send_LT_20230507.py", "LT_20230507_ActualOutput.csv"],
]) {
  test(`simulator reproduces firmware regression vectors (${csv})`, () => {
    for (const { cmd, expected } of regressionCases(script, csv)) {
      assert.deepEqual(runTestMode(cmd), expected, cmd);
    }
  });
}

test("moveDistT3 agrees with the simulated firmware on every golden T3/TD", () => {
  let checked = 0;
  for (const file of readdirSync(GOLDEN)) {
    const { commands } = JSON.parse(
      readFileSync(new URL(file, GOLDEN), "utf8")
    ) as {
      commands: [number, string][];
    };
    // Carry accumulators per axis through the stream, as the board does.
    const acc: [number | "clear", number | "clear"] = [0, 0];
    for (const [, line] of commands) {
      const [name, ...rest] = line.split(",");
      const n = rest.map(Number);
      if (name === "EM" || name === "CS" || name === "HM") acc[0] = acc[1] = 0;
      if (name !== "T3" && name !== "TD") continue;
      const moves =
        name === "T3"
          ? [
              {
                t: n[0],
                clear: n[7] ?? 0,
                axes: [
                  [n[1], n[2], n[3]],
                  [n[4], n[5], n[6]],
                ],
              },
            ]
          : [
              {
                t: n[0],
                clear: n[9] ?? 0,
                axes: [
                  [n[1], 0, n[4]],
                  [n[5], 0, n[8]],
                ],
              },
              {
                t: n[0],
                clear: 0,
                axes: [
                  [n[2], n[3], -n[4]],
                  [n[6], n[7], -n[8]],
                ],
              },
            ];
      for (const m of moves) {
        for (const i of [0, 1]) {
          const [rate, accel, jerk] = m.axes[i];
          const start = m.clear & (1 << i) ? "clear" : acc[i];
          const sim = simulateAxis(m.t, { rate, accel, jerk }, start);
          const calc = moveDistT3(m.t, rate, accel, jerk, start);
          assert.deepEqual(
            [calc[0], calc[1]],
            [sim.steps, sim.acc],
            `${file}: ${line} axis ${i + 1}`
          );
          acc[i] = sim.acc;
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 10000, `checked ${checked} axis moves`);
});
