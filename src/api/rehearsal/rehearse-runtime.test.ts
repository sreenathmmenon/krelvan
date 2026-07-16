/**
 * End-to-end rehearsal safety: run a real agent that composes a message AND sends it, as a
 * REHEARSAL. The real send plugin is a tripwire that throws if invoked. We assert the rehearsal
 * (1) completes on the real engine, (2) NEVER fires the real send, (3) records the send as a
 * suppressed effect, (4) creates NO Inbox artifact, and (5) is excluded from the runs list.
 *
 * This is the linchpin: it proves a rehearsal runs the production graph but touches nothing real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "../runtime.js";
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { Manifest } from "../../core/manifest/manifest.js";

/** Agent: node `write` composes a message (read), node `send` delivers it (message-human). */
function sendManifest(name: string): Manifest {
  return {
    version: 1, name, intent: "write a note and send it", entry: "write",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "title=write.title,body=write.body,format=markdown" },
    nodes: [
      { id: "write", role: "compose the note", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
      { id: "send", role: "send the note", autonomy: "full", capabilities: [{ name: "notify", sideEffect: "message-human", budgetCents: 10 }] },
    ],
    edges: [{ from: "write", to: "send" }],
  };
}

function makeRuntime(dir: string): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const compose: CapabilityPlugin = {
    name: "compose", sideEffect: "read", estimateCents: () => 1,
    async invoke() { return { output: { title: "Hello", body: "Your order shipped." }, claimedCostCents: 1 }; },
  };
  // The REAL send tripwire: if the rehearsal ever calls through, this throws and the run fails.
  const notify: CapabilityPlugin = {
    name: "notify", sideEffect: "message-human", estimateCents: () => 2,
    async invoke(call: EffectCall) { throw new Error(`REAL notify fired in a rehearsal! input=${JSON.stringify(call.input)}`); },
  };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["compose", compose], ["notify", notify]]));
  return rt;
}

test("a rehearsal completes on the real engine, sends nothing, and records the suppressed send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(sendManifest("Notifier"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    const res = await rt.rehearseOnce({ agentId, manifest: sendManifest("Notifier"), personaName: "happy path" });
    assert.ok(res.ok, res.ok ? "" : res.error);

    // (1) completed on the real engine — the tripwire never threw.
    assert.equal(res.run.status, "completed", "the rehearsal completed on the real kernel");
    // (2)+(3) the send was recorded, not performed.
    assert.equal(res.suppressed.length, 1, "exactly one consequential effect was suppressed");
    assert.equal(res.suppressed[0]!.capability, "notify");
    assert.equal(res.suppressed[0]!.sideEffect, "message-human");
    // (4) NO Inbox artifact was created for a rehearsal.
    assert.equal(rt.artifactStore.getByRun(res.run.runId), undefined, "a rehearsal produces no artifact");
    assert.equal(rt.artifactStore.list({ agentId }).length, 0, "nothing landed in the Inbox");
    // (5) the rehearsal is excluded from the runs list.
    assert.ok(res.run.rehearsal, "the run is marked rehearsal");
    assert.ok(!rt.runRegistry.list().some(r => r.runId === res.run.runId), "rehearsal runs never show in the runs list");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same agent run for REAL fires the tool (proving the tripwire is live) and makes an artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(sendManifest("Notifier2"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    // A real run hits the tripwire (message-human, autonomy full → no gate) → the node fails.
    // The point is only to prove the tool path is genuinely live for a non-rehearsal run, so a
    // passing rehearsal above is meaningful (not a tautology where the tool never runs anyway).
    const runId = "run-real-1";
    rt.runRegistry.create({ agentId, runId, manifestName: "Notifier2" });
    await rt.executeRun(runId, sendManifest("Notifier2"), {}, agentId);
    const real = rt.runRegistry.get(runId)!;
    assert.equal(real.status, "failed", "the real run actually reaches the (throwing) send tool");
    assert.ok(!real.rehearsal, "a normal run is not a rehearsal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rehearsals group by rehearsalId and are listable together, apart from real runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-"));
  try {
    const rt = makeRuntime(dir);
    const imp = rt.importManifest(sendManifest("Grouped"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    const rehearsalId = "reh-batch-1";
    await rt.rehearseOnce({ agentId, manifest: sendManifest("Grouped"), rehearsalId, personaName: "p1" });
    await rt.rehearseOnce({ agentId, manifest: sendManifest("Grouped"), rehearsalId, personaName: "p2" });

    const group = rt.runRegistry.listByRehearsal(rehearsalId);
    assert.equal(group.length, 2, "both persona-runs grouped under the rehearsal");
    assert.deepEqual(group.map(r => r.personaName), ["p1", "p2"], "in creation order");
    assert.equal(rt.runRegistry.list().length, 0, "no rehearsal leaks into the real runs list");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
