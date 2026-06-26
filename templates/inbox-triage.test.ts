/**
 * Guards the shipped inbox-triage template. The manifest must always validate, declare
 * only real built-in capabilities, and keep its approval-gated send path well-formed.
 * Beyond structure, this DRIVES THE ENGINE END-TO-END with fake plugins so the real
 * branching (reply vs archive) and the human-approval gate on `send` are exercised, and
 * the resulting ledger verifies. If an edit breaks any of this, it fails before a user.
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
const manifest = JSON.parse(readFileSync(join(here, "inbox-triage.manifest.json"), "utf8")) as Manifest;

// Every capability the template uses must be a real built-in.
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

// ── deterministic test rig (mirrors src/core/kernel/kernel.test.ts) ───────────────
function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A plugin that returns a fixed output object (so edge conditions can be exercised). */
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

test("inbox-triage manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("inbox-triage uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("inbox-triage gates the send node behind human approval (autonomy 'suggest')", () => {
  const send = manifest.nodes.find((n) => n.id === "send");
  assert.ok(send, "there must be a send node");
  assert.equal(send!.autonomy, "suggest", "send must require approval before any message leaves");
  assert.ok(send!.capabilities.some((c) => c.sideEffect === "message-human"), "send must message a human");
});

test("inbox-triage branches deterministically on the classifier's should_reply", () => {
  // Routing is purely deterministic: the classify node's structured output gates the
  // branch directly (no redundant llm_route node). The two branch edges leave `classify`.
  const fromClassify = manifest.edges.filter((e) => e.from === "classify");
  assert.equal(fromClassify.length, 2, "classify must branch to exactly draft and archive");
  for (const e of fromClassify) {
    assert.ok(e.when, "every branch edge must be conditional");
    assert.match(JSON.stringify(e.when), /"key":"classify\.should_reply"/, "branch gate must read classify.should_reply");
  }
  assert.ok(fromClassify.some((e) => e.to === "draft"), "classify must be able to reach draft");
  assert.ok(fromClassify.some((e) => e.to === "archive"), "classify must be able to reach archive");
  // The redundant llm_route routing node has been removed.
  assert.ok(!manifest.nodes.some((n) => n.id === "route"), "the redundant route node must be gone");
});

// Build a fully-wired engine with fake plugins. `replyPath` controls the classifier
// output so we can drive BOTH branches end-to-end.
function buildEngine(replyPath: boolean) {
  const r = rig();
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("recall", outputPlugin("recall", "read", 5, { last_contact: "sales" }));
  plugins.set("think", outputPlugin("think", "read", 60, replyPath
    ? { category: "sales", urgency: 80, should_reply: true, reason: "A real prospect is awaiting our reply." }
    : { category: "newsletter", urgency: 0, should_reply: false, reason: "Automated newsletter — no reply needed." }));
  plugins.set("compose", outputPlugin("compose", "read", 30, {
    subject: "Re: Following up on the proposal",
    reply: "Hi Jordan — thanks for the nudge. I'm reviewing the proposal now and will come back to you this week with next steps. — Sam",
  }));
  plugins.set("email_send", outputPlugin("email_send", "message-human", 5, { sent: true, message_id: "msg-1" }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { ok: true }));

  const supervisor = new Supervisor(plugins);
  const engine = new Engine(manifest, "t1", "r1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
  });
  return { engine, ...r };
}

test("inbox-triage drives end-to-end on the REPLY path with human approval; ledger verifies", async () => {
  const { engine, store, ring } = buildEngine(true);
  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // The send node is 'suggest' → it pauses for approval. Approve it so the reply sends.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });
  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // Reply path was taken: the drafted reply made it into run state.
  assert.equal(res.projection.state["draft.subject"], "Re: Following up on the proposal");
  assert.equal(res.projection.state["send.sent"], true, "the approved reply was sent");

  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

test("inbox-triage drives end-to-end on the ARCHIVE path (no reply, nothing sent); ledger verifies", async () => {
  const { engine, store, ring } = buildEngine(false);
  // No 'suggest' node is reached on this path, so no approval is needed; deny anyway to
  // prove nothing on the archive path depends on approval.
  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const res = await engine.run({ maxSteps: 50, approve: () => false, initialState });
  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // Archive path: the classifier said newsletter → no email was ever sent.
  assert.equal(res.projection.state["send.sent"], undefined, "nothing should be sent on the archive path");
  assert.equal(res.projection.state["classify.category"], "newsletter");

  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});