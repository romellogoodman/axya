"""Generate Python reference vectors for test/svg.helpers.test.ts and
test/optimize.helpers.test.ts. Run from the repo root:

    .venv-oracle/bin/python -I test/oracle/digest_vectors.py

Writes test/fixtures/digest-vectors.json. NaN and infinities, which JSON
can't represent, are written as {"__float__": "nan" | "inf" | "-inf"};
test/helpers/digestVectors.ts restores them.
"""
import sys, os, json, math, random, copy
sys.dont_write_bytecode = True
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
V = os.path.join(ROOT, "docs", "reference-apps", "nextdraw-1.7.5")
sys.path[:0] = [os.path.join(V, "nextdraw-api"), V]
from ink_extensions import simplepath, cubicsuperpath, simpletransform, simplestyle
from plotink import plot_utils, rtree, spatial_grid
from nextdrawcore import path_objects, plot_optimizations

def err(e):
    return {"error": type(e).__name__}

def attempt(f):
    try:
        return {"ok": f()}
    except Exception as e:
        return err(e)

out = {}

# Record every libm call ink_extensions makes, so tests can replay CPython's
# values where V8's Math functions differ by an ulp.
import types
LIBM = {}
def wrap(n, f):
    def w(x):
        r = f(x); LIBM[(n, x)] = r; return r
    return w
for n in ["sin", "cos", "tan", "acos"]:
    setattr(cubicsuperpath, n, wrap(n, getattr(math, n)))
proxy = types.SimpleNamespace(**{k: getattr(math, k) for k in dir(math) if not k.startswith("_")})
for n in ["sin", "cos", "tan", "acos"]:
    setattr(proxy, n, wrap(n, getattr(math, n)))
simpletransform.math = proxy

PATHS = [
    "M 10 20 L 30 40", "m10,20 l5,5 l-3-4z", "M1e-3.5.5L-.5.5", "M0,0L10,10,20,0,30,10",
    "M 0 0 H 10 V 10 h -5 v -5 Z", "M0 0 C 1 2 3 4 5 6 S 7 8 9 10 s 1 1 2 2",
    "M0 0 Q 1 1 2 0 T 4 0 t 2 0", "M10 10 A 5 5 0 0 1 20 10", "m10 10 a5 5 0 1 0 10 0",
    "M0 0 a 10 5 30 1 1 20 20", "M0 0 A 1 1 0 0 1 10 0", "M0 0 A 0 5 0 0 1 10 0",
    "M5 5 A 5 5 0 11 15 5", "M0 0 L 1", "L 1 1", "", "M0 0 Z L 5 5", "M0 0 z m 1 1 l 2 2",
    "M 1.5e2 -2E-1 L +3 -.25", "M0,0 10,10 20,0", "M0 0L10 0 M 5 5", "M0 0 A 5 5 -45 1 0 -10 3",
    "M2 2 Z 3 3", "M 0 0 c 1 1 2 2 3 3 4 4 5 5 6 6", "M0-1-2-3", "M0.1.2.3.4", "M 1e 2 L 3 4",
    "M 0 0 A 3 4 10 0 0 0 0", "M 0 0 T 5 5", "M0 0 S 1 1 2 2",
]
out["simplepath"] = [[d, attempt(lambda: simplepath.parsePath(d))] for d in PATHS]
out["cubicsuperpath"] = [[d, attempt(lambda: cubicsuperpath.parsePath(d))] for d in PATHS]
out["formatPath"] = [[d, attempt(lambda: simplepath.formatPath(simplepath.parsePath(d)))] for d in PATHS[:12]]

TRANSFORMS = [
    "translate(10)", "translate(10, 20)", "translate(1e1,-2.5e-1)", "scale(2)", "scale(2,-3)",
    "rotate(45)", "rotate(30 10 20)", "rotate(15) scale(1.5,0.8)", "translate(100,350) rotate(15) scale(1.5,0.8)",
    "skewX(20)", "skewY(-33.3)", "matrix(0.9,0.2,-0.2,0.9,120,0)", "matrix(1 0 0 1 5 6)",
    "  translate(1,2) , scale(3)  ", "rotate(10 1)", "matrix(1,2,3)", "foo(1)", "translate(1) foo",
    "scale()", "translate(1,2)scale(2)", "rotate(-90)", "rotate(180)", "rotate(1e2)",
    "scale(1.041667E-02,1.041667E-02) translate(0.000000E+00,-1.250000E+01)",
]
out["transform"] = [[t, attempt(lambda: simpletransform.parseTransform(t))] for t in TRANSFORMS]
random.seed(5)
comp = []
for _ in range(20):
    a = [[random.uniform(-3, 3) for _ in range(3)] for _ in range(2)]
    b = [[random.uniform(-3, 3) for _ in range(3)] for _ in range(2)]
    comp.append([a, b, simpletransform.composeTransform(a, b), simpletransform.invertTransform(a),
                 simpletransform.formatTransform(a)])
out["compose"] = comp

STYLES = ["fill:none;stroke:#000", " fill : red ; ; stroke:blue;", "display:none", "a:b:c", "nocolon", "", ";;"]
out["style"] = [[s, attempt(lambda: sorted(simplestyle.parseStyle(s).items()))] for s in STYLES]

LENGTHS = ["10", "10px", "2in", "25.4mm", "2.54cm", "40Q", "40q", "6pc", "72pt", "50%", " 3 mm ",
           "10MM", "abc", "", "1e2mm", "-5in", "1_0in", "inf", "nan", ".5in", "5.in", "10em"]
out["lengths"] = [[s, list(plot_utils.parseLengthWithUnits(s)),
                   plot_utils.unitsToUserUnits(s), plot_utils.unitsToUserUnits(s, 300.0)] for s in LENGTHS]
class Alt:
    def __init__(self, v):
        from lxml import etree
        e = etree.Element("svg")
        if v is not None:
            e.set("width", v)
        self.document = etree.ElementTree(e)
out["inches"] = [[s, plot_utils.getLengthInches(Alt(s), "width")] for s in LENGTHS]

VB = [("0 0 100 100", None, 4.0, 4.0), ("0 0 200 100", None, 4.0, 4.0), ("0 0 100 200", None, 4.0, 4.0),
      ("10 20 100 50", "none", 8.0, 6.0), ("0,0,100,50", "xMinYMin", 4.0, 4.0), ("0 0 100 50", "xMaxYMax meet", 4.0, 4.0),
      ("0 0 100 50", "xMidYMax slice", 4.0, 4.0), ("0 0 50 100", "xMaxYMid slice", 4.0, 4.0), ("0 0 50 100", "xMinYMax", 4.0, 4.0),
      ("0 0 50 100", "XMAXYMIN", 4.0, 4.0), ("0 0 0 100", None, 4.0, 4.0), ("0 0 100", None, 4.0, 4.0),
      ("a b c d", None, 4.0, 4.0), (None, None, 4.0, 4.0), ("0 0 100 100", None, 0.0, 4.0), ("0 0 inf 5", None, 1.0, 1.0),
      ("-5 -5 297 210", "xMidYMid", 11.69, 8.27), ("0 0 800 600", None, 8.0, 6.0)]
out["vbscale"] = [[list(v), plot_utils.vb_scale_2(*v)] for v in VB]

random.seed(11)
subdiv = []
for i in range(40):
    pts = [[random.uniform(-5, 5), random.uniform(-5, 5)] for _ in range(4)]
    if i % 7 == 0:
        pts[3] = list(pts[0])
    if i % 9 == 0:
        pts[1] = list(pts[0]); pts[2] = list(pts[0]); pts[3] = list(pts[0])
    sp = [[pts[0], pts[0], pts[1]], [pts[2], pts[3], pts[3]]]
    tol = random.choice([0.5, 0.05, 0.002 / 3, 0.0, -1.0])
    s2 = copy.deepcopy(sp)
    plot_utils.subdivideCubicPath(s2, tol)
    subdiv.append([sp, tol, s2])
out["subdivide"] = subdiv

ss = []
for i in range(30):
    n = random.randint(0, 40)
    x = 0.0; v = []
    for _ in range(n):
        x += random.uniform(0, 0.01)
        v.append([x, math.sin(x * 50) * random.choice([0.0001, 0.001, 0.01])])
    if i % 5 == 0 and v:
        v.append(list(v[0]))
    tol = random.choice([0.0005, 0.002 / 3, 0.01, 0.0])
    v2 = copy.deepcopy(v)
    plot_utils.supersample(v2, tol)
    ss.append([v, tol, v2])
out["supersample"] = ss

clip = []
for _ in range(60):
    seg = [[random.uniform(-2, 6), random.uniform(-2, 6)] for _ in range(2)]
    bounds = [[0, 0], [random.choice([4.0, 3.0]), 4.0]]
    a, s = plot_utils.clip_segment(seg, bounds)
    clip.append([seg, bounds, a, s])
out["clip"] = clip

iso = []
for _ in range(30):
    a = random.uniform(-1, 1)
    b = random.choice([a, a * (1 + 1e-10), a * (1 + 2e-9), a + 1e-12, -a, 0.0])
    iso.append([[a, b], [b, a], plot_utils.points_equal([a, b], [b, a])])
out["isclose"] = iso

NAMES = ["1 black", "%notes", "!2 swap pen", "3+s50+m4+g4 slow", "2+d300+h45 red", "+d", "12+d", "12+d0+h101+s0+s111+m5+g5",
         "  1 lead", "!", "", "abc", "7+H20+S30 x", "4+x5", "5+h", "005+g2", "+s+h10", "１２+h3", "1+d500"]
def props(n):
    p = path_objects.LayerProperties(); p.parse(n); d = dict(vars(p)); d["compose"] = p.compose(); return d
out["layernames"] = [[n, attempt(lambda: props(n))] for n in NAMES]

# Python random
mt = []
for seed in [0, 1, 42, 2**32 + 5, 170000000000, -7, 2**70 + 3, 123456789012345678]:
    r = random.Random(seed)
    words = [r.getrandbits(32) for _ in range(8)]
    floats = [r.random() for _ in range(4)]
    big = [str(r.getrandbits(k)) for k in (1, 7, 31, 33, 64, 65)]
    ranges = [r.randrange(n) for n in (1, 2, 3, 10, 99, 1000, 2**31 - 1, 2**32 + 1)]
    mt.append([str(seed), words, floats, big, ranges])
r = random.Random(170000000000)
mt_long = [r.getrandbits(32) for _ in range(1500)]
out["mt"] = mt
out["mt_long"] = mt_long

fx = []
for x in [0.0, -0.0, 1.0, -1.0, 1/96, 0.5, 0.0078125, 0.00000075, 1.5e-7, 12345678.5, 123456785.0, 9.9999995,
          9.99999949999, 1e300, 5e-324, 2.5e-5, 0.000000125, 1.0000005, 1.00000050000001, float("inf"), float("nan"), -2.5]:
    fx.append([x if math.isfinite(x) else repr(x), f"{x:.6E}", f"{x:.2E}", f"{x:.0E}", f"{x:f}"])
random.seed(3)
for _ in range(200):
    x = random.uniform(-1, 1) * 10 ** random.randint(-12, 12)
    fx.append([x, f"{x:.6E}", f"{x:.2E}", f"{x:.0E}", f"{x:f}"])
out["formatExp"] = fx

# Optimizations on synthetic flat digests
def make_digest(rng, npaths, layers=1):
    d = path_objects.DocDigest(); d.flat = True
    for li in range(layers):
        layer = path_objects.LayerItem(); layer.name = str(li); layer.item_id = str(li)
        for i in range(npaths):
            p = path_objects.PathItem(); p.item_id = f"{li}_{i}"
            n = rng.randint(2, 6)
            x, y = rng.uniform(0, 5), rng.uniform(0, 5)
            v = [[x, y]]
            for _ in range(n - 1):
                x += rng.choice([0.0, rng.uniform(-0.3, 0.3)]); y += rng.uniform(-0.3, 0.3)
                v.append([round(x, 3), round(y, 3)])
            if rng.random() < 0.3:
                v.append(list(v[0]))
            p.subpaths = [v]
            layer.paths.append(p)
        d.layers.append(layer)
    return d
def dump(d):
    return copy.deepcopy([[[p.item_id, p.subpaths[0]] for p in l.paths] for l in d.layers])
opt = []
rng = random.Random(77)
for i in range(16):
    n = rng.choice([1, 2, 5, 17, 40, 120])
    d = make_digest(rng, n, layers=rng.choice([1, 2]))
    # snap some endpoints together so joining happens
    allp = [p for l in d.layers for p in l.paths]
    for k in range(len(allp) // 2):
        a, b = rng.sample(allp, 2) if len(allp) > 1 else (allp[0], allp[0])
        b.subpaths[0][0] = list(a.subpaths[0][-1]) if rng.random() < 0.5 else [a.subpaths[0][-1][0] + 0.004, a.subpaths[0][-1][1]]
    reord = rng.choice([0, 1, 2, 3, 4])
    gap = rng.choice([0.006, 0.0, -1.0, 0.05])
    seed = rng.choice([None, 1, 170000000000])
    inp = dump(d)
    plot_optimizations.connect_nearby_ends(d, gap, reord)
    joined = dump(d)
    plot_optimizations.supersample(d, 0.002 / 3)
    sampled = dump(d)
    if seed is not None:
        plot_optimizations.randomize_start(d, seed)
    rand = dump(d)
    plot_optimizations.reorder(d, reord)
    opt.append({"input": inp, "gap": gap, "reordering": reord, "seed": seed, "joined": joined,
                "supersampled": sampled, "randomized": rand, "reordered": dump(d)})
out["optimize"] = opt

# Crop (resume), rotation, and plob output/input
from lxml import etree
crops = []
rng = random.Random(9)
for i in range(10):
    d = make_digest(rng, rng.choice([3, 8]), layers=2)
    for li, l in enumerate(d.layers):
        l.name = ["!1+d200 a", "2+d300 b"][li]; l.parse_name()
    plot_optimizations.randomize_start(d, 1 + i)
    inp = dump(d)
    total = d.length()
    dist = rng.choice([0, -1, total * rng.random(), total + 1, d.layers[0].paths[0].length()])
    d.crop(dist)
    crops.append({"input": inp, "names": ["!1+d200 a", "2+d300 b"], "seed": 1 + i, "distance": dist,
                  "layers": [[l.name, vars(l.props), copy.deepcopy([[p.item_id, p.subpaths[0]] for p in l.paths])] for l in d.layers]})
out["crop"] = crops
rot = []
for ccw in (True, False):
    d = make_digest(random.Random(4), 4)
    d.width, d.height = 6.0, 9.5
    d.layers[0].paths[0].subpaths.append([[1.0, 2.0]])
    inp = dump(d)
    d.rotate(ccw)
    rot.append({"ccw": ccw, "input": inp, "width": d.width, "height": d.height, "viewbox": d.viewbox,
                "subpaths": [[p.subpaths for p in l.paths] for l in d.layers]})
out["rotate"] = rot
d = make_digest(random.Random(8), 3, layers=2)
d.layers[0].name = "__digest-root__"
d.layers[1].name = "3+s40+g2 pens"; d.layers[1].parse_name()
d.width, d.height = 4.0, 3.0; d.viewbox = "0 0 4.000000 3.000000"; d.name = "doc.svg"
d.metadata["k"] = "v"
plob = d.to_plob()
root = plob.getroot()
out["plob"] = {
    "input": dump(d),
    "attrs": dict(root.attrib),
    "children": [[c.tag, dict(c.attrib), [[g.tag, dict(g.attrib)] for g in c]] for c in root],
}
mm = etree.tostring(plob).decode().replace('width="4.000000in"', 'width="101.6mm"').replace('height="3.000000in"', 'height="76.2mm"')
d2 = path_objects.DocDigest()
d2.from_plob(etree.fromstring(mm), 4.0, 3.0)
out["plob"]["from_mm"] = mm
out["plob"]["reparsed"] = {"width": d2.width, "height": d2.height, "viewbox": d2.viewbox, "name": d2.name,
                          "layers": [[l.name, l.item_id, [[p.item_id, p.subpaths] for p in l.paths]] for l in d2.layers]}

out["libm"] = [[n, x, r] for (n, x), r in sorted(LIBM.items())]


def tag_specials(value):
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return {"__float__": "nan" if value != value else ("inf" if value > 0 else "-inf")}
    if isinstance(value, dict):
        return {k: tag_specials(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [tag_specials(v) for v in value]
    return value


with open(os.path.join(ROOT, "test", "fixtures", "digest-vectors.json"), "w", encoding="utf8") as f:
    json.dump(tag_specials(out), f, allow_nan=False)
    f.write("\n")
