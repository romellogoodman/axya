# Prior art: saxi

saxi is a TypeScript driver and web UI for EiBotBoard (EBB) pen plotters. It parses SVGs in the browser, plans motion itself, and streams low-level EBB commands over serial. Of all the prior art, it is the closest to what axya's Node port has to become. axya started as a browser WebSerial port of saxi: commit `cb8aa40` added `src/lib/ebb.js`, `planning.js`, `svg.js` and `vec.js`, and `dc606e1` ported path sorting, home-on-cancel, auto-reconnect and persistence. `58312f5` then replaced all of that with the `nextdraw` CLI wrapper.

This document covers two vendored copies:

| Abbreviation | Path | Notes |
|---|---|---|
| **N** | `docs/reference-apps/nornagon-saxi/` | Original by @nornagon, last commit 2025-01. Jest, webpack, Express 4, serialport 11. |
| **A** | `docs/reference-apps/alexrudd2-saxi/` | Maintained fork by @alexrudd2, v0.17.1, last commit 2026-10. Vitest, esbuild, Biome, Express 5, serialport 13, React 19. |

All paths below are relative to the repo root. Unless a section says otherwise, it describes **A**. Both forks are AGPL-3.0-only (`docs/reference-apps/alexrudd2-saxi/package.json`, `"license"`), and so is axya. Code can therefore be copied with attribution, and no license conflict arises.

---

## 1. Architecture

### Operating modes

saxi has three entry points (`docs/reference-apps/alexrudd2-saxi/ARCHITECTURE.md:3-8`):

1. **Server mode (default).** `saxi` with no subcommand starts Express on port 9080, serves the compiled UI, and owns the serial port (`docs/reference-apps/alexrudd2-saxi/src/cli.ts:251-274`). The browser does SVG parsing and planning, then POSTs the finished plan to the server. The server only executes it.
2. **Browser WebSerial mode.** Built with `IS_WEB=1` (`docs/reference-apps/alexrudd2-saxi/build.mjs:20`). The UI opens the EBB directly with `navigator.serial.requestPort({filters:[{usbVendorId:0x04d8, usbProductId:0xfd92}]})` (`docs/reference-apps/alexrudd2-saxi/src/drivers.ts:46-75`), and the same `EBB` class runs in the page.
3. **CLI one-shots.** `saxi plot <file>` parses the SVG with `svgdom`, plans, and calls `ebb.executePlan()` (`docs/reference-apps/alexrudd2-saxi/src/cli.ts:41-225`). `saxi pen <percent>` moves the servo (`docs/reference-apps/alexrudd2-saxi/src/cli.ts:226-250`). Both take `--hardware v3|brushless|nextdraw-2234` and `--device` (`docs/reference-apps/alexrudd2-saxi/src/cli.ts:30-40`). **N** also has `--firmware-version` (`docs/reference-apps/nornagon-saxi/src/cli.ts:42-60`).

The modes are joined by a `BaseDriver` abstraction (`docs/reference-apps/alexrudd2-saxi/src/drivers.ts:12-33`) with two implementations. `WebSerialDriver` runs the plot loop in the browser (`drivers.ts:40-178`). `SaxiDriver` sends commands to the server (`drivers.ts:185-296`). In **N** both classes live in `src/ui.tsx` (`docs/reference-apps/nornagon-saxi/src/ui.tsx:87-106`, `:108`, `:211`).

The `EBB` class takes any object with WHATWG `readable`/`writable` streams and a `close()` (`EBBPort`, `docs/reference-apps/alexrudd2-saxi/src/ebb.ts:63-67`). On Node, `SerialPortSerialPort` wraps the `serialport` package in that WebSerial-shaped interface (`docs/reference-apps/alexrudd2-saxi/src/serialport-serialport.ts:29-149`). It converts the Node stream to a `ReadableStream` (`:6-23`, `:67`) and emits `disconnect` on close (`:59`). A single driver class therefore serves both runtimes.

### Device discovery (server)

`isEBB()` matches manufacturer `SchmalzHaus` / `SchmalzHaus LLC` or VID:PID `04D8:FD92` (`docs/reference-apps/alexrudd2-saxi/src/server.ts:323-329`). An async generator `ebbs()` polls `Binding.list()` every 5 s and opens the first match at 9600 baud. It yields an `EBB`, waits for `disconnect`, yields `null`, and loops to reconnect (`server.ts:310-374`). The baud rate does not matter for USB CDC. The 9600 value copies pyserial's default (`drivers.ts:50-53`).

### UI-to-server protocol

HTTP (`docs/reference-apps/alexrudd2-saxi/src/server.ts:120-201`):

| Route | Body | Behavior |
|---|---|---|
| `POST /plot` | `Plan.serialize()` JSON | 400 if a plot is already running. Otherwise responds 200 immediately and runs the plot asynchronously. A malformed body throws inside the handler (500). |
| `GET /plot/status` | – | `{plotting: boolean}` (added in **A**, used by tests) |
| `POST /pause` | – | Arms a pause promise and broadcasts `pause:true` |
| `POST /resume` | – | Resolves the pause promise |
| `POST /cancel` | – | Aborts the plot (see §5) |

WebSocket. The server attaches `ws` to the same HTTP server. The client connects to `/chat`, though the path is not checked (`drivers.ts:206`). Messages are JSON of the form `{c, p}`:

| Direction | `c` | `p` |
|---|---|---|
| client→server | `ping` | – (sent every 30 s, `drivers.ts:211`) |
| client→server | `limp` | – (`EM,0,0`) |
| client→server | `setPenHeight` | `{height, rate}`, in raw servo units, not percent |
| client→server | `changeHardware` | `{hardware}` (**A** only) |
| server→client | `pong`, `finished`, `cancelled` | – |
| server→client | `dev` | `{path, hardware}`. In **N** the path is hard-coded to `"/dev/XXX"` (`docs/reference-apps/nornagon-saxi/src/server.ts:60`). |
| server→client | `pause` | `{paused}` |
| server→client | `progress` | `{motionIdx}` |
| server→client | `plan` | the in-flight plan, sent on connect so a reloaded tab can re-attach |

On connect, the server sends `dev`, `pause`, and, if a plot is running, `progress` and `plan` (`server.ts:101-110`). In **A** the `plan` message sends `currentPlan.toTransferable()`, which contains `ArrayBuffer`s, through `JSON.stringify`. `JSON.stringify` serializes an `ArrayBuffer` as `{}`, so the plan likely arrives empty. I inferred this from the code and did not test it. **N** sends the original request body instead (`docs/reference-apps/nornagon-saxi/src/server.ts:66`).

The SaxiDriver socket reconnects 5 s after it closes (`drivers.ts:245-251`).

---

## 2. SVG pipeline

### Parsing and flattening

The browser parses the SVG with `DOMParser`. It then attaches the SVG off-screen, because `getCTM()` returns null on detached elements and the viewBox scaling would be lost, and calls `flattenSVG()` (`docs/reference-apps/alexrudd2-saxi/src/ui.tsx:1276-1295`). The CLI uses `svgdom` instead (`cli.ts:17-21`, `:173`). `flatten-svg` (v0.3.0) walks `svg/g/a` containers and the basic shapes, applies each shape's CTM, and normalizes path data. It flattens Béziers to line segments with a default `maxError` of 0.1 user units (`node_modules/flatten-svg/dist/svg-to-paths.js:51-139`). Each `M` starts a new polyline tagged with:

- `stroke`: the shape's `stroke` attribute or style, inherited from ancestors (`svg-to-paths.js:71-84`).
- `groupId`: the `id` of the nearest ancestor `<g>` with an id (`svg-to-paths.js:85-95`). **It does not read `inkscape:groupmode="layer"` or `inkscape:label`.** Any `<g id>` counts, so nested groups split "layers" at the innermost id.

### Units and paper

Flattened coordinates are SVG user units after the CTM. saxi treats them as CSS px: `mmPerSvgUnit = 25.4/96` (`docs/reference-apps/alexrudd2-saxi/src/massager.ts:9-11`). Paper sizes are a fixed table, stored portrait (`docs/reference-apps/alexrudd2-saxi/src/paper-size.ts:32-43`): USLetter, USLegal, ArchA, A3–A6, 6x8, 5x7 and 11x14 (the last three added in **A**). Each size has `.landscape` and `.portrait` getters. The default is ArchA landscape with a 20 mm margin (`docs/reference-apps/alexrudd2-saxi/src/planning.ts:40-69`).

### `replan()` order of operations

`replan()` lives at `docs/reference-apps/alexrudd2-saxi/src/massager.ts:19-110`. In the UI it runs in a Web Worker (`docs/reference-apps/alexrudd2-saxi/src/background-planner.ts:8-18`, `ui.tsx:148-194`). The steps are:

1. **Rotate** by `rotateDrawing` degrees about the paper centre, in SVG units (`massager.ts:26-38`).
2. **Fit or crop.**
   - With `fitPage`, `scaleToPaper` computes the bounding box of all paths. It scales uniformly into `[margin, size−margin]` and centres the result (`docs/reference-apps/alexrudd2-saxi/src/util.ts:44-59`). The scale uses all paths, so the layer choice does not change it (`massager.ts:40-41`).
   - Without `fitPage`, paths are scaled px→mm 1:1. With `cropToMargins`, each polyline is clipped against the margin rectangle using Liang–Barsky and split where it leaves and re-enters (`util.ts:65-155`).
3. **Layer filter** by index, against the original `Path[]`. In `group` mode it filters on `groupId`; in `stroke` mode on `stroke`; `all` keeps everything (`massager.ts:54-58`). The UI picks `group` automatically when more than one distinct `groupId` exists, and `stroke` otherwise (`ui.tsx:197-217`).
4. **Point join**: drop consecutive points closer than `pointJoinRadius` mm (`massager.ts:60-62`, `util.ts:157-169`).
5. **Sort**: `optimize-paths`.`reorder` (`massager.ts:64-68`).
6. **Elide**: `elideShorterThan(minimumPathLength)` (`massager.ts:70-74`).
7. **Join**: `merge(paths, pathJoinRadius)`, default 0.5 mm (`massager.ts:76-80`).
8. **Convert mm to planner steps**: multiply by `device.stepsPerMm` (= 5) (`massager.ts:83`).
9. **Plan** (`massager.ts:87-106`).

**Path optimization algorithm.** `optimize-paths` 1.2.2 is also @nornagon's AGPL package, and it is not vendored. The README says only that saxi "minimizes pen-up travel time by reordering & reversing paths" (`docs/reference-apps/alexrudd2-saxi/README.md:8`). I could not verify whether `reorder` is a greedy nearest-neighbour or something better, or how `merge` chooses endpoints. Read the package before relying on it.

**Pen-up/pen-down segmentation** is simple: every surviving polyline becomes one pen-down stroke. No layer pauses or pen changes are emitted. The CLI hard-codes `layerMode: "all"` (`cli.ts:186-188`).

In the UI, changing only pen heights reuses the previous plan via `Plan.withPenHeights` instead of replanning (`ui.tsx:131-146`, `planning.ts:562-582`).

---

## 3. Motion planning

The planner is "cribbed from" fogleman/axi's `planner.py` (`docs/reference-apps/alexrudd2-saxi/src/planning.ts:1`). It is identical in both forks apart from data layout.

### Kinematic model

- **Units.** The planner works in "steps" at 5 per mm. The UI's mm/s and mm/s² values are multiplied by `stepsPerMm` before planning (`massager.ts:92-101`). The planner unit is a full-step equivalent. Microstepping is applied only at execution time (§3, step conversion).
- **Profile.** Constant acceleration (trapezoidal velocity) with no jerk limit. Each `ToolingProfile` holds separate pen-down and pen-up `AccelerationProfile`s `{acceleration, maximumVelocity, corneringFactor}`, plus servo positions and lift/drop durations (`planning.ts:83-96`). The pen-up cornering factor is always 0 (`massager.ts:100`), but pen-up moves are single straight segments anyway.
- **Plan structure.** For each path, `plan()` emits the following (`planning.ts:848-868`):

  `XYMotion(pen-up travel curPos → path start)`, `PenMotion(down)`, `XYMotion(path)`, `PenMotion(up)`

  It finishes with a pen-up travel to `penHome`. `XYMotion` is a list of constant-acceleration `Block`s, each `{accel, duration, vInitial, p1, p2}` (`planning.ts:204-247`). Every `XYMotion` starts and ends at zero velocity, so the machine fully stops at every pen lift.

### Junction (cornering) velocity

The planner uses grbl's junction-deviation heuristic (`planning.ts:602-616`, citing the onehossshay grbl post). For consecutive unit directions d₁ and d₂:

```
cos θ = −(d₁ · d₂)
if cos θ ≈ 1:  v = 0              (full reversal)
sin(θ/2) = sqrt((1 − cos θ) / 2)
if sin ≈ 1:    v = vMax           (straight through)
v_junction = min( vMax, sqrt( a · δ · sin(θ/2) / (1 − sin(θ/2)) ) )
```

δ is `corneringFactor`, default 0.127 mm × 5 = 0.635 steps (`planning.ts:153-158`). The variable named `cosine` is the cosine of the angle between −d₁ and d₂, so a straight line gives cos = −1 and sin = 1, which yields vMax.

### Segment planning

`constantAccelerationPlan()` lives at `planning.ts:765-839`. It works as follows:

1. Dedup points within ε = 1e-9 and build `Segment`s. Set each segment's `maxEntryVelocity` from the junction formula above. Append a zero-length segment so that the exit velocity is 0 (`:766-785`).
2. Walk forward. For segment *i* with entry `vInitial`, exit target `vExit = next.maxEntryVelocity`, length *d* and acceleration *a*, compute a triangle profile (`computeTriangle`, `:665-680`):

   ```
   s_accel = (2·a·d + vExit² − vInitial²) / (4a)
   s_decel = d − s_accel
   v_peak  = sqrt(vInitial² + 2·a·s_accel)
   t1 = (v_peak − vInitial)/a ;  t2 = (vExit − v_peak)/(−a)
   ```

3. Then branch on the result (`:797-828`):
   - **`s_accel < −ε`.** The segment cannot slow down to `vExit` in time. Set `maxEntryVelocity = sqrt(vExit² + 2·a·d)` and **step back one segment** (`i -= 1`) to replan the previous one. This backtracking replaces the usual separate backward pass, and the source carries a "TODO: verify this equation" (`:802`).
   - **`s_decel ≤ 0`.** Accelerate the whole way. `vFinal = sqrt(vInitial² + 2ad)`, one block. A source TODO notes that this branch does not check vMax (`:807`).
   - **`v_peak > vMax`.** Use a trapezoid (`computeTrapezoid`, `:721-740`), producing three blocks: accelerate, cruise, decelerate. `t1 = (vMax−vi)/a`, `s1 = (vMax+vi)/2·t1`, `t3 = (vf−vMax)/(−a)`, `s3 = (vf+vMax)/2·t3`, `s2 = d−s1−s3`, `t2 = s2/vMax`.
   - **Otherwise** use a triangle: two blocks.
4. Discard blocks with duration ≤ ε (`:830-837`).

Each segment yields 1–3 blocks, and each block becomes one LM command. **A** stores blocks in one interleaved `Float64Array`, 8 doubles per block, with prefix sums `ts`/`ss` for O(log n) `instant(t)` lookup (`planning.ts:307-479`). That layout is for memory and for zero-copy transfer from the worker (`:486-545`). The math is unchanged from **N**.

### Pen motions

A `PenMotion` is `{initialPos, finalPos, duration}` in raw servo units, with a **fixed** duration (`penDropDuration`/`penLiftDuration`, default 0.12 s) that does not depend on travel distance (`planning.ts:256-278`). Bantam's driver computes `move_min + move_slope × %travel` (`docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw_options/models.py:84-94`).

**N** does one extra thing. The last lift of a plot goes to the servo's extreme "up" position (0 %). After the return-home travel, a final `PenMotion` lowers the pen back to the configured pen-up height (`docs/reference-apps/nornagon-saxi/src/planning.ts:566-582`). **A** removed this.

### Step conversion (CoreXY)

The conversion happens in `executeBlockWithLM` (`docs/reference-apps/alexrudd2-saxi/src/ebb.ts:385-400`) and `moveWithAcceleration` (`:331-362`):

```
Δx_µ = (p2.x − p1.x)·stepMultiplier + errX ;  stepsX = floor(Δx_µ), errX = frac   (same for y)
axis1 = stepsX + stepsY        axis2 = stepsX − stepsY            (CoreXY / H-bot mix)
n = (x, y)/|(x, y)|
rate_axis1 = |v·(n.x + n.y)|   rate_axis2 = |v·(n.x − n.y)|       (v in µsteps/s, start and end)
```

`stepMultiplier` is 16/8/4/2/1 for EM modes 1–5 (`ebb.ts:158-168`). At the server's EM mode 1, that gives 5 × 16 = **80 µsteps/mm**, which is 2032 µsteps/in. This matches Bantam's `2 × native_res_factor(1016)` at 16× (`docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw_conf.py:237-240`, `nextdrawcore/homing.py:46-47`). The fractional remainder is carried in `this.error` across blocks and motions (`ebb.ts:85`), so rounding never accumulates. The error is carried in X/Y before the CoreXY mix.

LM rate encoding (`axisRate`, `ebb.ts:555-562`) follows the 25 kHz / 2³¹ accumulator model (`docs/reference-apps/ebb-firmware/ebb.html:1035-1094`):

```
Rate   = round(stepsPerSec · 2^31 / 25000)
t_move = 2·|steps| / (v_i + v_f)
Accel  = round((Rate_f − Rate_i) / (t_move · 25000))
LM,Rate1,Steps1,Accel1,Rate2,Steps2,Accel2
```

The step sign carries direction and the rates are always positive (the EBB flips the signs internally, `ebb.html:1060`). The optional 7th `Clear` argument is never sent.

---

## 4. Device protocol

### Transport and response parsing

Each command is written as ASCII plus `\r` (`ebb.ts:178-185`). Responses are split on `[\r\n]+` and matched FIFO against a queue of pending handlers (`ebb.ts:98-145`, `:564-575`). A line starting with `!` rejects the head of the queue. The literal startup noise `!8 Err: Unknown command 'OK:4F4B'` is ignored (`:112`). There are three request kinds:

- `query(cmd)` takes one line and no OK. Used for `V` and `QM` (`:188-194`).
- `queryM(cmd)` handles both the legacy form (data line, then `OK`) and the future-syntax form (`QB,<data>`). Used for `QB` and `QC` (`:197-210`).
- `command(cmd)` accepts `OK` (legacy) or the echoed command name (future syntax), and fails on `CMD,!…` (`:213-228`).

**A** therefore *tolerates* EBB v3 "future syntax" responses but never enables them; it never sends `CU,10,1`. **N** accepts only `OK` (`docs/reference-apps/nornagon-saxi/src/ebb.ts:112-124`).

Each command's promise resolves when the EBB *acknowledges parsing* it, not when the motion finishes. The plot loop awaits every command (`server.ts:256`). The motion FIFO is the only lookahead buffer.

### Every command saxi sends

| Command | Format sent | Where | Notes |
|---|---|---|---|
| `V` | `V` | `ebb.ts:150` | Parses the last space-separated word as `major.minor.patch`. **A** reads it eagerly in `EBB.create`; **N** reads it lazily and caches it (`nornagon-saxi/src/ebb.ts:351-359`). |
| `EM` | `EM,m,m` / `EM,0,0` | `ebb.ts:270`, `:276` | The same mode is used for both motors. The server uses `EM,1,1` (16×) in **A** (`server.ts:224`) and `EM,2,2` (8×) in **N** (`nornagon-saxi/src/server.ts:158`). The CLI `executePlan` defaults to mode 2 in both (`ebb.ts:479`). |
| `SR` | `SR,<ms>,<0\|1>` | `ebb.ts:292-300` | Sent only if fw ≥ 2.6.0. On enable: `SR,0,1`. On disable: `SR,60000000,0`. |
| `S2` | `S2,<pos>,<pin>,<rate>,<delay>` | `ebb.ts:303-306` | The only pen command. Pin 4 (RP4 = RB1) for `v3`, otherwise pin 5 (RP5 = RB2) (`ebb.html:2209` pin table). |
| `LM` | `LM,r1,s1,a1,r2,s2,a2` | `ebb.ts:318` | Sent if fw ≥ 2.5.3 (`:534-536`). |
| `XM` | `XM,<ms>,<x>,<y>` | `ebb.ts:372` | Fallback for fw < 2.5.3: the plan is sampled every 15 ms into constant-rate chunks (`:426-440`). The EBB does the CoreXY mix itself. |
| `QM` | `QM` | `ebb.ts:375-383` | Idle when `CommandStatus=0` and `FIFOStatus=0`. |
| `HM` | `HM,4000` | `server.ts:232`, `drivers.ts:131` | Cancel only (**A**). Moves to the step-counter origin, which `EM` resets, at about 4000 steps/s. |
| `CU` | `CU,4,<n>` | `ebb.ts:241-256` | **A** only, fw ≥ 3.0.0. Sets the FIFO depth to 255 (firmware clamps it), or to `SAXI_FIFO_DEPTH`. |
| `QC` | `QC` | `ebb.ts:496-503` | `queryVoltages`/`areSteppersPowered` (VIN > 6 V). Defined but not called anywhere in the plot path. |
| `QB` | `QB` | `ebb.ts:527-529` | `queryButton`. Defined but **never called**. |

**saxi never sends** `SC`, `SP`, `TP`, `SM`, `ES`, `QS`, `CS`, `QG`, `QL`/`SL`, `T3`, `TD`, `L3` or `CU,10`. I grepped both `src/` trees for each command name and found no uses outside the table above. The task brief anticipated `SC`/`SP` servo configuration; saxi does not use either. All servo control is absolute `S2`, so the EBB's own pen-up/pen-down registers are never configured.

### Firmware version handling

Two version gates exist: `supportsLM()` (≥ 2.5.3) and `supportsSR()` (≥ 2.6.0), plus the `CU,4` gate at ≥ 3.0.0 in **A**. The choice is between "LM" and "XM", and SM is never used. There is no v3-specific motion path.

### Pen servo

`executePenMotion` (`ebb.ts:451-467`):

- **A**: `rate = round(|Δpos| · 24 / durMs)` and `delay = durMs`. The S2 rate unit is pulse-width counts per 24 ms PWM cycle with the default 8 channels (`ebb.html` S2 "Slew rate"). The delay is passed unrounded, so a non-integer duration in ms would be sent as a float.
- **N**: `rate = 0` (jump on the next PWM cycle) with the same delay (`nornagon-saxi/src/ebb.ts:289-302`).

Percent-to-position mapping: `pos = round(min·t + max·(1−t))` with `t = pct/100` (`planning.ts:121-124`). **0 % is the max pulse (pen fully up) and 100 % is the min pulse (pen fully down).** That is why the defaults are "up 50, down 60" (`planning.ts:41-42`).

### Brushless / NextDraw handling (A only)

`Hardware = "v3" | "brushless" | "nextdraw-2234"` (`ebb.ts:54`). Hardware changes exactly two things:

1. The **servo pin**: 5 instead of 4 (`ebb.ts:304`).
2. The **servo range**: 5400–12600 instead of 7500–28000 (`planning.ts:128-151`).

`stepsPerMm`, accelerations, velocities and FIFO handling are the same for every model. The `*Fast` tooling profiles for brushless/NextDraw (0.08 s lift/drop, `planning.ts:170-202`) are exported but not referenced by `replan()`; only tests use `AxidrawFast`. The UI also offers `idraw-h-se` (`ui.tsx:295`). `Device()` maps it to AxiDraw servo values (`planning.ts:101`), but `setPenHeight` would drive pin 5 for it, because only the literal `"v3"` selects pin 4. That looks unintended.

### Motors, idle detection, streaming

- **Enable** (`ebb.ts:268-273`): `EM,m,m`, then `SR,0,1` to power the servo with no timeout.
- **Disable** (`:275-281`): `EM,0,0`, then `SR,…,0`. The comment says "60 seconds", but `setServoPowerTimeout` takes seconds and multiplies by 1000, so `60000` becomes `SR,60000000,0` (about 16.7 h). The manual `setPenHeight` path similarly sends `SR,10000000,1` (`server.ts:89-91`). Both forks have this bug, and the A test suite encodes the value: it asserts `SR,60000000,0` is absent during a pause, and a commented-out assertion expects it after the plot (`src/__tests__/server.test.ts:137`, `:149`). It is mostly harmless, because state 0 cuts power immediately.
- **Idle wait** (`ebb.ts:375-383`): a tight `while(true)` `QM` loop with **no sleep**, which saturates the serial link while it waits.
- **Streaming.** The host sends one command per block and awaits each ack. With fw < 3 the FIFO is one command deep, so throughput depends on host latency. **A**'s `CU,4,255` lets the board buffer up to the firmware maximum, which removes stutter (`ebb.ts:230-240`). A side effect is that `motionIdx` progress and pause/cancel decisions now run ahead of the physical pen by up to the FIFO depth. That follows from the code, but I have not measured it.

---

## 5. Plot control

The server implementation is `doPlot` (`docs/reference-apps/alexrudd2-saxi/src/server.ts:242-283`). The WebSerial one is `WebSerialDriver.plot` (`drivers.ts:102-140`).

**Start.** `prePlot` sends `CU,4`, then `EM,1,1`, then `S2,<firstPenMotion.initialPos>,pin,1000,1000`, which raises the pen to the plan's pen-up height (`server.ts:222-226`).

**Progress.** `progress {motionIdx}` is broadcast before each motion (`server.ts:254`). The UI timestamps that message and animates a crosshair by calling `motion.instant(elapsed)` on the current XYMotion every animation frame (`ui.tsx:618-660`). The remaining-time display is `plan.duration(motionIdx)` (`ui.tsx:548-558`). The firmware is never queried for position (`QS`), so progress is entirely open-loop.

**Pause.** `/pause` creates an unresolved promise. The loop checks it only **after a motion completes and only if the pen is up** (`penIsUp = initialPos < finalPos`, which holds because "up" positions have larger pulse widths on all supported servos) (`server.ts:258-265`). In practice the plotter stops after the current stroke's pen lift, never mid-stroke. Motors stay energized during the pause, so position is held, and nothing is written anywhere. The physical button (`QB`) is not polled.

**Resume.** `/resume` resolves the promise, and the loop continues with the next motion. **Pause state lives only in server memory**: the `unpaused` promise, `currentPlan` and `motionIdx` are closure variables (`server.ts:67-74`). A browser reload can re-attach through the `plan`/`progress` messages. A server restart or USB disconnect loses the plot entirely, and there is no resume-from-index or resume-by-distance feature.

**Cancel.**

- **A, server** (`server.ts:171-183`, `:271-276`, `:230-234`). `/cancel` aborts an `AbortController` and calls `ebb.cancel()`, which rejects every pending command promise and marks them so their late responses are silently drained (`ebb.ts:261-266`, `:119-122`). The plot loop races each motion against the abort, so it exits mid-motion. `postCancel` then sends `S2,<initial pen-up pos>,pin,1000`, `HM,4000` and a `QM` wait. Finally `postPlot` waits for idle and sends `EM,0,0` and `SR`. Commands already queued in the EBB FIFO **still execute**, because `HM` waits for prior motion (`ebb.html:957`). With a 255-deep FIFO the plotter may finish a noticeable amount of drawing before it homes, and that tail may be pen-down. I infer this from the firmware docs and did not test it.
- **A, WebSerial** (`drivers.ts:120-134`). The cancel flag is checked between motions. The driver raises the pen and sends `HM,4000` **only if the pen was down** at that point. When cancel lands after a pen-up motion, there is no homing.
- **N** (`nornagon-saxi/src/server.ts:112-119`, `:164-166`, `:210-218`). The cancel flag is checked between motions. The driver raises the pen to 0 % (fully up) and does **not** home.

axya's earlier "home-on-cancel" port (`dc606e1`) corresponds to the **A** behavior.

**Simulation.** **N** had a `simPlotter` that sleeps for each motion's duration when no EBB is attached (`nornagon-saxi/src/server.ts:173-187`). **A** instead opens the *test* mock serial port in production code (`server.ts:19`, `:152`). This imports `vitest`'s `vi` at runtime and runs at mock speed rather than real time.

---

## 6. Device and model tables

### Hardware variants (A, `planning.ts:98-151`, `ebb.ts:304`)

| `hardware` | Label in UI | S2 pin | Servo min (down) | Servo max (up) | stepsPerMm (planner) |
|---|---|---|---|---|---|
| `v3` (default) | AxiDraw V3 | 4 (RB1) | 7500 | 28000 | 5 |
| `brushless` | AxiDraw V3 Brushless | 5 (RB2) | 5400 | 12600 | 5 |
| `nextdraw-2234` | NextDraw 2234 | 5 (RB2) | 5400 | 12600 | 5 |
| `idraw-h-se` | iDraw H SE (UI only) | 5 (see §4) | 7500 | 28000 | 5 |

**N** has only `Device.Axidraw` (7500/28000, pin 4) (`nornagon-saxi/src/planning.ts:90-105`).

Servo units are 1/12 MHz ≈ 83.3 ns. 7500 is about 0.63 ms and 28000 about 2.33 ms.

### Motion defaults (`planning.ts:40-69`; identical in N)

| Parameter | Pen down | Pen up |
|---|---|---|
| Max velocity | 50 mm/s | 200 mm/s |
| Acceleration | 200 mm/s² | 400 mm/s² |
| Cornering factor (δ) | 0.127 mm | 0 |
| Servo transition time | 0.12 s (drop) | 0.12 s (lift) |
| Height | 60 % | 50 % |

Other defaults: margin 20 mm, `pathJoinRadius` 0.5 mm, `pointJoinRadius` 0, `sortPaths` true, `fitPage` true, `cropToMargins` true, `minimumPathLength` 0, `penHome` (0,0). `penHome` exists in **A** only (`planning.ts:68`).

### Travel limits

**saxi has none.** No per-model travel envelope exists. Moves are bounded only by the paper rectangle, with `fitPage`/`cropToMargins` applied. With `fitPage` off and `cropToMargins` off, a large SVG will be driven past the hard stops. The UI's `penHome` inputs are labelled mm but cap at `paper × stepsPerMm` (`ui.tsx:347`, `:363`). For comparison, Bantam lists AxiDraw V3 at 11.81 × 8.58 in and NextDraw 2234 at 34.02 × 23.39 in (`docs/reference-apps/nextdraw-1.7.5/nextdrawcore/nextdraw_options/models.py:139-227`).

---

## 7. Fork differences

| Area | nornagon (N) | alexrudd2 (A) |
|---|---|---|
| Hardware models | AxiDraw only | `v3`, `brushless`, `nextdraw-2234`, plus `idraw-h-se` in the UI; `changeHardware` WS message; `--hardware` CLI flag |
| Servo pin | always 4 | 4 for `v3`, else 5 |
| Pen motion S2 | `rate=0`, `delay=dur` | `rate=|Δ|·24/durMs`, `delay=dur` |
| Final pen lift | goes to 0 % (max up), then back to pen-up height after homing | normal pen-up height; no extra motion |
| Pen home | always (0,0) | configurable `penHome` |
| Server microstepping | `EM,2,2` (8×) | `EM,1,1` (16×) |
| FIFO depth | default (1) | `CU,4,255` on fw ≥ 3.0.0, `SAXI_FIFO_DEPTH` override |
| Response parsing | legacy `OK` only; generator-based queue | legacy or future-syntax; cancellable promise queue; ignores the startup `OK:4F4B` error |
| Firmware version | lazy, cached, async `supportsLM()` | eager in `EBB.create`, sync `supportsLM()` |
| Cancel | flag checked between motions; pen to 0 %; no homing | `AbortController` mid-motion abort; pen up, `HM,4000`, wait idle |
| Plot status | – | `GET /plot/status` |
| No-device simulation | `simPlotter` with real-time sleeps | test mock serial port |
| XYMotion storage | `Block[]` objects | flat `Float64Array` columns with transferable buffers |
| Paper sizes | 7 | 10 (adds 6x8, 5x7, 11x14) |
| Driver classes | inside `ui.tsx` | `drivers.ts` with a `BaseDriver` abstract class |
| CLI | `--firmware-version` | `pen <percent>` subcommand; custom `WxH(mm\|cm\|in)` paper sizes. The unit is parsed but **ignored**: the numbers are used as mm (`cli.ts:58-61`). |
| Tooling | Jest, ts-jest, webpack, ESLint, Express 4, serialport 11, flatten-svg 0.2 | Vitest, supertest, esbuild, Biome, TS 7, Express 5, serialport 13, flatten-svg 0.3 |

The planner math (junction velocity, triangle/trapezoid, backtracking) and the LM/XM encoding did not change between forks.

---

## 8. Tests (A)

The runner is Vitest, configured for `src/__tests__/*.test.ts` in a node environment (`docs/reference-apps/alexrudd2-saxi/vitest.config.ts`).

- **`ebb.test.ts`** (`src/__tests__/ebb.test.ts:1-36`). Covers firmware version parsing (`"test 2.5.3"` → `[2,5,3]`, `V` sent) and that `enableMotors(2)` sends `EM,2,2`. That is the whole file: no LM encoding, error-path or cancel tests.
- **`planning.test.ts`** (`:1-88`). Checks the motion sequence (start/end points and pen state) for a single point, a line, and two lines. One property test checks that a collinear "fake point" does not slow the move (`:65-87`), which exercises the junction-velocity straight-through case. The empty-input test is skipped (`:11`).
- **`server.test.ts`** (`:1-167`). Starts the real Express server on port 0 with `supertest`. It mocks `SerialPortSerialPort` and replaces `waitForEbb` with `/dev/ttyMOCK` via the module self-import hack (`server.ts:23`, `:351`). Tests: plot accepted and `EM,1,1` logged; malformed or empty body → 500; concurrent plot → 400; cancel; pause/resume; `/plot/status` transitions. The assertions are coarse ("contains `EM,1,1`"). One assertion is commented out with "FIXME: Is this a real bug on Windows?" (`:148-149`).
- **`util.test.ts`**: `cropToMargins` cases, including split lines and edge-inclusive margins (`:7-59`).

### The serial mock

The mock is at `src/__tests__/mocks/serialport.ts:1-59`. It is a plain object with WHATWG `readable`/`writable` streams. The writable side decodes each chunk, trims it, and records it in a shared `mockSerialPortInstance.commands` array. After 2 ms it enqueues a canned reply on the readable side:

| Prefix | Reply |
|---|---|
| `V` | `test 2.5.3` |
| `QM` | `1,0,0,0,0` (the first field stands in for `QM`; the parser skips it) |
| `QB` | `0` |
| `QP` | `1` |
| `QE`, `QS` | `0,0` |
| `ST` | `1` |
| anything else | `OK` |

Limitations to fix in axya's version:

- The mock reports fw 2.5.3, so the `CU,4` and v3 paths are never exercised.
- `QM` always reports idle, so FIFO back-pressure is never simulated.
- It has no notion of time, position or step counts, so motion cannot be checked against the plan.
- It cannot inject `!` errors or disconnects.
- State is module-global.

**N** instead used `@serialport/binding-mock` with `record: true`, asserting raw bytes such as `"EM,2,2\rV\r"` (`docs/reference-apps/nornagon-saxi/src/__tests__/ebb.test.ts:1-43`). Because it mocks at the binding layer, it would also exercise `SerialPortSerialPort`.

---

## 9. Gaps versus Bantam's nextdraw driver

Bantam's driver is covered in another doc. Below are only the points where saxi lacks something or disagrees.

**Missing EBB v3 features.** saxi uses none of these:

- `T3`/`TD` jerk-limited (S-curve) moves (`ebb.html:2783`, `:2839`). saxi has only constant acceleration, while Bantam's handlers specify jerk values (`models.py:101-131`).
- `L3`, and `LM`'s `Clear` argument.
- Limit-switch / automatic homing. NextDraw models set `auto_home = True` (`models.py:208`, `:217`, `:226`). saxi's only "homing" is `HM` back to wherever `EM` was last issued, so the carriage must be manually parked at the origin before every plot.
- `QG` button/status polling (`ebb.html:1787`). Even `QB` is defined but never called, so the hardware pause button does nothing.
- `SL`/`QL` variables (`ebb.html:2503`, `:1885`), which Bantam uses to persist pen-state codes (`pen_handling.py:470-471`).
- `SC`/`SP` pen configuration. Bantam programs pen-up/down positions and rates with `SC,4`/`SC,5`/`SC,11`/`SC,12` and raises with `SP` (`docs/reference-apps/nextdraw-1.7.5/plotink/ebb3_motion.py:233-329`).
- Future syntax mode (`CU,10,1`).
- `QS` position readback.
- Resume by distance: Bantam stores progress in the SVG and resumes after restart. saxi's resume is in-memory only and is lost on restart (§5).
- Layer pauses, pen changes, multi-copy plots and per-layer speeds.

**Disagreements with Bantam.**

| Topic | saxi | Bantam nextdraw 1.7.5 |
|---|---|---|
| Brushless servo range | 5400–12600 (A, `planning.ts:131-132`) | 5400–12600 (`models.py:90-91`). **They agree.** |
| Standard servo range | 7500–28000 | 9855–27831 (`models.py:82-83`) |
| Percent direction | 0 % = max pulse (up), 100 % = min (down) | `pos = min + (max−min)·pct/100`, so 0 % = down and 100 % = up (`pen_handling.py:422-441`) |
| Brushless PWM channels | default 8 channels (24 ms repeat); S2 rate math assumes 24 ms | `SC,8,1` for brushless, giving a 3 ms repeat (`pen_handling.py:461-464`) |
| Servo power timeout | `SR` in ms but called as if seconds → `SR,60000000,0` | `servo_timeout` applied to the standard servo only (`pen_handling.py:465-466`) |
| Lift/drop timing | fixed 0.12 s | `move_min + move_slope × Δ%` per motor type (`models.py:84-94`) |
| Step resolution | 80 µsteps/mm at 16× | 2032 steps/in at 16×, which is the same value |
| Model awareness | 3 hardware ids, no travel limits | 10 models with travel limits, z-motor type and auto-home flags |
| NextDraw sizes | only `nextdraw-2234` | 8511, 1117 and 2234 |

The percent-direction difference means a user who moves between saxi-style and Bantam-style settings would need to invert their pen heights. axya's Configure modal currently uses Bantam's semantics.

---

## 10. What axya should borrow

### Borrow

- **The `EBB` class structure** (`ebb.ts`). Take the `EBBPort` stream interface, the FIFO promise queue with legacy and future response tolerance, the cancellation of in-flight promises with sentinel draining (`:119-122`, `:261-266`), the version gates, and `configureFifoDepth`. Fix the `SR` units bug and the busy `QM` loop.
- **LM encoding**: `axisRate` and `moveWithAcceleration`, including the CoreXY mix and the fractional-step error carry (`ebb.ts:331-400`, `:555-562`). Test this code first, because it is small, correct, and has no tests yet.
- **`SerialPortSerialPort`** (`serialport-serialport.ts`) as the Node adapter. It lets the same driver also run against the WebSerial API or a mock.
- **Device discovery and reconnect**: `isEBB` and the `ebbs()` async generator (`server.ts:323-374`).
- **The planner** (`planning.ts:602-868`) as a baseline: junction velocity plus triangle/trapezoid blocks, with the columnar `XYMotion` and `instant(t)` for preview and progress. Keep it as the constant-acceleration fallback even if axya later adds T3 S-curves.
- **SVG prep**: `scaleToPaper`, the Liang–Barsky `cropToMargins`, `dedupPoints` and rotation (`util.ts`, `massager.ts`), together with `util.test.ts`.
- **The test approach**: a stream-level mock recording commands, plus supertest against the real server. Build a richer mock than saxi's: configurable firmware version, simulated `QM` FIFO state, step-counter tracking for `QS`/`HM`, error and disconnect injection, and per-test instances.

### Do not borrow

- **Pen-percent semantics and the 7500–28000 standard range.** Use Bantam's `models.py` values and its direction (0 % = down).
- **`S2`-only pen control without `SC,8,1` for brushless.** Use Bantam's SC/SP flow or at least its PWM channel configuration.
- **In-memory pause/resume.** axya currently survives restarts because state lives in the SVG, and a port should keep that property by persisting the motion index or distance.
- **The pause semantics**: waiting for a pen-up, and no hardware button. Also the open-loop `motionIdx` progress with a deep FIFO; use `QS`/`QM` or account for FIFO depth.
- **Cancel via `HM` while the FIFO is still full.** Clear the queue first (v3 has `ES`), raise the pen immediately, then home.
- **The test mock imported into production** (`server.ts:19`, `:152`) as the no-device path.
- **`groupId`-as-layer.** axya already extracts Inkscape layers server-side, and should keep using `inkscape:groupmode="layer"`.
- **The absence of travel limits.** Clamp every move to the model's envelope.
- **`optimize-paths`** as a black box. Read or replace it before adopting it (§2).
