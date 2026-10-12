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
import copy
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


def plain(value):
    """JSON-safe copy of option/param values and planner tuples."""
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if hasattr(value, "__dict__"):
        return {k: plain(v) for k, v in vars(value).items() if not k.startswith("_")}
    return repr(value)


def digest_json(digest):
    return {
        "width": digest.width, "height": digest.height, "flat": digest.flat,
        "layers": [{
            "name": layer.name, "item_id": layer.item_id, "props": plain(layer.props),
            "paths": [{"item_id": path.item_id, "stroke": path.stroke, "fill": path.fill,
                       "fill_rule": path.fill_rule,
                       "subpaths": copy.deepcopy(path.subpaths)}  # later stages edit in place
                      for path in layer.paths],
        } for layer in digest.layers],
    }


def install_stage_hooks(nd, stages):
    """Wrap nextdraw's pipeline stages to record their outputs in `stages`."""
    from nextdrawcore import boundsclip, digest_svg, motion, nextdraw, path_objects, \
        plot_optimizations  # noqa: E402

    def after(module, name, label, result_digest=None):
        original = getattr(module, name)

        def wrapper(*args, **kwargs):
            result = original(*args, **kwargs)
            digest = result_digest(args, result) if result_digest else args[0]
            stages.setdefault("digest", []).append([label, digest_json(digest)])
            return result
        setattr(module, name, wrapper)

    after(digest_svg.DigestSVG, "process_svg", "process_svg", lambda a, r: r)
    after(path_objects.DocDigest, "rotate", "rotate")
    after(boundsclip, "clip_at_bounds", "clip_at_bounds")
    after(path_objects.DocDigest, "flatten", "flatten")
    after(plot_optimizations, "connect_nearby_ends", "connect_nearby_ends")
    after(plot_optimizations, "supersample", "supersample")
    after(plot_optimizations, "randomize_start", "randomize_start")
    after(plot_optimizations, "reorder", "reorder")

    original_prepare = nextdraw.NextDraw.prepare_document

    def prepare(self):
        stages["options"] = plain(vars(self.options))
        stages["params"] = plain({k: v for k, v in vars(self.params).items()
                                  if not k.startswith("_") and not callable(v)})
        stages["bounds"] = plain(self.bounds)
        return original_prepare(self)
    nextdraw.NextDraw.prepare_document = prepare

    def planner(name):
        original = getattr(motion, name)

        def wrapper(nd_ref, target, xyz_pos=None):
            start = plain(xyz_pos if xyz_pos is not None else nd_ref.pen.phys)
            target_in = plain(target)
            result = original(nd_ref, target, xyz_pos)
            moves = result[0] if name == "compute_segment" and result is not None else result
            if moves is not None:
                moves = [[m[0], plain(m[1])] + ([plain(m[2])] if len(m) > 2 else [])
                         for m in moves]
            end = plain(xyz_pos if xyz_pos is not None else nd_ref.pen.phys)
            extra = plain(result[1:]) if name == "compute_segment" and result is not None else None
            stages.setdefault("planner", []).append(
                {"fn": name, "in": target_in, "start": start, "end": end, "out": moves,
                 "extra": extra})
            return result
        setattr(motion, name, wrapper)

    planner("trajectory")
    planner("compute_segment")


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
    stages = {}
    if case.get("stages"):
        install_stage_hooks(nd, stages)
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
    if stages:
        result["stages"] = stages
    return result


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf8") as f:
        print(json.dumps(run_case(json.load(f)), indent=1))
