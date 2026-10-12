"""Generate reference vectors for test/clipping.test.ts: nextdraw's
hidden-line removal (nextdrawcore/clipping.py) on synthetic digests, the
pyclipper calls it makes, and the CPython set orders it depends on. Run
from the repo root:

    .venv-oracle/bin/python -I test/oracle/clipping_vectors.py

Writes test/fixtures/clipping-vectors.json.gz. Deterministic (fixed seeds).

Sections:
  process  ClipPathsProcess().run(layers, bounds, clip_on) on synthetic
           layers: random overlapping fills (nonzero/evenodd/none), nested
           holes, strokes crossing fills, open filled paths, paths partly
           outside the bounds, several layers (one pair sharing an item_id),
           clip_on true/false, no bounds, degenerate geometry (zero area,
           collinear, duplicate points, touching edges, horizontals, single
           points), independent multi-subpath clippers (the per-subpath
           path), >= 500 paths (the spatial-grid path), and bad fill rules.
  clipper  pyclipper AddPaths/Execute2/PolyTreeToPaths and CleanPolygon on
           random scaled paths (open and closed, both fill types, both ops).
  pyset    iteration order of sets of ints after add/discard/|= sequences.
  fma      math.fma on awkward operands.
  boundary pyclipper on coordinates near 2^52 - 1, the edge of the range the
           TypeScript port computes exactly.
"""
import sys, os, json, math, random, gzip
sys.dont_write_bytecode = True
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
V = os.path.join(ROOT, "docs", "reference-apps", "nextdraw-1.7.5")
sys.path[:0] = [os.path.join(V, "nextdraw-api"), V]
import pyclipper
from nextdrawcore import path_objects
from nextdrawcore.clipping import ClipPathsProcess

OUT = os.path.join(ROOT, "test", "fixtures", "clipping-vectors.json.gz")


def r6(x):
    return round(x, 6)


# ---------------------------------------------------------------- shapes

def poly_circle(rng, cx, cy, r, n, ccw=True):
    a0 = rng.uniform(0, 2 * math.pi)
    pts = [[r6(cx + r * math.cos(a0 + 2 * math.pi * k / n * (1 if ccw else -1))),
            r6(cy + r * math.sin(a0 + 2 * math.pi * k / n * (1 if ccw else -1)))]
           for k in range(n)]
    return pts + [list(pts[0])]


def rect(x0, y0, x1, y1, ccw=True):
    pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    if not ccw:
        pts.reverse()
    return pts + [list(pts[0])]


def star(rng, cx, cy, r, n):
    pts = []
    for k in range(2 * n):
        rr = r if k % 2 == 0 else r * rng.uniform(0.2, 0.6)
        a = math.pi * k / n
        pts.append([r6(cx + rr * math.cos(a)), r6(cy + rr * math.sin(a))])
    return pts + [list(pts[0])]


def polyline(rng, x0, y0, x1, y1, n, grid=False):
    pts = []
    for k in range(n):
        t = k / max(n - 1, 1)
        x = x0 + (x1 - x0) * t + (0 if grid else rng.uniform(-0.3, 0.3))
        y = y0 + (y1 - y0) * t + (0 if grid else rng.uniform(-0.3, 0.3))
        pts.append([r6(x), r6(y)])
    return pts


def grid_poly(rng, n, step=0.5, span=8):
    return [[rng.randint(0, span) * step, rng.randint(0, span) * step] for _ in range(n)]


FILLS = [None, "#000", "#fff", "none", "#ccc", "red"]
STROKES = [None, "#000", "none", "blue"]
RULES = [None, "nonzero", "evenodd"]


def path(item_id, subpaths, fill=None, stroke="#000", fill_rule=None):
    return {"item_id": item_id, "fill": fill, "stroke": stroke,
            "fill_rule": fill_rule, "subpaths": subpaths}


def random_shape(rng, kind, w, h):
    cx, cy = rng.uniform(0.5, w - 0.5), rng.uniform(0.5, h - 0.5)
    r = rng.uniform(0.2, min(w, h) / 3)
    if kind == "circle":
        return [poly_circle(rng, cx, cy, r, rng.randint(3, 24), rng.random() < 0.7)]
    if kind == "rect":
        return [rect(r6(cx - r), r6(cy - r * 0.6), r6(cx + r), r6(cy + r * 0.6),
                     rng.random() < 0.5)]
    if kind == "star":
        return [star(rng, cx, cy, r, rng.randint(3, 8))]
    if kind == "holed":
        outer = rect(r6(cx - r), r6(cy - r), r6(cx + r), r6(cy + r), True)
        inner = rect(r6(cx - r / 2), r6(cy - r / 2), r6(cx + r / 2), r6(cy + r / 2),
                     rng.random() < 0.5)
        return [outer, inner]
    if kind == "line":
        return [polyline(rng, rng.uniform(-1, w + 1), rng.uniform(-1, h + 1),
                         rng.uniform(-1, w + 1), rng.uniform(-1, h + 1),
                         rng.randint(2, 8))]
    if kind == "multiline":
        return [polyline(rng, rng.uniform(0, w), rng.uniform(0, h), rng.uniform(0, w),
                         rng.uniform(0, h), rng.randint(2, 6))
                for _ in range(rng.randint(2, 4))]
    if kind == "open":  # a filled but unclosed path
        return [poly_circle(rng, cx, cy, r, rng.randint(3, 9))[:-1]]
    if kind == "grid":
        return [grid_poly(rng, rng.randint(2, 7))]
    if kind == "dots":  # many separate small circles: an independent clipper
        return [poly_circle(rng, r6(1 + 1.2 * k), cy, 0.4, 8) for k in range(rng.randint(2, 7))]
    raise ValueError(kind)


def random_layers(rng, n_paths, w=8.0, h=6.0, n_layers=1, kinds=None):
    kinds = kinds or ["circle", "rect", "star", "holed", "line", "multiline", "open",
                      "grid", "dots"]
    layers = []
    pid = 1
    for li in range(n_layers):
        paths = []
        for _ in range(n_paths):
            kind = rng.choice(kinds)
            line = kind in ("line", "multiline")
            fill = None if line and rng.random() < 0.7 else rng.choice(FILLS)
            stroke = rng.choice(STROKES)
            paths.append(path(str(pid), random_shape(rng, kind, w, h), fill, stroke,
                              rng.choice(RULES)))
            pid += 1
        layers.append({"item_id": "L%d" % li, "name": str(li + 1), "paths": paths})
    return layers


# ---------------------------------------------------------------- run

def to_digest(layers):
    out = []
    for spec in layers:
        layer = path_objects.LayerItem()
        layer.item_id = spec["item_id"]
        layer.name = spec["name"]
        layer.parse_name()
        for p in spec["paths"]:
            layer.paths.append(path_objects.PathItem.from_attrs(
                subpaths=[[list(v) for v in sp] for sp in p["subpaths"]],
                stroke=p["stroke"], fill=p["fill"], fill_rule=p["fill_rule"],
                item_id=p["item_id"]))
        out.append(layer)
    return out


def from_digest(layers):
    return [{"item_id": l.item_id,
             "paths": [[p.item_id, p.stroke, p.fill, p.fill_rule, p.subpaths]
                       for p in l.paths]} for l in layers]


def process_case(layers, bounds, clip_on):
    case = {"layers": layers, "bounds": bounds, "clip_on": clip_on}
    try:
        res = ClipPathsProcess().run(to_digest(layers), bounds, clip_on=clip_on)
        case["out"] = from_digest(res)
    except Exception as e:  # nextdraw lets these propagate
        case["error"] = type(e).__name__
    return case


def process_cases():
    rng = random.Random(9)
    cases = []
    B = [[-1e-9, -1e-9], [8.000000001, 6.000000001]]

    def add(layers, bounds=B, clip_on=True):
        cases.append(process_case(layers, bounds, clip_on))

    # Hand-made cases first.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [polyline(rng, 0, 3, 8, 3, 5, grid=True)], None, "#000"),
        path("2", [rect(2, 2, 4, 4)], "#fff", "#000"),
        path("3", [rect(3, 1, 5, 5), rect(3.5, 2, 4.5, 4)], "#888", "#000", "evenodd"),
        path("4", [rect(3, 1, 5, 5), rect(3.5, 2, 4.5, 4)], "#888", "#000", "nonzero"),
    ]}])
    # Touching and coincident edges, duplicate points, zero-area fills.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [rect(0, 0, 2, 2)], "#000", "#000"),
        path("2", [rect(2, 0, 4, 2)], "#000", "#000"),
        path("3", [rect(1, 0, 3, 2)], "#fff", None),
        path("4", [[[0, 1], [1, 1], [1, 1], [4, 1], [4, 1]]], None, "#000"),
        path("5", [[[1, 1], [2, 2], [3, 3], [1, 1]]], "#000", "#000"),  # collinear fill
        path("6", [[[2, 2], [2, 2], [2, 2]]], None, "#000"),  # a single point
        path("7", [[[0.5, 0.5], [3.5, 0.5]]], "#000", "#000"),  # 2-point fill
        path("8", [rect(1, 1, 3, 1.5)], "#ccc", "#000"),
    ]}])
    # The same clipper twice; strokes exactly along fill edges.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [[[0, 2], [6, 2]], [[2, 0], [2, 6]]], None, "#000"),
        path("2", [rect(2, 2, 4, 4)], "#fff", "#000"),
        path("3", [rect(2, 2, 4, 4)], "#fff", "#000"),
        path("4", [[[2, 3], [4, 3]]], None, "#000"),
    ]}])
    # Paths partly and wholly outside the bounds; negative coordinates.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [polyline(rng, -3, -2, 11, 9, 7)], None, "#000"),
        path("2", [rect(-1, -1, 1, 1)], "#000", "#000"),
        path("3", [rect(20, 20, 21, 21)], "#000", "#000"),
        path("4", [poly_circle(rng, 7.5, 5.5, 1.5, 12)], None, "#000"),
    ]}])
    # Layers, including two sharing an item_id (they end up sharing paths).
    lay = random_layers(rng, 4, n_layers=3)
    lay[2]["item_id"] = lay[0]["item_id"]
    add(lay)
    # Coordinates pyclipper cannot scale to int64 (2^32 inches and up, or
    # infinite after scaling): those paths are dropped.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [polyline(rng, 0, 1, 5, 1, 3)], None, "#000"),
        path("2", [[[1, 1], [5e9, 1]]], None, "#000"),
        path("3", [rect(0, 0, 2, 2)], "#fff", "#000"),
        path("4", [[[-1e300, 0], [1, 1]]], None, "#000"),
        path("5", [[[1, 0.5], [4294967295.9999995, 0.5]]], None, "#000"),
        path("6", [[[-4294967296.0, 0.25], [1, 0.25]]], None, "#000"),
    ]}], bounds=None)
    # Bad fill rules and an empty fill: nextdraw raises.
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [rect(0, 0, 1, 1)], "#000", "#000", "inherit")]}])
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [rect(0, 0, 1, 1)], "#000", "#000"),
        path("2", [rect(0.5, 0.5, 2, 2)], "", "#000")]}])
    add([{"item_id": "a", "name": "1", "paths": [
        path("1", [rect(0, 0, 1, 1)], "none", "#000", "inherit")]}])

    # Random cases.
    for n in range(190):
        n_paths = rng.choice([2, 3, 4, 6, 8, 12])
        layers = random_layers(rng, n_paths, n_layers=rng.choice([1, 1, 1, 2, 3]))
        roll = rng.random()
        if roll < 0.1:
            bounds = None
        elif roll < 0.2:
            bounds = [[0.5, 0.5], [r6(rng.uniform(2, 7)), r6(rng.uniform(2, 5))]]
        else:
            bounds = B
        add(layers, bounds, rng.random() < 0.9)

    # Independent multi-subpath clippers over many strokes (per-subpath).
    for n in range(12):
        lines = [path(str(k), [polyline(rng, rng.uniform(0, 8), rng.uniform(0, 6),
                                        rng.uniform(0, 8), rng.uniform(0, 6), 4)],
                      None, "#000") for k in range(1, 30)]
        fills = [path(str(100 + k), random_shape(rng, "dots", 8, 6), "#fff",
                      rng.choice(STROKES), rng.choice(RULES)) for k in range(3)]
        mixed = lines[:10] + fills[:1] + lines[10:20] + fills[1:] + lines[20:]
        add([{"item_id": "a", "name": "1", "paths": mixed}])

    # >= 500 paths: the spatial-grid path.
    for n in range(3):
        paths = []
        for k in range(1, 521):
            if rng.random() < 0.5:
                sub = [poly_circle(rng, rng.uniform(0, 8), rng.uniform(0, 6),
                                   rng.uniform(0.05, 0.4), rng.randint(3, 6))]
                paths.append(path(str(k), sub, rng.choice(["#fff", "#000", None]),
                                  rng.choice(STROKES), rng.choice(RULES)))
            else:
                x, y = rng.uniform(0, 8), rng.uniform(0, 6)
                paths.append(path(str(k), [[[r6(x), r6(y)],
                                            [r6(x + rng.uniform(-1, 1)), r6(y + rng.uniform(-1, 1))]]],
                                  None, "#000"))
        add([{"item_id": "a", "name": "1", "paths": paths}])
    return cases


# ---------------------------------------------------------------- pyclipper

def clipper_cases():
    rng = random.Random(4)
    out = []
    for n in range(200):
        mode = rng.choice(["grid", "float", "circle"])

        def rp(k):
            if mode == "grid":
                return grid_poly(rng, k)
            if mode == "float":
                cx, cy, r = rng.uniform(0, 10), rng.uniform(0, 8), rng.uniform(0.1, 5)
                return [[cx + rng.uniform(-r, r), cy + rng.uniform(-r, r)] for _ in range(k)]
            return poly_circle(rng, rng.uniform(0, 10), rng.uniform(0, 8),
                               rng.uniform(0.1, 5), k)[:-1]
        clip = pyclipper.scale_to_clipper([rp(rng.randint(3, 10)) for _ in range(rng.randint(1, 3))])
        subj = pyclipper.scale_to_clipper([rp(rng.randint(2, 10)) for _ in range(rng.randint(1, 3))])
        case = {"clip": clip, "subj": subj, "closed": rng.random() < 0.5,
                "ct": rng.choice([pyclipper.CT_DIFFERENCE, pyclipper.CT_INTERSECTION]),
                "sft": rng.choice([0, 1]), "cft": rng.choice([0, 1])}
        try:
            pc = pyclipper.Pyclipper()
            pc.AddPaths(clip, pyclipper.PT_CLIP, closed=True)
            pc.AddPaths(subj, pyclipper.PT_SUBJECT, closed=case["closed"])
            res = pyclipper.PolyTreeToPaths(pc.Execute2(case["ct"], case["sft"], case["cft"]))
            case["out"] = res
            case["clean"] = [pyclipper.CleanPolygon(p) for p in res]
        except pyclipper.ClipperException as e:
            case["error"] = str(e)
        out.append(case)
    return out


# ---------------------------------------------------------------- sets

def pyset_cases():
    rng = random.Random(7)
    out = []
    for n in range(220):
        span = rng.choice([10, 40, 200, 3000])
        s = set()
        ops = []
        for _ in range(rng.randint(1, 90)):
            r = rng.random()
            if r < 0.6:
                k = rng.randrange(span)
                s.add(k)
                ops.append(["a", k])
            elif r < 0.85:
                k = rng.randrange(span)
                s.discard(k)
                ops.append(["d", k])
            else:
                other = set()
                keys = [rng.randrange(span) for _ in range(rng.randint(0, 30))]
                for k in keys:
                    other.add(k)
                s |= other
                ops.append(["u", keys])
        out.append({"ops": ops, "order": list(s)})
    return out


def boundary_cases():
    rng = random.Random(5)
    edge = 2**52 - 1
    out = []
    for n in range(40):
        def pt():
            return [rng.choice([1, -1]) * rng.randint(edge - 2**34, edge),
                    rng.choice([1, -1]) * rng.randint(edge - 2**34, edge)]
        clip = [[pt() for _ in range(rng.randint(3, 6))]]
        subj = [[pt() for _ in range(rng.randint(2, 6))]]
        case = {"clip": clip, "subj": subj, "closed": rng.random() < 0.5,
                "ct": rng.choice([pyclipper.CT_DIFFERENCE, pyclipper.CT_INTERSECTION]),
                "sft": rng.choice([0, 1]), "cft": rng.choice([0, 1])}
        try:
            pc = pyclipper.Pyclipper()
            pc.AddPaths(clip, pyclipper.PT_CLIP, closed=True)
            pc.AddPaths(subj, pyclipper.PT_SUBJECT, closed=case["closed"])
            res = pyclipper.PolyTreeToPaths(pc.Execute2(case["ct"], case["sft"], case["cft"]))
            case["out"] = res
            case["clean"] = [pyclipper.CleanPolygon(p) for p in res]
        except pyclipper.ClipperException as e:
            case["error"] = str(e)
        out.append(case)
    return out


def fma_cases():
    rng = random.Random(3)
    out = []
    for n in range(400):
        a = rng.choice([rng.uniform(-1e3, 1e3), float(rng.randint(-2**41, 2**41)),
                        rng.uniform(-1, 1) / 3])
        b = rng.choice([rng.uniform(-1e3, 1e3), float(rng.randint(-2**41, 2**41)),
                        1 / rng.uniform(-50, 50)])
        c = rng.choice([-(a * b), rng.uniform(-1e12, 1e12), float(rng.randint(-2**52, 2**52)),
                        a * b * (1 + 2**-52), 0.5])
        out.append([a, b, c, math.fma(a, b, c)])
    return out


data = {"process": process_cases(), "clipper": clipper_cases(), "pyset": pyset_cases(),
        "fma": fma_cases(), "boundary": boundary_cases()}
with gzip.open(OUT, "wt", encoding="utf8") as f:
    json.dump(data, f, separators=(",", ":"))
print(OUT, os.path.getsize(OUT), "bytes;", {k: len(v) for k, v in data.items()},
      "process errors:", sum(1 for c in data["process"] if "error" in c))
