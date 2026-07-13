/**
 * Guards output_map across ALL shipped templates (A2). A template that declares an
 * output_map in its seed MUST: parse cleanly, reference a node that exists, and — because
 * this is the drift class that produced the last round of stale-rig failures — stay in
 * sync with the manifest whenever a node id changes. This one test covers every template
 * file at once, so adding a template with a bad output_map fails here before it ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, fatalIssues, type Manifest } from "../src/core/manifest/manifest.js";
import { parseOutputMap } from "../src/core/manifest/output-map.js";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith(".manifest.json"));

test("every shipped template still validates with no fatal issues", () => {
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(here, f), "utf8")) as Manifest;
    assert.deepEqual(fatalIssues(validateManifest(m)), [], `${f} has fatal validation issues`);
  }
});

test("every declared output_map parses and references a node that exists", () => {
  let declared = 0;
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(here, f), "utf8")) as Manifest;
    const rawMap = m.seed?.["output_map"];
    if (rawMap === undefined) continue;
    declared++;
    const om = parseOutputMap(m.seed);
    assert.ok(om, `${f}: output_map ${JSON.stringify(rawMap)} must parse`);
    // A referenced node that doesn't exist surfaces as a NON-FATAL note in validation.
    const note = validateManifest(m).find((i) => i.code === "OUTPUT_MAP_UNKNOWN_NODE");
    assert.equal(note, undefined, `${f}: output_map references a missing node — ${note?.message}`);
  }
  // The prose-composing flagships must carry output_map so their deliverable is captured
  // deterministically rather than by heuristic. If this drops, a template lost its map.
  assert.ok(declared >= 11, `expected >= 11 templates to declare output_map, found ${declared}`);
});
