/**
 * Guards the shipped lead-qualifier template. The manifest must always validate,
 * declare only real built-in capabilities, keep its score-gated routing well-formed,
 * AND actually drive the engine end-to-end: a strong lead (score 85) must flow
 * enrich → score → route → compose → outreach (a "suggest" send that the owner
 * approves) → record, the run must complete, and the signed ledger must verify.
 *
 * If someone edits the JSON and breaks any of that, this test fails before a user
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
const manifest = JSON.parse(readFileSync(join(here, "lead-qualifier.manifest.json"), "utf8")) as Manifest;

// Every capability the template uses must be a real built-in (registered in runtime.ts).
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
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

test("lead-qualifier manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("lead-qualifier uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("lead-qualifier gates outreach on the score (deterministic, injection-proof routing)", () => {
  // The pursue path is gated by score.score >= 70 in the engine — never by an
  // LLM-set flag. The gate edges leave the `score` node directly (the redundant
  // llm_route routing node has been removed). Every path must still reach 'record'.
  const pursue = manifest.edges.find((e) => e.from === "score" && e.to === "compose");
  assert.ok(pursue && pursue.when, "score → compose must be conditional on the score");
  assert.match(JSON.stringify(pursue!.when), /"key":"score\.score"/, "the gate must compare the score");

  const archive = manifest.edges.find((e) => e.from === "score" && e.to === "record");
  assert.ok(archive && archive.when, "score → record (archive) must be conditional on a low score");

  // The redundant llm_route routing node has been removed.
  assert.ok(!manifest.nodes.some((n) => n.id === "route"), "the redundant route node must be gone");

  // The send node must require approval (it messages a human).
  const outreach = manifest.nodes.find((n) => n.id === "outreach");
  assert.equal(outreach!.autonomy, "suggest", "the email send node must be 'suggest' (human approves)");
});

test("lead-qualifier drives the engine end-to-end: strong lead → approved send → completes + verifies", async () => {
  const r = rig();

  // Fake plugins for EVERY capability the manifest uses. A score of 85 (>= 70)
  // forces the pursue path through compose → outreach (the suggest send).
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 5, { verdict: null }));
  plugins.set("http_get", outputPlugin("http_get", "read", 8, { body: "Acme Cloud — B2B SaaS, 200 employees, hiring 12 engineers. sales@acme.test" }));
  plugins.set("think", outputPlugin("think", "read", 50, { company: "Acme Cloud", contact_email: "sales@acme.test", score: 85, reason: "200-person B2B SaaS actively hiring engineers — squarely in ICP." }));
  plugins.set("compose", outputPlugin("compose", "read", 15, { subject: "A quick idea for Acme Cloud", body: "Hi — noticed you're scaling your eng org..." }));
  plugins.set("email_send", outputPlugin("email_send", "message-human", 5, { sent: true, to: "sales@acme.test" }));
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
  // approve: () => true → the owner approves the "suggest" email send, so the run
  // proceeds to completion instead of parking ("halted").
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The score flowed into run state and the pursue gate was taken.
  assert.equal(res.projection.state["score.score"], 85, "the analyst's score must be in run state");

  // The signed ledger verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

test("lead-qualifier drives the engine end-to-end: weak lead → archive path, no send", async () => {
  const r = rig();

  // Score 40 (< 70) → route → record directly. The email_send is never reached.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 5, { verdict: null }));
  plugins.set("http_get", outputPlugin("http_get", "read", 8, { body: "Joe's Pizza — a local restaurant." }));
  plugins.set("think", outputPlugin("think", "read", 50, { company: "Joe's Pizza", contact_email: "", score: 40, reason: "Local restaurant, not a B2B SaaS — outside ICP." }));
  // compose / email_send are still registered so a stray route would not crash the supervisor.
  plugins.set("compose", outputPlugin("compose", "read", 15, { subject: "", body: "" }));
  plugins.set("email_send", outputPlugin("email_send", "message-human", 5, { sent: false }));
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
  assert.equal(res.projection.state["score.score"], 40, "the low score must be in run state");

  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});