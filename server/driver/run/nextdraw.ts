/*
 * NextDraw: one run of the native driver. Owns the document, the machine
 * connection and all per-run state, and implements nextdraw's top-level
 * flow: mode dispatch, document preparation, the copy/layer/polyline plot
 * loops, pausing, cleanup and reporting.
 *
 * Ported from nextdrawcore/nextdraw.py (nextdraw 1.7.5: effect, plot_document,
 * plot_cleanup, plot_doc_digest, eval_layer_props, plot_polyline,
 * go_to_position, pause_check, and the Python API's plot_run bookkeeping
 * from nextdraw/nextdraw_py.py), and ResumeStatus.check_button from
 * nextdrawcore/plot_status.py, docs/reference-apps/nextdraw-1.7.5/.
 * Copyright 2025-2026 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 *
 * Not ported: plotting to multiple machines at once (nextdraw_control's
 * port_config 3), the CLI progress bar, and NextDraw Merge integration.
 */

import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from "@xmldom/xmldom";
import {
  createConfig,
  updateOptions,
  type Bounds,
  type Options,
  type Params,
} from "../config.ts";
import { EBBMotionWrap } from "../ebb/motion.ts";
import { listNamedEbbs } from "../ebb/ebb3.ts";
import { realClock, type Clock, type PortProvider } from "../ebb/transport.ts";
import {
  HidingNotPortedError,
  prepareDocument,
  randomizeOptimize,
  PLOB_VERSION,
  type DocDigest,
  type PathItem,
} from "../digest/index.ts";
import { HomingClass } from "../machine/homing.ts";
import { PenHandler } from "../machine/pen.ts";
import { readStatusByte } from "../machine/status.ts";
import {
  disconnect,
  preparePlot,
  serialConnect,
  setupCommand,
  utilityCommand,
} from "../machine/utility.ts";
import type { MachineContext, PlannerHooks } from "../machine/context.ts";
import { computeSegment, trajectory } from "../motion/index.ts";
import { enableMotors } from "../machine/status.ts";
import { checkLimitsTol } from "../motion/plotUtils.ts";
import { formatFixed } from "../pyfmt.ts";
import { PlotWarnings } from "../warnings.ts";
import { feed, pageLayerDelay } from "./dripfeed.ts";
import { Preview, stripData } from "./preview.ts";
import { formatHms, parseDist, PlotStatus } from "./status.ts";

export const VERSION = "1.7.5";

export interface NextDrawInit {
  /** SVG text to plot; omit for setup and utility modes. */
  svg?: string;
  /** Changes to nextdraw_conf.py defaults (config-file layer). */
  params?: Partial<Params>;
  /** Plot options, applied after defaults. */
  options?: Partial<Options>;
  ports: PortProvider;
  clock?: Clock;
  message?: (text: string) => void;
  /** Software pause request (UI pause button); checked before every move. */
  pauseRequested?: () => boolean;
  /** Called after each executed move, for progress reporting (not in nextdraw). */
  onMove?: (nd: NextDraw) => void;
}

type LayerProps = {
  pause: boolean;
  delay: number | null;
  height: number | null;
  speed: number | null;
};

export class NextDraw implements MachineContext {
  // ConfigState
  options: Options;
  params: Params;
  bounds: Bounds;

  machine: EBBMotionWrap;
  ports: PortProvider;
  clock: Clock;
  pen = new PenHandler();
  homing: HomingClass;
  warnings = new PlotWarnings();
  plot_status = new PlotStatus();
  preview = new Preview();
  planner: PlannerHooks;

  step_scale = 0;
  speed_pendown = 0;
  speed_penup = 0;
  use_layer_speed = false;
  layer_speed_pendown = -1;
  connected = false;
  called_externally = "";

  document: Document | null = null;
  svg: Element | null = null;
  private backup_original: Document | null = null;
  digest: DocDigest | null = null;
  svg_width = 0;
  svg_height = 0;
  rotate_page = false;
  doc_units = "in";
  vb_stash: [number, number, number, number] = [1, 1, 0, 0];
  start_time = 0;
  time_elapsed = 0;
  /** res_read/res_adj: resume position in mm (Python API res_dist). */
  res_dist = 0;
  /** list_names result (Python API name_list). */
  name_list: string[] | null = null;

  private pauseRequested: () => boolean;
  private onMove: (nd: NextDraw) => void;
  user_message_fun: (text: string) => void;

  constructor(init: NextDrawInit) {
    const config = createConfig(init.params);
    Object.assign(config.options, init.options ?? {});
    this.options = config.options;
    this.params = config.params;
    this.bounds = config.bounds;
    this.ports = init.ports;
    this.machine = new EBBMotionWrap(init.ports);
    this.clock = init.clock ?? realClock;
    this.user_message_fun = init.message ?? (() => {});
    this.pauseRequested = init.pauseRequested ?? (() => false);
    this.onMove = init.onMove ?? (() => {});
    this.planner = {
      go_to_position: (x, y, ignoreLimits = false) =>
        this.goToPosition(x, y, ignoreLimits),
    };
    this.homing = new HomingClass(this, (t) => this.user_message_fun(t));
    if (init.svg !== undefined) {
      this.document = new DOMParser().parseFromString(
        init.svg,
        "image/svg+xml"
      );
    }
  }

  receive_pause_request(): boolean {
    return this.pauseRequested();
  }

  /** Serialized output document (with <plotdata>), as nextdraw's get_output. */
  getOutput(): string {
    if (!this.document) return "";
    return new XMLSerializer().serializeToString(this.document);
  }

  /** nextdraw_py plot_run: reset per-run state, run, and collect results. */
  async run(): Promise<RunResult> {
    this.use_layer_speed = false;
    this.plot_status.reset(this.clock.time());
    this.pen.reset();
    this.warnings.reset();
    this.time_elapsed = 0;
    this.digest = null;
    await this.effect();
    const plotting = ["plot", "layers", "res_plot"].includes(this.options.mode);
    const stats = this.plot_status.stats;
    const distancePendown = 0.0254 * stats.down_travel_tot;
    for (const text of this.warnings.returnTextList())
      this.user_message_fun(text);
    return {
      status_code: this.plot_status.stopped,
      time_estimate: !plotting
        ? 0
        : this.options.preview
          ? stats.pt_estimate / 1000.0
          : this.time_elapsed,
      distance_pendown: plotting ? distancePendown : 0,
      distance_total: plotting
        ? distancePendown + 0.0254 * stats.up_travel_tot
        : 0,
      pen_lifts: plotting ? this.pen.status.lifts : 0,
      output_svg: this.getOutput(),
    };
  }

  private plotting(): boolean {
    return ["plot", "layers", "res_plot"].includes(this.options.mode);
  }

  /** NextDraw.effect */
  async effect(): Promise<void> {
    const o = this.options;
    const ps = this.plot_status;
    this.start_time = this.clock.time();
    ps.stats.reset();
    this.doc_units = "in";
    this.pen.phys.xpos = 0;
    this.pen.phys.ypos = 0;
    this.layer_speed_pendown = -1;
    ps.copies_to_plot = 1;
    ps.resume.reset(this.clock.time());
    this.svg_width = 0;
    this.svg_height = 0;
    this.rotate_page = false;
    updateOptions(this);
    o.mode = o.mode.replace(/^"+|"+$/g, "");
    o.setup_type = o.setup_type.replace(/^"+|"+$/g, "");
    o.utility_cmd = o.utility_cmd.replace(/^"+|"+$/g, "");
    o.page_delay = Math.max(o.page_delay, 0);

    if (o.mode === "options" || o.mode === "timing") return;
    if (o.mode === "version") {
      this.user_message_fun(VERSION);
      return;
    }
    if (o.mode === "utility") {
      if (o.utility_cmd === "none") return;
      if (o.utility_cmd === "strip_data") {
        if (this.svg_root()) stripData(this.svg_root() as Element);
        this.user_message_fun(
          "Previews and NextDraw software data have been removed from the SVG file."
        );
        return;
      }
      if (["res_read", "res_adj_in", "res_adj_mm"].includes(o.utility_cmd)) {
        this.svg = this.svg_root();
        if (!this.svg) return;
        this.user_message_fun(
          ps.resume.manageOffset(this.svg, o.utility_cmd, o.dist)
        );
        this.res_dist = Math.max(ps.resume.new.pause_dist * 25.4, 0);
        return;
      }
      if (o.utility_cmd === "list_names") {
        this.name_list = await listNamedEbbs(this.ports);
        if (!this.name_list || this.name_list.length === 0) {
          this.user_message_fun("No named plotters located.\n");
        } else {
          this.user_message_fun("List of attached plotters:");
          for (const name of this.name_list) this.user_message_fun(name);
        }
        return;
      }
    }
    if (o.mode === "res_plot") o.copies = 1;
    if (o.mode === "setup") o.mode = o.setup_type;
    if (o.mode === "utility" && o.utility_cmd === "toggle") o.mode = "toggle";
    if (o.digest === 2) o.preview = true; // digest only: no serial I/O

    if (!o.preview) await serialConnect(this, "nextdraw");
    if (o.mode === "sysinfo") {
      this.user_message_fun(`NextDraw software (axya port) ${VERSION}`);
      if (this.machine.version)
        this.user_message_fun(`Firmware ${this.machine.version}`);
    }
    if (this.machine.err !== null && !o.preview) {
      this.user_message_fun(`Error:\n\n${this.machine.err}`);
      return;
    }
    if (["align", "toggle", "cycle", "find_home"].includes(o.mode)) {
      await setupCommand(this);
      this.warnings.report(
        Boolean(this.called_externally),
        this.user_message_fun
      );
      return;
    }
    if (o.mode === "utility") {
      await utilityCommand(this);
      this.warnings.report(
        Boolean(this.called_externally),
        this.user_message_fun
      );
      return;
    }

    this.svg = this.svg_root();
    ps.resume.update_needed = false;
    ps.resume.new.model = o.model;
    if (this.plotting() && this.svg) ps.resume.readFromSvg(this.svg);
    if (!this.svg && this.plotting()) {
      this.user_message_fun("No SVG input provided.");
      return;
    }

    if (o.mode === "res_plot") {
      if (ps.resume.old.pause_dist >= 0) {
        ps.resume.resPlotOptionsUpdate(o);
        updateOptions(this);
      } else {
        this.user_message_fun(
          "No in-progress plot data found in file; unable to resume."
        );
        this.plotCleanup();
        return;
      }
    } else if (this.svg) {
      const warning = ps.resume.pauseWarning(
        this.params.pause_warning,
        this.called_externally.startsWith("nextdraw merge,") ||
          o.submode !== "none"
      );
      if (warning !== null) {
        if (!ps.secondary) this.user_message_fun(warning);
        this.plotCleanup();
        ps.resume.removePauseWarning(this.svg_root() as Element, ps.secondary);
        return;
      }
    }

    // nextdraw quirk: the CLI never forwards --offset_start, so only a config
    // file sets it; kept as an option here.
    if (
      (o as Options & { offset_start: boolean }).offset_start &&
      this.plotting()
    ) {
      let distInches: number;
      try {
        distInches = parseDist(o.dist, "in");
      } catch (err) {
        this.user_message_fun(`Error: ${(err as Error).message}`);
        return;
      }
      if (o.mode === "plot" || o.mode === "layers") {
        if (distInches < 0) {
          this.user_message_fun(
            "Error: dist must be >= 0 for plot and layers modes with --offset_start."
          );
          return;
        }
        ps.resume.old.pause_dist = distInches;
        ps.resume.old.pause_ref = -1;
        o.layer_option = o.mode === "layers" ? 2 : 1;
        o.mode = "res_plot";
        ps.resume.resPlotOptionsUpdate(o);
        updateOptions(this);
      } else {
        const current = Math.max(ps.resume.old.pause_dist, 0);
        ps.resume.old.pause_dist = Math.max(current + distInches, 0);
      }
    }

    if (this.plotting()) {
      ps.copies_to_plot = o.copies;
      if (ps.copies_to_plot === 0) ps.copies_to_plot = -1; // continuous
      if (o.preview && !o.random_start) ps.copies_to_plot = 1;
      if (o.mode === "plot" && o.layer_option === 2) o.mode = "layers";
      if (o.mode === "layers") ps.resume.new.layer = o.layer;
      if (o.mode === "plot") ps.resume.new.layer = -1;
      if (!this.prepareDocument()) return;
      if (o.digest === 2) {
        this.plotCleanup();
        ps.resume.new.plob_version = String(PLOB_VERSION);
        ps.resume.writeToSvg(this.svg as Element);
        this.warnings.report(false, this.user_message_fun);
        return;
      }
      if (o.mode === "res_plot")
        (this.digest as DocDigest).crop(ps.resume.old.pause_dist);
      if (o.mode === "res_plot")
        ps.stats.down_travel_inch = ps.resume.old.pause_dist;
      let firstCopy = true;
      while (ps.copies_to_plot !== 0) {
        this.preview.reset();
        ps.resume.update_needed = true;
        ps.copies_to_plot -= 1;
        if (firstCopy) {
          firstCopy = false;
        } else {
          ps.stats.nextPage();
          if (o.random_start) this.randomizeOptimize();
        }
        await this.plotDocument();
        await pageLayerDelay(this, true);
      }
      await this.plotCleanupAsync();
    }

    if (ps.resume.update_needed && this.svg) {
      if (o.digest) ps.resume.new.plob_version = String(PLOB_VERSION);
      ps.resume.writeToSvg(this.svg);
    }
    if (this.machine.port !== null) {
      await this.pen.servoRevert(this);
      if (this.machine.caller === "nextdraw") await disconnect(this);
    }
    this.warnings.report(
      Boolean(this.called_externally),
      this.user_message_fun
    );
  }

  private svg_root(): Element | null {
    return (this.document?.documentElement as Element | null) ?? null;
  }

  private seedForRandomize(): number {
    if (this.options.random_start && this.options.mode !== "res_plot") {
      this.plot_status.resume.new.rand_seed = Math.trunc(
        this.clock.time() * 100
      );
    }
    return this.plot_status.resume.new.rand_seed;
  }

  /** NextDraw.prepare_document */
  private prepareDocument(): boolean {
    const svg = this.svg as Element;
    if (!this.backup_original) this.backup_original = this.cloneDocument();
    const resume = this.plot_status.resume;
    let prepared;
    try {
      prepared = prepareDocument(svg, {
        options: this.options,
        params: this.params,
        bounds: this.bounds,
        layer: resume.new.layer,
        plob_version: resume.old.plob_version,
        rand_seed: this.options.random_start
          ? this.seedForRandomize()
          : resume.new.rand_seed,
        warnings: this.warnings,
      });
    } catch (err) {
      if (err instanceof HidingNotPortedError) {
        this.user_message_fun(
          "Hidden-line removal is not supported yet by axya's native driver."
        );
        return false;
      }
      throw err;
    }
    if (prepared === null) {
      for (const line of [
        "This document does not have valid dimensions.",
        "The page size should be in either millimeters (mm) or inches (in).\r\r",
        "Consider starting with the Letter landscape or ",
        "the A4 landscape template.\r\r",
        "The page size may also be set in Inkscape,\r",
        "using File > Document Properties.",
      ]) {
        this.user_message_fun(line);
      }
      return false;
    }
    this.digest = prepared.digest;
    this.svg_width = prepared.svg_width;
    this.svg_height = prepared.svg_height;
    this.rotate_page = prepared.rotate_page;
    if (prepared.doc_units) this.doc_units = prepared.doc_units;
    this.vb_stash = prepared.vb_stash;
    if (prepared.valid_plob) {
      this.backup_original = this.cloneDocument();
      resume.new.plob_version = String(PLOB_VERSION);
    } else if (this.options.digest) {
      this.backup_original = prepared.digest.toPlob(); // save a plob, not the full SVG
    }
    return true;
  }

  /** NextDraw.randomize_optimize for later copies. */
  private randomizeOptimize(): void {
    if (this.plot_status.resume.new.plob_version !== "n/a") return;
    randomizeOptimize(this.digest as DocDigest, {
      options: this.options,
      rand_seed: this.seedForRandomize(),
    });
  }

  private cloneDocument(): Document {
    return (this.document as Document).cloneNode(true) as Document;
  }

  /** NextDraw.plot_document */
  async plotDocument(): Promise<void> {
    if (!this.options.preview) {
      this.options.rendering = false;
      if (this.machine.port === null) return;
    }
    if (!(await preparePlot(this))) return;
    await this.plotDocDigest(this.digest);
    await this.pen.penRaise(this);
    if (this.plot_status.stopped === 0) {
      this.plot_status.resume.new.clean();
      await this.goToPosition(
        Math.min(this.pen.phys.xpos, 0.1),
        Math.min(this.pen.phys.ypos, 0.1)
      );
      await this.homing.precisionMoveTo(0, 0);
    }
  }

  /** NextDraw.plot_cleanup, synchronous part: revert the document. */
  private plotCleanup(): boolean {
    if (!this.backup_original) return false;
    this.document = this.backup_original.cloneNode(true) as Document;
    this.svg = this.svg_root();
    return true;
  }

  /** NextDraw.plot_cleanup: revert, render preview, report, webhook. */
  private async plotCleanupAsync(): Promise<void> {
    if (!this.plotCleanup()) return;
    const elapsed = this.clock.time() - this.start_time;
    if (this.options.digest === 2) {
      this.time_elapsed = elapsed;
      if (this.options.report_time && !this.called_externally) {
        this.user_message_fun("Elapsed time: " + formatHms(elapsed));
      }
      return;
    }
    this.preview.render(this, this.svg as Element);
    this.time_elapsed = elapsed;
    if (!this.called_externally) {
      this.plot_status.stats.report(
        this.options,
        this.user_message_fun,
        elapsed,
        endedAt
      );
      this.pen.status.report(this, this.user_message_fun);
      if (
        this.options.report_time &&
        this.plot_status.resume.new.plob_version !== "n/a"
      ) {
        this.user_message_fun("Document printed from valid Plob digest.");
      }
    }
    if (
      this.options.webhook &&
      !this.options.preview &&
      this.options.webhook_url !== null
    ) {
      await this.sendWebhook(elapsed);
    }
  }

  private async sendWebhook(elapsed: number): Promise<void> {
    let url = (this.options.webhook_url as string).trim();
    if (!url.startsWith("http")) url = "https://" + url;
    const name = this.digest?.name;
    const note =
      typeof name === "string" && name !== "" ? `File ${name}, ` : "";
    const payload =
      "Plot complete. " +
      note +
      `Time ${formatHms(elapsed)}, Machine: ${this.machine.name}`;
    try {
      await fetch(url, {
        method: "POST",
        body: payload,
        signal: AbortSignal.timeout(7000),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        this.user_message_fun("Webhook notification failed (Timed out).\n");
      } else {
        this.user_message_fun(
          "An error occurred while posting webhook. Check your internet connection and webhook URL.\n"
        );
      }
    }
  }

  /** NextDraw.plot_doc_digest */
  private async plotDocDigest(digest: DocDigest | null): Promise<void> {
    if (!digest) return;
    for (const layer of digest.layers) {
      await this.pen.endTempHeight(this);
      const oldUseLayerSpeed = this.use_layer_speed;
      const oldLayerSpeed = this.layer_speed_pendown;
      await this.pen.penRaise(this);
      await this.evalLayerProps(layer.props as unknown as LayerProps);
      for (const path of layer.paths) {
        if (this.plot_status.stopped) return;
        await this.plotPolyline(path);
      }
      this.use_layer_speed = oldUseLayerSpeed;
      if (this.layer_speed_pendown !== oldLayerSpeed) {
        this.layer_speed_pendown = oldLayerSpeed;
        await enableMotors(this);
      }
      await this.pen.endTempHeight(this);
    }
  }

  /** NextDraw.eval_layer_props: layer-name pause, delay, height and speed codes. */
  private async evalLayerProps(props: LayerProps): Promise<void> {
    if (props.pause) {
      if (this.plot_status.stopped === 0) this.plot_status.stopped = -1;
      await this.pauseCheck();
    }
    const oldSpeed = this.layer_speed_pendown;
    this.use_layer_speed = false;
    this.layer_speed_pendown = -1;
    if (props.delay) await pageLayerDelay(this, false, props.delay);
    if (props.height !== null && props.height !== undefined) {
      await this.pen.setTempHeight(this, props.height);
    }
    if (props.speed) {
      this.use_layer_speed = true;
      this.layer_speed_pendown = props.speed;
    }
    if (this.layer_speed_pendown !== oldSpeed) await enableMotors(this);
  }

  /** NextDraw.plot_polyline: one pen-down polyline, clamped to travel. */
  private async plotPolyline(pathItem: PathItem): Promise<void> {
    const vertices = pathItem.subpaths[0];
    if (this.plot_status.stopped) return;
    if (!vertices || vertices.length < 2) return;
    await this.pen.penRaise(this);
    const downTravelLast = this.plot_status.stats.down_travel_inch;
    const polylineLength = pathItem.length();
    for (const v of vertices) {
      v[0] = checkLimitsTol(v[0], 0, this.bounds[1][0], 2e-9)[0];
      v[1] = checkLimitsTol(v[1], 0, this.bounds[1][1], 2e-9)[0];
    }
    await this.goToPosition(vertices[0][0], vertices[0][1]);
    await feed(this, trajectory(this, vertices));
    if (this.plot_status.stopped === 0) {
      this.plot_status.stats.down_travel_inch = downTravelLast + polylineLength;
    }
  }

  /** NextDraw.go_to_position: planned pen-up straight move. */
  async goToPosition(
    xDest: number,
    yDest: number,
    ignoreLimits = false
  ): Promise<void> {
    const [moves] = computeSegment(this, [xDest, yDest, 0, 0, ignoreLimits]);
    await feed(this, moves);
  }

  /** PlotStats.add_dist, with this run's pen state and pause cache. */
  addDist(distanceInch: number, tD = false): void {
    this.plot_status.stats.addDist(
      Boolean(this.pen.phys.z_up),
      this.plot_status.resume.drip,
      distanceInch,
      tD
    );
    this.onMove(this);
  }

  /** ResumeStatus.check_button: 1 pressed, -1 USB error, 0 otherwise. */
  private async checkButton(): Promise<number> {
    if (this.options.preview) return 0;
    const resume = this.plot_status.resume;
    const now = this.clock.time();
    if (now - resume.button_timestamp > this.params.button_interval) {
      resume.button_timestamp = now;
      await readStatusByte(this);
    }
    if (this.plot_status.button) return 1;
    if (this.plot_status.connection) return -1;
    return 0;
  }

  /** NextDraw.pause_check: act on pause requests, the button, and power or USB loss. */
  async pauseCheck(): Promise<void> {
    const ps = this.plot_status;
    if (ps.stopped > 0) return;
    const button = await this.checkButton();
    if (this.receive_pause_request()) {
      ps.stopped = ps.delay_between_copies ? -2 : -103;
    }
    if (ps.power) {
      ps.stopped = -105;
      this.user_message_fun("Plot stopped because loss of power detected.\n");
      await this.machine.varWrite(0, 12);
      await this.machine.varWrite(0, 13);
    }
    if (ps.stopped === -1)
      this.user_message_fun("Plot paused programmatically.\n");
    if (ps.stopped === -103)
      this.user_message_fun("\nPlot paused by user input.\n");
    if ((ps.stopped < 0 || button !== 0) && ps.stopped !== -1) {
      const response = await this.machine.query("QU,6");
      ps.resume.drip.queuedDist(
        response === null ? null : Number.parseInt(response, 10),
        ps.stats,
        this.options.mode === "res_plot",
        ps.resume.old.pause_dist
      );
    }
    const mm = () => formatFixed(25.4 * ps.stats.down_travel_inch, 3);
    if (button === -1) {
      this.user_message_fun(
        `\nError: USB connection lost during plot. [Position: ${mm()} mm]\n`
      );
      this.connected = false;
      ps.stopped = -104;
    }
    if (button === 1) {
      if (ps.delay_between_copies) {
        ps.stopped = -2;
      } else {
        this.user_message_fun("Plot paused by button press.\n");
        ps.stopped = -102;
      }
    }
    if (ps.stopped === -2)
      this.user_message_fun("Plot sequence ended between copies.\n");
    if ([-1, -102, -103].includes(ps.stopped)) {
      this.user_message_fun(`(Paused after: ${mm()} mm of pen-down travel.)`);
    }
    if (ps.stopped < 0) {
      await this.pen.penRaise(this);
      if (
        !ps.delay_between_copies &&
        !ps.secondary &&
        this.options.mode !== "interactive"
      ) {
        if (ps.stopped !== -104 && ps.stopped !== -105) {
          this.user_message_fun("Use the resume feature to continue.\n");
        }
      }
      ps.stopped = -ps.stopped;
      ps.copies_to_plot = 0;
      if (!this.plotting()) return;
      ps.resume.updateFromOptions(ps.stats.down_travel_inch, this.options);
    }
  }
}

export interface RunResult {
  /** nextdraw status code: 0 ok, 1 programmatic pause, 2 stopped between copies,
   *  101 no connection, 102 button pause, 103 software pause, 104 USB lost,
   *  105 power lost, 106 homing failed. */
  status_code: number;
  time_estimate: number; // s
  distance_pendown: number; // m
  distance_total: number; // m
  pen_lifts: number;
  output_svg: string;
}

function endedAt(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
