# NextDraw 1.7.5 driver internals: a porting reference

This document explains how Bantam Tools' NextDraw driver (version 1.7.5, dated 2026-10-07) turns an SVG file into a stream of EiBotBoard (EBB) commands. axya is going to port this driver from Python to Node/TypeScript, so the document covers every stage in enough detail to reimplement it and then check the port against the original.

Two other documents cover related ground, and this one does not repeat them:

- The raw EBB command reference (what each command does in firmware).
- `docs/prior-art/nextdraw-inkscape-cli-api.md`, which covers the user-facing options, CLI flags, modes and Inkscape UI.

**Citation convention.** As in the CLI/API document, `file:line` citations are relative to `docs/reference-apps/nextdraw-1.7.5/`. `ink_extensions/...` refers to the `ink_extensions` 2.x pip package, which is a dependency and is not vendored. It is installed locally at `~/Library/Python/3.9/lib/python/site-packages/ink_extensions/`, and line numbers for it refer to that copy.

**Licensing.** The files have different licences:

| Files | Licence |
|---|---|
| `nextdrawcore/*` | GPL-2.0-or-later (headers such as `nextdrawcore/nextdraw.py:1-15`) |
| `nextdrawcore/homing.py` and `plotink/*` | MIT (`nextdrawcore/homing.py:17-26`, `plotink/ebb_calc.py:16-36`) |
| `nextdraw-api/nextdraw/nextdraw_cli.py` | MIT (`nextdraw-api/nextdraw/nextdraw_cli.py:41-59`) |
| `ink_extensions` (`simplepath.py` and the rest) | GPL-2+ (`ink_extensions/simplepath.py` header) |

All of these licences are compatible with an AGPL-3.0 port, as long as the copyright notices are kept.

---

## 1. Module map

### 1.1 Modules

| Module | LOC (non-blank, non-comment) | Owns | Depends on | Needed for a TS port? |
|---|---|---|---|---|
| `nextdrawcore/nextdraw.py` | 804 | `NextDraw` class: `effect()` mode dispatch, `prepare_document`, `plot_document`, `plot_doc_digest`, `plot_polyline`, `go_to_position`, `pause_check`, utility and setup commands, output. | Nearly every other module, plus `lxml`, `ink_extensions`, `requests` | **Yes.** This is the orchestrator. |
| `nextdrawcore/nextdraw_control.py` | 172 | `NextDrawWrapperClass`: maps SIGINT and SIGTERM to a pause `Event`, handles multi-machine `port_config`, and copies options into a per-machine `NextDraw`. | `nextdraw`, `ebb3_serial`, `threading` | Partly. Keep the signal-to-pause mapping and status code; drop multi-machine. |
| `nextdrawcore/motion.py` | 584 | Trajectory planning: `trajectory`, `plan_trajectory`, `compute_segment`, `compute_subsegment_cmds`. | `plan_utils`, `ebb_calc`, `plot_utils` | **Yes.** Highest risk. |
| `nextdrawcore/plan_utils.py` | 445 | S-curve maths (`scurve_plan`, `scurve_jerk(2)`, `scurve_time`, `striangle`), `calc_jerk`, `td_seg_data`, `t3_seg_data`. Dead code: `calc_layer_speeds`, `scurve_speeds`, `Z_MAP`. | `cubic_eqn`, `ebb_calc` | **Yes.** |
| `nextdrawcore/cubic_eqn.py` | 58 | Closed-form cubic root solver (numpy removed). | `math` | **Yes.** |
| `nextdrawcore/dripfeed.py` | 210 | `feed()` loop: pause check per move, pen up/down dispatch, SM/T3/TD send-or-simulate, host sleeps, distance stats; `page_layer_delay`. | — | **Yes.** |
| `nextdrawcore/plot_status.py` | 563 | `PlotStatus` (stopped code, monitor flags), `ResumeStatus` and `SVGPlotData` (`<plotdata>` read/write), `PlotStats` (distances, time estimate), `ProgressBar` (tqdm), `DripCache` (`queued_dist`), `parse_dist`. | `lxml`, `serial_utils`, `tqdm` (lazy) | **Yes**, except the tqdm UI. |
| `nextdrawcore/pen_handling.py` | 362 | `PenPosition` (x, y, z_up, accumulators), `PenHeight`, `PenLiftTiming`, `PenStatus`, `PenHandler` (`pen_raise`, `pen_lower`, `servo_init`, `servo_revert`, `cycle`). | `serial_utils` | **Yes.** |
| `nextdrawcore/homing.py` | 530 | Auto-homing with the limit switch, `read_position` (QS plus offsets), `set_home`, origin offsets, `precision_move_to` (HM). | `serial_utils`, `plot_utils` | **Yes.** |
| `nextdrawcore/serial_utils.py` | 179 | Connect settings (`CU,3/4/50`), `read_status_byte` (QG), `exhaust_queue`, `enable_motors` (also sets speeds and `step_scale`), step-offset RAM I/O, `abs_move_wrapper`. | `plot_utils` | **Yes.** |
| `nextdrawcore/digest_svg.py` | 697 | `DigestSVG.traverse`: SVG to `DocDigest`; shape-to-path conversion; style inheritance; `verify_plob`. | `lxml`, `ink_extensions` (simplepath, cubicsuperpath, simpletransform, simplestyle), `path_objects`, `models` | **Yes.** |
| `nextdrawcore/path_objects.py` | 652 | `DocDigest`, `LayerItem`, `LayerProperties` (layer-name syntax), `PathItem` (length, crop, reverse); plob I/O (`to_plob`, `from_plob`); `crop()` for resume. | `lxml`, `plot_utils` | **Yes.** |
| `nextdrawcore/boundsclip.py` | 145 | Clips flattened polylines at the travel/page rectangle and sets the `bounds` warning flag. | `plot_utils` | **Yes.** |
| `nextdrawcore/plot_optimizations.py` | 244 | `connect_nearby_ends` (path joining), `randomize_start`, `supersample` wrapper, `reorder` (greedy nearest-neighbour). | `rtree`, `spatial_grid`, `random` | **Yes.** |
| `nextdrawcore/clipping.py` | 740 | Hidden-line removal (`--hiding`) using fills, with a spatial-grid accelerator. | **`pyclipper`** | Optional. |
| `nextdrawcore/preview.py` | 338 | Logs simulated moves into `% Preview` layer path data; velocity charts (disabled); `strip_data`. | `lxml`, `simpletransform`, `ebb_calc` | Optional (only the `strip_data` part is needed). |
| `nextdrawcore/snap_colors.py` | 354 | Separate Inkscape extension: snaps colours to a palette and moves elements onto layers. Not used in the plot path. | `inkex` | No. |
| `nextdrawcore/plot_warnings.py` | 107 | De-duplicated warning dictionary and its message text. | — | Yes (small). |
| `nextdrawcore/nextdraw_conf.py` | 114 | Default parameters and the `overrides` dict. | — | Yes, as a TS defaults object. |
| `nextdrawcore/nextdraw_options/models.py` | 292 | Tables for `ZMotor` (2), `Handler` (5) and `Plotter` (11); `apply_model_and_handling`; `find_curve_tolerance`. | — | **Yes.** |
| `nextdrawcore/nextdraw_options/common_options.py` | 186 | argparse option definitions and defaults. | `argparse`, `inkex` | Replace with a TS options schema. |
| `nextdrawcore/nextdraw_options/conf_handling.py` | 15 | `get_conf()`: deep-copies the config module into a `SimpleNamespace`. | — | Trivial. |
| `nextdrawcore/nextdraw_options/versions.py` | 197 | sysinfo; online version check via `requests`. | `requests` | No. |
| `plotink/ebb3_serial.py` | 486 | `EBB3`: port discovery (name or VID:PID `04D8:FD92`), handshake, `command`/`query` with response validation, `QG`, `SL`/`QL` and int32 RAM helpers. | `pyserial`, `packaging` | **Yes** (over `serialport`). |
| `plotink/ebb3_motion.py` | 305 | `EBBMotionWrap(EBB3)`: wrappers for SM, HM, EM, QE, QS, CS, T3-clear, SP, PO/PD/PI, SC, SR, QC. | `ebb3_serial` | **Yes.** |
| `plotink/ebb_calc.py` | 280 | Firmware-exact step and accumulator maths: `move_dist_t3`, `rate_t3`. Also `move_dist_lt`, `calculate_lm`, `max_rate_t3`, which nextdraw does not use. | `decimal` | **Yes.** Bit-exact. |
| `plotink/plot_utils.py` | 796 | Units and lengths, `vb_scale_2`, `subdivideCubicPath`, `supersample`, `points_in_tolerance`, `clip_segment`, `checkLimitsTol`, `points_near`/`points_equal`. | `ink_extensions` (bezmisc, ffgeom, cspsubdiv) | **Yes** (the parts listed). |
| `plotink/rtree.py` | 95 | One-shot quadtree-like bbox index used by path joining. | — | **Yes.** |
| `plotink/spatial_grid.py` | 193 | Grid nearest-neighbour index used by reordering. | — | **Yes.** |
| `plotink/text_utils.py` | 66 | `format_hms`. | — | Trivial. |
| `plotink/ebb_serial.py`, `plotink/ebb_motion.py` | 368, 335 | Legacy (pre-EBB-3) API. nextdrawcore never imports them. | — | No. |
| `nextdraw-api/nextdraw/nextdraw_cli.py` | 261 | argparse CLI and config merge; calls `NextDrawWrapperClass.effect`; output file; exit code. | `utils`, `nextdraw_control` | Replace with the axya server API. |
| `nextdraw-api/nextdraw/nextdraw_py.py` | 443 | Python API: plot context (`plot_setup`/`plot_run`) and interactive context (`moveto`, `lineto`, `draw_path`, and so on). | `nextdraw` | Interactive parts are optional (useful for jog). |
| `nextdraw-api/nextdraw/utils.py` | 113 | `load_configs` (runpy), `assign_option_values` (precedence), `output_result`. | `runpy` | Replace. |

### 1.2 Third-party dependencies and JS equivalents

| Python dependency | Used for | Suggested JS equivalent | Notes |
|---|---|---|---|
| `lxml.etree` | SVG parse, tree walk, `<plotdata>` read/write, output serialization (`nextdrawcore/nextdraw.py:38`, `nextdrawcore/plot_status.py:32`) | `@xmldom/xmldom` + `xpath`, or `linkedom` | Needs namespace-aware attributes (`inkscape:label`, `sodipodi:docname`, the `nd:` namespace) and byte-stable serialization. |
| `ink_extensions.simplepath` | Path-data parsing that resolves relative and shorthand commands to absolute M/L/C/Q/A/Z (`ink_extensions/simplepath.py:215`) | **Port it directly.** | Exact output order matters for oracle parity. |
| `ink_extensions.cubicsuperpath` | Converts to cubic "superpaths": Q to C (`cubicsuperpath.py:123-138`), arcs via `ArcToPath` (`:44-98`) | **Port it directly.** | `ArcToPath` clamps out-of-range radii (`d=sqrt(max(0,1-d/4))`, `:58`) instead of scaling them up as SVG 1.1 F.6.6 requires. Libraries such as `svgpath` differ on such arcs. |
| `ink_extensions.simpletransform` | `parseTransform` (recursive regex; `:26-79`), `composeTransform`, `formatTransform` | Port (about 80 lines). | |
| `ink_extensions.simplestyle` | `parseStyle`, `formatStyle` | Small port. | |
| `ink_extensions.bezmisc` | `beziersplitatt` (de Casteljau at t=0.5) for flattening | Small port. | |
| `ink_extensions.inkex` | `Effect` base class (option parsing, document I/O), namespace map `NSS` | Not needed. | |
| `pyserial` (`serial`, `serial.tools.list_ports.comports`) | Port I/O (`plotink/ebb3_serial.py:42-43`) | `serialport` (`SerialPort.list()`, `@serialport/parser-readline`) | Responses are newline-terminated. |
| `packaging.version.parse` | Firmware version comparison (`plotink/ebb3_serial.py:39`) | `semver` with coercion, or a hand-written comparison | |
| `decimal` (precision 20) | Firmware-exact accumulator maths (`plotink/ebb_calc.py:42-44`) | `BigInt` with scaled rational arithmetic | See §6.4. |
| `random` (Mersenne Twister) | `randomize_start` seed and `randrange` (`nextdrawcore/plot_optimizations.py:243-252`) | A port of CPython's `random.seed(int)` (init_by_array) and `_randbelow_with_getrandbits` | Only needed for parity when `random_start` is on. |
| `pyclipper` | Hidden-line clipping (`nextdrawcore/clipping.py:8`) | `clipper2-js` or `js-angusj-clipper` (WASM) | Imported lazily (`nextdrawcore/nextdraw.py:637-639`); not in `install_requires` (`nextdraw-api/setup.py:14-20`). |
| `tqdm` | CLI progress bar (`nextdrawcore/plot_status.py:556`) | axya's own SSE progress | |
| `requests`, `urllib3` | Webhook (`nextdrawcore/nextdraw.py:765-789`), version check | `fetch` | Optional. |
| `argparse`, `runpy` | Options and the config file executed as Python (`nextdraw-api/nextdraw/utils.py` `load_config`) | JSON or TS config | Moving off Python also removes axya's current config-injection concern (see CLAUDE.md). |

---

## 2. Lifecycle of a plot

The CLI path is `nextdraw_CLI()` → `NextDrawWrapperClass.effect()` → `plot_to_nextdraw()` → `NextDraw.effect()`. The steps below follow that path for `--mode plot`/`layers`/`res_plot` on a real machine.

1. **Config merge.** `load_configs([args.config, 'nextdrawcore.nextdraw_conf'])` executes each config file with `runpy` and merges them with `dict.update`, defaults first (`nextdraw-api/nextdraw/utils.py` `load_configs`; called at `nextdraw-api/nextdraw/nextdraw_cli.py:314`). The merge is shallow: a user config that defines `overrides` replaces the whole default dict, so any missing key causes a `KeyError` in `apply_model_and_handling`. Option precedence is: CLI value if not None, then user config, then default config, then the argparse default (`utils.py` `assign_option_values`/`get_configured_value`). Two quirks:
   - `store_true` flags that are false are reset to None so that config values win (`nextdraw_cli.py:269-272`).
   - `OPTION_NAMES` (`utils.py:10-15`) and the per-machine `selected_options` list (`nextdrawcore/nextdraw_control.py:206-212`) both omit `offset_start`. As far as the code shows, the CLI `--offset_start` flag never reaches `NextDraw.options`; only a config-file value does. Treat this as a likely bug and confirm it with the oracle before relying on it.

2. **Signal setup.** `NextDrawWrapperClass.__init__` maps both SIGINT and SIGTERM to `software_initiated_pause_event.set()` (`nextdrawcore/nextdraw_control.py:75-84`). Each `NextDraw` receives that event through `set_up_pause_receiver` (`:196`, `nextdrawcore/nextdraw.py:119-126`).

3. **Construction.** `NextDraw.__init__` builds the options with argparse defaults taken from `params`, calls `apply_model_and_handling(self, True)`, and creates `PlotStatus`, `PenHandler`, `PlotWarnings`, `Preview`, `HomingClass` and `EBBMotionWrap` (`nextdrawcore/nextdraw.py:78-117`).

4. **`effect()` start** (`nextdrawcore/nextdraw.py:195-235`): resets stats, sets the position to (0,0) "until suggested otherwise" (`:210-211`), then calls `update_options()`. That function calls `apply_model_and_handling` again, sets `bounds = [[-1e-9,-1e-9],[travel_x+1e-9, travel_y+1e-9]]` (`:179-182`), and clamps `pen_pos_*` to 0–100 and the speeds, accel and pen rates to 1–100 (`:185-193`).

5. **Model and handling** (`nextdrawcore/nextdraw_options/models.py:231-348`). When the model changes, it copies `model_name`, `travel_x/y`, `jerk_derate`, `auto_home` and `z_motor`; `penlift==3` forces `z_motor=1`. When the handling changes (and is non-zero), it sets:
   - `resolution`
   - `jerk_pen_down = handler.jerk * jerk_derate`
   - `const_speed = (handler.jerk==0)`
   - `curve_tolerance`
   - `speed_limit = min(handler.speed, speed_lim_xy_lr|hr)`
   - `speed_up = min(handler.speed_up, …)`

   It then always sets `jerk_pen_up` from the model's `_lo`/`_hi` value, and applies the overrides (`:299-323`). When `z_motor` changes, it copies the servo constants and applies the servo overrides (`:325-348`). Three subtleties:
   - A model change without a handling change does **not** recompute `jerk_pen_down` with the new `jerk_derate`, because of the `handling_old` guard at `:275`.
   - `overrides['speed_up']` exists in the config (`nextdrawcore/nextdraw_conf.py:220`) but is never applied.
   - `model == 0` returns early (`:256`).

6. **Mode dispatch.** `res_plot` forces `copies=1`; `digest==2` forces `preview` (`nextdrawcore/nextdraw.py:268-279`).

7. **Connect** (if not preview). `serial_connect` → `serial_utils.connect` → `EBB3.connect` (`plotink/ebb3_serial.py:195-269`). The handshake is:
   - Open at 1 s timeout and flush input.
   - Send `v\r` and read a line, retrying once; the line must contain `"EBB"`.
   - Parse `"Firmware Version X"` and require at least 3.0.2 (`MIN_VERSION_STRING`, `:50`).
   - Send raw `CU,10,1\r` (future syntax mode), read one line and ignore it, then flush.
   - Query the nickname with `QT`.

   After the handshake the driver sends `CU,3,1` (empty-FIFO LED), `CU,4,16` (**FIFO depth 16**) and `CU,50,0` (stepper freewheel) (`nextdrawcore/serial_utils.py:65-67`). A failed connection sets `plot_status.stopped = 101` (`nextdrawcore/nextdraw.py:973-979`).

8. **Read plotdata and the resume decision** (`nextdrawcore/nextdraw.py:301-366`): `resume.read_from_svg`. In `res_plot` mode it calls `res_plot_options_update` (or gives up when `old.pause_dist < 0`). Otherwise `pause_warning` may refuse the plot once and rewrite the file with `pause_warn=0` (`:319-326`). `--offset_start` is handled here (§8.3).

9. **`prepare_document()`** (`nextdrawcore/nextdraw.py:570-679`):
   1. `get_doc_props` reads width and height in inches (`plot_utils.getLengthInches`). `%` or a missing value is invalid and returns False. `rotate_page = auto_rotate and height > width` (`:995-1012`).
   2. Deep-copies the document as `backup_original` (`:586-587`).
   3. Computes the viewBox scale with `vb_scale_2`, falling back to 1/96 in per px. Sets `svg_transform = scale(s_x,s_y) translate(o_x,o_y)` (`:592-606`) and stores `vb_stash`.
   4. If the file contains a matching plob (`verify_plob`), loads the digest directly and skips every optimization (`:608-619`, `randomize_optimize` early return at `:684-685`).
   5. Otherwise calls `DigestSVG.process_svg` (§3), then `digest.rotate(auto_rotate_ccw)` if `rotate_page`.
   6. **Clipping**: with `hiding`, uses `ClipPathsProcess` and pyclipper, then `layer_filter`, `remove_unstroked`, `flatten` (`:632-650`). Without it, uses `boundsclip.clip_at_bounds(digest, bounds, doc_bounds+1e-9, bounds_tolerance, clip_to_page)`, which flattens and adds the `bounds` warning (`:651-662`).
   7. **Optimizations**: `connect_nearby_ends(min_gap, reordering)`, then `supersample(curve_tolerance/3)`, then `randomize_optimize(True)`, which runs `randomize_start` if enabled and then `reorder` (`:670-694`). With `digest>0` the plob is snapshotted as `backup_original` (`:693-694`), so the plob becomes the output document.

10. **Digest-only exit.** `digest==2` writes plotdata into the plob and returns (`nextdrawcore/nextdraw.py:390-395`).

11. **Resume crop.** In `res_plot`, `digest.crop(resume.old.pause_dist)` (`:397-398`; §8).

12. **Optional dry run.** With `--progress` from the CLI only, `ProgressBar.review` switches to preview and runs `plot_document()` once to measure the total distance and estimated time, then `restore()` (`:400-405`, `nextdrawcore/plot_status.py:482-546`). The whole planning pipeline therefore runs twice.

13. **Copies loop** (`nextdrawcore/nextdraw.py:411-425`). `copies==0` means continuous (`copies_to_plot = -1`). Each subsequent copy calls `stats.next_page()` and re-runs `randomize_optimize` if `random_start` is on; then `plot_document()`, then the page delay.

14. **`plot_document()`** (`nextdrawcore/nextdraw.py:696-726`):
    1. Real mode only: `query_ebb_voltage()` reads QG (acting on the power-loss bit) and QC. **If V+ is below threshold the plot returns silently with `stopped == 0`** (exit 0, nothing plotted, `voltage` warning) (`:701-703`, `:981-993`).
    2. `pen.servo_init` (§9), then `pen.pen_raise`.
    3. `serial_utils.enable_motors` (EM if needed; sets `step_scale`, `speed_pendown` and `speed_penup`; §5.6).
    4. `homing.find_home()` (§10). On failure, `stopped` becomes 105 or 106.
    5. `plot_doc_digest(digest)` (the main loop below), then `pen_raise`.
    6. If not stopped: `resume.new.clean()`, then a pen-up `go_to_position(min(x,0.1), min(y,0.1))`, then `homing.precision_move_to(0,0)` (HM correction, §10.4) (`:716-723`).

15. **Main loop.** `plot_doc_digest` (`nextdrawcore/nextdraw.py:791-820`) handles each layer in turn:
    - `end_temp_height`, `pen_raise`, then `eval_layer_props` (pause, delay, height, speed; §3.4).
    - `plot_polyline` for each path. It clamps vertices to `[0, bounds_max]` with tolerance 2e-9, makes a pen-up `go_to_position` to the first vertex, builds `motion.trajectory()` as `['lower', …moves…, 'raise']`, and passes it to `dripfeed.feed()`. On success it sets `down_travel_inch = before + path.length()` (`:849-890`).
    - Restore the layer speed (re-running `enable_motors` if it changed) and end the temporary height.

16. **Cleanup** (`plot_cleanup`, `nextdrawcore/nextdraw.py:728-789`): restores `backup_original` (the pre-modification SVG, or the plob), renders the preview layer (preview mode only), prints the time and distance report and pen-lift count, and sends the webhook if one is configured.

17. **Write plotdata.** If `resume.update_needed`, `write_to_svg` (`:429-432`). Then `servo_revert` (wait for the queue, restore `SC,5`) and `disconnect()`, which waits for the queue unless in utility mode (`:433-436`, `:1019-1033`).

18. **Output and exit.** `nextdraw_control` copies `nd.plot_status.stopped` into `status_code` (`nextdrawcore/nextdraw_control.py:239-242`). The CLI writes `outdoc` only if `--output_file` is given **and** the serialized document differs from the input (`nextdraw-api/nextdraw/nextdraw_cli.py:352-353`, `utils.has_output`). It exits with code 1 if `status_code >= 100`, otherwise 0 (`:355-356`).

### 2.1 `plot_status.stopped` codes

`pause_check` stores negative codes while it acts and then negates them (`nextdrawcore/nextdraw.py:965`).

| Final value | Meaning | Set at | CLI exit |
|---|---|---|---|
| 0 | Normal completion. Also used for "no power, nothing plotted" and "pause warning refused". | | 0 |
| 1 | Programmatic pause from a `!` layer | `nextdraw.py:831` | **0** |
| 2 | Pause during the delay between copies | `nextdraw.py:913, 940` | 0 |
| 101 | Failed to connect | `nextdraw.py:979` | 1 |
| 102 | Pause button | `nextdraw.py:946, 949` | 1 |
| 103 | Software pause (SIGINT/SIGTERM). The comment at `:911` says "Code 104"; the value is −103. | `nextdraw.py:911` | 1 |
| 104 | USB connection lost | `nextdraw.py:936` | 1 |
| 105 | Power lost (QG bit 6, or homing with a voltage warning) | `nextdraw.py:916`, `homing.py:147` | 1 |
| 106 | Homing failed | `homing.py:149` | 1 |

**axya impact:** `docs/ARCHITECTURE.md` says every resumable pause exits with code 1. A programmatic `!` layer pause also writes resumable plotdata and prints "Use the resume feature to continue", but it exits with **0** (`nextdrawcore/nextdraw.py:954-971`).

---

## 3. SVG digest (`digest_svg.py`, `path_objects.py`)

### 3.1 Coordinates and units

- Width and height come from `getLengthInches`. Supported units are `in`, `mm`, `cm`, `Q`/`q`, `pc`, `pt`, and `px` or unitless (both at 96/in). `%` returns None, which makes the document invalid (`plotink/plot_utils.py:269-304`, `:307-347`).
- The viewBox is applied by `vb_scale_2` (`plotink/plot_utils.py:861-958`). It implements `preserveAspectRatio` alignment (`none`, `x{Min,Mid,Max}Y{Min,Mid,Max}`; default `xMidYMid meet`) and returns `(s_x, s_y, o_x, o_y)`. A point maps to inches as `x_in = s_x * (x_user + o_x)`, since the transform is `scale(s) translate(o)` (`nextdrawcore/nextdraw.py:605-606`). An invalid or missing viewBox gives `s = 1/96`, `o = 0`.
- **All digest coordinates are inches**, in document space with Y pointing down; that is also machine space.
- Percent lengths on shapes are resolved against `doc_width_100 = width_in / s_x` and `doc_height_100`; circle and ellipse radii use the normalized diagonal `sqrt(w²+h²)/sqrt(2)` (`nextdrawcore/digest_svg.py:438-440`).

### 3.2 Traversal (`DigestSVG.traverse`, `nextdrawcore/digest_svg.py:459-711`)

**Style.** Only `fill`, `stroke`, `fill-rule`, `visibility` and `display` are tracked. Presentation attributes are merged into the style dict when the style does not set them; `inherit` copies the parent's value (`:479-492`, `inherit_style` `:801-837`).

**Skipping.** `display:none` in the style or as an attribute skips the subtree (`:494-497`). `visibility` hidden or collapse skips only the element itself; visible children of hidden parents still plot, because the check comes after the container handling (`:629-632`).

**Transforms.** The node's `transform` is composed with the current matrix (`:499-505`). Supported transforms are `translate`, `scale`, `rotate(a[,cx,cy])`, `skewX`, `skewY` and `matrix`; lists are parsed recursively (`ink_extensions/simpletransform.py:26-79`).

**Elements.**

| Element | Handling |
|---|---|
| `g` | A top-level `inkscape:groupmode="layer"` group directly under the root (while the current layer is `__digest-root__`) starts a new `LayerItem` (`:507-561`). Nested layers and ordinary groups are traversed as groups (`:562-563`). |
| `symbol` | Traversed only inside a `use` (`:566-571`). |
| `a`, `switch` | Traversed as groups; `switch` conditions are ignored (`:573-583`). |
| `use` | `xlink:href` only (SVG 2 `href` is ignored). The `x`/`y` translate is composed after the use's transform, and `use_tag_nest_level` is tracked (`:585-621`). |
| `path` | `d` attribute. The check matches only the namespaced tag `{svg}path` (`:634`), unlike the other shapes. |
| `rect` | Includes rounded corners via `A` arcs; `rx`/`ry` default to each other and are clamped to half the size (`:51-105`). |
| `line` | `M x1 y1 L x2 y2` (`:108-134`). |
| `polyline`, `polygon` | `points` (needs at least 4 numbers); polygon adds `Z` (`:137-162`). |
| `circle`, `ellipse` | Two half-arcs starting at 3 o'clock. A zero radius produces nothing (`:165-211`). |
| `metadata`, `plotdata` | Attributes copied into `digest.metadata` and `digest.plotdata` (`:666-673`). |
| `defs`, `namedview`, `title`, `desc`, `pattern`, gradients, `style`, `font`, `foreignObject`, comments, and others | Ignored (`:675-694`). |
| `text`, `flowRoot` | Warning `text` (`:696-699`). |
| `image` | Warning `image` (`:701-703`). |
| Anything else | Warning keyed by its local tag name (`:710-711`). |

**Layers mode.** When `layer_selection >= 0`, elements in the root pseudo-layer are skipped (`:625-627`). Layers whose number is not the selected one, or that have no number, are skipped (`:524-528`).

**Layer list bookkeeping.** A `__digest-root__` pseudo-layer is created at the start (`:446-454`) and again after each real layer (`:551-561`). An empty pseudo-layer is deleted when the next real layer begins (`:533-534`). Drawing order is therefore document order, with interleaved root content preserved.

### 3.3 Curve flattening (`digest_path`, `nextdrawcore/digest_svg.py:713-783`)

1. `simplepath.parsePath(d)` converts everything to absolute M/L/C/Q/A/Z. `CubicSuperPath` turns Q into C using the ⅓/⅔ rule, and arcs into cubic sectors with `NbSectors = int(|Δθ|·2/π)+1` and handle length `v = 4·tan(dθ/4)/3` (`ink_extensions/cubicsuperpath.py:44-151`). `Z` appends a segment back to the subpath start.
2. The transform matrix (current matrix composed with the viewBox scaling, so the output is in inches) is applied to every control point (`apply_transform_to_path`, `nextdrawcore/digest_svg.py:786-798`).
3. `plot_utils.subdivideCubicPath(subpath, bezier_tolerance)` splits each cubic at t=0.5 (`bezmisc.beziersplitatt`) until both control points lie within tolerance of the chord, as tested by `four_points_in_tolerance` (`plotink/plot_utils.py:397-507`). It is iterative, not recursive.
4. The tolerance is `bezier_tolerance = curve_tolerance / 3`, which is 0.002/3 inch for Technical drawing. A layer with `+m<n>` uses that handling mode's tolerance (`nextdrawcore/digest_svg.py:433`, `:539-547`; `models.find_curve_tolerance` `nextdrawcore/nextdraw_options/models.py:351-364`).
5. The superpath endpoints `vertex[1]` become the vertices. Subpaths with fewer than 2 points are dropped. Fill is removed if every subpath has only 2 vertices (`:750-777`).

After clipping, `DocDigest.flatten()` splits multi-subpath `PathItem`s into one `PathItem` per subpath (ids `<id>_f<n>`) and clears stroke and fill (`nextdrawcore/path_objects.py:410-438`, `:488-501`).

### 3.4 Layer-name syntax (`LayerProperties.parse`, `nextdrawcore/path_objects.py:311-355`)

The grammar is:

```
name   := '%' anything                      -> documentation layer (skip it and its contents)
        | ['!'] [digits] { key digits } [text]
key    := '+d' | '+h' | '+s' | '+m' | '+g'    (case-insensitive; matched on remainder[:2].lower())
```

| Token | Meaning | Valid range (out-of-range values are ignored) | Effect |
|---|---|---|---|
| leading `%` | Documentation layer | — | Layer and children skipped in the digest (`digest_svg.py:522-523`) and in plobs (`path_objects.py:675-677`, `digest_svg.py:919-921`). |
| leading `!` | Programmatic pause before the layer | — | `stopped = -1` → `pause_check` (`nextdraw.py:828-832`). Skipped during the progress dry run. |
| leading digits | Layer number | Any non-negative integer (`find_int` reads ASCII digits only) | Selection in `layers` mode. |
| `+d<n>` | Delay at layer start, ms | `n > 0` | `page_layer_delay(between_pages=False)` (`nextdraw.py:838-839`). |
| `+h<n>` | Temporary pen-down height | 0–100 | `pen.set_temp_height` → `servo_init` if changed (`nextdraw.py:840-841`). |
| `+s<n>` | Pen-down speed, % | **1–110** | `use_layer_speed=True` → `enable_motors` re-derives `speed_pendown` (`nextdraw.py:842-847`). Values above 100 can push per-motor rates past the firmware step limit at the 8.6979 in/s cap (§12). |
| `+m<n>` | Handling mode for this layer | 1–4 | **Curve tolerance only.** Speeds and jerk are not changed (`digest_svg.py:539-547`). |
| `+g<n>` | Reordering for this layer | 0–4 | Overrides `reordering` in joining and sorting (`plot_optimizations.py:99-101`, `:303-305`). |
| remaining text | Human label | — | `props.text`. |

Parsing details:

- The loop only runs while at least 3 characters remain (`:331`), so a trailing `+d` with no digits becomes text.
- A key followed by a non-digit consumes the key and continues.
- `layer_name.strip()` is a no-op because its result is discarded (`:318`), so leading whitespace defeats the `%` and `!` checks.
- `compose()` (`:357-378`) writes the canonical form used in plobs: `!` `N` `+d` `+h` `+s` `+m` `+g` `text`.

### 3.5 DocDigest and the plob format

- `DocDigest` holds `name`, `width`, `height` (inches), `viewbox`, `plotdata` (which always contains `plob_version`), `metadata`, `flat` and `layers[]`. Each `LayerItem` holds `name`, `paths[]`, `item_id` and `props`. Each `PathItem` holds `subpaths` (lists of `[x,y]`), `stroke`, `fill`, `fill_rule`, `item_id` and a cached `flat_length` (`nextdrawcore/path_objects.py:71-182`, `:381-486`).
- `PLOB_VERSION = "1"` (`:60`).
- **`to_plob()`** (`:551-602`) emits the `PLOB_BASE` root with the `nd:` namespace, `width`/`height` in `in` written with `%f`, `viewBox` and `sodipodi:docname`. It then writes a `<metadata>` element, an `<nd:plotdata>` element, and one `<g inkscape:groupmode="layer" inkscape:label=…>` per layer. Real layers get `id=item_id`; root pseudo-layers keep the label `__digest-root__`. Each path becomes `<polyline id points="x,y x,y …">` with `%f` (6 decimal places) (`vertex_list_to_string`, `:768-796`). Coordinates are inches and the viewBox is `0 0 w h`.
- **`verify_plob()`** (`nextdrawcore/digest_svg.py:840-951`) requires:
  - a plotdata node with `model` and `plob_version == "1"`;
  - a valid viewBox, if one is present;
  - root children limited to labelled `g` layers whose children are only untransformed `polyline`s, plus `defs`, `metadata`, `namedview` and `plotdata`. Unlabelled groups are allowed only if they contain nothing plottable; `%` layers are allowed.
  - the model to match, or the document to fit within the selected model's travel.
- **`from_plob()`** (`nextdrawcore/path_objects.py:604-693`) rescales by `svg_width_inches/width_value` when the width is not in inches.
- When a valid plob is plotted, no clipping, joining, supersampling, randomizing or reordering is run (`nextdrawcore/nextdraw.py:613-619`, `:684-685`).

---

## 4. Plot optimizations (`plot_optimizations.py`)

All of these work on a **flat** digest and process each layer independently.

### 4.1 Path joining: `connect_nearby_ends(digest, min_gap, reordering)` (`:71-221`)

- It is disabled when `min_gap < 0` (default 0.006 in, `nextdrawcore/nextdraw_conf.py:178`) or when the layer's effective reordering is 4. Reversal is allowed for reordering 2 or 3.
- **Index.** `rtree.Index` over 2N boxes: the start point of path i has id `i` and the end point has id `i+N`, each inflated by ±`min_gap` (`:111-119`). The index (`plotink/rtree.py:56-131`) is a one-shot quadtree. Leaves hold at most 16 boxes; a node is not split when one quadrant would hold every box or when the duplication factor exceeds 1.5. `intersection()` returns a set of ids.
- **Algorithm.** Paths are visited in file order; each visited path is marked consumed.
  1. **Grow forward.** For each candidate from the sorted intersection list at the current end (id mod N, not yet consumed): if its start is within `min_gap` (squared-distance test `points_near`, strict `<`), concatenate it. If reversal is allowed and its end is within range, reverse it and concatenate. After each join, re-query at the new end and start over.
  2. **Grow backward** from the start point in the same way.
- `concatenate_paths` drops the duplicated junction vertex only when `points_equal` (exact `math.isclose`, relative tolerance 1e-9, no absolute tolerance) (`:60-68`). Otherwise the short gap becomes a pen-down segment.
- The joined path keeps the attributes of whichever `PathItem` object received the concatenation.

### 4.2 Supersampling: `supersample(digest, curve_tolerance/3)` (`:257-265` → `plotink/plot_utils.py:602-644`)

For each polyline, starting at vertex `s`, it extends `e` while every vertex strictly between `s` and `e` is within tolerance of segment `s→e` (`points_in_tolerance`), then deletes the interior vertices. Worst case is O(n²).

### 4.3 Random start: `randomize_start(digest, seed)` (`:224-254`)

- `random.seed(seed)` is called once per call.
- For each path with at least 3 vertices that is `closed()` (first and last vertex within 1e-4 in, `nextdrawcore/path_objects.py:227-236`), it picks `r = random.randrange(len-1)` and rotates: `v[r:] + v[1:r+1]`.
- The seed is `int(time.time()*100)` (`nextdrawcore/nextdraw.py:687-688`) and is stored as `rand_seed` in plotdata so that a resume reproduces the same order.

### 4.4 Reordering: `reorder(digest, reordering_type)` (`:276-355`)

| Value | Join (4.1) | Sort | Reverse |
|---|---|---|---|
| 0 (default) | yes | no | no |
| 1 | yes | greedy nearest-neighbour | no |
| 2 | yes | greedy NN | yes |
| 3 (deprecated, same as 2) | yes | greedy NN | yes |
| 4 | **no** | no | no |

- **Data structure:** `spatial_grid.Index(endpoints, bins, reverse)` (`plotink/spatial_grid.py`). The grid has B×B cells, with `B = 4 + floor(sqrt(N/25))` when reversing and `4 + floor(sqrt(N/50))` otherwise. Its extent is the bounding box of all start points (and end points, if reversing), grown by a shim of `(w+h)/200`. Each cell lists entries: id `i` for path start, `N+i` for path end. An adjacency table lists each cell and its up-to-8 neighbours.
- **`nearest(v)`** (`:186-237`) scans v's cell and its neighbours for the minimum squared distance. **Quirk:** `if best_index:` treats index 0 as not found and falls through to a full scan of all other cells, keeping `best_dist`. The result for path 0 can therefore come from outside the neighbourhood. A port must reproduce this for parity. If the neighbourhood is empty, the whole grid is scanned.
- **Tour:** start at **(0,0) for every layer** (`:328`, inside the layer loop), not at the previous layer's end. Pick the nearest entry: id ≥ N means "draw reversed, exit at its start"; otherwise "exit at its end". Remove both entries of the chosen path and repeat.
- **Edge case:** if every endpoint coincides, `bin_size` is 0, which gives a `ZeroDivisionError` in the binning (`:113-123`). Untested; do not rely on it.

---

## 5. Motion planning

### 5.1 Units, axes and step scales

- Planning uses inches and seconds. Firmware time is in ISR ticks of 40 µs (25 kHz).
- CoreXY-style mixing (`nextdrawcore/motion.py:486-496`):

  ```
  m1 = Δx + Δy        m2 = Δx − Δy                       (inches of belt)
  steps_k = round_half_even(step_scale · m_k)
  Back-conversion: Δx = (s1 + s2)/(2·step_scale),  Δy = (s1 − s2)/(2·step_scale)
  ```

- `step_scale` is set in `enable_motors` (`nextdrawcore/serial_utils.py:198-218`):

  | resolution | EM | microstepping | step_scale | ≈ steps/inch along a motor axis |
  |---|---|---|---|---|
  | 1 (high, "Super") | `EM,1,1` | 16× | `2 · native_res_factor` = 2032 | 2032·√2 ≈ 2874 |
  | 2 (low, "Normal") | `EM,2,2` | 8× | `native_res_factor` = 1016 | 1016·√2 ≈ 1437 |

  The comment "Enable motors at 16X microstepping" on the low-resolution branch (`:211`) is a copy-paste; EM value 2 means 8× (`plotink/ebb3_motion.py:108-116`).
- **Axis order on the wire:** `SM,<duration>,<axis1>,<axis2>` with axis1 = motor 1 = Δx+Δy. `xy_move(delta_x, delta_y)` is called as `xy_move(steps2, steps1, t)` and formats `SM,t,{delta_y},{delta_x}` (`plotink/ebb3_motion.py:65-77`), so the misleadingly named arguments still put motor 1 first. T3 and TD always list axis 1 parameters before axis 2.
- **Minimum segment:** segments shorter than `MAX_STEP_DIST_HR = 0.000348` in (or `_LR = 0.000696`) are skipped during trajectory trimming (`nextdrawcore/motion.py:41-42`, `:189-220`). In `compute_segment`, moves of less than 1 step on both motors return `(None, None)` (`:498-499`).

### 5.2 Speed and jerk limits

```
speed_pendown [in/s] = (layer_speed% if +s else speed_pendown%) · params.speed_limit / 100
speed_penup   [in/s] = speed_penup% · params.speed_up / 100                  (serial_utils.py:205-218)
params.speed_limit   = min(handler.speed,    speed_lim_xy_hr|lr)                (models.py:283-292)
params.speed_up      = min(handler.speed_up, speed_lim_xy_hr|lr)
speed_lim_xy_hr = 8.6979, speed_lim_xy_lr = 17.3958 in/s                        (nextdraw_conf.py:246-247)
   (derived: 24 995 steps/s ÷ (step_scale·√2))

a = min(accel%, 100)/100;  k = a³                      (cubic, although the comment says "x^2")
jerk_down = params.jerk_pen_down · k;  jerk_up = params.jerk_pen_up · k   [in/s³]   (plan_utils.py:129-148)
```

| Handling (`models.py:99-131`) | res | jerk (pen-down, before derate) | speed | speed_up | curve tolerance |
|---|---|---|---|---|---|
| 1 Technical drawing | 1 | 20 000 | 8.6979 | 8.6979 | 0.002 |
| 2 Handwriting | 2 | 90 000 | 7 | 12 | 0.008 |
| 3 Sketching | 2 | 14 000 | 12 | 12 | 0.005 |
| 4 Constant speed | 1 | 0 (const_speed) | 3.0 | 8.6979 | 0.002 |

| Model (`models.py:137-227`) | travel x × y (in) | jerk_pen_up hi / lo | jerk_derate | auto_home | z_motor |
|---|---|---|---|---|---|
| 1 AxiDraw V3, SE/A4 | 11.81 × 8.58 | 19000 / 13000 | 1.0 | no | 0 |
| 2 V3/A3, SE/A3 | 16.93 × 11.69 | 17000 / 12000 | 0.9 | no | 0 |
| 3 V3 XLX | 23.42 × 8.58 | 18000 / 13000 | 1.0 | no | 0 |
| 4 MiniKit | 6.30 × 4.00 | 6000 / 6000 | 0.6 | no | 0 |
| 5 SE/A1 | 34.02 × 23.39 | 13000 / 8000 | 0.6 | no | 0 |
| 6 SE/A2 | 23.39 × 17.01 | 16000 / 10000 | 0.7 | no | 0 |
| 7 V3/B6 | 7.48 × 5.51 | 14000 / 14000 | 1.0 | no | 0 |
| 8 NextDraw 8511 | 11.81 × 8.58 | 19000 / 13000 | 1.0 | **yes** | 1 |
| 9 NextDraw 1117 | 16.93 × 11.69 | 17000 / 12000 | 0.9 | **yes** | 1 |
| 10 NextDraw 2234 | 34.02 × 23.39 | 13000 / 8000 | 0.6 | **yes** | 1 |

There is no separate acceleration limit. Peak acceleration of an S-curve is `j·t_m`. `calc_layer_speeds` (`plan_utils.py:57-103`) is dead code; it also contains a clamp bug at `:79`.

Default worked example (model 8, handling 1, `speed_pendown` 25, `speed_penup` 75, `accel` 75):

- pen-down speed = 2.1745 in/s
- pen-up speed = 6.5234 in/s
- k = 0.421875
- `jerk_down` = 8437.5 in/s³
- `jerk_up` = 8015.6 in/s³

### 5.3 S-curve primitives (`plan_utils.py`)

Each S-curve is a pair of T3 moves of equal duration `t_m`. The first has jerk +j and zero initial acceleration; the second has jerk −j and starts at acceleration `j·t_m`, so acceleration is zero at both ends. The derivation is documented in the code (`:172-293`):

```
v_f = v_i + j·t_m²                 t_m = sqrt(|v_f − v_i| / j)
dist = 2·v_i·t_m + j·t_m³          (accel)   ≡   dist = 2·v_f·t_m − j·t_m³ (decel)
scurve_time(v_i,v_f,j) = 2·sqrt(|v_f − v_i| / j)         (:491-501; returns 0 if j == 0)
```

**`scurve_plan(v_in, v_max, j, dist=None, min_time=None)`** (`:151-372`):

1. Take absolute values of all inputs. If `j == 0`, use `j = 1000`.
2. `t_m = sqrt(|v_max − v_in|/j)`, `d_max = 2·v_in·t_m + j·t_m³`.
3. If `dist is None` and `t_m ≈ 0`, return 0. If `min_time` is set and `t_m < min_time/2`: set `t_m = min_time/2`, `j' = |v_max − v_in|/t_m²`, and recompute `d_max` with `j'`. If `dist is None`, return `d_max`.
4. If `dist ≥ d_max` (or `isclose`), return `v_max`.
5. Solve `j·t³ + 2·v_in·t − dist = 0` with `cubic_eqn.solve` and take the smallest real positive root. If none exists, return None.
6. If `min_time` is set and `t < min_time/2`: set `t = min_time/2`. If `v_in ≠ 0` and `dist/v_in < min_time`, **return `max((dist − v_in·t)/t, 0)`** (the deceleration case). Otherwise `j = |dist − 2·v_in·t|/t³`.
7. Return `min(v_max, v_in + j·t²)`.

This one function answers three questions: the distance needed to reach `v_max`; the highest final speed reachable within `dist`; and, by symmetry, the highest initial speed that can still decelerate to `v_in` within `dist`.

**`striangle(v_i, v_f, v_max, j, dist)`** (`:533-572`) bisects `v ∈ [max(v_i,v_f), v_max]` until `scurve_plan(v_i,v,j) + scurve_plan(v_f,v,j)` is within 1e-5 in of `dist`. There is **no iteration cap**.

**`scurve_jerk` and `scurve_jerk2`** (`:375-488`) bisect `t_m` (at most 50 iterations) to find a reduced jerk `j = |dist − 2·v_lo·t_m|/t_m³` whose `v_lo + j·t_m²` matches `v_hi` within 1e-6.

| Parameter | `scurve_jerk` | `scurve_jerk2` |
|---|---|---|
| Lower bound on `t_m` | `max(0.003, dist/(2·v_lo))` (`v_lo = 0` is treated as 0.001) | 0.002 |
| Upper bound on `t_m` | `sqrt((v_hi−v_lo)/(1.25·j_max))` | uses `1.3·j_max` |

### 5.4 Polyline velocity planning (`plan_trajectory`, `nextdrawcore/motion.py:95-397`)

1. **Escape for one segment.** Two vertices → `compute_segment(v1, vi=0, vf=0)` and return the move list (`:145-158`).
2. **Trim.** Drop vertices closer than the minimum step distance to the last kept vertex. Build `traj_dists[i]` (length of the segment arriving at vertex i), unit vectors, and `trimmed_path` (`:180-220`). **These arrays are `array('f')`, which is float32** (`:180-181`).
3. If only one segment survives trimming, it returns `compute_segment(...)` **as a tuple** (`:228-231`), not a list. `trajectory()` then extends `['lower', …]` with `(moves, data)`, and `feed()` silently ignores both elements because neither has a string tag. The segment is not drawn and `pen.phys` is not advanced. Supersampling (tolerance at least 0.00067 in, larger than the trim threshold) almost always removes such a vertex first, so the bug is latent in the default pipeline. An exact port should reproduce it; a correct port should return the list, and the oracle will show the difference.
4. **Forward pass, junction speeds** (`:249-319`). For each interior vertex i:
   ```
   v = scurve_plan(traj_vels[i−1], v_lim, j, traj_dists[i], min_time=0.007)   # reachable speed
   c = max(0, û_{i−1} · û_i)                                                   # cosine of turn
   if   v > 0.5·v_lim: v = v · c⁴
   elif v > 0.25·v_lim: v = v · c
   v = min(v, 0.8·v_lim)
   traj_vels.append(v)        (float32)
   ```
   The final vertex gets 0. `v_lim` and `j` are the pen-down values unless the start state is pen-up.
5. **Reverse pass, deceleration feasibility** (`:340-362`). For `i` from last to 1: if `v[i−1] > v[i]` (not `isclose` with absolute tolerance 1e-9) and the segment length is positive, set `v[i−1] = min(v[i−1], scurve_plan(v[i], v_lim, j, traj_dists[i], 0.007))`.
6. Call `compute_segment` for each trimmed segment with `(target, v[i], v[i+1])`, threading `xyz_pos` (which includes the accumulators) through (`:384-397`).

The pen-up move to the start of a path, `go_to_position`, is a single `compute_segment` with `vi = vf = 0` that uses the current `z_up` (pen-up limits) (`nextdrawcore/nextdraw.py:892-901`).

### 5.5 Segment profile cases (`compute_segment`, `nextdrawcore/motion.py:400-796`)

**Preliminaries:**

- Clamp the target to `bounds` with `bounds_tolerance` (0.003 in), unless `ignore_limits`; this sets the `bounds` warning (`:469-476`).
- Compute steps and the rounded distance `dist` (`:486-501`).
- `v_lim` and `j` are the pen-up or pen-down values. `vi = min(vi, v_lim)` and `vf = min(vf, v_lim)`. In const-speed mode with the pen down, both are set to `v_lim` (`:513-518`).
- `const_speed_time = dist/vi`, or 100 if `vi ≈ 0` (`:552-555`).

| Case | Condition (evaluated in order) | Subsegments (1 = S-accel, 2 = S-decel, 3 = constant) |
|---|---|---|
| 3 | const-speed mode, or (`vi≈v_lim` and `vf≈v_lim`) | [3] |
| 3 | `|vi−vf| ≤ 0.01` and `dist/vi < 0.013 s` | [3] |
| 3 | `|vi−vf| ≤ 0.01` and `dist/vi < 0.030 s` and `vi > v_lim/2` | [3] |

Otherwise compute:

```
d_acc = scurve_plan(vi, v_lim, j)
d_dec = scurve_plan(vf, v_lim, j)
d_svm = d_acc + d_dec
d_sse = scurve_plan(min(vi,vf), max(vi,vf), j)
```

| Case | Condition | Subsegments |
|---|---|---|
| 2 | `dist ≥ d_svm`, `vi≈v_lim`, `dist≈d_svm` | [2] |
| 4 | `dist ≥ d_svm`, `vi≈v_lim` | [3 to `dist−d_dec` at `v_lim`, 2] |
| 1 | `dist ≥ d_svm`, `vf≈v_lim`, `dist≈d_svm` | [1] |
| 5 | `dist ≥ d_svm`, `vf≈v_lim` | [1 to `d_acc` at `v_lim`, 3] |
| 6 | `dist ≥ d_svm` (otherwise) | [1 to `d_acc`, 3 to `dist−d_dec`, 2] ("trapezoid") |
| 7 | `dist < d_svm` and (`vi≈vf≈0` within 1e-3, or `dist > d_sse`) | Triangle: `v_mid = striangle(...)`; [1 to `scurve_plan(vi,v_mid)` at `v_mid`, 2] |
| 1 / 2 | `dist ≈ d_sse` (absolute 1e-3) | [1] if `vi < vf`, else [2] |
| 0 | Anything left, **or** a triangle that is rejected (below) | One S-curve with reduced jerk `scurve_jerk` or `scurve_jerk2`. If no solution, the **segment is dropped** (`return None, None`). |

`≈` means `math.isclose` with the default relative tolerance 1e-9, unless stated otherwise.

**Triangle rejection** (`:714-743`): `t3 = scurve_time(vi, vf, scurve_jerk(...))`. If `t3 ≠ 0` and either `t1+t2 > t3` or `t1+t2 < 12 ms`, fall back to case 0.

**Storage precision:** `dist_array`, `vel_array` and `jerk_array` are also `array('f')` (float32) (`:542-545`), and case 0 overwrites `jerk_array[-1]` with the reduced jerk.

When a segment is dropped, nothing moves, but `xyz_pos` stays truthful, so the next segment starts from the real position and absorbs the error.

### 5.6 Converting subsegments to firmware units (`compute_subsegment_cmds`, `nextdrawcore/motion.py:799-1164`)

```
VEL_SCALE  = step_scale · 2³¹ / 25 000          # (in/s) → rate units (steps/tick · 2³¹)
JERK_SCALE = step_scale · 2³¹ / 25 000³         # (in/s³) → rate units per tick²
v̂_k = √2 · steps_k / hypot(steps_1, steps_2)    # per-motor direction factor, |v̂_k| ≤ √2
R_k(v)    = round_half_even(v · VEL_SCALE · v̂_k)    # evaluated as (v·VEL_SCALE)·v̂_k
jerk_k    = J · JERK_SCALE · v̂_k                     # float, rounded where used
```

The direction comes from the **whole segment's** step vector. The initial rate is `R_k(vi)` (`:836-837`). For each subsegment the target end distance is `round(steps_k · dist_array[i]/dist)`, or the exact total for the last subsegment (`:871-879`).

**Accelerating S-curve (type 1)** (`:917-1011`):

```
j_k = round(jerk_k)
t_k = round(sqrt(|R_k(v_end) − R_prev_k| / j_k))         (0 if j_k == 0)
T   = t_k of the axis whose move_dist_t3(t_k, R_prev_k, 0, j_k) has the larger |steps|
       (not max(t1,t2): that fails when one axis has zero steps)
skip if T == 0
a_k  = round(jerk_k · T)
R_kB = rate_t3(T, R_prev_k, 0, j_k) + a_k
emit TD [T, R1A=R_prev_1, R1B, a_1, j_1, R2A=R_prev_2, R2B, a_2, j_2]
```

**Decelerating S-curve (type 2)** (`:1013-1101`) is the same with `j_k = −round(jerk_k)` and `a_k = round(−jerk_k·T)`.

**Constant segment (type 3)** (`:1103-1158`):

```
V_k = R_k(v_end)
t_k = ceil(|Δsteps_k / (V_k / 2³¹)|)
T   = t_k of the larger-distance axis
emit T3 [T, V_1, 0, 0, V_2, 0, 0]
```

`Δsteps_k` is the target end minus the steps already produced. A constant segment is the only kind of subsegment that aims at a step target, and the ceiling means it slightly overshoots. The rate jumps from the previous subsegment's actual end rate to `V_k` with no transition.

After every command, `td_seg_data` or `t3_seg_data` runs the firmware model (§6.4) to get the **actual** steps per axis, the new accumulator values, and the new end rate. `xyz_pos.xpos/ypos` (floats) and `accum1/2` are updated from those. That simulated state is what the next segment plans from. Position therefore never drifts from what the firmware will do, **provided the port's arithmetic matches the firmware bit for bit.**

Constant segments are not split into shorter pieces (there is a TODO at `:1107`), so one T3 can last many seconds. Plain SM moves are produced only by `timed_pause` and homing, never by the planner.

---

## 6. Command generation

### 6.1 Wire formats

| Command | Format as emitted | Source |
|---|---|---|
| TD | `TD,T,R1A,R1B,A1,J1,R2A,R2B,A2,J2` (no Clear field). Firmware runs `T3,T,R1A,0,J1,R2A,0,J2` then `T3,T,R1B,A1,−J1,R2B,A2,−J2`, so its duration is **2T** ticks. | `nextdrawcore/dripfeed.py:288-290`, `:236-240` |
| T3 | `T3,T,R1,A1,J1,R2,A2,J2` (A and J are 0 for constant segments) | `nextdrawcore/dripfeed.py:204-205` |
| T3 clear | `T3,1,0,0,0,0,0,0,3`: zero-motion move whose Clear=3 zeroes both accumulators | `plotink/ebb3_motion.py:216-222` |
| SM | `SM,ms,axis1,axis2`; `SM,ms,0,0` is a timed pause, at most 750 ms each | `plotink/ebb3_motion.py:51-77` |
| HM | `HM,rate,pos1,pos2`: absolute dog-leg move, rate in steps/s (3000) | `plotink/ebb3_motion.py:80-97`, `homing.py:659` |
| EM | `EM,r1,r2` (1 = 16×, 2 = 8×). Enabling motor 2 alone sends `CU,50,0` and may pre-send `EM,r,r`. | `plotink/ebb3_motion.py:108-153` |
| SP | `SP,0|1,duration_ms,pin` (the pin is always included because `servo_pin` is 1 or 2); `SP,3` for an urgent raise | `plotink/ebb3_motion.py:225-250`, `dripfeed.py:74` |
| SC | `SC,4,up_pwm`, `SC,5,down_pwm`, `SC,11,raise_rate`, `SC,12,lower_rate`, `SC,8,1|8` | `plotink/ebb3_motion.py:294-329`, `pen_handling.py:430-464` |
| SR | `SR,60000` (legacy servo only) | `plotink/ebb3_motion.py:332-356` |
| SL / QL | `SL,value,index` / `QL,index` | `plotink/ebb3_serial.py:436-472` |
| CU | `3,1`; `4,16`; `10,1`; `50,0`; `51,0|2`; `52,2`; `60,135` | |
| PO/PD/PI | `PO,B,pin,state`; `PD,B,pin,dir`; `PI,B,pin` | `plotink/ebb3_motion.py:253-291` |
| CS, QS, QE, QC, QG, QU,6, ES, QT, R, RB, BL, ST | as named | |

`command()` and `query()` strip the string, append `\r`, and read one line, retrying empty reads up to 25 times with a 1 s timeout each. A command's response must **start with the command name**: the first letter for one-letter commands or `X,…`, otherwise the first two letters. A query's response must start with the query name, which is then stripped along with the comma. Any `Err:` in a response, a wrong prefix, or a timeout records the **first** error in `machine.err`; after that every command and query is a no-op (`plotink/ebb3_serial.py:290-396`). `QG` is parsed with its own hexadecimal parser, `int(response[3:],16)` (`:399-434`).

### 6.2 Tick rate and rate units

Firmware time is 25 000 ticks/s, so 25 ticks = 1 ms (`dripfeed.py:193, 276`). A rate R means the accumulator gains R per tick, and one step is emitted per 2³¹ (`EBB_ACCUMULATOR_MAX`, `plotink/ebb_calc.py:47`). The firmware maximum is about 25 kHz, which is `R ≈ 2³¹`. With the speed caps, the per-motor rate peaks at `0.9998·2³¹`, just below `2³¹−1`. Exceeding that is an overflow; `rate_t3` documents this at `plotink/ebb_calc.py:202`.

### 6.3 Scaling arithmetic and rounding

- `round()` in Python 3 is **round-half-to-even**. It is used for steps (`motion.py:488-489`), rates (`:836-837`, `:893-894`), jerks (`:945-946`), accelerations (`:975-976`), times (`:949`) and in `rate_t3`. JavaScript's `Math.round` rounds half toward +∞, so the port needs its own `roundHalfEven`.
- `int(x)` and `int(a/2)` truncate toward zero. Use `Math.trunc` and note the float division.
- `math.ceil` is used for constant-segment time.
- `array('f')` storage: every value that passes through `traj_dists`, `traj_vels`, `dist_array`, `vel_array` or `jerk_array` is rounded to float32 and read back as float64. Use `Math.fround` at exactly those store points.

### 6.4 Firmware-exact maths (`plotink/ebb_calc.py`)

**`move_dist_t3(T, R, A, J, accum)`** (`:108-184`) gives the steps moved and the final accumulator for one axis of a T3:

```
if T == 0: return (0, 0)                      # NOTE: returns accumulator 0, not the input accumulator
hA = trunc(A/2);  j6 = trunc(J/6)
accum = given, or the "clear" initial value:
    0, except 2³¹−1 when (R − hA + j6 + A) < 0,
    or (that == 0 and A+J < 0), or (both == 0 and J < 0)
R_eff = R + A/2 − hA + j6 − J/6                    # exact rational: fractional parts in halves and sixths
acc   = accum + T·(R_eff + T·(A/2 + T·J/6))        # Decimal, precision 20
acc_r = round_half_up(acc)                         # Decimal ROUND_HALF_UP: ties go AWAY FROM ZERO
steps = floor(acc_r / 2³¹)                         # float division in Python (see below)
accum_out = acc_r − 2³¹·steps
```

**`rate_t3(T, R, A, J)`** (`:187-210`) gives the rate after T ticks:

```
T == 0 → R + A + J
else   → round_half_even( trunc(R) − trunc(A/2) + trunc(J/6) + (trunc(A) − J/2)·T + J·T²/2 )   # float64
```

**Port recipe:**

- Implement `move_dist_t3` in `BigInt` by multiplying through by 6: `6·acc = 6·accum + T·(6R + 3A − 6hA + 6j6 − J) + 3A·T² + J·T³`. Then round half away from zero when dividing by 6, and use floor division by 2³¹. This is exact, whereas Decimal at 20 digits could round at extreme T.
- Python computes `floor(acc_r / 2³¹)` with **float** division (`:181`). For `|acc_r| > 2⁵³` it can differ from exact floor division by one at boundaries. That only matters for multi-second T3s at high rates; flag it as a parity edge case rather than copying it.
- `rate_t3` uses float64 arithmetic in Python; evaluate the same expression in JS doubles, in the same order, then apply `roundHalfEven`.
- **Overflow headroom:** `R·T` for a long constant T3, for example 60 s at `0.5·2³¹`, is about 1.6e15, under 2⁵³ but not by much. Use BigInt for everything in `move_dist_t3`.

`move_dist_lt`, `calculate_lm` and `max_rate_t3` (LM/LT support, `:55-105`, `:213-400`) are not used by nextdraw and can be skipped.

### 6.5 Accumulator tracking across commands

`pen.phys.accum1/2` carry the remainders from one command to the next. They are threaded through planning in `xyz_pos` and committed by `dripfeed` from each move's snapshot (`dripfeed.py:190-191`, `:219-222`, `:303-306`). They are reset to 0, together with the EBB's own accumulators via `T3,1,0,0,0,0,0,0,3`, in `homing.read_position` (`homing.py:599-601`), and implicitly by `EM` and `CS` (`serial_utils.py:203`). Pen moves (SP) and `SM` pauses do not touch the accumulators.

---

## 7. Dripfeed and flow control (`dripfeed.py`)

- **FIFO.** The connection sets `CU,4,16`, a 16-command motion FIFO (`serial_utils.py:66`). There is no host-side queue accounting. Flow control appears to be implicit. The driver never checks free FIFO space before sending, so it must rely on the EBB holding back its response line until the command fits in the FIFO. This is inferred from the design; confirm it against the EBB reference. `command()` blocks on `readline()`, waiting up to 26 s (1 s timeout × 25 retries) before it calls it a timeout.
- **Host sleeps.** For any SM, T3 or TD longer than 50 ms, the host sleeps `(duration − 30)` ms after sending, except in utility mode (`dripfeed.py:150-152`, `:208-210`, `:293-295`). Pen raises and lowers sleep likewise when longer than 50 ms, except in utility, align and cycle modes (`pen_handling.py:231-233`, `:261-263`). These sleeps keep the pause check responsive and the FIFO shallow.
- **Per-move loop** (`feed`, `:37-108`): for each move, run `pause_check()`. If that call has just stopped the plot, set `copies_to_plot=0`, send **`SP,3`**, and return. Otherwise dispatch:
  - `lower` → `pen_lower`
  - `raise` → `pen_raise`
  - `SM`, `T3`, `TD` → send, or simulate in preview

  The last move is cached in `drip.last_move` for a planned braking move that is not implemented (TODO at `:76`). **There is no deceleration on pause.** The up to 16 queued commands still execute, with the pen lifted.
- **Pause sources**, checked by `pause_check` (`nextdraw.py:903-971`):

  | Source | How it is detected |
  |---|---|
  | Software | `receive_pause_request()`, the Event set by SIGINT/SIGTERM |
  | Button | QG bit 5 (32), polled at most every `button_interval` = 50 ms via `check_button` (`plot_status.py:216-237`) |
  | USB loss | `machine.err` after QG, or two consecutive unreadable QG responses (`serial_utils.py:104-112`) |
  | Power | QG bit 6 (64), unless `skip_voltage_check`. Writes `SL,0,12`, `SL,0,13` and `CS` the first time it is seen (`serial_utils.py:118-124`). |
  | Programmatic | `!` layer |

  QG bit 7 (128) sets `plot_status.limit` (used by homing). Bits 0–3 non-zero mean motion is pending (`exhaust_queue`, `serial_utils.py:129-153`, polled every 50 ms). Bit 4 (16) means the pen is up (`pen_handling.py:339`).
- **Pause bookkeeping.** On any pause other than a programmatic one, `DripCache.queued_dist` sends `QU,6` (the number of commands waiting in the FIFO) and subtracts the sum of the first n entries of `dist_deque`, newest first, from `down_travel_inch` (`plot_status.py:684-707`). `add_dist` pushes 0 for pen-up moves, the distance for pen-down moves, and an extra 0 before each pen-down TD because a TD takes two FIFO slots (`:408-418`). In `res_plot` the result is clamped to at least `old.pause_dist`. **Ambiguity:** SP and SM pause commands also occupy FIFO slots but are not pushed to the deque, so the queued count and the deque can disagree by a slot or two around pen moves. The error is at most a few segments, and it errs towards redrawing.
- **Kept and lost on pause:**
  - The carriage stops wherever the FIFO finishes; there is no return home (`nextdraw.py:717`).
  - The EBB's step counter and RAM variables survive the pause.
  - `SP,3` sets Servo_Max equal to Servo_Min, which raises the pen and turns queued lowers into raises. `servo_revert` later restores `SC,5` (`pen_handling.py:474-493`).
  - Distances still queued are lost from the count and redrawn on resume.
  - Exception: if the pause happens during a page delay, the current copy is not affected (`stopped=-2`).
- **Page and layer delays** (`page_layer_delay`, `:318-363`) wait in 100 ms slices, with the final slice taken whole when less than 150 ms remains. In real mode each slice runs `pause_check`; in preview each slice adds to `pt_estimate`.

---

## 8. Pause and resume persistence

### 8.1 The `<plotdata>` element

It is written as `<nd:plotdata xmlns:nd="https://bantam.tools/nd" …>` directly under the root, replacing any `{nd}plotdata` or `{svg}plotdata` (`plot_status.py:171-198`). On reading, the `nd` namespace is tried first, then `//svg:plotdata | //plotdata` (`:141-143`). Any missing required attribute raises `TypeError`, which deletes the node and leaves `read = False` (`:165-169`).

| Attribute | Type and units | Meaning |
|---|---|---|
| `application` | string | `"nextdraw"` |
| `auto_rot` | 0/1 | `options.auto_rotate` at the pause |
| `handling` | int | Handling mode |
| `hiding` | 0/1 | Hidden-line removal |
| `layer` | int | −1 = all layers (plot mode); N = layers mode; −2 = default or clean |
| `model` | int | Plotter model |
| `optim` | int | `reordering` |
| `pause_dist` | integer **µm** (`round(inches·25400)`) | Pen-down distance at which to resume; −1 (stored as −25400) means none |
| `pause_ref` | integer µm | Distance at the original pause; differs from `pause_dist` after an adjustment; −1 for synthetic |
| `pause_warn` | 0/1 | 1 = warn once if the file is plotted from the start |
| `plob_version` | string | `"n/a"` or `"1"` |
| `rand_seed` | int (read through `int(float())`) | Seed for `randomize_start` |
| `rand_start` | 0/1 | `random_start` |

The values are populated by `update_from_options` at a pause (`:363-376`) and by `clean()` after normal completion, which sets `layer=-2` and `pause_dist=-1` (`:101-104`, `nextdraw.py:718`). The element is written whenever `update_needed`, which includes after a normal plot (`nextdraw.py:415`, `:429-432`). The output SVG always carries plotdata.

### 8.2 Resume by distance

`res_plot`:

1. Read plotdata. If `old.pause_ref >= 0`, `res_plot_options_update` copies old into new and **forces** `model`, `handling`, `reordering`, `random_start`, `auto_rotate` and `hiding` from the file (`plot_status.py:339-352`).
2. The digest is rebuilt deterministically, using the same seed and options, and `digest.crop(old.pause_dist)` is applied (`nextdraw.py:397-398`).
3. `crop` (`nextdrawcore/path_objects.py:695-754`) walks layers and paths summing `path.length()`:
   - A path is skipped whole if `cum + len ≤ dist + min(len/100, 0.001)`. That also clears the layer's `+d` delay, since the resume point is not at the layer start.
   - The first path past the distance is cut part-way along a segment by `crop_by_distance`, which also clears the delay.
   - That layer's `pause` flag is cleared, so it will not pause again.
   - Layers emptied by the crop are deleted.
4. `stats.down_travel_inch = old.pause_dist`, so a later pause accumulates on top of it (`nextdraw.py:407-409`).
5. `plot_document` → `find_home` → if QL[12] is 1, `read_position` recovers XY from QS minus the offsets (§10.3). The first `go_to_position` is a pen-up move from wherever the carriage stopped.

Because resume replans from distance alone, it only works if the planner is deterministic: the same SVG plus the same options must give the same path order and the same lengths. A TS port must keep that property if it is to be compatible with plotdata written by the Python driver.

### 8.3 `--offset_start` versus `res_plot`

| Mode | `dist` semantics | Implementation |
|---|---|---|
| `plot` or `layers` with `offset_start` | Absolute offset from the start, must be ≥ 0 | Synthetic resume: `old.pause_dist = dist`, `old.pause_ref = −1`, `layer_option` 1 or 2, mode becomes `res_plot`. `res_plot_options_update` takes the **else** branch: options come from the user, not the file (`nextdraw.py:336-358`; `plot_status.py:353-361`). |
| `res_plot` with `offset_start` | Relative to the saved `pause_dist`; may be negative; clamped at 0 | `nextdraw.py:360-366` |
| `utility res_adj_in` / `res_adj_mm` | Relative adjustment written into the file without plotting | `ResumeStatus.manage_offset` (`plot_status.py:239-307`). A result ≤ 0 is stored as −1, which means "start from the beginning". |

`parse_dist` accepts `mm`, `cm` and `in` suffixes, and bare numbers in the command's default unit (`plot_status.py:40-61`).

### 8.4 EBB RAM variables (`SL`/`QL`, 8-bit, indices 0–31, volatile, zero on reset)

| Index | Written | Meaning |
|---|---|---|
| 10 | `servo_init` (`pen_handling.py:470`) | Encoded pen-up position: 0 = uninitialized; 1–101 = legacy servo (pos+1); 102–202 = brushless (pos+102) |
| 11 | `pen_handling.py:471` | Encoded pen-down position, same encoding |
| 12 | `set_home` writes 1; power loss, EM re-enable, homing failure and `find_home` mode write 0 | **Homed flag.** Read by `find_home` (`homing.py:106`). |
| 13 | Written as 0 on power loss (`nextdraw.py:919`, `:987`; `serial_utils.py:83`, `:122`) | Power-lost marker. Nothing in 1.7.5 writes 1 or reads it back, so its purpose is unclear. |
| 24–27 | `write_step_offsets` | Motor-1 origin offset, **signed int32 big-endian**, in units of steps × 1000 (`serial_utils.py:232-251`, `ebb3_serial.py:475-528`) |
| 28–31 | | Motor-2 origin offset, same encoding |

### 8.5 Position recovery from QS

`read_position` (`homing.py:577-601`) runs:

1. `exhaust_queue`
2. `QS` → `(a, b)` steps
3. Read the offsets `(oa, ob)` from RAM
4. Convert both with `steps_to_xy_pos(a/1000 …)`:
   ```
   x = (a+b)/(4·native_res_factor)
   y = (a−b)/(4·native_res_factor)
   ```
   multiplied by 2 in low resolution (`homing.py:52-66`)
5. Set `phys = pos − offset`, zero the host accumulators, and send `T3,1,0,0,0,0,0,0,3`

The QS step count is in the current microstep units, which is why low resolution doubles the result.

---

## 9. Pen handling (`pen_handling.py`, `models.py:78-94`)

### 9.1 Servo constants

| | Standard servo (z_motor 0) | Narrow-band brushless (z_motor 1) |
|---|---|---|
| Pin (port B) | 1 | 2 |
| `servo_max` (100 %, up) | 27831 | 12600 |
| `servo_min` (0 %, down) | 9855 | 5400 |
| PWM units | 1/12 MHz ≈ 83.3 ns | same |
| `sweep_time` (ms for 100 %) | 200 | 70 |
| `move_min` (ms) | 45 | 20 |
| `move_slope` (ms per %) | 2.69 | 1.28 |
| `pwm_period` (factor) | 0.24 (8 channels × 3 ms) | 0.03 |
| `SC,8` channels | 8 | 1 |
| Servo timeout | `SR,60000` | none |
| RAM code offset | +1 | +102 |

### 9.2 PWM, rate and timing

```
pwm(pos%)   = round_half_even(servo_min + (servo_max − servo_min)/100 · pos%)  →  SC,4 (up) / SC,5 (down)
rate(r%)    = round_half_even((servo_max − servo_min) · pwm_period / sweep_time · r%)  →  SC,11 (raise) / SC,12 (lower)
d           = |pen_pos_up − pen_pos_down|                                (in %)
t_raise[ms] = trunc( ((move_slope·d + move_min)⁴ + (sweep_time·d/pen_rate_raise)⁴)^(1/4) )
              → 0 if d < 0.9;  then + pen_delay_up;  max(0, ·)
t_lower     = the same with pen_rate_lower and pen_delay_down
```

Sources: `pen_handling.py:422-441` and `:127-160`.

Example with the defaults (brushless, up 60, down 40, raise 75, lower 50): `d = 20`; raise ≈ 45 ms; lower = `trunc((45.6⁴+28⁴)^¼)` = 47 ms; `SC,11` = 231; `SC,12` = 154; `SC,4` = 9720; `SC,5` = 8280.

`t_raise` and `t_lower` are the **duration argument of SP**, so the firmware itself holds the FIFO for that long, and they are added to the preview time estimate.

### 9.3 Flow of `servo_init` (`:343-471`)

1. `heights.update()`. In preview, set `z_up = True` and return.
2. Read QL 10 and 11 and the QG pen bit, and decode them into `init_state = [up, down, z_motor, pen_up]` (`find_pen_state`, `:290-341`).
3. `servo_initialized = (state[0:3] == goal[0:3])`. If true, trust the EBB's pen state.
4. Choose the goal pen state:
   - lower for `utility lower_pen`, for `toggle` when the pen is up, and for `cycle`;
   - raise if not initialized, for `toggle`, or for `raise_pen`;
   - otherwise keep the current state.
5. **Always send:** `SC,11`, `SC,12`, then (if `use_b3_out`) `PO,B,3,0` and `PD,B,3,0`, then `SC,4` and `SC,5`.
6. If initialized and already in the goal state, **return here**. In that case `SC,8`, `SR` and the `SL` writes are skipped.
7. Otherwise send `SP,0` or `SP,1` with the duration and pin (and B3 if used), then `SC,8,1|8`, `SR,60000` (legacy only), `SL,code_up,10` and `SL,code_down,11`.

### 9.4 Raise and lower

`pen_raise` and `pen_lower` skip the command when the cached `phys.z_up` already matches. `pen_lower` also skips when the plot is stopped. Each raise increments `lifts`.

With `use_b3_out`, pin B3 goes high while the pen is down. If `sync_b3` is set, `exhaust_queue` runs before each toggle, which stalls the FIFO at every pen change (`:234-237`, `:264-267`).

### 9.5 Temporary heights

Layer `+h` heights go through `set_temp_height` and `end_temp_height`, which re-run `servo_init` only if the height changes (`:280-288`).

---

## 10. Homing and origin (`homing.py`, MIT)

### 10.1 When homing runs

`find_home()` (`:86-139`):

- Preview → return True.
- `QL,12` true → `read_position()`, return True.
- Auto-home when `options.homing` and `params.auto_home` (models 8–10 only). It fails fast on a `voltage` warning; with `skip_voltage_check` it does its own `QC` check against 200.
- Otherwise there is **no physical homing**. The current position is declared home: `set_home()` = `exhaust_queue`, `CS`, offsets (0,0), `SL,1,12`, `read_position`. This is the AxiDraw behaviour: wherever the carriage is when the machine is not marked homed becomes (0,0).
- On failure `stopped` is set to 105 or 106 and `SL,0,12` is written.

### 10.2 Limit-switch algorithm

Constants: `SPEED_FAST` = 2 in/s, `SPEED_FINE` = 0.25 in/s, `SIDE_DIST` = 6 mm (`:72-75`). All moves are `SM` commands with `time_ms = int(1000·dist/speed)`.

**Limit switch I/O.** The switch is normally closed on pin B1, set up with `PO,B,1,1` and `PD,B,1,1` (input, pulled high). `query_limit_switch` waits for motion with `block()` and then reads `PI,B,1`; 1 means pressed or absent (`:204-225`).

**Hardware stop.** `enable_limit_detection` sends `CU,52,2` (target: bit 1 high) and `CU,51,2` (mask: PB1). The firmware stops motion and flushes the FIFO when the switch trips, and `CU,51,0` clears the condition (`:571-575`).

**`block(timeout)`** (`:156-202`) polls QG every 2 ms (the comment says 10). A button press sends the query `ES` (E-stop) and marks homing paused and failed. **Quirk:** when `timeout_ms` is None, `time_left` is never decremented, so there is no timeout, contrary to the docstring's "1 second".

**`left_until_bump(speed, max_dist)`** (`:243-295`): requires the switch to read 0, disables motor 2 with `EM,res,0` (which also clears the step counter), enables limit detection, and commands `SM` "left by max_dist" using motor 1 only. With one motor, the carriage actually moves diagonally until Y=0, at half the apparent distance. After `block`, it checks `plot_status.limit`, sends `CU,51,0`, and returns `|QS motor-2 steps| / step_scale` as the apparent distance.

**Right-hand-motor (RHM) homing** (`rhm_homing`, `:365-514`):

| Stage | Steps |
|---|---|
| 1 | If the switch already reads 1, skip the coarse move (`first_coarse = 0.05`). Otherwise coarse `left_until_bump(2 in/s, 2·y_max + (x_max − y_max) + 0.5)`, with `first_coarse = apparent/2`. |
| 1C, 2 | `rhm_homing_fine()` = `EM` both motors; right 6 mm at 2 in/s; verify the switch released; left 3.5 mm; verify not pressed; fine `left_until_bump(0.25, 7 mm)`. Run twice; Y counts as zero when `dist ≤ 0.0984` in (2.5 mm), or `< 0.12` if the first run was also close. |
| 2C | If `< 0.15`: a third fine pass must give `≤ 0.12`, or homing fails. |
| 3 | Otherwise a big move right by `y_max − first_coarse − 2.5 mm`, coarse left with `max = 2·(that+0.1)`, then a fine pass and the same acceptance thresholds. |

**Left-hand-motor (LHM) precision stage** (`lhm_homing`, `:516-569`), after `CS`:

1. Both motors on.
2. `SM` motor 1 by 12 mm worth of steps, which moves (6, 6) mm.
3. `SM` motor 2 by −6 mm at fast speed.
4. Check the switch, enable detection, `SM` motor 2 by −12 mm at fine speed until the limit trips.
5. `CU,51,0`, then `SM,(4·t1),s1,−s1` back towards the origin.

Then `set_home()`.

### 10.3 Walking and origin offsets

| Command | Behaviour |
|---|---|
| `walk_x`, `walk_y` (inches) / `walk_mmx`, `walk_mmy` (mm) | `adjust_origin_offset(dx,dy)` adds to the RAM offset (stored as steps×1000), so the logical position drops by d; then `go_to_position(old_xy, ignore_limits)` and `precision_move_to(old_xy)` (`nextdraw.py:545-568`, `homing.py:615-639`). **The carriage moves by d physically while its logical coordinates stay the same, so the plot origin shifts by d for every later plot until `set_home` or `walk_home`.** |
| `walk_home` | Offsets set to (0,0) → `read_position` → pen-up `go_to_position(min(x,0.01), min(y,0.01))` → `precision_move_to(0,0)` (`nextdraw.py:537-543`) |
| `set_home` | Makes the current position the true home and clears the offsets (`homing.py:603-613`) |

**axya impact:** the jog pad's `walk_mm*` commands currently move the origin, not just the pen.

### 10.4 `precision_move_to(x, y, rate=3000)`

`precision_move_to` (`homing.py:659-701`):

1. Compute absolute A/B steps including the offset:
   ```
   a = round(2·native_res_factor·(x+y))
   b = round(2·native_res_factor·(x−y))
   ```
   with x and y halved first in low resolution (`xy_to_step_pos`, `:35-49`).
2. Read QS.
3. If the position differs, send `HM,3000,a,b`.
4. `read_position`.

It is used after every plot to remove the remaining error at the origin. In preview it only estimates time: `max(|Δa|,|Δb|)/3000` s.

---

## 11. Time estimation, preview, and the Python driver as a test oracle

### 11.1 How `--preview` simulates

The preview flag is threaded through many places:

| Area | Behaviour in preview |
|---|---|
| Connection | No `serial_connect` (`nextdraw.py:281-282`); `machine.port` is None, so every `EBBMotionWrap` method returns early. |
| `servo_init` | Sets `z_up = True` and returns before any SC command. |
| `enable_motors` | Skips QG, CU, QE and EM, but still sets `step_scale` and the speeds (`serial_utils.py:184-218`). |
| `find_home` | Returns True with **no** `read_position`, so planning starts from (0,0) with accumulators 0 (`nextdraw.py:210-211`). |
| Pen moves | Add their SP duration to `pt_estimate` (`preview.VelocityChart.rest`, `preview.py:100-112`). |
| Move commands | `feed_sm`/`feed_t3`/`feed_td` add `ms`, `T/25` or `2T/25` to `pt_estimate` and log path data for rendering. The T3/TD strings are still built (`dripfeed.py:195-201`, `:278-285`) but not sent. |
| Pause | `check_button` returns 0 (`plot_status.py:226-227`), but a software pause still works. |
| Final HM | `precision_move_to` adds its time estimate. Page and layer delays add their full value. |

Motion planning itself is identical in preview and on hardware for the same start state. The planner never reads anything from the machine apart from the start position and accumulators.

### 11.2 `--report_time` numbers

`PlotStats.report` (`plot_status.py:420-465`) prints, in preview:

- "Estimated print time" = `pt_estimate`
- "Length of path to draw" = `down_travel_tot`
- "Pen-up travel distance" and "Total movement distance"
- the wall-clock time the estimate took

On hardware it prints "Elapsed time" (wall clock), "Ended at", "Length of path drawn" and "Total distance moved". It optionally prints the lift count (`pen_handling.py:185-189`) and "Document printed from valid Plob digest".

Distances come from `add_dist` on each move's **actual** step distance. Pen-down travel is overwritten by `path.length()` (geometric length) after each completed polyline (`nextdraw.py:889-890`), so the two disagree slightly.

For multiple copies in preview without `random_start`, one page is simulated and the result multiplied, plus the page delays (`:426-434`, `nextdraw.py:373-375`).

The estimate does not include homing, USB latency, `exhaust_queue` waits, or the firmware's per-command overhead.

### 11.3 What `preview.py` renders

`render()` (`preview.py:394-513`) replaces any `% Preview` layer with a new `% Preview` group containing a `Pen-up movement` path and a `Pen-down movement` path:

- `M x y x y …` points at 3 decimal places, in inches, one point per move end.
- A transform undoes the viewBox scaling and the auto-rotation (`find_preview_transform`, `:371-391`).
- Stroke width is `min(w,h)/1000`, with precision chosen so that CSS never sees scientific notation (`:45-80`).
- Colours come from `preview_color_up` and `preview_color_down`; `preview_paths` 0–3 selects which paths are drawn.

With `digest>0` the transform is moved to `data-transform`. Velocity charts exist but are always disabled (`preview.py:149`).

The output is therefore a polyline approximation of each move's end point, not the curved S-curve path between them.

### 11.4 Using the Python driver as a command-stream oracle

**Goal:** record every byte the driver would send for a given SVG and options, without hardware, so that the TS port can be diffed against it.

**Approach A: fake serial port (recommended; full fidelity).** Patch pyserial at the two points where `ebb3_serial` uses it:

- `ebb3_serial.comports` (imported into the module namespace at `plotink/ebb3_serial.py:43`) should return `[("/dev/fake", "EiBotBoard", "USB VID:PID=04D8:FD92")]`.
- `ebb3_serial.serial.Serial` should be a `FakeSerial(port, timeout)` class that implements `write(bytes)`, `readline() -> bytes`, `reset_input_buffer()`, `flush()` and `close()`. These are the only methods `EBB3` calls (`:225-264`, `:312-318`, `:367-373`, `:410-411`, `:94`, `:110-111`, `:189`).

Then drive it through `nextdraw_control.NextDrawWrapperClass` or the Python API's `plot_setup`/`plot_run`, which call `connect()` normally. Everything above the port stays unmodified.

`FakeSerial.write` appends each `\r`-terminated line to a log and queues the matching response. It must answer:

| Sent | Response (`\n`-terminated) | Notes |
|---|---|---|
| `v` (raw, at connect) | `EBBv13_and_above EB Firmware Version 3.0.3` | Must contain `EBB` and parse as at least 3.0.2 (`:228-259`) |
| `CU,10,1` (raw) | any line, for example `CU` | Read and discarded |
| `QT` | `QT,oracle` | Nickname |
| `QG` | `QG,%02X` | Keep bits 0–3 at 0 so that `exhaust_queue` and `block` finish. Set bit 4 (16) from the last `SP` (1 = up). Never set 32, 64 or 128 unless simulating a button, power loss or limit switch. |
| `QC` | `QC,300,900` | The second value must be at least 200 to pass the voltage checks (`ebb3_motion.py:359-379`) |
| `QE` | `QE,a,b` | Track the last `EM`: 1→16, 2→8, 0→0 (`ebb3_motion.py:184`). Initialize to 16,16 to model a machine that has already been enabled; otherwise the run sends `EM`, `SL,0,12` and `CS`. |
| `QL,n` | `QL,<v>` | Keep a 32-byte RAM updated by `SL,v,n`. Preset `[12]=1` to model a homed machine (skips the homing sequence), or leave it 0 and pass `homing=False`, which gives `set_home()`. |
| `QS` | `QS,a,b` | Zero after `CS` or `EM`. For a plot run, `0,0` is enough. For `walk_*` or resume tests, integrate SM/T3/TD/HM with the same `ebb_calc` model. |
| `QU,6` | `QU,0` | Only on pause |
| `PI,B,1` | `PI,0` | Homing only; scripting a limit-switch model is possible but awkward |
| `ES` | `ES,0` | Homing interrupt only |
| any other command | its 1- or 2-letter name (`T3`, `TD`, `SM`, `SP`, `SC`, `SL`, `SR`, `EM`, `CS`, `CU`, `HM`, `PO`, `PD`, `R`, …) | Same prefix rule as `command()` (`:303-321`) |

**Make it deterministic:**

1. Replace `time.sleep` with a virtual clock that advances `time.time()` by the sleep amount. Otherwise each move longer than 50 ms costs real wall time, and the interleaving of button-poll `QG` queries (driven by `time.time()` against `button_interval`, `plot_status.py:229-232`) changes from run to run. Alternatively, drop all `QG` lines before diffing.
2. Fix `random_start` off, or monkeypatch `time.time` so that `rand_seed = int(t·100)` is fixed (`nextdraw.py:688`).
3. Do not pass `--progress`, which adds a preview dry run (§2 step 12).
4. Do not pass `--hiding` unless pyclipper is installed.

**Approach B: preview plus hooks (fast; motion only).** Run with `preview=True` and wrap `dripfeed.feed_t3`, `feed_td` and `feed_sm`, or `motion.compute_segment`, to capture the move tuples: TD and T3 parameters plus each move's `xyz_pos` snapshot (position and accumulators). This gives exactly the motion stream that hardware would get when starting from (0,0) with zero accumulators. It omits the SP/SC/EM/CU/SL/HM traffic and the voltage, QE and homing preamble.

**What to diff:**

1. The digest: layer and path order plus vertices, which can be dumped with `digest.to_plob()` or `digest=2`.
2. The ordered list of `TD`/`T3`/`SM`/`SP`/`HM` lines, compared exactly.
3. Final `phys` and accumulators.
4. `pt_estimate` and distances from a preview run.

Keep golden fixtures small (a few hundred segments) and cover:

- each handling mode, both resolutions, and const-speed mode;
- sharp, obtuse and shallow corners;
- tiny segments at the step threshold;
- every arc flag combination, including radii that are too small;
- `+s`, `+h`, `+d`, `!` and `%` layers;
- reorder modes 0–4;
- a resume crop in the middle of a segment.

Run the Python side from a dedicated virtualenv, never from the vendored tree. This document's analysis did not execute any vendored code.

---

## 12. Porting notes

### 12.1 Riskiest code (most likely sources of subtle bugs)

1. **Firmware arithmetic** (`ebb_calc.move_dist_t3` and `rate_t3`):
   - round-half-away-from-zero (Decimal) versus round-half-even (`round`) versus truncation (`int(a/2)` of a negative number);
   - the "clear accumulator" sign rule;
   - the float `floor(x/2³¹)`;
   - `T==0` returning accumulator 0.

   One wrong rounding spreads into every later segment through `xyz_pos`.
2. **float32 storage** in `motion.py` (`array('f')` at `:180-181`, `:542-545`). Without `Math.fround` at the same points, rates differ by ±1 in the rounding, and TD timings then drift.
3. **Banker's rounding** everywhere `round()` touches steps, rates, jerk, acceleration or PWM.
4. **Axis order and signs:** motor 1 = x+y and motor 2 = x−y. `SM` is `axis1, axis2` even though the wrapper's arguments are named `(delta_x, delta_y)`. Decel S-curves negate `round(jerk)`, not `jerk` before rounding (`motion.py:1039-1040`, `:1066-1067`). `v̂` carries a √2 factor.
5. **Selecting T** by the axis with the larger simulated distance (`motion.py:956-961`), not by `max(t1,t2)`.
6. **Bounds:** three different clamps. Clipping in `prepare_document` (exact); `checkLimitsTol` in `plot_polyline` with tolerance 2e-9 (`nextdraw.py:874-876`); and `compute_segment` with `bounds_tolerance` and a warning. `bounds` itself is padded by 1e-9.
7. **Cubic solver** (`cubic_eqn.py`): returns complex roots as Python `complex`; the port must filter out complex and non-positive roots in exactly the same way (`plan_utils.py:343-347`).
8. **Unbounded loops:** `striangle` has no iteration cap; `homing.block()` with `timeout_ms=None` has no timeout.
9. **Spatial index quirks:** the `if best_index:` treatment of index 0, the restart at (0,0) for each layer, and division by zero when all endpoints are identical.
10. **Layer `+s` up to 110 %** can exceed the 2³¹ rate ceiling at the high-resolution speed cap: `1.1 · 0.9998 · 2³¹`.
11. **Latent dropped-segment bug** in `plan_trajectory` (§5.4 step 3) and case-0 drops (§5.5). Decide whether to keep or fix them, and record the decision in the fixtures.
12. **Config merge:** a shallow `overrides` merge; `offset_start` not propagated from the CLI; `overrides['speed_up']` ignored.
13. **Exit-code semantics:** a programmatic pause is resumable but exits 0. A missing power supply exits 0 having plotted nothing.

### 12.2 Proposed TypeScript modules

| TS module | Ports | Est. LOC |
|---|---|---|
| `driver/config.ts` | `nextdraw_conf` defaults, overrides, option validation and clamping (`update_options`) | 200 |
| `driver/models.ts` | `ZMotor`, `Handler`, `Plotter` tables; `applyModelAndHandling`; `findCurveTolerance` | 180 |
| `driver/svg/path-parse.ts` | `simplepath` + `cubicsuperpath` (including `ArcToPath`) + `simpletransform` + `simplestyle` | 550 |
| `driver/svg/units.ts` | `getLengthInches`, `parseLengthWithUnits`, `unitsToUserUnits`, `vb_scale_2` | 180 |
| `driver/svg/digest.ts` | `DigestSVG.traverse`, shape converters, `inherit_style`, flattening via `subdivideCubicPath`/`four_points_in_tolerance`/bezier split | 550 |
| `driver/digest-model.ts` | `DocDigest`, `LayerItem`, `PathItem`, `LayerProperties`, `crop`, `rotate`, plob I/O, `verify_plob` | 550 |
| `driver/boundsclip.ts` | `clip_at_bounds`, `clip_segment`, `point_in_bounds` | 200 |
| `driver/optimize/{rtree,spatialGrid,optimize}.ts` | Joining, supersampling, `randomize_start` (with a Python-compatible MT19937), reordering | 450 |
| `driver/motion/ebbCalc.ts` | `move_dist_t3` (BigInt), `rate_t3`, `roundHalfEven`, `roundHalfAwayFromZero` | 150 |
| `driver/motion/scurve.ts` | `cubic_eqn`, `scurve_plan`, `scurve_jerk(2)`, `scurve_time`, `striangle`, `calc_jerk` | 300 |
| `driver/motion/planner.ts` | `trajectory`, `plan_trajectory`, `compute_segment`, `compute_subsegment_cmds`, `td/t3_seg_data` | 550 |
| `driver/ebb/transport.ts` | `serialport` line I/O, discovery, handshake, `command`/`query` validation, first-error latch | 300 |
| `driver/ebb/commands.ts` | `ebb3_motion` wrappers, RAM int32 helpers | 200 |
| `driver/machine/{pen,homing,status}.ts` | `PenHandler` + `servo_init`/`revert`; `HomingClass` + offsets + `precision_move_to`; `read_status_byte`, `exhaust_queue`, `enable_motors` | 900 |
| `driver/run/dripfeed.ts` | `feed`, pause check, `SP,3`, sleeps, delays (async/await) | 250 |
| `driver/run/plotdata.ts` | `SVGPlotData`, `ResumeStatus` (read/write/adjust), `DripCache.queued_dist`, `PlotStats` | 400 |
| `driver/run/plot.ts` | `effect()` dispatch, `prepare_document`, `plot_document`, `plot_doc_digest`, `plot_polyline`, `go_to_position`, `pause_check`, utility and setup commands, status codes | 750 |
| `driver/preview.ts` | Time estimate, preview path logging, `% Preview` render, `strip_data` | 250 |
| `driver/warnings.ts` | `PlotWarnings` | 80 |
| *(optional)* `driver/hiding.ts` | `clipping.py` on top of clipper2 | 700 |
| *(test)* `test/oracle/*` | Fake-port harness (Python), fixture runner, diff tooling | 400 |
| **Total** | | **≈ 7 500 core (+ ≈ 1 100 optional and test)** |

### 12.3 Implementation guidance

- **Async boundary.** Python blocks on `readline()` and `sleep()`. In Node, make `command()` and `query()` return promises on a single serialized queue (one outstanding line at a time, as the firmware expects). Turn the host sleeps into `await delay()`, and expose pause as an `AbortSignal`-like flag checked once per move, as `pause_check` does.
- **Keep the planner pure.** Python already separates planning (`motion.*` returns move lists plus `xyz_pos` snapshots) from execution (`dripfeed`). Keep that split, so the planner can be unit-tested and diffed against the oracle with no I/O, and so preview is simply the planner plus the time-summing part of the executor.
- **Compatibility contract with existing files.** Reading and writing `<nd:plotdata>` in the exact format of §8.1, and replanning deterministically, is what lets a plot paused under Python be resumed under TS and the other way round. That is worth supporting during the transition.
- **Legal.** Keep the GPL notices on files derived from `nextdrawcore`, the MIT notices on files derived from `plotink` and `homing.py`, and the GPL notice from `ink_extensions` on the path parser port.
