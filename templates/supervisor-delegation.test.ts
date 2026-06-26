/**
 * Guards the shipped supervisor-delegation template. This template is TRUE multi-agent:
 * a supervisor that plans, then DELEGATES to a research sub-agent and a writer sub-agent
 * (each a real bounded sub-run under one authority ceiling), then assembles + records.
 *
 * What this test covers:
 *  1. The manifest is structurally valid (validateManifest === []).
 *  2. Every capability name is a real built-in (including delegate / rag.* / wiki.*).
 *  3. The two delegation nodes really carry a subAgent binding (manifestId + outputMapping).
 *  4. The WHOLE pipeline is driven END-TO-END through the real Engine, including BOTH
 *     sub-agent delegations — using fake plugins for the leaf capabilities and a
 *     resolveManifest that returns real (tiny) sub-agent manifests, exactly the way
 *     kernel.test.ts wires a sub-run. The two "suggest" delegation nodes are approved
 *     via approve:() => true. We assert the run completes, the child outputs flow into
 *     parent state via outputMapping, and the signed ledger verifies.
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
  readFileSync(join(here, "supervisor-delegation.manifest.json"), "utf8"),
) as Manifest;

// The real built-in capability set (mirrors runtime.ts), incl. the agentic extras.
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

// ── deterministic rig (mirrors kernel.test.ts) ───────────────────────────────────
function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A plugin that returns a fixed output (mirrors kernel.test.ts outputPlugin). */
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

// ── tiny REAL sub-agent manifests the supervisor delegates to ────────────────────
// The supervisor's "research" node maps research_out <- synthesize.findings,
// so the research sub-agent must produce a node "synthesize" with key "findings".
const subResearch: Manifest = {
  version: 1,
  name: "sub-research",
  intent: "investigate the brief and synthesize findings",
  entry: "synthesize",
  runBudgetCents: 200,
  maxNodeVisits: 2,
  nodes: [
    {
      id: "synthesize",
      role: "research synthesizer",
      autonomy: "full",
      capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 50 }],
    },
  ],
  edges: [],
};

// The supervisor's "write" node maps writer_out <- draft.text.
const subWriter: Manifest = {
  version: 1,
  name: "sub-writer",
  intent: "draft a brief from the findings",
  entry: "draft",
  runBudgetCents: 150,
  maxNodeVisits: 2,
  nodes: [
    {
      id: "draft",
      role: "drafter",
      autonomy: "full",
      capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 40 }],
    },
  ],
  edges: [],
};

// ── structural guards ────────────────────────────────────────────────────────────
test("supervisor-delegation manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map((i) => i.message).join("; ")}`);
});

test("supervisor-delegation uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("supervisor-delegation: research + write nodes carry real sub-agent bindings", () => {
  const research = manifest.nodes.find((n) => n.id === "research")!;
  const write = manifest.nodes.find((n) => n.id === "write")!;
  const rCap = research.capabilities.find((c) => c.subAgent);
  const wCap = write.capabilities.find((c) => c.subAgent);
  assert.ok(rCap?.subAgent, "research node must delegate to a sub-agent");
  assert.ok(wCap?.subAgent, "write node must delegate to a sub-agent");
  assert.equal(rCap!.subAgent!.manifestId, "sub-research");
  assert.equal(wCap!.subAgent!.manifestId, "sub-writer");
  // delegation nodes gate on approval (suggest) because they spend a sub-run budget
  assert.equal(research.autonomy, "suggest");
  assert.equal(write.autonomy, "suggest");
});

// ── end-to-end engine drive through BOTH delegations ─────────────────────────────
test("supervisor-delegation: full pipeline runs E2E through both sub-agents; ledger verifies", async () => {
  const r = rig();

  // Fake plugins for every leaf capability used by the parent AND the two sub-agents.
  // think (plan) -> {plan, research_brief}; the research/write nodes delegate (no leaf
  // plugin — the engine spawns a sub-run); compose (assemble) -> {result}; remember -> ok.
  // Sub-agent leaves: web_search (research) -> {findings}; compose (writer) -> {text}.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("think", outputPlugin("think", "read", 10, { plan: "research X, write for founders", research_brief: "investigate X" }));
  plugins.set("compose", outputPlugin("compose", "read", 10, { result: "FINAL BRIEF", text: "DRAFT TEXT" }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { ok: true }));
  plugins.set("web_search", outputPlugin("web_search", "read", 8, { findings: "key finding: on-device inference is cheap at the margin" }));

  const supervisor = new Supervisor(plugins);

  const engine = new Engine(manifest, "t1", "r1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
    // Resolve the two pinned sub-agent manifestIds to real (tiny) manifests so the
    // engine can spawn genuine bounded sub-runs — exactly like kernel.test.ts.
    resolveManifest: async (id: string) =>
      id === "sub-research" ? subResearch : id === "sub-writer" ? subWriter : null,
  });

  // Merge the manifest seed into initialState exactly as the real runtime does
  // (src/api/runtime.ts merges { ...manifest.seed, ...initialState } before engine.run).
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  // approve:() => true lets the two "suggest" delegation nodes proceed.
  const res = await engine.run({ maxSteps: 50, approve: () => true, initialState });

  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // Child outputs flowed into parent state via outputMapping.
  assert.equal(
    res.projection.state["research.research_out"],
    "key finding: on-device inference is cheap at the margin",
    "research sub-agent finding must land in parent state",
  );
  assert.equal(res.projection.state["write.writer_out"], "DRAFT TEXT", "writer sub-agent draft must land in parent state");
  assert.equal(res.projection.state["assemble.result"], "FINAL BRIEF", "assembled brief must be in parent state");

  // The signed ledger verifies end-to-end.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);

  // Both delegations really happened (two sub-runs requested + completed).
  const types = events.map((e) => e.type);
  assert.ok(types.filter((t) => t === "SubRunRequested").length >= 2, "both delegations must request a sub-run");
  assert.ok(types.filter((t) => t === "SubRunCompleted").length >= 2, "both sub-runs must complete");
});
