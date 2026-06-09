/**
 * Memory tests — the four planes, distillation provenance, the untrusted-inbound
 * gate, and deterministic retrieval. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HmacKeyring } from "../ledger/crypto.js";
import { InMemoryLedgerStore } from "../ledger/store.js";
import type { EventScope } from "../ledger/event.js";
import {
  consequentialFacts,
  distilledProvenance,
  isTrusted,
  projectMemory,
  retrieve,
  type Episode,
  type SemanticFact,
  type Soul,
} from "./memory.js";

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const sup = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  return { ring, owner, sup, store, now: () => clock++ };
}
const scope = (nodeId?: string): EventScope => ({ tenantId: "t", runId: "r", branchId: "main", ...(nodeId ? { nodeId } : {}) });

function fact(key: string, value: string | number | boolean, over: Partial<SemanticFact> = {}): SemanticFact {
  return { key, value, derivedFrom: [], provenance: "tool-observed", distilledBy: "model-x", version: 1, ts: 1, ...over };
}

// ── provenance / trust ──────────────────────────────────────────────────────────

test("MEM: trusted vs untrusted provenance", () => {
  assert.ok(isTrusted("owner"));
  assert.ok(isTrusted("tool-observed"));
  assert.ok(!isTrusted("channel"));
  assert.ok(!isTrusted("agent"));
  assert.ok(!isTrusted("memory"));
});

test("MEM: untrustedness PROPAGATES through distillation (never washes out)", () => {
  assert.equal(distilledProvenance(["owner", "tool-observed"]), "owner");
  assert.equal(distilledProvenance(["tool-observed"]), "tool-observed");
  // any untrusted source taints the result
  assert.equal(distilledProvenance(["owner", "channel"]), "channel");
  assert.equal(distilledProvenance(["tool-observed", "agent"]), "agent");
});

test("MEM: untrusted-inbound gate — laundered fact CANNOT inform a consequential decision", () => {
  const facts = [
    fact("vendor", "acme", { provenance: "owner" }),
    fact("wire_to", "attacker-iban", { provenance: "channel" }), // laundered via a chat message
  ];
  const { usable, quarantined } = consequentialFacts(facts);
  assert.deepEqual(usable.map((f) => f.key), ["vendor"]);
  assert.deepEqual(quarantined.map((f) => f.key), ["wire_to"]);
  // the dangerous fact is NOT usable for a spend/irreversible decision
  assert.ok(!usable.some((f) => f.key === "wire_to"));
});

// ── projection (folding the ledger) ──────────────────────────────────────────────

async function appendMemory(r: ReturnType<typeof rig>, mem: unknown, author: "owner" | "supervisor") {
  const signer = author === "owner" ? r.owner : r.sup;
  await r.store.append(
    { type: "EffectResult", scope: scope("mem"), payload: { idem: `m${r.now()}`, memory: mem }, determinism: "captured", author },
    { ts: r.now(), signer },
  );
}

test("MEM: episodic and semantic planes fold from the ledger", async () => {
  const r = rig();
  const ep: Episode = { runId: "r", summary: "researched AI agents", provenance: "tool-observed", ts: 1 };
  await appendMemory(r, { plane: "episodic", episode: ep }, "supervisor");
  await appendMemory(r, { plane: "semantic", fact: fact("topic", "ai-agents") }, "supervisor");

  const events = await r.store.read("t");
  const mem = projectMemory(events);
  assert.equal(mem.episodic.length, 1);
  assert.equal(mem.episodic[0]!.summary, "researched AI agents");
  assert.equal(mem.semantic.get("topic")?.value, "ai-agents");
});

test("MEM: re-distillation SUPERSEDES by version (never mutates in place)", async () => {
  const r = rig();
  await appendMemory(r, { plane: "semantic", fact: fact("price", 100, { version: 1 }) }, "supervisor");
  await appendMemory(r, { plane: "semantic", fact: fact("price", 120, { version: 2, distilledBy: "model-y" }) }, "supervisor");
  // an out-of-order older version must NOT override the newer one
  await appendMemory(r, { plane: "semantic", fact: fact("price", 999, { version: 1 }) }, "supervisor");

  const mem = projectMemory(await r.store.read("t"));
  const f = mem.semantic.get("price")!;
  assert.equal(f.version, 2);
  assert.equal(f.value, 120);
  assert.equal(f.distilledBy, "model-y");
});

test("MEM: SOUL only updates when authorityOk (owner authority enforced upstream)", async () => {
  const r = rig();
  const soul: Soul = { name: "Atlas", values: ["honest"], standingInstructions: ["never spend without asking"], version: 1 };
  // a NON-authorized soul edit (authorityOk:false) must be ignored
  await appendMemory(r, { plane: "soul", soul: { ...soul, name: "Hacked" }, authorityOk: false }, "supervisor");
  let mem = projectMemory(await r.store.read("t"));
  assert.equal(mem.soul, null, "unauthorized soul edit ignored");

  // an authorized soul edit applies
  await appendMemory(r, { plane: "soul", soul, authorityOk: true }, "owner");
  mem = projectMemory(await r.store.read("t"));
  assert.equal(mem.soul?.name, "Atlas");
});

// ── retrieval ─────────────────────────────────────────────────────────────────────

test("MEM: retrieval is deterministic (stable order) for the same projection+query", async () => {
  const r = rig();
  await appendMemory(r, { plane: "semantic", fact: fact("b", 2) }, "supervisor");
  await appendMemory(r, { plane: "semantic", fact: fact("a", 1) }, "supervisor");
  await appendMemory(r, { plane: "semantic", fact: fact("c", 3) }, "supervisor");
  const mem = projectMemory(await r.store.read("t"));

  const r1 = retrieve(mem, ["c", "a", "b"]).map((f) => f.key);
  const r2 = retrieve(mem, ["b", "c", "a"]).map((f) => f.key);
  assert.deepEqual(r1, ["a", "b", "c"]); // stable sorted order
  assert.deepEqual(r1, r2); // same result regardless of query order
});

test("MEM: retrieve only returns facts that exist", async () => {
  const r = rig();
  await appendMemory(r, { plane: "semantic", fact: fact("known", 1) }, "supervisor");
  const mem = projectMemory(await r.store.read("t"));
  assert.deepEqual(retrieve(mem, ["known", "missing"]).map((f) => f.key), ["known"]);
});
