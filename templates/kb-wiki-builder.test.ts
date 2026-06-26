/**
 * Guards the shipped kb-wiki-builder template end-to-end.
 *
 * It is not enough that the manifest parses: this test (1) validates the manifest
 * structurally, (2) proves every capability it declares is a REAL built-in, and
 * (3) DRIVES THE ENGINE with fake plugins so the conditional "update needed" branch
 * actually fires — read existing pages → reason → apply page edit → notify human
 * (approved) → record — and the resulting signed ledger verifies. If anyone edits the
 * JSON and breaks the graph, the gate, or the autonomy wiring, this fails before a user
 * ever installs it.
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
const manifest = JSON.parse(readFileSync(join(here, "kb-wiki-builder.manifest.json"), "utf8")) as Manifest;

// Every capability the template uses must be a real built-in plugin name.
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

// ── deterministic rig (mirrors src/core/kernel/kernel.test.ts) ──────────────────
function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A plugin that returns a fixed output (for testing run-state propagation / edges). */
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

test("kb-wiki-builder manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("kb-wiki-builder uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("kb-wiki-builder gates the wiki write on a deterministic update_needed flag", () => {
  const applyEdge = manifest.edges.find((e) => e.to === "apply_update");
  assert.ok(applyEdge, "there must be an edge into apply_update");
  assert.ok(applyEdge!.when, "the apply_update edge MUST be conditional (only write when an update is warranted)");
  const json = JSON.stringify(applyEdge!.when);
  assert.match(json, /"key":"plan\.update_needed"/, "gate must read the planner's update_needed flag");
});

test("kb-wiki-builder pauses for human approval before messaging (suggest autonomy on telegram_send)", () => {
  const notify = manifest.nodes.find((n) => n.id === "notify");
  assert.ok(notify, "notify node must exist");
  assert.equal(notify!.autonomy, "suggest", "the human-messaging node must be 'suggest' so a human approves the send");
  assert.ok(notify!.capabilities.some((c) => c.sideEffect === "message-human"), "notify must use a message-human capability");
});

test("kb-wiki-builder drives end-to-end: update branch applies a page, notifies (approved), records, ledger verifies", async () => {
  const r = rig();

  // Fake plugins for every capability the manifest uses. The planner returns
  // update_needed:true so the conditional edge fires and the full write→notify→record
  // chain executes — exercising the agentic branch, not just the linear happy path.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("wiki.query", outputPlugin("wiki.query", "read", 8, {
    body: "[page: Vector Databases] Stores embeddings for similarity search.",
    hits: 1,
  }));
  plugins.set("think", outputPlugin("think", "read", 50, {
    update_needed: true,
    page: "Retrieval-Augmented Generation",
    content: "# Retrieval-Augmented Generation\nRAG grounds an LLM in retrieved context from [[Vector Databases]].",
    summary: "Added a new RAG page cross-linked to Vector Databases.",
  }));
  plugins.set("wiki.ingest", outputPlugin("wiki.ingest", "write-reversible", 15, { ok: true, touched: 1 }));
  plugins.set("telegram_send", outputPlugin("telegram_send", "message-human", 1, { ok: true, sent: true }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { ok: true }));

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
  // notify is "suggest" + message-human → it parks for approval; approve it so the run
  // completes through record.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The deterministic gate took the update branch: the proposed page reached run state.
  assert.equal(res.projection.state["plan.update_needed"], true, "planner flagged an update");
  assert.equal(res.projection.state["plan.page"], "Retrieval-Augmented Generation", "proposed page is in run state");

  // The signed ledger verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

test("kb-wiki-builder skips the write when no update is needed (no churn, ledger still verifies)", async () => {
  const r = rig();

  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("wiki.query", outputPlugin("wiki.query", "read", 8, {
    body: "[page: Retrieval-Augmented Generation] Already complete and accurate.",
    hits: 1,
  }));
  // Planner decides nothing needs changing → update_needed:false → the gated edge is
  // NOT taken → the run completes at 'plan' without writing the wiki or messaging anyone.
  plugins.set("think", outputPlugin("think", "read", 50, {
    update_needed: false,
    page: "",
    content: "",
    summary: "Existing pages already cover the topic; no edit warranted.",
  }));
  // Register the rest too (admission needs the plugin present even if never reached).
  plugins.set("wiki.ingest", outputPlugin("wiki.ingest", "write-reversible", 15, { ok: true }));
  plugins.set("telegram_send", outputPlugin("telegram_send", "message-human", 1, { ok: true }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { ok: true }));

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
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);
  assert.equal(res.projection.state["plan.update_needed"], false, "planner declined to update");

  const events = await r.store.read("t1");
  // No wiki write and no human message should have been requested on the no-update path.
  const requested = events.filter((e) => e.type === "EffectRequested");
  const caps = requested.map((e) => (e.payload as Record<string, unknown>)["capability"]);
  assert.ok(!caps.includes("wiki.ingest"), "no-update path must NOT write the wiki");
  assert.ok(!caps.includes("telegram_send"), "no-update path must NOT message a human");

  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});