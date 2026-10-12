/**
 * PlotterManager: the plotter's state machine (idle | plotting | paused |
 * error), log buffer and change events, over a pluggable driver:
 *
 *   drivers/native.js  axya's TypeScript port of the nextdraw driver
 *   drivers/cli.js     Bantam's `nextdraw` CLI as a subprocess (transitional)
 *
 * AXYA_DRIVER=native|cli selects one (default: native; cli remains as a
 * fallback until hardware bring-up is complete, see docs/DRIVER_PORT.md).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { CliDriver } from "./drivers/cli.js";
import { NativeDriver } from "./drivers/native.js";
import { stripPlotDataFile, stripPlotDataText } from "./plotdata.js";

export function createDriver(name, opts) {
  if (name === "native") return new NativeDriver(opts);
  if (name === "cli") return new CliDriver(opts);
  throw new Error(`Unknown AXYA_DRIVER "${name}" (expected native or cli)`);
}

export class PlotterManager extends EventEmitter {
  constructor({ configPath, uploadsDir, driver }) {
    super();
    this.configPath = configPath;
    this.uploadsDir = uploadsDir;
    this.driver =
      driver ?? createDriver(process.env.AXYA_DRIVER || "native", { configPath });

    this.state = "idle";
    this.currentFile = null;
    this.currentLayer = null;
    this.progress = 0;
    this.startedAt = null;
    this.error = null;
    this.canHome = false;
    this.connected = null; // null=unknown, true=connected, false=no device
    this.busy = false; // a manual command is running
    this.machine = null; // { firmware, nickname } from the last native session

    this.logs = [];
    this.logVersion = 0;
    this.hooks = {
      log: (line, level) => this.log(line, level),
      machine: (info) => {
        this.machine = info;
        this.emit("change");
      },
      progress: (pct) => {
        if (pct !== this.progress) {
          this.progress = pct;
          this.emit("change");
        }
      },
    };
    this.log(`Driver: ${this.driver.name}`);
  }

  status() {
    return {
      state: this.state,
      driver: this.driver.name,
      currentFile: this.currentFile,
      currentLayer: this.currentLayer,
      progress: this.progress,
      startedAt: this.startedAt,
      error: this.error,
      canHome: this.canHome,
      logVersion: this.logVersion,
      connected: this.connected,
      machine: this.machine,
    };
  }

  log(line, level = "info") {
    this.logs.push({ t: Date.now(), level, line });
    if (this.logs.length > 200) this.logs.shift();
    this.logVersion++;
    this.emit("change");
  }

  setState(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this.emit("change");
  }

  filePath(filename) {
    const p = path.join(this.uploadsDir, path.basename(filename));
    if (!fs.existsSync(p)) throw new Error(`File not found: ${filename}`);
    return p;
  }

  /** Start a plot, or resume a paused one. Resolves when it is under way. */
  plot(filename, { layer = null, resume = false } = {}) {
    if (this.state === "plotting" || this.busy)
      throw new Error("The plotter is busy");
    const filePath = this.filePath(filename);
    // Plot always starts over: nextdraw refuses (silently) to replot a file
    // that still holds resume data from an earlier pause.
    if (!resume) stripPlotDataFile(filePath);

    this.currentFile = filename;
    this.currentLayer = layer;
    this.setState("plotting", {
      progress: 0,
      startedAt: Date.now(),
      error: null,
      canHome: false,
    });
    this.driver
      .plot(filePath, { layer, resume }, this.hooks)
      .then((outcome) => this.finishPlot(outcome, filename))
      .catch((err) => {
        this.log(err.message, "error");
        this.setState("error", { error: err.message, canHome: true });
      });
  }

  finishPlot(outcome, filename) {
    if (outcome.connected !== undefined) this.connected = outcome.connected;
    switch (outcome.kind) {
      case "complete":
        this.setState("idle", { progress: 100 });
        this.emit("complete", { file: filename });
        break;
      case "paused":
        this.setState("paused", { canHome: true });
        break;
      case "stopped":
        this.setState("idle", { progress: 0, canHome: true });
        break;
      default:
        this.log(outcome.error, "error");
        this.setState("error", { error: outcome.error, canHome: true });
    }
  }

  pause() {
    if (this.state !== "plotting") throw new Error("Not plotting");
    this.driver.requestPause();
  }

  resume() {
    if (this.state !== "paused" || !this.currentFile)
      throw new Error("Nothing to resume");
    this.plot(this.currentFile, { layer: this.currentLayer, resume: true });
  }

  /** Stop a running plot, or cancel a paused one (discarding its resume point). */
  stop() {
    if (this.state === "plotting") {
      this.driver.requestStop();
      return;
    }
    if (this.currentFile) {
      try {
        stripPlotDataFile(this.filePath(this.currentFile));
      } catch {
        // file deleted meanwhile; nothing to clear
      }
    }
    this.setState("idle", {
      currentFile: null,
      currentLayer: null,
      progress: 0,
    });
  }

  async manual(cmd, opts = {}) {
    if (this.state === "plotting" || this.busy)
      throw new Error("The plotter is busy");
    this.busy = true;
    try {
      const outcome = await this.driver.utility(cmd, opts, this.hooks);
      if (outcome.connected !== undefined) this.connected = outcome.connected;
      this.emit("change");
      if (outcome.kind === "error") throw new Error(outcome.error);
    } finally {
      this.busy = false;
    }
  }

  /** Return the carriage to the origin (walk_home reads the EBB step counter). */
  home() {
    return this.manual("walk_home");
  }

  pen(direction) {
    if (direction !== "up" && direction !== "down") {
      throw new Error(`Invalid pen direction: ${direction}`);
    }
    return this.manual(direction === "up" ? "raise_pen" : "lower_pen");
  }

  async jog(dx, dy) {
    // dx/dy are mm. Reject non-finite or absurd values so "Infinity"/1e9
    // can't drive the carriage off its travel area.
    const MAX_JOG_MM = 1000;
    for (const d of [dx, dy]) {
      if (!Number.isFinite(d) || Math.abs(d) > MAX_JOG_MM) {
        throw new Error(`Jog distance out of range (±${MAX_JOG_MM} mm)`);
      }
    }
    if (dx) await this.manual("walk_mmx", { dist: dx });
    if (dy) await this.manual("walk_mmy", { dist: dy });
  }

  /** Time and distance estimate; runs on a copy without resume data. */
  async estimate(filename, layer = null) {
    if (this.state === "plotting" || this.busy)
      throw new Error("The plotter is busy");
    const text = stripPlotDataText(
      fs.readFileSync(this.filePath(filename), "utf8")
    );
    return this.driver.estimate(text, layer, this.hooks);
  }
}
