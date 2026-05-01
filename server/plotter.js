/**
 * PlotterManager — state machine around the `nextdraw` CLI subprocess.
 *
 * States: idle | plotting | paused | error
 * Every plotter action is a subprocess. Pause = SIGINT (nextdraw saves
 * resume state into the SVG via --output_file), Resume = --mode res_plot.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const NEXTDRAW_CMD = process.env.NEXTDRAW_CMD || "nextdraw";
const PROGRESS_RE = /(\d+)%\s*\|?[\s#█░-]*\|?\s*\d+\/\d+/;

// Dummy 1×1 SVG for manual commands that require a file arg
const DUMMY_SVG_PATH = path.join(os.tmpdir(), "axya-dummy.svg");
fs.writeFileSync(
  DUMMY_SVG_PATH,
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
);

export class PlotterManager extends EventEmitter {
  constructor({ configPath, uploadsDir }) {
    super();
    this.configPath = configPath;
    this.uploadsDir = uploadsDir;

    this.state = "idle";
    this.currentFile = null;
    this.currentLayer = null;
    this.progress = 0;
    this.startedAt = null;
    this.error = null;
    this.canHome = false;

    this.proc = null;
    this.logs = [];
    this.logVersion = 0;
  }

  status() {
    return {
      state: this.state,
      currentFile: this.currentFile,
      currentLayer: this.currentLayer,
      progress: this.progress,
      elapsed: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
      error: this.error,
      canHome: this.canHome,
      logVersion: this.logVersion,
    };
  }

  log(line, level = "info") {
    const entry = { t: Date.now(), level, line };
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    this.logVersion++;
    this.emit("change");
  }

  setState(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this.emit("change");
  }

  /** Spawn nextdraw with the given args; stream output to the log buffer. */
  spawnCli(args, { onLine, detached = false } = {}) {
    this.log(`$ ${NEXTDRAW_CMD} ${args.join(" ")}`, "cmd");
    const proc = spawn(NEXTDRAW_CMD, args, {
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle = (stream, isStderr) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.search(/[\r\n]/)) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (onLine) onLine(line, isStderr);
          this.log(line, isStderr ? "stderr" : "stdout");
        }
      });
    };
    handle(proc.stdout, false);
    handle(proc.stderr, true);

    proc.on("error", (err) => {
      const msg =
        err.code === "ENOENT"
          ? `'${NEXTDRAW_CMD}' not found. Install with: pip install https://software-download.bantamtools.com/nd/api/nextdraw_api.zip`
          : err.message;
      this.log(msg, "error");
      this.setState("error", { error: msg });
    });

    return proc;
  }

  /** Start plotting a file from the uploads directory. */
  plot(filename, { layer = null, resume = false } = {}) {
    if (this.state === "plotting") {
      throw new Error("A plot is already running");
    }
    const filePath = path.join(this.uploadsDir, path.basename(filename));
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filename}`);
    }

    const args = [
      filePath,
      "--config",
      this.configPath,
      "--output_file",
      filePath,
      "--progress",
      "--report_time",
    ];
    if (resume) {
      args.push("--mode", "res_plot");
    } else if (layer != null) {
      args.push("--mode", "layers", "--layer", String(layer));
    }

    this.currentFile = filename;
    this.currentLayer = layer;
    this.progress = 0;
    this.startedAt = Date.now();
    this.error = null;
    this.canHome = false;

    this.proc = this.spawnCli(args, {
      detached: true,
      onLine: (line) => {
        const m = line.match(PROGRESS_RE);
        if (m) {
          this.progress = Number(m[1]);
          this.emit("change");
        }
      },
    });
    this.setState("plotting");

    this.proc.on("close", (code, signal) => {
      this.proc = null;
      if (signal === "SIGKILL") {
        // stop()
        this.canHome = true;
        this.setState("idle", { progress: 0 });
      } else if (signal === "SIGINT" || this.pauseRequested) {
        // pause()
        this.pauseRequested = false;
        this.canHome = true;
        this.setState("paused");
      } else if (code === 0) {
        this.progress = 100;
        this.setState("idle");
        this.emit("complete", { file: filename });
      } else {
        this.canHome = true;
        this.setState("error", {
          error: `nextdraw exited with code ${code}`,
        });
      }
    });
  }

  pause() {
    if (this.state !== "plotting" || !this.proc) {
      throw new Error("Not plotting");
    }
    this.pauseRequested = true;
    process.kill(-this.proc.pid, "SIGINT");
  }

  resume() {
    if (this.state !== "paused" || !this.currentFile) {
      throw new Error("Nothing to resume");
    }
    this.plot(this.currentFile, { resume: true });
  }

  stop() {
    if (!this.proc) {
      // Nothing running — just clear paused state
      this.setState("idle", { currentFile: null, canHome: false, progress: 0 });
      return;
    }
    process.kill(-this.proc.pid, "SIGKILL");
  }

  home() {
    if (this.state === "plotting") throw new Error("Stop the plot first");
    if (!this.currentFile) throw new Error("No file to home from");
    const filePath = path.join(this.uploadsDir, path.basename(this.currentFile));
    return this.runOnce([filePath, "--config", this.configPath, "--mode", "res_home"]);
  }

  pen(direction) {
    if (this.state === "plotting") throw new Error("Plot in progress");
    const cmd = direction === "up" ? "raise_pen" : "lower_pen";
    return this.runOnce([
      DUMMY_SVG_PATH,
      "--config",
      this.configPath,
      "--mode",
      "manual",
      "--manual_cmd",
      cmd,
    ]);
  }

  async jog(dx, dy) {
    if (this.state === "plotting") throw new Error("Plot in progress");
    if (dx) {
      await this.runOnce([
        DUMMY_SVG_PATH,
        "--config",
        this.configPath,
        "--mode",
        "manual",
        "--manual_cmd",
        "walk_mmx",
        "--dist",
        String(dx),
      ]);
    }
    if (dy) {
      await this.runOnce([
        DUMMY_SVG_PATH,
        "--config",
        this.configPath,
        "--mode",
        "manual",
        "--manual_cmd",
        "walk_mmy",
        "--dist",
        String(dy),
      ]);
    }
  }

  /** Run nextdraw once and resolve when it exits. */
  runOnce(args) {
    return new Promise((resolve, reject) => {
      const proc = this.spawnCli(args);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`nextdraw exited with code ${code}`));
      });
      proc.on("error", reject);
    });
  }

  /** Run --preview --report_time and parse the estimate. */
  async estimate(filename, layer = null) {
    const filePath = path.join(this.uploadsDir, path.basename(filename));
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filename}`);

    const args = [
      filePath,
      "--config",
      this.configPath,
      "--preview",
      "--report_time",
    ];
    if (layer != null) args.push("--mode", "layers", "--layer", String(layer));

    const output = [];
    await new Promise((resolve, reject) => {
      const proc = this.spawnCli(args, { onLine: (line) => output.push(line) });
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`))
      );
      proc.on("error", reject);
    });

    const text = output.join("\n");
    const result = {};
    const time = text.match(/Estimated print time:\s*([^\n]+)/i);
    if (time) result.time = time[1].trim();
    const draw = text.match(/Length of path to draw:\s*([\d.]+)\s*(\w+)/i);
    if (draw) result.drawDistance = `${draw[1]} ${draw[2]}`;
    const travel = text.match(/Pen-up travel distance:\s*([\d.]+)\s*(\w+)/i);
    if (travel) result.travelDistance = `${travel[1]} ${travel[2]}`;
    const total = text.match(/Total movement distance:\s*([\d.]+)\s*(\w+)/i);
    if (total) result.totalDistance = `${total[1]} ${total[2]}`;
    return result;
  }
}
