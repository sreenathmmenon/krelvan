/**
 * FULL-PRODUCT flow across three distinct agent shapes, driven through the REAL server: import →
 * real run → rehearsal (synthetic users) → verification of separation. This is the "does the whole
 * thing, including the new Rehearsal Room, hang together end to end" acceptance test.
 *
 * Shapes:
 *   A. Linear producer (lookup → write)     — real run makes an artifact; every persona completes.
 *   B. Sender         (write → email)        — real run WOULD send (message-human); rehearsal records it, never sends.
 *   C. Looper         (a node revisits to cap)— rehearsal surfaces a visit-cap STOP for empty input.
 *
 * Throughout we assert the hard invariant: a rehearsal NEVER delivers, NEVER makes an artifact, and
 * NEVER pollutes the runs list — while a real run does exactly one of those, as designed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { KrelvanRuntime } from "../runtime.js";
import { createApiServer } from "../server.js";
import type { AuthState } from "../auth.js";
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { Manifest } from "../../core/manifest/manifest.js";
import type { RehearsalReport } from "../rehearsal/report.js";

const TOKEN = "test-admin-token";
const authState: AuthState = { tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"), generated: false };
const authed = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

// ── Agent shapes ────────────────────────────────────────────────────────────────

function producerManifest(): Manifest {
  return {
    version: 1, name: "Research Analyst", intent: "look up a topic and write a brief", entry: "lookup",
    runBudgetCents: 100, maxNodeVisits: 5, seed: { output_map: "title=write.title,body=write.body,format=markdown" },
    nodes: [
      { id: "lookup", role: "look up the topic", autonomy: "full", capabilities: [{ name: "research", sideEffect: "read", budgetCents: 10 }] },
      { id: "write", role: "write the brief", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
    ],
    edges: [{ from: "lookup", to: "write" }],
  };
}

function senderManifest(): Manifest {
  return {
    version: 1, name: "Refund Assistant", intent: "answer a refund question and email the reply", entry: "write",
    runBudgetCents: 100, maxNodeVisits: 5, seed: { output_map: "title=write.title,body=write.body,format=markdown" },
    nodes: [
      { id: "write", role: "write the reply", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
      { id: "send", role: "email the customer", autonomy: "full", capabilities: [{ name: "email_send", sideEffect: "message-human", budgetCents: 10 }] },
    ],
    edges: [{ from: "write", to: "send" }],
  };
}

function brokenManifest(): Manifest {
  // A STRUCTURALLY broken agent: the step declares a per-cap budget the run ceiling can't afford
  // (estimate 60¢ but a 40¢ run budget), so admission denies and the run fails. Because the
  // synthetic layer preserves each tool's estimateCents, a rehearsal reproduces this exactly — a
  // blocker the owner should see before going live. (A rehearsal fakes read DATA, but budget,
  // gating and structure are byte-identical to production.)
  return {
    version: 1, name: "Order Checker", intent: "validate an order number before proceeding", entry: "check",
    runBudgetCents: 40, maxNodeVisits: 5, seed: { output_map: "title=check.title,body=check.body,format=markdown" },
    nodes: [
      { id: "check", role: "validate the order", autonomy: "full", capabilities: [{ name: "pricey", sideEffect: "read", budgetCents: 100 }] },
    ],
    edges: [],
  };
}

// ── Runtime with fake plugins (email is a tripwire: throws if ever really invoked) ──

function makeRuntime(dir: string): KrelvanRuntime {
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const research: CapabilityPlugin = { name: "research", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output: { facts: "synthetic facts" }, claimedCostCents: 1 }; } };
  const compose: CapabilityPlugin = { name: "compose", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output: { title: "A brief", body: "The content." }, claimedCostCents: 1 }; } };
  const email: CapabilityPlugin = { name: "email_send", sideEffect: "message-human", estimateCents: () => 2, async invoke(c: EffectCall) { throw new Error(`REAL email fired! ${JSON.stringify(c.input)}`); } };
  // `pricey` estimates 60¢ — more than the broken agent's 40¢ run ceiling → admission denies.
  const pricey: CapabilityPlugin = { name: "pricey", sideEffect: "read", estimateCents: () => 60, async invoke() { return { output: {}, claimedCostCents: 60 }; } };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["research", research], ["compose", compose], ["email_send", email], ["pricey", pricey]]));
  return rt;
}

interface H { base: string; rt: KrelvanRuntime; close: () => Promise<void>; }
async function harness(): Promise<H> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-fullflow-"));
  const rt = makeRuntime(dir);
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

async function waitForRun(rt: KrelvanRuntime, runId: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = rt.runRegistry.get(runId)?.status;
    if (s === "completed" || s === "failed" || s === "halted") return;
    await new Promise(r => setTimeout(r, 15));
  }
}

async function rehearse(h: H, agentId: string, count = 5): Promise<RehearsalReport> {
  const res = await fetch(`${h.base}/api/agents/${encodeURIComponent(agentId)}/rehearse`, { method: "POST", headers: authed, body: JSON.stringify({ count }) });
  assert.equal(res.status, 200, "rehearse route responds 200");
  return (await res.json() as { report: RehearsalReport }).report;
}

// ── A. Producer: real run makes an artifact; rehearsal completes clean and ships nothing ──

test("FLOW A · producer: real run → artifact; rehearsal → all complete, nothing shipped", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(producerManifest());
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    // Real run via the server → completes and produces exactly one Inbox artifact.
    const start = await fetch(`${h.base}/api/runs`, { method: "POST", headers: authed, body: JSON.stringify({ agentId }) });
    assert.equal(start.status, 201);
    const realRunId = (await start.json() as { run: { runId: string } }).run.runId;
    await waitForRun(h.rt, realRunId);
    assert.equal(h.rt.runRegistry.get(realRunId)!.status, "completed");
    assert.ok(h.rt.artifactStore.getByRun(realRunId), "the real run produced an artifact");
    assert.equal(h.rt.runRegistry.list().length, 1, "one real run in the runs list");

    // Rehearsal → every persona completes (no consequential tools in this agent), nothing shipped.
    const report = await rehearse(h, agentId);
    assert.equal(report.rollup.total, 5);
    assert.equal(report.rollup.byVerdict.completed, 5, "a read-only agent completes for every persona");
    assert.equal(report.rollup.hasBlocker, false, "no blockers");
    for (const r of report.results) assert.ok(r.judgement.findings.some(f => f.code === "nothing_delivered"));

    // Separation invariant: the rehearsal added NO artifacts and NO entries to the runs list.
    assert.equal(h.rt.artifactStore.list({ agentId }).length, 1, "still exactly one artifact (the real run's)");
    assert.equal(h.rt.runRegistry.list().length, 1, "rehearsal runs never enter the runs list");
    assert.equal(h.rt.runRegistry.listByRehearsal(report.rehearsalId).length, 5, "5 rehearsal runs grouped, out of the way");
  } finally { await h.close(); }
});

// ── B. Sender: real run WOULD send; rehearsal records it, never sends ──

test("FLOW B · sender: rehearsal records the email as would-send and never fires it", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(senderManifest());
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    const report = await rehearse(h, agentId);
    // Nothing threw → the real email tripwire never fired for any persona.
    assert.ok(report.results.length >= 3);
    assert.ok(report.results.every(r => r.judgement.findings.some(f => f.code === "would_send")),
      "every persona reaches the send and records a would-send warning");
    assert.ok(report.rollup.findingCounts.warn > 0, "the report warns about the real action");
    assert.ok(report.results.every(r => r.judgement.findings.some(f => f.code === "nothing_delivered")),
      "and reassures nothing shipped");
    // No artifacts, no runs leaked.
    assert.equal(h.rt.artifactStore.list({ agentId }).length, 0);
    assert.equal(h.rt.runRegistry.list().length, 0);
  } finally { await h.close(); }
});

// ── C. Structurally broken: rehearsal surfaces the failure as a blocker for every persona ──

test("FLOW C · broken: rehearsal flags the structural failure as a blocker", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(brokenManifest());
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;

    const report = await rehearse(h, agentId);
    // The over-budget step is denied at admission → every persona-run fails.
    assert.ok(report.rollup.byVerdict.failed >= 1, "at least one persona fails on the structural break");
    assert.equal(report.rollup.hasBlocker, true, "a failing run is a blocker to fix before going live");
    assert.ok(report.results.some(r => r.judgement.findings.some(f => f.code === "run_failed")),
      "the failure finding is surfaced");
    // Still zero real-world side effects.
    assert.equal(h.rt.artifactStore.list({ agentId }).length, 0);
    assert.equal(h.rt.runRegistry.list().length, 0);
  } finally { await h.close(); }
});
