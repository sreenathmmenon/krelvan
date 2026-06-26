/**
 * Guards the shipped competitive-intel template. The manifest must always validate,
 * declare only real built-in capabilities, keep the LLM-routed deep-dive edge well-formed,
 * and — most importantly — actually RUN end-to-end through the engine with fake plugins so
 * the branching, scheduling, and signed-ledger guarantees are proven, not just asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { Supervisor, type CapabilityPlugin } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "competitive-intel.manifest.json"), "utf8")) as Manifest;

// The full set of REAL built-in capability names (registered in runtime.ts), including
// the RAG/wiki/sub-agent names. Anything outside this set would not resolve at run time.
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook", "text_transform",
  "email_send", "telegram_send", "slack_send",
  "delegate", "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
]);

// ── deterministic test rig (mirrors src/core/kernel/kernel.test.ts) ──────────────
function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A plugin that returns a fixed output object (mirrors kernel.test.ts outputPlugin). */
function outputPlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, output: Record<string, unknown>): CapabilityPlugin {
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      return { output, claimedCostCents: cost };
    },
  };
}

// ── structural guards ────────────────────────────────────────────────────────────

test("competitive-intel manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map(i => i.message).join("; ")}`);
});

test("competitive-intel uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("competitive-intel runs daily on a cron schedule", () => {
  assert.ok(manifest.schedule, "template must carry a schedule");
  assert.equal(manifest.schedule!.kind, "cron");
});

test("competitive-intel gates the deep dive on a deterministic LLM-extracted flag", () => {
  const deepEdge = manifest.edges.find(e => e.to === "deep_dive");
  assert.ok(deepEdge, "there must be an edge into the deep_dive node");
  assert.ok(deepEdge!.when, "the deep_dive edge MUST be conditional (only research material changes)");
  const json = JSON.stringify(deepEdge!.when);
  assert.match(json, /"key":"extract\.needs_deep_dive"/, "deep-dive gate must read the extracted needs_deep_dive flag");
  // Routing is deterministic from the extract node's structured output — the two branch
  // edges leave `extract` directly (the redundant llm_route routing node was removed).
  const fromExtract = manifest.edges.filter(e => e.from === "extract").map(e => e.to);
  assert.ok(fromExtract.includes("digest"), "extract must have a skip edge straight to digest");
  assert.ok(fromExtract.includes("deep_dive"), "extract must have a deep-dive edge");
  assert.ok(!manifest.nodes.some(n => n.id === "route"), "the redundant route node must be gone");
});

// ── engine: full end-to-end run with fake plugins ─────────────────────────────────

/** Build a Supervisor whose plugins return plausible outputs for every used capability. */
function pluginsForRun(needsDeepDive: boolean): Map<string, CapabilityPlugin> {
  const p = new Map<string, CapabilityPlugin>();
  // fetch → http_get: returns page text (string output, namespaced under fetch.result)
  p.set("http_get", outputPlugin("http_get", "read", 3, { body: "Pro plan is now $49/mo (was $39)." }));
  // extract → think: emits the routing flags the deep-dive edge gates on
  p.set("think", outputPlugin("think", "read", 50, {
    signal: "Pro plan price increased from $39 to $49.",
    changed: true,
    needs_deep_dive: needsDeepDive,
    // deep_think reuses the same 'think' plugin; its synthesis key rides along harmlessly.
    deep_findings: "Competitors raised prices industry-wide this quarter; modest churn risk.",
  }));
  // deep_dive → web_search
  p.set("web_search", outputPlugin("web_search", "read", 8, { body: "Several SaaS vendors raised prices in Q2." }));
  // digest → compose
  p.set("compose", outputPlugin("compose", "read", 15, { result: "Intel: Pro plan +$10/mo. Market-wide trend. Watch churn." }));
  // notify → notify_webhook (write-reversible, suggest autonomy → parks for approval)
  p.set("notify_webhook", outputPlugin("notify_webhook", "write-reversible", 2, { delivered: true }));
  return p;
}

function engineFor(needsDeepDive: boolean) {
  const r = rig();
  const supervisor = new Supervisor(pluginsForRun(needsDeepDive));
  const engine = new Engine(manifest, "t1", "r1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
  });
  return { engine, ...r };
}

test("competitive-intel: a MATERIAL change drives the deep-dive branch end-to-end and the ledger verifies", async () => {
  const { engine, store, ring } = engineFor(true);
  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // notify is a 'suggest' node with a write effect → it parks for approval; approve it.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });
  assert.equal(res.status, "completed", res.reason ?? "");

  // The deep-dive branch must have produced its synthesis in run state.
  assert.equal(res.projection.state["extract.needs_deep_dive"], true, "router flag must be in state");
  assert.equal(res.projection.state["deep_think.deep_findings"], "Competitors raised prices industry-wide this quarter; modest churn risk.", "deep_think must have run");

  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

test("competitive-intel: a MINOR change skips the deep dive but still digests + notifies, and the ledger verifies", async () => {
  const { engine, store, ring } = engineFor(false);
  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });
  assert.equal(res.status, "completed", res.reason ?? "");

  // Skip path: deep_think never ran, so its output key must be absent from state.
  assert.equal(res.projection.state["extract.needs_deep_dive"], false, "router flag must be false");
  assert.equal(res.projection.state["deep_think.deep_findings"], undefined, "deep_think must NOT run on the skip path");

  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});