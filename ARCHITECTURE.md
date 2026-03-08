# Architecture

**axya** is a browser-only AxiDraw controller. It talks directly to the plotter over USB via the [WebSerial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) — no server, no Node, no installation. The trade-off is Chrome/Edge only.

## Lineage

axya is a simplified port of [saxi](https://github.com/nornagon/saxi) (original, archived) and its [active fork](https://github.com/alexrudd2/saxi). Both are vendored under `reference/` for comparison.

saxi has two operating modes selected at build time:

- **Server mode** — an Express + WebSocket server drives `node-serialport`; the browser is a thin client. Useful for tethering the plotter to a Raspberry Pi and controlling it from any device on the network.
- **WebSerial mode** (`IS_WEB=1`) — static files only; the browser drives the EBB directly.

**axya implements only the WebSerial mode.** There is no server, no `SaxiDriver`/`WebSerialDriver` abstraction layer, no serialization of plans over the wire.

## Data flow

```
  SVG file (drop / upload)
           │
           ▼
   parseSVG()  ──────────  flatten-svg → polylines as {x,y}[][]
           │
           ▼  state.rawPaths
   scalePaths()  ─────────  fit-to-paper + margin, mm → steps,
           │                optimize-paths reorder (minimize pen-up travel)
           │
           ▼  state.scaledPaths
   createPlan()  ─────────  constant-accel velocity profiles,
           │                interleave XYMotion / PenMotion
           │
           ▼  state.plan
   EBB.executePlan()  ────  stream LM / S2 commands over serial
```

Each stage invalidates downstream stages: changing paper size nulls `scaledPaths` and `plan`, changing pen heights nulls only `plan`. Two effects in `App.jsx` watch these dependencies and recompute.

## Files

### UI

| File | Role |
|---|---|
| `src/App.jsx` | Root component. Owns the reducer, pipeline effects, EBB connection handlers, and sidebar JSX. |
| `src/Preview.jsx` | Canvas preview. Draws paper outline, margin guide, paths, and a green progress overlay during plotting. Owns its own resize observer and handles DPR scaling. Props-only, no context. |
| `src/state.js` | `initialState`, `reducer`, and localStorage persistence. Pure — no React imports. |
| `src/App.scss` | All styles. BEM naming. |

### Library

| File | Role |
|---|---|
| `src/lib/svg.js` | `parseSVG` (DOMParser → `flatten-svg`), `scalePaths` (fit/margin/sort → step coords), `PaperSizes` presets. |
| `src/lib/planning.js` | Constant-acceleration motion planner. `Block` / `XYMotion` / `PenMotion` / `Plan` classes, `createPlan()` entry point, `Device` hardware constants. Ported from [fogleman/axi](https://github.com/fogleman/axi/blob/master/axi/planner.py). |
| `src/lib/ebb.js` | WebSerial driver for the EiBotBoard. Connection (incl. auto-reconnect), firmware queries, motor/servo commands, `executePlan` with abort handling. |
| `src/lib/vec.js` | 2D vector math (`vadd`, `vsub`, `vmul`, `vnorm`, `vdot`, `vlen`). |

## Motion planning

`createPlan` builds a `Plan` — a flat list of `Motion` objects that alternate between moving the pen (`XYMotion`) and raising/lowering it (`PenMotion`):

```
[ travel-to-path₁, pen-down, draw-path₁, pen-up,
  travel-to-path₂, pen-down, draw-path₂, pen-up,
  ...
  travel-home ]
```

Each `XYMotion` is a list of `Block`s. A `Block` is a straight-line segment with constant acceleration: `{accel, duration, vInitial, p1, p2}`. `constantAccelerationPlan()` fits each polyline segment with either a **triangle** (accelerate then decelerate) or **trapezoid** (accelerate, cruise at vMax, decelerate) velocity profile.

**Corner velocity** at each vertex is derived from the angle between adjacent segments (grbl-style cornering): sharp corners force a near-stop, gentle curves stay fast. If a segment is too short to decelerate in time for the next corner, the planner backtracks and lowers the *previous* segment's entry velocity.

Two acceleration profiles:
- **Pen down** (drawing) — slower, with cornering: `accel=200mm/s², vMax=50mm/s`
- **Pen up** (travel) — faster, no cornering: `accel=400mm/s², vMax=200mm/s`

All units convert to **steps** before planning (`stepsPerMm = 5` for AxiDraw v3).

## EBB serial protocol

The EiBotBoard is the USB motion controller inside the AxiDraw. Commands are `\r`-terminated ASCII; responses are `OK` or `!`-prefixed errors. [Full command reference](https://evil-mad.github.io/EggBot/ebb.html).

Commands axya uses:

| Command | Purpose |
|---|---|
| `V` | Query firmware version string |
| `QC` | Query voltages (detect stepper power) |
| `QM` | Query motor status (poll for idle) |
| `EM,m,m` | Enable/disable motors; `m` is microstepping mode (1 = 1/16, 0 = off) |
| `LM,r₁,s₁,Δr₁,r₂,s₂,Δr₂` | Low-level move — constant-acceleration step timing computed on-board. Requires firmware ≥ 2.5.3. Each `Block` becomes one `LM`. |
| `S2,pos,pin,rate,delay` | Set servo (pen lift). `pos` is a PWM value; `Device.penPctToPos()` maps 0–100% to the servo range. |
| `SR,timeout,state` | Servo power timeout (firmware ≥ 2.6.0). Keeps the servo from buzzing when idle. |
| `HM,rate` | Home the carriage to origin at `rate` steps/sec. Used on cancel. |

**Sub-step error accumulation:** `LM` takes integer step counts, but `Block` positions are floats. `this.error` carries the fractional remainder across moves so rounding doesn't drift over a long plot.

**Coordinate transform:** AxiDraw uses a CoreXY belt layout. Cartesian `(x, y)` steps map to motor-axis steps as `(x+y, x−y)`. `moveWithAcceleration` handles this.

**Auto-reconnect:** `navigator.serial.getPorts()` returns previously-paired devices without a user gesture. `EBB.tryAutoConnect()` filters for the EBB's VID/PID (`0x04d8:0xfd92`) and opens it on mount.

**Cancel behavior:** `executePlan` tracks whether the pen is up. On abort: lifts pen if down → `HM,4000` to send the carriage home → polls `QM` until idle → disables motors.

## What saxi has that axya doesn't

See `reference/alexrudd2-saxi/src/` for implementations.

| Feature | saxi file | Why you might want it |
|---|---|---|
| **Web Worker planning** | `ui.tsx` `usePlan()`, `background-planner.ts` | Planning runs off the main thread so the UI stays responsive on large SVGs. axya plans synchronously — fine until it isn't. |
| **Pause/Resume** | `drivers.ts` `pause()` | The plot loop awaits an unresolved Promise but only when `penIsUp` — never pauses mid-stroke. Useful for long plots. |
| **Rejigger** | `ui.tsx` `attemptRejigger()` | If only pen heights changed, swap servo positions in the existing plan instead of replanning from scratch. |
| **Layer filtering** | `ui.tsx` `LayerSelector`, `massager.ts` | Filter paths by SVG `stroke` color or `groupId`. Multi-select which layers to plot. Essential for multi-pen workflows. |
| **Crop to margins** | `util.ts` `cropToMargins()` | Liang-Barsky segment-AABB clipping. When `fitPage` is off, trims anything outside the margin instead of plotting it. |
| **Path joining / point dedup** | `massager.ts` | `optimize-paths` `merge()` joins paths whose endpoints are within a radius (fewer pen lifts). `dedupPoints()` collapses near-duplicate vertices. |
| **Live pen position** | `ui.tsx` `PlanPreview` | `requestAnimationFrame` + `motion.instant(t)` interpolates a crosshair between progress events. axya just recolors completed paths. |
| **Hardware variants** | `planning.ts` `Device()`, `ebb.ts` | Different servo PWM ranges for v3 / brushless / NextDraw. Brushless uses servo output pin 5 instead of 4, and shorter pen lift timing. |
| **Time remaining** | `ui.tsx` `TimeLeft` | `plan.duration(fromMotionIdx)` minus elapsed-since-last-progress-event. |
| **`XM` fallback** | `ebb.ts` `executeXYMotionWithXM()` | 15ms-timestep constant-velocity moves for firmware < 2.5.3. axya assumes `LM` exists. |

## Constants

| Constant | Value | Source |
|---|---|---|
| SVG px → mm | `25.4 / 96 ≈ 0.2646` | CSS spec: 1px = 1/96 inch |
| Steps per mm | `5` | AxiDraw v3 hardware |
| Servo range (v3) | `7500` (down) – `28000` (up) | 83ns-resolution PWM units |
| EBB USB | VID `0x04d8`, PID `0xfd92` | SchmalzHaus |
| Baud rate | `9600` | EBB default |
| `LM` firmware req | `≥ 2.5.3` | |
| `SR` firmware req | `≥ 2.6.0` | |
