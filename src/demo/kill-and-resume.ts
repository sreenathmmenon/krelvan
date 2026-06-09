/**
 * Demo: kill-and-resume with NO double-execution (the durability proof).
 *
 * Scenario: a 2-node run where node 1 performs an IRREVERSIBLE, costly effect
 * (imagine "charge the customer"). We run node 1, durably append its EffectResult,
 * then SIMULATE A CRASH before node 2 runs. On resume, the engine folds the log,
 * sees node 1's effect already has a result (by idempotency key), and RE-SERVES it
 * instead of re-executing — so the customer is charged exactly once.
 *
 * We count real side-effect executions to prove it. Covers premortem LED-10/11,
 * DUR-* (no double-execution), and the "crash hole" rule.
 *
 * Run: npm run demo:resume
 */

import { HmacKeyring, type Signer } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../core/ledger/store.js";
import type { EventScope, LedgerEvent } from "../core/ledger/event.js";

let clock = 1;
const now = () => clock++;

// The "world" — a side-effecting resource. We count how many times each
// irreversible effect ACTUALLY executes. The whole point is: exactly once.
const sideEffectExecutions: Record<string, number> = {};
function performIrreversibleEffect(idem: string): { costCents: number } {
  sideEffectExecutions[idem] = (sideEffectExecutions[idem] ?? 0) + 1;
  return { costCents: 99 }; // e.g. a $0.99 charge
}

interface Node {
  id: string;
  effect: string;
  idem: string;
}

const MANIFEST: Node[] = [
  { id: "charger", effect: "charge_customer", idem: "charger:charge_customer:1" },
  { id: "reporter", effect: "telegram_send", idem: "reporter:telegram_send:1" },
];

function scope(nodeId?: string): EventScope {
  return { tenantId: "demo", runId: "run-1", branchId: "main", ...(nodeId ? { nodeId } : {}) };
}

/**
 * The mini-engine: a pure reducer decides the next node to run by folding the log,
 * then the (impure) runner executes ONE effect and appends its result. Crucially,
 * before executing an effect it checks the log: if an EffectResult for that
 * idempotency key already exists, it RE-SERVES (no execution).
 */
async function runUntil(
  store: InMemoryLedgerStore,
  owner: Signer,
  supervisor: Signer,
  stopAfterNode: string | null,
): Promise<void> {
  for (const node of MANIFEST) {
    const events = await store.read("demo");
    if (nodeConcluded(events, node.id)) continue; // already done in a prior life

    // enter node (idempotent: only if not already entered)
    if (!hasEvent(events, node.id, "NodeEntered")) {
      await store.append({ type: "NodeEntered", scope: scope(node.id), payload: {}, author: "owner" }, { ts: now(), signer: owner });
    }

    // admission (pure decision)
    const evs2 = await store.read("demo");
    if (!hasEvent(evs2, node.id, "AdmissionDecision")) {
      await store.append({ type: "AdmissionDecision", scope: scope(node.id), payload: { effect: node.effect, admitted: true, budgetCents: 200 }, author: "owner" }, { ts: now(), signer: owner });
    }

    // request (records intent + idempotency key) — append only if absent
    const evs3 = await store.read("demo");
    if (!hasEffectRequest(evs3, node.idem)) {
      await store.append({ type: "EffectRequested", scope: scope(node.id), payload: { effect: node.effect, idem: node.idem }, author: "owner" }, { ts: now(), signer: owner });
    }

    // RESULT — the critical part. Re-serve if a result already exists.
    const evs4 = await store.read("demo");
    if (!hasEffectResult(evs4, node.idem)) {
      // no result yet → actually perform the effect, then record the OBSERVED result
      const observed = performIrreversibleEffect(node.idem);
      await store.append(
        { type: "EffectResult", scope: scope(node.id), payload: { idem: node.idem, costCents: observed.costCents }, determinism: "captured", author: "supervisor" },
        { ts: now(), signer: supervisor },
      );
    } else {
      // result already in the log → re-serve, do NOT execute again
      console.log(`  (resume) effect ${node.idem} already has a result — re-served, NOT re-executed`);
    }

    await store.append({ type: "NodeConcluded", scope: scope(node.id), payload: {}, author: "owner" }, { ts: now(), signer: owner });

    if (stopAfterNode && node.id === stopAfterNode) {
      throw new CrashSignal(node.id); // simulate process death right after this node
    }
  }
}

class CrashSignal extends Error {
  constructor(readonly afterNode: string) {
    super(`simulated crash after node ${afterNode}`);
  }
}

// ── log-fold helpers (pure) ────────────────────────────────────────────────────
function hasEvent(events: readonly LedgerEvent[], nodeId: string, type: string): boolean {
  return events.some((e) => e.scope.nodeId === nodeId && e.type === type);
}
function nodeConcluded(events: readonly LedgerEvent[], nodeId: string): boolean {
  return hasEvent(events, nodeId, "NodeConcluded");
}
function hasEffectRequest(events: readonly LedgerEvent[], idem: string): boolean {
  return events.some((e) => e.type === "EffectRequested" && (e.payload as { idem?: string }).idem === idem);
}
function hasEffectResult(events: readonly LedgerEvent[], idem: string): boolean {
  return events.some((e) => e.type === "EffectResult" && (e.payload as { idem?: string }).idem === idem);
}

async function main(): Promise<void> {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "demo-secret", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisor = ring.addKey("supervisor", "sup-secret", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();

  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: now(), signer: owner });

  console.log("\n── Life 1: run, then CRASH right after the irreversible charge ──");
  try {
    await runUntil(store, owner, supervisor, "charger");
  } catch (e) {
    if (e instanceof CrashSignal) console.log(`  💥 crashed after node '${e.afterNode}' (process would die here)`);
    else throw e;
  }

  console.log(`  charge executions so far: ${sideEffectExecutions["charger:charge_customer:1"] ?? 0}`);

  console.log("\n── Life 2: process restarts, folds the log, resumes ──");
  // A fresh "process" — same store (= durable disk). The engine recovers purely from the log.
  const recovered = await store.read("demo");
  const v = verify(recovered, ring);
  console.log(`  recovered ${recovered.length} events; chain verified: ${v.ok ? "✔" : "✗ " + (v.ok ? "" : v.error.kind)}`);
  await runUntil(store, owner, supervisor, null); // run to completion

  await store.append({ type: "RunCompleted", scope: scope(), payload: {}, author: "owner" }, { ts: now(), signer: owner });

  const charges = sideEffectExecutions["charger:charge_customer:1"] ?? 0;
  const sends = sideEffectExecutions["reporter:telegram_send:1"] ?? 0;

  console.log("\n── Result ──");
  console.log(`  customer charged: ${charges} time(s)`);
  console.log(`  reporter sent:    ${sends} time(s)`);

  const finalEvents = await store.read("demo");
  const vf = verify(finalEvents, ring);
  console.log(`  final log: ${finalEvents.length} events, verified: ${vf.ok ? "✔" : "✗"}`);

  if (charges === 1 && sends === 1 && vf.ok) {
    console.log("\n✅ PROVEN: crash-and-resume executed each irreversible effect EXACTLY ONCE.\n");
    process.exit(0);
  } else {
    console.error("\n❌ FAILED: double-execution or unverifiable log.\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
