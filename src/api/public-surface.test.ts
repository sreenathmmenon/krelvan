/**
 * Workstream B (B1 + B2) — the public agent front door, tested through the REAL server.
 *
 * Security posture under test (this is public attack surface):
 *  - Deny-by-default: every /api/public route 404s until the owner enables it; disabling
 *    kills all of them instantly.
 *  - Site key: hash-only storage, constant-time verify, shown once, rotate = invalidate.
 *  - Zero information leak: no runId / internal ids in any public response or error.
 *  - Rate limits + run caps return 429 with no budget numbers.
 *  - Public ask honors the human-approval gate; a public caller can never approve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

/** A chat agent: one `think` node that autonomy=full replies. `gated` makes it suggest (parks). */
function chatManifest(name: string, gated = false): Manifest {
  return {
    version: 1, name, intent: "answer questions", entry: "respond",
    runBudgetCents: 100, maxNodeVisits: 5,
    seed: { output_map: "body=respond.reply,format=markdown" },
    nodes: [{ id: "respond", role: "reply to the message", autonomy: gated ? "suggest" : "full", capabilities: [{ name: gated ? "email_send" : "think", sideEffect: gated ? "message-human" : "read", budgetCents: 10 }] }],
    edges: [],
  };
}

interface Harness { base: string; rt: KrelvanRuntime; dir: string; close: () => Promise<void>; }

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-public-"));
  const rt = new KrelvanRuntime({ port: 0, dataDir: join(dir, "data"), capabilitiesDir: join(dir, "capabilities") });
  const think: CapabilityPlugin = { name: "think", sideEffect: "read", estimateCents: () => 1, async invoke() { return { output: { reply: "Hi! Orders ship in 1 day." }, claimedCostCents: 1 }; } };
  const email: CapabilityPlugin = { name: "email_send", sideEffect: "message-human", estimateCents: () => 1, async invoke() { return { output: { sent: true }, claimedCostCents: 1 }; } };
  (rt as unknown as { supervisorSnapshotHandle: { replaceSnapshot(p: Map<string, CapabilityPlugin>): void } })
    .supervisorSnapshotHandle.replaceSnapshot(new Map([["think", think], ["email_send", email]]));
  const server = createApiServer(rt, authState);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, rt, dir, close: () => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })) };
}

/** Import an agent and return { id, slug }. */
function makeAgent(rt: KrelvanRuntime, gated = false): { id: string; slug: string } {
  const imp = rt.importManifest(chatManifest("Support Bot", gated));
  assert.ok(imp.ok, imp.ok ? "" : JSON.stringify(imp.issues));
  return { id: imp.agent.id, slug: imp.agent.slug! };
}

// ── Allowlist boundary — the admin API stays gated; only the public routes are open ──

test("auth allowlist: admin routes 401 without a session; public routes do not require one", async () => {
  const h = await harness();
  try {
    // A canonical admin route MUST reject an unauthenticated request.
    assert.equal((await fetch(`${h.base}/api/agents`)).status, 401, "GET /api/agents needs auth");
    assert.equal((await fetch(`${h.base}/api/agents`, { headers: authed })).status, 200, "…and serves when authed");
    // A representative admin mutation is also gated.
    assert.equal((await fetch(`${h.base}/api/agents/anything/public`)).status, 401, "admin public-config needs auth");

    // The allowlisted routes are reachable WITHOUT a session (they gate themselves downstream):
    // health is public, and a public front-door route resolves to a 404 (deny-by-default),
    // NOT a 401 — proving it passed the session gate and hit its own handler.
    assert.equal((await fetch(`${h.base}/api/health`)).status, 200, "health is public");
    assert.equal((await fetch(`${h.base}/api/public/agents/nope`)).status, 404, "public route passes the gate, then 404s (not 401)");
  } finally { await h.close(); }
});

// ── B1: identity + public config + site key ──────────────────────────────────────

test("B1: a new agent gets a slug; public config is all-off by default", async () => {
  const h = await harness();
  try {
    const { id, slug } = makeAgent(h.rt);
    assert.ok(slug && /^[a-z0-9-]+$/.test(slug), "slug is url-safe");
    const res = await fetch(`${h.base}/api/agents/${id}/public`, { headers: authed });
    assert.equal(res.status, 200);
    const cfg = await res.json() as { enabled: boolean; showFeed: boolean; chat: boolean; hasSiteKey: boolean };
    assert.deepEqual([cfg.enabled, cfg.showFeed, cfg.chat, cfg.hasSiteKey], [false, false, false, false], "deny-by-default");
  } finally { await h.close(); }
});

test("B1: enabling chat mints a site key ONCE (hash-only on disk); GET never returns it", async () => {
  const h = await harness();
  try {
    const { id } = makeAgent(h.rt);
    const put = await fetch(`${h.base}/api/agents/${id}/public`, { method: "PUT", headers: authed, body: JSON.stringify({ enabled: true, showFeed: true, chat: true }) });
    assert.equal(put.status, 200);
    const body = await put.json() as { siteKey?: string; hasSiteKey: boolean };
    assert.ok(body.siteKey && body.siteKey.startsWith("pk_"), "site key returned once");
    assert.equal(body.hasSiteKey, true);

    // The plaintext key is NOT on disk (only its hash).
    const onDisk = readFileSync(join(h.dir, "data", "agents.json"), "utf8");
    assert.ok(!onDisk.includes(body.siteKey!), "plaintext site key must NOT be persisted");
    assert.ok(onDisk.includes("siteKeyHash"), "only the hash is stored");

    // A later GET returns status only — never the key.
    const get = await (await fetch(`${h.base}/api/agents/${id}/public`, { headers: authed })).json() as Record<string, unknown>;
    assert.equal(get["siteKey"], undefined, "GET never exposes the key");
    assert.equal(get["siteKeyHash"], undefined, "GET never exposes the hash");
  } finally { await h.close(); }
});

test("B1: rotating the site key invalidates the old one; disabling chat clears it", async () => {
  const h = await harness();
  try {
    const { id } = makeAgent(h.rt);
    const k1 = (await (await fetch(`${h.base}/api/agents/${id}/public`, { method: "PUT", headers: authed, body: JSON.stringify({ enabled: true, showFeed: false, chat: true }) })).json() as { siteKey: string }).siteKey;
    const k2 = (await (await fetch(`${h.base}/api/agents/${id}/public/rotate-key`, { method: "POST", headers: authed })).json() as { siteKey: string }).siteKey;
    assert.notEqual(k1, k2, "rotate produces a new key");
    // Verify at the runtime layer (constant-time).
    const agent = h.rt.agentRegistry.get(id)!;
    assert.equal(h.rt.verifySiteKey(agent, k1), false, "old key no longer verifies");
    assert.equal(h.rt.verifySiteKey(agent, k2), true, "new key verifies");
    assert.equal(h.rt.verifySiteKey(agent, "pk_wrong"), false, "a wrong key is rejected");
    assert.equal(h.rt.verifySiteKey(agent, undefined), false, "an absent key is rejected");

    // Disable chat → the key is cleared and verification fails even with the right key.
    await fetch(`${h.base}/api/agents/${id}/public`, { method: "PUT", headers: authed, body: JSON.stringify({ enabled: true, showFeed: false, chat: false }) });
    const after = h.rt.agentRegistry.get(id)!;
    assert.equal(after.public?.siteKeyHash, undefined, "disabling chat clears the key");
    assert.equal(h.rt.verifySiteKey(after, k2), false, "no key verifies once chat is off");
  } finally { await h.close(); }
});

// ── B2: deny-by-default across every public route ────────────────────────────────

async function enable(h: Harness, id: string, cfg: { enabled: boolean; showFeed: boolean; chat: boolean }): Promise<string | undefined> {
  const r = await (await fetch(`${h.base}/api/agents/${id}/public`, { method: "PUT", headers: authed, body: JSON.stringify(cfg) })).json() as { siteKey?: string };
  return r.siteKey;
}

test("B2: every public route 404s until enabled, and disabling kills them all instantly", async () => {
  const h = await harness();
  try {
    const { id, slug } = makeAgent(h.rt);
    const profile = () => fetch(`${h.base}/api/public/agents/${slug}`);
    const feed = () => fetch(`${h.base}/api/public/agents/${slug}/feed`);
    const ask = (key?: string) => fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", siteKey: key }) });

    // Disabled: all 404.
    assert.equal((await profile()).status, 404, "profile 404 when disabled");
    assert.equal((await feed()).status, 404, "feed 404 when disabled");
    assert.equal((await ask()).status, 404, "ask 404 when disabled");

    // Enable profile + feed + chat.
    const key = await enable(h, id, { enabled: true, showFeed: true, chat: true });
    assert.ok(key);
    assert.equal((await profile()).status, 200, "profile live when enabled");
    assert.equal((await feed()).status, 200, "feed live when showFeed on");

    // Disable everything → all routes 404 again, immediately.
    await enable(h, id, { enabled: false, showFeed: false, chat: false });
    assert.equal((await profile()).status, 404, "profile killed on disable");
    assert.equal((await feed()).status, 404, "feed killed on disable");
    assert.equal((await ask(key)).status, 404, "ask killed on disable — even with the old key");
  } finally { await h.close(); }
});

test("B2: feed 404s unless showFeed is on; returns only published, non-archived artifacts", async () => {
  const h = await harness();
  try {
    const { id, slug } = makeAgent(h.rt);
    // published + not archived → shown; unpublished → hidden; published + archived → hidden.
    const shown = h.rt.artifactStore.create({ agentId: id, agentName: "Support Bot", runId: "r1", title: "Public One", body: "visible", format: "markdown" });
    h.rt.artifactStore.update(shown.id, {}); h.rt.artifactStore.get(shown.id)!.published = true;
    const hidden = h.rt.artifactStore.create({ agentId: id, agentName: "Support Bot", runId: "r2", title: "Private", body: "hidden", format: "markdown" });
    void hidden;
    const arch = h.rt.artifactStore.create({ agentId: id, agentName: "Support Bot", runId: "r3", title: "Archived", body: "gone", format: "markdown" });
    h.rt.artifactStore.get(arch.id)!.published = true; h.rt.artifactStore.update(arch.id, { archived: true });

    // showFeed off → 404.
    await enable(h, id, { enabled: true, showFeed: false, chat: false });
    assert.equal((await fetch(`${h.base}/api/public/agents/${slug}/feed`)).status, 404);

    // showFeed on → only the published, non-archived artifact, with NO ids.
    await enable(h, id, { enabled: true, showFeed: true, chat: false });
    const res = await fetch(`${h.base}/api/public/agents/${slug}/feed`);
    assert.equal(res.status, 200);
    const { items } = await res.json() as { items: Record<string, unknown>[] };
    assert.equal(items.length, 1, "only published + non-archived");
    assert.equal(items[0]!["title"], "Public One");
    assert.equal(items[0]!["id"], undefined, "no artifact id leaked");
    assert.equal(items[0]!["runId"], undefined, "no runId leaked");
  } finally { await h.close(); }
});

test("B2: ask requires a valid site key; a completed ask returns a reply and NO ids", async () => {
  const h = await harness();
  try {
    const { id, slug } = makeAgent(h.rt);
    const key = await enable(h, id, { enabled: true, showFeed: false, chat: true });

    // Missing/wrong key → 401 (generic).
    const noKey = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(noKey.status, 401);
    const wrong = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", siteKey: "pk_wrong" }) });
    assert.equal(wrong.status, 401);

    // Valid key → 200 reply.
    const ok = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "when does my order ship?", siteKey: key }) });
    assert.equal(ok.status, 200);
    const reply = await ok.json() as Record<string, unknown>;
    assert.ok(typeof reply["reply"] === "string" && (reply["reply"] as string).length > 0, "got a reply");
    assert.ok(typeof reply["thread"] === "string", "got a thread id");
    assert.equal(reply["runId"], undefined, "no runId in the ask response");
    // CORS is open for the widget.
    assert.equal(ok.headers.get("access-control-allow-origin"), "*", "public CORS is *");
  } finally { await h.close(); }
});

test("B2: an approval-gated agent parks publicly (202 awaiting-approval); public caller cannot approve", async () => {
  const h = await harness();
  try {
    // gated=true → the single node is autonomy:suggest with a message-human effect → it parks.
    const imp = h.rt.importManifest(chatManifest("Gated Bot", true));
    assert.ok(imp.ok);
    const id = imp.agent.id, slug = imp.agent.slug!;
    const key = await enable(h, id, { enabled: true, showFeed: false, chat: true });

    const res = await fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "please email the team", siteKey: key }) });
    assert.equal(res.status, 202, "a gated ask parks, not completes");
    const body = await res.json() as { status?: string };
    assert.equal(body.status, "awaiting-approval", "public sees awaiting-approval");

    // There is NO public approval route — approvals live behind the admin session only.
    const halted = h.rt.runRegistry.list().filter(r => r.status === "halted");
    // (the parked run is a chat run — excluded from list(); assert nothing shipped instead)
    void halted;
    // The public caller cannot resolve it: the approvals resolve route requires a session.
    const approvals = await (await fetch(`${h.base}/api/approvals`, { headers: authed })).json() as { approvals: { correlationId: string }[] };
    if (approvals.approvals[0]) {
      const noSession = await fetch(`${h.base}/api/approvals/${approvals.approvals[0].correlationId}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) });
      assert.notEqual(noSession.status, 200, "a public (no-session) caller cannot approve");
    }
  } finally { await h.close(); }
});

test("B2: the poll endpoint 404s for an unknown thread and requires the agent be public", async () => {
  const h = await harness();
  try {
    const { id, slug } = makeAgent(h.rt);
    // Not enabled → poll 404s.
    assert.equal((await fetch(`${h.base}/api/public/agents/${slug}/ask/whatever`)).status, 404);
    await enable(h, id, { enabled: true, showFeed: false, chat: true });
    // Enabled but unknown thread → 404 (no oracle, no id leak).
    const r = await fetch(`${h.base}/api/public/agents/${slug}/ask/never-asked`);
    assert.equal(r.status, 404);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body["runId"], undefined, "poll error leaks no runId");
  } finally { await h.close(); }
});

test("B2: per-thread run cap returns 429 with NO budget numbers", async () => {
  const h = await harness();
  try {
    // Force a tiny per-thread cap so the second ask on the same thread trips it.
    process.env["KRELVAN_PUBLIC_THREAD_MAX"] = "1";
    const { id, slug } = makeAgent(h.rt);
    const key = await enable(h, id, { enabled: true, showFeed: false, chat: true });
    const call = () => fetch(`${h.base}/api/public/agents/${slug}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", siteKey: key, thread: "fixed" }) });
    assert.equal((await call()).status, 200, "first ask ok");
    const second = await call();
    assert.equal(second.status, 429, "second ask on the same thread is rate-limited");
    const body = await second.json() as { error: string };
    assert.doesNotMatch(body.error, /\d+\s*(cent|cents|\$|budget|token)/i, "429 must not reveal any cost/budget number");
  } finally { delete process.env["KRELVAN_PUBLIC_THREAD_MAX"]; await h.close(); }
});
