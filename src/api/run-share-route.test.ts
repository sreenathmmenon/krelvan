/**
 * Run-share PUBLIC route: GET /api/run-share/:token resolves a run's one-pager LOGGED-OUT and
 * leaks no internal ids; an unknown/revoked token 404s. We seed the share directly on the
 * registry (the LLM generation path is exercised separately/live), then drive the real server.
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

function oneNode(name: string): Manifest {
  return {
    version: 1, name, intent: "do a thing", entry: "n1",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "title=n1.title,body=n1.body,format=markdown" },
    nodes: [{ id: "n1", role: "do it", autonomy: "full", capabilities: [] }],
    edges: [],
  };
}

async function harness(): Promise<{ base: string; rt: KrelvanRuntime; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-runshare-route-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

test("public run-share resolves logged-out with only the safe shape; no runId leak", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(oneNode("Research Analyst"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    h.rt.runRegistry.create({ agentId: imp.agent.id, runId: "run-x", manifestName: "Research Analyst" });
    h.rt.runRegistry.update("run-x", { status: "completed", finishedAt: Date.now() });

    // Seed the share directly (skip the LLM); the public route just reads the cached one-pager.
    const token = h.rt.runRegistry.mintShare("run-x", "The agent did the thing and finished.")!;

    const res = await fetch(`${h.base}/api/run-share/${token}`); // NO auth
    assert.equal(res.status, 200, "resolves logged-out");
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body["agentName"], "Research Analyst");
    assert.equal(body["status"], "completed");
    assert.equal(body["explanation"], "The agent did the thing and finished.");
    assert.equal(body["runId"], undefined, "no runId leaks");
    assert.equal(body["id"], undefined, "no internal id leaks");
  } finally { await h.close(); }
});

test("an unknown or revoked run-share token 404s", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(oneNode("Analyst"));
    assert.ok(imp.ok);
    h.rt.runRegistry.create({ agentId: imp.agent.id, runId: "run-y", manifestName: "Analyst" });
    const token = h.rt.runRegistry.mintShare("run-y", "one-pager")!;

    assert.equal((await fetch(`${h.base}/api/run-share/totally-wrong`)).status, 404, "unknown token 404s");

    // Revoke through the real server (admin, bearer-authed), then the link 404s.
    const del = await fetch(`${h.base}/api/runs/run-y/share`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${h.base}/api/run-share/${token}`)).status, 404, "revoked token 404s");
  } finally { await h.close(); }
});
