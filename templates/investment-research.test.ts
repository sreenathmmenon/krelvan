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

test("investment-research has the evaluator-optimizer judge loop: judge->analyst on revise, judge->deliver on pass", () => {
  const revise = manifest.edges.find((e) => e.from === "judge" && e.to === "analyst");
  const pass = manifest.edges.find((e) => e.from === "judge" && e.to === "deliver");
  assert.ok(revise?.when, "judge must route back to analyst on a 'revise' verdict (the reflection retry loop)");
  assert.ok(pass?.when, "judge must route to deliver on a 'pass' verdict");
  assert.match(JSON.stringify(revise!.when), /"key":"judge\.verdict"/);
  assert.match(JSON.stringify(pass!.when), /"key":"judge\.verdict"/);
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

test("investment-research judge loop FIRES: a 'revise' then 'pass' makes the analyst run twice", async () => {
  const { ring, owner, supervisorSigner, store, now } = rig();
  // A judge plugin that says 'revise' the first time, 'pass' the second — exercising the retry loop.
  let judgeCalls = 0;
  const thinkPlugin: CapabilityPlugin = {
    name: "think", sideEffect: "read", estimateCents: () => 60,
    async invoke(call: EffectCall) {
      // The judge node is the only one whose role mentions verdict; detect by nodeId.
      if (call.nodeId === "judge") {
        judgeCalls++;
        return { output: { verdict: judgeCalls === 1 ? "revise" : "pass", critique: "x", score: judgeCalls === 1 ? 40 : 92 }, claimedCostCents: 60 };
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
  assert.equal(res.status, "completed", `expected completed, got ${res.status}`);
  assert.ok(verify(await store.read("t1"), ring).ok, "ledger must verify");
  const events = await store.read("t1");
  const analystVisits = events.filter((e) => e.type === "NodeEntered" && (e.scope as { nodeId?: string }).nodeId === "analyst").length;
  assert.equal(analystVisits, 2, "judge said 'revise' once, so the analyst must have re-run (reflection loop fired)");
  const proj = project(events);
  void proj;
});
