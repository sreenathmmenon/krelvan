/**
 * The full driver, end-to-end with NO LLM: rehearseAgent casts the deterministic archetypes, runs
 * each persona through the real graph against a synthetic world, and returns a report. We assert
 * the report shape, that the send tool never fired (a would-send warning is raised instead), that
 * no artifacts were created, and that every persona-run is grouped under one rehearsalId.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "../runtime.js";
import type { CapabilityPlugin } from "../../core/capability/capability.js";
import type { Manifest } from "../../core/manifest/manifest.js";

/** A single node that composes a reply (read) then a send node (message-human). */
function agentManifest(name: string): Manifest {
  return {
    version: 1, name, intent: "reply to customers and send the reply", entry: "reply",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "title=reply.title,body=reply.body,format=markdown" },
    nodes: [
      { id: "reply", role: "write the reply", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
      { id: "deliver", role: "send the reply", autonomy: "full", capabilities: [{ name: "email_send", sideEffect: "message-human", budgetCents: 10 }] },
    ],
    edges: [{ from: "reply", to: "deliver" }],
  };
}

function makeRuntime(dir: string): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const compose: CapabilityPlugin = {
    name: "compose", sideEffect: "read", estimateCents: () => 1,
    async invoke() { return { output: { title: "Re: your question", body: "Here's the answer." }, claimedCostCents: 1 }; },
  };
  const email: CapabilityPlugin = {
    name: "email_send", sideEffect: "message-human", estimateCents: () => 2,
    async invoke() { throw new Error("REAL email_send fired during a rehearsal!"); },
  };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["compose", compose], ["email_send", email]]));
  return rt;
}

test("rehearseAgent runs the deterministic cast, sends nothing, and returns a report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-agent-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(agentManifest("Support Bot"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    const res = await rt.rehearseAgent(agentId, 5);
    assert.ok(res.ok, res.ok ? "" : res.error);
    const report = res.report;

    // No LLM in the test env → the deterministic archetype cast (marked not-generated).
    assert.equal(report.personasGenerated, false);
    assert.equal(report.results.length, 5, "five personas rehearsed");
    assert.equal(report.rollup.total, 5);

    // The send tool never fired (no test threw). Each persona that reached `deliver` raises a
    // would-send warning instead — at least the happy path does.
    assert.ok(
      report.results.some(r => r.judgement.findings.some(f => f.code === "would_send")),
      "at least one persona would have sent an email in production — recorded, not performed",
    );

    // Every persona-run reassures nothing shipped.
    for (const r of report.results) {
      assert.ok(r.judgement.findings.some(f => f.code === "nothing_delivered"), `${r.persona.name} reassures nothing shipped`);
    }

    // No artifacts, and nothing leaked into the runs list.
    assert.equal(rt.artifactStore.list({ agentId }).length, 0, "a rehearsal produces no Inbox artifacts");
    assert.equal(rt.runRegistry.list().length, 0, "no rehearsal run leaks into the runs list");

    // All persona-runs are grouped under the one rehearsalId.
    const grouped = rt.runRegistry.listByRehearsal(report.rehearsalId);
    assert.equal(grouped.length, 5, "all five persona-runs grouped under the rehearsal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rehearseAgent rejects an unknown agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-agent-"));
  try {
    const rt = makeRuntime(dir);
    const res = await rt.rehearseAgent("sha256:nope");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
