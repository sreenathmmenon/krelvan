import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerStore } from "./trigger-store.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "krelvan-trigger-"));
}

test("TriggerStore: mints a token that verifies, and rejects wrong/absent tokens", () => {
  const dir = freshDir();
  try {
    const store = new TriggerStore(dir);
    assert.equal(store.has("agent-1"), false);
    const token = store.mint("agent-1");
    assert.ok(token.length > 20, "token is non-trivial");
    assert.equal(store.has("agent-1"), true);
    assert.equal(store.verify("agent-1", token), true, "correct token verifies");
    assert.equal(store.verify("agent-1", "nope"), false, "wrong token rejected");
    assert.equal(store.verify("agent-1", undefined), false, "missing token rejected");
    assert.equal(store.verify("agent-2", token), false, "token is scoped to its agent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TriggerStore: never persists the plaintext token (only the hash)", () => {
  const dir = freshDir();
  try {
    const store = new TriggerStore(dir);
    const token = store.mint("agent-1");
    const onDisk = readFileSync(join(dir, "triggers.json"), "utf8");
    assert.ok(!onDisk.includes(token), "plaintext token must NOT appear on disk");
    assert.ok(onDisk.includes("tokenHash"), "only the hash is stored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TriggerStore: rotating invalidates the previous token", () => {
  const dir = freshDir();
  try {
    const store = new TriggerStore(dir);
    const first = store.mint("agent-1");
    const second = store.mint("agent-1");
    assert.notEqual(first, second);
    assert.equal(store.verify("agent-1", first), false, "old token no longer valid");
    assert.equal(store.verify("agent-1", second), true, "new token valid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TriggerStore: revoke disables the webhook; survives reload from disk", () => {
  const dir = freshDir();
  try {
    const token = new TriggerStore(dir).mint("agent-1");
    // reload (simulates restart) — token still valid because the hash persisted
    const reloaded = new TriggerStore(dir);
    assert.equal(reloaded.verify("agent-1", token), true, "token survives restart");
    assert.equal(reloaded.revoke("agent-1"), true);
    assert.equal(reloaded.verify("agent-1", token), false, "revoked token rejected");
    assert.equal(new TriggerStore(dir).has("agent-1"), false, "revocation persisted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
