import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest } from "../core/manifest/manifest.js";
import { manualRunInitialState } from "./run-input.js";

function manifest(seed: Manifest["seed"]): Manifest {
  return {
    version: 1,
    name: "Input test",
    intent: "test customer input",
    entry: "n1",
    runBudgetCents: 10,
    maxNodeVisits: 1,
    seed,
    nodes: [{
      id: "n1",
      role: "Return the input.",
      autonomy: "full",
      capabilities: [{ name: "think", sideEffect: "read", budgetCents: 1 }],
    }],
    edges: [],
  };
}

test("manual run input replaces a template sample query throughout the graph", () => {
  const state = manualRunInitialState(
    manifest({ query: "sample question", kb: "support" }),
    { message: "customer's live question" },
  );
  assert.deepEqual(state, {
    message: "customer's live question",
    query: "customer's live question",
  });
});

test("an explicit structured query wins over the free-text convenience mapping", () => {
  const state = manualRunInitialState(
    manifest({ query: "sample question" }),
    { message: "free text", initialState: { query: "structured query" } },
  );
  assert.deepEqual(state, { message: "free text", query: "structured query" });
});

test("document-ingest templates without a query receive only the universal message", () => {
  const state = manualRunInitialState(manifest({ kb: "support" }), { input: "document body" });
  assert.deepEqual(state, { message: "document body" });
});
