import { test } from "node:test";
import assert from "node:assert/strict";

import { extractArtifact } from "./artifact-extractor.js";
import type { Manifest } from "../core/manifest/manifest.js";

function seed(output_map?: string): Pick<Manifest, "seed"> {
  return { seed: output_map ? { output_map } : {} };
}

// ── output_map precedence ────────────────────────────────────────────────────────

test("extractor: output_map wins — uses declared title/body/format", () => {
  const a = extractArtifact(
    seed("title=compose.title,body=compose.body,format=markdown"),
    { "compose.title": "The Headline", "compose.body": "The full brief.", "other.result": "SHOULD NOT WIN" },
  );
  assert.deepEqual(a, { title: "The Headline", body: "The full brief.", format: "markdown" });
});

test("extractor: output_map with no titleKey derives a title from the body", () => {
  const a = extractArtifact(seed("body=write.body"), { "write.body": "First line here\nsecond line" });
  assert.equal(a?.body, "First line here\nsecond line");
  assert.equal(a?.title, "First line here", "title derived from first line");
  assert.equal(a?.format, "markdown");
});

test("extractor: output_map whose body key is empty falls back to the heuristic (text)", () => {
  // declared body key resolves to empty → don't emit an empty artifact; heuristic picks .result
  const a = extractArtifact(
    seed("body=compose.body"),
    { "compose.body": "   ", "step.result": "The heuristic answer." },
  );
  assert.equal(a?.body, "The heuristic answer.");
  assert.equal(a?.format, "text", "fell through to heuristic → text format");
});

test("extractor: a malformed output_map falls back to the heuristic", () => {
  const a = extractArtifact(seed("garbage-no-equals"), { "x.body": "prose output here" });
  assert.equal(a?.body, "prose output here");
  assert.equal(a?.format, "text");
});

// ── heuristic parity (verbatim port of inbox extractOutput) ───────────────────────

test("extractor heuristic: prefers the suffix priority list (.result before .body)", () => {
  const a = extractArtifact(seed(), { "a.body": "body value", "z.result": "result value" });
  assert.equal(a?.body, "result value", ".result outranks .body");
});

test("extractor heuristic: falls back to the longest substantial string", () => {
  const long = "x".repeat(60);
  const a = extractArtifact(seed(), { "weird_key": long, "small": "hi" });
  assert.equal(a?.body, long);
  assert.equal(a?.format, "text");
});

test("extractor heuristic: notable-values line when there's no prose", () => {
  const a = extractArtifact(seed(), { "analyze.price": "19.99", "check.ok": true });
  assert.ok(a, "produces a notable-values summary");
  assert.match(a!.body, /price: 19\.99/);
  assert.match(a!.body, /ok: true/);
});

test("extractor heuristic: truncates a long headline with an ellipsis", () => {
  const long = "y".repeat(300);
  const a = extractArtifact(seed(), { "n.body": long });
  assert.ok(a!.title.length <= 180, "headline clamped");
  assert.ok(a!.title.endsWith("…"), "ellipsized");
  assert.equal(a!.body, long, "body is the full text");
});

test("extractor heuristic: ignores engine-injected (_) keys in the longest-string pass", () => {
  // Underscore-prefixed keys are excluded from the longest-string prose pass (verbatim port);
  // with only _ keys present there is no prose, and no notable values either → null.
  const a = extractArtifact(seed(), { "_runId": "r1", "_agentId": "a1", "_note": "x".repeat(80) });
  assert.equal(a, null, "only engine-injected keys → null");
});

test("extractor: a run with nothing surfaceable returns null", () => {
  assert.equal(extractArtifact(seed(), {}), null);
  assert.equal(extractArtifact(seed(), { "_runId": "r" }), null);
});
