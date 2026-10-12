/**
 * cxxSort permutes equal elements exactly as libc++'s std::sort does, which
 * Clipper's output order depends on. Vectors: test/oracle/clipping_sort_vectors.cpp;
 * its McIlroy "killer" inputs reach introsort's heap-sort fallback.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cxxHeapSort, cxxSort } from "../server/driver/digest/clippingSort.ts";

interface Vector {
  kind: "sort" | "heap";
  keys: number[];
  ids: number[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/clipping-sort-vectors.json", import.meta.url),
    "utf8"
  )
) as Vector[];

test("cxxSort matches libc++ std::sort and partial_sort", () => {
  for (const [n, v] of vectors.entries()) {
    const items = v.keys.map((key, id) => ({ key, id }));
    const comp = (a: { key: number }, b: { key: number }) => b.key < a.key;
    if (v.kind === "sort") cxxSort(items, comp);
    else cxxHeapSort(items, comp);
    assert.deepEqual(
      items.map((i) => i.id),
      v.ids,
      `vector ${n} (${v.kind}, n=${v.keys.length})`
    );
  }
  assert.equal(vectors.length, 244);
});
