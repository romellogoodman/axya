# Architecture

**axya** is a local web UI for AxiDraw and Bantam NextDraw plotters: a React frontend and a small Express backend, started together with `npm run dev`. The backend drives the plotter through one of two **drivers**, selected with `AXYA_DRIVER`:

| Driver | What it is | Status |
|---|---|---|
| `native` (default) | axya's TypeScript port of Bantam's nextdraw driver (`server/driver/`), talking to the EiBotBoard (EBB) over USB serial directly | Matches nextdraw 1.7.5 command-for-command on every oracle case; hardware validation in progress |
| `cli` | Spawns Bantam's [`nextdraw` CLI](https://bantam.tools/nd_cli/) for every action | Fallback; removed once `native` is validated on hardware |

See [DRIVER_PORT.md](DRIVER_PORT.md) for why and how the driver was ported, and [prior-art/](prior-art/README.md) for the research behind it.

## Lineage

Earlier versions of axya were a browser-only WebSerial port of [saxi](https://github.com/nornagon/saxi). The second version was modeled on [@gre's penplotter-web](https://github.com/gre/penplotter-web), wrapping Bantam's `nextdraw` CLI. The native driver ports that CLI's internals to TypeScript so axya needs no Python. saxi, nextdraw 1.7.5, penplotter-web and the EBB firmware are vendored under `docs/reference-apps/`.

## Data flow

```
 SVG file
    │  drag-drop / upload
    ▼
 Browser ──POST /api/upload──▶ Express ── writes ──▶ db/uploads/<file>.svg
    │
    │  GET /api/files/<file> ─▶ parseSVG() client-side ─▶ canvas preview
    │
    │  POST /api/plot {file, layer?}
    ▼
 PlotterManager (server/plotter.js) ── driver.plot(file, {layer, resume}) ──▶
    native: NextDraw run in-process ──USB serial──▶ EBB
    cli:    nextdraw <file> --config … --output_file <file> …   (subprocess)
    │  progress, log lines, outcome
    ▼
 Browser ◀── SSE /api/events ── status on change ──── PlotterManager
```

### State machine

`PlotterManager` holds one of `idle | plotting | paused | error` plus `currentFile`, `currentLayer`, `progress`, `startedAt`, `connected`, `driver`, and a 200-line log ring. It emits `change` events; the SSE endpoint pushes `status()` whenever that fires. Each driver call resolves to an outcome (`complete`, `paused`, `stopped` or `error`) that drives the transition. Only one plot or manual command runs at a time.

### Plot, pause, resume, stop

- **Plot** always starts over. It first removes any `<nd:plotdata>` resume data from the file; nextdraw otherwise refuses to replot a paused file and exits 0 having done nothing.
- **Pause** leaves resume data in the SVG, so pause/resume survives a server restart or browser reload.
  - **native:** sets a flag that the run loop checks before every move.
  - **cli:** sends `SIGINT` to the `nextdraw` process group. nextdraw writes its position into the SVG's `<plotdata>` (`--output_file` points back at the same file).
  - Pressing the plotter's pause button takes the same path.
- **Resume** re-runs in `res_plot` mode, which replans the document and continues from the stored pen-down distance.
- **Stop** ends a running plot and discards the resume point.
  - **native:** a pause followed by stripping the resume data.
  - **cli:** `SIGKILL`.
  - Cancelling a paused plot also strips the data.
- **Home** is nextdraw's `walk_home` utility command. It reads the EBB step counter, so it works any time the machine is powered.

### Manual commands

Pen up/down and XY jog are nextdraw utility commands: `raise_pen`, `lower_pen`, `walk_mmx` and `walk_mmy`. Under `native` each is one short serial session. Under `cli` each forks a subprocess, which takes about 1 s.

Note that nextdraw's walk commands **shift the plot origin**: the next plot starts where the carriage was jogged to, until `walk_home`.

### Progress and estimates

- **native:**
  - Progress is pen travel so far, divided by the total from a preview run of the same plot made just before it starts.
  - Estimates run the planner in preview mode and return its statistics directly.
- **cli:**
  - Progress is parsed from nextdraw's tqdm bar on stderr.
  - Estimates parse `--preview --report_time` output.

Estimates always run on a copy of the file with the resume data removed.

### Connection detection

`connected` is `null` until the first command runs, then `true` after a successful session and `false` when no EBB is found or the USB link drops.
- **native:** status codes 101 and 104.
- **cli:** "No available nextdraw units", "Failed to connect to …" and "USB connection lost" in the output.

The sidebar shows a green or red dot for this.

### Invoking nextdraw (cli driver)

`NEXTDRAW_CMD` (default `python3 -m nextdraw`) is split on whitespace, so it spawns `python3` with `-m nextdraw` prepended to every argument list. The `nextdraw` pip package installs no standalone binary.

## The native driver (`server/driver/`)

A port of nextdraw 1.7.5's Python internals, module for module. Each file's header names its source, and [NOTICE](../NOTICE) lists provenance and licenses.

| Directory | Ports | Role |
|---|---|---|
| `config.ts`, `models.ts` | `nextdraw_conf.py`, `models.py` | Defaults, options, model and handling tables |
| `svg/` | `digest_svg.py`, ink_extensions | SVG parsing, transforms, units and layer codes |
| `digest/` | `path_objects.py`, `boundsclip.py` (`clipping.py` in progress) | Document digest, plob format, bounds clipping, hidden-line removal (in progress) |
| `optimize/` | `plot_optimizations.py`, rtree, spatial grid | Path joining, supersampling, random start (CPython-exact MT19937), reordering |
| `motion/` | `motion.py`, `plan_utils.py`, `ebb_calc.py` | S-curve planning and T3/TD command generation, with firmware-exact step arithmetic |
| `ebb/` | `ebb3_serial.py`, `ebb3_motion.py` | Serial transport (serialport), framing, EBB commands |
| `machine/` | `pen_handling.py`, `serial_utils.py`, `homing.py` | Pen/servo, status byte, motors, limit-switch homing, utility commands |
| `run/` | `nextdraw.py`, `dripfeed.py`, `preview.py`, `plot_status.py` | The run loop: modes, copies, layers, pausing, resume data, preview |

Verification is described in [DRIVER_PORT.md](DRIVER_PORT.md#verification-strategy) and [test/oracle/README.md](../test/oracle/README.md). The Python driver, run against a fake EBB, is the reference, and every case must reproduce its command stream exactly.

## Files

### Backend

| File | Role |
|---|---|
| `server/index.js` | Express app: REST routes, SSE endpoint, file upload/list/delete, config read/write, Inkscape layer extraction |
| `server/plotter.js` | `PlotterManager`: state machine, log buffer, driver selection |
| `server/drivers/native.js` | Native driver adapter: one `NextDraw` run per action |
| `server/drivers/cli.js` | CLI driver: `nextdraw` subprocesses, output parsing |
| `server/plotdata.js` | Read and strip `<plotdata>` resume data |
| `server/configFile.js` | Parse `db/nextdraw.conf.py` |
| `server/driver/` | The native driver (above) |
| `db/nextdraw.conf.py` | nextdraw-format config file (Python `key = value`), edited via the Configure modal |
| `db/uploads/` | Uploaded SVGs. Persist across restarts. Git-ignored. |

### Frontend

| File | Role |
|---|---|
| `src/App.jsx` | Root component: reducer wiring, SSE subscription, handlers, sidebar JSX, Web Notifications |
| `src/state.js` | `initialState`, `reducer`, localStorage persistence |
| `src/Preview.jsx` | Canvas preview: plotter travel area, SVG outline and paths in mm. Owns the resize observer and DPR. |
| `src/FileLibrary.jsx` | File picker modal with thumbnails, upload, delete |
| `src/ConfigModal.jsx` | Schema-driven form over the nextdraw config keys |
| `src/JogPad.jsx` | Arrow-pad XY jog, home, pen up/down |
| `src/LogPanel.jsx` | Scrolling command log with timestamps |
| `src/Modal.jsx` | Shared modal shell |
| `src/lib/api.js` | Fetch wrappers and the `subscribeStatus` SSE helper with auto-reconnect |
| `src/lib/svg.js` | `parseSVG` (DOMParser + flatten-svg → mm polylines), `PLOTTER_MODELS` travel-area table |
| `src/App.scss` | All styles. BEM. |

## REST API

| Method | Path | Body / Notes |
|---|---|---|
| GET | `/api/status` | Current `PlotterManager.status()` |
| GET | `/api/events` | SSE stream of status on change |
| GET | `/api/logs` | Last 200 log lines |
| GET | `/api/files` | `[{name, size, mtime}]` |
| GET | `/api/files/:name` | Raw SVG text |
| GET | `/api/files/:name/layers` | `[{label, number}]` from Inkscape `<g>` labels |
| POST | `/api/upload` | `?name=`, body: SVG text (`image/svg+xml`) |
| DELETE | `/api/files/:name` | |
| POST | `/api/plot` | `{file, layer?}`; always starts from the beginning |
| POST | `/api/pause` / `/api/resume` / `/api/stop` / `/api/home` | `stop` while paused cancels and discards the resume point |
| POST | `/api/pen/:dir` | `dir` = `up` or `down` |
| POST | `/api/jog` | `{dx, dy}` in mm |
| GET | `/api/estimate/:name` | `?layer=N` → `{time, drawDistance, travelDistance, totalDistance}` |
| GET/POST | `/api/config` | Parsed/serialized `nextdraw.conf.py` |

## Config keys

Written to `db/nextdraw.conf.py`. The cli driver passes the file via `--config`; the native driver reads it and splits it into options and params exactly as nextdraw does. See the [CLI reference](https://bantam.tools/nd_cli/) for full semantics.

`model`, `penlift`, `pen_pos_up/down`, `pen_rate_raise/lower`, `pen_delay_up/down`, `handling`, `speed_pendown/penup`, `accel`, `reordering`, `random_start`, `hiding`, `auto_rotate`, `copies`, `page_delay`

In nextdraw 1.x, `handling` (1 technical drawing, 2 handwriting, 3 sketching, 4 constant speed) sets resolution and constant-speed mode. Top-level `resolution` and `const_speed` keys are overwritten by it, so axya doesn't expose them. `GET /api/config` returns only allowlisted keys, because the file is executed as Python by the cli driver.

## Preview vs. plot

The sidebar offers paper presets (Letter, Legal, Tabloid, A4, A3, Arch A/B, Custom) and a margin control that draws a paper rect and a dotted margin guide on the preview, scaling the SVG to fit. This is preview-only: both drivers plot the SVG at its declared physical size. Author your SVG at the final dimensions, or use `auto_rotate`.
