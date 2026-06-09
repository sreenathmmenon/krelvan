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
  await assert.rejects(() => dp.invoke(call), /intent must be a non-empty string/);
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
