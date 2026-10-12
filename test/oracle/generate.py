"""
Regenerate golden fixtures: run every case in test/fixtures/cases.json through
the vendored nextdraw (test/oracle/run.py) and write
test/fixtures/golden/<name>.json.

    .venv-oracle/bin/python -I test/oracle/generate.py [case-name ...]

Each case runs in a fresh subprocess so module-level state in nextdraw can't
leak between cases.
"""

import json
import os
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True  # keep vendored source dirs clean

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FIXTURES = os.path.join(ROOT, "test", "fixtures")
GOLDEN = os.path.join(FIXTURES, "golden")

DEFAULTS = {"options": {"model": 8}, "params": {"check_updates": False},
            "fake": {"homed": True, "motors_on": True}}


def resolve(name, cases, done):
    case = cases[name]
    merged = {key: {**DEFAULTS[key], **case.get(key, {})} for key in DEFAULTS}
    if "svg" in case:
        merged["svg"] = os.path.join("test", "fixtures", "svg", case["svg"])
    if "svg_from" in case:
        source = case["svg_from"]
        if source not in done:
            done[source] = run(source, cases, done)
        tmp = tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False, encoding="utf8")
        tmp.write(done[source]["output_svg"])
        tmp.close()
        merged["svg"] = os.path.relpath(tmp.name, ROOT)
    return merged


def run(name, cases, done):
    merged = resolve(name, cases, done)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(merged, f)
    proc = subprocess.run([sys.executable, "-I", os.path.join(HERE, "run.py"), f.name],
                          capture_output=True, text=True, check=False)
    os.unlink(f.name)
    if proc.returncode != 0:
        raise SystemExit(f"case {name} failed:\n{proc.stderr}")
    result = json.loads(proc.stdout)
    if "svg_from" in cases[name]:
        os.unlink(os.path.join(ROOT, merged["svg"]))
        merged["svg"] = {"from": cases[name]["svg_from"]}
    result["case"] = merged
    return result


def main():
    with open(os.path.join(FIXTURES, "cases.json"), encoding="utf8") as f:
        cases = json.load(f)["cases"]
    names = sys.argv[1:] or list(cases)
    os.makedirs(GOLDEN, exist_ok=True)
    done = {}
    for name in names:
        if name not in done:
            done[name] = run(name, cases, done)
        result = done[name]
        with open(os.path.join(GOLDEN, f"{name}.json"), "w", encoding="utf8") as f:
            json.dump(result, f, indent=1)
            f.write("\n")
        print(f"{name}: {len(result['commands'])} commands, status {result['status_code']}")


if __name__ == "__main__":
    main()
