/**
 * Guards the shipped research-analyst template. It must always validate, declare only
 * real built-in capabilities, and actually DRIVE THE ENGINE end-to-end with fake plugins
 * so the routing (synthesize → compose on high confidence, → deepen on low) is exercised
 * and the resulting ledger verifies. If someone edits the JSON and breaks the graph, this
 * fails before it ever reaches a user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { parseOutputMap } from "../src/core/manifest/output-map.js";
import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { Supervisor, type CapabilityPlugin } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "research-analyst.manifest.json"), "utf8")) as Manifest;

// Real built-in capability names (registered in runtime.ts). Includes the extended set.
const BUILTINS = new Set([
  "think", "llm_route", "compose", "recall", "remember", "identify",
  "web_search", "http_get", "http_post", "notify_webhook",
  "rag.ingest", "rag.search", "wiki.ingest", "wiki.query",
  "email_send", "telegram_send", "slack_send", "delegate",
]);

// ── deterministic test rig (mirrors kernel.test.ts) ─────────────────────────────
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

/**
 * A NODE-AWARE fake plugin: several manifest nodes can share ONE capability (e.g. both
 * `synthesize` and `compose` use `think`), and the engine dispatches by capability name —
 * so a single plugin must return the right output for whichever node called it. It branches
 * on call.nodeId; an unmapped node yields {} (still runs, contributes nothing).
 */
function nodeAwarePlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, byNode: Record<string, Record<string, unknown>>): CapabilityPlugin {
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(call): Promise<{ output: unknown; claimedCostCents: number }> {
      return { output: byNode[call.nodeId] ?? {}, claimedCostCents: cost };
    },
  };
}

test("research-analyst manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map(i => i.message).join("; ")}`);
});

test("research-analyst uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("research-analyst runs a reliable linear flow: search → synthesize → compose → remember", () => {
  // The agent was intentionally simplified from a synthesize↔deepen revise loop (which never
  // converged on weaker models — synthesize honestly returns low confidence every pass, so it
  // looped until maxNodeVisits killed the run) to a bounded linear flow that always completes.
  const chain = ["search", "synthesize", "compose", "remember"];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.ok(
      manifest.edges.some(e => e.from === chain[i] && e.to === chain[i + 1]),
      `expected edge ${chain[i]} → ${chain[i + 1]}`,
    );
  }
  // no unbounded revise loop remains
  assert.ok(!manifest.nodes.some(n => n.id === "deepen"), "the fragile deepen revise loop must be gone");
  assert.ok(!manifest.edges.some(e => e.to === e.from), "no self-loop edges");
});

test("research-analyst persists the brief deterministically (remember_map in seed)", () => {
  assert.ok(manifest.seed, "template must seed config");
  assert.match(String(manifest.seed!["remember_map"]), /last_brief=compose\.body/);
});

test("research-analyst declares output_map so its brief is captured deterministically", () => {
  const om = parseOutputMap(manifest.seed);
  assert.ok(om, "output_map must be present and parse");
  assert.equal(om!.bodyKey, "compose.body");
  assert.equal(om!.titleKey, "compose.title");
  assert.equal(om!.format, "markdown");
});

test("research-analyst drives the engine end-to-end, routes to compose, and the ledger verifies", async () => {
  const r = rig();

  // One fake plugin per capability the manifest uses. 'think' returns high confidence,
  // so the gate routes synthesize → compose (the happy path), and the run completes.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("web_search", outputPlugin("web_search", "read", 8, {
    findings: "Several 2025 reports note small open-weight models (3B-14B) now rival larger closed models on common tasks. Sources: a benchmark roundup and two vendor model cards.",
    query_used: "state of small open-weight language models 2025",
  }));
  // Both `synthesize` and `compose` use the `think` capability — one node-aware plugin
  // returns the analyst summary for synthesize and the finished brief for compose.
  plugins.set("think", nodeAwarePlugin("think", "read", 50, {
    synthesize: {
      summary: "Small open-weight models have closed much of the gap with larger closed models on mainstream tasks, driven by better data and distillation.",
      key_points: "Open-weight 7B-14B models rival larger ones on many benchmarks\nLocal/private deployment is now practical\nQuality varies sharply by task",
      confidence: 80,
    },
    compose: {
      body: "BLUF: Small open-weight models are now production-viable for many tasks.\n- They rival larger closed models on mainstream benchmarks.\n- They enable private, local deployment.\n- Quality still varies by task.\nWhat we don't yet know: long-horizon reasoning parity.",
      title: "Small Open-Weight Models: Where They Stand",
    },
  }));
  plugins.set("remember", outputPlugin("remember", "write-reversible", 5, { ok: true, stored: "last_brief" }));

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
  // All nodes are "full" autonomy (read/compose/remember), so the run never parks.
  const res = await engine.run({ maxSteps: 50, initialState });
  assert.equal(res.status, "completed", `run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // The high-confidence path was taken: the brief made it into run state and was remembered.
  assert.equal(res.projection.state["synthesize.confidence"], 80, "analyst confidence is in run state");
  assert.equal(typeof res.projection.state["compose.body"], "string", "the composed brief is in run state");

  // The signed ledger of the whole run verifies.
  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});