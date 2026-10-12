/**
 * The TS digest pipeline reproduces every DocDigest snapshot the Python
 * oracle recorded (test/fixtures/stages), stage by stage, exactly.
 *
 * CPython's libm and V8 differ by one ulp on a few sin/cos/tan inputs.
 *   Those calls replay recorded CPython values (test/helpers/digestLibm.ts);
 *   test/svg.libm.test.ts bounds the difference itself.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { DocDigest } from "../server/driver/digest/pathObjects.ts";
import { prepareDocument } from "../server/driver/digest/prepare.ts";
import { setLibm } from "../server/driver/svg/libm.ts";
import type { DigestSnapshot } from "./helpers/fixtures.ts";
import { loadStages, stageNames } from "./helpers/fixtures.ts";
import { digestLibmReplay } from "./helpers/digestLibm.ts";
import {
  caseContext,
  caseSvgText,
  digestSnapshot,
  parseSvgRoot,
} from "./helpers/digestSnapshot.ts";

let restore = () => {};
before(() => {
  restore = setLibm(digestLibmReplay());
});
after(() => restore());

for (const name of stageNames()) {
  const stages = loadStages(name);
  if (!stages.digest) continue;
  const want = stages.digest;

  test(`digest stages: ${name}`, () => {
    const root = parseSvgRoot(caseSvgText(name));
    const ctx = caseContext(stages, root);
    const got: [string, DigestSnapshot][] = [];
    ctx.onStage = (stage: string, d: DocDigest) =>
      got.push([stage, digestSnapshot(d)]);
    prepareDocument(root, ctx);
    assert.deepEqual(
      got.map(([s]) => s),
      want.map(([s]) => s),
      "stage sequence"
    );
    for (let i = 0; i < want.length; i++) {
      assert.deepStrictEqual(got[i][1], want[i][1], `stage ${want[i][0]}`);
    }
  });
}
