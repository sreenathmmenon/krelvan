/**
 * Channels + Observability tests. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { InteractionResolver, type ParkedAwait, type ReplyMessage } from "./channel.js";
import { HmacKeyring } from "../ledger/crypto.js";
import { InMemoryLedgerStore } from "../ledger/store.js";
import { Engine } from "../kernel/engine.js";
import { Supervisor, type CapabilityPlugin } from "../capability/capability.js";
import type { Manifest } from "../manifest/manifest.js";
import { canvasView, costView, planCounterfactual, verificationReplay } from "../observability/observe.js";
import { project } from "../kernel/project.js";

// ── Interaction Resolver (approval IS authorization) ────────────────────────────

function park(over: Partial<ParkedAwait> = {}): ParkedAwait {
  return { correlationId: "c1", branchId: "main", effect: "spend", principalId: "owner", open: true, ...over };
}
function reply(over: Partial<ReplyMessage> = {}): ReplyMessage {
  return { channel: "telegram", principalId: "owner", correlationId: "c1", decision: "approve", assurance: "high", ts: 1, ...over };
}

test("CHAN: approve with sufficient assurance → authorized", () => {
  const r = new InteractionResolver();
  r.park(park());
  const out = r.resolve(reply(), "main");
  assert.equal(out.kind, "authorized");
  assert.ok(!r.isOpen("c1"), "await consumed (single-use)");
});

test("CHAN: a correlation token is single-use (replay-proof)", () => {
  const r = new InteractionResolver();
  r.park(park());
  assert.equal(r.resolve(reply(), "main").kind, "authorized");
  const replay = r.resolve(reply(), "main");
  assert.ok(replay.kind === "rejected" && replay.reason === "ALREADY_RESOLVED");
});

test("CHAN: low-assurance channel cannot authorize a spend (needs step-up)", () => {
  const r = new InteractionResolver();
  r.park(park({ effect: "spend" }));
  const out = r.resolve(reply({ assurance: "low" }), "main");
  assert.ok(out.kind === "rejected" && out.reason === "INSUFFICIENT_ASSURANCE");
  assert.ok(r.isOpen("c1"), "await NOT consumed — a step-up can still satisfy it");
});

test("CHAN: low assurance is fine for a low-risk effect (message-human)", () => {
  const r = new InteractionResolver();
  r.park(park({ effect: "message-human" }));
  assert.equal(r.resolve(reply({ assurance: "low" }), "main").kind, "authorized");
});

test("CHAN: wrong principal and branch mismatch are rejected", () => {
  const r = new InteractionResolver();
  r.park(park());
  assert.ok(r.resolve(reply({ principalId: "stranger" }), "main").kind === "rejected");
  r.park(park({ correlationId: "c2" }));
  const out = r.resolve(reply({ correlationId: "c2" }), "other-branch");
  assert.ok(out.kind === "rejected" && out.reason === "BRANCH_MISMATCH");
});

test("CHAN: deny resolves the await as denied", () => {
  const r = new InteractionResolver();
  r.park(park());
  const out = r.resolve(reply({ decision: "deny" }), "main");
  assert.equal(out.kind, "denied");
  assert.ok(!r.isOpen("c1"));
});

// ── Observability (run a real workflow, then fold the views) ──────────────────────

function plugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number): CapabilityPlugin {
  return { name, sideEffect, estimateCents: () => cost, async invoke() { return { output: {}, claimedCostCents: cost }; } };
}

async function runAndObserve() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const sup = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;

  const m: Manifest = {
    version: 1, name: "obs", intent: "x", entry: "a", runBudgetCents: 100, maxNodeVisits: 3,
    nodes: [
      { id: "a", role: "1", autonomy: "full", capabilities: [{ name: "tA", sideEffect: "read", budgetCents: 50 }] },
      { id: "b", role: "2", autonomy: "full", capabilities: [{ name: "tB", sideEffect: "message-human", budgetCents: 50 }] },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  const plugins = new Map<string, CapabilityPlugin>([["tA", plugin("tA", "read", 7)], ["tB", plugin("tB", "message-human", 3)]]);
  const engine = new Engine(m, "t", "r", { store, owner, supervisor: new Supervisor(plugins), supervisorSigner: sup, now: () => clock++ });
  await engine.run();
  return { store, ring };
}

test("OBS: canvas + cost views fold from the verified log", async () => {
  const { store, ring } = await runAndObserve();
  const events = await store.read("t");
  const p = project(events);
  const canvas = canvasView(p);
  assert.ok(canvas.nodes.every((n) => n.status === "done"));
  const cost = costView(events);
  assert.equal(cost.spentCents, 10); // 7 + 3
  assert.equal(cost.reservedCents, 0);
  const v = verificationReplay(events, ring);
  assert.ok(v.ok && v.reconciledCostCents === 10);
});

test("OBS: verification replay marks a tampered log UNVERIFIABLE (loud, not silent)", async () => {
  const { store, ring } = await runAndObserve();
  const events = await store.read("t");
  const tampered = events.map((e, i) => (i === 2 ? { ...e, payload: { ...(e.payload as object), hacked: true } } : e));
  const v = verificationReplay(tampered, ring);
  assert.ok(!v.ok && v.reason === "UNVERIFIABLE");
});

test("OBS: counterfactual plan re-gates downstream effects, never executes (no accidental re-spend)", async () => {
  const { store } = await runAndObserve();
  const events = await store.read("t");
  // fork at node b → only b's effects are downstream
  const plan = planCounterfactual(events, "b");
  assert.equal(plan.forkAtNodeId, "b");
  assert.ok(plan.wouldRegate.length >= 1);
  // projected cost is shown, but NOTHING is executed/charged by planning
  assert.ok(plan.projectedCostCents >= 0);
});
