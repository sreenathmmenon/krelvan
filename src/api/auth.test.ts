/**
 * Auth tests — token generation/persistence, the authenticate() gate, public allowlist,
 * constant-time match, and per-IP lockout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { initAuth, authenticate } from "./auth.js";

function dir(): string { return mkdtempSync(join(tmpdir(), "krelvan-auth-")); }

// Minimal IncomingMessage stub for the gate.
function req(headers: Record<string, string> = {}, ip = "1.2.3.4"): IncomingMessage {
  return { headers, socket: { remoteAddress: ip } } as unknown as IncomingMessage;
}
function url(path: string, query = ""): URL {
  return new URL(`http://localhost${path}${query}`);
}

test("initAuth: first run generates a token, persists only the HASH", () => {
  const d = dir();
  try {
    const s = initAuth(d);
    assert.equal(s.generated, true);
    assert.ok(s.freshPlaintext && s.freshPlaintext.length >= 40, "plaintext returned once");
    const stored = readFileSync(join(d, "auth.token"), "utf8").trim();
    assert.match(stored, /^[a-f0-9]{64}$/, "stored value is a sha256 hash");
    assert.notEqual(stored, s.freshPlaintext, "plaintext is NOT stored");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("initAuth: second run reuses the persisted hash, no new plaintext", () => {
  const d = dir();
  try {
    const first = initAuth(d);
    const second = initAuth(d);
    assert.equal(second.generated, false);
    assert.equal(second.freshPlaintext, undefined);
    assert.equal(second.tokenHash, first.tokenHash);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("initAuth: env token wins and is never written to disk", () => {
  const d = dir();
  try {
    process.env["KRELVAN_AUTH_TOKEN"] = "env-token-abc";
    const s = initAuth(d);
    assert.equal(s.generated, false);
    assert.equal(existsSync(join(d, "auth.token")), false, "no file written for env token");
  } finally {
    delete process.env["KRELVAN_AUTH_TOKEN"];
    rmSync(d, { recursive: true, force: true });
  }
});

test("authenticate: health is public", () => {
  const d = dir();
  try {
    const s = initAuth(d);
    assert.deepEqual(authenticate(req(), url("/api/health"), s), { ok: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("authenticate: rejects missing + wrong token, accepts correct token", () => {
  const d = dir();
  try {
    const s = initAuth(d);
    const tok = s.freshPlaintext!;
    // missing
    const miss = authenticate(req({}, "10.0.0.1"), url("/api/agents"), s);
    assert.equal(miss.ok, false);
    assert.equal((miss as { status: number }).status, 401);
    // wrong
    const wrong = authenticate(req({ authorization: "Bearer nope" }, "10.0.0.2"), url("/api/agents"), s);
    assert.equal(wrong.ok, false);
    // correct
    const right = authenticate(req({ authorization: `Bearer ${tok}` }, "10.0.0.3"), url("/api/agents"), s);
    assert.deepEqual(right, { ok: true });
    // correct via ?token= fallback
    const viaQuery = authenticate(req({}, "10.0.0.4"), url("/api/agents", `?token=${tok}`), s);
    assert.deepEqual(viaQuery, { ok: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("authenticate: locks out an IP after repeated failures", () => {
  const d = dir();
  try {
    const s = initAuth(d);
    const ip = "9.9.9.9";
    for (let i = 0; i < 10; i++) authenticate(req({ authorization: "Bearer bad" }, ip), url("/api/agents"), s);
    const locked = authenticate(req({ authorization: "Bearer bad" }, ip), url("/api/agents"), s);
    assert.equal(locked.ok, false);
    assert.equal((locked as { status: number }).status, 429);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
