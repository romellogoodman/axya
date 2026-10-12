/**
 * CliDriver: drives the plotter by spawning Bantam's `nextdraw` CLI.
 *
 * Transitional backend, kept until the native driver (drivers/native.js) is
 * validated on hardware; see docs/DRIVER_PORT.md. Pause = SIGINT to the
 * process group (nextdraw saves resume state into the SVG via
 * --output_file), resume = --mode res_plot, stop = SIGKILL.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The nextdraw pip package installs no console script, only the Python module.
const [NEXTDRAW_EXE, ...NEXTDRAW_PREFIX] = (
  process.env.NEXTDRAW_CMD || "python3 -m nextdraw"
)
  .trim()
  .split(/\s+/);

// Patterns below match nextdraw 1.x output (nextdrawcore). The progress bar is
// tqdm with ascii=True, e.g. "Plot Progress:  45%|####5     | 123/273 [...]";
// "Copy 2 of 3" replaces the label when plotting copies. Anchoring on the
// label skips the "Page delay" / "Layer delay" bars.
const PROGRESS_RE = /(?:Plot Progress|Copy [\w ]+?):\s*(\d+)%\|/;
// "No available nextdraw units found on USB." (no device at startup),
// "Failed to connect to <model>." (port open failed), and
// "Error: USB connection lost during plot." (cable pulled mid-plot).
const NO_DEVICE_RE =
  /no available nextdraw units|failed to connect|usb connection lost/i;
// Printed for every resumable pause: SIGINT, the hardware pause button, and
// programmatic pauses. Not printed for USB/power loss.
const PAUSED_RE = /use the resume feature to continue/i;

// Utility commands use nextdraw's built-in blank document, but the CLI still
// requires a file argument.
const DUMMY_SVG_PATH = path.join(os.tmpdir(), "axya-dummy.svg");
fs.writeFileSync(
  DUMMY_SVG_PATH,
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
);

export class CliDriver {
  name = "cli";

  constructor({ configPath }) {
    this.configPath = configPath;
    this.proc = null;
    this.pauseRequested = false;
  }

  /** Spawn nextdraw; stream output lines to hooks.log and onLine. */
  spawnCli(args, hooks, { onLine, detached = false } = {}) {
    const fullArgs = [...NEXTDRAW_PREFIX, ...args];
    hooks.log(`$ ${NEXTDRAW_EXE} ${fullArgs.join(" ")}`, "cmd");
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
          if (onLine) onLine(line);
          hooks.log(line, isStderr ? "stderr" : "stdout");
        }
      });
    };
    handle(proc.stdout, false);
    handle(proc.stderr, true);
    return proc;
  }

  /** Run nextdraw to completion; resolve with its exit code and output. */
  runCli(args, hooks, opts = {}) {
    return new Promise((resolve) => {
      const lines = [];
      const proc = this.spawnCli(args, hooks, {
        ...opts,
        onLine: (l) => {
          lines.push(l);
          opts.onLine?.(l);
        },
      });
      if (opts.detached) this.proc = proc;
      proc.on("error", (err) => {
        const msg =
          err.code === "ENOENT"
            ? `'${NEXTDRAW_EXE}' not found. Install with: pip install https://software-download.bantamtools.com/nd/api/nextdraw_api.zip`
            : err.message;
        resolve({
          code: null,
          signal: null,
          output: lines.join("\n"),
          spawnError: msg,
        });
      });
      proc.on("close", (code, signal) => {
        if (opts.detached) this.proc = null;
        resolve({ code, signal, output: lines.join("\n") });
      });
    });
  }

  async plot(filePath, { layer = null, resume = false }, hooks) {
    const args = [
      filePath,
      "--config",
      this.configPath,
      "--output_file",
      filePath,
      "--progress",
      "--report_time",
    ];
    if (resume) args.push("--mode", "res_plot");
    else if (layer != null)
      args.push("--mode", "layers", "--layer", String(layer));

    this.pauseRequested = false;
    const r = await this.runCli(args, hooks, {
      detached: true,
      onLine: (line) => {
        const m = line.match(PROGRESS_RE);
        if (m) hooks.progress(Number(m[1]));
      },
    });
    const pauseRequested = this.pauseRequested;
    this.pauseRequested = false;
    if (r.spawnError) return { kind: "error", error: r.spawnError };
    if (r.signal === "SIGKILL") return { kind: "stopped" };
    if (pauseRequested || PAUSED_RE.test(r.output)) return { kind: "paused" };
    if (r.code === 0) return { kind: "complete", connected: true };
    if (NO_DEVICE_RE.test(r.output)) {
      return { kind: "error", error: "No plotter connected", connected: false };
    }
    return { kind: "error", error: `nextdraw exited with code ${r.code}` };
  }

  requestPause() {
    if (!this.proc) return;
    this.pauseRequested = true;
    killGroup(this.proc.pid, "SIGINT");
  }

  requestStop() {
    if (!this.proc) return;
    killGroup(this.proc.pid, "SIGKILL");
  }

  /** utility_cmd: raise_pen, lower_pen, walk_mmx, walk_mmy, walk_home. */
  async utility(cmd, { dist } = {}, hooks) {
    const args = [
      DUMMY_SVG_PATH,
      "--config",
      this.configPath,
      "--mode",
      "utility",
      "--utility_cmd",
      cmd,
    ];
    if (dist != null) args.push("--dist", String(dist));
    const r = await this.runCli(args, hooks);
    if (r.spawnError) return { kind: "error", error: r.spawnError };
    if (r.code === 0) return { kind: "complete", connected: true };
    if (NO_DEVICE_RE.test(r.output)) {
      return { kind: "error", error: "No plotter connected", connected: false };
    }
    return { kind: "error", error: `nextdraw exited with code ${r.code}` };
  }

  /** --preview --report_time on a copy of the file; returns display strings. */
  async estimate(svgText, layer, hooks) {
    const tmp = path.join(os.tmpdir(), `axya-estimate-${process.pid}.svg`);
    fs.writeFileSync(tmp, svgText);
    const args = [
      tmp,
      "--config",
      this.configPath,
      "--preview",
      "--report_time",
    ];
    if (layer != null) args.push("--mode", "layers", "--layer", String(layer));
    try {
      const r = await this.runCli(args, hooks);
      if (r.spawnError) throw new Error(r.spawnError);
      if (r.code !== 0) throw new Error(`exit ${r.code}`);
      const result = {};
      const time = r.output.match(/Estimated print time:\s*([^\n]+)/i);
      if (time) result.time = time[1].trim();
      const draw = r.output.match(
        /Length of path to draw:\s*([\d.]+)\s*(\w+)/i
      );
      if (draw) result.drawDistance = `${draw[1]} ${draw[2]}`;
      const travel = r.output.match(
        /Pen-up travel distance:\s*([\d.]+)\s*(\w+)/i
      );
      if (travel) result.travelDistance = `${travel[1]} ${travel[2]}`;
      const total = r.output.match(
        /Total movement distance:\s*([\d.]+)\s*(\w+)/i
      );
      if (total) result.totalDistance = `${total[1]} ${total[2]}`;
      return result;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/**
 * Signal the detached process group. process.kill throws ESRCH if the
 * process already exited (a race against close).
 */
function killGroup(pid, signal) {
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}
