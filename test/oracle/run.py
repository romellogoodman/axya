"""
Run one oracle case: drive the vendored nextdraw 1.7.5 against FakeEBB and
print a JSON record of everything it did.

    python -I test/oracle/run.py <case.json>

A case is JSON:
    {
      "svg": "test/fixtures/svg/square.svg",   # path relative to repo root
      "options": {"model": 8, "speed_pendown": 40, ...},  # NextDraw.options
      "params": {"min_gap": -1, ...},           # NextDraw.params overrides
      "fake": {"homed": true, "pause_after_moves": 12}
    }

Output keys: commands ([ms, line] in order), messages, status_code,
stats, output_svg (plotting modes only; the SVG with <plotdata>).
"""

import contextlib
import io
import json
import os
import sys
import time

sys.dont_write_bytecode = True  # keep vendored source dirs clean

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VENDORED = os.path.join(ROOT, "docs", "reference-apps", "nextdraw-1.7.5")
sys.path[:0] = [os.path.dirname(__file__), os.path.join(VENDORED, "nextdraw-api"), VENDORED]

from fake_ebb import FakeEBB, VirtualClock  # noqa: E402


def run_case(case):
    clock = VirtualClock()
    time.time = clock.time
    time.sleep = clock.sleep

    import plotink.ebb3_serial as ebb3_serial  # noqa: E402

    fake = FakeEBB(clock, **case.get("fake", {}))
    ebb3_serial.serial.Serial = lambda *args, **kwargs: fake
    ebb3_serial.comports = lambda: [("/dev/fake-ebb", "EiBotBoard", "USB VID:PID=04D8:FD92")]

    from nextdraw import NextDraw  # noqa: E402

    nd = NextDraw()
    svg = case.get("svg")
    nd.plot_setup(os.path.join(ROOT, svg) if svg else None)
    for key, value in case.get("options", {}).items():
        setattr(nd.options, key, value)
    for key, value in case.get("params", {}).items():
        if key == "overrides":
            nd.params.overrides.update(value)
        else:
            setattr(nd.params, key, value)

    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        output_svg = nd.plot_run(True)

    result = {
        "commands": fake.log,
        "messages": [line for line in out.getvalue().splitlines() if line.strip()],
        "status_code": nd.plot_status.stopped,
        "final_steps": fake.steps,
        "final_ram": fake.ram,
    }
    if nd.options.mode in ("plot", "layers", "res_plot"):
        result["stats"] = {
            "time_estimate": nd.time_estimate,
            "distance_pendown": nd.distance_pendown,
            "distance_total": nd.distance_total,
            "pen_lifts": nd.pen_lifts,
        }
        result["output_svg"] = output_svg
    return result


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf8") as f:
        print(json.dumps(run_case(json.load(f)), indent=1))
