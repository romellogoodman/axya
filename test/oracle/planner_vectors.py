"""
Generate planner test vectors from the vendored nextdraw 1.7.5.

    .venv-oracle/bin/python -I test/oracle/planner_vectors.py [out.json] [scale]

Default output: test/fixtures/planner-vectors.json (the committed set, scale 0.4).

scale multiplies the random sweep sizes (0.4, the default, = the committed set).
"""
import copy
import json
import math
import os
import random
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VENDORED = os.path.join(ROOT, "docs", "reference-apps", "nextdraw-1.7.5")
sys.path[:0] = [os.path.join(VENDORED, "nextdraw-api"), VENDORED]

from nextdrawcore import cubic_eqn, motion, plan_utils  # noqa: E402
from nextdrawcore.pen_handling import PenPosition  # noqa: E402

out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "fixtures", "planner-vectors.json")
SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 0.4  # 0.4 = the committed set
rng = random.Random(20261012)


def n(count):
    return max(1, int(count * SCALE))


def root_json(r):
    if isinstance(r, complex):
        return {"complex": True}
    return r


def pos_json(p):
    return {k: v for k, v in vars(p).items()}


def plain(v):
    if isinstance(v, PenPosition):
        return pos_json(v)
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


def safe(fn, *args):
    try:
        return {"ok": plain(fn(*args))}
    except Exception as exc:  # noqa: BLE001
        return {"err": type(exc).__name__}


def speed():
    return rng.choice([0.0, rng.uniform(0, 17.4), rng.uniform(0, 1), rng.uniform(5, 17.4)])


def jerk():
    k = rng.uniform(0.01, 1) ** 3
    return rng.choice([20000, 19000, 14000, 90000, 13000, 6000]) * k


def length():
    return rng.choice([rng.uniform(0, 0.01), rng.uniform(0, 1), rng.uniform(0, 12),
                       10 ** rng.uniform(-6, -2)])


V = {}

# cubic_eqn.solve: planner form (j, 0, 2v, -d), plus generic coefficients
cubic = []
for _ in range(n(400)):
    a, c, d = jerk(), 2 * speed(), -length()
    cubic.append([[a, 0, c, d], [root_json(r) for r in cubic_eqn.solve(a, 0, c, d)]])
for _ in range(n(150)):
    a, b, c, d = (rng.uniform(-5, 5) for _ in range(4))
    cubic.append([[a, b, c, d], [root_json(r) for r in cubic_eqn.solve(a, b, c, d)]])
for args in ([1, 0, 0, 0], [1000, 0, 0, -0.001], [0, 0, 2, -1], [0, 1, 2, -3],
             [0, 1, 0, 1], [1, -6, 11, -6], [1, -3, 3, -1], [2, 0, -6, 1]):
    try:
        cubic.append([args, [root_json(r) for r in cubic_eqn.solve(*args)]])
    except Exception as exc:  # noqa: BLE001
        cubic.append([args, {"err": type(exc).__name__}])
V["cubic"] = cubic

# scurve_plan in all three modes, with and without min_time
sp = []
for _ in range(n(1500)):
    v_in, v_max, j = speed(), speed(), jerk()
    dist = rng.choice([None, length(), 0.0])
    mt = rng.choice([None, 0.007, rng.uniform(0, 0.05)])
    sp.append([[v_in, v_max, j, dist, mt], plan_utils.scurve_plan(v_in, v_max, j, dist, mt)])
for args in ([0, 0, 0, None, None], [1, 1, 8000, None, None], [1, 1, 8000, 0.1, 0.007],
             [0, 5, 0, None, None], [0, 5, 0, 0.5, None], [2, 5, 8000, 0.0, 0.007],
             [5, 2, 8000, 0.0001, 0.007], [5, 6, 8000, 0.0001, 0.007],
             [0, 6, 8000, 0.0001, 0.007], [-3, -6, -8000, -0.2, None],
             [0, 17.3958, 90000, 1e-9, 0.007], [8.6979, 8.6979, 8437.5, 0.3, 0.007],
             [None, 1, 1, None, None]):
    sp.append([args, plan_utils.scurve_plan(*args)])
V["scurve_plan"] = sp

# scurve_jerk / scurve_jerk2 / scurve_time
sj = []
for _ in range(n(600)):
    a, b, d, j = speed(), speed(), length(), jerk()
    sj.append([[a, b, d, j], plan_utils.scurve_jerk(a, b, d, j),
               plan_utils.scurve_jerk2(a, b, d, j)])
for args in ([0, 0, 0.001, 8000], [0, 2, 0.001, 8000], [2, 2, 0.02, 8000],
             [3, 0, 0.0005, 8000], [8.6979, 0, 0.004, 8437.5]):
    sj.append([args, plan_utils.scurve_jerk(*args), plan_utils.scurve_jerk2(*args)])
V["scurve_jerk"] = sj

st = []
for _ in range(n(300)):
    a, b, j = speed(), speed(), rng.choice([0, jerk(), -jerk()])
    st.append([[a, b, j], plan_utils.scurve_time(a, b, j)])
V["scurve_time"] = st

# striangle: only called with dist between d_sse and d_svm (motion.py:632)
tri = []
while len(tri) < n(300):
    v_max, j = rng.uniform(0.5, 17.4), jerk()
    vi, vf = rng.uniform(0, v_max), rng.uniform(0, v_max)
    if rng.random() < 0.2:
        vi = vf = 0.0
    lo = plan_utils.scurve_plan(min(vi, vf), max(vi, vf), j, None)
    hi = plan_utils.scurve_plan(vi, v_max, j, None) + plan_utils.scurve_plan(vf, v_max, j, None)
    if not hi > lo:
        continue
    d = rng.uniform(lo, hi)
    tri.append([[vi, vf, v_max, j, d], plan_utils.striangle(vi, vf, v_max, j, d)])
V["striangle"] = tri

# calc_jerk
cj = []
for accel in (1, 2, 33, 50, 75, 99, 100, 101, 150):
    for jd, ju in ((20000, 19000), (90000, 13000), (0, 17000)):
        ref = SimpleNamespace(options=SimpleNamespace(accel=accel),
                              params=SimpleNamespace(jerk_pen_down=jd, jerk_pen_up=ju))
        cj.append([[accel, jd, ju], list(plan_utils.calc_jerk(ref))])
V["calc_jerk"] = cj


def rand_pos():
    p = PenPosition()
    p.xpos, p.ypos = rng.uniform(0, 12), rng.uniform(0, 9)
    p.z_up = rng.choice([True, False])
    p.accum1, p.accum2 = rng.randrange(0, 2 ** 31), rng.randrange(0, 2 ** 31)
    return p


def rate():
    return rng.choice([0, rng.randrange(-2 ** 31 + 1, 2 ** 31), rng.randrange(-2 ** 26, 2 ** 26)])


# td_seg_data / t3_seg_data on realistic planner parameters
seg = []
for _ in range(n(400)):
    step_scale = rng.choice([2032.0, 1016])
    t = rng.choice([1, rng.randrange(1, 1000), rng.randrange(1, 60000)])
    r1, r2 = rate(), rate()
    j1, j2 = rng.randrange(-6000, 6000), rng.randrange(-6000, 6000)
    a1, a2 = j1 * t, j2 * t
    td = [t, r1, r1 + a1, a1, j1, r2, r2 + a2, a2, j2]
    p = rand_pos()
    before = pos_json(p)
    res = plan_utils.td_seg_data(td, p, step_scale)
    seg.append(["td", td, before, step_scale, list(res), pos_json(p)])
    t3 = [t, r1, 0, 0, r2, 0, 0]
    p = rand_pos()
    before = pos_json(p)
    res = plan_utils.t3_seg_data(t3, p, step_scale)
    seg.append(["t3", t3, before, step_scale, list(res), pos_json(p)])
V["seg_data"] = seg


# compute_segment / trajectory edge cases through a fake nd_ref
def nd(handling_jerk=20000, jerk_up=19000, accel=75, res=1, const=False,
       spd_down=25, spd_up=75, limit=8.6979, limit_up=8.6979, phys=None):
    pen = SimpleNamespace(phys=phys or PenPosition())
    warn = []
    return SimpleNamespace(
        options=SimpleNamespace(accel=accel),
        params=SimpleNamespace(resolution=res, const_speed=const, bounds_tolerance=0.003,
                               jerk_pen_down=handling_jerk, jerk_pen_up=jerk_up,
                               model_name="model"),
        bounds=[[-1e-9, -1e-9], [11.81 + 1e-9, 8.58 + 1e-9]],
        step_scale=2032.0 if res == 1 else 1016,
        speed_pendown=spd_down * limit / 100.0, speed_penup=spd_up * limit_up / 100.0,
        pen=pen, warnings=SimpleNamespace(add_new=lambda *a: warn.append(list(a))),
        _warn=warn)


def ctx_json(ref):
    return {"accel": ref.options.accel, "resolution": ref.params.resolution,
            "const_speed": ref.params.const_speed, "jerk_pen_down": ref.params.jerk_pen_down,
            "jerk_pen_up": ref.params.jerk_pen_up, "step_scale": ref.step_scale,
            "speed_pendown": ref.speed_pendown, "speed_penup": ref.speed_penup}


def start_pos(x=1.0, y=1.0, z_up=False, a1=0, a2=0):
    p = PenPosition()
    p.xpos, p.ypos, p.z_up, p.accum1, p.accum2 = x, y, z_up, a1, a2
    return p


segs = []


def add_seg(label, ref, target, pos):
    before = pos_json(pos)
    res = safe(motion.compute_segment, ref, target, pos)
    segs.append({"label": label, "ctx": ctx_json(ref), "in": list(target), "start": before,
                 "result": res, "end": pos_json(pos), "warnings": ref._warn})


add_seg("zero length", nd(), (1.0, 1.0, 0, 0, False), start_pos())
add_seg("below one step", nd(), (1.0001, 1.0001, 0, 0, False), start_pos())
add_seg("rounds to one step", nd(), (1.0002, 1.0001, 0, 0, False), start_pos())
add_seg("one step", nd(), (1.0003, 1.0, 0, 0, False), start_pos())
add_seg("one step y", nd(res=2), (1.0, 1.0006, 0, 0, False), start_pos())
add_seg("max speed in/out", nd(spd_down=100), (5.0, 3.0, 9, 9, False), start_pos())
add_seg("max speed pen-up", nd(spd_up=100), (5.0, 3.0, 0, 0, False), start_pos(z_up=True))
add_seg("const speed", nd(handling_jerk=0, const=True, limit=3.0), (4.0, 1.0, 0, 0, False),
        start_pos())
add_seg("const speed pen up", nd(handling_jerk=0, const=True, limit=3.0),
        (4.0, 1.0, 0, 0, False), start_pos(z_up=True))
add_seg("out of bounds", nd(), (13.0, -1.0, 0, 0, False), start_pos())
add_seg("bounds within tolerance", nd(), (11.812, 1.0, 0, 0, False), start_pos())
add_seg("ignore limits", nd(), (-1.0, -1.0, 0, 0, True), start_pos())
add_seg("no position", nd(), (1.0, 1.0, 0, 0, False), start_pos(None, None, None))
add_seg("very short TD", nd(), (1.002, 1.0, 0.5, 0.5, False), start_pos())
add_seg("short reduced jerk", nd(), (1.004, 1.0, 1.5, 0.2, False), start_pos())
add_seg("decel only", nd(), (1.01, 1.0, 2.0, 0.0, False), start_pos())
add_seg("accel only", nd(), (1.01, 1.0, 0.0, 2.0, False), start_pos())
add_seg("reversal axis", nd(), (0.5, 1.5, 0, 0, False), start_pos(a1=2 ** 31 - 1, a2=5))
for k in range(n(250)):
    phys = start_pos(rng.uniform(0, 11.8), rng.uniform(0, 8.5), rng.choice([True, False]),
                     rng.randrange(0, 2 ** 31), rng.randrange(0, 2 ** 31))
    ref = nd(handling_jerk=rng.choice([20000, 90000, 14000]), accel=rng.randrange(1, 101),
             res=rng.choice([1, 2]), spd_down=rng.randrange(1, 111),
             spd_up=rng.randrange(1, 101), limit=rng.choice([8.6979, 7, 12, 17.3958]),
             limit_up=rng.choice([8.6979, 12, 17.3958]))
    dx, dy = (rng.choice([rng.uniform(-3, 3), rng.uniform(-0.01, 0.01), 0.0]) for _ in "xy")
    vmax = ref.speed_penup if phys.z_up else ref.speed_pendown
    vi, vf = (rng.choice([0, rng.uniform(0, vmax), vmax, vmax * 1.2]) for _ in "if")
    add_seg(f"random {k}", ref, (phys.xpos + dx, phys.ypos + dy, vi, vf, False), phys)
V["compute_segment"] = segs

trajs = []


def add_traj(label, ref, verts):
    phys_before = pos_json(ref.pen.phys)
    res = safe(motion.trajectory, ref, copy.deepcopy(verts))
    trajs.append({"label": label, "ctx": ctx_json(ref), "in": verts, "start": phys_before,
                  "result": res, "end": pos_json(ref.pen.phys)})


def nd_at(x, y, **kw):
    return nd(phys=start_pos(x, y, True), **kw)


add_traj("single segment", nd_at(1, 1), [[1, 1], [2, 1.5]])
add_traj("trimmed to one segment (tuple quirk)", nd_at(1, 1), [[1, 1], [1.0001, 1], [2, 1]])
add_traj("trimmed to nothing", nd_at(1, 1), [[1, 1], [1.0001, 1], [1.0002, 1]])
add_traj("180 corner", nd_at(1, 1), [[1, 1], [3, 1], [1, 1]])
add_traj("90 corner", nd_at(1, 1), [[1, 1], [3, 1], [3, 3]])
add_traj("shallow corners", nd_at(1, 1), [[1, 1], [2, 1.01], [3, 1.03], [4, 1.06], [5, 1.1]])
add_traj("zigzag tiny", nd_at(1, 1), [[1 + 0.001 * i, 1 + 0.0005 * (i % 2)] for i in range(40)])
add_traj("circle", nd_at(3, 2), [[2 + math.cos(t / 50 * 2 * math.pi),
                                  2 + math.sin(t / 50 * 2 * math.pi)] for t in range(51)])
add_traj("one vertex", nd_at(1, 1), [[1, 1]])
for k in range(n(60)):
    x, y = rng.uniform(1, 10), rng.uniform(1, 7)
    verts = [[x, y]]
    for _ in range(rng.randrange(2, 25)):
        step = rng.choice([rng.uniform(0, 0.02), rng.uniform(0, 0.5), 0.0002])
        ang = rng.uniform(0, 2 * math.pi)
        x = min(max(x + step * math.cos(ang), 0), 11.8)
        y = min(max(y + step * math.sin(ang), 0), 8.5)
        verts.append([x, y])
    ref = nd_at(verts[0][0], verts[0][1], handling_jerk=rng.choice([20000, 90000, 14000]),
                accel=rng.randrange(1, 101), res=rng.choice([1, 2]),
                spd_down=rng.randrange(1, 111), limit=rng.choice([8.6979, 7, 12]))
    ref.pen.phys.accum1 = rng.randrange(0, 2 ** 31)
    add_traj(f"random {k}", ref, verts)
V["trajectory"] = trajs

with open(out_path, "w") as fh:
    json.dump(V, fh, separators=(",", ":"))
