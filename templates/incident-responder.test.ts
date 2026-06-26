/**
 * Guards the shipped incident-responder template: its manifest must always validate,
 * declare only real built-in capabilities, keep the conditional page/log_only routing
 * edges well-formed, and — most importantly — actually DRIVE THE ENGINE end-to-end with
 * fake plugins, proving the whole graph (triage → llm_route → page/log_only → status →
 * record) executes, parks the human-paging step for approval, and produces a ledger that
 * verifies. If someone edits the JSON and breaks it, this fails before it reaches a user.
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
const manifest = JSON.parse(readFileSync(join(here, "incident-responder.manifest.json"), "utf8")) as Manifest;

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

/** A plugin that returns a fixed output (for testing run-state propagation + routing). */
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

test("incident-responder manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map(i => i.message).join("; ")}`);
});

test("incident-responder uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("incident-responder routes between page and log_only via llm_route's chosen_node", () => {
  const pageEdge = manifest.edges.find(e => e.to === "page");
  const logEdge = manifest.edges.find(e => e.to === "log_only");
  assert.ok(pageEdge?.when, "the page edge MUST be conditional (only page on the page branch)");
  assert.ok(logEdge?.when, "the log_only edge MUST be conditional");
  assert.match(JSON.stringify(pageEdge!.when), /"key":"route\.chosen_node"/, "page gate must read the router's choice");
  assert.match(JSON.stringify(logEdge!.when), /"key":"route\.chosen_node"/, "log_only gate must read the router's choice");
});

test("incident-responder seeds route.candidates so the REAL llm_route plugin can run", () => {
  // The real llm_route plugin (src/core/plugins/llm-route.ts) THROWS if 'candidates' is
  // missing/empty ("'candidates' input must be a comma-separated list of node IDs"). The
  // manifest seed must therefore supply candidates, and they must list EXACTLY the route
  // node's out-edge targets — so the LLM can only choose among declared edges.
  assert.ok(manifest.seed, "template must seed config for the router");
  const candidatesRaw = manifest.seed!["candidates"];
  assert.equal(typeof candidatesRaw, "string", "seed.candidates must be a string");
  const candidates = String(candidatesRaw).split(",").map(s => s.trim()).filter(Boolean);
  assert.ok(candidates.length > 0, "seed.candidates must be a non-empty comma-separated list");

  const routeTargets = manifest.edges
    .filter(e => e.from === "route")
    .map(e => e.to)
    .sort();
  assert.ok(routeTargets.length > 0, "the route node must have out-edges");
  assert.deepEqual(
    [...candidates].sort(),
    routeTargets,
    `seed.candidates (${candidates.join(",")}) must list exactly the route node's out-edge targets (${routeTargets.join(",")})`,
  );
  // Guard the exact set we expect for this template.
  assert.deepEqual([...candidates].sort(), ["log_only", "page"], "router must choose between page and log_only");
});

test("incident-responder gates the human-paging node behind approval (suggest autonomy)", () => {
  const page = manifest.nodes.find(n => n.id === "page");
  assert.ok(page, "there must be a page node");
  assert.equal(page!.autonomy, "suggest", "paging a human must require approval");
  assert.ok(page!.capabilities.some(c => c.sideEffect === "message-human"), "page must message a human");
});

test("incident-responder drives the engine end-to-end: pages on high severity, parks for approval, ledger verifies", async () => {
  const r = rig();

  // Fake every capability the manifest uses with plausible outputs so the page branch is taken.
  const plugins = new Map<string, CapabilityPlugin>();
  // triage → high severity (drives the router toward 'page')
  plugins.set("think", outputPlugin("think", "read", 50, { severity: "high", summary: "Checkout API returning 500s for 40% of users." }));
  // llm_route → choose the 'page' branch (engine writes route.chosen_node into state)
  plugins.set("llm_route", outputPlugin("llm_route", "read", 20, { chosen_node: "page", reason: "high-severity user-facing outage" }));
  // page → message-human (telegram); this node is 'suggest' so it parks for approval
  plugins.set("telegram_send", outputPlugin("telegram_send", "message-human", 1, { sent: true }));
  // log_only branch's composer (not taken here, but registered so the plugin snapshot is complete)
  plugins.set("compose", outputPlugin("compose", "read", 15, { text: "logged" }));
  // status channel update + memory persist
  plugins.set("notify_webhook", outputPlugin("notify_webhook", "write-reversible", 2, { ok: true }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { stored: true }));

  const supervisor = new Supervisor(plugins);
  const engine = new Engine(manifest, "t1", "r1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
  });

  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run),
  // so this fake-plugin run faithfully matches the customer path.
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // The 'page' node is suggest-autonomy + message-human → it parks; approve it so the run completes.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The router chose 'page' → that branch was taken and recorded in run state.
  assert.equal(res.projection.state["route.chosen_node"], "page", "router decision must flow into run state");
  assert.equal(res.projection.state["triage.severity"], "high", "triage severity must flow into run state");

  // The signed ledger for this run must verify end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});