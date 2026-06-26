/**
 * Guards the shipped daily-digest template. The manifest must always validate, declare
 * only real built-in capabilities, branch correctly on the ranked item count, and run
 * end-to-end through the real Engine against fake plugins with a verifiable ledger.
 * If someone edits the JSON and breaks any of that, this fails before a user installs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { Supervisor, type CapabilityPlugin } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "daily-digest.manifest.json"), "utf8")) as Manifest;

// Real built-in capabilities (registered in runtime.ts). Anything outside this set is a bug.
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

/** A plugin that returns a fixed output (so edge conditions can be exercised). */
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

test("daily-digest manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("daily-digest uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("daily-digest is a scheduled, self-running agent (cron)", () => {
  assert.ok(manifest.schedule, "template must carry a schedule so it runs itself");
  assert.equal(manifest.schedule!.kind, "cron");
});

test("daily-digest only posts to Slack when there is something new (conditional edge)", () => {
  const formatEdge = manifest.edges.find((e) => e.to === "format");
  assert.ok(formatEdge, "there must be an edge into the format node");
  assert.ok(formatEdge!.when, "the format edge MUST be conditional (only post when item_count >= 1)");
  const json = JSON.stringify(formatEdge!.when);
  assert.match(json, /"key":"rank\.item_count"/, "post gate must compare the ranked item count");
});

test("daily-digest always persists the baseline (remember reached on every path)", () => {
  const fromRank = manifest.edges.filter((e) => e.from === "rank").map((e) => e.to);
  assert.ok(fromRank.includes("remember"), "rank must have an unconditional edge to remember");
  const fromPost = manifest.edges.filter((e) => e.from === "post").map((e) => e.to);
  assert.ok(fromPost.includes("remember"), "post must continue to remember");
});

test("daily-digest runs end-to-end through the Engine with a verifiable ledger", async () => {
  const r = rig();

  // Register a fake plugin for every capability the manifest uses, returning plausible
  // outputs so the rank→format gate (item_count >= 1) is actually taken.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 5, { last_top: "Yesterday's lead story" }));
  plugins.set("http_get", outputPlugin("http_get", "read", 3, { body: "Source A and B headlines and article text..." }));
  plugins.set("think", outputPlugin("think", "read", 50, {
    digest: "• New release ships today\n• Funding round closes\n• Big outage post-mortem",
    top_item: "New release ships today",
    item_count: 3,
  }));
  plugins.set("compose", outputPlugin("compose", "read", 15, { message: "Good morning! Today's lead: New release ships today\n• ..." }));
  plugins.set("slack_send", outputPlugin("slack_send", "message-human", 1, { ok: true, ts: "1700000000.000100" }));
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
  // The 'post' node is autonomy "suggest" (message-human) → it parks for approval.
  // Approve it so the digest is sent and the run completes.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The conditional edge was taken: think output (item_count=3) routed through format.
  assert.equal(res.projection.state["rank.item_count"], 3, "ranked item count must be in run state");
  assert.equal(res.projection.state["rank.top_item"], "New release ships today", "top item must be in run state");

  // The signed ledger for this run verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});