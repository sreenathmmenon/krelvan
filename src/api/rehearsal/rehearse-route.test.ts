/**
 * The rehearse route: POST /api/agents/:id/rehearse returns a report; an unknown agent 404s. Driven
 * through the real server against a runtime with deterministic fake plugins (no LLM/network). The
 * send tool is a tripwire, so a green report also proves the route never fired a real effect.
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
import type { CapabilityPlugin } from "../../core/capability/capability.js";
import type { Manifest } from "../../core/manifest/manifest.js";

const TOKEN = "test-admin-token";
const authState: AuthState = { tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"), generated: false };
const authed = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function manifest(name: string): Manifest {
  return {
    version: 1, name, intent: "answer and send", entry: "reply",
    runBudgetCents: 100, maxNodeVisits: 5, seed: { output_map: "title=reply.title,body=reply.body,format=markdown" },
    nodes: [
      { id: "reply", role: "write reply", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 10 }] },
      { id: "send", role: "send it", autonomy: "full", capabilities: [{ name: "email_send", sideEffect: "message-human", budgetCents: 10 }] },
    ],
    edges: [{ from: "reply", to: "send" }],
  };
}

async function harness(): Promise<{ base: string; rt: KrelvanRuntime; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-reh-route-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const compose: CapabilityPlugin = { name: "compose", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output: { title: "Hi", body: "Answer." }, claimedCostCents: 1 }; } };
  const email: CapabilityPlugin = { name: "email_send", sideEffect: "message-human", estimateCents: () => 2, async invoke() { throw new Error("REAL email fired via the route!"); } };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["compose", compose], ["email_send", email]]));
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test("POST /api/agents/:id/rehearse returns a report; the send tool never fires", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(manifest("Support"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));

    const res = await fetch(`${h.base}/api/agents/${encodeURIComponent(imp.agent.id)}/rehearse`, {
      method: "POST", headers: authed, body: JSON.stringify({ count: 3 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { report: { results: unknown[]; rollup: { total: number }; personasGenerated: boolean } };
    assert.ok(Array.isArray(body.report.results));
    assert.equal(body.report.rollup.total, body.report.results.length);
    assert.ok(body.report.results.length >= 3, "rehearsed at least three personas");

    // Nothing threw → the tripwire email never fired. No artifacts, no runs leaked.
    assert.equal(h.rt.artifactStore.list({ agentId: imp.agent.id }).length, 0, "no artifacts from a rehearsal");
    assert.equal(h.rt.runRegistry.list().length, 0, "no rehearsal runs in the runs list");
  } finally { await h.close(); }
});

test("rehearsing an unknown agent 404s", async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/api/agents/sha256:nope/rehearse`, { method: "POST", headers: authed, body: "{}" });
    assert.equal(res.status, 404);
  } finally { await h.close(); }
});
