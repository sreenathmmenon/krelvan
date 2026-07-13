/**
 * A3 runtime integration: a completed NON-CHAT run produces exactly one Artifact whose
 * title/body/format come from the shared extractor, delivery is handed the IDENTICAL
 * title/body, chat runs produce no artifact, and a duplicate completion never duplicates.
 *
 * The runtime is built against a throwaway data dir; the supervisor snapshot is swapped for
 * deterministic fake plugins (no LLM / network), exactly the seam the plugin lifecycle uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "./runtime.js";
import type { CapabilityPlugin } from "../core/capability/capability.js";
import type { Manifest } from "../core/manifest/manifest.js";

function fakePlugin(name: string, output: Record<string, unknown>): CapabilityPlugin {
  return {
    name,
    sideEffect: "read",
    estimateCents: () => 1,
    async invoke() { return { output, claimedCostCents: 1 }; },
  };
}

/** A trivial one-node agent: a `think` node that composes body+title, output_map declared. */
function composeManifest(name: string): Manifest {
  return {
    version: 1,
    name,
    intent: "compose a brief",
    entry: "compose",
    runBudgetCents: 100,
    maxNodeVisits: 5,
    seed: { output_map: "title=compose.title,body=compose.body,format=markdown" },
    nodes: [{ id: "compose", role: "write a brief", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 10 }] }],
    edges: [],
  };
}

function makeRuntime(dir: string): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  // Swap the live supervisor snapshot for a deterministic fake `think` that emits body+title.
  const plugins = new Map<string, CapabilityPlugin>([
    ["think", fakePlugin("think", { body: "The finished brief.", title: "Brief Title" })],
  ]);
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(plugins);
  return rt;
}

test("A3: a completed run creates one artifact from output_map; delivery gets identical title/body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-artifact-rt-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(composeManifest("Briefer"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    // Wire a delivery target and spy on deliverOutput to capture what delivery receives.
    const delivered: { title: string; body: string }[] = [];
    rt.agentRegistry.setDeliverTo(agentId, [{ channel: "webhook", config: { url: "https://example.invalid/hook" } }]);
    (rt as unknown as { deliverOutput: (t: unknown, n: string, r: string, title: string, body: string) => Promise<void> }).deliverOutput =
      async (_t, _n, _r, title, body) => { delivered.push({ title, body }); };

    const runId = "run-compose-1";
    rt.runRegistry.create({ agentId, runId, manifestName: "Briefer" });
    await rt.executeRun(runId, composeManifest("Briefer"), {}, agentId);

    const arts = rt.artifactStore.list({ agentId });
    assert.equal(arts.length, 1, "exactly one artifact");
    const art = arts[0]!;
    assert.equal(art.title, "Brief Title");
    assert.equal(art.body, "The finished brief.");
    assert.equal(art.format, "markdown", "format comes from output_map");
    assert.equal(art.runId, runId);

    assert.equal(delivered.length, 1, "delivery was invoked once");
    assert.equal(delivered[0]!.title, art.title, "delivery title == artifact title");
    assert.equal(delivered[0]!.body, art.body, "delivery body == artifact body");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: a chat run creates NO artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-artifact-rt-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(composeManifest("ChatAgent"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    const runId = "run-chat-1";
    rt.runRegistry.create({ agentId, runId, manifestName: "ChatAgent", kind: "chat" });
    await rt.executeRun(runId, composeManifest("ChatAgent"), {}, agentId);

    assert.equal(rt.artifactStore.list({ agentId }).length, 0, "chat runs never become artifacts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: re-running (duplicate completion) keeps exactly one artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-artifact-rt-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(composeManifest("Dup"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    const runId = "run-dup-1";
    rt.runRegistry.create({ agentId, runId, manifestName: "Dup" });
    await rt.executeRun(runId, composeManifest("Dup"), {}, agentId);
    // Fold/serve the same run again — must not create a second artifact.
    await rt.executeRun(runId, composeManifest("Dup"), {}, agentId);

    assert.equal(rt.artifactStore.list({ agentId }).length, 1, "idempotent by runId");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
