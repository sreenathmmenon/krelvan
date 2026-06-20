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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VERIFIER = join(ROOT, "bin", "krelvan-verify.mjs");
const FIXTURE = join(ROOT, "test", "fixtures", "proof-ed25519.json");

function runVerifier(file: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [VERIFIER, file], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function writeTemp(bundle: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-proof-"));
  const path = join(dir, "proof.json");
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  return path;
}

test("a genuine Ed25519 proof bundle verifies offline (every signature valid)", () => {
  const { code, out } = runVerifier(FIXTURE);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /✓ VERIFIED/);
  assert.match(out, /all \d+ valid/); // signatures line
  assert.match(out, /RunStarted → terminal/); // run-boundary completeness line
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
