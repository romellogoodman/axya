/**
 * NativeDriver: drives the plotter with axya's TypeScript port of the
 * nextdraw driver (server/driver/), talking to the EiBotBoard over USB
 * serial directly. Every action is one NextDraw run, exactly as one nextdraw
 * CLI invocation would be; see docs/DRIVER_PORT.md.
 */

import fs from "node:fs";
import { readConfigFile } from "../configFile.js";
import { defaultOptions, defaultParams } from "../driver/config.ts";
import { serialPortProvider } from "../driver/ebb/serialPort.ts";
import { formatFixed } from "../driver/pyfmt.ts";
import { NextDraw } from "../driver/run/nextdraw.ts";
import { formatHms } from "../driver/run/status.ts";
import { stripPlotDataFile } from "../plotdata.js";

const OPTION_KEYS = new Set(Object.keys(defaultOptions(defaultParams())));

/** nextdraw status codes (NextDraw.pause_check / serial_connect / homing). */
const STATUS_ERRORS = {
  101: { error: "No plotter connected", connected: false },
  104: { error: "USB connection to the plotter was lost", connected: false },
  105: { error: "The plotter lost power" },
  106: { error: "Automatic homing failed" },
};

export class NativeDriver {
  name = "native";

  constructor({ configPath, ports = serialPortProvider, clock }) {
    this.configPath = configPath;
    this.ports = ports;
    this.clock = clock; // undefined: real time
    this.pauseFlag = false;
    this.stopFlag = false;
  }

  /** Split the config file into per-plot options and machine params, as nextdraw does. */
  settings() {
    const options = {};
    const params = {};
    for (const [key, value] of Object.entries(
      readConfigFile(this.configPath)
    )) {
      (OPTION_KEYS.has(key) ? options : params)[key] = value;
    }
    return { options, params };
  }

  async run({ svg, options, hooks, onMove, pausable = true }) {
    const settings = this.settings();
    const messages = [];
    const nd = new NextDraw({
      svg,
      params: settings.params,
      options: { ...settings.options, ...options },
      ports: this.ports,
      clock: this.clock,
      message: (text) => {
        messages.push(text);
        for (const line of text.split(/\r\n|\r|\n/)) {
          if (line.trim()) hooks.log(line, "stdout");
        }
      },
      pauseRequested: () => pausable && this.pauseFlag,
      onMove,
    });
    try {
      const result = await nd.run();
      return { nd, result, text: messages.join("\n") };
    } finally {
      if (nd.machine.port !== null) await nd.machine.disconnect();
    }
  }

  outcome(statusCode, text) {
    if (STATUS_ERRORS[statusCode])
      return { kind: "error", ...STATUS_ERRORS[statusCode] };
    if ([1, 102, 103].includes(statusCode))
      return { kind: "paused", connected: true };
    // nextdraw returns 0 having plotted nothing when the motor supply is off.
    if (/low voltage detected/i.test(text)) {
      return {
        kind: "error",
        error: "Low voltage: is the plotter's power supply on?",
      };
    }
    return { kind: "complete", connected: true };
  }

  async plot(filePath, { layer = null, resume = false }, hooks) {
    const mode = resume ? "res_plot" : layer != null ? "layers" : "plot";
    const plotOptions = layer != null ? { mode, layer } : { mode };
    const svg = fs.readFileSync(filePath, "utf8");
    this.pauseFlag = false;
    this.stopFlag = false;

    // A preview run of the same plot gives the total travel for progress.
    const preview = await this.run({
      svg,
      options: { ...plotOptions, preview: true },
      hooks: { log: () => {} },
      pausable: false,
    });
    const totalInch = preview.result.distance_total / 0.0254;

    hooks.log(`native: ${mode} ${filePath}`, "cmd");
    const { result, text } = await this.run({
      svg,
      options: plotOptions,
      hooks,
      onMove: (run) => {
        if (totalInch <= 0) return;
        const s = run.plot_status.stats;
        const done =
          s.down_travel_inch +
          s.up_travel_inch +
          s.down_travel_tot +
          s.up_travel_tot;
        hooks.progress(Math.min(99, Math.floor((100 * done) / totalInch)));
      },
    });
    if (result.output_svg) fs.writeFileSync(filePath, result.output_svg);
    if (this.stopFlag) {
      stripPlotDataFile(filePath); // stop discards the resume point
      this.stopFlag = false;
      this.pauseFlag = false;
      return { kind: "stopped" };
    }
    this.pauseFlag = false;
    return this.outcome(result.status_code, text);
  }

  requestPause() {
    this.pauseFlag = true;
  }

  /** Stop is a pause whose resume data is then discarded. */
  requestStop() {
    this.stopFlag = true;
    this.pauseFlag = true;
  }

  /** utility_cmd: raise_pen, lower_pen, walk_mmx, walk_mmy, walk_home, ... */
  async utility(cmd, { dist } = {}, hooks) {
    const options = { mode: "utility", utility_cmd: cmd };
    if (dist != null) options.dist = String(dist);
    hooks.log(`native: utility ${cmd}${dist != null ? ` ${dist}` : ""}`, "cmd");
    const { result, text } = await this.run({ options, hooks });
    return this.outcome(result.status_code, text);
  }

  /** Preview run; the same figures nextdraw's --report_time prints. */
  async estimate(svgText, layer) {
    const options =
      layer != null
        ? { mode: "layers", layer, preview: true }
        : { preview: true };
    const { nd, result } = await this.run({
      svg: svgText,
      options,
      hooks: { log: () => {} },
    });
    const s = nd.plot_status.stats;
    const draw = 0.0254 * s.down_travel_tot;
    const travel = 0.0254 * s.up_travel_tot;
    return {
      time: formatHms(result.time_estimate),
      drawDistance: `${formatFixed(draw, 3)} m`,
      travelDistance: `${formatFixed(travel, 3)} m`,
      totalDistance: `${formatFixed(draw + travel, 3)} m`,
    };
  }
}
