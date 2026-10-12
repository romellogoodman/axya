# Native driver port: decision record and plan

Status: **accepted, in progress** (2026-10-12). Research is in [prior-art/](prior-art/README.md).

## Context

axya drives AxiDraw and NextDraw plotters by spawning Bantam's `nextdraw` Python CLI for every action. That costs:

- **Install:** Python plus a pip package.
- **Speed:** about 1 s of subprocess startup per pen up/down or jog.
- **Observability:** state is scraped from human-oriented log text (tqdm bars, warning strings, exit codes that don't separate pause from completion).
- **Wrapper bugs:** see [prior-art/README.md](prior-art/README.md#known-axya-bugs-found-during-research).

The driver logic is open source:

- `nextdrawcore` is GPL-2.0-or-later.
- `plotink` and the EBB firmware are MIT, BSD, and GPL-3.0.
- axya is AGPL-3.0, so a derived port is license-compatible as long as notices are kept.

## Options considered

| Option | Verdict |
|---|---|
| **A. Keep wrapping the CLI** | Lowest risk, but keeps every cost above. Rejected as the end state; kept as the fallback backend during the transition. |
| **B. Partial port**: serial layer for pen, status, and position; CLI for plotting | Fixes latency, not observability or install. Two programs contend for one USB port. Rejected. |
| **C. Restore saxi-style driver** (constant acceleration, LM/XM) | Not a NextDraw driver: no S-curves, homing, button/power polling, or resume, and different servo semantics ([saxi.md §9](prior-art/saxi.md)). Rejected. |
| **D. Browser WebSerial driver** | Zero-install, but a plot dies with the tab. It also loses server-side persistence, SSE, and multi-client control. Rejected; the transport stays swappable so this remains possible later. |
| **E. Full port of Bantam's driver to Node, server-side, verified against the Python driver as an oracle** | **Chosen.** One runtime, instant manual control, structured state, and parity with the official driver's motion. The main risk, motion-math fidelity, can be tested without hardware. |

## Decisions

1. **Port everything nextdraw does**, including the SVG digest, layer codes, optimizations, planner, pause/resume, homing, utility commands, and preview/estimate. Hidden-line removal and the Inkscape helpers (Snap Colors, Hatch) come last.
2. **Server-side Node.** Use [`serialport`](https://serialport.io) behind a `Transport` interface (a WebSerial transport is possible later). The Express API and SSE stay the contract with the frontend.
3. **TypeScript, run directly by Node.** Driver modules are `.ts` files using only erasable syntax, executed by Node's built-in type stripping (Node ≥ 22.18), with `tsc --noEmit` for checking. No build step for the server. Tests use `node --test`.
4. **Bit-faithful first, then fix.**
   - Port nextdraw's behavior exactly, quirks included, so command streams can be diffed.
   - Known bugs (e.g. the dropped single-segment polyline, unbounded `striangle`, `overrides['speed_up']` ignored) are fixed only *after* fixtures pin the original behavior.
   - Each fix is a recorded, intentional divergence.
5. **Firmware floor: EBB ≥ 3.0.2**, the same as nextdraw. On connect, parse `V` and refuse older firmware with a link to Bantam's updater. A legacy LM/XM backend for 2.x AxiDraws is out of scope unless asked for.
6. **Compatible on-disk and on-board state:**
   - Read and write `<nd:plotdata>` in nextdraw's exact format.
   - Use the same EBB RAM slots: 10–11 pen, 12 homed, 13 power, 24–31 origin.

   Files and machines can then move between axya and Bantam's tools mid-plot.
7. **Python is a dev/test dependency only.** The oracle runs the vendored nextdraw against a fake serial port. Users never need Python once the CLI backend is removed.
8. **Licensing and provenance.** Each ported file keeps the upstream copyright and license notice of its source:
   - GPL-2.0+ for nextdrawcore and ink_extensions.
   - MIT for plotink.

   It also names the source file it was derived from. A `NOTICE` file lists them.
9. **Transitional dual backend.** `PlotterManager` talks to a `Driver` interface, implemented by:
   - `CliDriver`: the current behavior.
   - `NativeDriver`: the port.

   `AXYA_DRIVER` selects between them. Native became the default on 2026-10-12, at the user's request, ahead of hardware validation; the CLI backend stays as a fallback and is deleted after validation.

## Verification strategy

There is no plotter in CI. Correctness comes from three independent checks.

1. **Python oracle (golden command streams).**
   - The vendored nextdraw runs with `plotink.ebb3_serial.serial.Serial` and `comports` replaced by a fake EBB.
   - The fake answers `v`, `QT`, `QG`, `QC`, `QE`, `QL/SL`, `QS`, `QU`, `PI`, and `ES`, and echoes everything else.
   - A virtual clock replaces the real one, and `random_start` is seeded.
   - Output: the full command stream for each fixture SVG and option set ([nextdraw-driver.md §11](prior-art/nextdraw-driver.md)).
   - The port must reproduce each stream exactly. Fixtures are committed so CI doesn't need Python; regenerating them does.
2. **Firmware simulator.**
   - A TypeScript model of the EBB motion ISR, from `ebb-firmware/source/ebb.c`, executes the port's `T3`/`TD`/`SM`/`HM` stream.
   - It asserts that predicted step positions equal simulated ones and that the carriage stays inside travel bounds.
   - It is validated against the firmware's own regression vectors in `ebb-firmware/regression-tests/`.
3. **Unit tests** for the risky arithmetic: rounding modes, float32 points, accumulator rules, the cubic solver, CoreXY signs, and bounds clamps ([nextdraw-driver.md §12.1](prior-art/nextdraw-driver.md)).

Hardware is the final gate, not the first test.

## Architecture

```
server/
  index.js             Express routes, SSE (unchanged contract)
  plotter.js           PlotterManager: state machine over a Driver
  drivers/cli.js       current nextdraw-subprocess backend (transitional)
  driver/              the port (TypeScript)
    config.ts models.ts                 options, defaults, model + handling tables
    svg/                                path parsing, units, digest, layer codes
    digest-model.ts boundsclip.ts       DocDigest/plob, crop/rotate, clipping
    optimize/                           joining, supersample, random start, reordering
    motion/ebbCalc.ts scurve.ts planner.ts   firmware math, S-curves, trajectory → T3/TD
    ebb/transport.ts commands.ts        serial framing, discovery, EBB command wrappers
    machine/pen.ts homing.ts status.ts  servo, homing/origin, status byte, motors
    run/dripfeed.ts plotdata.ts plot.ts preview.ts   execution, pause/resume, modes
    index.ts                            NativeDriver
test/
  oracle/              Python fake-EBB harness + fixture generator (dev only)
  fixtures/            SVGs, option sets, golden command streams
  sim/                 EBB ISR simulator
  *.test.ts
```

## Phases

| # | Phase | Exit criterion |
|---|---|---|
| 0 | Oracle harness, fixture corpus, TS toolchain | **Done.** 52 deterministic golden cases ([test/oracle](../test/oracle/README.md)) |
| 1 | `ebbCalc` + EBB ISR simulator | **Done.** `ebbCalc` matches Python on 33,540 vectors; simulator matches the firmware's hardware regression vectors and agrees with `ebbCalc` on every golden T3/TD |
| 2 | Config, models, handling | **Done.** Options, params and bounds match the oracle for all 36 plotting cases |
| 3 | SVG digest + layer codes + boundsclip | **Done.** Every recorded digest stage matches exactly (hidden-line removal deferred to phase 9) |
| 4 | Optimizations (join, supersample, random start, reorder) | **Done.** Matches every recorded stage, incl. CPython MT19937 random start. Known last-bit differences: macOS libm vs V8 on 4 of 45 sin/cos/tan inputs (rotate, skewX, arc sectors); tests replay CPython's values (`server/driver/svg/libm.ts`) |
| 5 | S-curve planner + command generation | **Done.** All 8,753 recorded planner calls reproduce exactly; formatted T3/TD lines equal the goldens. Known last-bit difference: macOS libm `pow(g, 2.0)` in `cubic_eqn` vs `g*g` in V8 (~0.14% of inputs); never survives the planner's float32 storage in 1M sampled calls |
| 6 | Transport, commands, pen, status, homing (against the fake EBB) | **Done.** Setup/teardown and utility streams (incl. full limit-switch homing and its failure path) match the oracle; pen timing matches every golden |
| 7 | Dripfeed, pause/resume, plotdata, utility modes, preview/estimate | **Done.** `test/run.e2e.test.ts`: every oracle case (56; hidden-line removal pending) reproduces nextdraw's full command stream with timing, messages, status code, final steps/RAM, stats and output SVG byte for byte |
| 8 | `Driver` interface over the CLI backend; `NativeDriver` wired into `PlotterManager` and the UI (instant pen/jog, position, firmware check, start-over, stop reasons) | **Done.** `AXYA_DRIVER=native|cli`; `test/server.native.test.ts` drives plot/pause/resume/stop/pen/estimate end to end against the fake EBB, and the plot stream equals the oracle's |
| 9 | Hidden-line removal, Snap Colors, Hatch | **Hidden-line removal done.** `clipping.py` plus a TypeScript port of Clipper 6.4.2 (clipper-lib's Int128 and sort differ from pyclipper), with fused multiply-add where the arm64 pyclipper build uses it, libc++ `std::sort` tie order, and CPython set order; 5 hiding cases match end to end and ~1,000 clipping vectors match exactly. Snap Colors and Hatch (Inkscape helpers) not started |
| 10 | **Hardware bring-up** (AxiDraw V3, NextDraw 2234) | Checklist: [HARDWARE_BRINGUP.md](HARDWARE_BRINGUP.md). Aids: firmware/nickname shown in the UI; `AXYA_EBB_TRACE=<file>` serial trace |

### Hardware bring-up

Run each step with a hand on the power switch:

1. Connect and run read-only queries (`V`, `QG`, `QS`, `QC`).
2. Pen up/down.
3. 1 mm jogs at low speed.
4. Homing (NextDraw).
5. A 20 mm square.
6. A fixture SVG, compared side by side with the CLI backend.
7. Button pause and resume; UI pause and resume; resume across a server restart.
8. Pull the USB cable mid-plot; cut power mid-plot.
9. Long plot soak test.

`NativeDriver` becomes the default only after this passes on each model provided. The CLI backend is deleted afterwards.

## Open questions

- Which models and firmware versions will be tested (the user is providing these at the end).
- Whether to keep nextdraw's "walk shifts the origin" semantics as-is or surface them in the UI. The current plan: keep the semantics, show the origin.
- Whether a legacy EBB 2.x backend is wanted.
