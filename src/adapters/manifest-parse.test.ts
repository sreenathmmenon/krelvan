/**
 * parseManifestProposal robustness — the GENERAL fixes that make NL agent-building work
 * with local models (Ollama) that don't honour the JSON schema. Each test feeds a real
 * malformed shape observed from qwen2.5 and asserts the parser repairs it into a runnable
 * manifest (the compiler then does deep validation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifestProposal } from "./anthropic-model.js";

test("entry that matches no node is repaired to the first node id", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "start_monitoring", runBudgetCents: 50,
    nodes: [
      { id: "fetch_page", role: "Fetch", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 10 }] },
      { id: "summarize", role: "Sum", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 50 }] },
    ],
    edges: [],
  }));
  assert.equal(m.entry, "fetch_page", "invalid entry must snap to the first node id");
});

test("role set to a capability name is replaced with a readable instruction", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "n1", runBudgetCents: 50,
    nodes: [{ id: "n1", role: "http_get", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 10 }] }],
    edges: [],
  }));
  assert.notEqual(m.nodes[0]!.role, "http_get", "a capability-name role must be rewritten");
  assert.ok(m.nodes[0]!.role.length > 4);
});

test("near-miss capability names (dot/underscore) are snapped to the real name", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "n1", runBudgetCents: 50,
    nodes: [{ id: "n1", role: "do it", autonomy: "full", capabilities: [{ name: "text.transform", sideEffect: "read", budgetCents: 5 }] }],
    edges: [],
  }));
  assert.equal(m.nodes[0]!.capabilities[0]!.name, "text_transform", "text.transform -> text_transform");
});

test("a node left with no valid capabilities is dropped and the graph re-wired", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "ghost", runBudgetCents: 50,
    nodes: [
      { id: "ghost", role: "compose", autonomy: "full", capabilities: [{ name: "totally_unknown_cap", sideEffect: "read", budgetCents: 5 }] },
      { id: "real", role: "Write", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 20 }] },
    ],
    edges: [],
  }));
  assert.equal(m.nodes.length, 1, "the capability-less node must be dropped");
  assert.equal(m.nodes[0]!.id, "real");
  assert.equal(m.entry, "real", "entry must repoint to a surviving node");
});

test("wrong/none sideEffect is corrected from the canonical map", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "n1", runBudgetCents: 50,
    nodes: [{ id: "n1", role: "Write", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 20 }] }],
    edges: [],
  }));
  assert.equal(m.nodes[0]!.capabilities[0]!.sideEffect, "read", "compose sideEffect must be corrected to read");
});

test("missing edges are auto-chained in node order", () => {
  const m = parseManifestProposal(JSON.stringify({
    version: 1, name: "X", intent: "x", entry: "a", runBudgetCents: 50,
    nodes: [
      { id: "a", role: "A", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 10 }] },
      { id: "b", role: "B", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 50 }] },
    ],
    edges: [],
  }));
  assert.equal(m.edges.length, 1);
  assert.deepEqual({ from: m.edges[0]!.from, to: m.edges[0]!.to }, { from: "a", to: "b" });
});
