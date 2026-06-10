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

const [NEXTDRAW_EXE, ...NEXTDRAW_PREFIX] = (process.env.NEXTDRAW_CMD || "nextdraw").split(" ");
const PROGRESS_RE = /(\d+)%\s*\|?[\s#█░-]*\|?\s*\d+\/\d+/;
const NO_DEVICE_RE = /no available nextdraw units|check your connection|unable to connect|no device|port not found|cannot connect|not respond/i;

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
    this.connected = null; // null=unknown, true=connected, false=no device

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
      startedAt: this.startedAt,
      error: this.error,
      canHome: this.canHome,
      logVersion: this.logVersion,
      connected: this.connected,
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
    const fullArgs = [...NEXTDRAW_PREFIX, ...args];
    this.log(`$ ${NEXTDRAW_EXE} ${fullArgs.join(" ")}`, "cmd");
    const proc = spawn(NEXTDRAW_EXE, fullArgs, {
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
          ? `'${NEXTDRAW_EXE}' not found. Install with: pip install https://software-download.bantamtools.com/nd/api/nextdraw_api.zip`
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

    const runLines = [];
    this.proc = this.spawnCli(args, {
      detached: true,
      onLine: (line) => {
        runLines.push(line);
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
        this.connected = true;
        this.progress = 100;
        this.setState("idle");
        this.emit("complete", { file: filename });
      } else {
        this.canHome = true;
        if (NO_DEVICE_RE.test(runLines.join("\n"))) {
          this.connected = false;
          this.setState("error", { error: "No plotter connected" });
        } else {
          this.setState("error", { error: `nextdraw exited with code ${code}` });
        }
      }
    });
  }

  pause() {
    if (this.state !== "plotting" || !this.proc) {
      throw new Error("Not plotting");
    }
    this.pauseRequested = true;
    this.killGroup(this.proc.pid, "SIGINT");
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
    this.killGroup(this.proc.pid, "SIGKILL");
  }

  /**
   * Signal the detached process group. Wraps process.kill, which throws ESRCH
   * if the process already exited (a race against close) and would otherwise
   * surface as a spurious 400, and guards against a NaN pid from a failed spawn.
   */
  killGroup(pid, signal) {
    if (pid == null) return;
    try {
      process.kill(-pid, signal);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  }

  home() {
    if (this.state === "plotting") throw new Error("Stop the plot first");
    if (!this.currentFile) throw new Error("No file to home from");
    const filePath = path.join(this.uploadsDir, path.basename(this.currentFile));
    return this.runOnce([filePath, "--config", this.configPath, "--mode", "utility", "--utility_cmd", "walk_home"]);
  }

  pen(direction) {
    if (this.state === "plotting") throw new Error("Plot in progress");
    const cmd = direction === "up" ? "raise_pen" : "lower_pen";
    return this.runOnce([
      DUMMY_SVG_PATH,
      "--config",
      this.configPath,
      "--mode",
      "utility",
      "--utility_cmd",
      cmd,
    ]);
  }

  async jog(dx, dy) {
    if (this.state === "plotting") throw new Error("Plot in progress");
    // dx/dy reach the CLI as --dist (mm). Reject non-finite or absurd values
    // so "Infinity"/1e9 can't drive the carriage off its travel area.
    const MAX_JOG_MM = 1000;
    for (const d of [dx, dy]) {
      if (!Number.isFinite(d) || Math.abs(d) > MAX_JOG_MM) {
        throw new Error(`Jog distance out of range (±${MAX_JOG_MM} mm)`);
      }
    }
    if (dx) {
      await this.runOnce([
        DUMMY_SVG_PATH,
        "--config",
        this.configPath,
        "--mode",
        "utility",
        "--utility_cmd",
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
        "utility",
        "--utility_cmd",
        "walk_mmy",
        "--dist",
        String(dy),
      ]);
    }
  }

  /** Run nextdraw once and resolve when it exits. */
  runOnce(args) {
    return new Promise((resolve, reject) => {
      const lines = [];
      const proc = this.spawnCli(args, { onLine: (l) => lines.push(l) });
      proc.on("close", (code) => {
        if (code === 0) {
          this.connected = true;
          this.emit("change");
          resolve();
        } else {
          const msg = NO_DEVICE_RE.test(lines.join("\n"))
            ? ((this.connected = false), "No plotter connected")
            : `nextdraw exited with code ${code}`;
          this.emit("change");
          reject(new Error(msg));
        }
      });
      proc.on("error", reject);
    });
  }

  /** Run --preview --report_time and parse the estimate. */
  async estimate(filename, layer = null) {
    if (this.state === "plotting") throw new Error("Plot in progress");
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
