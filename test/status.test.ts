import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import {
  formatHms,
  parseDist,
  ResumeStatus,
} from "../server/driver/run/status.ts";
import { caseNames, fixtureUrl, loadGolden } from "./helpers/fixtures.ts";

function inputSvg(name: string): string {
  const svg = loadGolden(name).case.svg;
  if (typeof svg === "string")
    return readFileSync(fixtureUrl(`../../${svg}`), "utf8");
  if (svg) return loadGolden(svg.from).output_svg ?? "";
  throw new Error(`${name}: no svg`);
}

const parse = (text: string) =>
  new DOMParser().parseFromString(text, "image/svg+xml")
    .documentElement as Element;

// Preview runs also add a rendered "% Preview" layer (preview.py); the full
// run-loop tests cover those.
const plain = (n: string) =>
  loadGolden(n).output_svg && !loadGolden(n).case.options.preview;

for (const name of caseNames().filter(plain)) {
  test(`plotdata round-trips to nextdraw's output SVG: ${name}`, () => {
    const golden = loadGolden(name);
    const expected = golden.output_svg as string;
    // Values nextdraw wrote:
    const written = new ResumeStatus();
    written.readFromSvg(parse(expected));
    assert.ok(written.read, "golden output has readable plotdata");
    // Our write over the input document:
    const root = parse(inputSvg(name));
    const status = new ResumeStatus();
    Object.assign(status.new, written.old);
    status.writeToSvg(root);
    const out = new XMLSerializer().serializeToString(
      root.ownerDocument as never
    );
    assert.equal(out, expected);
  });
}

test("parseDist units", () => {
  assert.equal(parseDist("25.4", "mm"), 1);
  assert.equal(parseDist(" 2.54CM ", "in"), 1);
  assert.equal(parseDist("3in", "mm"), 3);
  assert.equal(parseDist("1.0", "in"), 1);
  assert.throws(() => parseDist("3ft", "in"), /Unknown unit/);
});

test("formatHms", () => {
  assert.equal(formatHms(7.708), "7.708 Seconds");
  assert.equal(formatHms(42.5), "42 Seconds");
  assert.equal(formatHms(43.5), "44 Seconds");
  assert.equal(formatHms(125), "2:05 (Minutes, seconds)");
  assert.equal(formatHms(3725000, true), "1:02:05 (Hours, minutes, seconds)");
});
