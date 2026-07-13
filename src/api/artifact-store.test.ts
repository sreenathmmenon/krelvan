import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, type ArtifactInput } from "./artifact-store.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "krelvan-artifact-"));
}

function sampleInput(over: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    agentId: "agent-1",
    agentName: "Research Analyst",
    runId: "run-1",
    title: "Small Open-Weight Models",
    body: "BLUF: they are production-viable.",
    format: "markdown",
    ...over,
  };
}

test("ArtifactStore: create + get + list newest-first", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const a = store.create(sampleInput({ runId: "run-1" }));
    const b = store.create(sampleInput({ runId: "run-2", title: "Second" }));
    assert.ok(a.id.startsWith("art_"), "id is prefixed");
    assert.equal(store.get(a.id)?.title, "Small Open-Weight Models");
    const list = store.list();
    assert.equal(list.length, 2);
    // b was created after a → newest first
    assert.equal(list[0]?.id, b.id, "newest first");
    assert.equal(list[1]?.id, a.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: creation is idempotent by runId (no duplicates on re-fold)", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const first = store.create(sampleInput({ runId: "run-x", title: "Original" }));
    const second = store.create(sampleInput({ runId: "run-x", title: "DIFFERENT — should be ignored" }));
    assert.equal(second.id, first.id, "same run → same artifact");
    assert.equal(second.title, "Original", "the original record is returned unchanged");
    assert.equal(store.list().length, 1, "exactly one artifact for the run");
    assert.equal(store.getByRun("run-x")?.id, first.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: title is clamped to 120 chars", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const long = "x".repeat(200);
    const a = store.create(sampleInput({ title: long }));
    assert.equal(a.title.length, 120, "clamped to 120");
    assert.ok(a.title.endsWith("…"), "ellipsized");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: list filters by agentId, archived, q, before, limit", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const a = store.create(sampleInput({ runId: "r1", agentId: "A", title: "alpha keyword-zed", body: "" }));
    const b = store.create(sampleInput({ runId: "r2", agentId: "B", title: "beta", body: "no match" }));
    store.create(sampleInput({ runId: "r3", agentId: "A", title: "gamma", body: "" }));

    assert.equal(store.list({ agentId: "A" }).length, 2, "agentId filter");
    assert.equal(store.list({ q: "keyword-zed" }).length, 1, "q matches title substring");
    assert.equal(store.list({ q: "KEYWORD-ZED" }).length, 1, "q is case-insensitive");
    assert.equal(store.list({ limit: 1 }).length, 1, "limit caps results");

    store.update(b.id, { archived: true });
    assert.equal(store.list({ archived: false }).length, 2, "archived=false excludes archived");
    assert.equal(store.list({ archived: true }).length, 1, "archived=true selects archived");

    // before: nothing is strictly before the oldest record's own timestamp
    assert.equal(store.list({ before: a.createdAt }).length, 0, "before excludes >= boundary");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: update archive/read state (read stamps once)", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const a = store.create(sampleInput());
    assert.equal(a.archived, false);
    assert.equal(a.readAt, undefined);

    const read1 = store.update(a.id, { read: true });
    assert.ok(read1?.readAt !== undefined, "read stamps readAt");
    const stamp = read1!.readAt;
    const read2 = store.update(a.id, { read: true });
    assert.equal(read2?.readAt, stamp, "re-marking read keeps the original stamp");

    const unread = store.update(a.id, { read: false });
    assert.equal(unread?.readAt, undefined, "unread clears the stamp");

    const arch = store.update(a.id, { archived: true });
    assert.equal(arch?.archived, true);
    assert.equal(store.update("nope", { archived: true }), undefined, "missing id → undefined");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: delete removes the record and frees the runId", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const a = store.create(sampleInput({ runId: "run-del" }));
    assert.equal(store.delete(a.id), true);
    assert.equal(store.get(a.id), undefined);
    assert.equal(store.getByRun("run-del"), undefined, "runId index cleared");
    assert.equal(store.delete(a.id), false, "second delete is a no-op");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: share mint/resolve/revoke; plaintext never persisted", () => {
  const dir = freshDir();
  try {
    const store = new ArtifactStore(dir);
    const a = store.create(sampleInput());
    assert.equal(store.resolveShare("anything"), undefined, "no live token → no match");

    const token = store.mintShare(a.id);
    assert.ok(token && token.length > 20, "mint returns a non-trivial token");
    assert.equal(store.resolveShare(token)?.id, a.id, "correct token resolves the artifact");
    assert.equal(store.resolveShare("wrong-token"), undefined, "wrong token rejected");
    assert.equal(store.resolveShare(undefined), undefined, "absent token rejected");

    const onDisk = readFileSync(join(dir, "artifacts.json"), "utf8");
    assert.ok(!onDisk.includes(token!), "plaintext share token must NOT appear on disk");
    assert.ok(onDisk.includes("shareTokenHash"), "only the hash is stored");

    // rotate invalidates the old link
    const token2 = store.mintShare(a.id);
    assert.notEqual(token, token2);
    assert.equal(store.resolveShare(token), undefined, "rotated: old token dead");
    assert.equal(store.resolveShare(token2)?.id, a.id, "rotated: new token live");

    // revoke kills it
    assert.equal(store.revokeShare(a.id), true);
    assert.equal(store.resolveShare(token2), undefined, "revoked token no longer resolves");
    assert.equal(store.revokeShare(a.id), false, "second revoke is a no-op");
    assert.equal(store.mintShare("missing"), undefined, "mint on missing id → undefined");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ArtifactStore: survives reload from disk (records, indexes, share hashes)", () => {
  const dir = freshDir();
  try {
    const token = (() => {
      const s = new ArtifactStore(dir);
      const a = s.create(sampleInput({ runId: "run-persist" }));
      s.update(a.id, { read: true, archived: true });
      return s.mintShare(a.id)!;
    })();

    const reloaded = new ArtifactStore(dir);
    const a = reloaded.getByRun("run-persist");
    assert.ok(a, "record survives restart");
    assert.equal(a!.archived, true, "archive state persisted");
    assert.ok(a!.readAt !== undefined, "read state persisted");
    assert.equal(reloaded.resolveShare(token)?.id, a!.id, "share token survives restart");
    // idempotency index survives too
    const again = reloaded.create(sampleInput({ runId: "run-persist", title: "dup" }));
    assert.equal(again.id, a!.id, "no duplicate after reload");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
