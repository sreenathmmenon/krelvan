/**
 * Full-circle demo: compile a manifest from "intent", then RUN it through the engine.
 *
 * This closes the loop: describe an outcome → the compiler produces a validated,
 * monotonicity-checked, signed manifest → the engine drives it off the ledger →
 * the result is a verified log.
 *
 * It also demonstrates the security property end-to-end: the SAME malicious proposal
 * compiled under an UNTRUSTED principal is REJECTED (no escalation), while under the
 * owner it compiles and runs.
 *
 * Run: npm run demo:compile
 */

import { HmacKeyring } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../core/ledger/store.js";
import { project } from "../core/kernel/project.js";
import { Engine } from "../core/kernel/engine.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../core/capability/capability.js";
import { Compiler, type ModelPort, type Principal } from "../core/compiler/compiler.js";
import type { Manifest } from "../core/manifest/manifest.js";

let clock = 1;
const now = () => clock++;

function plugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, out: unknown): CapabilityPlugin {
  return { name, sideEffect, estimateCents: () => cost, async invoke() { return { output: out, claimedCostCents: cost }; } };
}

// The manifest a model would propose for "research AI agents and message me a brief".
const PROPOSED: Manifest = {
  version: 1,
  name: "research-and-report",
  intent: "research AI agents and message me a brief",
  entry: "researcher",
  runBudgetCents: 60,
  maxNodeVisits: 2,
  nodes: [
    { id: "researcher", role: "research", autonomy: "full", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 40 }] },
    { id: "reporter", role: "deliver", autonomy: "full", capabilities: [{ name: "telegram_send", sideEffect: "message-human", budgetCents: 20 }] },
  ],
  edges: [{ from: "researcher", to: "reporter" }],
};

const owner: Principal = {
  kind: "owner",
  id: "owner-1",
  maxRunBudgetCents: 1000,
  allowedCapabilities: [
    { name: "web_search", sideEffect: "read", maxBudgetCents: 100 },
    { name: "telegram_send", sideEffect: "message-human", maxBudgetCents: 50 },
  ],
};

// An untrusted channel principal that may NOT confer telegram_send.
const channel: Principal = {
  kind: "channel",
  id: "telegram:stranger",
  maxRunBudgetCents: 30,
  allowedCapabilities: [{ name: "web_search", sideEffect: "read", maxBudgetCents: 20 }],
};

function fakeModel(out: Manifest): ModelPort {
  return { async propose() { return out; } };
}

async function main(): Promise<void> {
  const ring = new HmacKeyring();
  const ownerSigner = ring.addKey("owner", "k-owner", { epoch: 1, validFrom: 0, validUntil: null });
  const compilerSigner = ring.addKey("compiler", "k-comp", { epoch: 1, validFrom: 0, validUntil: null });
  const supSigner = ring.addKey("supervisor", "k-sup", { epoch: 1, validFrom: 0, validUntil: null });

  const compiler = new Compiler(fakeModel(PROPOSED), compilerSigner);

  console.log("\n── Step 1: compile the SAME proposal under two principals ──\n");

  // untrusted channel — must be REJECTED (it tries to confer telegram_send)
  const asChannel = await compiler.compile(PROPOSED.intent, channel, now());
  console.log(`  as untrusted channel: ${asChannel.ok ? "COMPILED (!!)" : "REJECTED — " + asChannel.stage}`);
  if (!asChannel.ok) for (const i of asChannel.issues) console.log(`      • ${i.code}: ${i.message}`);

  // owner — should COMPILE and sign
  const asOwner = await compiler.compile(PROPOSED.intent, owner, now());
  console.log(`  as owner: ${asOwner.ok ? "COMPILED + signed ✔" : "REJECTED — " + asOwner.stage}`);
  if (!asOwner.ok) {
    console.error("owner compile should have succeeded");
    process.exit(1);
  }

  console.log(`  manifest id: ${asOwner.signed.id}`);
  console.log(`  provenance: intent="${asOwner.signed.provenance.intent}" by ${asOwner.signed.provenance.principalKind}`);

  console.log("\n── Step 2: run the compiled manifest through the engine ──\n");

  const store = new InMemoryLedgerStore();
  const plugins = new Map<string, CapabilityPlugin>([
    ["web_search", plugin("web_search", "read", 9, { sources: 5 })],
    ["telegram_send", plugin("telegram_send", "message-human", 1, { delivered: true })],
  ]);
  const supervisor = new Supervisor(plugins);

  const engine = new Engine(asOwner.signed.manifest, "acme", "run-compile-1", {
    store,
    owner: ownerSigner,
    supervisor,
    supervisorSigner: supSigner,
    now,
  });

  const res = await engine.run();
  const events = await store.read("acme");
  const v = verify(events, ring);
  const p = project(events);

  console.log(`  run status: ${res.status}`);
  console.log(`  ledger: ${events.length} signed events, verified: ${v.ok ? "✔" : "✗"}`);
  console.log(`  cost: ${p.budget.runSpentCents}¢ of ${asOwner.signed.manifest.runBudgetCents}¢ budget`);
  console.log(`  nodes: ${Object.entries(p.nodes).map(([n, s]) => `${n}=${s.concluded ? "done" : "?"}`).join(", ")}`);

  const allOk = !asChannel.ok && res.status === "completed" && v.ok && p.budget.runSpentCents === 10;
  console.log(
    allOk
      ? "\n✅ Full circle: intent → compiled+signed manifest → run off the ledger → verified.\n" +
          "   The same proposal was REJECTED for an untrusted principal (no escalation).\n"
      : "\n❌ something did not match expectations\n",
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
