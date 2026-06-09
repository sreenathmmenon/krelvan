/**
 * End-to-end demo: a real multi-agent run through the ACTUAL kernel + engine.
 *
 * No hand-written events this time — we define a manifest (the program), a plan
 * (what each node does), register plugins, and let the pure kernel + impure engine
 * drive the whole run by folding the ledger. Then we verify the log and show that
 * the canvas, cost meter, and audit timeline are all reads of it.
 *
 * Demonstrates, on real machinery:
 *  - the ledger is the runtime (everything folds from one verified log)
 *  - deny-by-default capabilities + reserve-then-settle budget
 *  - the autonomy gradient (a node parked for approval, then approved)
 *  - the supervisor co-signs effect results (plugins never self-sign)
 *
 * Run: npm run demo:e2e
 */

import { HmacKeyring } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../core/ledger/store.js";
import { project } from "../core/kernel/project.js";
import { Engine } from "../core/kernel/engine.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../core/capability/capability.js";
import type { Manifest } from "../core/manifest/manifest.js";
import type { LedgerEvent } from "../core/ledger/event.js";

let clock = 1;
const now = () => clock++;

// ── plugins (the swappable capability layer) ───────────────────────────────────

function plugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, run: (c: EffectCall) => unknown): CapabilityPlugin {
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(c: EffectCall) {
      return { output: run(c), claimedCostCents: cost };
    },
  };
}

async function main(): Promise<void> {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "e2e-owner", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "e2e-sup", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();

  // A 3-node content pipeline: research -> write -> deliver.
  // "deliver" sends to a human → message-human → gated under act-with-veto autonomy.
  const manifest: Manifest = {
    version: 1,
    name: "content-pipeline",
    intent: "research a topic, write a brief, deliver it",
    entry: "researcher",
    runBudgetCents: 100,
    maxNodeVisits: 3,
    nodes: [
      { id: "researcher", role: "research the topic", autonomy: "full", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 50 }] },
      { id: "writer", role: "write the brief", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 30 }] },
      { id: "reporter", role: "deliver to the human", autonomy: "act-with-veto", capabilities: [{ name: "telegram_send", sideEffect: "message-human", budgetCents: 20 }] },
    ],
    edges: [
      { from: "researcher", to: "writer" },
      { from: "writer", to: "reporter" },
    ],
  };

  const plugins = new Map<string, CapabilityPlugin>([
    ["web_search", plugin("web_search", "read", 8, () => ({ sources: 5 }))],
    ["compose", plugin("compose", "read", 6, () => ({ words: 480 }))],
    ["telegram_send", plugin("telegram_send", "message-human", 1, () => ({ delivered: true }))],
  ]);

  const supervisor = new Supervisor(plugins);
  const engine = new Engine(manifest, "acme", "run-42", { store, owner, supervisor, supervisorSigner, now });

  // The reporter is "act-with-veto" with a message-human effect → it gates. Approve it.
  console.log("\n── Running content-pipeline through the real kernel + engine ──\n");
  const res = await engine.run({ approve: (c) => (console.log(`  approval requested for ${c.capability} → APPROVED`), true) });

  console.log(`\nrun status: ${res.status}`);

  const events = await store.read("acme");
  const v = verify(events, ring);
  console.log(`ledger: ${events.length} signed events, chain verified: ${v.ok ? "✔" : "✗ " + (v.ok ? "" : v.error.kind)}`);
  if (!v.ok) process.exit(1);

  const p = project(events);

  console.log("\nVIEW — Canvas (node states), folded from the log:");
  for (const [node, st] of Object.entries(p.nodes)) console.log(`  ${node}: ${st.concluded ? "done" : st.entered ? "running" : "idle"} (visits ${st.visits})`);

  console.log("\nVIEW — Cost meter (exact integer cents), folded from the log:");
  console.log(`  spent ${p.budget.runSpentCents}¢ of ${manifest.runBudgetCents}¢ budget; reserved open: ${p.budget.runReservedCents}¢`);

  console.log("\nVIEW — Who signed each effect result (plugins never self-sign):");
  for (const e of events as LedgerEvent[]) {
    if (e.type === "EffectResult") {
      const pl = e.payload as { idem?: string; costCents?: number };
      console.log(`  ${pl.idem} → ${pl.costCents}¢, signed by '${e.author}'`);
    }
  }

  const allOk = res.status === "completed" && v.ok && p.budget.runSpentCents === 15;
  console.log(
    allOk
      ? "\n✅ End-to-end: a real 3-agent run drove itself off the ledger, gated a human-facing\n   effect, settled cost exactly, and the whole log verifies. Plugins did not self-sign.\n"
      : "\n❌ something did not match expectations\n",
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
