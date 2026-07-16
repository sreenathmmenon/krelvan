/**
 * manifest-diff: the before→after change summary the visible self-improvement loop shows the
 * owner. Order-insensitive, catches added/removed/changed steps, tool grants, edges, and
 * top-level fields — and reports identical when nothing structural changed. Never surfaces cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffManifests } from "./manifest-diff.js";
import type { Manifest } from "../core/manifest/manifest.js";

function base(): Manifest {
  return {
    version: 1, name: "Analyst", intent: "do a thing", entry: "a",
    runBudgetCents: 100, maxNodeVisits: 5, seed: {},
    nodes: [
      { id: "a", role: "start", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 5 }] },
      { id: "b", role: "finish", autonomy: "full", capabilities: [] },
    ],
    edges: [{ from: "a", to: "b" }],
  };
}

test("identical manifests report identical, no changes", () => {
  const d = diffManifests(base(), base());
  assert.equal(d.identical, true);
  assert.equal(d.addedNodes.length, 0);
  assert.equal(d.changedNodes.length, 0);
  assert.equal(d.addedEdges.length, 0);
});

test("an added node and its edge are reported", () => {
  const after = base();
  after.nodes.push({ id: "c", role: "verify", autonomy: "full", capabilities: [{ name: "recall", sideEffect: "read", budgetCents: 5 }] });
  after.edges.push({ from: "b", to: "c" });

  const d = diffManifests(base(), after);
  assert.equal(d.identical, false);
  assert.equal(d.addedNodes.length, 1);
  assert.equal(d.addedNodes[0]!.id, "c");
  assert.deepEqual(d.addedNodes[0]!.capabilities, ["recall"]);
  assert.equal(d.addedEdges.length, 1);
  assert.deepEqual(d.addedEdges[0], { from: "b", to: "c" });
});

test("a removed node and edge are reported", () => {
  const before = base();
  before.nodes.push({ id: "c", role: "extra", autonomy: "full", capabilities: [] });
  before.edges.push({ from: "b", to: "c" });

  const d = diffManifests(before, base());
  assert.equal(d.removedNodes.length, 1);
  assert.equal(d.removedNodes[0]!.id, "c");
  assert.equal(d.removedEdges.length, 1);
});

test("a gained tool + autonomy change on an existing node is reported", () => {
  const after = base();
  after.nodes[0] = { id: "a", role: "start", autonomy: "suggest", capabilities: [
    { name: "think", sideEffect: "read", budgetCents: 5 },
    { name: "rag.search", sideEffect: "read", budgetCents: 5 },
  ] };

  const d = diffManifests(base(), after);
  assert.equal(d.changedNodes.length, 1);
  assert.equal(d.changedNodes[0]!.id, "a");
  assert.ok(d.changedNodes[0]!.changes.some(c => c.includes("gained tool: rag.search")));
  assert.ok(d.changedNodes[0]!.changes.some(c => c.includes("autonomy: full → suggest")));
});

test("a removed tool is reported", () => {
  const after = base();
  after.nodes[0] = { id: "a", role: "start", autonomy: "full", capabilities: [] };
  const d = diffManifests(base(), after);
  assert.ok(d.changedNodes[0]!.changes.some(c => c.includes("removed tool: think")));
});

test("entry + visit-cap changes are reported; budget/cost is NEVER surfaced", () => {
  const after = base();
  after.entry = "b";
  after.maxNodeVisits = 9;
  after.runBudgetCents = 999; // must NOT appear in the diff

  const d = diffManifests(base(), after);
  const fields = d.fieldChanges.map(f => f.field);
  assert.ok(fields.includes("entry step"));
  assert.ok(fields.includes("max step visits"));
  assert.ok(!fields.some(f => /budget|cent|cost|spend|money/i.test(f)), "no cost/budget field leaks into the diff");
  const dumped = JSON.stringify(d);
  assert.ok(!/999/.test(dumped), "the budget number never appears");
});

test("diff is order-insensitive on nodes and edges", () => {
  const before = base();
  const after = base();
  after.nodes.reverse();
  after.edges = [...after.edges];
  const d = diffManifests(before, after);
  assert.equal(d.identical, true, "reordering nodes/edges is not a change");
});
