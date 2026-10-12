# Oracle

Runs Bantam's vendored nextdraw 1.7.5 (`docs/reference-apps/nextdraw-1.7.5/`) against a fake EiBotBoard and records every serial command it sends. The recorded streams in `test/fixtures/golden/` are what the Node driver port must reproduce. See [docs/DRIVER_PORT.md](../../docs/DRIVER_PORT.md#verification-strategy).

Python is needed only to regenerate fixtures. Tests read the committed JSON.

```bash
npm run oracle:setup          # once: creates .venv-oracle with lxml, ink-extensions, pyserial, …
npm run oracle                # regenerate every case in test/fixtures/cases.json
npm run oracle -- plot-basic  # regenerate specific cases
```

## Files

- `fake_ebb.py`: the fake board. It models:
  - EBB 3.x future-syntax replies
  - pen and motor state
  - SL/QL RAM
  - the `QS` step position, computed with plotink's firmware-exact `ebb_calc`
  - `EM`/`CS` counter resets
  - the `QG` status bits (pen down = bit 4, button = bit 5, limit = bit 7)
  - a limit switch at physical X = 0, used by NextDraw homing

  Each case can set the start position (`start_x_mm`), whether the machine is already homed or powered (`homed`, `motors_on`), the supply voltage, and a button press after N moves (`pause_after_moves`).
- `run.py`: runs one case through the Python API with time patched to a virtual clock, so runs are fast and fully deterministic (including `random_start` seeds).
- `generate.py`: runs every case in a fresh subprocess and writes the goldens. A case with `svg_from` uses another case's output SVG (with `<plotdata>`) as its input, for resume tests.

## Vector generators

Unit-level vectors for individual ported modules, each committed under `test/fixtures/`:

- `ebb_calc_vectors.py`: `plotink/ebb_calc.py`.
- `planner_vectors.py`: the motion planner helpers.
- `digest_vectors.py`: path parsing, transforms, MT19937 and the optimizations.
- `clipping_vectors.py`: hidden-line removal and pyclipper.
- `clipping_sort_vectors.cpp`: libc++ `std::sort` tie order. Build it with clang++; the file header has the command.

The clipping vectors depend on the arm64 macOS pyclipper wheel, which is compiled with fused multiply-add. An x86_64 build would produce different last bits, so regenerate them on arm64 macOS only.

## Golden format

```json
{
  "commands": [[virtual_ms, "SM,118,480,480"], ...],
  "messages": ["user-facing output lines"],
  "status_code": 0,
  "final_steps": [m1, m2],
  "final_ram": [32 ints],
  "stats": {...},
  "output_svg": "...",
  "case": {...}
}
```

`stats` and `output_svg` are present only for plotting modes.

## Stage fixtures

Every case also writes `test/fixtures/stages/<case>.json.gz`, which holds nextdraw's intermediate results so each ported module can be tested on its own:

- `options`, `params`, `bounds`: resolved settings at the start of `prepare_document`.
- `digest`: `[stage, DocDigest]` snapshots after each of `process_svg`, `rotate`, `clip_at_bounds`, `flatten`, `connect_nearby_ends`, `supersample`, `randomize_start` and `reorder` (only the stages that ran).
- `planner`: every `motion.trajectory` and `motion.compute_segment` call, with its input, the start and end pen position (`xpos`, `ypos`, `z_up`, `accum1/2`), the move list it returned, and `compute_segment`'s extra return values.

## Limits of the fake

- Motion is instantaneous: the queue is always empty (`QU,6` → 0, `QG` low nibble 0).
- Only the limit switch's X position is modelled, so homing works whenever the carriage starts within the travel the algorithm expects. Starting beyond that range exercises nextdraw's own failure path (`plot-cold-homing-fail-out-of-range`).
- Timings in `commands` come from nextdraw's own host-side sleeps, not from real motion.
