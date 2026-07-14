/**
 * Acceptance e2e — the two end-to-end journeys from the build plan, driven through the REAL
 * server against a real runtime (fake plugins, no LLM/network). These are the "does the whole
 * thing hang together" checks, above the per-route unit tests.
 *
 *   A (Artifacts):   run → inbox → rendered → share → works logged-out → revoke → 404 → run reachable
 *   B (Front door):  enable public → page loads → widget/ask answers → disable kills everything
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
import type { CapabilityPlugin } from "../core/capability/capability.js";
import type { Manifest } from "../core/manifest/manifest.js";

const TOKEN = "test-admin-token";
const authState: AuthState = { tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"), generated: false };
const authed = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function composeManifest(name: string): Manifest {
  return {
    version: 1, name, intent: "write a short brief", entry: "compose",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "title=compose.title,body=compose.body,format=markdown" },
    nodes: [{ id: "compose", role: "write", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 10 }] }],
    edges: [],
  };
}

interface Harness { base: string; rt: KrelvanRuntime; close: () => Promise<void>; }
async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-accept-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const think: CapabilityPlugin = { name: "think", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output: { title: "Small Open-Weight Models", body: "**BLUF:** they are production-viable for many tasks." }, claimedCostCents: 1 }; } };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["think", think]]));
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

async function waitForArtifact(rt: KrelvanRuntime, runId: string, ms = 3000): Promise<string | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const a = rt.artifactStore.getByRun(runId);
    if (a) return a.id;
    await new Promise(r => setTimeout(r, 20));
  }
  return undefined;
}

// ── Acceptance A: the artifact journey ────────────────────────────────────────────

test("ACCEPTANCE A: run → inbox artifact → rendered → share (logged-out) → revoke → 404 → run reachable", async () => {
  const h = await harness();
  try {
    // Install an agent and run it.
    const imp = h.rt.importManifest(composeManifest("Research Analyst"));
    assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
    const agentId = imp.agent.id;
    const start = await fetch(`${h.base}/api/runs`, { method: "POST", headers: authed, body: JSON.stringify({ agentId }) });
    assert.equal(start.status, 201);
    const runId = (await start.json() as { run: { runId: string } }).run.runId;

    // The completed run produced an artifact — it's in the Inbox feed.
    const artId = await waitForArtifact(h.rt, runId);
    assert.ok(artId, "an artifact was produced");
    const inbox = await (await fetch(`${h.base}/api/artifacts`, { headers: authed })).json() as { artifacts: { id: string; runId: string }[] };
    assert.ok(inbox.artifacts.some(a => a.id === artId && a.runId === runId), "the artifact appears in the Inbox feed");

    // Open the rendered artifact (admin) — it links back to the run.
    const rendered = await (await fetch(`${h.base}/api/artifacts/${artId}`, { headers: authed })).json() as { artifact: { title: string; runId: string } };
    assert.equal(rendered.artifact.runId, runId, "the artifact points back at its run (how this was made)");
    assert.ok(rendered.artifact.title.length > 0);

    // Mint a share link → it resolves LOGGED-OUT and leaks no internal ids.
    const mint = await (await fetch(`${h.base}/api/artifacts/${artId}/share`, { method: "POST", headers: authed })).json() as { token: string };
    const shared = await fetch(`${h.base}/api/share/${mint.token}`); // NO auth
    assert.equal(shared.status, 200, "share link works logged-out");
    const body = await shared.json() as Record<string, unknown>;
    assert.equal(body["runId"], undefined, "share payload leaks no runId");
    assert.equal(body["id"], undefined, "share payload leaks no artifact id");

    // Revoke → the link 404s.
    const revoke = await fetch(`${h.base}/api/artifacts/${artId}/share`, { method: "DELETE", headers: authed });
    assert.equal(revoke.status, 200);
    assert.equal((await fetch(`${h.base}/api/share/${mint.token}`)).status, 404, "revoked link 404s");

    // The run record is still reachable from the admin.
    assert.equal((await fetch(`${h.base}/api/runs/${runId}`, { headers: authed })).status, 200, "the run record stays reachable");
  } finally { await h.close(); }
});

// ── Acceptance B: the front-door journey ──────────────────────────────────────────

test("ACCEPTANCE B: enable public → page loads → ask answers → disable kills page, feed, ask instantly", async () => {
  const h = await harness();
  try {
    const imp = h.rt.importManifest(composeManifest("Support Bot"));
    assert.ok(imp.ok);
    const agentId = imp.agent.id;
    const slug = imp.agent.slug!;

    // Before enabling: the public page 404s.
    assert.equal((await fetch(`${h.base}/api/public/agents/${slug}`)).status, 404, "private by default");

    // Enable public + feed + chat → mints a site key.
    const enabled = await (await fetch(`${h.base}/api/agents/${agentId}/public`, {
      method: "PUT", headers: authed, body: JSON.stringify({ enabled: true, showFeed: true, chat: true }),
    })).json() as { siteKey: string };
    const key = enabled.siteKey;
    assert.ok(key?.startsWith("pk_"));

    // The public page loads (logged-out) and advertises chat + feed + the site key.
    const profile = await (await fetch(`${h.base}/api/public/agents/${slug}`)).json() as { name: string; chatEnabled: boolean; feedEnabled: boolean; siteKey?: string };
    assert.equal(profile.chatEnabled, true);
    assert.equal(profile.feedEnabled, true);
    assert.ok(profile.siteKey, "the storefront gets the key to chat");

    // The widget/page asks a question and gets a reply (site-key-authed).
    const ask = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hello", siteKey: key }) });
    assert.equal(ask.status, 200, "a public ask returns a reply");
    const reply = await ask.json() as Record<string, unknown>;
    assert.ok(typeof reply["reply"] === "string" && (reply["reply"] as string).length > 0);
    assert.equal(reply["runId"], undefined, "no runId in the public reply");

    // Produce a deliverable artifact (a normal run — chat asks never become artifacts), publish
    // it, and confirm it shows on the feed.
    const runStart = await fetch(`${h.base}/api/runs`, { method: "POST", headers: authed, body: JSON.stringify({ agentId }) });
    const feedRunId = (await runStart.json() as { run: { runId: string } }).run.runId;
    const feedArtId = await waitForArtifact(h.rt, feedRunId);
    assert.ok(feedArtId, "a normal run produced an artifact to publish");
    await fetch(`${h.base}/api/artifacts/${feedArtId}`, { method: "PATCH", headers: authed, body: JSON.stringify({ published: true }) });
    const feed = await (await fetch(`${h.base}/api/public/agents/${slug}/feed`)).json() as { items: unknown[] };
    assert.ok(feed.items.length >= 1, "the published output shows on the feed");

    // DISABLE everything → page, feed, ask all 404 instantly (even with the old key).
    await fetch(`${h.base}/api/agents/${agentId}/public`, { method: "PUT", headers: authed, body: JSON.stringify({ enabled: false, showFeed: false, chat: false }) });
    assert.equal((await fetch(`${h.base}/api/public/agents/${slug}`)).status, 404, "page killed");
    assert.equal((await fetch(`${h.base}/api/public/agents/${slug}/feed`)).status, 404, "feed killed");
    const askAfter = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", siteKey: key }) });
    assert.equal(askAfter.status, 404, "ask killed — even with the old key");
  } finally { await h.close(); }
});
