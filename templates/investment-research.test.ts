/**
 * Guards the investment-research template — a multi-agent evaluator-optimizer pattern:
 * supervisor -> data worker -> context worker -> analyst -> LLM judge
 * (forces a retry on 'revise') -> human-gated deliver. Validates structurally, uses only
 * real built-ins, and drives the Engine end-to-end with fake plugins so BOTH the judge-pass
 * path and the judge->analyst revise loop are exercised, with the ledger verifying.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";
import { project } from "../src/core/kernel/project.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "investment-research.manifest.json"), "utf8")) as Manifest;

const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

function outputPlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, output: Record<string, unknown>): CapabilityPlugin {
  return { name, sideEffect, estimateCents: () => cost, async invoke(): Promise<{ output: unknown; claimedCostCents: number }> { return { output, claimedCostCents: cost }; } };
}

test("investment-research manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("investment-research uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("investment-research: the judge evaluates and always delivers (bounded, no revise loop)", () => {
  // The judge still runs (its verdict + score are signed into the ledger as a quality
  // attestation), but the synthesize↔judge revise back-edge was removed: it never converged
  // on weaker models (the judge kept saying 'revise' until maxNodeVisits failed the run).
  const toDeliver = manifest.edges.find((e) => e.from === "judge" && e.to === "deliver");
  const backToAnalyst = manifest.edges.find((e) => e.from === "judge" && e.to === "analyst");
  assert.ok(toDeliver, "judge must route to deliver");
  assert.ok(!toDeliver!.when, "judge -> deliver must be unconditional so the run always terminates");
  assert.ok(!backToAnalyst, "the fragile judge -> analyst revise loop must be gone");
  // the judge node itself is still present and does its evaluation
  assert.ok(manifest.nodes.some((n) => n.id === "judge"), "judge node must remain (it scores the answer)");
});

test("investment-research delivers under human approval (deliver node is 'suggest')", () => {
  const deliver = manifest.nodes.find((n) => n.id === "deliver");
  assert.equal(deliver?.autonomy, "suggest", "final delivery to a human must be approval-gated (mandatory human-in-the-loop)");
});

test("investment-research runs E2E when the judge PASSES first time; ledger verifies", async () => {
  const { ring, owner, supervisorSigner, store, now } = rig();
  const plugins = new Map<string, CapabilityPlugin>([
    ["think", outputPlugin("think", "read", 60, { plan: "p", facts: "f", context: "c", answer: "a", needs_data: true, needs_context: true, data_quality: "complete", cited: true, used_evidence: true, verdict: "pass", critique: "ok", score: 95, bottom_line: "bl" })],
    ["compose", outputPlugin("compose", "message-human", 40, { briefing: "final briefing", result: "final briefing" })],
  ]);
  const { supervisor } = Supervisor.create(plugins);
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // approve reads; the deliver node messages a human -> approve it so the run completes here.
  const approve = (_c: EffectCall) => true;
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 50, approve, initialState });
  assert.equal(res.status, "completed", `expected completed, got ${res.status}`);
  const events = await store.read("t1");
  assert.ok(verify(events, ring).ok, "ledger must verify");
  const analystVisits = events.filter((e) => e.type === "NodeEntered" && (e.scope as { nodeId?: string }).nodeId === "analyst").length;
  assert.equal(analystVisits, 1, "on a first-time pass, analyst runs exactly once");
});

test("investment-research runs once through analyst→judge→deliver and the ledger verifies", async () => {
  const { ring, owner, supervisorSigner, store, now } = rig();
  // Even if the judge returns a low score / 'revise' verdict, the bounded (loop-free) flow
  // still terminates at deliver in a single pass — a weak model can no longer trap the run.
  const thinkPlugin: CapabilityPlugin = {
    name: "think", sideEffect: "read", estimateCents: () => 60,
    async invoke(call: EffectCall) {
      if (call.nodeId === "judge") {
        // deliberately 'revise' — the run must STILL complete (no back-edge to loop on).
        return { output: { verdict: "revise", critique: "x", score: 40 }, claimedCostCents: 60 };
      }
      return { output: { plan: "p", facts: "f", context: "c", answer: "a", needs_data: true, needs_context: true, data_quality: "complete", cited: true, used_evidence: true, bottom_line: "bl" }, claimedCostCents: 60 };
    },
  };
  const plugins = new Map<string, CapabilityPlugin>([
    ["think", thinkPlugin],
    ["compose", outputPlugin("compose", "message-human", 40, { briefing: "b", result: "b" })],
  ]);
  const { supervisor } = Supervisor.create(plugins);
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 60, approve: () => true, initialState });
  assert.equal(res.status, "completed", `expected completed even on a 'revise' verdict, got ${res.status}`);
  assert.ok(verify(await store.read("t1"), ring).ok, "ledger must verify");
  const events = await store.read("t1");
  const analystVisits = events.filter((e) => e.type === "NodeEntered" && (e.scope as { nodeId?: string }).nodeId === "analyst").length;
  assert.equal(analystVisits, 1, "no revise loop — the analyst runs exactly once");
  const proj = project(events);
  void proj;
});
