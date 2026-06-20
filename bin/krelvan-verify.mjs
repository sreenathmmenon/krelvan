#!/usr/bin/env node
/**
 * krelvan-verify — independently verify a Krelvan proof bundle, OFFLINE, with no Krelvan
 * install and no trust in the instance that produced it.
 *
 * This is the payoff of the whole "prove what they did" wedge: someone hands you a
 * `krelvan-proof-<run>.json` file (exported from any Krelvan run), and you check it
 * yourself. For an Ed25519 bundle, the included public keys + Node's crypto are all you
 * need — forgery is impossible without the private key, which never leaves their instance.
 *
 * Node built-ins ONLY (node:crypto). Zero dependencies. Copy this one file anywhere.
 *
 * What it checks, per event:
 *   1. content address — recompute sha256 over the canonical preimage; must equal `id`.
 *   2. signature       — Ed25519 verify of `sig.value` over `id` against the public key.
 *   3. chain linkage   — events are offset-contiguous and each `prev` points at the
 *                        previous event's `id` (a re-ordered or spliced run fails here).
 *
 * Usage:
 *   node bin/krelvan-verify.mjs <proof.json>
 *   npx krelvan verify <proof.json>
 *
 * Exit code 0 = verified, 1 = verification failed / bad input.
 */

import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

function die(msg) {
  process.stderr.write(`${bad("✗")} ${msg}\n`);
  process.exit(1);
}

// ── canonicalize — MUST byte-match src/core/ledger/canonical.ts ──────────────────
// Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace,
// integers only (LED-02 bans floats — they'd format differently across platforms).
function canonicalize(value, path = "$") {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) die(`non-finite number at ${path}`);
    if (!Number.isInteger(value)) die(`non-integer number at ${path} — bundle is not canonical`);
    if (!Number.isSafeInteger(value)) die(`integer outside safe range at ${path}`);
    return String(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "undefined") die(`undefined at ${path}`);
  if (Array.isArray(value)) return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalize(v, `${path}.${k}`)}`);
    }
    return `{${parts.join(",")}}`;
  }
  die(`unsupported value of type ${t} at ${path}`);
}

// The exact preimage shape the content address is computed over (LED-03).
function preimageBytes(e) {
  const scope = {
    tenantId: e.scope.tenantId,
    runId: e.scope.runId,
    ...(e.scope.nodeId !== undefined ? { nodeId: e.scope.nodeId } : {}),
    branchId: e.scope.branchId,
  };
  return canonicalize({
    type: e.type,
    scope,
    parents: [...(e.parents ?? [])],
    prev: e.prev ?? null,
    offset: e.offset,
    payload: e.payload,
    determinism: e.determinism,
    ts: e.ts,
    author: e.author,
  });
}

function contentAddress(canonicalBytes) {
  return `sha256:${createHash("sha256").update(canonicalBytes, "utf8").digest("hex")}`;
}

// ── main ─────────────────────────────────────────────────────────────────────────
const file = process.argv[2];
if (!file || file === "--help" || file === "-h") {
  process.stdout.write("Usage: krelvan verify <proof.json>\n\nIndependently verify a Krelvan signed-run proof bundle, offline.\n");
  process.exit(file ? 0 : 1);
}

let bundle;
try {
  bundle = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  die(`could not read JSON from ${file}: ${e.message}`);
}

if (!bundle || bundle.krelvanProofBundle !== 1 || !Array.isArray(bundle.events)) {
  die(`${file} is not a Krelvan proof bundle (missing krelvanProofBundle:1 / events[])`);
}

process.stdout.write(`${C.bold}Krelvan proof bundle${C.reset} — run ${bundle.runId}\n`);
process.stdout.write(dim(`  ${bundle.events.length} events · ${bundle.algorithm} · exported ${new Date(bundle.exportedAt).toISOString()}\n`));

// Load public keys (Ed25519 only — HMAC sigs are instance-local and not third-party verifiable).
const pubKeys = new Map();
for (const k of bundle.publicKeys ?? []) {
  try { pubKeys.set(`${k.keyId}#${k.epoch}`, createPublicKey(k.publicKeyPem)); }
  catch (e) { die(`bad public key ${k.keyId}#${k.epoch}: ${e.message}`); }
}

const isEd25519 = bundle.algorithm === "ed25519";
if (!isEd25519) {
  process.stdout.write(`${C.yellow}!${C.reset} This bundle is signed with ${bundle.algorithm} (tamper-EVIDENT, instance-local).\n`);
  process.stdout.write(dim("  Content addresses and chain linkage are checked below, but the signatures\n  cannot be independently verified without the instance's secret. For non-repudiable\n  proof, ask the sender to run Krelvan with KRELVAN_LEDGER_SIGNING=ed25519.\n"));
}

let idFailures = 0, sigFailures = 0, chainFailures = 0, sigChecked = 0;
let prevId = null, prevOffset = null;

for (const e of bundle.events) {
  // 1) content address
  const computed = contentAddress(preimageBytes(e));
  const idOk = computed === e.id;
  if (!idOk) { idFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset} ${e.type}: content address mismatch\n${dim(`      expected ${e.id}\n      computed ${computed}`)}\n`); }

  // 2) signature (Ed25519 only)
  if (isEd25519 && e.sig) {
    const key = pubKeys.get(`${e.sig.keyId}#${e.sig.epoch}`);
    if (!key) { sigFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset}: no public key for ${e.sig.keyId}#${e.sig.epoch}\n`); }
    else {
      sigChecked++;
      let valid = false;
      try {
        const sigBytes = Buffer.from(e.sig.value, "hex");
        valid = sigBytes.length === 64 && cryptoVerify(null, Buffer.from(e.id, "utf8"), key, sigBytes);
      } catch { valid = false; }
      if (!valid) { sigFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset} ${e.type}: signature does not verify\n`); }
    }
  }

  // 3) chain linkage — contiguous offsets, prev points at the previous event's id
  if (prevOffset !== null) {
    if (e.offset !== prevOffset + 1) { chainFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset}: non-contiguous (previous was ${prevOffset})\n`); }
    if (e.prev !== prevId) { chainFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset}: prev does not link to the previous event\n`); }
  }
  prevId = e.id; prevOffset = e.offset;
}

process.stdout.write("\n");
const allOk = idFailures === 0 && sigFailures === 0 && chainFailures === 0;
process.stdout.write(`  content addresses : ${idFailures === 0 ? ok(`all ${bundle.events.length} match`) : bad(`${idFailures} mismatch`)}\n`);
if (isEd25519) process.stdout.write(`  signatures        : ${sigFailures === 0 ? ok(`all ${sigChecked} valid`) : bad(`${sigFailures} invalid`)}\n`);
process.stdout.write(`  chain linkage     : ${chainFailures === 0 ? ok("intact") : bad(`${chainFailures} broken`)}\n\n`);

if (allOk) {
  process.stdout.write(`${ok("✓ VERIFIED")} — ${bundle.events.length} events`);
  if (isEd25519) process.stdout.write(`, every signature checks out against the included public keys.\n${dim("  This run happened exactly as recorded. It cannot have been altered or forged.")}\n`);
  else process.stdout.write(`, hash chain intact (signatures are instance-local for ${bundle.algorithm}).\n`);
  process.exit(0);
} else {
  process.stdout.write(`${bad("✗ VERIFICATION FAILED")} — the bundle does not match its own signed record. Do not trust it.\n`);
  process.exit(1);
}
