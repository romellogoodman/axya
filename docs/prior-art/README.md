# Prior art

Research into how pen-plotter drivers work: what exists, what each piece does, and what axya can take. It was written before porting Bantam's NextDraw driver from Python to Node. The decision record and plan built on it are in [../DRIVER_PORT.md](../DRIVER_PORT.md).

## Documents

| Doc | Read it for |
|---|---|
| [nextdraw-driver.md](nextdraw-driver.md) | **Bantam's official driver internals** (nextdrawcore + plotink 1.7.5), at the depth needed to port it. Plot lifecycle, SVG digest and layer codes, path optimization, S-curve motion planning, T3/TD command generation and firmware-exact arithmetic, dripfeed and pause, `<plotdata>` resume format, pen/servo math, limit-switch homing, preview/time estimate, and how to run the Python driver as a test oracle. |
| [ebb-protocol.md](ebb-protocol.md) | **The EiBotBoard serial protocol.** Transport and discovery, legacy vs v3 "future syntax" framing, firmware versions, a 55-command reference showing which drivers use which commands, motion/accumulator math, FIFO, servo, safety (limit switch, power loss, ES), EBB2 vs EBB3 migration, and recommendations for axya's serial layer. |
| [nextdraw-inkscape-cli-api.md](nextdraw-inkscape-cli-api.md) | **Every user-facing option** in Bantam's software. How the Inkscape extension is packaged, every `.inx` control, every CLI flag/mode/utility command, the Python API, every `nextdraw_conf.py` parameter, model and handling tables, axicli migration notes, and a **45-item feature-parity checklist** against axya. |
| [saxi.md](saxi.md) | **saxi** (nornagon original + alexrudd2 fork), the TypeScript EBB2 driver axya v1 was ported from. Architecture, constant-acceleration planner, LM/XM/S2 protocol use, pause/cancel, model tables, fork differences, tests and serial mock, gaps against Bantam, and what to borrow. |
| [landscape.md](landscape.md) | **Everything else.** Ecosystem timeline, gre/penplotter-web (axya v2's model), legacy EMS AxiDraw software, the EBB firmware source and its regression vectors, a survey of other tools (vpype, cncserver, Kurvengefahr, @thi.ng/axidraw, …), axya's own history, and the firmware support matrix for the port. |

## Vendored sources (`docs/reference-apps/`)

| Path | What | License |
|---|---|---|
| `nextdraw-1.7.5/nextdrawcore/` | Bantam core driver, from the `nextdrawcore-1.7.5` wheel | GPL-2.0-or-later |
| `nextdraw-1.7.5/plotink/` | EBB serial/motion helpers, 1.14.3 from the Inkscape installer (matches upstream except one import shim) | MIT |
| `nextdraw-1.7.5/nextdraw-api/` | `nextdraw` CLI + Python API package, examples, tests (from `nextdraw_api.zip`; Bantam's docs excluded) | MIT (CLI) / GPL (core) |
| `nextdraw-1.7.5/inkscape-extension/` | `.inx` UI definitions, launchers, and the installer script from `NextDrawInstall.app` 1.7.5 (the PyInstaller binaries are excluded) | per file |
| `ebb-firmware/docs/` | EBB command set docs (v3.0+ and legacy 2.8.1) and release notes | GPL-3.0 (EggBot repo) |
| `ebb-firmware/source/` | EBB firmware v3.1.7 source (`ebb.c` motion ISR, `UBW.c`, `RCServo2.c`, …) | BSD-3-Clause headers / GPL-3.0 repo |
| `ebb-firmware/regression-tests/` | Firmware golden vectors for `LM`/`LT`/`T3` (2023) and the scripts that produced them | GPL-3.0 (EggBot repo) |
| `nornagon-saxi/`, `alexrudd2-saxi/` | saxi, both forks, current upstream as of 2026-10 | AGPL-3.0 |
| `gre-penplotter-web/` | FastAPI wrapper around axicli (screenshots excluded) | WTFPL |

Not vendored: Bantam's NextDraw documentation, which is "All rights reserved". The docs here summarize it and link to [bantam.tools/nd_cli](https://bantam.tools/nd_cli/) and [bantam.tools/nd_py](https://bantam.tools/nd_py/). The legacy `evil-mad/axidraw` repo and the full `evil-mad/EggBot` repo are cited by commit hash in `landscape.md`.

## Facts that shape the port

1. **nextdraw refuses EBB firmware below 3.0.2.** axya today therefore can't drive 2.x AxiDraws either, so targeting ≥3.0.2 loses nobody.
2. **Motion is planned on the host and must match the firmware bit for bit.** The planner predicts each `T3`/`TD` command's exact step output (`ebb_calc.py`) and plans the next segment from that prediction. A port needs exact rounding (half-even, half-away-from-zero, truncation), float32 storage at the same points, and BigInt accumulators.
3. **Resume works by distance, not by position.** `<plotdata>` stores options, the random seed, and pen-down distance. Deterministic replanning plus a crop rebuilds the remaining plot. If we keep the format, a plot paused under one driver can be resumed under the other.
4. **Machine state lives in EBB RAM** (`SL`/`QL`): pen state at 10–11, homed flag at 12, power flag at 13, origin offsets at 24–31. Jogging shifts the origin for later plots.
5. **The Python driver can run as an oracle without hardware.** Faking `serial.Serial`, `comports`, and the clock makes it emit the full command stream for any SVG, giving golden fixtures for the port.
6. **saxi is not a NextDraw driver.** It has no T3/TD, no homing, no button or power polling, no resume, and uses different servo semantics. It's useful for structure, the transport, and test mocks, not for motion.

## Known axya bugs found during research

These are fixed by the port, or earlier if needed:

- **Plotting a file that holds pause data silently does nothing.** nextdraw refuses once, exits 0, and axya reports "Plot complete" (`plot_status.py:309-337`). `/api/estimate` also returns nothing for such files.
- **Stop uses SIGKILL.** That skips writing `<plotdata>` and leaves the servo powered.
- **Jogging moves the plot origin** for the next plot, and the UI doesn't say so.
- **Home doesn't need a file.** The dummy SVG and the requirement for a current file are unnecessary.
