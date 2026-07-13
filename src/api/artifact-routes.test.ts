/**
 * A4 route tests — exercise the artifact API through the REAL server (real routing + real
 * auth gate). A bearer-token AuthState stands in for the admin session; the public share
 * route is hit with NO credential to prove it is allowlisted and leaks no internal ids.
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

const TOKEN = "test-admin-token";
const authState: AuthState = { tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"), generated: false };

interface Harness { base: string; close: () => Promise<void>; rt: KrelvanRuntime; }

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-artifact-routes-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const server = createApiServer(rt, authState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    rt,
    close: () => new Promise<void>((resolve) => { server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); }); }),
  };
}

const authed = { Authorization: `Bearer ${TOKEN}` };

function seedArtifact(rt: KrelvanRuntime, over: Partial<{ runId: string; title: string; body: string }> = {}) {
  return rt.artifactStore.create({
    agentId: "agent-1",
    agentName: "Research Analyst",
    runId: over.runId ?? "run-1",
    title: over.title ?? "The Brief",
    body: over.body ?? "The full brief body.",
    format: "markdown",
  });
}

test("A4: GET /api/artifacts requires auth; returns newest-first when authed", async () => {
  const h = await harness();
  try {
    seedArtifact(h.rt, { runId: "r1", title: "First" });
    seedArtifact(h.rt, { runId: "r2", title: "Second" });

    const noAuth = await fetch(`${h.base}/api/artifacts`);
    assert.equal(noAuth.status, 401, "unauthenticated list is rejected");

    const ok = await fetch(`${h.base}/api/artifacts`, { headers: authed });
    assert.equal(ok.status, 200);
    const { artifacts } = await ok.json() as { artifacts: { title: string }[] };
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0]!.title, "Second", "newest first");
  } finally { await h.close(); }
});

test("A4: list filters (agentId, archived, q, limit) reach the store", async () => {
  const h = await harness();
  try {
    const a = seedArtifact(h.rt, { runId: "r1", title: "alpha unique-term" });
    seedArtifact(h.rt, { runId: "r2", title: "beta" });
    await fetch(`${h.base}/api/artifacts/${a.id}`, { method: "PATCH", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });

    const q = await (await fetch(`${h.base}/api/artifacts?q=unique-term`, { headers: authed })).json() as { artifacts: unknown[] };
    assert.equal(q.artifacts.length, 1, "q filter");
    const arch = await (await fetch(`${h.base}/api/artifacts?archived=true`, { headers: authed })).json() as { artifacts: unknown[] };
    assert.equal(arch.artifacts.length, 1, "archived filter");
    const lim = await (await fetch(`${h.base}/api/artifacts?limit=1`, { headers: authed })).json() as { artifacts: unknown[] };
    assert.equal(lim.artifacts.length, 1, "limit");
  } finally { await h.close(); }
});

test("A4: GET/PATCH/DELETE /api/artifacts/:id", async () => {
  const h = await harness();
  try {
    const a = seedArtifact(h.rt);
    const got = await fetch(`${h.base}/api/artifacts/${a.id}`, { headers: authed });
    assert.equal(got.status, 200);

    const patched = await fetch(`${h.base}/api/artifacts/${a.id}`, {
      method: "PATCH", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify({ read: true, archived: true }),
    });
    assert.equal(patched.status, 200);
    const { artifact } = await patched.json() as { artifact: { archived: boolean; readAt?: number } };
    assert.equal(artifact.archived, true);
    assert.ok(artifact.readAt !== undefined, "read stamped");

    assert.equal((await fetch(`${h.base}/api/artifacts/nope`, { headers: authed })).status, 404);

    const del = await fetch(`${h.base}/api/artifacts/${a.id}`, { method: "DELETE", headers: authed });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${h.base}/api/artifacts/${a.id}`, { headers: authed })).status, 404, "gone after delete");
  } finally { await h.close(); }
});

test("A4: share mint → public GET works logged-out → revoke → 404", async () => {
  const h = await harness();
  try {
    const a = seedArtifact(h.rt, { title: "Shared Brief", body: "public body" });

    const mint = await fetch(`${h.base}/api/artifacts/${a.id}/share`, { method: "POST", headers: authed });
    assert.equal(mint.status, 201);
    const { token, url } = await mint.json() as { token: string; url: string };
    assert.ok(token.length > 20 && url === `/share/${token}`);

    // PUBLIC — no auth header at all.
    const pub = await fetch(`${h.base}/api/share/${token}`);
    assert.equal(pub.status, 200, "share resolves with no session");
    const shared = await pub.json() as Record<string, unknown>;
    assert.equal(shared["title"], "Shared Brief");
    assert.equal(shared["body"], "public body");
    assert.equal(shared["agentName"], "Research Analyst");
    // Must NOT leak internal ids.
    assert.equal(shared["runId"], undefined, "runId never exposed");
    assert.equal(shared["id"], undefined, "internal id never exposed");
    assert.equal(shared["shareTokenHash"], undefined, "hash never exposed");

    // Revoke kills the link.
    const rev = await fetch(`${h.base}/api/artifacts/${a.id}/share`, { method: "DELETE", headers: authed });
    assert.equal(rev.status, 200);
    assert.equal((await fetch(`${h.base}/api/share/${token}`)).status, 404, "revoked token 404s");
  } finally { await h.close(); }
});

test("A4: an invalid/unknown share token 404s (constant-time path, no info leak)", async () => {
  const h = await harness();
  try {
    seedArtifact(h.rt);
    const r = await fetch(`${h.base}/api/share/not-a-real-token`);
    assert.equal(r.status, 404);
    const body = await r.json() as { error: string };
    assert.equal(body.error, "not found", "generic message — no oracle");
  } finally { await h.close(); }
});

test("A4: rotating the share link invalidates the old token", async () => {
  const h = await harness();
  try {
    const a = seedArtifact(h.rt);
    const t1 = (await (await fetch(`${h.base}/api/artifacts/${a.id}/share`, { method: "POST", headers: authed })).json() as { token: string }).token;
    const t2 = (await (await fetch(`${h.base}/api/artifacts/${a.id}/share`, { method: "POST", headers: authed })).json() as { token: string }).token;
    assert.notEqual(t1, t2);
    assert.equal((await fetch(`${h.base}/api/share/${t1}`)).status, 404, "old token dead");
    assert.equal((await fetch(`${h.base}/api/share/${t2}`)).status, 200, "new token live");
  } finally { await h.close(); }
});

test("C1: GET /api/status exposes the server timezone (for schedule display)", async () => {
  const h = await harness();
  try {
    // Public endpoint — no auth needed.
    const res = await fetch(`${h.base}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as { serverTz?: string };
    assert.ok(typeof body.serverTz === "string" && body.serverTz.length > 0, "serverTz must be a non-empty string");
  } finally { await h.close(); }
});

test("C2: GET /api/schedules/:id/runs returns only that schedule's runs (auth-gated; 404 when absent)", async () => {
  const h = await harness();
  try {
    // Seed a schedule record + two runs attributed to it, plus an unrelated run.
    h.rt.scheduleRegistry.create({ id: "sch-1", agentId: "agent-1", agentName: "Digest", kind: "interval", spec: "3600000", label: "hourly", enabled: true, createdAt: 0 });
    h.rt.runRegistry.create({ agentId: "agent-1", runId: "r-a", manifestName: "Digest", origin: { kind: "schedule", scheduleId: "sch-1" } });
    h.rt.runRegistry.create({ agentId: "agent-1", runId: "r-b", manifestName: "Digest", origin: { kind: "schedule", scheduleId: "sch-1" } });
    h.rt.runRegistry.create({ agentId: "agent-1", runId: "r-c", manifestName: "Digest", origin: { kind: "schedule", scheduleId: "OTHER" } });
    h.rt.runRegistry.create({ agentId: "agent-1", runId: "r-manual", manifestName: "Digest" });

    assert.equal((await fetch(`${h.base}/api/schedules/sch-1/runs`)).status, 401, "history requires auth");

    const res = await fetch(`${h.base}/api/schedules/sch-1/runs`, { headers: authed });
    assert.equal(res.status, 200);
    const { runs } = await res.json() as { runs: { runId: string }[] };
    assert.equal(runs.length, 2, "only this schedule's runs");
    assert.deepEqual(runs.map(r => r.runId).sort(), ["r-a", "r-b"]);

    assert.equal((await fetch(`${h.base}/api/schedules/missing/runs`, { headers: authed })).status, 404, "unknown schedule 404s");
  } finally { await h.close(); }
});
