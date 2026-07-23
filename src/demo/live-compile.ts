/**
 * LIVE demo: a real Anthropic call → manifest proposal → compiler validates +
 * monotonicity-checks + signs → engine runs it off the ledger.
 *
 * This is the only code path that makes a real network call. It reads the API key
 * from the environment (KRELVAN_ANTHROPIC_KEY) — never hardcoded, never printed.
 * If no key is present it exits cleanly (so the demo is safe to run anywhere).
 *
 * Run: KRELVAN_ANTHROPIC_KEY=sk-... npm run demo:live
 */

import { AnthropicModel } from "../adapters/anthropic-model.js";
import { Compiler, type Principal } from "../core/compiler/compiler.js";
import { HmacKeyring } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../core/ledger/store.js";
import { Engine } from "../core/kernel/engine.js";
import { Supervisor, type CapabilityPlugin } from "../core/capability/capability.js";
import { project } from "../core/kernel/project.js";

let clock = 1;
const now = () => clock++;

async function main(): Promise<void> {
  const apiKey = process.env.KRELVAN_ANTHROPIC_KEY;
  if (!apiKey) {
    console.log("\nNo KRELVAN_ANTHROPIC_KEY set — skipping the live model call.");
    console.log("Run:  KRELVAN_ANTHROPIC_KEY=sk-ant-... npm run demo:live\n");
    process.exit(0);
  }

  const intent = process.argv[2] ?? "Every morning, research the top AI news and send me a short brief.";
  console.log(`\nIntent: "${intent}"\n`);

  // The owner's authority — what capabilities a compiled manifest may use.
  const owner: Principal = {
    kind: "owner",
    id: "owner-1",
    maxRunBudgetCents: 100,
    allowedCapabilities: [
      { name: "web_search", sideEffect: "read", maxBudgetCents: 60 },
      { name: "compose", sideEffect: "read", maxBudgetCents: 30 },
      { name: "telegram_send", sideEffect: "message-human", maxBudgetCents: 20 },
    ],
  };

  const model = new AnthropicModel({
    apiKey,
    allowedCapabilities: owner.allowedCapabilities.map((c) => ({ name: c.name, sideEffect: c.sideEffect })),
    suggestedRunBudgetCents: owner.maxRunBudgetCents,
  });

  const ring = new HmacKeyring();
  const ownerSigner = ring.addKey("owner", "k-owner", { epoch: 1, validFrom: 0, validUntil: null });
  const compilerSigner = ring.addKey("compiler", "k-comp", { epoch: 1, validFrom: 0, validUntil: null });
  const supSigner = ring.addKey("supervisor", "k-sup", { epoch: 1, validFrom: 0, validUntil: null });

  console.log("→ calling the model to propose a manifest…");
  const compiler = new Compiler(model, compilerSigner);
  const res = await compiler.compile(intent, owner, now());

  if (!res.ok) {
    console.log(`✗ compile rejected at stage '${res.stage}':`);
    for (const i of res.issues) console.log(`   • ${i.code}: ${i.message}`);
    console.log("\n(The model proposed something outside the owner's authority — the compiler correctly refused it.)\n");
    process.exit(0);
  }

  const m = res.signed.manifest;
  console.log(`✓ compiled + signed. manifest "${m.name}" — ${m.nodes.length} nodes, budget ${m.runBudgetCents} units`);
  console.log(`  nodes: ${m.nodes.map((n) => `${n.id}[${n.capabilities.map((c) => c.name).join(",")}]`).join(" → ")}`);

  // Register stub plugins for each capability in the manifest.
  // (we are NOT going to make real web/Telegram calls in a demo).
  const plugins = new Map<string, CapabilityPlugin>();
  for (const node of m.nodes) {
    for (const cap of node.capabilities) {
      if (!plugins.has(cap.name)) {
        plugins.set(cap.name, {
          name: cap.name,
          sideEffect: cap.sideEffect,
          estimateCents: () => 5,
          async invoke() {
            return { output: { stub: true, cap: cap.name }, claimedCostCents: 5 };
          },
        });
      }
    }
  }

  const store = new InMemoryLedgerStore();
  const engine = new Engine(m, "acme", "live-1", {
    store,
    owner: ownerSigner,
    supervisor: new Supervisor(plugins),
    supervisorSigner: supSigner,
    now,
  });

  console.log("\n→ running the compiled manifest through the engine (stub plugins, no real side effects)…");
  const run = await engine.run({ approve: () => true });
  const events = await store.read("acme");
  const v = verify(events, ring);
  const p = project(events);

  console.log(`  run status: ${run.status}`);
  console.log(`  ledger: ${events.length} signed events, verified: ${v.ok ? "✔" : "✗"}`);
  console.log(`  budget: ${p.budget.runSpentCents} units used`);
  console.log(
    run.status === "completed" && v.ok
      ? "\n✅ LIVE: a real model proposed a workflow; the compiler signed it within authority;\n   the engine ran it off the ledger and the log verifies.\n"
      : "\n(run did not complete cleanly — see above)\n",
  );
}

main().catch((e) => {
  console.error("error:", (e as Error).message);
  process.exit(1);
});
