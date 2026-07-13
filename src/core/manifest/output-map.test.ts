import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOutputMap, outputMapKeys } from "./output-map.js";
import { validateManifest, fatalIssues, type Manifest } from "./manifest.js";

// ── parseOutputMap ────────────────────────────────────────────────────────────

test("output-map: parses the canonical declaration", () => {
  const m = parseOutputMap("title=compose.title,body=compose.body,format=markdown");
  assert.deepEqual(m, { titleKey: "compose.title", bodyKey: "compose.body", format: "markdown" });
});

test("output-map: accepts a seed object (reads the output_map field)", () => {
  const m = parseOutputMap({ output_map: "body=write.body", other: "ignored" });
  assert.deepEqual(m, { bodyKey: "write.body", format: "markdown" });
});

test("output-map: format defaults to markdown; text is honored", () => {
  assert.equal(parseOutputMap("body=x.y")?.format, "markdown");
  assert.equal(parseOutputMap("body=x.y,format=text")?.format, "text");
  // an unknown format value is ignored → default markdown
  assert.equal(parseOutputMap("body=x.y,format=pdf")?.format, "markdown");
});

test("output-map: title is optional; body is required", () => {
  assert.deepEqual(parseOutputMap("body=n.b"), { bodyKey: "n.b", format: "markdown" });
  assert.equal(parseOutputMap("title=n.t,format=markdown"), null, "no body → null");
  assert.equal(parseOutputMap("title=n.t"), null, "title alone → null");
});

test("output-map: bare (non-node-scoped) keys are allowed", () => {
  assert.deepEqual(parseOutputMap("body=answer"), { bodyKey: "answer", format: "markdown" });
});

test("output-map: malformed input falls back to null (never throws)", () => {
  assert.equal(parseOutputMap(""), null);
  assert.equal(parseOutputMap("   "), null);
  assert.equal(parseOutputMap("no_equals_sign"), null);
  assert.equal(parseOutputMap("=orphan"), null, "empty left side ignored → no body");
  assert.equal(parseOutputMap("body="), null, "empty value ignored → no body");
  assert.equal(parseOutputMap("body=has spaces"), null, "invalid key shape rejected → no body");
  assert.equal(parseOutputMap("body=a.b.c"), null, "too-deep key rejected → no body");
  assert.equal(parseOutputMap(null), null);
  assert.equal(parseOutputMap(undefined), null);
  assert.equal(parseOutputMap({}), null, "seed with no output_map → null");
});

test("output-map: a malformed field among valid ones is skipped, the rest parse", () => {
  const m = parseOutputMap("title=,body=compose.body,junk,format=text");
  assert.deepEqual(m, { bodyKey: "compose.body", format: "text" }, "bad title dropped, body+format kept");
});

test("output-map: outputMapKeys returns referenced keys (title then body)", () => {
  assert.deepEqual(outputMapKeys("title=c.t,body=c.b"), ["c.t", "c.b"]);
  assert.deepEqual(outputMapKeys("body=c.b"), ["c.b"]);
  assert.deepEqual(outputMapKeys("garbage"), []);
});

// ── validateManifest: the non-fatal note ─────────────────────────────────────────

function baseManifest(seed: Record<string, string>): Manifest {
  return {
    version: 1,
    name: "t",
    intent: "t",
    entry: "compose",
    runBudgetCents: 100,
    maxNodeVisits: 5,
    seed,
    nodes: [{ id: "compose", role: "write", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 10 }] }],
    edges: [],
  };
}

test("validateManifest: output_map pointing at a real node produces no issues", () => {
  const issues = validateManifest(baseManifest({ output_map: "title=compose.title,body=compose.body" }));
  assert.deepEqual(issues, [], `unexpected: ${issues.map(i => i.message).join("; ")}`);
});

test("validateManifest: output_map pointing at a MISSING node is a NON-FATAL note", () => {
  const issues = validateManifest(baseManifest({ output_map: "body=ghost.body" }));
  const note = issues.find(i => i.code === "OUTPUT_MAP_UNKNOWN_NODE");
  assert.ok(note, "a note is emitted for the unknown node");
  assert.equal(note!.severity, "note", "it is a note, not an error");
  // The blocking subset must be empty — the agent still installs and runs.
  assert.deepEqual(fatalIssues(issues), [], "the note does not block");
});

test("validateManifest: bare-key output_map is not node-checked (no note)", () => {
  const issues = validateManifest(baseManifest({ output_map: "body=answer" }));
  assert.equal(issues.find(i => i.code === "OUTPUT_MAP_UNKNOWN_NODE"), undefined);
});
