/** Guards the RAG templates: manifests must validate and use only real capabilities. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const BUILTINS = new Set(["think", "recall", "remember", "rag.ingest", "rag.search"]);

for (const file of ["support-bot.manifest.json", "kb-ingest.manifest.json"]) {
  const m = JSON.parse(readFileSync(join(here, file), "utf8")) as Manifest;
  test(`${file}: manifest is valid`, () => {
    assert.deepEqual(validateManifest(m), [], `${file} should validate`);
  });
  test(`${file}: uses only known capabilities`, () => {
    for (const node of m.nodes) for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `${file} node '${node.id}' uses unknown '${cap.name}'`);
    }
  });
}

test("support-bot retrieves before it answers (rag.search before think)", () => {
  const m = JSON.parse(readFileSync(join(here, "support-bot.manifest.json"), "utf8")) as Manifest;
  const order = m.nodes.map(n => n.capabilities[0]?.name);
  assert.equal(order[0], "rag.search", "first node must retrieve");
  assert.ok(order.includes("think"), "must have a think node to answer");
});
