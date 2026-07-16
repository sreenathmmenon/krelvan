/**
 * The synthetic tool layer is the safety core: it must (1) NEVER perform a consequential tool,
 * (2) preserve name/sideEffect/estimateCents byte-for-byte so admission/budget/gating are
 * identical to production, and (3) record what a consequential tool WOULD have done. A read tool
 * gets synthetic data; a real plugin's invoke() must never be called for any wrapped tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSyntheticLayer, isConsequential } from "./synthetic-supervisor.js";
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { SideEffectClass } from "../../core/manifest/manifest.js";

/** A real plugin that BLOWS UP if invoked — proves the synthetic layer never calls through. */
function tripwire(name: string, sideEffect: SideEffectClass, estimate = 7): CapabilityPlugin {
  return {
    name, sideEffect,
    estimateCents: () => estimate,
    async invoke() { throw new Error(`REAL ${name} was invoked — the synthetic layer leaked!`); },
  };
}

function call(nodeId: string, capability: string, input: unknown): EffectCall {
  return { nodeId, capability, input };
}

test("classification: consequential set covers every non-read class", () => {
  assert.equal(isConsequential("read"), false);
  for (const c of ["write-reversible", "write-irreversible", "spend", "message-human", "identity-mutation"] as SideEffectClass[]) {
    assert.equal(isConsequential(c), true, `${c} must be consequential`);
  }
});

test("a consequential tool is RECORDED, never performed; input is captured", async () => {
  const live = new Map<string, CapabilityPlugin>([
    ["email_send", tripwire("email_send", "message-human")],
    ["charge_card", tripwire("charge_card", "spend")],
  ]);
  const { plugins, suppressed } = buildSyntheticLayer(live);

  const emailInput = { to: "real@customer.com", body: "your refund is processed" };
  const emailRes = await plugins.get("email_send")!.invoke(call("n1", "email_send", emailInput));
  const chargeRes = await plugins.get("charge_card")!.invoke(call("n2", "charge_card", { amountCents: 1240 }));

  // Nothing threw → the real tripwire invoke was never reached.
  assert.equal((emailRes.output as Record<string, unknown>)["_suppressed"], true);
  assert.equal(emailRes.claimedCostCents, 0, "a suppressed effect claims no spend");
  assert.equal((chargeRes.output as Record<string, unknown>)["_suppressed"], true);

  assert.equal(suppressed.length, 2, "both consequential effects were recorded");
  assert.deepEqual(suppressed[0], { nodeId: "n1", capability: "email_send", sideEffect: "message-human", input: emailInput });
  assert.equal(suppressed[1]!.capability, "charge_card");
  assert.deepEqual((suppressed[1]!.input as Record<string, unknown>), { amountCents: 1240 });
});

test("a read tool returns synthetic data and never calls the real plugin", async () => {
  const live = new Map<string, CapabilityPlugin>([["lookup", tripwire("lookup", "read")]]);
  const { plugins, suppressed } = buildSyntheticLayer(live);

  const res = await plugins.get("lookup")!.invoke(call("n1", "lookup", { q: "order 123" }));
  assert.equal((res.output as Record<string, unknown>)["_synthetic"], true, "read output is marked synthetic");
  assert.equal(suppressed.length, 0, "a read tool is never recorded as a suppressed effect");
});

test("the synthesizer shapes read output; declining/throwing falls back to the stub", async () => {
  const live = new Map<string, CapabilityPlugin>([
    ["a", tripwire("a", "read")],
    ["b", tripwire("b", "read")],
    ["c", tripwire("c", "read")],
  ]);
  const { plugins } = buildSyntheticLayer(live, async (c) => {
    if (c.capability === "a") return { rows: [{ id: 1 }] };  // shaped
    if (c.capability === "b") return undefined;               // declines → stub
    throw new Error("synth boom");                            // throws → stub
  });

  const a = await plugins.get("a")!.invoke(call("n", "a", {}));
  assert.deepEqual((a.output as Record<string, unknown>)["rows"], [{ id: 1 }]);

  const b = await plugins.get("b")!.invoke(call("n", "b", {}));
  assert.equal((b.output as Record<string, unknown>)["_synthetic"], true, "decline falls back to stub");

  const c = await plugins.get("c")!.invoke(call("n", "c", {}));
  assert.equal((c.output as Record<string, unknown>)["_synthetic"], true, "throw falls back to stub");
});

test("wrapped plugins preserve name, sideEffect and estimateCents exactly (admission parity)", () => {
  const live = new Map<string, CapabilityPlugin>([
    ["think", tripwire("think", "read", 3)],
    ["send", tripwire("send", "message-human", 11)],
  ]);
  const { plugins } = buildSyntheticLayer(live);

  for (const [name, real] of live) {
    const w = plugins.get(name)!;
    assert.equal(w.name, real.name);
    assert.equal(w.sideEffect, real.sideEffect);
    assert.equal(w.estimateCents(call("n", name, {})), real.estimateCents(call("n", name, {})), `${name} estimate must match`);
  }
});

test("the layer wraps every tool in the live snapshot (no tool escapes to the real world)", () => {
  const live = new Map<string, CapabilityPlugin>([
    ["read1", tripwire("read1", "read")],
    ["write1", tripwire("write1", "write-irreversible")],
    ["id1", tripwire("id1", "identity-mutation")],
  ]);
  const { plugins } = buildSyntheticLayer(live);
  assert.deepEqual([...plugins.keys()].sort(), ["id1", "read1", "write1"]);
});
