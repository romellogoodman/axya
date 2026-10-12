# Prior art: the pen-plotter control landscape

This document covers the parts of the ecosystem that the other prior-art docs leave out. It places axya in the history of EiBotBoard (EBB) plotters, looks closely at gre's `penplotter-web` (the model for axya's current architecture), describes the legacy Evil Mad Scientist AxiDraw software and what firmware-2.x machines need, shows where the EBB firmware source can confirm the motion math, surveys other tools, and records axya's own history. It ends with what all of this means for the planned Node port of the driver.

saxi, Bantam's nextdraw driver internals, the EBB protocol and the nextdraw CLI/Inkscape options each have their own doc in this folder (for example [`saxi.md`](saxi.md) and [`nextdraw-inkscape-cli-api.md`](nextdraw-inkscape-cli-api.md)). This doc only mentions them where they connect to something here.

Local sources:

| Label | Path |
|---|---|
| `penplotter-web/` | `docs/reference-apps/gre-penplotter-web/` |
| `nextdraw-1.7.5/` | `docs/reference-apps/nextdraw-1.7.5/` |
| `legacy-axidraw/` | clone of `github.com/evil-mad/axidraw` (HEAD `a0df054`, 2024-01-23) |
| `EggBot/` | clone of `github.com/evil-mad/EggBot` (HEAD `8f7fb31`, 2026-10-01) |
| `plotink-upstream/` | clone of `github.com/evil-mad/plotink` (HEAD `4976b86`, 2026-10-02, `setup.py` version 1.14.3) |

The three clones are not committed to axya; to check a citation, re-clone the repo at the HEAD shown. Line numbers refer to those revisions. The parts of `EggBot/` that matter for the port are vendored at `docs/reference-apps/ebb-firmware/`: `docs/` (command reference), `source/` (the `app.X/source` firmware files, including `ebb.c` and `UBW.c`), and `regression-tests/` (the `Analysis/RegressionTests` scripts and CSV vectors).

---

## 1. Timeline

| When | Event | Evidence |
|---|---|---|
| 2009–2010 | Brian Schmalz (Schmalz Haus) designs the **EiBotBoard (EBB)**, a PIC18-based USB board for two steppers and a servo, for Evil Mad Scientist's **EggBot**. EBB v1.1 shipped in the 2009 clear-chassis kits. | `EggBot/EBB_firmware/readme.txt`; [EMS wiki: Updating EBB firmware](https://wiki.evilmadscientist.com/Updating_EBB_firmware) |
| Sep 2010 | EBB firmware **2.0.1**: the start of the "EBB 2.x" command set (`SM`, `SP`, `EM`, `QB`…). | `EggBot/docs/EBBReleaseNotes.html` (v2.0.1) |
| 2015 | 2.3.0 adds **`XM`** (mixed-axis/CoreXY move), the command saxi falls back to and fogleman/axi uses. | Release notes v2.3.0 |
| Jan 2017 | 2.5.0 adds **`LM`** (low-level accelerated move). In 2.5.x it is buggy. | Release notes v2.5.0–2.5.3 |
| ~2016–2018 | **AxiDraw** ships, driven by the "AxiDraw Control" Inkscape extension. A standalone **CLI/Python API** (later `axicli`/`pyaxidraw`) appears as "AxiDraw Standalone Beta" builds before v2.x. | `legacy-axidraw/cli/pyaxidraw/changelog.txt:634-641` (beta builds 22/32), `:398` (v2.3.1, Dec 2018) |
| Jan 2019 | 2.6.2 adds **`HM`** (home/absolute move). This becomes the floor for `walk_home`. | Release notes v2.6.2; `legacy-axidraw/inkscape driver/axidraw.py:533` |
| ~2019 | **saxi** (nornagon; TypeScript, AGPL-3.0) is the first popular non-EMS AxiDraw driver: its own planner, `LM`-based, with server and WebSerial modes. The repo dates from 2017 per the GitHub API. The 2019 date for saxi's public release is approximate. | `gh api repos/nornagon/saxi` (created 2017-08-19) |
| Nov 2020 | 2.7.0 rewrites `LM` with correct kinematics and adds `LT` (timed `LM`). **2.7.0 is the first firmware where `LM` is trustworthy.** | Release notes v2.7.0 |
| Jul 2022 | 2.8.1, the last 2.x release and still the "current" firmware on EMS's wiki and AxiDraw CLI docs. | Release notes; [axidraw.com/doc/cli_api](https://axidraw.com/doc/cli_api/) ("current firmware version is 2.8.1") |
| Jan 2024 | **Bantam Tools acquires Evil Mad Scientist.** Future machines are sold as **Bantam Tools NextDraw**. | [Control Design](https://www.controldesign.com/industry-news/news/33018729/bantam-tools-acquires-evil-mad-scientist), [EMS blog](https://www.evilmadscientist.com/2024/bantam-tools/) |
| Mar 2024 | EBB firmware **3.0.0**: jerk-limited `T3`/`L3`, a FIFO of up to 32 commands, "future syntax" (`CU,10`), limit switches (`CU,51-53`), and a hardware-in-the-loop test mode. 3.0.1 adds **`TD`** (two back-to-back `T3`s for S-curves). The 3.0.1 entry is dated "04/02/23", earlier than 3.0.0, which is almost certainly a typo for 2024. | Release notes v3.0.0–3.0.2 |
| 2024 | The legacy `evil-mad/axidraw` repo goes quiet (last push 2024-04-12, last tagged release v3.9.0 in May 2023). The docs site still advertises **3.9.6**. EMS's "AxiDraw Merge" is discontinued in favour of NextDraw Merge. | `gh api repos/evil-mad/axidraw`; [axidraw.com/doc/cli_api](https://axidraw.com/doc/cli_api/); [EMS shop](https://shop.evilmadscientist.com/productsmenu/956) |
| 2024–2026 | Bantam's **`nextdraw`** CLI/Python API (current 1.7.5) supports AxiDraw models 1–7 and NextDraw models 8–10, but requires **EBB firmware ≥ 3.0.2**. | [bantam.tools/nd_cli](https://bantam.tools/nd_cli/); `nextdraw-1.7.5/plotink/ebb3_serial.py:50` |
| Mar 2026 | EBB firmware 3.1.0 and 3.1.7 fix end-of-command time accounting in `LT`/`T3`/`TD` and optimise the ISR. | Release notes v3.1.0, v3.1.7 |
| Jan–Mar 2026 | **axya v1**: a browser-only WebSerial port of saxi. | `git log` (`cb8aa40` 2026-01-25 … `7a72a11` 2026-03-08) |
| Mar 2026 | **gre/penplotter-web**: a FastAPI wrapper around `axicli`, with a Home Assistant integration. | `gh api repos/gre/penplotter-web` (created 2026-03-28) |
| May 2026 | **axya v2**: rebuilt around the `nextdraw` CLI with an Express backend, modelled on penplotter-web. | `58312f5` (2026-05-01) |
| Oct 2026 | Upstream plotink 1.14.3, the same code nextdraw 1.7.5 vendors (see §4.3). axya plans a Node port of the driver. | `plotink-upstream/setup.py:19` |

---

## 2. gre/penplotter-web in depth

**What it is.** A single-file FastAPI backend (`server.py`, 854 lines), a single-file vanilla-JS frontend (`static/index.html`, 1030 lines), and a Home Assistant custom component. It runs on a Raspberry Pi next to an AxiDraw and wraps EMS's legacy `axicli` (`penplotter-web/server.py:38`). License: WTFPL v2 (`penplotter-web/LICENSE`; GitHub reports it as `NOASSERTION`). The repo has 4 stars and was last pushed 2026-04-08.

### 2.1 Process model

- **`run.sh`** creates a `.venv`, installs `fastapi`, `uvicorn[standard]` and `python-multipart` (`requirements.txt`), and generates a self-signed certificate whose SAN covers the hostname, `localhost` and `127.0.0.1` (`run.sh:33-45`). It then runs `server.py`, which binds **`0.0.0.0:4443`** over HTTPS (`server.py:845-853`). HTTPS is there so that browser Notifications and Home Assistant work across the LAN. The README also describes a systemd unit (`README.md`, Setup), but the `docs/` folder holding that file was not vendored into axya.
- **`PlotterManager`** (`server.py:62-332`) is one in-memory object holding `state ∈ {idle, plotting, paused, error}`, `current_file`, `progress_pct`, `error_msg`, a 200-line log (`MAX_LOG_LINES`, `:48`), `_paused_file` and `selected_file`. axya copied this almost verbatim: the class name, the four states, the 200-line ring and the `can_home` flag all appear in `server/plotter.js:43,81`.
- **Plot execution** (`server.py:131-221`): `Popen([axicli, svg, --config, cfg, --output_file, svg, --progress, --report_time, …options], start_new_session=True)`. A `selectors` loop reads both pipes. stderr is split on `\r` because tqdm redraws in place, and every fragment is regex-scanned for `(\d+)%\s+\d+/\d+` (`:122-129`). stdout lines go to the log. A worker thread runs each plot and a `threading.RLock` guards state.
- **Status push**: `/api/events` is SSE, but it **polls** `status_dict()` every 0.5 s and emits only when state, progress or log version changes (`server.py:728-747`). axya instead emits on `EventEmitter` `change` events (`docs/ARCHITECTURE.md`, State machine).

### 2.2 Pause / resume / stop / home

| Action | penplotter-web | Notes |
|---|---|---|
| Pause | `os.killpg(pgid, SIGINT)`, then immediately `state = PAUSED`, `_paused_file = current_file` (`server.py:223-230`) | axicli traps SIGINT as a pause request (`legacy-axidraw/inkscape driver/axidraw_control.py:77-78`). The driver finishes the current move, raises the pen, writes position and progress into the SVG's `<plotdata>`, and exits. This only works because `--output_file` points back at the input file (`server.py:116`). nextdraw keeps the same mechanism and also traps SIGTERM (`nextdraw-1.7.5/nextdrawcore/nextdraw_control.py:76-78`). |
| Resume | New subprocess with `--mode res_plot` on the same file (`server.py:114-115, 232-243`) | Pause state lives in the SVG on disk, not in the server, so it survives restarts. axya documents and relies on this (`docs/ARCHITECTURE.md`, Pause/Resume). |
| Stop | `killpg(SIGKILL)` and `state = IDLE`. It still sets `_paused_file` so Home stays available (`server.py:245-257`) | With SIGKILL the driver cannot write `<plotdata>`, so a later `res_home` works from the *previous* saved position (or none). This is a latent footgun. |
| Home | `axicli <file> --mode res_home` (`server.py:305-324`) | Legacy axicli mode. In nextdraw this became `--mode utility --utility_cmd walk_home`, and axya migrated in `0229e1d`. |
| Hardware pause button | Not handled | The driver exits non-zero on a button pause while state is still `PLOTTING`, so `server.py:197-202` reports it as `ERROR`. axya fixed this by matching "Use the resume feature to continue" (`docs/ARCHITECTURE.md`, Pause/Resume). |

### 2.3 Manual commands, estimate, layers

- **Pen/jog** spawn `axicli <dummy.svg> --mode manual --manual_cmd raise_pen|lower_pen|walk_mmx|walk_mmy [--dist d]` (`server.py:271-303`), using a 1×1 dummy SVG written to the temp directory (`:40-42`). axya kept the dummy-file trick (`server/plotter.js:37-40`) and the one-subprocess-per-axis jog.
- **Estimate** runs `axicli --preview --report_time` and scrapes the lines "Estimated print time", "Length of path", "Pen-up travel" and "Total movement" (`server.py:576-625`).
- **Layers**: `ET.iterparse` collects `<g inkscape:groupmode="layer">` labels and parses a leading integer as the layer number (`server.py:550-573`). axya's `GET /api/files/:name/layers` mirrors this.

### 2.4 REST API

| Method | Path | Body / behaviour |
|---|---|---|
| GET | `/api/status` | `status_dict()`, including the last 50 log lines and `log_version` |
| GET | `/api/events` | SSE (0.5 s poll) |
| GET | `/api/files` | `{files:[{name,size,modified}]}`; hides `_`-prefixed files |
| POST | `/api/select/{f}`, `/api/select` | Server-side "selected file", shared across clients |
| GET | `/api/files/{f}/layers` | `{layers:[{label,number}]}` |
| POST | `/api/estimate/{f}` | `{options}` → scraped estimate dict |
| POST | `/api/upload` | multipart; checks only the `.svg` suffix |
| DELETE | `/api/files/{f}` | |
| POST | `/api/plot/{f}` | `{options}` passed through as `--k v` CLI flags |
| POST | `/api/pause`, `/api/resume`, `/api/stop`, `/api/home` | 409 on invalid state |
| POST | `/api/pen/up`, `/api/pen/down`, `/api/move {dx,dy}` | |
| GET/POST | `/api/config` | **Raw text** of `axidraw.conf.py` in and out |
| GET/POST | `/api/camera/config`, GET `/api/camera/status`, `/api/camera/stream` (MJPEG), `/api/camera/snapshot` | Optional webcam (see below) |

Static `/uploads/*` is served directly (`server.py:46`).

### 2.5 UX patterns axya borrowed

From `static/index.html`:

- A **schema-driven config form** (`CONFIG_SCHEMA`, `index.html:876-922`) grouped as Device / Pen positions / Speed / Path optimization / Plot options. The browser parses the config with a `key = value` regex (`:924-931`) and re-serialises it (`:932-940`). axya's `ConfigModal.jsx` SCHEMA is the same idea, with the parsing and validation moved to the server.
- A **config summary pill** (model, ↑up, ↓down, ⚡speed; `:966-976`).
- **Layer chips** with a "layer mode" checkbox (`:611-710`).
- **ETA** computed client-side as `elapsed × (100−p)/p` (`:828-832`).
- **Web Notifications** on complete, pause and error (`:416-427, 839-845`).
- A **command log** that echoes each spawned command as `$ axicli …`.
- An **optional camera**: the user configures a shell command that emits MJPEG on stdout. The server parses JPEG SOI/EOI markers, keeps the latest frame, and stops the process 5 s after the last viewer leaves (`server.py:359-490`). axya has not adopted this. It is a cheap, useful feature for a machine in another room.

### 2.6 Security posture (the reason axya diverged)

penplotter-web is built for a trusted home LAN and makes no attempt at hardening:

- `POST /api/config` writes arbitrary text to a file that axicli **executes as Python** (`server.py:833-839`). That is remote code execution for anyone on the LAN.
- `POST /api/camera/config` stores a command that is later run with `shell=True` (`server.py:398-403, 764-771`). This is a second RCE.
- Upload paths use `file.filename` without checking for directory traversal (`server.py:628-635`).
- `/api/plot` passes arbitrary `options` keys straight through as CLI flags (`server.py:117-119`).
- No authentication, binds `0.0.0.0`.

axya's commits `2933d23` (loopback Host/Origin check), `a17f0c3` (validate SVG uploads), `fae95d9` (path prefix check), `5929966` (config range checks), `2ae5f76` (jog validation) and `92b8db8` (pen/layer validation), together with the `CONFIG_NUM_KEYS`/`CONFIG_BOOL_KEYS` allowlist (`server/index.js:279-331`) and the `127.0.0.1` bind (`server/index.js:349`), deliberately close each of these holes. A Node port that writes no Python config file at all removes the config-injection class of bug entirely.

### 2.7 Home Assistant integration

`custom_components/penplotter/` is a HACS-installable integration (`hacs.json`: "Pen Plotter (AxiDraw)", HA ≥ 2024.1.0):

- **Config flow** (`config_flow.py:16-53`): the user enters host, port (default 4443) and a "verify SSL" toggle. The flow validates by calling `GET /api/status` over HTTPS and uses `host:port` as the unique ID.
- **Coordinator** (`coordinator.py:17-57`): a `DataUpdateCoordinator` polls `/api/status` every **15 s** (`const.py:8`). `api_post(path)` POSTs a command and then forces a refresh. The device info is hard-coded as manufacturer "Evil Mad Scientist", model "AxiDraw" (`coordinator.py:27-33`).
- **Entities**: a State sensor with `current_file`, `elapsed`, `can_home` and `error` attributes, and a Progress % sensor (`sensor.py:11-58`). Six buttons, Pause, Resume, Stop, Pen Up, Pen Down and Home, each mapped to one REST path (`button.py:10-17`).
- `iot_class: local_polling`, version 0.1.0 (`manifest.json`). The integration only works with HTTPS URLs (`const.py:11-12`).

What this means for axya: the integration depends only on `/api/status` returning `{state, progress, current_file, elapsed, can_home, error}` and on six POST endpoints. axya's API matches it closely except for `elapsed` (axya sends `startedAt`, `734ffef`), `/api/move` (axya uses `/api/jog`), and axya's loopback-only binding. An HA integration for axya would need an opt-in LAN mode with authentication. It could subscribe to SSE instead of polling.

---

## 3. Legacy Evil Mad Scientist AxiDraw software (EBB 2.x era)

### 3.1 Architecture

`legacy-axidraw/` (GPL-2.0; CLI `pyproject.toml` version 3.9.7, docs site says 3.9.6) holds:

- `inkscape driver/`: the core package, imported as `axidrawinternal`. Main modules: `axidraw.py` (1065 lines, orchestrator and modes), `motion.py` (980, trajectory planning), `dripfeed.py` (186, streams moves to the EBB), `pen_handling.py`, `plot_status.py`, `digest_svg.py`, `plot_optimizations.py`, `clipping.py`/`boundsclip.py`, `preview.py`, `serial_utils.py`, and `axidraw_conf.py` (defaults). The `.inx` files are the Inkscape UI ("AxiDraw Control", Naming, Hatch, Reorder…).
- `cli/`: `axicli` (argument parser wrapping the above) and `pyaxidraw` (the Python API: `plot_setup`/`plot_run` and an interactive `moveto`/`lineto` API).
- EBB I/O goes through **plotink**'s legacy `ebb_serial.py`/`ebb_motion.py` (`dripfeed.py:35`).

The modes are the same family nextdraw inherited: `plot`, `layers`, `res_plot`, `res_home`, `manual` (`--manual_cmd raise_pen|lower_pen|walk_mmx|walk_home|…`), `align`, `toggle`, `cycle`, `sysinfo`, `version` (`axidraw.py:265-462`). nextdraw renamed `manual` to `utility` and `res_home` to `utility walk_home`, which is why axya needed `0229e1d`.

### 3.2 How it moves the motors

The legacy software does **all motion timing on the host** and sends only constant-velocity `SM` segments:

- `motion.py:409-448` (`compute_segment`) splits each line into sub-segments of constant velocity using a **linear ("trapezoid") acceleration and deceleration strategy** (`motion.py:448`). Each sub-segment becomes `['SM', (steps2, steps1, ms), seg_data]` (`motion.py:974`).
- `dripfeed.py:88-139` (`feed_sm`) sends each one with `ebb_motion.doXYMove` → `SM,<ms>,<a>,<b>` (`plotink-upstream/plotink/ebb_motion.py:92-99`). For moves longer than 50 ms it **sleeps `move_time − 30` ms on the host** before sending the next (`dripfeed.py:127-129`). This is necessary because the 2.x firmware FIFO is one command deep.
- It never sends `LM`, `LT`, `T3` or `TD`. `LM` exists in plotink's legacy module (`ebb_motion.py:75-90`) but the AxiDraw driver does not use it.
- **No homing hardware.** The AxiDraw has no limit switches. "Home" means the position at power-on/motor-enable. `walk_home` reads step counters with `QS` and moves back (`axidraw.py:532-541`) and needs firmware ≥ 2.6.2. Below that it logs "This function requires newer firmware" (`:542`).
- Other firmware gates: `QC` voltage/current reads need ≥ 2.2.3 (`axidraw_options/versions.py:110`), USB nicknames need ≥ 2.5.5 (`axidraw.py:504`), and `QG` pause-button/status polling needs ≥ 2.6.2 (`serial_utils.py:94-105`). There is **no hard minimum**: the software degrades on old firmware rather than refusing to run.

### 3.3 Legacy vs nextdraw

| Aspect | Legacy AxiDraw 3.9.x | nextdraw 1.7.5 |
|---|---|---|
| Firmware floor | None (feature-gated: 2.2.3 / 2.5.5 / 2.6.2) | **3.0.2, hard refusal** (`ebb3_serial.py:50, 254-258`) |
| Serial layer | `plotink.ebb_serial` / `ebb_motion` (free functions) | `plotink.ebb3_serial.EBB3` class + `ebb3_motion`; switches into future-syntax responses with `CU,10,1` (`ebb3_serial.py:262`) |
| Motion primitive | `SM` (constant rate; host-side trapezoid) | `T3` / `TD` (on-board jerk-limited S-curves; `nextdrawcore/dripfeed.py:178-205, 283-288`) |
| Velocity profile | Trapezoidal (piecewise-constant velocity) | S-curve (jerk-limited) |
| FIFO | Depth 1; host sleeps per move | `CU,4,16`: 16-deep FIFO (`nextdrawcore/serial_utils.py:66`) |
| Homing | None; `walk_home` via `QS` | Limit-switch homing for NextDraw models only (`nextdrawcore/homing.py`, "Not supported on legacy models"; limit-switch config `CU,51`) |
| Models | AxiDraw 1–7 | AxiDraw 1–7 + NextDraw 8–10 (`nextdrawcore/nextdraw_conf.py:71-77`) |
| Modes | `manual`, `res_home` | `utility`, `walk_home` |
| License | GPL-2.0 | Package `LICENSE.txt` is GPL-2.0. Some newer files (for example `homing.py:6-8`) carry MIT headers. |

### 3.4 What EBB-2.x AxiDraws need, and what nextdraw does about them

Command availability on 2.x firmware, from the release notes in `EggBot/docs/EBBReleaseNotes.html`:

| Command | First firmware | Usable for |
|---|---|---|
| `SM` | 2.0.1 (long args from 2.2.5) | Constant-rate segments, the legacy driver's approach |
| `XM` | 2.3.0 | Same, in CoreXY A/B form (fogleman/axi, saxi fallback) |
| `QS` / `CS` | 2.4.3 | Step-position readback |
| `LM` | 2.5.0, **correct only from 2.7.0** | On-board constant-acceleration segments (saxi) |
| `HM` | 2.6.2 | Return home / absolute move |
| `QG` | 2.6.1 | Button, FIFO and motor status in one query |
| `LT` | 2.7.0 | Timed `LM` |
| `QE` | 2.8.0 | Motor-enable / microstep query |
| `T3`, `L3`, FIFO > 1 (`CU,4`), `CU,10`, limit switches | **3.0.0** | |
| `TD`, `SP,2/3` (immediate pen-up), `QU,6` (FIFO fill) | **3.0.1** | |

**nextdraw 1.7.5 does not support firmware 2.x at all.** `EBB3.connect()` parses the `V` reply and, if it is below `MIN_VERSION_STRING = "3.0.2"`, records "Firmware version (…) not supported. Firmware 3.0.2 or newer is required. Visit https://bantam.tools/ndfw to update your firmware." and returns `False` (`nextdraw-1.7.5/plotink/ebb3_serial.py:50, 254-258`). So **axya today, which shells out to nextdraw, already cannot drive an AxiDraw on 2.x firmware**, even though nextdraw accepts `model=1..7`. That user's only options are to update the firmware or to fall back to EMS's legacy `axicli` 3.9.x.

Can every AxiDraw be updated? Since 2.8.1 the firmware tree builds a single image from `HardwareProfile_EBB_V13_and_above.h` (`EggBot/EBB_firmware/app.X/source/HardwareProfile.h:56`), and `Releases/app/EBF_v300…v317` each contain one `.hex`. The version string is literally `"EBBv13_and_above EB Firmware Version 3.1.7"` (`UBW.c:154`). The EMS wiki says the only separate builds were for EBB 1.1/1.2 (2009-era EggBot kits) ([wiki](https://wiki.evilmadscientist.com/Updating_EBB_firmware)). **Inference, unverified on hardware:** every AxiDraw's EBB is "v1.3 and above" and can be flashed to 3.x through the USB HID bootloader. The Windows updater in the repo is already v3.1.7 (`EBBUpdater/EBBUpgraderGUI_v317.exe`, `EBF_v317.hex`). The macOS script still flashes 2.8.1 (`EBBUpdaterMac/UpdateEBB.sh`: `mphidflash … -w EBF_v281.hex`). Bantam's `bantam.tools/ndfw` redirects to a support article that returned 403 when fetched, so its current instructions are unverified.

---

## 4. The EBB firmware source (EggBot repo)

### 4.1 Layout

`EggBot/EBB_firmware/` (repo license GPL-3.0; firmware file headers are BSD-3-Clause by Schmalz Haus; the release notes footer says CC-BY-3.0 for the EBB design):

| Path | Contents |
|---|---|
| `app.X/source/ebb.c` (4647 lines) | Motion ISR, command parsers, FIFO |
| `app.X/source/UBW.c` (4009) | USB/CDC command dispatch, `CU` options (incl. test modes), version string |
| `app.X/source/ebb.h` | `MoveCommandType`, `COMMAND_FIFO_MAX_LENGTH 32u` (`:99`), `HIGH_ISR_TICKS_PER_MS 25u` (`:244`) |
| `app.X/source/RCServo2.c` | Servo PWM (pen lift) |
| `bootloader.X/`, `Releases/{app,bootloader,combined}` | Every released hex from v1.9 to v3.1.7 |
| `EBBUpdater/`, `EBBUpdaterMac/` | Flashing tools (mphidflash) |
| `Analysis/RegressionTests/` | Golden input/output vectors for `LM`, `LT` and `T3` |
| `docs/ebb.html`, `docs/EBBReleaseNotes.html` | The command reference and history (sources for [evil-mad.github.io/EggBot/ebb.html](https://evil-mad.github.io/EggBot/ebb.html)) |

The Microchip MLA USB stack is not redistributable, so you cannot build the firmware from the repo alone (`EBB_firmware/readme.txt`).

### 4.2 Where the motion math lives

| Item | Location |
|---|---|
| 25 kHz step ISR | `ebb.c:520` `high_ISR()` through about `:1505`. It reloads TMR0 with lateness compensation (`:536-542`). |
| Simple (`SM`/`XM`/`HM`) step path | `ebb.c:574-662` |
| `LM`/`LT`/`L3`/`T3` accelerated path | `ebb.c:664` onward. Per tick and per axis: `Accel += Jerk; Rate += Accel; acc += Rate`. A step fires when bit 31 of the accumulator is set; the code then clears that bit and takes direction from the sign of `Rate` (`ebb.c:683-712` motor 1, `:720-748` motor 2). |
| Parsers | `parse_LM_packet` `ebb.c:1890`, `parse_L3_packet` `:1968`, `parse_TD_packet` `:2034`, `parse_T3_packet` `:2122`, `parse_LT_packet` `:2182`, `process_low_level_move` `:2245`, `parse_SM_packet` `:2573`, `parse_HM_packet` `:3090`, `parse_XM_packet` `:3380` |
| Test/debug modes | `CU,250`–`CU,257` (`UBW.c:2114-2307`): GPIO ISR timing, end-of-move values printed on RC6, per-tick values, parse debug |

`TD` takes `Intervals, Rate1A, Rate1B, Accel1, Jerk1, Rate2A, Rate2B, Accel2, Jerk2[, Clear]` (`ebb.c:2034-2052`). `T3` takes `Intervals, Rate1, Accel1, Jerk1, Rate2, Accel2, Jerk2[, Clear]` (`ebb.c:2122-2137`).

### 4.3 How a port can use this to check its math

1. **Write a bit-exact JS simulator of the accumulator loop** above, using 32-bit integer semantics (`Math.imul`/`| 0`, unsigned compare on bit 31). Feed it the same `T3`/`TD` arguments the port generates. Then assert step counts per axis, total ISR ticks, and final position against the host planner's predicted endpoint and duration.
2. **Use the golden vectors.** `Analysis/RegressionTests/python_send_T3_20230507.py:89-98` sends `CU,250,1`, `CU,251,1`, then commands such as `T3,22,490123456,0,0,0,0,0`. `T3_20230507_ExpectedOutput.csv` records the board's end-of-move dump, e.g. `T,22,S,5,C,45297792,R,490123456,P,5` (ticks, steps, accumulator, rate, position). It has 51 `T3` rows, 80 `LT` rows and 79 `LM` rows. The simulator should reproduce every row. **Caveat:** these vectors date from 2023-05-07, before 3.1.0's "fix for incorrect time accounting in LT, T3, TD commands at end of command". Expect tick-count differences of about one interval at command boundaries. To regenerate them, run the scripts against a 3.1.x board with `CU,251,1`.
3. **Hardware-in-the-loop on a real board.** The same `CU,251` mode prints end-of-move values on pin RC6 (a UART you can tap with a USB-serial adapter). `Analysis/firmware tests/saleae_test*.py` shows logic-analyser capture of step pulses. This is the strongest available check that a Node port's `TD` stream matches nextdraw's.
4. **Cross-check against plotink.** `plotink-upstream/plotink/ebb_calc.py` (v1.1.0, 2025-07-23) is the host-side Python model of LM/T3 math, with tests in `plotink-upstream/test/test_ebb_calc.py`. Porting those tests first gives a cheap oracle.

**Vendored plotink vs upstream:** apart from one line, the eleven modules in `nextdraw-1.7.5/plotink/` are byte-identical to upstream HEAD, including the 2026-10-02 `rtree.py` 1.2 fix and `ebb3_serial.py` 0.2.3. The one difference is `DEPENDENCY_DIRS` in `plot_utils_import.py:54`: upstream has `['nextdraw_deps', 'axidraw_deps']` and nextdraw has `['nextdraw_deps', 'nextdraw_deps']`. Upstream additionally ships `test/` (`test_ebb_calc.py`, `test_ebb3_serial.py`, `test_plot_utils.py`, `test_rtree.py`, `test_spatial_grid.py`, `test_text_utils.py`), which the vendored copy lacks. **Port those tests along with the code.** The recent upstream commits are relevant to a port: 2026-03 added guards for non-ASCII serial replies and an unparsed `min_version()`, and fixed the bootloader command not being flushed before close.

---

## 5. Survey of other tools

Metadata (language, license, last push) comes from the GitHub API on 2026-10-12 unless noted.

| Project | Lang | License | Hardware path | Maintained? |
|---|---|---|---|---|
| [vpype](https://github.com/abey79/vpype) | Python | MIT | None (file pipeline) | Yes (1.15.0, Aug 2025; pushed Oct 2026) |
| [vpype-gcode](https://github.com/plottertools/vpype-gcode) | Python | MIT | None (export) | Yes (pushed Sep 2025) |
| [vsketch](https://github.com/abey79/vsketch) | Python | GitHub reports NOASSERTION (unverified) | None | Yes (pushed Oct 2026) |
| [AxiDraw Control / axicli](https://github.com/evil-mad/axidraw) | Python | GPL-2.0 | Own (plotink, `SM`) | Frozen since 2024 |
| [NextDraw software](https://bantam.tools/nd_cli/) | Python | GPL-2.0 (package) | Own (plotink `ebb3`, `T3/TD`) | Yes (1.7.5) |
| [fogleman/axi](https://github.com/fogleman/axi) | Python | MIT | Own (`XM` timeslices) | No (last push 2020) |
| [saxi](https://github.com/nornagon/saxi) / [alexrudd2 fork](https://github.com/alexrudd2/saxi) | TypeScript | AGPL-3.0 | Own (`LM`, `XM` fallback) | Original slow (Feb 2025); fork active (Oct 2026) |
| [cncserver](https://github.com/techninja/cncserver) | JavaScript | MIT | Own (Node serialport) | Sporadic (pushed Aug 2026, v2.9.1) |
| [RoboPaint](https://github.com/evil-mad/robopaint) | JavaScript | No SPDX detected | Via cncserver | No (2018) |
| [@thi.ng/axidraw](https://www.npmjs.com/package/@thi.ng/axidraw) | TypeScript | Apache-2.0 | Own (Node serialport, `XM`) | Yes (1.1.194, Sep 2026) |
| [ebb-control](https://github.com/jmpinit/ebb-control) + [p5.axidraw](https://github.com/jmpinit/p5.axidraw) | JavaScript | MIT | Own (WebSerial, 2.x command set) | No (Mar 2024) |
| [AxiDraw-Processing](https://github.com/evil-mad/AxiDraw-Processing) | Processing | none listed | Own (examples) | Light (Jun 2025) |
| [Kurvengefahr](https://github.com/tibordp/kurvengefahr) | TypeScript + Rust/WASM | GPL-2.0 | Own (WebSerial/Node, `LM` with `SM` fallback) | Yes (Aug 2026) |
| [DrawingBotV3](https://github.com/SonarSonic/DrawingBotV3) | Java | GPL-3.0 (+ Premium) | HPGL serial only; SVG/G-code export | Yes (Oct 2025) |
| [plotterfun](https://github.com/mitxela/plotterfun) | JavaScript | MIT | None | Light (Aug 2025) |
| [penkit](https://github.com/paulgb/penkit) | Python | MIT | None | No (2021) |
| Plotter.vision | n/a | n/a | n/a | **Unverified: no project by this name found** |

**vpype** (+ plugins). A Python CLI and library that is "the Swiss-Army-knife … for plotter vector graphics": you chain commands (`read`, `linemerge`, `linesort`, `reloop`, `linesimplify`, `layout`, `write`). It does not talk to hardware. It writes SVG or HPGL, and plugins add `vpype-gcode` (arbitrary text formats), `occult` (hidden-line removal), `deduplicate`, `vpype-vectrace` and `hatched` ([plugin list](https://vpype.readthedocs.io/en/latest/plugins.html)). **What axya can learn:** vpype's path-optimisation passes (`linemerge` with tolerance, `linesort`, `reloop`) and its `layout` (fit to page, centre, margins) are the reference algorithms for the "fit-to-page / margins" feature axya lost in the nextdraw rewrite (`docs/ARCHITECTURE.md`, last section). A Node port that owns its pipeline could implement them for real instead of only in the preview.

**AxiDraw Control / axicli (EMS legacy).** Covered in §3. Inkscape itself does **not** ship an AxiDraw driver. The AxiDraw (and now NextDraw) extensions are installed separately into Inkscape's extensions directory. Inkscape's built-in "Plot" extension speaks HPGL to serial plotters, which is a different protocol. (Based on the extension packaging in `nextdraw-1.7.5/inkscape-extension/` and `legacy-axidraw/inkscape driver/*.inx`. Inkscape's bundled extension list was not re-checked for this doc.)

**Bantam NextDraw software and Merge.** The NextDraw Inkscape extension, CLI and Python API are installed from `https://software-download.bantamtools.com/nd/api/nextdraw_api.zip` and need Python 3.10–3.14 ([nd_cli](https://bantam.tools/nd_cli/)). Their internals are covered elsewhere. **NextDraw Merge** replaces EMS's discontinued "AxiDraw Merge"/"Hershey Advanced" (handwriting fonts and spreadsheet mail-merge into an SVG template) ([EMS shop](https://shop.evilmadscientist.com/productsmenu/956)). Its features and licensing were not verified. Retailers also list a "NextDraw SVG Player" accessory (standalone playback). Its pages returned 403, so its details are unverified.

**fogleman/axi.** A Python library for the AxiDraw v3 (MIT, untouched since 2020). It has its own serial driver (`axi/device.py`) and a constant-acceleration planner with corner speeds (`axi/planner.py`). Execution samples the plan every `TIMESLICE_MS = 10` ms and sends each slice as an `XM` command, carrying the sub-step error forward (`device.py:13, 144-165`). axya v1's `planning.js` was ported from `axi/planner.py` by way of saxi (§6). **Lesson:** fixed-timeslice `XM` is simple, works on any firmware ≥ 2.3.0, and is accurate to about 10 ms. It is a valid fallback for 2.x boards.

**saxi and forks.** Covered in `saxi.md`. For this doc, the important facts are that saxi uses `LM` (2.5.3+, correct from 2.7.0) with an `XM` fallback, supports both a Node server and WebSerial, and is AGPL-3.0, so anything copied from it into axya inherits AGPL.

**cncserver / RoboPaint.** A Node/Express **RESTful API server** for EBB-based bots (originally the WaterColorBot), with its own serial driver over `serialport` (`package.json`: `serialport ^10.5.0`, MIT). It tracks absolute pen position itself, takes positions as percentages of the work area, and exposes a simplified API for Scratch ([README](https://github.com/techninja/cncserver)). RoboPaint was the Electron painting app built on it (last push 2018). **Lessons:** it is the earliest prior art for exactly what axya is becoming, a Node HTTP server that owns the EBB. Its multi-machine "machine_types" ini configs and its tool-change (paint-well) abstraction show how to keep the machine profile separate from the driver. It predates EBB3 and has no S-curve planning.

**@thi.ng/axidraw.** A minimal Node.js controller (Apache-2.0, "ALPHA") from the thi.ng umbrella. Drawing commands are JSON-serialisable "hiccup" arrays, and `draw()` supports pause/resume/cancel, lifting the pen on pause. It enforces bounds and records metrics (draw/travel distance, pen lifts). It deliberately leaves path planning out of scope ([README](https://unpkg.com/@thi.ng/axidraw@1.1.192/README.md)). The packaged JS sends `EM,1,1`, `SC,…`, `SP,0|1,delay` and `XM,duration,a,b`, so it has no on-board acceleration (checked by grepping the npm tarball). **Lessons:** the serialisable command-list design and its cooperative pause model are a clean shape for a JS driver API. Its default port-name regex is macOS-only, which is a reminder to match ports by USB VID/PID (`04d8:fd92`) instead.

**ebb-control / p5.axidraw.** A WebSerial EBB library (MIT, v2.0.0, last published Mar 2024) wrapping essentially the whole **2.x** command set (`SM`, `XM`, `LM`, `LT`, `HM`, `QG`, `QE`, `QS`, `SR`, …) but not `T3`, `L3` or `TD` (grep of the npm tarball). p5.axidraw builds a p5.js API on top of it. **Lesson:** this is a useful typed reference for 2.x command and response parsing, and it shows the gap: no JS library targets EBB3.

**AxiDraw-Processing.** EMS's example sketches for driving the AxiDraw from Processing ([repo](https://github.com/evil-mad/AxiDraw-Processing), [EMS wiki](https://wiki.evilmadscientist.com/AxiDraw)). Community derivatives include `axidrawprocessingclient` (tested on firmware ≥ 2.5.1) and AxiTurtle. These are of historical interest only.

**Kurvengefahr.** A browser CAD/CAM tool for pen plotters (TypeScript plus a Rust/WASM planning crate, GPL-2.0, active). It previews the exact toolpath and then exports G-code or plots live over Web Serial to EBB or GRBL machines, with pause/resume and a moving playhead. Its EBB layer (`src/output/ebb/protocol.ts`) uses `LM` (gated at ≥ 2.7.0) with an `SM` fallback for older boards. Its comments say the legacy-framing quirks were "verified against real EBB 3.0.3 firmware". It ships a **`MockTransport` fake EBB** for hardware-free tests (`src/output/ebb/mock.ts`) and a Node serial transport. Its Rust crate is tested against a NumPy reference. **Lessons:** this is the closest living analogue to axya's port. Its mock transport is the missing piece axya's CLAUDE.md complains about ("there is no mock"). It shows a single codebase supporting both 2.x (`LM`/`SM`) and 3.x boards without using `T3`/`TD`.

**DrawingBotV3.** A Java/JavaFX image-to-vector art tool (GPL-3.0 with a paid Premium tier) with 50+ styles. Exports SVG, PDF, G-code and HPGL, and can drive **HPGL** plotters over serial. It has no EBB driver, so AxiDraw users export SVG and plot with other software ([README](https://github.com/SonarSonic/DrawingBotV3)). Relevant to axya only as an upstream source of SVGs.

**plotterfun.** mitxela's browser collection of image-to-vector algorithms (squiggle, StippleGen-style stippling with 2-opt TSP), each running in a Web Worker (MIT). No hardware. **Lesson:** do heavy processing in Web Workers (saxi's background planner is the same idea).

**penkit.** Paul Butler's Python generative-plotting toolkit, notebook-oriented (MIT, unmaintained since 2021). No hardware.

**Plotter.vision.** Searches found no project by this name. Treat it as **unverified or nonexistent**. Kurvengefahr (above) fills the "preview the exact toolpath in the browser" niche the name suggests.

---

## 6. axya's history and lessons

### 6.1 v1: browser-only WebSerial port of saxi (Jan–Mar 2026)

- `cb8aa40` (2026-01-25) "Add pen plotter control app for AxiDraw" added `src/lib/ebb.js` (WebSerial EBB driver), `src/lib/planning.js` (constant-acceleration planner "based on fogleman/axi/planner.py"), `src/lib/svg.js` (flatten-svg parsing) and `src/lib/vec.js`.
- `b6a905c` vendored saxi (nornagon and alexrudd2) as reference.
- `dc606e1` (2026-03-01) ported four saxi features: path sorting via `optimize-paths`; **home-on-cancel** (lift the pen, send `HM,4000`, poll `QM`); **auto-reconnect** via `navigator.serial.getPorts()` filtered on VID/PID `0x04d8:0xfd92`; and localStorage persistence.
- `c4cca64` split `App.jsx` into `state.js` and `Preview.jsx`. Then came UI iterations (`337c78c` NextDraw paper sizes, `0b431df` "Spectrolite-inspired" redesign) and an AGPL-3.0 `LICENSE` (`d1b6b63`), required because the code derived from saxi.

How it worked (`git show 7a72a11:docs/ARCHITECTURE.md`, `7a72a11:src/lib/ebb.js`):

- Pipeline: `parseSVG` → `scalePaths` (fit/margin/sort, mm→steps) → `createPlan` (trapezoid/triangle profiles, grbl-style corner velocity, backtracking for short segments; pen-down 200 mm/s² and 50 mm/s, pen-up 400 mm/s² and 200 mm/s) → `EBB.executePlan`.
- Each `Block` became one `LM` (`ebb.js:258-279`), with a CoreXY transform `(x+y, x−y)` and per-axis rate normalisation (`:286-323`). Sub-step error was carried across moves. `EM,2,2` (8× microstepping) with `stepsPerMm = 5` × multiplier. Pen lift used `S2`, servo timeout used `SR`.
- `QM` polling for idle (`:336-347`). `XM` existed as a constant-rate helper (`:329-331`), but the doc admits "axya assumes `LM` exists" with no firmware fallback.
- The README claimed support for NextDraw 8511/1117/2234, but the device constants were AxiDraw v3 only. No hardware variants (brushless servo pin, NextDraw servo range) were implemented. The old doc's own "What saxi has that axya doesn't" table lists hardware variants, pause/resume, layers, time remaining and the `XM` fallback as missing.

### 6.2 Why it was replaced (`58312f5`, 2026-05-01)

The commit message and the current ARCHITECTURE.md give the reasons:

1. **Hardware coverage**: "native support for both AxiDraw (models 1-7) and NextDraw (models 8-10)" without reimplementing per-model servo, resolution and homing details.
2. **Features for free**: pause/resume (persisted in the SVG), layer mode, path optimisation (reordering, hidden-line removal), time estimates, copies. Building all of these on WebSerial would have meant re-deriving them from saxi.
3. **Correctness ownership**: motion planning, S-curves and EBB3 semantics stay Bantam's problem.
4. **Architecture**: "Inspired by github.com/gre/penplotter-web": a server process can survive tab closes and expose a REST/SSE API.

What was lost, as listed in ARCHITECTURE.md's final section: zero install (now Node, Python and nextdraw are required), real fit-to-page and margins (now preview-only), per-path progress (now a single tqdm percentage), and instant pen up/down (about 1 s per subprocess).

### 6.3 v2 hardening (May–Oct 2026)

`84e9b8e` connection detection by regex on CLI output. `0229e1d` migration to nextdraw's `utility` modes. `734ffef` `startedAt` replacing `elapsed`. `54baaa9` process-group kill races. Then a run of input-validation and localhost-only commits (§2.6). `42c03b9` "Fix nextdraw integration bugs".

### 6.4 Lessons

- **Scraping a CLI is brittle.** Progress, pause detection, connection state and estimates all depend on matching English strings and tqdm formats (`PROGRESS_RE`, `NO_DEVICE_RE`, "Use the resume feature"; `server/plotter.js:24-36`). Every nextdraw release could break them, and `0229e1d` already happened once. A Node driver turns these into typed events.
- **Fork-per-command latency** (about 1 s per jog or pen toggle) is a UX regression a native driver removes.
- **The config-as-Python file is an attack surface.** It forced the allowlist in `server/index.js:279-331`.
- **v1's failures were about scope, not WebSerial.** v1 lacked pause/resume, hardware profiles, a firmware fallback, and any test strategy for motion. A port must arrive with those rather than rediscover them.
- **Licensing follows the source.** v1 was AGPL because of saxi. nextdraw and plotink are GPL-2.0/MIT, legacy axidraw is GPL-2.0, and the EBB firmware is BSD/GPL-3. What a Node port derives from decides axya's license.

---

## 7. Implications for axya's port

### 7.1 Support matrix

| Machine / firmware | nextdraw CLI today | Legacy axicli 3.9.x | Proposed Node port |
|---|---|---|---|
| NextDraw 8511/1117/2234 (EBB 3.x, limit switches) | Yes | No (no models 8–10) | **Primary target**: `T3`/`TD`, FIFO 16, limit-switch homing |
| AxiDraw (any) on EBB **≥ 3.0.2** | Yes (models 1–7, no homing) | Yes (`SM`) | **Primary target**: same `T3`/`TD` path, `walk_home` via `QS`/`HM` |
| AxiDraw on EBB **3.0.0–3.0.1** | **Refused** (< 3.0.2) | Yes | Detect and prompt for a firmware update. `TD` exists from 3.0.1, but 3.0.2 changed `QU` reply parsing. |
| AxiDraw on EBB **2.7.0–2.8.1** | **Refused** | Yes | Optional fallback: `LM`/`LT` constant-accel (saxi/Kurvengefahr style), FIFO depth 1, no S-curve |
| AxiDraw on EBB **2.3.0–2.6.x** | **Refused** | Yes (degraded) | Optional fallback: `XM`/`SM` timeslices (fogleman/axi style). `walk_home` needs ≥ 2.6.2. |
| EBB < 2.3.0 | Refused | Partly | Out of scope |

Recommendation: **target EBB ≥ 3.0.2 only for v1 of the port.** That is parity with today's nextdraw behaviour, so no user loses support. On connect, parse `V` and, below 3.0.2, show nextdraw's message and a link to the firmware updater. Add an `LM` fallback for 2.7+ later if users ask for it. It is a separate planner backend (trapezoid, host-paced), not a flag.

### 7.2 What to reuse

- **From nextdraw/plotink**: the planner and `TD` generation, `ebb_calc.py`, `ebb3_serial`'s connect, version and future-syntax handshake (`ebb3_serial.py:200-270`), and plotink's upstream `test/` suite as an oracle.
- **From the EBB firmware**: the ISR accumulator loop (`ebb.c:664-748`) as a bit-exact JS simulator, and the `Analysis/RegressionTests` CSVs as golden vectors (regenerate them on 3.1.x).
- **From Kurvengefahr**: the shape of a mock EBB transport and the split between Node and WebSerial transports (GPL-2.0, so take ideas, not code, unless axya relicenses).
- **From penplotter-web**: the REST/SSE surface and the HA integration contract (§2.7). Pause state persisted on disk, kept compatible with nextdraw's `<plotdata>` so files paused by either tool can be resumed by the other. The optional MJPEG camera.
- **From vpype**: real fit-to-page, margins and line merging, restoring what v2 dropped.
- **From @thi.ng/axidraw**: serialisable command lists, cooperative pause that lifts the pen, and port matching by VID/PID.

### 7.3 Risks

| Risk | Mitigation |
|---|---|
| Motion-math mismatch with nextdraw (overshoot, missed steps at high speed) | ISR simulator plus golden vectors in CI. A/B plots against nextdraw. Optionally tap the `CU,251` RC6 debug UART. |
| Firmware 3.1.0 end-of-command timing change versus the 2023 vectors | Regenerate the vectors and key expected results by firmware version. |
| Future-syntax (`CU,10,1`) response parsing differs from legacy | Always enable future syntax as nextdraw does (`ebb3_serial.py:262`). Handle replies that arrive in either syntax around the switch. |
| Silent loss of EBB-2.x AxiDraw users if the fallback is never built | Explicit version gate with a clear message. Document the legacy `axicli` 3.9.x workaround. |
| Firmware updater availability (the macOS script in the repo still flashes 2.8.1; the Bantam page is unverified) | Link to Bantam's official updater; do not ship flashing in axya initially. |
| No hardware in CI | A mock EBB transport (Kurvengefahr pattern) plus the simulator. Keep `curl /api/status` workflows working without a device. |
| Licence contamination (AGPL saxi, GPL nextdraw/Kurvengefahr) | Decide axya's licence before porting. Record provenance for each ported module. |
| Losing nextdraw-only features (hidden-line removal, `random_start`, copies, layers, `<plotdata>` format) | Inventory them against the CLI/options doc before cut-over. Keep the CLI backend selectable during transition. |
