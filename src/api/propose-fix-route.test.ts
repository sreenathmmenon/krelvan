/**
 * propose-fix route guards: it is only for failed/halted runs, 404s for a missing run, and —
 * the key contract of the VISIBLE loop — proposing never starts a run. The LLM-backed happy path
 * (rebuild + diff) is covered by the diff unit tests + live verification; here we pin the guards
 * and the no-side-effect promise, which need no LLM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { KrelvanRuntime } from "./runtime.js";
import { createApiServer } from "./server.js";
import type { AuthState } from "./auth.js";
import type { Manifest } from "../core/manifest/manifest.js";

const TOKEN = "test-admin-token";
const authState: AuthState = { tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"), generated: false };
const authed = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function oneNode(name: string): Manifest {
  return {
    version: 1, name, intent: "do a thing", entry: "n1",
    runBudgetCents: 100, maxNodeVisits: 5, seed: {},
    nodes: [{ id: "n1", role: "do it", autonomy: "full", capabilities: [] }],
    edges: [],
  };
}

async function harness(): Promise<{ base: string; rt: KrelvanRuntime; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-propose-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test("propose-fix 404s for a missing run", async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/api/runs/nope/propose-fix`, { method: "POST", headers: authed, body: "{}" });
    assert.equal(res.status, 404);
  } finally { await h.close(); }
});

test("propose-fix 409s for a non-failed run (and starts no run)", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(oneNode("Analyst"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    h.rt.runRegistry.create({ agentId: imp.agent.id, runId: "run-ok", manifestName: "Analyst" });
    h.rt.runRegistry.update("run-ok", { status: "completed", finishedAt: Date.now() });

    const before = h.rt.runRegistry.list().length;
    const res = await fetch(`${h.base}/api/runs/run-ok/propose-fix`, { method: "POST", headers: authed, body: "{}" });
    assert.equal(res.status, 409, "completed runs cannot be 'fixed'");
    assert.equal(h.rt.runRegistry.list().length, before, "proposing started no new run");
  } finally { await h.close(); }
});

test("propose-fix on a failed run with no LLM returns 503 — and still starts no run", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(oneNode("Analyst"));
    assert.ok(imp.ok);
    h.rt.runRegistry.create({ agentId: imp.agent.id, runId: "run-bad", manifestName: "Analyst" });
    h.rt.runRegistry.update("run-bad", { status: "failed", finishedAt: Date.now(), reason: "boom" });

    const before = h.rt.runRegistry.list().length;
    // No LLM configured in the test env → the diagnose/rebuild path is unavailable, but the
    // route must fail SAFELY (no run created), proving propose is side-effect-free until accept.
    const res = await fetch(`${h.base}/api/runs/run-bad/propose-fix`, { method: "POST", headers: authed, body: "{}" });
    assert.ok(res.status === 503 || res.status === 502, `unavailable without an LLM, got ${res.status}`);
    assert.equal(h.rt.runRegistry.list().length, before, "a failed proposal started no run");
  } finally { await h.close(); }
});
