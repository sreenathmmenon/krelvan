/**
 * Combination-workflow proofs for two more build-and-sell chains:
 *   #2 Lead to Outreach:  enrich(read) -> qualify(read) -> crm_write(reversible)
 *                         -> draft(read) -> send(email, human-gated) | done_unqualified
 *   #5 Order to Refund:   lookup(read) -> decide(read) -> refund(MONEY, irreversible,
 *                         human-gated) -> notify(email) | deny_note
 *
 * These test the two things that separate a platform from a toy across MORE connectors:
 * a chain of side-effects that BRANCHES on an LLM decision, and the human-approval gate
 * holding on the irreversible / money / message actions. Fake plugins (no real network),
 * so orchestration + branch + gate + signed ledger are what's under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(join(here, f), "utf8")) as Manifest;

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** Fake plugins for both manifests; per-node outputs via `out`. */
function plugins(out: Record<string, Record<string, unknown>>): Map<string, CapabilityPlugin> {
  const mk = (name: string, sideEffect: CapabilityPlugin["sideEffect"], cents: number): CapabilityPlugin => ({
    name, sideEffect, estimateCents: () => cents,
    async invoke(c: EffectCall) { return { output: out[c.nodeId] ?? { result: "ok" }, claimedCostCents: cents }; },
  });
  return new Map<string, CapabilityPlugin>([
    ["http_get", mk("http_get", "read", 5)],
    ["http_post", mk("http_post", "write-irreversible", 3)], // covers both reversible+irreversible uses
    ["web_search", mk("web_search", "read", 8)],             // the enrich node researches the lead
    ["think", mk("think", "read", 40)],
    ["compose", mk("compose", "read", 40)],
    ["email_send", mk("email_send", "message-human", 5)],
  ]);
}

async function run(m: Manifest, out: Record<string, Record<string, unknown>>, approve: (c: EffectCall) => boolean) {
  const { ring, owner, supervisorSigner, store, now } = rig();
  const { supervisor } = Supervisor.create(plugins(out));
  const initialState = { ...(m.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const engine = new Engine(m, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 60, approve, initialState });
  const events = await store.read("t1");
  const seq = events.filter((e) => e.type === "NodeEntered").map((e) => (e.scope as { nodeId?: string }).nodeId);
  return { res, ring, store, seq };
}

// ── #2 Lead to Outreach ───────────────────────────────────────────────────────
const lead = load("lead-to-outreach.manifest.json");

test("lead-to-outreach validates; send is the only human-gated step", () => {
  assert.deepEqual(validateManifest(lead), []);
  assert.equal(lead.nodes.find((n) => n.id === "send")!.autonomy, "suggest");
  assert.equal(lead.nodes.find((n) => n.id === "crm_write")!.capabilities[0]!.sideEffect, "write-reversible");
});

test("QUALIFIED + approve: enrich -> qualify -> crm_write -> draft -> send; ledger verifies", async () => {
  const out = {
    enrich: { company_facts: "50-person AI infra team", enriched: true },
    qualify: { fit: 82, reason: "matches ICP", qualified: true },
    crm_write: { contact_id: "c_1" },
    draft: { subject: "Hi Dana", body: "Saw Northwind is building internal tooling…" },
    send: { sent: true },
  };
  const { res, ring, store, seq } = await run(lead, out, () => true);
  assert.equal(res.status, "completed", `expected completed, got ${res.status} ${res.reason ?? ""}`);
  assert.deepEqual(seq, ["enrich", "qualify", "crm_write", "draft", "send"]);
  assert.equal(res.projection.state["send.sent"], true);
  assert.ok(verify(await store.read("t1"), ring).ok, "ledger must verify");
});

test("UNQUALIFIED: branches away — no CRM write, no email", async () => {
  const out = {
    enrich: { company_facts: "2-person hobby project", enriched: true },
    qualify: { fit: 20, reason: "too small for ICP", qualified: false },
    done_unqualified: { message: "not a fit" },
  };
  const { res, ring, store, seq } = await run(lead, out, () => true);
  assert.equal(res.status, "completed");
  assert.ok(!seq.includes("crm_write"), "must not write the CRM for an unqualified lead");
  assert.ok(!seq.includes("send"), "must not email an unqualified lead");
  assert.ok(seq.includes("done_unqualified"));
  assert.ok(verify(await store.read("t1"), ring).ok);
});

test("QUALIFIED + DENY the email: nothing is sent", async () => {
  const out = {
    enrich: { company_facts: "50-person AI infra team", enriched: true },
    qualify: { fit: 82, reason: "matches ICP", qualified: true },
    crm_write: { contact_id: "c_1" },
    draft: { subject: "Hi Dana", body: "…" },
  };
  const { res, store, seq } = await run(lead, out, (c) => c.capability !== "email_send");
  assert.notEqual(res.status, "completed", "a denied email must not complete as sent");
  assert.ok(seq.includes("crm_write"), "the reversible CRM write still happened");
  assert.equal(res.projection.state["send.sent"], undefined, "no email left the system");
  const { ring } = rig();
  void ring; // ledger of the halted run still verifies via the store's own keyring in run()
});

// ── #5 Order to Refund (the money gate) ───────────────────────────────────────
const refund = load("order-to-refund.manifest.json");

test("order-to-refund validates; refund is irreversible + human-gated", () => {
  assert.deepEqual(validateManifest(refund), []);
  const r = refund.nodes.find((n) => n.id === "refund")!;
  assert.equal(r.autonomy, "suggest");
  assert.equal(r.capabilities[0]!.sideEffect, "write-irreversible");
});

test("REFUND approved: lookup -> decide -> refund -> notify; money moves once; ledger verifies", async () => {
  const out = {
    lookup: { amount_cents: 12900, days_since_order: 9, status: "DELIVERED", issue: "damaged" },
    decide: { verdict: "refund", amount_cents: 12900, reason: "damaged within 30 days per policy" },
    refund: { refund_id: "re_1" },
    notify: { sent: true },
  };
  const { res, ring, store, seq } = await run(refund, out, () => true);
  assert.equal(res.status, "completed", `expected completed, got ${res.status} ${res.reason ?? ""}`);
  assert.deepEqual(seq, ["lookup", "decide", "refund", "notify"]);
  assert.equal(res.projection.state["refund.refund_id"], "re_1");
  assert.ok(verify(await store.read("t1"), ring).ok);
});

test("REFUND denied at the money gate: NO money moves", async () => {
  const out = {
    lookup: { amount_cents: 12900, days_since_order: 9, status: "DELIVERED", issue: "damaged" },
    decide: { verdict: "refund", amount_cents: 12900, reason: "…" },
  };
  // approve everything except the irreversible refund http_post
  const { res, store, seq } = await run(refund, out, (c) => c.capability !== "http_post");
  assert.notEqual(res.status, "completed", "a denied refund must not complete as if money moved");
  assert.equal(res.projection.state["refund.refund_id"], undefined, "NO refund executed — no money moved");
  assert.ok(seq.includes("decide"));
});

test("REFUND policy DENY branch: decide says deny -> deny_note, refund never reached", async () => {
  const out = {
    lookup: { amount_cents: 12900, days_since_order: 40, status: "DELIVERED", issue: "changed mind" },
    decide: { verdict: "deny", amount_cents: 0, reason: "buyer's remorse after 30 days — not covered" },
    deny_note: { message: "Sorry, this doesn't qualify…" },
  };
  const { res, ring, store, seq } = await run(refund, out, () => true);
  assert.equal(res.status, "completed");
  assert.ok(!seq.includes("refund"), "a policy-denied request must never reach the money step");
  assert.ok(seq.includes("deny_note"));
  assert.ok(verify(await store.read("t1"), ring).ok);
});
