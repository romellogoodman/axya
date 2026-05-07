# Architecture

**axya** is a local web UI for AxiDraw and Bantam NextDraw plotters. It consists of a React frontend and a small Express backend, both started together with `npm run dev`. The backend does not speak to the plotter directly — every operation spawns Bantam's official [`nextdraw` CLI](https://bantam.tools/nd_cli/), which owns all SVG parsing, motion planning, path optimization, and EBB serial communication.

## Lineage

Earlier versions of axya were a browser-only WebSerial port of [saxi](https://github.com/nornagon/saxi). The current architecture is modeled on [@gre's penplotter-web](https://github.com/gre/penplotter-web), which wraps `axicli` in a FastAPI server. axya uses Node/Express instead of Python, and `nextdraw` instead of `axicli` so that Bantam NextDraw hardware is supported alongside AxiDraw.

saxi sources are still vendored under `docs/reference-apps/` for reference.

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
 Express ── spawn ──▶ nextdraw <file> --config db/nextdraw.conf.py
                               --output_file <file> --progress --report_time
    │                          [--mode layers --layer N]
    │  stderr (tqdm) ─▶ regex parse % ─▶ PlotterManager.progress
    │  stdout/stderr lines ─▶ PlotterManager.logs (ring buffer)
    ▼
 Browser ◀── SSE /api/events ── status_dict on change ──── PlotterManager
```

### State machine

`PlotterManager` (server/plotter.js) holds one of `idle | plotting | paused | error` plus `currentFile`, `progress`, `elapsed`, `canHome`, and a 200-line log ring. It emits `change` events; the SSE endpoint pushes `status()` to clients whenever that fires.

### Pause/Resume

Pause sends `SIGINT` to the `nextdraw` process group. `nextdraw` traps it, writes the current position into the SVG's `<plotdata>` element (because `--output_file` points back at the same file), and exits. Resume is a fresh subprocess with `--mode res_plot`, which reads that saved state and continues from where it stopped. This means **pause/resume survives a server restart or browser reload** — the state lives in the SVG file on disk.

Stop is `SIGKILL`. Home is `--mode utility --utility_cmd walk_home`, which uses the saved state to plan a return-to-origin move.

### Manual commands

Pen up/down and XY jog spawn `nextdraw` with `--mode utility --utility_cmd raise_pen|lower_pen|walk_mmx|walk_mmy`. Manual commands need a file argument even though they don't read it, so the server writes a 1×1 dummy SVG to `/tmp` at startup.

### Connection detection

`PlotterManager.connected` is `null` until the first command runs, then `true` on a clean exit or `false` when the output matches `NO_DEVICE_RE` (e.g. "No available nextdraw units found on USB"). The sidebar shows a green/red dot reflecting this.

### Invoking nextdraw

`NEXTDRAW_CMD` is split on whitespace so the executable can be multi-word — e.g. `NEXTDRAW_CMD='python3 -m nextdraw'` (the default in `package.json`) spawns `python3` with `-m nextdraw` prepended to every arg list. The `nextdraw` pip package doesn't install a standalone binary; it only exposes the Python module.

## Files

### Backend

| File | Role |
|---|---|
| `server/index.js` | Express app. REST routes, SSE endpoint, file upload/list/delete, config read/write, Inkscape layer extraction. |
| `server/plotter.js` | `PlotterManager` — state machine, subprocess spawning, log buffer, progress parsing. |
| `db/nextdraw.conf.py` | nextdraw-native config file (Python `key = value` syntax). Edited via the Configure modal. |
| `db/uploads/` | Uploaded SVGs. Persists across restarts. Git-ignored. |

### Frontend

| File | Role |
|---|---|
| `src/App.jsx` | Root component. Reducer wiring, SSE subscription, handlers, sidebar JSX, Web Notifications. |
| `src/state.js` | `initialState`, `reducer`, localStorage persistence. |
| `src/Preview.jsx` | Canvas preview — plotter travel area + SVG outline + paths in mm. Owns resize observer + DPR. |
| `src/FileLibrary.jsx` | File picker modal with thumbnails, upload, delete. |
| `src/ConfigModal.jsx` | Schema-driven form over the nextdraw config keys. |
| `src/JogPad.jsx` | Arrow-pad XY jog + home + pen up/down. |
| `src/LogPanel.jsx` | Scrolling command log with timestamps. |
| `src/Modal.jsx` | Shared modal shell. |
| `src/lib/api.js` | Fetch wrappers + `subscribeStatus` SSE helper with auto-reconnect. |
| `src/lib/svg.js` | `parseSVG` (DOMParser + flatten-svg → mm polylines), `PLOTTER_MODELS` travel-area table. |
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
| POST | `/api/upload` | multipart `file` |
| DELETE | `/api/files/:name` | |
| POST | `/api/plot` | `{file, layer?}` |
| POST | `/api/pause` / `/api/resume` / `/api/stop` / `/api/home` | |
| POST | `/api/pen/:dir` | `dir` = `up` or `down` |
| POST | `/api/jog` | `{dx, dy}` in mm |
| GET | `/api/estimate/:name` | `?layer=N` → `{time, drawDistance, travelDistance, totalDistance}` |
| GET/POST | `/api/config` | Parsed/serialized `nextdraw.conf.py` |

## Config keys

Written to `db/nextdraw.conf.py` and passed to every `nextdraw` invocation via `--config`. See the [CLI reference](https://bantam.tools/nd_cli/) for full semantics.

`model`, `penlift`, `pen_pos_up/down`, `pen_rate_raise/lower`, `pen_delay_up/down`, `speed_pendown/penup`, `accel`, `const_speed`, `reordering`, `random_start`, `hiding`, `auto_rotate`, `copies`, `page_delay`, `resolution`

## What the earlier WebSerial version had that this doesn't

- **Zero-install** — the old version ran entirely in Chrome via WebSerial. This one needs Node, Python, and `nextdraw` installed.
- **Fit-to-page / margins** — the sidebar offers paper presets (Letter, Legal, Tabloid, A4, A3, Arch A/B, Custom) and a margin control that draws a paper rect and dotted margin guide on the preview and scales the SVG to fit. This is preview-only; `nextdraw` still plots the SVG at its declared physical size, so author your SVG at the final dimensions (or use `auto_rotate`).
- **Per-path progress overlay** — the old canvas recolored completed paths. Progress from `nextdraw` is a single percentage, so the new preview shows a top progress bar instead.
- **Instant pen up/down** — each manual command now forks a subprocess (~1s) rather than sending a serial byte.
