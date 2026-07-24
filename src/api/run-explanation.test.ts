import { test } from "node:test";
import assert from "node:assert/strict";

import { buildExplanationFacts, buildExplanationPrompt } from "./run-explanation.js";
import type { LedgerEvent } from "../core/ledger/event.js";
import type { Manifest } from "../core/manifest/manifest.js";

const manifest: Manifest = {
  version: 1,
  name: "Research agent",
  intent: "Research and audit",
  entry: "fetch",
  runBudgetCents: 100,
  maxNodeVisits: 5,
  nodes: [
    { id: "fetch", role: "Fetch the source", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 10 }] },
    { id: "audit", role: "Audit the source", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 10 }] },
  ],
  edges: [{ from: "fetch", to: "audit" }],
};

function event(offset: number, type: string, nodeId: string | undefined, payload: Record<string, unknown>): LedgerEvent {
  return {
    id: `sha256:${String(offset).padStart(64, "0")}`,
    type: type as LedgerEvent["type"],
    scope: { tenantId: "default", runId: "run-1", ...(nodeId ? { nodeId } : {}), branchId: "main" },
    parents: [],
    prev: null,
    offset,
    payload: payload as LedgerEvent["payload"],
    determinism: "captured",
    ts: offset,
    author: "owner",
    sig: { keyId: "test", epoch: 1, signedAt: offset, value: "00" },
  };
}

test("run explanation: groups large signed results into bounded factual node summaries", () => {
  const hugeBody = "source-data ".repeat(50_000);
  const events = [
    event(1, "RunStarted", undefined, {}),
    event(2, "NodeEntered", "fetch", {}),
    event(3, "EffectRequested", "fetch", { idem: "i1", capability: "http_get" }),
    event(4, "EffectResult", "fetch", { idem: "i1", output: { body: hugeBody, status: 200 } }),
    event(5, "NodeConcluded", "fetch", {}),
    event(6, "RunCompleted", undefined, {}),
  ];

  const facts = buildExplanationFacts({ events, manifest, agentName: "Research agent", status: "completed" });
  const prompt = buildExplanationPrompt(facts);
  assert.ok(prompt.length <= 16_000);
  assert.match(facts.markdown, /fetch/);
  assert.match(facts.markdown, /http_get/);
  assert.match(facts.markdown, /not reached/);
  assert.doesNotMatch(prompt, new RegExp(hugeBody.slice(0, 100)));
});

test("run explanation: failed fallback states the recorded failure without inventing output", () => {
  const facts = buildExplanationFacts({
    events: [
      event(1, "RunStarted", undefined, {}),
      event(2, "NodeEntered", "fetch", {}),
      event(3, "RunFailed", undefined, { reason: "connector timed out" }),
    ],
    manifest,
    agentName: "Research agent",
    status: "failed",
    failureReason: "connector timed out",
  });
  assert.match(facts.markdown, /connector timed out/);
  assert.match(facts.markdown, /started but did not conclude/);
  assert.doesNotMatch(facts.markdown, /Observed result:/);
});
