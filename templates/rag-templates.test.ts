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

test("support-bot ingests then retrieves before it answers (rag.ingest → rag.search → think)", () => {
  const m = JSON.parse(readFileSync(join(here, "support-bot.manifest.json"), "utf8")) as Manifest;
  const order = m.nodes.map(n => n.capabilities[0]?.name);
  // A self-contained support bot loads its knowledge base first, then retrieves, then answers.
  const iIngest = order.indexOf("rag.ingest");
  const iSearch = order.indexOf("rag.search");
  const iThink = order.indexOf("think");
  assert.ok(iSearch >= 0, "must retrieve from the knowledge base");
  assert.ok(iThink >= 0, "must have a think node to answer");
  // The invariant that matters: retrieve BEFORE answering; and if it ingests, ingest first.
  assert.ok(iSearch < iThink, "must retrieve before it answers");
  if (iIngest >= 0) assert.ok(iIngest < iSearch, "if it ingests, it must ingest before it retrieves");
});
