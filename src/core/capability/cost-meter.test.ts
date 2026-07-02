/**
 * Cost-meter tests — the honesty fix for budget settlement. A plugin's self-reported
 * cost can only ever RAISE what the supervisor settles; anything the meter measured
 * independently (LLM completions through the shared client) is a floor a lying plugin
 * cannot get under. Scopes ride AsyncLocalStorage, so concurrent invocations meter
 * independently and recording outside any scope is a harmless no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { meterRun, recordMeteredCost } from "./cost-meter.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "./capability.js";

function call(capability: string): EffectCall {
  return { nodeId: "n1", capability, input: {} };
}

/** A plugin that does `meteredWork` cents of metered work but CLAIMS whatever it likes. */
function plugin(name: string, claim: number, meteredWork: number): CapabilityPlugin {
  return {
    name,
    sideEffect: "read",
    estimateCents: () => 50,
    async invoke() {
      if (meteredWork > 0) recordMeteredCost(meteredWork); // stands in for the shared LLM client's recording
      return { output: { ok: true }, claimedCostCents: claim };
    },
  };
}

test("under-reporting is caught: settle = max(claim, metered) — a lying plugin cannot get under the meter", async () => {
  const sup = new Supervisor(new Map([["lying", plugin("lying", 1, 47)]]));
  const obs = await sup.run(call("lying"), "idem-1");
  assert.equal(obs.meteredCents, 47, "the meter saw the real LLM spend");
  assert.equal(obs.pluginClaim.claimedCostCents, 1, "the claim is kept, separately, as untrusted data");
  assert.equal(obs.costCents, 47, "settlement uses the metered floor, not the 1-cent claim");
});

test("an honest claim above the meter stands (claims can raise, never lower)", async () => {
  // e.g. a plugin that also paid for something through its own stack the meter can't see.
  const sup = new Supervisor(new Map([["honest", plugin("honest", 30, 12)]]));
  const obs = await sup.run(call("honest"), "idem-2");
  assert.equal(obs.costCents, 30);
  assert.equal(obs.meteredCents, 12);
});

test("a non-LLM plugin (nothing metered) settles at its claim; negative claims clamp to 0", async () => {
  const sup = new Supervisor(new Map([
    ["plain", plugin("plain", 5, 0)],
    ["negative", plugin("negative", -25, 0)],
  ]));
  assert.equal((await sup.run(call("plain"), "i3")).costCents, 5);
  const neg = await sup.run(call("negative"), "i4");
  assert.equal(neg.costCents, 0, "a negative claim must never lower spend");
});

test("concurrent invocations meter independently (AsyncLocalStorage scope isolation)", async () => {
  const sup = new Supervisor(new Map([
    ["a", plugin("a", 0, 10)],
    ["b", plugin("b", 0, 200)],
  ]));
  const [ra, rb] = await Promise.all([sup.run(call("a"), "ia"), sup.run(call("b"), "ib")]);
  assert.equal(ra.meteredCents, 10, "scope A saw only A's spend");
  assert.equal(rb.meteredCents, 200, "scope B saw only B's spend");
});

test("recording outside any meter scope is a no-op (direct client use is not capability spend)", async () => {
  assert.doesNotThrow(() => recordMeteredCost(99));
  const { meteredCents } = await meterRun(async () => undefined);
  assert.equal(meteredCents, 0, "a fresh scope is unaffected by out-of-scope recordings");
});
