/**
 * Guards the shipped content-repurposer template: its manifest must always validate,
 * declare only real built-in capabilities, and — driven end-to-end through the real
 * Engine with fake plugins — branch correctly (extract -> two compose formats -> queue)
 * and produce a ledger that verifies. If someone edits the JSON and breaks any of this,
 * the test fails before it ever reaches a user.
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
const manifest = JSON.parse(
  readFileSync(join(here, "content-repurposer.manifest.json"), "utf8"),
) as Manifest;

// The capabilities the template uses must all be real built-ins (registered in runtime.ts).
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook", "text_transform",
  "email_send", "telegram_send", "slack_send",
  "delegate", "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
]);

// ── deterministic test rig (mirrors src/core/kernel/kernel.test.ts) ─────────────
function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A plugin that returns a specific output (for testing run state propagation). */
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

test("content-repurposer manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("content-repurposer uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("content-repurposer has the conditional branch into compose_short (only writes when a core message was extracted)", () => {
  const edge = manifest.edges.find((e) => e.to === "compose_short");
  assert.ok(edge, "there must be an edge into compose_short");
  assert.ok(edge!.when, "the compose_short edge MUST be conditional (only proceed when extract found a core message)");
  const json = JSON.stringify(edge!.when);
  assert.match(json, /"key":"extract\.ready"/, "branch must gate on extract.ready");
  assert.match(json, /"key":"extract\.core"/, "branch must check extract.core is non-empty");
});

test("content-repurposer produces two distinct formats from one source (two compose nodes -> queue)", () => {
  const composeNodes = manifest.nodes.filter((n) => n.capabilities.some((c) => c.name === "compose"));
  assert.equal(composeNodes.length, 2, "there must be exactly two compose (multi-format) nodes");
  const fromShort = manifest.edges.filter((e) => e.from === "compose_short").map((e) => e.to);
  assert.ok(fromShort.includes("compose_thread"), "short-form must feed the thread writer");
  const fromThread = manifest.edges.filter((e) => e.from === "compose_thread").map((e) => e.to);
  assert.ok(fromThread.includes("queue"), "thread must feed the publishing queue");
});

test("content-repurposer gates the publish (queue node requires human approval)", () => {
  const queue = manifest.nodes.find((n) => n.id === "queue");
  assert.ok(queue, "there must be a queue node");
  assert.equal(queue!.autonomy, "suggest", "pushing to the publishing queue must pause for human approval");
});

test("content-repurposer runs end-to-end through the real Engine and the ledger verifies", async () => {
  // Build fake plugins for EVERY capability the manifest uses, returning plausible
  // outputs so the conditional branch is actually exercised.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 5, { brand_voice: "punchy, plainspoken, no jargon" }));
  // extract.ready=1 and a non-empty extract.core → the conditional edge into compose_short is taken.
  plugins.set("think", outputPlugin("think", "read", 50, { core: "Ship small, ship often.", angles: "fear of big bang | speed compounds", ready: 1 }));
  plugins.set("compose", outputPlugin("compose", "read", 15, { result: "Stop hoarding the release. Ship small, ship often — momentum is the moat." }));
  plugins.set("notify_webhook", outputPlugin("notify_webhook", "write-reversible", 5, { ok: true, queued: true }));

  const r = rig();
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
  // The queue node is "suggest" (write-reversible) → it parks for approval; approve it so the run completes.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });
  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The branch was taken: extract surfaced a core message into run state.
  assert.equal(res.projection.state["extract.ready"], 1, "extract.ready must be in run state");
  assert.equal(res.projection.state["extract.core"], "Ship small, ship often.", "extract.core must flow into run state");

  // The signed ledger verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});
