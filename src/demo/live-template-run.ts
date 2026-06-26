/**
 * LIVE customer-path test for a shipped template, driven by the REAL plugins
 * (think / compose / llm_route / recall / remember) against the configured model
 * (here: Ollama qwen2.5:14b). This is the exact runtime path a customer hits via
 * the HTTP API, minus the HTTP shell — same Engine, same real Supervisor plugins,
 * same signed ledger.
 *
 * Safety: ONE run, sequential, bounded by the manifest's runBudgetCents/maxNodeVisits.
 * Any node whose autonomy is "suggest" (e.g. email_send) PAUSES for approval — this
 * harness DECLINES those, so nothing is actually sent. Read/memory effects are approved.
 *
 * Run: KRELVAN_LLM_PROVIDER=ollama KRELVAN_LLM_MODEL=qwen2.5:14b \
 *      tsx src/demo/live-template-run.ts templates/inbox-triage.manifest.json
 */
import { readFileSync } from "node:fs";
import { HmacKeyring } from "../core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../core/ledger/store.js";
import { Engine } from "../core/kernel/engine.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../core/capability/capability.js";
import { project } from "../core/kernel/project.js";
import { validateManifest, type Manifest } from "../core/manifest/manifest.js";

import { thinkCapability } from "../core/plugins/think.js";
import { composeCapability } from "../core/plugins/compose.js";
import { llmRouteCapability } from "../core/plugins/llm-route.js";
import { recallCapability, rememberCapability } from "../core/plugins/memory-plugins.js";

async function main(): Promise<void> {
  const path = process.argv[2] ?? "templates/inbox-triage.manifest.json";
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;

  const issues = validateManifest(manifest);
  if (issues.length) {
    console.error("MANIFEST INVALID:", issues.map((i) => i.message).join("; "));
    process.exit(1);
  }
  console.log(`\n=== LIVE run: ${manifest.name} (${path}) ===`);
  console.log(`provider=${process.env["KRELVAN_LLM_PROVIDER"]} model=${process.env["KRELVAN_LLM_MODEL"]}`);
  console.log(`nodes=${manifest.nodes.length} budget=${manifest.runBudgetCents}c maxVisits=${manifest.maxNodeVisits}\n`);

  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;

  // Real reasoning/memory plugins. A "noop" stands in ONLY for external-send caps so the
  // graph can be exercised without real credentials — but those live on "suggest" nodes and
  // are DECLINED below, so they never execute anyway.
  const noop = (name: string, sideEffect: CapabilityPlugin["sideEffect"]): CapabilityPlugin => ({
    name, sideEffect, estimateCents: () => 1,
    async invoke() { return { output: { skipped: true }, claimedCostCents: 0 }; },
  });

  const plugins = new Map<string, CapabilityPlugin>([
    ["think", thinkCapability],
    ["compose", composeCapability],
    ["llm_route", llmRouteCapability],
    ["recall", recallCapability],
    ["remember", rememberCapability],
    ["email_send", noop("email_send", "message-human")],
    ["telegram_send", noop("telegram_send", "message-human")],
    ["slack_send", noop("slack_send", "message-human")],
    ["notify_webhook", noop("notify_webhook", "write-reversible")],
  ]);

  const { supervisor } = Supervisor.create(plugins);

  // The customer's veto: approve reads/memory, DECLINE any human-message/spend effect (nothing sent).
  const approve = (call: EffectCall): boolean => {
    const send = call.sideEffect === "message-human" || call.sideEffect === "spend" || call.sideEffect === "write-irreversible";
    console.log(`  [approval] node=${call.nodeId} cap=${call.capability} effect=${call.sideEffect} -> ${send ? "DECLINED (not sent)" : "approved"}`);
    return !send;
  };

  // Faithful to the real runtime (runtime.ts executeRun): manifest.seed is merged into
  // initialState before the run, so seeded keys (e.g. llm_route's `candidates`) reach the
  // engine. initialState overrides seed. Without this the headless harness would NOT match
  // the customer's HTTP path.
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;

  const t0 = Date.now();
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const result = await engine.run({ maxSteps: 40, approve, initialState });
  const ms = Date.now() - t0;

  const events = await store.read("t1");
  const v = verify(events, ring);
  const proj = project(events);

  console.log(`\n--- RESULT ---`);
  console.log(`status:        ${result.status}${result.reason ? " (" + result.reason + ")" : ""}`);
  console.log(`wall time:     ${(ms / 1000).toFixed(1)}s`);
  console.log(`spent:         ${proj.budget.runSpentCents}c / ${manifest.runBudgetCents}c`);
  console.log(`ledger events: ${events.length}`);
  console.log(`ledger verify: ${v.ok ? "OK ✓ (signed chain valid)" : "FAILED: " + JSON.stringify(v)}`);
  console.log(`\n--- real LLM output (selected state keys) ---`);
  for (const [k, val] of Object.entries(proj.state)) {
    const s = typeof val === "string" ? val : JSON.stringify(val);
    if (/\.(result|thought|category|urgency|should_reply|next|body|title|severity|score)$/.test(k) || k.endsWith(".result")) {
      console.log(`  ${k}: ${s.slice(0, 220)}${s.length > 220 ? "…" : ""}`);
    }
  }
  console.log("");
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((e) => { console.error("RUN ERROR:", e); process.exit(1); });
