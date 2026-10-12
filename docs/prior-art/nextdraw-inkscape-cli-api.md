# Bantam NextDraw software 1.7.5: Inkscape extension, CLI and Python API

This is a map of every user-facing option and feature in Bantam Tools' official NextDraw software (version 1.7.5, dated 2026-10-07). axya is going to port the driver from Python to Node, and this document is the reference for reaching feature parity on purpose rather than by accident.

**Sources and citation convention.** Paths in `file:line` citations are relative to `docs/reference-apps/nextdraw-1.7.5/` unless they start with `src/`, `server/` or `docs/`, which are axya paths. The vendored tree contains:

| Prefix | What it is |
|---|---|
| `inkscape-extension/` | Payload of the macOS `NextDrawInstall.app` v1.7.5: `.inx` UI definitions, launchers and helper scripts |
| `nextdraw-api/` | The `nextdraw` pip package: CLI (`nextdraw/nextdraw_cli.py`), Python API (`nextdraw/nextdraw_py.py`), examples and tests |
| `nextdrawcore/` | The shared driver core that every front end calls (`nextdraw.py`, `nextdraw_conf.py`, `nextdraw_options/`, and so on) |
| `plotink/` | Serial and EBB helpers (`ebb3_serial.py`, `ebb3_motion.py`) |

Bantam's prose documentation is "All rights reserved", so this file summarizes it in our own words and links to it: the CLI guide is at <https://bantam.tools/nd_cli/> and the Python guide at <https://bantam.tools/nd_py/>. The legacy Evil Mad Scientist AxiDraw software (`axicli` and the Inkscape driver, v3.9.x, last updated 2024) is used only for the history in §7.

---

## 1. Packaging and installation of the Inkscape extension

### 1.1 Installer

`NextDrawInstall.app` is a [Platypus](https://sveinbjorn.org/platypus) 5.4.1 wrapper (`Contents/Resources/AppSettings.plist` names `Platypus-5.4.1` and `/bin/bash`). Its `Contents/Resources/script` is the same file as `inkscape-extension/installer-script.sh`, and it does three things:

1. It creates `~/Library/Application Support/org.inkscape.Inkscape/config/inkscape/extensions` (`installer-script.sh:6`). This is the per-user extension directory for the sandboxed Inkscape 1.x build on macOS.
2. It copies the whole `payload/` directory into that folder with `cp -R` (`installer-script.sh:8`). Nothing is versioned or uninstalled: files from an older install stay in place unless the new copy overwrites them.
3. It checks that `nextdraw.inx` exists and prints a success or failure message (`installer-script.sh:12-17`). The user then has to restart Inkscape.

### 1.2 Payload layout

| Path in `payload/` | Role |
|---|---|
| `nextdraw.inx` | The main "Bantam Tools NextDraw" dialog (§2.1) |
| `nextdraw_saveplob.inx` | A **save-as output** extension that writes a Plob digest (§2.3) |
| `nextdraw_naming.inx`, `nextdraw_hatch.inx`, `snap_colors.inx`, `nextdraw_disable_xy.inx` | Utilities under *Extensions › Bantam Tools Utilities* |
| `nextdraw_control.py`, `nextdraw_naming.py` | Small launchers (19 lines each) that `subprocess.run` a frozen binary |
| `build_deps/nextdraw_control`, `build_deps/nextdraw_naming` | **PyInstaller** binaries: universal Mach-O (x86_64 + arm64) with `_internal/` holding Python 3.13, `lxml`, `pyclipper`, OpenSSL and `certifi`. These are not vendored in axya. |
| `nextdraw_deps/` | Plain-Python dependencies: `nextdrawcore` 1.7.5 (including `inx_img/` artwork), `plotink` 1.14.3, `ink_extensions` 2.2.0, `ink_extensions_utils`, `pyserial` (`serial/`), `requests`, `urllib3`, `idna`, `certifi`, `charset_normalizer`, `packaging` |
| `snap_colors.py`, `eggbot_hatch.py`, `plot_utils_import.py` | Unfrozen scripts, run with Inkscape's own Python. `plot_utils_import.from_dependency_import` puts `nextdraw_deps/` first on `sys.path` so these bundled copies win over anything else installed (`inkscape-extension/plot_utils_import.py:11-18`). |
| `nextdraw_conf.py` | A copy of the core config file, identical to `nextdrawcore/nextdraw_conf.py` |

### 1.3 How Inkscape runs the extension

```
Inkscape ──writes temp SVG──▶ python nextdraw_control.py --mode=plot --speed_pendown=50 … /tmp/ink_ext_XXXX.svg
                                     │  (launcher, inkscape-extension/nextdraw_control.py:10-12)
                                     ▼
                        build_deps/nextdraw_control <same argv>   (PyInstaller-frozen NextDrawWrapperClass)
                                     │  stdout = whole modified SVG, stderr = messages
                                     ▼
Inkscape ◀── reads stdout as the new document; shows stderr in a "received additional data" dialog
```

- In `nextdraw.inx`, `<script><command location="extensions" interpreter="python">nextdraw_control.py</command></script>` (`nextdraw.inx:541-543`) together with `<dependency type="executable">` (`:6`) tells Inkscape to run the launcher with its bundled Python.
- Inkscape passes every `<param>` as `--name=value`. Notebook params (`mode`, `submode`) receive the `name` of the selected page. The temporary SVG path comes last.
- The launcher forwards argv unchanged to the frozen binary, sends the child's stderr back to stderr, and writes the child's stdout to stdout. The comment at `nextdraw_control.py:18` notes that Inkscape reads the extension's result from stdout.
- Inside the binary, `NextDrawWrapperClass` (an `inkex.Effect`; `nextdrawcore/nextdraw_control.py:38`) parses the options with the same argparse definitions the CLI uses (`nextdrawcore/nextdraw_options/common_options.py:17-227`), plots, and emits the document.
- `ink_extensions_utils.exit_status.run` turns a bare `sys.exit()` into a non-zero exit with a generic error message, so that Inkscape notices failures.

### 1.4 Why `<plotdata>` in the SVG matters

The driver keeps no state between runs: each Apply is a fresh process. Pause and resume work because the driver writes a custom element into the document it returns:

```xml
<nd:plotdata xmlns:nd="https://bantam.tools/nd" application="nextdraw" model="8" handling="1"
   optim="0" auto_rot="1" hiding="0" rand_start="0" rand_seed="…" layer="-1"
   pause_dist="123456" pause_ref="123456" pause_warn="1" plob_version="n/a"/>
```

This element is written at `nextdrawcore/plot_status.py:171-198` and read at `:133-169`. `pause_dist` and `pause_ref` are pen-down distances along the plot in **µm**. On resume (`mode=res_plot`), the driver forces `model`, `handling`, `reordering`, `random_start`, `auto_rotate` and `hiding` back to the values saved in the file (`plot_status.py:339-361`), so the path order replays exactly. It then crops the digest at `pause_dist` (`nextdraw.py:397-398`).

In Inkscape, that element only persists if the user **saves the document** after pausing; the Resume tab text points this out (`nextdraw.inx:94-97`). The CLI has the same requirement: progress is saved only when `--output_file` is given, and axya passes the input path as the output path for this reason (`server/plotter.js`).

`pause_warn` drives a one-time guard. If you start a plain `plot` on a file that holds unfinished pause data, the driver refuses, prints a warning, clears `pause_warn`, and exits without plotting. The next attempt then proceeds (`plot_status.py:309-337`, `nextdraw.py:318-326`). The config key `pause_warning = False` disables this guard, and the `strip_data` utility removes the data.

---

## 2. Inkscape UI reference

### 2.1 `nextdraw.inx`: the main dialog

The top-level notebook param is `mode`. Its page names (`plot`, `res_plot`, `setup`, `options`, `utility`) are the values sent as `--mode`. One checkbox, `preview`, sits outside the notebook and applies to every tab (`nextdraw.inx:528-533`).

Column notes: **CLI** gives the equivalent CLI flag; "conf" means the setting can be made only in the config file, and "GUI" means it exists only in Inkscape. In an Inkscape `optiongroup`, the default is the first `<option>` listed, which is not always the conf-file default.

#### Tab: Plot (`mode=plot`, `nextdraw.inx:11-74`)

| Param | Type | Values / range | Inkscape default | CLI |
|---|---|---|---|---|
| `layer_option` | optiongroup (combo) | `1` plot entire document, `2` plot selected layers | 1 | GUI. Choosing `2` is the same as `-m layers` (`nextdraw.py:377-378`). |
| `layer` | int | 0–1000 | 1 | `-l/--layer` |

Pressing Apply on this tab plots, or previews if `preview` is checked. In 1.7.5 there is no separate Layers tab; layer selection moved into the Plot tab.

#### Tab: Resume (`mode=res_plot`, `:77-108`)

This tab has no params. Apply resumes from the `<plotdata>` saved in the document. The tab text explains that you pause with the hardware button, can change settings while paused, and must save the document before quitting Inkscape.

#### Tab: Setup (`mode=setup`, `:111-167`)

| Param | Type | Values / range | Default | CLI |
|---|---|---|---|---|
| `pen_pos_up` | int slider | 0–100 | 60 | `-u` |
| `pen_pos_down` | int slider | 0–100 | **30** (conf default is 40) | `-d` |
| `setup_type` | optiongroup (radio) | `cycle`, `find_home`, `align` | cycle | Becomes the mode: `-m cycle` / `-m find_home` / `-m align` (`nextdraw.py:271-273`) |

#### Tab: Options (`mode=options`, nested notebook `submode`)

Pressing Apply on any Options sub-tab other than Configuration only shows a reminder that settings apply automatically (`nextdrawcore/nextdraw_control.py:98-104`). The conf key `options_message` turns that reminder off.

**Speed** (`submode=Speed`, `:172-243`)

| Param | Type | Values / range | Default | CLI |
|---|---|---|---|---|
| `handling` | combo | 1 Technical drawing, 2 Handwriting, 3 Sketching, 4 Constant speed | 1 | `-z/--handling` |
| `speed_pendown` | int | 1–100 | **50** (conf: 25) | `-s` |
| `speed_penup` | int | 1–100 | 75 | `-S` |
| `accel` | combo | 50 Standard, 100 Maximum, 75 High, 35 Slow | **50** (conf: 75) | `-a` (any 1–100) |
| `pen_rate_raise` | combo | 100 Maximum, 50 Standard, 25 Slow, 12 Very slow, 6 Dead slow | **100** (conf: 75) | `-R` (any 1–100) |
| `pen_rate_lower` | combo | 50, 100, 25, 12, 6 (same labels) | 50 | `-r` (any 1–100) |

**Copies** (`submode=copies`, `:248-286`)

| Param | Type | Range | Default | CLI |
|---|---|---|---|---|
| `copies` | int | 0–9999 (0 means plot continuously until paused) | 1 | `-c` |
| `page_delay` | int, seconds | 0–3600 | 15 | `-D` |

**Notifications** (`submode=preview`, `:292-339`)

| Param | Type | Default | CLI |
|---|---|---|---|
| `report_time` | bool | false | `-T` |
| `rendering` | bool: draw the simulated pen-up and pen-down paths into the document when previewing | true | `-g/--no_render` inverts it |
| `webhook` | bool: POST when a plot finishes | false | `-W` |
| `webhook_url` | string | empty | `-U` |

**Advanced** (`submode=advanced`, `:342-390`)

| Param | Type | Values | Default | CLI |
|---|---|---|---|---|
| `homing` | bool: automatic homing on supported models | — | true | `-n/--no_homing` inverts it |
| `auto_rotate` | bool: rotate portrait documents 90° | — | true | `-N/--no_rotate` inverts it |
| `random_start` | bool | — | false | `-Y` |
| `hiding` | bool: hidden-line removal (only stroked paths plot) | — | false | `-H` |
| `reordering` | combo | 0 Least, 1 Basic, 2 Full, 4 None | 0 | `-G` |

**Configuration** (`submode=sysinfo`, `:392-450`). Apply on this sub-tab runs `sysinfo`, which includes the online update check (`nextdrawcore/nextdraw_control.py:95-96`).

| Param | Type | Values | Default | CLI |
|---|---|---|---|---|
| `model` | combo | 8, 9, 10, 1, 2, 6, 5, 7, 4, 3 (in that display order; §6) | 8 | `-L` |
| `penlift` | combo | 1 Default for model, 3 Brushless upgrade | 1 | `-q` |
| `port_config` | combo | 1 first located, 2 machine named below, 3 all machines | 1 | `-P` (the CLI also accepts 0) |
| `port` | string: serial port or USB nickname | — | empty | `-p` |

#### Tab: Utility (`mode=utility`, `:452-522`)

| Param | Type | Values | Default | CLI |
|---|---|---|---|---|
| `utility_cmd` | combo | `none`, `walk_x`, `walk_y`, `walk_mmx`, `walk_mmy`, `walk_home`, `set_home`, `raise_pen`, `lower_pen`, `toggle`, `enable_xy`, `disable_xy`, `bootload`, `strip_data`. The `res_adj_mm`, `res_adj_in` and `res_read` options are commented out in the GUI (`:490-494`). | none | `-M` |
| `dist` | float, 3 decimals | −100000 to 100000 | 1.000 | `-w` |

#### Global

| Param | Type | Default | CLI |
|---|---|---|---|
| `preview` | bool: simulate only, with no USB traffic | false | `-v` |

### 2.2 Utility extensions (*Extensions › Bantam Tools Utilities*)

| Extension | Params (name: type = default) | Notes |
|---|---|---|
| **NextDraw Naming** (`nextdraw_naming.inx`) | notebook `mode` ∈ {`list_names`, `write_name`, `about`}; `nickname`: string, max 16 = `East` (`:32`) | Reads or writes the EBB's USB nickname. Names must be 3–16 characters. Writing a name reboots the board, and a firmware update can erase the name. The CLI equivalents are `-M list_names`, `-M read_name`, and `-M write_name<NAME>` (the name is appended directly to the command string; `nextdraw.py:495-516`). |
| **Hatch fill** (`nextdraw_hatch.inx`, runs `eggbot_hatch.py`) | `hatchSpacing`: float 0.001–1000 = 3.0; `units` ∈ {2 px, 3 mm, 4 inch} = px; `hatchAngle`: float −360 to 360 = 45; `crossHatch`: bool = false; `connect_bool`: bool = true; `hatchScope`: float 1.1–5.0 = 3.0; `inset_bool`: bool = true; `inset_dist`: float = 0.5; `tolerance`: float 0.1–100 = 2.0 (`:16-43`) | Edits the document by adding hatch-line paths inside filled shapes. It does not drive the plotter. |
| **Snap Colors to Layers** (`snap_colors.inx`, runs `snap_colors.py` → `nextdrawcore/snap_colors.py`) | `color_1`…`color_8` (colorbuttons: black, red, orange, yellow, green, blue, purple, brown), `layer_1`…`layer_8` (`1-black` … `8-brown`), `enable_1`…`enable_8` = true, `snap_layers` = true | Snaps each stroke color to the nearest enabled palette color, and can move each object into the matching numbered layer. This prepares files for `layers` mode, one pen per layer. |
| **Disable XY Motors** (`nextdraw_disable_xy.inx`) | hidden: `mode=utility`, `utility_cmd=disable_xy`, `model=0` | A one-click shortcut. |

### 2.3 Plob export (`nextdraw_saveplob.inx`)

This is an Inkscape **output** extension, so it appears under *Save a Copy* as "NextDraw Plob Plot Digest (\*.svg)" (`:104-110`). It has a hidden `digest=2` (`:9`) and visible `model` (with `0 = - Select -`), `mode` ∈ {`plot`, `layers`}, `layer`, `reordering`, `auto_rotate`, `random_start` and `hiding` (`:17-54`). A Plob is tied to one model and one software version (§3.6).

---

## 3. The CLI (`nextdraw`)

The entry point is `nextdraw_CLI()` (`nextdraw-api/nextdraw/nextdraw_cli.py:90`). The pip package registers no console script; it is run as `python -m nextdraw` (`nextdraw/__main__.py`) or `python nextdraw.py`.

### 3.1 Flags

| Short | Long | Arg | Maps to option | Notes |
|---|---|---|---|---|
| (positional) | `svg_in` | file | — | Not needed for trivial modes (§3.3). `-` or no argument means stdin, which is rejected if stdin is a TTY (`utils.py:34-42`). |
| `-f` | `--config` | path | — | Python config file (§3.4) |
| `-m` | `--mode` | name | `mode` | §3.2 |
| `-s` | `--speed_pendown` | int 1–100 | `speed_pendown` | Clamped by `update_options` (`nextdraw.py:184-193`) |
| `-S` | `--speed_penup` | int 1–100 | `speed_penup` | |
| `-a` | `--accel` | int 1–100 | `accel` | |
| `-d` | `--pen_pos_down` | int 0–100 | `pen_pos_down` | |
| `-u` | `--pen_pos_up` | int 0–100 | `pen_pos_up` | |
| `-r` | `--pen_rate_lower` | int 1–100 | `pen_rate_lower` | |
| `-R` | `--pen_rate_raise` | int 1–100 | `pen_rate_raise` | |
| `-N` | `--no_rotate` | flag | `auto_rotate=False` | |
| `-n` | `--no_homing` | flag | `homing=False` | |
| `-T` | `--report_time` | flag | `report_time` | §3.7 |
| `-M` | `--utility_cmd` | name | `utility_cmd` | §3.3 |
| `-z` | `--handling` | int 1–4 | `handling` | **In axicli, `-z` meant `--pen_delay_down`.** |
| `-w` | `--dist` | string | `dist` | Accepts the unit suffixes `in`, `mm` and `cm`. A bare number uses the command's native unit (`plot_status.py:40-61`). |
| — | `--offset_start` | flag | `offset_start` | New in 1.7. See the caveat in §3.4. |
| `-l` | `--layer` | int | `layer` | Help text says 1–1000; the GUI allows 0. |
| `-c` | `--copies` | int 0–9999 | `copies` | 0 means continuous |
| `-D` | `--page_delay` | int seconds | `page_delay` | |
| `-v` | `--preview` | flag | `preview` | |
| `-g` | `--no_render` | flag | `rendering=False` | **In axicli, `-g` was `--rendering N`.** |
| `-G` | `--reordering` | int 0–4 | `reordering` | 3 is deprecated and behaves like 2 (`plot_optimizations.py:84`) |
| `-Y` | `--random_start` | flag | `random_start` | |
| `-H` | `--hiding` | flag | `hiding` | |
| `-L` | `--model` | int 1–10 | `model` | |
| `-q` | `--penlift` | int 1 or 3 | `penlift` | |
| `-p` | `--port` | string | `port` | A port path or USB nickname |
| `-P` | `--port_config` | int 0–3 | `port_config` | 3 plots to every machine found |
| `-o` | `--output_file` | path | — | §3.5 |
| `-O` | `--digest` | int 0–2 | `digest` | §3.6 |
| `-W` | `--webhook` | flag | `webhook` | |
| `-U` | `--webhook_url` | URL | `webhook_url` | `https://` is prepended if no scheme is given (`nextdraw.py:767-769`) |
| — | `--version` | flag | — | Prints the CLI and core versions and exits (`utils.py:25-32`) |
| `-b` | `--progress` | flag | `progress` | tqdm progress bar on stderr (§3.7) |

Flag arguments (`store_true`) are set to `None` when absent so that they don't override the config (`nextdraw_cli.py:268-272`). A consequence is that a flag can turn an option on but never off. To force `report_time=False` when the config file says `True`, you have to use a second config file. The `no_*` flags work the other way round: they can only turn an option off.

### 3.2 Modes

| Mode | Needs SVG? | Needs USB? | Effect | Code |
|---|---|---|---|---|
| `plot` (default) | yes | yes, unless previewing | Parse → digest → optimize → plot all visible layers | `nextdraw.py:368-427` |
| `layers` | yes | yes, unless previewing | Same as `plot`, but only top-level layers whose names start with the number given by `--layer` | `:380-381` |
| `res_plot` | yes, with `<plotdata>` | yes | Resume from the saved `pause_dist`. Forces copies=1, and forces `port_config` 3 down to 1. | `:268-269, 309-320`; `nextdraw_control.py:125-127` |
| `align` | no | yes | Raise the pen and disable the XY motors | `:452-454` |
| `cycle` | no | yes | Lower the pen, wait 500 ms, raise it | `:455-456`, `pen_handling.py:270-278` |
| `toggle` | no | yes | Flip the pen state. `-M toggle` is rewritten to this mode. | `:275-276` |
| `find_home` | no | yes | Run the automatic homing sequence. If homing is disabled or the model has none, print a message instead. | `:457-468` |
| `utility` | only for `strip_data` and `res_*` | most commands | Run `--utility_cmd` | `:245-266, 470-568` |
| `sysinfo` | no | optional | Software version and online update check, EBB firmware version and update check, Python version, input voltage and motor current | `nextdraw_options/versions.py:188-213` |
| `version` | no | no | Print the core version string | `:241-243` |
| `setup` | no | yes | GUI alias: becomes `setup_type` | `:271-273` |
| `options`, `timing` | — | — | GUI-only no-ops | `:237-240` |

Preview (`-v`) disables all serial traffic. Setup and utility commands answer "Command unavailable while in preview mode." (`:443-445, 476-478`).

### 3.3 Utility commands (`-m utility -M <cmd>`)

| `utility_cmd` | SVG? | Effect | `dist` unit |
|---|---|---|---|
| `read_name` (default) | no | Print the EBB nickname | — |
| `list_names` | no | List the nickname or port of every EBB on USB, without opening a regular session (`:258-266`) | — |
| `write_name<NAME>` | no | Write a nickname of up to 16 characters (an empty name clears it), soft-reset and reboot the EBB (`:495-516`) | — |
| `raise_pen` / `lower_pen` | no | Initialize the servo to the up or down position | — |
| `toggle` | no | Becomes the `toggle` mode | — |
| `enable_xy` / `disable_xy` | no | Energize or release the steppers | — |
| `walk_x` / `walk_y` | no | Relative move. **Since 1.4.6 the walk shifts the stored origin offset**, so later plots start from the walked position (`nextdraw.py:528-568`, `homing.py:615-639`; changelog 1.4.6 §2). Runs auto-homing first if the machine isn't homed. | inches |
| `walk_mmx` / `walk_mmy` | no | Same, in millimetres | mm |
| `walk_home` | no | Clear the origin offset, read the step counter, and move to the true Home (`:537-546`). **It does not use the SVG.** | — |
| `set_home` | no | Make the current position Home: zero the step counter and offsets and mark the machine as homed (`homing.py:603-613`) | — |
| `res_read` | yes | Report the resume position stored in the file (`plot_status.py:239-307`). In the Python API, sets `res_dist` in mm. | — |
| `res_adj_in` / `res_adj_mm` | yes plus `-o` | Shift the stored resume position. Deprecated in favour of `--offset_start`. | in / mm |
| `strip_data` | yes plus `-o` | Remove `<plotdata>` and the `% Preview` layers (`preview.py:515+`) | — |
| `bootload` | no | Put the EBB into bootloader mode for firmware updates (`:479-490`) | — |
| `none` | — | No-op (GUI default) | — |

Important for axya: **the CLI does not need an input file for any utility command except `strip_data` and the `res_*` commands.** When none is given, it substitutes a built-in A4 SVG (`nextdraw_cli.py:296-340`). This means `server/plotter.js`'s `/tmp/axya-dummy.svg` is unnecessary. Also, because `walk_home` reads the EBB step counter rather than the file, axya's "No file to home from" guard is stricter than it needs to be.

### 3.4 `--config` mechanics and precedence

- `utils.load_configs([args.config, 'nextdrawcore.nextdraw_conf'])` loads the **packaged defaults first and then the user file** with `runpy.run_path`, so the user file can be partial. Keys starting with `_` are dropped (`utils.py:70-114`). The file is **executed as Python**, which is why axya allowlists keys before writing it.
- The merged dict becomes `params`, which includes every secondary parameter and `overrides`. CLI values are then applied over the merged config, but only for the 30 names in `OPTION_NAMES` (`utils.py:10-15, 116-132`).
- The resulting precedence, highest first: **layer-name codes in the SVG**, then **CLI flags**, then **the `--config` file**, then **the packaged `nextdraw_conf.py`**. Bantam's [setting-options section](https://bantam.tools/nd_cli/#setting-options) describes the same order.
- A missing `.py` file prints an error and exits 1, and so does a syntax error. A name without `.py` is tried as a module (`utils.py:83-112`).
- **Settable from the CLI:** the 30 `OPTION_NAMES`. **Config file only:** everything else in §5, including `pen_delay_up/down`, `min_gap`, `clip_to_page`, `preview_paths`, `servo_timeout`, `use_b3_out`, `overrides`, and so on. **Settable from either:** all of the above.
- **Caveat on `offset_start` in 1.7.5:** `offset_start` is not in `OPTION_NAMES`, and `NextDrawWrapperClass.plot_to_nextdraw` doesn't forward it (`nextdrawcore/nextdraw_control.py:206-212`). As far as the source shows, the `--offset_start` flag never reaches the core; only `offset_start = True` in a config file takes effect. Verify this on hardware before relying on the flag.

### 3.5 `--output_file` and document output

- When `-o` is given, the CLI writes the result document if it differs from the input (`nextdraw_cli.py:352-353`, `utils.py:52-65`). That document is the original SVG plus `<plotdata>`, plus `% Preview` layers when previewing with rendering on. When `digest>0`, the Plob is written instead.
- The driver always reverts its in-memory working copy before saving (`plot_cleanup`, `nextdraw.py:728-745`), so reordering, rotation and similar changes never leak into the saved file.
- Nothing goes to stdout without `-o`. The CLI path never sets `always_output`, so the CLI cannot be used as a stdin-to-stdout filter. The Inkscape path does emit the document on stdout.
- If `-o` is given in a trivial mode, an input file becomes mandatory.

### 3.6 Plob digest (`-O/--digest`)

| Value | Behaviour |
|---|---|
| 0 | Normal |
| 1 | Plot or preview normally, but save the **Plob** instead of the full SVG as the output |
| 2 | Don't plot or preview; just generate and save the Plob. This forces `preview=True`, so no USB traffic (`nextdraw.py:278-279, 390-395`). |

A Plob is a flattened, unstyled SVG subset (`path_objects.py:551, 604`; `PLOB_VERSION = "1"` at `:60`). It has been clipped, rotated, joined, randomized and reordered, and it records the model it was made for. When the plotted file is a valid Plob for the current model and bounds (`digest_svg.verify_plob`, `:840`), all preprocessing is skipped (`nextdraw.py:609-618`). This is mainly useful for very large files and for resuming them repeatedly.

### 3.7 Exit codes, status codes and console output

**Exit code.** The process exits 1 when `status_code >= 100` (`nextdraw_cli.py:355-356`), and also when the config file fails to load or the input file is missing. Every other outcome exits 0. That includes **the pause-warning refusal**, **a programmatic `!` layer pause** (status 1), and **"ended between copies"** (status 2).

**Status codes** (`plot_status.stopped` internally; `errors.code` in Python):

| Code | Meaning | Resumable | Set at |
|---|---|---|---|
| 0 | Finished normally | — | |
| 1 | Programmatic pause (layer name starting with `!`) | yes | `nextdraw.py:826-832` |
| 2 | Stopped during the page delay between copies | n/a | `:912-913, 952-953` |
| 101 | Failed to connect | n/a | `:973-979` |
| 102 | Paused by the hardware button | yes | `:941-949` |
| 103 | Paused by keyboard interrupt. **SIGINT and SIGTERM** both count (`nextdraw_control.py:77-78`). | yes | `:911-912` |
| 104 | USB connection lost | yes, with care | `:931-937` |
| 105 | Power loss detected | no (homing lost) | `:915-919`, `homing.py:147` |
| 106 | Automatic homing failed | — | `homing.py:149` |

**Messages** that a wrapper can match (exact strings from source):

| When | Text |
|---|---|
| Any resumable pause (1, 102, 103) | `Use the resume feature to continue.` and `(Paused after: N mm of pen-down travel.)` (`nextdraw.py:954-964`) |
| USB lost | `Error: USB connection lost during plot. [Position: N mm]` |
| No device | `Failed to connect to <model name>.` (`serial_utils.py:50-56`). With `-P3` and no device: `No available nextdraw units found on USB.` |
| Firmware too old (below EBB 3.0.2) | `Firmware version (x) not supported.` plus an update link (`plotink/ebb3_serial.py:50, 254-257`) |
| Pause-warning refusal | `This document looks like it was paused while plotting.` |
| Warnings (`plot_warnings.py`) | `Warning (bounds)`, `Note (voltage)`, `Note (image)`, `Note (plain-text)`, unknown-element notes, `Automatic homing failed with an apparent power issue.` |

**`--report_time`** (`plot_status.py:420-465`). When previewing:
```
Estimated print time: H:MM:SS[, including page delays of …]
Length of path to draw: X.XXX m
Pen-up travel distance: X.XXX m
Total movement distance: X.XXX m
This estimate took …
```
When plotting:
```
Elapsed time: …
Ended at: YYYY-MM-DD, HH:MM:SS
Length of path drawn: X.XX m
Total distance moved: X.XX m
```
With `report_lifts=True` it also prints `Number of pen lifts: N`. During `res_plot`, distances are measured from the **start of the document**, not from the resume point.

**`--progress`** (`plot_status.py:468-629`) runs only from the CLI, only when not previewing, and only in plot, layers or res_plot mode. It first does a dry-run preview to size the bar and prints `Estimated print time: …`. It then shows a tqdm bar on stderr, labelled `Plot Progress`, or `Copy n of N` or `Copy number n` when plotting copies. Its units are **mm of total travel**. On resume, the bar starts at the resume point. Separate `Page delay …` and `Layer delay` bars appear for delays of 1 s or more. On normal completion it prints `NextDraw plot complete.`.

### 3.8 Layer-name control codes (part of the SVG contract)

These are parsed in `path_objects.py:311-355` and applied in `nextdraw.py:822-847`. They take precedence over CLI and config values.

| Syntax | Meaning |
|---|---|
| `%name` | Documentation layer; never plotted |
| `!…` | Pause before this layer starts (status 1) |
| leading integer | Layer number used for `layers` mode matching |
| `+d<ms>` | Delay at the start of the layer |
| `+h<0-100>` | Pen-down height for this layer |
| `+s<1-110>` | Pen-down speed for this layer |
| `+m<1-4>` | Handling mode for this layer. Only the curve tolerance changes (`digest_svg.py:539-547`). |
| `+g<0-4>` | Reordering for this layer (`plot_optimizations.py:99-105, 303-309`) |

Only top-level Inkscape layers (`<g inkscape:groupmode="layer">`) count; sublayers don't. Bantam's guide is "NextDraw Layer Control" on support.bantamtools.com.

### 3.9 Multiple machines

- `port_config 0` uses `--port` if given and the first EBB otherwise. `1` always uses the first EBB. `2` requires `--port`. `3` plots the same document to every EBB at once using threads (`nextdraw_control.py:107-185`).
- With `-P3`, non-error output from the secondary units is suppressed, and pause/resume is only partly supported. Bantam's [multiple-units section](https://bantam.tools/nd_cli/#multiple-nextdraw-units) recommends running one process per `--port` when you need full control.

---

## 4. Python API (`from nextdraw import NextDraw`)

The class is `NextDraw` in `nextdraw-api/nextdraw/nextdraw_py.py:86`, which extends `nextdrawcore.nextdraw.NextDraw`. Options are set as `nd.options.<name>` and config-only parameters as `nd.params.<name>`. `nd.load_config(path)` applies a config file in either context (`:240-254`).

### 4.1 Plot context

| Call / variable | Meaning |
|---|---|
| `plot_setup(svg_input=None)` | Accepts a file path **or an SVG string**. With no argument, uses a blank document for utility-style runs (`:169-202`). |
| `plot_run(output=False)` | Runs `effect()`. With `output=True`, returns the result SVG as a string (`:204-238`). |
| `time_estimate` | Seconds. The preview estimate when previewing; otherwise the actual elapsed time. |
| `time_elapsed` | Wall-clock seconds spent in `plot_run` |
| `distance_pendown`, `distance_total` | **Metres** (`:229-231`) |
| `pen_lifts` | Number of pen lifts |
| `fw_version_string`, `nickname` | Available after `plot_run` |
| `res_dist` | mm, after `res_read` / `res_adj_*` |
| `name_list` | After `list_names` |
| `version_string` | Software version |

A Python script can also plot copies, use `layers` mode, call utilities, and so on, through the same `options.mode` and `options.utility_cmd` used by the CLI. The examples are in `nextdraw-api/examples_py_nextdraw/`: `plot.py`, `plot_inline.py`, `estimate_time.py` and `toggle.py`.

### 4.2 Interactive context

| Call | Meaning | Code |
|---|---|---|
| `interactive()` | Enter the interactive context. Sets units to inches. | `:256-263` |
| `connect()` | Open USB, initialize the servo, raise the pen, enable the motors, and **auto-home** if supported. Returns True, False or None. | `:124-167` |
| `disconnect()` | Drain the motion queue and close the port | `nextdrawcore/nextdraw.py:1019` |
| `update()` | Apply changed options (speeds, heights, units) after connecting | `:288-295` |
| `goto(x,y)` / `moveto(x,y)` / `lineto(x,y)` | Absolute move: pen state unchanged, pen up, or pen down | `:449-464` |
| `go(dx,dy)` / `move(dx,dy)` / `line(dx,dy)` | Relative versions of the same | `:466-481` |
| `penup()` / `pendown()` | `pendown` does nothing when the turtle is out of bounds and `auto_clip_lift` is set | `:483-499` |
| `draw_path([[x,y],…])` | Plan and plot a whole polyline with lookahead, clipped to travel | `:366-419` |
| `delay(ms)`, `block()` | Queue a timed pause; wait until motion finishes | `:297-306, 513-517` |
| `usb_command(cmd)`, `usb_query(q)` | Send raw EBB commands, e.g. `QS` for step position or `HM,3200` | `:501-511` |
| `current_pos()`, `current_pen()` | Last known **physical** position and pen state | `:532-543` |
| `turtle_pos()`, `turtle_pen()` | **Commanded** position and pen state; these can be outside the travel area | `:519-530` |
| `options.units` | 0 inch (default), 1 cm, 2 mm. Cannot be set from a config file. | `:321-326` |
| `connected` | Bool | |

Moves outside the model's travel area are clipped. Unless `auto_clip_lift=False`, the pen lifts over the clipped part (`:308-364`).

### 4.3 Error handling

`nd.errors` is an `ErrConfig` (`:74-83`) with the boolean switches `connect`, `button`, `keyboard`, `disconnect`, `power` and `homing`. Each one, when set, raises `RuntimeError` for its condition (`handle_errors`, `:421-447`). `nd.errors.code` always holds the last status code from §3.7.

`nd.keyboard_pause = True` makes Ctrl-C trigger a graceful, resumable pause (code 103) instead of a `KeyboardInterrupt`. A threaded script can trigger the same pause by calling `nd.transmit_pause_request()` (`:106-122`). Calling interactive methods before `connect()` always raises.

---

## 5. Configuration parameters (`nextdrawcore/nextdraw_conf.py`)

**Where each parameter can be set:** "CLI" means a CLI flag exists, "Ink" means an Inkscape control exists, "Py" means it can be set as `options.X` in Python, and "conf/params" means config file or `params.X` only.

| Parameter | Default | Range / values | Meaning | Settable from | Line |
|---|---|---|---|---|---|
| `mode` | `'plot'` | §3.2 | Operating mode | CLI, Ink (tab), Py | 30 |
| `handling` | 1 | 1–4 | Handling mode (§6.2) | CLI, Ink, Py | 32 |
| `speed_pendown` | 25 | 1–100 | Pen-down speed, as a percentage of the handling mode's limit | CLI, Ink, Py | 38 |
| `speed_penup` | 75 | 1–100 | Pen-up speed, as a percentage | CLI, Ink, Py | 39 |
| `accel` | 75 | 1–100 | Acceleration factor | CLI, Ink, Py | 40 |
| `pen_pos_up` | 60 | 0–100 | Servo height when up | CLI, Ink, Py | 42 |
| `pen_pos_down` | 40 | 0–100 | Servo height when down | CLI, Ink, Py | 43 |
| `pen_rate_raise` | 75 | 1–100 | Raise speed | CLI, Ink, Py | 45 |
| `pen_rate_lower` | 50 | 1–100 | Lower speed | CLI, Ink, Py | 46 |
| `report_time` | False | bool | Print time and distance (§3.7) | CLI, Ink, Py | 48 |
| `default_layer` | 1 | 1–1000 | Default for `layer` | CLI (`-l`), Ink, Py (`options.layer`) | 50 |
| `utility_cmd` | `'read_name'` | §3.3 | Utility command | CLI, Ink, Py | 52 |
| `dist` | 1.0 | number or string with a unit | Walk distance or offset | CLI, Ink, Py | 55 |
| `offset_start` | False | bool | Start at `dist` (§3.4 caveat) | conf/params (the CLI flag appears not to be forwarded), Py | 58 |
| `copies` | 1 | 0–9999 | 0 means continuous | CLI, Ink, Py | 63 |
| `page_delay` | 15 | ≥0 s | Delay between copies | CLI, Ink, Py | 64 |
| `preview` | False | bool | Simulate only | CLI, Ink, Py | 66 |
| `rendering` | True | bool | Draw preview paths into the output SVG | CLI (`-g` off only), Ink, Py | 67 |
| `model` | 8 | 1–10 | §6.1 | CLI, Ink, Py | 70 |
| `penlift` | 1 | 1, 2, 3 | 1 or 2 use the model default; 3 selects the brushless servo | CLI, Ink, Py | 79 |
| `port` | None | string | Port path or nickname | CLI, Ink, Py | 83 |
| `port_config` | 0 | 0–3 (the comment says 0–2) | §3.9 | CLI, Ink, Py | 86 |
| `homing` | True | bool | Enable auto-homing | CLI (`-n` off only), Ink, Py | 91 |
| `auto_rotate` | True | bool | Rotate portrait pages | CLI (`-N` off only), Ink, Py | 93 |
| `reordering` | 0 | 0, 1, 2, 4 (3 behaves as 2) | Path optimization | CLI, Ink, Py | 96 |
| `random_start` | False | bool | Randomize where closed paths start | CLI, Ink, Py | 102 |
| `hiding` | False | bool | Hidden-line removal | CLI, Ink, Py | 104 |
| `webhook` | False | bool | POST on completion | CLI, Ink, Py | 106 |
| `webhook_url` | None | URL | Webhook target | CLI, Ink, Py | 109 |
| `digest` | 0 | 0–2 | Plob output (§3.6) | CLI, Py (Inkscape only via the Plob export) | 111 |
| `progress` | False | bool | CLI progress bar | CLI | 116 |
| `pause_warning` | True | bool | Refuse a fresh plot of a paused file, once | conf/params | 125 |
| `servo_timeout` | 60000 | ms | Power down the standard servo after this idle time (EBB v2.5+ hardware, pin 1 only) | conf/params | 129 |
| `check_updates` | True | bool | Allow `sysinfo` to fetch `https://bantam.tools/nd_version.txt` (`versions.py:61`) | conf/params | 134 |
| `use_b3_out` | False | bool | Drive EBB pin B3 high while the pen is down (for a laser, valve and so on) | conf/params | 138 |
| `sync_b3` | True | bool | Drain the motion queue before toggling B3 | conf/params | 142 |
| `auto_rotate_ccw` | True | bool | Rotation direction | conf/params | 147 |
| `options_message` | True | bool | Show the Inkscape reminder on Options-tab Apply | conf | 150 |
| `report_lifts` | False | bool | Add the pen-lift count to the report | conf/params | 157 |
| `auto_clip_lift` | True | bool | In interactive mode, lift the pen over clipped segments | conf/params | 159 |
| `preview_paths` | 3 | 0–3 | Render none, pen-down only, pen-up only, or both | conf/params | 162 |
| `preview_color_up` | `'LightPink'` | CSS color | Preview pen-up color | conf/params | 170 |
| `preview_color_down` | `'Blue'` | CSS color | Preview pen-down color | conf/params | 171 |
| `skip_voltage_check` | False | bool | Skip the EBB power check (breaks auto-homing) | conf/params | 173 |
| `clip_to_page` | True | bool | Clip to the SVG page as well as to travel | conf/params | 176 |
| `min_gap` | 0.006 | inches; <0 disables | Join pen-up gaps shorter than this | conf/params | 178 |
| `pen_delay_up` | 0 | ms | Extra delay after raising the pen | conf/params | 183 |
| `pen_delay_down` | 0 | ms | Extra delay after lowering the pen | conf/params | 184 |
| `overrides['model_name']` | None | string | Replace the human-readable model name | conf/params | 214 |
| `overrides['travel_x']` / `['travel_y']` | None | inches | Custom travel area | conf/params | 215-216 |
| `overrides['jerk_pen_up']` | None | in/s³ | Pen-up jerk | conf/params | 217 |
| `overrides['jerk_pen_down']` | None | in/s³ | Pen-down jerk | conf/params | 218 |
| `overrides['speed_limit']` | None | in/s | Pen-down speed limit | conf/params | 219 |
| `overrides['speed_up']` | None | in/s | Pen-up speed limit. **Listed in the file but never applied** by `apply_model_and_handling` (`models.py:299-320`). | conf/params | 220 |
| `overrides['auto_home']` | None | bool | Whether the model supports homing | conf/params | 221 |
| `overrides['z_motor']` | None | 0 or 1 | Servo type | conf/params | 222 |
| `overrides['servo_pin']` | None | EBB port-B pin | Servo output pin | conf/params | 223 |
| `overrides['servo_max']` / `['servo_min']` | None | units of 83.3 ns | Pulse widths at 100% and 0% | conf/params | 224-225 |
| `overrides['servo_sweep_time']` | None | ms | Time for a full sweep | conf/params | 226 |
| `overrides['servo_move_min']` / `['servo_move_slope']` | None | ms, ms per % | Timing model for pen moves | conf/params | 227-228 |
| `overrides['resolution']` | None | 1 high (2874 steps/in), 2 low (1437 steps/in) | Microstepping | conf/params | 229 |
| `overrides['curve_tolerance']` | None | inches | Curve flattening tolerance | conf/params | 230 |
| `overrides['const_speed']` | None | bool | Constant speed with the pen down | conf/params | 231 |
| `native_res_factor` | 1016.0 | steps per inch | Motor scaling | conf/params | 237 |
| `max_step_rate` | 24.995 | steps per ms | EBB limit | conf/params | 242 |
| `speed_lim_xy_lr` / `speed_lim_xy_hr` | 17.3958 / 8.6979 | in/s | Speed caps per resolution | conf/params | 246-247 |
| `button_interval` | 0.05 | s | Pause-button polling interval | conf/params | 250 |
| `bounds_tolerance` | 0.003 | inches | How far out of bounds is tolerated before the warning | conf/params | 252 |

Setting top-level `resolution`, `const_speed`, `speed_limit` and similar keys **has no effect**, because `handling` overwrites them every run. They can only be changed through `overrides` (`models.py:274-320`).

---

## 6. Models and handling modes

### 6.1 Models (`nextdraw_options/models.py:135-227`)

| `model` | Name | Travel X × Y (in) | Travel (mm) | Auto-home | Pen-lift | Pen-down jerk derate | Visible effect |
|---|---|---|---|---|---|---|---|
| 1 | AxiDraw V3 or SE/A4 | 11.81 × 8.58 | 300 × 218 | no | standard servo | 1.0 | A4 / Letter |
| 2 | AxiDraw V3/A3 or SE/A3 | 16.93 × 11.69 | 430 × 297 | no | standard | 0.9 | A3 / Tabloid |
| 3 | AxiDraw V3 XLX | 23.42 × 8.58 | 595 × 218 | no | standard | 1.0 | Long and narrow |
| 4 | AxiDraw MiniKit | 6.30 × 4.00 | 160 × 102 | no | standard | 0.6 | Small, gentler motion |
| 5 | AxiDraw SE/A1 | 34.02 × 23.39 | 864 × 594 | no | standard | 0.6 | A1, softer pen-down jerk |
| 6 | AxiDraw SE/A2 | 23.39 × 17.01 | 594 × 432 | no | standard | 0.7 | A2 |
| 7 | AxiDraw V3/B6 | 7.48 × 5.51 | 190 × 140 | no | standard | 1.0 | Small |
| 8 | **NextDraw 8511** (default) | 11.81 × 8.58 | 300 × 218 | **yes** | brushless | 1.0 | Auto-homes at plot start |
| 9 | NextDraw 1117 | 16.93 × 11.69 | 430 × 297 | yes | brushless | 0.9 | |
| 10 | NextDraw 2234 | 34.02 × 23.39 | 864 × 594 | yes | brushless | 0.6 | |

Servo profiles (`models.py:78-94`): the standard servo uses pin B1, pulse widths 9855–27831, a 200 ms sweep, and timing of 45 ms + 2.69 ms per %. The brushless servo uses pin B2, pulse widths 5400–12600, a 70 ms sweep, and 20 ms + 1.28 ms per %. `penlift=3` forces the brushless profile on any model.

The model also sets the clipping bounds, so choosing the wrong model triggers the `bounds` warning and clips the plot. It is also written into `<plotdata>` and into Plobs.

### 6.2 Handling modes (`models.py:97-131`)

| `handling` | Name | Resolution | Pen-down jerk (in/s³) | Speed cap down / up (in/s) | Curve tolerance (in) | Visible effect |
|---|---|---|---|---|---|---|
| 1 | Technical drawing | high (2874 steps/in) | 20000 | 8.70 / 8.70 | 0.002 | Most precise; the default |
| 2 | Handwriting | low (1437) | 90000 | 7 / 12 | 0.008 | Very high jerk: fast on short strokes, coarser curves |
| 3 | Sketching | low | 14000 | 12 / 12 | 0.005 | Fastest top speed, smoother acceleration |
| 4 | Constant speed | high | 0, which means **constant velocity** | 3.0 / 8.70 | 0.002 | No acceleration with the pen down. Even ink for brushes and fountain pens. |

Pen-down jerk is multiplied by the model's derate factor. `speed_pendown` and `speed_penup` are percentages **of these caps**, so "50%" means something different in each handling mode.

---

## 7. Migrating from axicli / AxiDraw software to nextdraw

| Area | AxiDraw (axicli 3.9) | NextDraw 1.x |
|---|---|---|
| Command, package | `axicli`, `pyaxidraw` (`from pyaxidraw import axidraw`) | `nextdraw` (no console script; `python -m nextdraw`), `from nextdraw import NextDraw` |
| Config | `axidraw_conf.py` | `nextdraw_conf.py`, which drops many flat parameters (see below) |
| Speed and resolution | `const_speed` (`-C`), `resolution` 1/2, `accel_rate`, `cornering`, `time_slice` and so on as flat conf keys | Replaced by **`handling` 1–4**. `resolution`, `const_speed` and `curve_tolerance` are only reachable through `overrides`. Setting them at top level is silently ignored. |
| `-z` / `-Z` | `--pen_delay_down` / `--pen_delay_up` | `-z` is now **`--handling`**. Pen delays are **config-only**. Old scripts that pass `-z 100` silently get an invalid handling mode. |
| `-g` | `--rendering N` (0–3) | `--no_render` flag. The 0–3 choice moved to the `preview_paths` parameter. |
| Manual commands | `-m manual -M <cmd>`, default `fw_version` | `-m utility -M <cmd>`, default `read_name`. `fw_version` is gone (use `sysinfo`). Added: `toggle`, `set_home`. Modes added: `find_home` and `toggle`. `res_home` and `reorder` are removed. |
| Models | 1–7 (V2/V3/SE, XLX, MiniKit, A1, A2, B6), default 1 | Adds 8, 9 and 10 for NextDraw 8511, 1117 and 2234, and the default changes to **8**. Code numbers 1–7 keep their meaning. |
| Pen-lift servo | `penlift` 1–3 plus flat `servo_*` and `nb_servo_*` keys | Same 1/3 choice. Servo constants moved into model tables (`z_motors`) and can be overridden through `overrides`. |
| Homing | None; you place the carriage by hand | Automatic homing on NextDraw models (`homing`, `-n`, `find_home`). `set_home` and origin offsets were added. Walks shift the origin (1.4.6+). |
| Firmware | EBB 2.x was supported, with gates at 2.5.5 and 2.6.2 | **EBB firmware 3.0.2 or newer is required**, and older boards are rejected at connect (`plotink/ebb3_serial.py:50, 254`). Uses the `ebb3_*` protocol modules. |
| Resume data | `<plotdata>` in the SVG namespace | `<nd:plotdata>` in namespace `https://bantam.tools/nd`, with `handling` and `plob_version`. Older un-namespaced elements are still read (`plot_status.py:139-144`). |
| Plob | Introduced in late AxiDraw 3.x | Kept: `--digest`, with a model check before reuse |
| Resume position | `res_adj_in` / `res_adj_mm` followed by `res_plot` | Same, plus (1.7) `--offset_start --dist` with unit suffixes, and starting a fresh plot from an offset |
| Python | `ad.options.*`, `ad.errors`, `ad.plot_run()` | The same shape, plus `params.*` for config-only keys and new `errors.power` and `errors.homing` (codes 105 and 106) |
| Inkscape tabs | Plot, Setup, Options (Speed, **Pen timing**, Notifications, Advanced, Config), **Manual**, **Layers**, **Resume** | Plot (now with a layer selector), Resume, Setup (adds homing), Options (Speed, Copies, Notifications, Advanced, Configuration), Utility. The Pen timing and Layers tabs are gone. |
| Python versions | 3.8+ | 3.10–3.14 as of 1.7 (`changelog.txt`) |

Bantam also publishes a separate migration page at <https://bantam.tools/nd_migrate>.

---

## 8. Feature-parity checklist for axya

"axya today" comes from reading `server/index.js`, `server/plotter.js`, `src/App.jsx`, `src/ConfigModal.jsx`, `src/JogPad.jsx` and `src/lib/svg.js`. The priority is for the Node port of the driver.

| # | Feature | axya today | Priority | Rationale |
|---|---|---|---|---|
| 1 | Plot entire document | yes | must | The core purpose of the app |
| 2 | Plot by layer number (`layers`) | yes (layer chips; `server/index.js:107-122`) | must | Multi-pen workflow |
| 3 | Layer codes `%`, `!`, `+d`, `+h`, `+s`, `+m`, `+g` | partial (nextdraw honours them; the UI neither shows nor parses them) | must | Part of the SVG contract that users' files already rely on |
| 4 | Pause (button, SIGINT) with saved progress | yes | must | Long plots |
| 5 | Resume from `<plotdata>` | yes | must | Same as above |
| 6 | Pause-warning guard on re-plot | **no**. axya treats the refusal (exit 0) as "Plot complete" with progress 100%, after a Stop or after a pause from another tool. | must | Bug today: the next Plot silently does nothing. The port needs explicit "start over" and "resume" semantics. |
| 7 | `strip_data` / start over | no | must | Needed to fix #6 and to discard a paused plot cleanly |
| 8 | Resume offset (`res_read`, `res_adj_*`, `--offset_start`) | no | should | Recover from a dry pen by backing up N mm |
| 9 | Time, distance and lift estimate (preview + `report_time`) | yes (`/api/estimate`; lifts no). Fails on paused files because of #6. | must | Port: the planner should compute this directly |
| 10 | Preview rendering of planned pen-up and pen-down motion | partial (canvas draws SVG paths, not planned or reordered motion) | should | Shows the effect of reordering and travel |
| 11 | Progress | yes (percentage parsed from tqdm) | must | Port: emit progress natively, ideally per path |
| 12 | Copies and page delay | partial (UI minimum is 1, so the continuous mode 0 is missing; no way to skip a delay) | should | Batch production |
| 13 | Handling modes 1–4 | yes | must | They define what the speed percentages mean |
| 14 | Speed, accel, pen heights, rates and delays | yes | must | Basic tuning |
| 15 | Model 1–10 and penlift 3 | yes (`src/lib/svg.js` `PLOTTER_MODELS`) | must | Bounds and servo profile |
| 16 | Pen up / down | yes (about 1 s per subprocess) | must | Port makes it instant |
| 17 | `cycle` and `toggle` | no (up/down only) | could | Convenience for pen setup |
| 18 | `align` (raise pen and release motors) | no | should | Moving the carriage by hand on AxiDraws |
| 19 | `enable_xy` / `disable_xy` | no | should | Same, as a single control |
| 20 | Automatic homing (`find_home`, `homing` on/off) | partial (implicit at plot start; no button, no toggle) | must | NextDraw hardware depends on it |
| 21 | Jog / walk X and Y | yes (mm only) | must | Positioning |
| 22 | Walk shifts the origin (local origin semantics) | partial (inherited without being explained; the UI doesn't show that the next plot starts at the jogged point) | must | Port has to decide and document this behaviour |
| 23 | `walk_home` | yes (gated on `canHome`/`currentFile`, which isn't needed) | must | Return to origin |
| 24 | `set_home` | no | should | Custom origin for jigs |
| 25 | `auto_rotate`, `reordering`, `random_start`, `hiding` | yes | must | Planning parity |
| 26 | `auto_rotate_ccw`, `min_gap`, `clip_to_page`, `bounds_tolerance` | no | could | Advanced tuning |
| 27 | Warnings (bounds, text, image, voltage, homing power) | partial (log lines only) | should | Surface them as UI alerts before plotting |
| 28 | Distinct stop reasons (101–106) | partial (only "no device" is detected) | should | Power loss and homing failure need their own UX |
| 29 | Completion webhook | partial (browser Notifications instead) | could | Phone alerts for long plots |
| 30 | Port selection, nicknames (`list_names`, `read_name`, `write_name`) | no | should | Picking the right machine when several are connected |
| 31 | Plot to all machines (`-P3`) | no | could | Production use, rare |
| 32 | `sysinfo`: firmware and software version, voltage, update check | no | should | Firmware 3.0.2+ gate and diagnosing power problems |
| 33 | `bootload` | no | could | Firmware update flow |
| 34 | Plob export and import | no | could | Huge files. The port could cache plans its own way. |
| 35 | `use_b3_out` / `sync_b3` | no | could | Lasers, valves |
| 36 | `servo_timeout`, `skip_voltage_check` | no | could | Hardware edge cases |
| 37 | `overrides` (custom travel, servo widths, jerk, resolution) | no | could | Custom or modded machines |
| 38 | `preview_paths` and preview colors | no | could | Cosmetic |
| 39 | Interactive XY API (`goto`, `lineto`, `draw_path`, `delay`, `block`) | partial (jog only) | should | A Node API that generative-art code can call |
| 40 | Position readout (`current_pos`, `turtle_pos`) | no | should | Show the carriage position in the UI |
| 41 | Raw EBB `usb_command` / `usb_query` | no | could | Debug console |
| 42 | Hatch fill | no | could | Fill shapes for plotting; could run client-side |
| 43 | Snap colors to layers | no | should | Turns colored SVGs into per-pen layers; fits the layer chips |
| 44 | Elapsed time | yes (client-side timer) | must | Already present |
| 45 | Firmware version requirement (EBB 3.0.2 or newer) | partial (enforced by nextdraw, but not surfaced in the UI) | must | The Node driver has to check it at connect |

### Notes for the port

- **Bugs in current axya** that come from these semantics: (a) #6, a pause-warning refusal shown as a successful completion; (b) `/api/estimate` returns nothing for paused files; (c) the dummy SVG and the file requirement for `walk_home` are unnecessary (§3.3).
- **SIGTERM pauses rather than kills** (`nextdraw_control.py:78`). axya uses SIGKILL for Stop, which leaves the servo powered and skips writing `<plotdata>`. If Stop should be resumable, it should send SIGINT. If it shouldn't, it should strip the data.
- **Flags can't turn options off.** If axya keeps using the CLI before the port lands, any option that has to be false for one run must come from the config file, not a flag (§3.1).

---

## Key findings

1. axya's Plot button has a silent failure today. When a file still holds `<nd:plotdata>` from an earlier pause, nextdraw refuses once, exits 0, and axya shows "Plot complete" with 100% progress. The fix is an explicit "start over" action (`strip_data`) next to Resume.
2. Since 1.4.6, walk commands shift the plot origin, so the next plot starts wherever the user last jogged. `walk_home` and the utility commands need no SVG, so axya's dummy SVG and the file requirement on Home are unnecessary.
3. Several CLI behaviours trip up anyone wrapping the CLI: `-z` now means handling (in axicli it was the pen-down delay); flags can only turn options on; `--offset_start` appears not to be forwarded to the core in 1.7.5; SIGTERM pauses rather than kills.
4. The largest parity gaps are: resume offset and start-over; machine and port selection with nicknames; `sysinfo` with the firmware 3.0.2 check; `align`, `enable_xy`/`disable_xy`, `set_home` and `find_home` controls; distinct stop reasons (power loss, homing failure); surfaced warnings; an interactive XY API; and the Snap Colors and Hatch helpers.
5. `handling` decides resolution, jerk, speed caps and curve tolerance. Top-level `resolution` and `const_speed` do nothing, and only `overrides` can change those values (`overrides['speed_up']` is never applied). The Node port should copy the model and handling tables in §6 exactly.
