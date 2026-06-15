/**
 * SecretStore tests — encryption round-trip, masking, env fallback, persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "./secret-store.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "krelvan-secret-"));
}

test("SecretStore: set + resolve round-trips the plaintext", () => {
  const dir = freshDir();
  try {
    const s = new SecretStore(dir);
    const r = s.set("vercel-deploy-hook", "https://api.vercel.com/v1/integrations/deploy/abc123");
    assert.equal(r.ok, true);
    assert.equal(s.resolve("vercel-deploy-hook"), "https://api.vercel.com/v1/integrations/deploy/abc123");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SecretStore: list never returns plaintext, only a mask", () => {
  const dir = freshDir();
  try {
    const s = new SecretStore(dir);
    s.set("api-key", "sk-secret-value-1234567890");
    const list = s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "api-key");
    assert.ok(!list[0]!.preview.includes("secret-value"), "preview must not contain the raw value");
    assert.ok(list[0]!.preview.includes("…"), "preview should be masked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SecretStore: persists across instances (encrypted at rest)", () => {
  const dir = freshDir();
  try {
    new SecretStore(dir).set("token", "hunter2-very-secret");
    const reopened = new SecretStore(dir);
    assert.equal(reopened.resolve("token"), "hunter2-very-secret");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SecretStore: resolve falls back to env when not set", () => {
  const dir = freshDir();
  try {
    process.env["krelvan-test-envsecret"] = "from-env";
    const s = new SecretStore(dir);
    assert.equal(s.has("krelvan-test-envsecret"), true);
    assert.equal(s.resolve("krelvan-test-envsecret"), "from-env");
  } finally {
    delete process.env["krelvan-test-envsecret"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SecretStore: a set secret wins over env", () => {
  const dir = freshDir();
  try {
    process.env["dup-secret"] = "env-value";
    const s = new SecretStore(dir);
    s.set("dup-secret", "stored-value");
    assert.equal(s.resolve("dup-secret"), "stored-value");
  } finally {
    delete process.env["dup-secret"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SecretStore: rejects empty value and invalid name", () => {
  const dir = freshDir();
  try {
    const s = new SecretStore(dir);
    assert.equal(s.set("ok-name", "   ").ok, false);
    assert.equal(s.set("bad name!", "value").ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SecretStore: delete removes the secret", () => {
  const dir = freshDir();
  try {
    const s = new SecretStore(dir);
    s.set("temp", "value");
    assert.equal(s.delete("temp"), true);
    assert.equal(s.has("temp"), false);
    assert.equal(s.delete("temp"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
