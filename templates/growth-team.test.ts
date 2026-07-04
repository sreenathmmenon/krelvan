/**
 * The Autonomous Growth Team — a multi-specialist agentic marketing system.
 * A team of specialist steps (brand analyst -> market researcher -> SEO strategist ->
 * content lead -> outreach specialist -> AI-visibility analyst -> head of growth) runs
 * end-to-end, produces a prioritized growth plan and ready-to-ship content, and PAUSES
 * for human approval before anything is published. Proves: the whole team runs in order,
 * the publish step is human-gated, denying blocks the public post, and the signed ledger
 * verifies. Fake plugins (no real network) — orchestration + gate + ledger under test.
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
const manifest = JSON.parse(readFileSync(join(here, "growth-team.manifest.json"), "utf8")) as Manifest;

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

function plugins(): Map<string, CapabilityPlugin> {
  const out: Record<string, Record<string, unknown>> = {
    study_site: { product: "A governed agentic execution platform", positioning: "own your agents", signals: "self-hosted; signed runs; 7 providers" },
    market_research: { findings: "buyers want trust + control", themes: "governance, autonomy, proof", angle: "agents you can finally let do more" },
    seo_audit: { keyword_gaps: "governed agents; agent audit trail", content_priorities: "1) provable agents guide", quick_wins: "add FAQ schema" },
    draft_content: { article: "Provable Agents: a guide", social: "post A / post B", why: "highest-intent topic" },
    prospect_outreach: { targets: "eng-leader communities; AI-infra newsletters", outreach_draft: "Hi — saw you care about agent reliability…" },
    ai_visibility: { likely_prompts: "what's the safest agent platform?", gaps: "not cited yet", actions: "publish comparison + docs" },
    growth_plan: { result: "This week: ship the provable-agents guide, post A+B, reach 3 communities. Backlog: comparison page.", summary: "Ship one flagship piece and seed it in 3 communities this week." },
    publish: { announced: true },
    remember_cycle: { ok: true },
  };
  const mk = (name: string, se: CapabilityPlugin["sideEffect"], cents: number): CapabilityPlugin => ({
    name, sideEffect: se, estimateCents: () => cents,
    async invoke(c: EffectCall) { return { output: out[c.nodeId] ?? { result: "ok" }, claimedCostCents: cents }; },
  });
  return new Map<string, CapabilityPlugin>([
    ["http_get", mk("http_get", "read", 8)],
    ["web_search", mk("web_search", "read", 40)],
    ["think", mk("think", "read", 60)],
    ["compose", mk("compose", "read", 100)],
    ["notify_webhook", mk("notify_webhook", "message-human", 5)],
    ["remember", mk("remember", "write-reversible", 5)],
  ]);
}

async function run(approve: (c: EffectCall) => boolean) {
  const { ring, owner, supervisorSigner, store, now } = rig();
  const { supervisor } = Supervisor.create(plugins());
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 80, approve, initialState });
  const events = await store.read("t1");
  const seq = events.filter((e) => e.type === "NodeEntered").map((e) => (e.scope as { nodeId?: string }).nodeId);
  return { res, ring, store, seq };
}

test("growth-team validates; publish is the only human-gated step", () => {
  assert.deepEqual(validateManifest(manifest), []);
  const publish = manifest.nodes.find((n) => n.id === "publish")!;
  assert.equal(publish.autonomy, "suggest", "publish must be approval-gated");
  assert.equal(publish.capabilities[0]!.sideEffect, "message-human");
  // every research/strategy/drafting step runs autonomously (full) — the team works, the human only gates the send
  for (const id of ["study_site", "market_research", "seo_audit", "draft_content", "prospect_outreach", "ai_visibility", "growth_plan"]) {
    assert.equal(manifest.nodes.find((n) => n.id === id)!.autonomy, "full", `${id} should run autonomously`);
  }
});

test("APPROVE: the whole team runs in order, produces a plan, publishes; ledger verifies", async () => {
  const { res, ring, store, seq } = await run(() => true);
  assert.equal(res.status, "completed", `expected completed, got ${res.status} ${res.reason ?? ""}`);
  assert.deepEqual(seq, [
    "study_site", "market_research", "seo_audit", "draft_content",
    "prospect_outreach", "ai_visibility", "growth_plan", "publish", "remember_cycle",
  ], "the full specialist chain must run in order");
  assert.ok(String(res.projection.state["growth_plan.result"] ?? "").length > 0, "a growth plan must be produced");
  assert.equal(res.projection.state["publish.announced"], true, "approved content is published");
  assert.ok(verify(await store.read("t1"), ring).ok, "the signed ledger of the whole team must verify");
});

test("DENY: the team still does all its work, but nothing is published without approval", async () => {
  const { res, ring, store, seq } = await run((c) => c.capability !== "notify_webhook");
  // all the research/strategy/drafting happened...
  assert.ok(seq.includes("growth_plan"), "the team produced its plan even when publishing is denied");
  assert.ok(String(res.projection.state["growth_plan.result"] ?? "").length > 0, "the plan is still produced for review");
  // ...but the public announcement did NOT go out
  assert.notEqual(res.status, "completed", "a denied publish must not complete as if it posted");
  assert.equal(res.projection.state["publish.announced"], undefined, "NOTHING was published without approval");
  assert.ok(verify(await store.read("t1"), ring).ok, "the partial signed ledger still verifies");
});
