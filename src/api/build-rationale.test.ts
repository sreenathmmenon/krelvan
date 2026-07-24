import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest } from "../core/manifest/manifest.js";
import { normalizeBuildRationale } from "./server.js";

const manifest: Manifest = {
  version: 1,
  name: "Source digest",
  intent: "Fetch a source and summarize it.",
  entry: "fetch",
  runBudgetCents: 100,
  maxNodeVisits: 4,
  nodes: [
    {
      id: "fetch",
      role: "Fetch the source.",
      autonomy: "full",
      capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 10 }],
    },
    {
      id: "summarize",
      role: "Summarize the fetched source.",
      autonomy: "full",
      capabilities: [{ name: "think", sideEffect: "read", budgetCents: 20 }],
    },
  ],
  edges: [{ from: "fetch", to: "summarize" }],
};

test("build rationale keeps concise prose that matches the graph", () => {
  const text = "I separated retrieval from synthesis so the fetched source remains independently inspectable before the model produces its answer.";
  assert.equal(normalizeBuildRationale(text, manifest), text);
});

test("build rationale replaces malformed instruction echoes with graph-derived truth", () => {
  const malformed = '{"I used a single node":"} 60 words. No bullet points. Here is the revised response:"';
  const result = normalizeBuildRationale(malformed, manifest);
  assert.match(result, /2 recorded steps/);
  assert.match(result, /http_get/);
  assert.doesNotMatch(result, /revised response|single node/i);
});

test("build rationale rejects prose that contradicts the validated node count", () => {
  const result = normalizeBuildRationale(
    "I used a single step to keep the design simple and reliable while preserving a direct route to the final output.",
    manifest,
  );
  assert.match(result, /2 recorded steps/);
});
