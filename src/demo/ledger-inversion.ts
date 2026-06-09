/**
 * Demo: "the ledger IS the runtime" — the inversion.
 *
 * Proves that the canvas state, the cost meter, and the audit timeline are NOT
 * stored separately — they are pure PROJECTIONS (folds) of the one event log.
 * We append a tiny 2-node run, then derive three different views purely by
 * folding the same events. Change nothing else; the views can only ever reflect
 * what is in the log. That is "what you see is exactly what executed."
 *
 * Run: npm run demo:ledger
 */

import { HmacKeyring } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore } from "../core/ledger/store.js";
import { verify } from "../core/ledger/store.js";
import type { EventScope, LedgerEvent } from "../core/ledger/event.js";

// a logical clock so the demo is deterministic (no Date.now)
let clock = 1;
const now = () => clock++;

async function main(): Promise<void> {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "demo-secret", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisor = ring.addKey("supervisor", "sup-secret", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();

  const scope = (nodeId?: string): EventScope => ({
    tenantId: "demo",
    runId: "run-1",
    branchId: "main",
    ...(nodeId ? { nodeId } : {}),
  });

  // A 2-node run: researcher → reporter. Each does one priced effect.
  await store.append({ type: "RunStarted", scope: scope(), payload: { manifest: "content-brief" }, author: "owner" }, { ts: now(), signer: owner });

  // node 1: researcher
  await store.append({ type: "NodeEntered", scope: scope("researcher"), payload: {}, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "AdmissionDecision", scope: scope("researcher"), payload: { effect: "web_search", admitted: true, budgetCents: 50 }, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "EffectRequested", scope: scope("researcher"), payload: { effect: "web_search", idem: "researcher:web_search:1", query: "AI agents 2026" }, author: "owner" }, { ts: now(), signer: owner });
  // supervisor co-signs the OBSERVED result (cost in integer cents — LED-02)
  await store.append({ type: "EffectResult", scope: scope("researcher"), payload: { idem: "researcher:web_search:1", costCents: 12, summary: "found 5 sources" }, determinism: "captured", author: "supervisor" }, { ts: now(), signer: supervisor });
  await store.append({ type: "NodeConcluded", scope: scope("researcher"), payload: { output: "research brief" }, author: "owner" }, { ts: now(), signer: owner });

  // node 2: reporter
  await store.append({ type: "NodeEntered", scope: scope("reporter"), payload: {}, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "AdmissionDecision", scope: scope("reporter"), payload: { effect: "telegram_send", admitted: true, budgetCents: 50 }, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "EffectRequested", scope: scope("reporter"), payload: { effect: "telegram_send", idem: "reporter:telegram_send:1" }, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "EffectResult", scope: scope("reporter"), payload: { idem: "reporter:telegram_send:1", costCents: 1, delivered: true }, determinism: "captured", author: "supervisor" }, { ts: now(), signer: supervisor });
  await store.append({ type: "NodeConcluded", scope: scope("reporter"), payload: { output: "delivered" }, author: "owner" }, { ts: now(), signer: owner });
  await store.append({ type: "RunCompleted", scope: scope(), payload: {}, author: "owner" }, { ts: now(), signer: owner });

  const events = await store.read("demo");

  // The log is the single source of truth — verify it first.
  const v = verify(events, ring);
  if (!v.ok) {
    console.error("UNVERIFIABLE:", v.error);
    process.exit(1);
  }

  console.log(`\nLedger: ${events.length} signed events, chain verified ✔\n`);

  // ── Three independent VIEWS, all pure folds of the same events ──────────────

  console.log("VIEW 1 — Canvas (node states), folded from the log:");
  console.log(projectCanvas(events));

  console.log("\nVIEW 2 — Cost meter, folded from the log:");
  const cost = projectCost(events);
  console.log(`  total spent: ${cost.totalCents}¢  (per effect: ${JSON.stringify(cost.byEffect)})`);

  console.log("\nVIEW 3 — Audit timeline, folded from the log:");
  for (const line of projectTimeline(events)) console.log("  " + line);

  console.log(
    "\nAll three views are reads of the SAME log. Nothing is stored separately.\n" +
      'That is the inversion: "what you see is exactly what executed."\n',
  );
}

// canvas = the latest state per node
function projectCanvas(events: readonly LedgerEvent[]): Record<string, string> {
  const state: Record<string, string> = {};
  for (const e of events) {
    const node = e.scope.nodeId;
    if (!node) continue;
    if (e.type === "NodeEntered") state[node] = "running";
    else if (e.type === "NodeConcluded") state[node] = "done";
    else if (e.type === "RunFailed") state[node] = "failed";
  }
  return state;
}

// cost = sum of EffectResult.costCents (integer cents, exact)
function projectCost(events: readonly LedgerEvent[]): { totalCents: number; byEffect: Record<string, number> } {
  let total = 0;
  const byEffect: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "EffectResult") {
      const p = e.payload as { idem?: string; costCents?: number };
      const c = p.costCents ?? 0;
      total += c;
      if (p.idem) byEffect[p.idem] = c;
    }
  }
  return { totalCents: total, byEffect };
}

// timeline = human-readable line per event
function projectTimeline(events: readonly LedgerEvent[]): string[] {
  return events.map((e) => `[${e.offset}] ${e.scope.nodeId ?? "run"} · ${e.type} · by ${e.author}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
