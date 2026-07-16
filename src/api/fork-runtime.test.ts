/**
 * Time-travel debug (forkRun): copy a source run's ledger up through a chosen node onto a NEW
 * runId, optionally overriding one of that node's outputs, then re-run FORWARD from the fork
 * point. Because the fork lands on a fresh runId, downstream effect idempotency keys are empty —
 * so the downstream node genuinely re-executes (and re-gates), and it sees the edited value.
 *
 * The runtime is built against a throwaway data dir; the supervisor snapshot is swapped for
 * deterministic fake plugins (no LLM / network), the same seam the plugin lifecycle uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "./runtime.js";
import type { CapabilityPlugin } from "../core/capability/capability.js";
import type { Manifest } from "../core/manifest/manifest.js";
import type { EffectCall } from "../core/capability/capability.js";

/**
 * Two-node pipeline: `pick` writes a `topic`; `write` composes a title/body that ECHO the topic
 * it was handed. This lets a test prove an edit to `pick.topic` flows into the downstream `write`
 * output after a fork.
 */
function pipelineManifest(name: string): Manifest {
  return {
    version: 1,
    name,
    intent: "pick a topic then write about it",
    entry: "pick",
    runBudgetCents: 100,
    maxNodeVisits: 5,
    seed: { output_map: "title=write.title,body=write.body,format=markdown" },
    nodes: [
      { id: "pick", role: "choose a topic", autonomy: "full", capabilities: [{ name: "pick", sideEffect: "read", budgetCents: 10 }] },
      { id: "write", role: "write about the topic", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
    ],
    edges: [{ from: "pick", to: "write" }],
  };
}

function makeRuntime(dir: string): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const pick: CapabilityPlugin = {
    name: "pick", sideEffect: "read", estimateCents: () => 1,
    async invoke() { return { output: { topic: "small models" }, claimedCostCents: 1 }; },
  };
  // `compose` reads the accumulated state (its input) and echoes whatever `pick.topic` currently is.
  const compose: CapabilityPlugin = {
    name: "compose", sideEffect: "read", estimateCents: () => 1,
    async invoke(call: EffectCall) {
      const state = (call.input ?? {}) as Record<string, unknown>;
      const topic = String(state["pick.topic"] ?? "unknown");
      return { output: { title: `On ${topic}`, body: `A brief about ${topic}.` }, claimedCostCents: 1 };
    },
  };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["pick", pick], ["compose", compose]]));
  return rt;
}

async function seedRun(rt: KrelvanRuntime, agentId: string, runId: string, name: string): Promise<void> {
  rt.runRegistry.create({ agentId, runId, manifestName: name });
  await rt.executeRun(runId, pipelineManifest(name), {}, agentId);
}

/** forkRun kicks execution off in the background (the UI navigates + polls); wait for it to settle. */
async function waitForRun(rt: KrelvanRuntime, runId: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = rt.runRegistry.get(runId)?.status;
    if (s === "completed" || s === "failed") return;
    await new Promise(r => setTimeout(r, 20));
  }
}

test("fork: re-running a completed run forward produces a new completed run with its own artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(pipelineManifest("Pipe"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    await seedRun(rt, agentId, "run-src-1", "Pipe");
    assert.equal(rt.runRegistry.get("run-src-1")!.status, "completed");

    const fork = await rt.forkRun("run-src-1", "pick");
    assert.ok(fork.ok, fork.ok ? "" : fork.error);
    const newRunId = fork.run.runId;
    assert.notEqual(newRunId, "run-src-1", "the fork is a distinct run");
    await waitForRun(rt, newRunId);

    // The forked run finishes forward — a fresh artifact, not the source's.
    const src = rt.artifactStore.getByRun("run-src-1");
    const forked = rt.artifactStore.getByRun(newRunId);
    assert.ok(src && forked, "both runs produced artifacts");
    assert.notEqual(forked!.id, src!.id, "the fork has its own artifact");
    assert.equal(rt.runRegistry.get(newRunId)!.status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fork with an edit: the overridden value flows into the downstream node's output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(pipelineManifest("Pipe"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    await seedRun(rt, agentId, "run-src-2", "Pipe");
    const baseline = rt.artifactStore.getByRun("run-src-2")!;
    assert.equal(baseline.title, "On small models", "baseline echoes the picked topic");

    // What-if: fork at `pick` and override its `topic`. Downstream `write` must re-run and echo it.
    const fork = await rt.forkRun("run-src-2", "pick", { key: "topic", value: "large models" });
    assert.ok(fork.ok, fork.ok ? "" : fork.error);
    await waitForRun(rt, fork.run.runId);
    const forked = rt.artifactStore.getByRun(fork.run.runId)!;
    assert.equal(forked.title, "On large models", "the edited topic flowed downstream");
    assert.equal(forked.body, "A brief about large models.");
    // The source is untouched — forking never mutates the original run.
    assert.equal(rt.artifactStore.getByRun("run-src-2")!.title, "On small models");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fork: forking through the terminal node re-runs and still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(pipelineManifest("Pipe"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    await seedRun(rt, agentId, "run-src-3", "Pipe");
    const fork = await rt.forkRun("run-src-3", "write");
    assert.ok(fork.ok, fork.ok ? "" : fork.error);
    await waitForRun(rt, fork.run.runId);
    assert.equal(rt.runRegistry.get(fork.run.runId)!.status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fork: a non-existent source run is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const fork = await rt.forkRun("run-nope", "pick");
    assert.equal(fork.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fork: a node that never concluded in the source is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(pipelineManifest("Pipe"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    await seedRun(rt, agentId, "run-src-4", "Pipe");
    const fork = await rt.forkRun("run-src-4", "ghost-node");
    assert.equal(fork.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fork: a chat run cannot be forked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fork-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(pipelineManifest("Pipe"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    const runId = "run-chat-fork";
    rt.runRegistry.create({ agentId, runId, manifestName: "Pipe", kind: "chat" });
    await rt.executeRun(runId, pipelineManifest("Pipe"), {}, agentId);

    const fork = await rt.forkRun(runId, "pick");
    assert.equal(fork.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
