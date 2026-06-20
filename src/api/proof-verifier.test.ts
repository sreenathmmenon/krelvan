/**
 * Offline proof-verifier tests — exercises the REAL bin/krelvan-verify.mjs binary exactly
 * as a third party runs it (`npx krelvan verify <file>`), against a fixture proof bundle
 * exported from a live Ed25519 run.
 *
 * The whole "prove what they did" wedge rests on this binary: a recipient who holds only the
 * public keys can re-verify a signed run with zero trust in the issuing instance. These tests
 * lock in the two properties that matter:
 *   - a genuine bundle VERIFIES (exit 0, every Ed25519 signature checks out), and
 *   - any tampering is DETECTED (exit 1) — both a payload edit (content-address mismatch)
 *     and a signature swap.
 * If the verifier's canonicalization ever drifts from the core ledger's, the valid-bundle
 * test fails — which is exactly the regression we must catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VERIFIER = join(ROOT, "bin", "krelvan-verify.mjs");
const FIXTURE = join(ROOT, "test", "fixtures", "proof-ed25519.json");

function runVerifier(file: string, ...extra: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [VERIFIER, file, ...extra], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// Write the bundle's own public keys out as PEM files (what an auditor pins via --key).
function writeBundleKeys(bundle: { publicKeys: { publicKeyPem: string }[] }): string[] {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-keys-"));
  return bundle.publicKeys.map((k, i) => {
    const p = join(dir, `key${i}.pem`);
    writeFileSync(p, k.publicKeyPem);
    return p;
  });
}

function writeTemp(bundle: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-proof-"));
  const path = join(dir, "proof.json");
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  return path;
}

test("unpinned, a genuine bundle is CONSISTENT (not claimed authentic — keys came from the file)", () => {
  const { code, out } = runVerifier(FIXTURE);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /✓ CONSISTENT/);          // NOT "VERIFIED · authentic" without a pinned key
  assert.doesNotMatch(out, /✓ VERIFIED · authentic/);
  assert.match(out, /all \d+ valid/);          // signatures line
  assert.match(out, /self-included \(not pinned\)/); // honest key-trust line
  assert.match(out, /RunStarted → terminal/);  // run-boundary completeness line
});

test("pinned to the issuer's real keys, the same bundle is VERIFIED · authentic", () => {
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const keyArgs = writeBundleKeys(bundle).flatMap((p) => ["--key", p]);
  const { code, out } = runVerifier(FIXTURE, ...keyArgs);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /✓ VERIFIED · authentic/);
  assert.match(out, /matches pinned key/);
});

test("FORGERY: a re-signed bundle with the forger's own keys passes UNPINNED but is caught when pinned", () => {
  // Reproduce the attack: mint a fresh keypair, re-sign every event, embed the forger's pubkey.
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const forgerPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // canonicalize() must match the verifier's (sorted keys, integer-only, the LED-03 preimage)
  const canon = (v: unknown): string => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") return String(v);
    if (t === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (t === "object") { const o = v as Record<string, unknown>; return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}"; }
    return "null";
  };
  const pre = (e: any): string => canon({
    type: e.type, scope: { tenantId: e.scope.tenantId, runId: e.scope.runId, ...(e.scope.nodeId !== undefined ? { nodeId: e.scope.nodeId } : {}), branchId: e.scope.branchId },
    parents: [...(e.parents ?? [])], prev: e.prev ?? null, offset: e.offset, payload: e.payload, determinism: e.determinism, ts: e.ts, author: e.author,
  });
  for (const e of bundle.events) {
    e.payload = { ...e.payload, forged: true };
    e.id = "sha256:" + createHash("sha256").update(pre(e), "utf8").digest("hex");
    e.sig = { keyId: e.sig.keyId, epoch: e.sig.epoch, signedAt: e.sig.signedAt, value: edSign(null, Buffer.from(e.id, "utf8"), privateKey).toString("hex") };
  }
  bundle.publicKeys = bundle.publicKeys.map((k: { publicKeyPem: string }) => ({ ...k, publicKeyPem: forgerPem }));

  // UNPINNED: it IS internally consistent (the forger re-signed it), so CONSISTENT/exit 0 — but
  // the verifier never claims "authentic", which is the honest outcome.
  const forgedPath = writeTemp(bundle);
  const unpinned = runVerifier(forgedPath);
  assert.equal(unpinned.code, 0);
  assert.match(unpinned.out, /✓ CONSISTENT/);
  assert.doesNotMatch(unpinned.out, /authentic/);

  // PINNED to the REAL issuer keys: the forgery is caught.
  const realKeys = writeBundleKeys(JSON.parse(readFileSync(FIXTURE, "utf8"))).flatMap((p) => ["--key", p]);
  const pinned = runVerifier(forgedPath, ...realKeys);
  assert.equal(pinned.code, 1, `expected exit 1, got ${pinned.code}\n${pinned.out}`);
  assert.match(pinned.out, /✗ WRONG SIGNER/);
});

test("a head-truncated bundle (RunStarted dropped) is rejected — no lie by omission", () => {
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  bundle.events = bundle.events.slice(1); // drop the RunStarted
  if (bundle.verification) bundle.verification.runEvents = bundle.events.length;
  const { code, out } = runVerifier(writeTemp(bundle));
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /VERIFICATION FAILED/);
  assert.match(out, /RunStarted/);
});

test("a tail-truncated bundle (terminal event dropped) is rejected", () => {
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  bundle.events = bundle.events.slice(0, -1); // drop the terminal RunCompleted
  if (bundle.verification) bundle.verification.runEvents = bundle.events.length;
  const { code, out } = runVerifier(writeTemp(bundle));
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /VERIFICATION FAILED/);
  assert.match(out, /terminal/);
});

test("tampering with an event payload is detected (content-address mismatch)", () => {
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // Mutate a payload without recomputing the id/sig — exactly what a forger would try.
  bundle.events[1].payload = { ...bundle.events[1].payload, injected: "tampered" };
  const { code, out } = runVerifier(writeTemp(bundle));
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /VERIFICATION FAILED/);
  assert.match(out, /content address/i);
});

test("swapping a signature is detected (does not verify against the public key)", () => {
  const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // Replace a signature with another event's signature — valid hex, wrong message.
  const other = bundle.events.find((e: { sig?: { value: string } }, i: number) => i > 0 && e.sig);
  if (other && bundle.events[0].sig) bundle.events[0].sig.value = other.sig.value;
  const { code, out } = runVerifier(writeTemp(bundle));
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /VERIFICATION FAILED/);
});

test("a non-bundle file is rejected, not silently accepted", () => {
  const { code, out } = runVerifier(writeTemp({ hello: "world" }));
  assert.equal(code, 1);
  assert.match(out, /not a Krelvan proof bundle/i);
});
