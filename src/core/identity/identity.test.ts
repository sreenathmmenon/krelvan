/**
 * Identity, Secrets & Time tests. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MonotonicClock, logicalClockSource } from "./clock.js";
import { HmacKeyring } from "../ledger/crypto.js";
import { IdentityManager, SecretBroker } from "./identity.js";

function timeSigner() {
  const ring = new HmacKeyring();
  return ring.addKey("time", "t-secret", { epoch: 1, validFrom: 0, validUntil: null });
}

// ── clock ────────────────────────────────────────────────────────────────────

test("TIME: monotonic clock never goes backward even if source jumps back", () => {
  let raw = 100;
  const clock = new MonotonicClock(() => raw, timeSigner());
  assert.equal(clock.now(), 100);
  raw = 50; // wall clock jumps BACKWARD (NTP step / attacker)
  const t = clock.now();
  assert.ok(t > 100, `expected > 100, got ${t}`);
  assert.equal(clock.observedBackwardSteps, 1);
});

test("TIME: monotonic clock advances with a forward source", () => {
  const clock = new MonotonicClock(logicalClockSource(), timeSigner());
  const a = clock.now();
  const b = clock.now();
  const c = clock.now();
  assert.ok(a < b && b < c);
  assert.equal(clock.observedBackwardSteps, 0);
});

test("TIME: notarized tick is signed and verifies", () => {
  const ring = new HmacKeyring();
  const signer = ring.addKey("time", "t-secret", { epoch: 1, validFrom: 0, validUntil: null });
  const clock = new MonotonicClock(logicalClockSource(), signer);
  const tick = clock.tick();
  const v = ring.verify(`tick:${tick.t}`, tick.sig);
  assert.ok(v.ok);
});

// ── key lifecycle ──────────────────────────────────────────────────────────────

test("IDENTITY: a signature verifies within its key's window", () => {
  const im = new IdentityManager();
  const signer = im.issue("owner", "s", 10);
  const sig = signer.sign("sha256:abc", 20);
  assert.ok(im.verifier.verify("sha256:abc", sig).ok);
});

test("IDENTITY: revocation rejects signatures dated after revoke, keeps prior ones", () => {
  const im = new IdentityManager();
  const signer = im.issue("owner", "s", 10);

  const before = signer.sign("sha256:old", 20); // signed at t=20
  im.revoke("owner", 30); // revoked at t=30

  // a signature dated before revocation still verifies (history is immutable)
  assert.ok(im.verifier.verify("sha256:old", before).ok);

  // a signature dated AFTER revocation is rejected
  const after = signer.sign("sha256:new", 40);
  const res = im.verifier.verify("sha256:new", after);
  assert.ok(!res.ok && res.reason === "out_of_window");
});

test("IDENTITY: rotation issues a new epoch; old-epoch pre-rotation sigs still verify", () => {
  const im = new IdentityManager();
  const s1 = im.issue("owner", "secret-1", 10);
  const oldSig = s1.sign("sha256:x", 15); // epoch 1, before rotation
  const s2 = im.rotate("owner", "secret-2", 20); // rotate at t=20

  assert.ok(im.verifier.verify("sha256:x", oldSig).ok, "pre-rotation sig still valid");

  const newSig = s2.sign("sha256:y", 25); // epoch 2
  assert.ok(im.verifier.verify("sha256:y", newSig).ok, "new epoch sig valid");

  assert.equal(im.record("owner", 1)?.status, "rotated");
  assert.equal(im.record("owner", 2)?.status, "active");
});

// ── secret broker ────────────────────────────────────────────────────────────────

test("SECRETS: broker mints a scoped token, never reveals the secret", () => {
  const broker = new SecretBroker();
  broker.setSecret("api.example.com", "super-secret-key");
  const allow = new Set(["api.example.com"]);
  const tok = broker.mint("api.example.com", allow, 100, 60);
  assert.ok(tok);
  assert.equal(tok!.destination, "api.example.com");
  // the token is NOT the secret
  assert.notEqual(tok!.token, "super-secret-key");
  assert.ok(!JSON.stringify(tok).includes("super-secret-key"));
});

test("SECRETS: deny-by-default — destination not in allowlist gets no token", () => {
  const broker = new SecretBroker();
  broker.setSecret("evil.example.com", "k");
  const allow = new Set(["good.example.com"]);
  assert.equal(broker.mint("evil.example.com", allow, 100), null);
});

test("SECRETS: token expires and fails validation after expiry", () => {
  const broker = new SecretBroker();
  broker.setSecret("api.example.com", "k");
  const allow = new Set(["api.example.com"]);
  const tok = broker.mint("api.example.com", allow, 100, 10)!;
  assert.ok(broker.validate(tok, "api.example.com", 105)); // before expiry
  assert.ok(!broker.validate(tok, "api.example.com", 200)); // after expiry
  assert.ok(!broker.validate(tok, "other.com", 105)); // wrong destination
});
