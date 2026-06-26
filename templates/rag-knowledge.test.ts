/**
 * Guards the shipped self-improving RAG template. The manifest must always validate,
 * declare only real built-in capabilities, and keep the knowledge-gap branch well-formed.
 * Beyond the structural checks, this test DRIVES THE REAL ENGINE end-to-end with fake
 * plugins (no LLM, no network) and proves the run completes and the signed ledger verifies.
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
const manifest = JSON.parse(readFileSync(join(here, "rag-knowledge.manifest.json"), "utf8")) as Manifest;

// The capabilities this template uses must all be real built-ins (registered in runtime.ts).
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
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

/** A plugin that returns a fixed output (mirrors outputPlugin in kernel.test.ts). */
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
test("rag-knowledge manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map(i => i.message).join("; ")}`);
});

test("rag-knowledge uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("rag-knowledge has the knowledge-gap branch (web_search + rag.ingest gated on reason.gap)", () => {
  const gapEdge = manifest.edges.find(e => e.from === "reason" && e.to === "gap_search");
  assert.ok(gapEdge, "there must be an edge from reason into gap_search");
  assert.ok(gapEdge!.when, "the gap edge MUST be conditional (only learn when the KB has a gap)");
  const json = JSON.stringify(gapEdge!.when);
  assert.match(json, /"key":"reason\.gap"/, "gap gate must read the analyst's reason.gap flag");
  // The self-improvement path must actually ingest learned info back into the KB.
  const learn = manifest.nodes.find(n => n.id === "learn");
  assert.ok(learn?.capabilities.some(c => c.name === "rag.ingest"), "learn node must ingest into the KB");
});

test("rag-knowledge always reaches compose_answer then save on every path", () => {
  // No-gap path: reason → compose_answer. Gap path: reanswer → compose_answer.
  const intoCompose = manifest.edges.filter(e => e.to === "compose_answer").map(e => e.from);
  assert.ok(intoCompose.includes("reason"), "no-gap path must reach compose_answer from reason");
  assert.ok(intoCompose.includes("reanswer"), "gap path must reach compose_answer from reanswer");
  const fromCompose = manifest.edges.filter(e => e.from === "compose_answer").map(e => e.to);
  assert.ok(fromCompose.includes("save"), "compose_answer must continue to save");
});

// ── engine: full end-to-end run with fake plugins ────────────────────────────────
test("rag-knowledge drives the engine end-to-end, completes, and the ledger verifies", async () => {
  const r = rig();

  // Register a fake plugin for EVERY capability the manifest uses. Outputs are plausible
  // so the gap edge (reason.gap === true) can be exercised — here we return gap:false so
  // the agent takes the grounded path: recall_ctx → search_kb → reason → compose_answer → save.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 1, { "recall.last_answer": "", "recall.episode_count": 0 }));
  plugins.set("rag.search", outputPlugin("rag.search", "read", 10, { body: "[1] (source: handbook) Enterprise refunds are honored within 30 days of invoice.", hits: 1 }));
  plugins.set("think", outputPlugin("think", "read", 50, { result: "Enterprise customers have a 30-day refund window.", grounded: true, gap: false, gap_topic: "" }));
  plugins.set("web_search", outputPlugin("web_search", "read", 8, { body: "Web result about refund windows.", results: 3 }));
  plugins.set("rag.ingest", outputPlugin("rag.ingest", "write-reversible", 20, { ingested: 1, ok: true }));
  plugins.set("compose", outputPlugin("compose", "read", 12, { result: "Your enterprise refund window is 30 days from the invoice date." }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { remembered: true, factsUpdated: 1 }));

  const supervisor = new Supervisor(plugins);
  const engine = new Engine(manifest, "t1", "r1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
  });

  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // act-with-veto only gates irreversible/spend/identity; the reversible rag.ingest runs
  // autonomously, so approving everything is safe and the run completes without parking.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });
  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The grounded (no-gap) path was taken: the analyst's gap flag is in run state and false.
  assert.equal(res.projection.state["reason.gap"], false, "reason.gap must be false on the grounded path");
  // The final composed answer flowed through to run state.
  assert.equal(typeof res.projection.state["compose_answer.result"], "string", "final answer must be in run state");

  // The signed ledger for the run verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});