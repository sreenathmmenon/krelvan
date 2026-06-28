/**
 * Guards the flagship Support Resolution Agent (v2 — competitor best-features, made provable).
 * Pipeline: front-door triage (intent/sentiment/language/distress/out-of-scope) -> per-customer
 * recall -> grounded retrieval with three confidence tiers (answer / clarify / escalate) ->
 * evaluator-optimizer judge -> fail-closed resolve/escalate -> human-gated send OR pre-investigated
 * case-file escalation -> provable QA score -> record. Validates structurally, uses only real
 * built-ins, and drives the Engine end-to-end down the key safety paths, ledger verifying.
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
const manifest = JSON.parse(readFileSync(join(here, "support-agent.manifest.json"), "utf8")) as Manifest;

const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** Per-node fakes keyed by nodeId; `over` overrides specific node outputs per scenario. */
function plugins(over: Record<string, Record<string, unknown>> = {}): Map<string, CapabilityPlugin> {
  const thinkOut = (nodeId: string): Record<string, unknown> => {
    if (nodeId === "triage") return { distress: false, out_of_scope: false, category: "shipping", sentiment: "neutral", language: "english", urgency: 50, asks: "when will my order arrive", needs_action: false, reason: "asks order status", ...over["triage"] };
    if (nodeId === "judge") return { verdict: "pass", critique: "none", score: 92, ...over["judge"] };
    if (nodeId === "qa") return { qa_relevant: true, qa_accurate: true, qa_safe: true, qa_resolved: true, qa_score: 90, qa_note: "good resolution", ...over["qa"] };
    return { result: "ok" };
  };
  const composeOut = (nodeId: string): Record<string, unknown> => {
    if (nodeId === "answer") return { reply: "Your order ships in 1 day and arrives in 3-5 days.", grounded: true, cited_source: "handbook", makes_promise: false, ...over["answer"] };
    if (nodeId === "clarify") return { reply: "Could you share your order number so I can check?", is_clarification: true, ...over["clarify"] };
    if (nodeId === "escalate") return { brief: "Case file: customer asks order status; KB weak; recommend human reply.", kb_gap: "none", ...over["escalate"] };
    return { result: "composed" };
  };
  const think: CapabilityPlugin = { name: "think", sideEffect: "read", estimateCents: () => 50, async invoke(c: EffectCall) { return { output: thinkOut(c.nodeId), claimedCostCents: 50 }; } };
  const compose: CapabilityPlugin = { name: "compose", sideEffect: "read", estimateCents: () => 35, async invoke(c: EffectCall) { return { output: composeOut(c.nodeId), claimedCostCents: 35 }; } };
  const ragOut = over["retrieve"] ?? { ok: true, hits: 3, top_score: "0.81", top_score_pct: 81, sources: "handbook", body: "[1] (source: handbook) Orders ship in 1 day." };
  const ragSearch: CapabilityPlugin = { name: "rag.search", sideEffect: "read", estimateCents: () => 15, async invoke() { return { output: ragOut, claimedCostCents: 15 }; } };
  const route: CapabilityPlugin = { name: "llm_route", sideEffect: "read", estimateCents: () => 20, async invoke() { return { output: over["route"] ?? { chosen_node: "resolve", reason: "grounded informational answer" }, claimedCostCents: 20 }; } };
  const recall: CapabilityPlugin = { name: "recall", sideEffect: "read", estimateCents: () => 5, async invoke() { return { output: { "recall.last_topic": "" }, claimedCostCents: 5 }; } };
  const remember: CapabilityPlugin = { name: "remember", sideEffect: "write-reversible", estimateCents: () => 5, async invoke() { return { output: { ok: true }, claimedCostCents: 5 }; } };
  const email: CapabilityPlugin = { name: "email_send", sideEffect: "message-human", estimateCents: () => 5, async invoke() { return { output: { sent: true }, claimedCostCents: 5 }; } };
  const slack: CapabilityPlugin = { name: "slack_send", sideEffect: "message-human", estimateCents: () => 5, async invoke() { return { output: { sent: true }, claimedCostCents: 5 }; } };
  return new Map<string, CapabilityPlugin>([["think", think], ["compose", compose], ["rag.search", ragSearch], ["llm_route", route], ["recall", recall], ["remember", remember], ["email_send", email], ["slack_send", slack]]);
}

async function run(over: Record<string, Record<string, unknown>> = {}, approve: (c: EffectCall) => boolean = () => true) {
  const { ring, owner, supervisorSigner, store, now } = rig();
  const { supervisor } = Supervisor.create(plugins(over));
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 60, approve, initialState });
  const events = await store.read("t1");
  const seq = events.filter((e) => e.type === "NodeEntered").map((e) => (e.scope as { nodeId?: string }).nodeId);
  return { res, ring, store, events, seq };
}

test("support-agent v2 manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("support-agent v2 uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("support-agent v2: triage is the entry and classifies intent + sentiment + language", () => {
  assert.equal(manifest.entry, "triage", "front-door triage must be the entry node");
  const role = manifest.nodes.find((n) => n.id === "triage")!.role;
  for (const k of ["sentiment", "language", "category", "distress", "out_of_scope"]) {
    assert.match(role, new RegExp(k), `triage must classify ${k}`);
  }
});

test("support-agent v2: distress / out-of-scope hard-route to a human from the door", () => {
  const e = manifest.edges.find((x) => x.from === "triage" && x.to === "escalate");
  assert.ok(e?.when, "triage must escalate distress/out-of-scope");
  const j = JSON.stringify(e!.when);
  assert.match(j, /triage\.distress/);
  assert.match(j, /triage\.out_of_scope/);
});

test("support-agent v2: grounding tiers + FAIL-SAFE — answer (strong), clarify (weak), escalate (none/failed)", () => {
  const toAnswer = manifest.edges.find((x) => x.from === "retrieve" && x.to === "answer");
  const toClarify = manifest.edges.find((x) => x.from === "retrieve" && x.to === "clarify");
  const toEscalate = manifest.edges.find((x) => x.from === "retrieve" && x.to === "escalate");
  assert.ok(toAnswer?.when && toClarify?.when, "answer/clarify must be confidence-gated");
  // answer & clarify require a SUCCESSFUL retrieval (retrieve.ok) plus a score check.
  assert.match(JSON.stringify(toAnswer!.when), /retrieve\.ok/, "the answer branch must require a successful retrieval");
  assert.match(JSON.stringify(toClarify!.when), /top_score/, "the clarify branch must gate on the match score (weak grounding)");
  // escalate is the UNCONDITIONAL catch-all: zero hits OR a failed/empty retrieval falls through
  // to a human instead of silently completing the run (the live-run robustness fix).
  assert.ok(toEscalate && !toEscalate.when, "escalate must be the unconditional fail-safe fallback from retrieve");
});

test("support-agent v2: every terminal path flows through QA scoring then record", () => {
  // send_reply -> qa, notify_human -> qa, qa -> record
  assert.ok(manifest.edges.some((e) => e.from === "send_reply" && e.to === "qa"), "a resolved reply must be QA-scored");
  assert.ok(manifest.edges.some((e) => e.from === "notify_human" && e.to === "qa"), "an escalation must be QA-scored too");
  assert.ok(manifest.edges.some((e) => e.from === "qa" && e.to === "record"), "the QA score must be recorded to the ledger");
});

test("support-agent v2: escalation carries a pre-investigated case file + knowledge-gap note", () => {
  const role = manifest.nodes.find((n) => n.id === "escalate")!.role;
  assert.match(role, /case file|CASE FILE/i, "escalation must be a case file, not a cold transfer");
  assert.match(role, /kb_gap|knowledge-gap|KNOWLEDGE-GAP/i, "escalation must capture the knowledge-base gap");
});

test("support-agent v2: send + notify are human-gated; route is fail-closed", () => {
  assert.equal(manifest.nodes.find((n) => n.id === "send_reply")?.autonomy, "suggest");
  assert.equal(manifest.nodes.find((n) => n.id === "notify_human")?.autonomy, "suggest");
  assert.equal(String(manifest.seed?.["fallback"]), "escalate");
});

test("support-agent v2: RESOLVE path runs E2E (triage->answer->judge->route->send->qa->record); ledger verifies", async () => {
  const { res, ring, store, seq } = await run();
  assert.equal(res.status, "completed", `resolve path should complete, got ${res.status}`);
  assert.ok(verify(await store.read("t1"), ring).ok, "ledger must verify");
  for (const n of ["triage", "retrieve", "answer", "judge", "route", "send_reply", "qa", "record"]) {
    assert.ok(seq.includes(n), `resolve path must reach ${n}`);
  }
});

test("support-agent v2: WEAK grounding asks a clarifying question instead of guessing or escalating", async () => {
  const { res, seq } = await run({ retrieve: { ok: true, hits: 2, top_score: "0.35", top_score_pct: 35, sources: "handbook", body: "weakish" } });
  assert.equal(res.status, "completed", `clarify path should complete, got ${res.status}`);
  assert.ok(seq.includes("clarify"), "weak grounding must route to clarify");
  assert.ok(!seq.includes("answer"), "weak grounding must NOT draft a full answer");
  assert.ok(seq.includes("qa"), "even a clarification gets QA-scored");
});

test("support-agent v2: DISTRESS hard-escalates with a case file, no answering", async () => {
  const { res, seq } = await run({ triage: { distress: true, out_of_scope: false, category: "other", sentiment: "frustrated", language: "english", urgency: 95, asks: "help", needs_action: false, reason: "distress" } });
  assert.equal(res.status, "completed");
  assert.ok(seq.includes("escalate") && seq.includes("notify_human") && seq.includes("qa"), "distress -> escalate -> notify -> qa");
  assert.ok(!seq.includes("answer"), "a distressed customer must NOT be answered by the bot");
});

test("support-agent v2: zero grounding escalates instead of guessing", async () => {
  const { res, seq } = await run({ retrieve: { ok: true, hits: 0, top_score: "0", top_score_pct: 0, sources: "", body: "" } });
  assert.equal(res.status, "completed");
  assert.ok(seq.includes("escalate"), "no grounding must escalate");
  assert.ok(!seq.includes("answer") && !seq.includes("clarify"), "with zero grounding the bot must not answer or clarify");
});
