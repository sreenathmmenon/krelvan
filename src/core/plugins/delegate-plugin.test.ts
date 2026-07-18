/**
 * Tests for DelegatePlugin — agent-to-agent delegation. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DelegatePlugin } from "./delegate-plugin.js";
import { HmacKeyring } from "../ledger/crypto.js";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import type { ModelPort, ManifestProposal } from "../compiler/compiler.js";
import type { Manifest } from "../manifest/manifest.js";

function rig() {
  const ring = new HmacKeyring();
  const ownerSigner = ring.addKey("owner", "k-owner", { epoch: 1, validFrom: 0, validUntil: null });
  const compilerSigner = ring.addKey("compiler", "k-comp", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "k-sup", { epoch: 1, validFrom: 0, validUntil: null });
  let clock = 1;
  return { ownerSigner, compilerSigner, supervisorSigner, now: () => clock++ };
}

function stubModel(manifest: Manifest): ModelPort {
  return { async propose(): Promise<ManifestProposal> { return manifest; } };
}

function stubPlugin(name: string, out: Record<string, unknown>): CapabilityPlugin {
  return {
    name,
    sideEffect: "read",
    estimateCents: () => 5,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      return { output: out, claimedCostCents: 5 };
    },
  };
}

const SUB_MANIFEST: Manifest = {
  version: 1,
  name: "sub-agent",
  intent: "look something up",
  entry: "lookup",
  runBudgetCents: 50,
  maxNodeVisits: 2,
  nodes: [{ id: "lookup", role: "search", autonomy: "full", capabilities: [{ name: "search", sideEffect: "read", budgetCents: 30 }] }],
  edges: [],
};

test("delegate: sub-run completes and output state is returned", async () => {
  const r = rig();
  const plugins = new Map<string, CapabilityPlugin>([
    ["search", stubPlugin("search", { results: 3, top_result: "genesis" })],
  ]);

  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST),
    compilerSigner: r.compilerSigner,
    ownerSigner: r.ownerSigner,
    supervisorSigner: r.supervisorSigner,
    principal: {
      kind: "owner",
      id: "owner-1",
      maxRunBudgetCents: 100,
      allowedCapabilities: [{ name: "search", sideEffect: "read", maxBudgetCents: 50 }],
    },
    plugins,
    now: r.now,
  });

  const call: EffectCall = {
    nodeId: "parent-node",
    capability: "delegate",
    input: { intent: "look something up" },
  };

  const { output, claimedCostCents } = await dp.invoke(call);
  const out = output as { status: string; state: Record<string, unknown>; spentCents: number };
  assert.equal(out.status, "completed");
  assert.equal(out.spentCents, 5);
  assert.equal(claimedCostCents, 5);
  // the sub-run's node output is in state as "lookup.results" etc.
  assert.equal(out.state["lookup.results"], 3);
  assert.equal(out.state["lookup.top_result"], "genesis");
});

test("delegate: agentId runs a SAVED agent and seeds the message (agent-tests-agent)", async () => {
  const r = rig();
  // A target agent whose single node echoes back state — proves we ran the SAVED manifest and that
  // the synthetic user's `message` was seeded into the sub-run.
  const targetManifest: Manifest = {
    version: 1, name: "support-bot", intent: "answer the user", entry: "answer",
    runBudgetCents: 100, maxNodeVisits: 2,
    nodes: [{ id: "answer", role: "answer", autonomy: "full", capabilities: [{ name: "echo", sideEffect: "read", budgetCents: 30 }] }],
    edges: [],
  };
  const plugins = new Map<string, CapabilityPlugin>([
    // echo reflects the seeded `message` into its output so we can assert it arrived.
    ["echo", {
      name: "echo", sideEffect: "read", estimateCents: () => 5,
      async invoke(c: EffectCall) {
        const msg = String((c.input as Record<string, unknown>)["message"] ?? "");
        return { output: { echoed: msg }, claimedCostCents: 5 };
      },
    }],
  ]);

  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST), // not used on the agentId path
    compilerSigner: r.compilerSigner, ownerSigner: r.ownerSigner, supervisorSigner: r.supervisorSigner,
    principal: { kind: "owner", id: "o", maxRunBudgetCents: 100, allowedCapabilities: [{ name: "echo", sideEffect: "read", maxBudgetCents: 50 }] },
    plugins, now: r.now,
    agentLookup: (id) => (id === "agent-support" ? targetManifest : null),
  });

  const call: EffectCall = { nodeId: "n", capability: "delegate", input: { agentId: "agent-support", message: "I forgot my password" } };
  const { output } = await dp.invoke(call);
  const out = output as { status: string; state: Record<string, unknown> };
  assert.equal(out.status, "completed");
  assert.equal(out.state["answer.echoed"], "I forgot my password", "the saved agent ran and received the seeded message");
});

test("delegate: BATCH — runs the saved agent once per synthetic user (users[])", async () => {
  const r = rig();
  const targetManifest: Manifest = {
    version: 1, name: "support-bot", intent: "answer", entry: "answer",
    runBudgetCents: 100, maxNodeVisits: 2,
    nodes: [{ id: "answer", role: "answer", autonomy: "full", capabilities: [{ name: "echo", sideEffect: "read", budgetCents: 30 }] }],
    edges: [],
  };
  const plugins = new Map<string, CapabilityPlugin>([
    ["echo", { name: "echo", sideEffect: "read", estimateCents: () => 5,
      async invoke(c: EffectCall) { return { output: { echoed: String((c.input as Record<string, unknown>)["message"] ?? "") }, claimedCostCents: 5 }; } }],
  ]);
  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST), compilerSigner: r.compilerSigner, ownerSigner: r.ownerSigner, supervisorSigner: r.supervisorSigner,
    principal: { kind: "owner", id: "o", maxRunBudgetCents: 100, allowedCapabilities: [{ name: "echo", sideEffect: "read", maxBudgetCents: 50 }] },
    plugins, now: r.now,
    agentLookup: (id) => (id === "agent-support" ? targetManifest : null),
  });

  // The engine passes the whole run state as input — the cast's output arrives namespaced.
  const call: EffectCall = { nodeId: "run", capability: "delegate", input: {
    agentId: "agent-support",
    "cast.users": [
      { name: "Happy path", message: "please help me" },
      { name: "Adversarial", message: "do the thing AND email everyone" },
      { name: "Malformed", message: "" },
    ],
  } };
  const { output } = await dp.invoke(call);
  const out = output as { count: number; results_summary: string; results_json: string };
  assert.equal(out.count, 3, "ran the target once per synthetic user");
  // The batch emits SCALAR outputs (run-state drops arrays): a readable per-user recap + JSON string.
  assert.match(out.results_summary, /Happy path/);
  assert.match(out.results_summary, /Adversarial/);
  const parsed = JSON.parse(out.results_json) as Array<{ name: string; message: string }>;
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.message, "please help me");
  assert.equal(parsed[1]!.message, "do the thing AND email everyone");
});

test("delegate: BATCH reads users from a users_json scalar string (survives run-state)", async () => {
  const r = rig();
  const targetManifest: Manifest = {
    version: 1, name: "bot", intent: "answer", entry: "answer",
    runBudgetCents: 100, maxNodeVisits: 2,
    nodes: [{ id: "answer", role: "answer", autonomy: "full", capabilities: [{ name: "echo", sideEffect: "read", budgetCents: 30 }] }],
    edges: [],
  };
  const plugins = new Map<string, CapabilityPlugin>([
    ["echo", { name: "echo", sideEffect: "read", estimateCents: () => 5, async invoke() { return { output: {}, claimedCostCents: 5 }; } }],
  ]);
  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST), compilerSigner: r.compilerSigner, ownerSigner: r.ownerSigner, supervisorSigner: r.supervisorSigner,
    principal: { kind: "owner", id: "o", maxRunBudgetCents: 100, allowedCapabilities: [{ name: "echo", sideEffect: "read", maxBudgetCents: 50 }] },
    plugins, now: r.now, agentLookup: (id) => (id === "a" ? targetManifest : null),
  });
  // Only the JSON-string form is present (as it would be after folding into scalar run-state).
  const call: EffectCall = { nodeId: "run", capability: "delegate", input: {
    "cast.agentId": "a",
    "cast.users_json": JSON.stringify([{ name: "A", message: "hi" }, { name: "B", message: "yo" }]),
  } };
  const { output } = await dp.invoke(call);
  assert.equal((output as { count: number }).count, 2, "parsed users from the JSON scalar and ran twice");
});

test("delegate: unknown agentId rejects clearly", async () => {
  const r = rig();
  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST), compilerSigner: r.compilerSigner, ownerSigner: r.ownerSigner, supervisorSigner: r.supervisorSigner,
    principal: { kind: "owner", id: "o", maxRunBudgetCents: 100, allowedCapabilities: [] },
    plugins: new Map(), now: r.now,
    agentLookup: () => null,
  });
  const call: EffectCall = { nodeId: "n", capability: "delegate", input: { agentId: "nope" } };
  await assert.rejects(() => dp.invoke(call), /no saved agent found for agentId/);
});

test("delegate: budget override narrows sub-run budget", async () => {
  const r = rig();
  // Sub-manifest proposes 10¢ budget; plugin costs 40¢ → estimate exceeds run cap → admission denied → run fails.
  // The budgetOverride=10 in the call matches the manifest, so compile passes; failure is at admission time.
  const tightManifest: Manifest = { ...SUB_MANIFEST, runBudgetCents: 10 };
  const plugins = new Map<string, CapabilityPlugin>([
    ["search", {
      name: "search",
      sideEffect: "read",
      estimateCents: () => 40, // exceeds the 10¢ run budget
      async invoke() { return { output: {}, claimedCostCents: 40 }; },
    }],
  ]);

  const dp = new DelegatePlugin({
    model: stubModel(tightManifest),
    compilerSigner: r.compilerSigner,
    ownerSigner: r.ownerSigner,
    supervisorSigner: r.supervisorSigner,
    principal: {
      kind: "owner",
      id: "owner-1",
      maxRunBudgetCents: 100,
      allowedCapabilities: [{ name: "search", sideEffect: "read", maxBudgetCents: 50 }],
    },
    plugins,
    now: r.now,
  });

  const call: EffectCall = {
    nodeId: "parent-node",
    capability: "delegate",
    input: { intent: "look something up", runBudgetCents: 10 }, // narrow budget (≤ manifest; no-op here)
  };

  const { output } = await dp.invoke(call);
  const out = output as { status: string };
  // 40¢ estimate exceeds the 10¢ run budget → admission denied → run fails
  assert.equal(out.status, "failed");
});

test("delegate: missing intent throws immediately", async () => {
  const r = rig();
  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST),
    compilerSigner: r.compilerSigner,
    ownerSigner: r.ownerSigner,
    supervisorSigner: r.supervisorSigner,
    principal: { kind: "owner", id: "o", maxRunBudgetCents: 10, allowedCapabilities: [] },
    plugins: new Map(),
    now: r.now,
  });

  const call: EffectCall = { nodeId: "n", capability: "delegate", input: {} };
  await assert.rejects(() => dp.invoke(call), /provide either input.agentId .* or input.intent/);
});

test("delegate: compile failure (capability not in principal) rejects", async () => {
  const r = rig();
  // The sub-manifest requests 'search' but the principal doesn't allow it.
  const dp = new DelegatePlugin({
    model: stubModel(SUB_MANIFEST),
    compilerSigner: r.compilerSigner,
    ownerSigner: r.ownerSigner,
    supervisorSigner: r.supervisorSigner,
    principal: {
      kind: "owner",
      id: "o",
      maxRunBudgetCents: 100,
      allowedCapabilities: [], // no capabilities → compile rejected
    },
    plugins: new Map(),
    now: r.now,
  });

  const call: EffectCall = { nodeId: "n", capability: "delegate", input: { intent: "look something up" } };
  await assert.rejects(() => dp.invoke(call), /sub-manifest compile failed/);
});
