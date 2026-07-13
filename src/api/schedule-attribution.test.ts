/**
 * C2 run-origin attribution — a scheduled run carries origin.scheduleId, which:
 *  - stamps the produced artifact with scheduleId,
 *  - feeds the schedule's failure-streak (recordRunOutcome) on completion,
 *  - is queryable via runRegistry.listBySchedule (the /api/schedules/:id/runs source).
 * Uses a real runtime with fake plugins (no LLM/network), the same seam as A3's test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "./runtime.js";
import type { CapabilityPlugin } from "../core/capability/capability.js";
import type { Manifest } from "../core/manifest/manifest.js";

function fakeThink(output: Record<string, unknown>): CapabilityPlugin {
  return { name: "think", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output, claimedCostCents: 1 }; } };
}

function composeManifest(name: string): Manifest {
  return {
    version: 1, name, intent: "compose a brief", entry: "compose",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "title=compose.title,body=compose.body,format=markdown" },
    nodes: [{ id: "compose", role: "write a brief", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 10 }] }],
    edges: [],
  };
}

function makeRuntime(dir: string, thinkOut: Record<string, unknown>): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["think", fakeThink(thinkOut)]]));
  return rt;
}

test("C2: a scheduled run stamps origin.scheduleId, the artifact, and listBySchedule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-c2-"));
  try {
    const rt = makeRuntime(dir, { body: "The finished brief.", title: "Brief Title" });
    const imp = rt.importManifest(composeManifest("Digest"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    const runId = "run-sched-1";
    // Create the run exactly as startScheduledRun does (origin schedule).
    rt.runRegistry.create({ agentId, runId, manifestName: "Digest", origin: { kind: "schedule", scheduleId: "sched-XYZ" } });
    await rt.executeRun(runId, composeManifest("Digest"), {}, agentId);

    // The run record kept its origin.
    const rec = rt.runRegistry.get(runId);
    assert.equal(rec?.origin?.kind, "schedule");
    assert.equal(rec?.origin?.scheduleId, "sched-XYZ");

    // The artifact was stamped with the schedule id.
    const art = rt.artifactStore.getByRun(runId);
    assert.ok(art, "an artifact was produced");
    assert.equal(art!.scheduleId, "sched-XYZ", "artifact carries scheduleId");

    // listBySchedule finds it; a different schedule id finds nothing.
    assert.equal(rt.runRegistry.listBySchedule("sched-XYZ").length, 1);
    assert.equal(rt.runRegistry.listBySchedule("other").length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C2: a manual run has no origin (renders as manual); a trigger run is 'trigger'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-c2-"));
  try {
    const rt = makeRuntime(dir, { body: "x", title: "y" });
    const imp = rt.importManifest(composeManifest("A"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;

    // Manual (POST /api/runs path): no origin set.
    const manual = rt.runRegistry.create({ agentId, runId: "run-manual", manifestName: "A" });
    assert.equal(manual.origin, undefined, "manual runs have no origin (default)");
    assert.equal(rt.runRegistry.listBySchedule("sched-XYZ").length, 0, "manual run not attributed to a schedule");

    // Trigger path — starts a background run; the origin is set synchronously at create time.
    const trig = rt.triggerRun(agentId, {});
    assert.ok(trig.ok);
    assert.equal(trig.ok && rt.runRegistry.get(trig.run.runId)?.origin?.kind, "trigger");
    // Let the background run finish before cleanup so it can't write into a deleted temp dir.
    if (trig.ok) {
      for (let i = 0; i < 100; i++) {
        const s = rt.runRegistry.get(trig.run.runId)?.status;
        if (s === "completed" || s === "failed" || s === "halted") break;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C2: a failing scheduled run feeds the schedule failure streak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-c2-"));
  try {
    // A manifest whose only node uses a capability with NO registered plugin → the run fails.
    const failing: Manifest = {
      version: 1, name: "Broken", intent: "x", entry: "n1", runBudgetCents: 100, maxNodeVisits: 5,
      nodes: [{ id: "n1", role: "do", autonomy: "full", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 10 }] }],
      edges: [],
    };
    const rt = makeRuntime(dir, { body: "x" }); // only `think` is registered, not web_search
    const imp = rt.importManifest(failing);
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    // Register a schedule record so recordRunOutcome has something to update.
    rt.scheduleRegistry.create({ id: "sched-BROKEN", agentId, agentName: "Broken", kind: "interval", spec: "3600000", label: "hourly", enabled: true, createdAt: 0 });

    for (let i = 0; i < 3; i++) {
      const runId = `run-fail-${i}`;
      rt.runRegistry.create({ agentId, runId, manifestName: "Broken", origin: { kind: "schedule", scheduleId: "sched-BROKEN" } });
      await rt.executeRun(runId, failing, {}, agentId);
    }

    const sched = rt.scheduleRegistry.get("sched-BROKEN");
    assert.equal(sched?.lastStatus, "failed", "the scheduled run failed");
    assert.ok((sched?.failStreak ?? 0) >= 3, `failStreak should reach 3, got ${sched?.failStreak}`);
    assert.equal(sched?.enabled, true, "schedule stays armed despite the streak");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
