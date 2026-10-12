# Hardware bring-up: native driver

A checklist for first runs of the native driver on real plotters, written for the machines on hand:

- an **AxiDraw V3**: assumed to be model 1 (V3 or SE/A4, 300 × 218 mm, standard servo, no homing). Confirm before starting.
- a **NextDraw 2234**: model 10, 864 × 594 mm, brushless pen lift, automatic limit-switch homing.

Without hardware, the native driver reproduces Bantam's nextdraw 1.7.5 command for command on every oracle case (see [DRIVER_PORT.md](DRIVER_PORT.md)). This checklist verifies the parts a simulation can't: USB timing, real firmware replies, the limit switch, servos, and motion.

Keep a hand near the power switch for every step that moves.

## Setup

```bash
npm install
AXYA_EBB_TRACE=/tmp/axya-ebb.log npm run dev
```

- The native driver is the default. The status panel shows `· native` after the plotter summary.
- **`AXYA_EBB_TRACE`** appends every line sent to and received from the board to that file. Keep it for any step that misbehaves.
- **Comparing with the CLI driver.** Restart with `AXYA_DRIVER=cli`, which needs `python3 -m nextdraw`. Run the same step and compare the behavior, and the CLI's log panel output.

In **Configure**, set the model before each machine:
- AxiDraw V3: model 1, or 2, 3 or 7 for other V3 variants.
- NextDraw 2234: model 10.

## 1. Connection and firmware (no motion)

Open **Jog / Home** and press **Pen Up**.

- **Expect:** a log line `native: utility raise_pen`. The panel then shows `EBB firmware 3.x.y` (and the nickname, if set). The connection dot turns green.
- **"Firmware version (…) not supported":** the board is on EBB 2.x. nextdraw and the native driver both need **3.0.2 or newer**. This is likely on an older AxiDraw V3. Update the firmware with Bantam's updater (linked at bantam.tools/ndfw), or tell me and I'll add a legacy EBB 2.x path.
- **"No plotter connected":** check the USB cable and that the port isn't held by another program (Inkscape, a CLI run). Run `ls /dev/cu.usbmodem*` to see the device.

## 2. Pen

**Pen Up** and **Pen Down**, several times.

- **Expect:** the pen moves immediately (no ~1 s subprocess delay). The AxiDraw uses the standard servo; the NextDraw uses the brushless lift.
- Tune `pen_pos_up` / `pen_pos_down` in the sidebar and repeat until the pen clears and touches the paper.

## 3. Jog (short, slow)

Set the jog step to **1 mm** and press each arrow once.

- **Expect:** about 1 mm of motion in the arrow's direction. +X is away from home along the long axis; +Y is toward you.
- Then try 10 mm.
- **Note:** jogging moves the plot origin. The next plot starts where you jogged to, until **Home**.

## 4. Home

Press **Home** (⌂).

- **NextDraw 2234:** the first command after power-up runs automatic homing. The carriage seeks the limit switch at slow speed, backs off, re-approaches, and stops at the origin.
  - "Automatic homing failed" means the switch wasn't found where expected. Stop and send the trace.
- **AxiDraw V3:** no limit switch. Home returns to where the motors were enabled (where the carriage was at power-up). Before powering on, push the carriage by hand to the home corner.

## 5. A small square

Upload `test/fixtures/svg/square-circle.svg` (a 100 mm document with a 50 mm square and a 30 mm circle) and **Calculate** the estimate, then **Plot**.

- **Expect:** a square and a circle, then a return to the origin. Progress climbs to 100%, and the elapsed time is close to the estimate.
- Compare against `AXYA_DRIVER=cli` on the same file. Speed, cornering and pen timing should look identical.

## 6. A full document

Plot `test/fixtures/svg/shapes.svg` (curves, arcs, transforms) and `test/fixtures/svg/layers.svg` (layer codes: speed, height and delay per layer).

- On the 2234, also try a large drawing near the far corner of its 864 × 594 mm travel.

## 7. Pause and resume

1. During a plot, press **Pause** in the UI.
   - **Expect:** the pen lifts within a fraction of a second. Up to 16 queued moves finish first, with the pen up, as in nextdraw. State shows Paused.
2. Press **Resume**. The plot continues from the pause point.
3. Pause again, then restart the server and reload the page. **Resume** should still work, because the state is saved in the SVG.
4. Press the **plotter's own pause button** mid-plot. The UI should show Paused, and Resume should work.
5. **Cancel** a paused plot, then **Plot** the same file. It should start over from the beginning.

## 8. Faults

- **Pull the USB cable mid-plot.**
  - Expect an error that the USB connection was lost, and a red connection dot.
  - Reconnect, press Home, and plot again.
- **Switch off motor power mid-plot (NextDraw).**
  - Expect "The plotter lost power".
  - After power returns, the next command re-homes.

## 9. Soak

Plot a long drawing, 30 minutes or more. Check that it finishes without stalls, and that the final return to the origin lands where it started.

## Reporting a problem

Send the step number, the model, the trace file (`/tmp/axya-ebb.log`), and the log panel contents (or `curl localhost:4000/api/logs`). The trace and the oracle make most problems reproducible without the machine.

## After bring-up

Once each model passes, the CLI driver and its Python requirement are removed, and DRIVER_PORT.md records the result.
