"""
Generate test vectors for the TypeScript port of plotink/ebb_calc.py.

    .venv-oracle/bin/python -I test/oracle/ebb_calc_vectors.py

Writes test/fixtures/ebb-calc-vectors.json with inputs and Python outputs for
move_dist_t3, rate_t3 and max_rate_t3. Inputs come from three sources:
the T3/TD parameters actually emitted in the golden command streams, edge
cases around rounding and sign boundaries, and seeded random sweeps.
"""

import glob
import json
import os
import random
import sys

sys.dont_write_bytecode = True

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "docs", "reference-apps", "nextdraw-1.7.5"))

from plotink import ebb_calc  # noqa: E402


def golden_inputs():
    """(time, rate, accel, jerk) per axis for every T3 and TD in the goldens."""
    found = set()
    for path in sorted(glob.glob(os.path.join(ROOT, "test", "fixtures", "golden", "*.json"))):
        with open(path, encoding="utf8") as f:
            for _ms, line in json.load(f)["commands"]:
                parts = line.split(",")
                nums = [int(p) for p in parts[1:]] if parts[0] in ("T3", "TD") else None
                if parts[0] == "T3":
                    found.add((nums[0], nums[1], nums[2], nums[3]))
                    found.add((nums[0], nums[4], nums[5], nums[6]))
                elif parts[0] == "TD":
                    t, r1a, r1b, a1, j1, r2a, r2b, a2, j2 = nums[:9]
                    for args in ((t, r1a, 0, j1), (t, r1b, a1, -j1),
                                 (t, r2a, 0, j2), (t, r2b, a2, -j2)):
                        found.add(args)
    return sorted(found)


def edge_inputs():
    big = 2147483647
    cases = []
    for t in (0, 1, 2, 3, 7, 1000, 25000, 200000):
        for r in (0, 1, -1, 490123456, -490123456, big, -big, 1073741824, -1073741824):
            for a in (0, 1, -1, 3, -3, 400000, -400000, 125000, -125001):
                for j in (0, 1, -1, 5, -5, 6, -6, 7, -7, 11, -11, 2000, -2003):
                    cases.append((t, r, a, j))
    return cases


def random_inputs(rng, n):
    cases = []
    for _ in range(n):
        t = rng.choice([rng.randint(1, 50), rng.randint(1, 5000), rng.randint(1, 300000)])
        r = rng.randint(-2**31 + 1, 2**31 - 1) if rng.random() < 0.3 else rng.randint(-60000000, 60000000)
        a = rng.choice([0, rng.randint(-200000, 200000), rng.randint(-5000000, 5000000)])
        j = rng.choice([0, rng.randint(-50, 50), rng.randint(-20000, 20000)])
        cases.append((t, r, a, j))
    return cases


def main():
    rng = random.Random(20261012)
    inputs = golden_inputs()
    golden_count = len(inputs)
    inputs += edge_inputs() + random_inputs(rng, 6000)
    vectors = []
    for (t, r, a, j) in inputs:
        accum = "clear" if rng.random() < 0.5 else rng.randint(0, 2**31 - 1)
        steps, acc = ebb_calc.move_dist_t3(t, r, a, j, accum)
        vectors.append({
            "in": [t, r, a, j, accum],
            "move": [steps, acc],
            "rate": ebb_calc.rate_t3(t, r, a, j),
            "max": ebb_calc.max_rate_t3(t, r, a, j),
        })
    out = os.path.join(ROOT, "test", "fixtures", "ebb-calc-vectors.json")
    with open(out, "w", encoding="utf8") as f:
        json.dump({"source": "plotink/ebb_calc.py " + ebb_calc.__version__,
                   "golden_inputs": golden_count, "vectors": vectors}, f, separators=(",", ":"))
        f.write("\n")
    print(f"{len(vectors)} vectors ({golden_count} from goldens) -> {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
