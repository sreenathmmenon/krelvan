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

// ── arg parsing ────────────────────────────────────────────────────────────────
//   <proof.json>            the bundle to verify
//   --key <file.pem>        PIN against this trusted Ed25519 public key (repeatable). The
//                           bundle's own keys are then only accepted if they match a pinned
//                           one. This is what turns "internally consistent" into "authentic":
//                           an auditor fetches the genuine key out-of-band (GET /api/ledger/keys
//                           on the issuing instance) and pins it here so a forger can't supply
//                           their own keypair.
const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(`Usage: krelvan verify <proof.json> [--key <pubkey.pem> ...]

Independently verify a Krelvan signed-run proof bundle, offline.

Without --key, the bundle is checked against the public keys EMBEDDED in it — this proves
the run is internally consistent and unaltered, but NOT that it came from a particular
instance (a forger could embed their own keys). To prove authenticity of origin, pin the
issuer's real public key: fetch it from GET /api/ledger/keys on the source instance and pass
it with --key.
`);
  process.exit(args.length ? 0 : 1);
}

const pinnedKeyPems = [];
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key") {
    const p = args[++i];
    if (!p) die("--key needs a path to a PEM public key");
    try { pinnedKeyPems.push(readFileSync(p, "utf8")); } catch (e) { die(`could not read pinned key ${p}: ${e.message}`); }
  } else if (!file) {
    file = args[i];
  }
}
if (!file) die("no proof bundle given");

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

// SPKI DER fingerprint of a public key — stable, comparable across PEM whitespace.
const keyFingerprint = (keyObj) => createHash("sha256").update(keyObj.export({ type: "spki", format: "der" })).digest("hex");

// The set of trusted fingerprints, if the caller pinned any.
const pinnedFps = new Set();
for (const pem of pinnedKeyPems) {
  try { pinnedFps.add(keyFingerprint(createPublicKey(pem))); }
  catch (e) { die(`bad pinned public key: ${e.message}`); }
}

// Load the bundle's own public keys (Ed25519 only — HMAC sigs are instance-local).
// We accept all of them here; if --key was given, we enforce below that every key that
// ACTUALLY SIGNED an event matches a pinned fingerprint (unused bundle keys are irrelevant).
const pubKeys = new Map();         // "keyId#epoch" -> KeyObject
const pubKeyFp = new Map();        // "keyId#epoch" -> fingerprint hex
for (const k of bundle.publicKeys ?? []) {
  let keyObj;
  try { keyObj = createPublicKey(k.publicKeyPem); }
  catch (e) { die(`bad public key ${k.keyId}#${k.epoch}: ${e.message}`); }
  pubKeys.set(`${k.keyId}#${k.epoch}`, keyObj);
  pubKeyFp.set(`${k.keyId}#${k.epoch}`, keyFingerprint(keyObj));
}
const usedSigningKeys = new Set(); // "keyId#epoch" actually used to verify a signature

const isEd25519 = bundle.algorithm === "ed25519";
if (!isEd25519) {
  process.stdout.write(`${C.yellow}!${C.reset} This bundle is signed with ${bundle.algorithm} (tamper-EVIDENT, instance-local).\n`);
  process.stdout.write(dim("  Content addresses and chain linkage are checked below, but the signatures\n  cannot be independently verified without the instance's secret. For non-repudiable\n  proof, ask the sender to run Krelvan with KRELVAN_LEDGER_SIGNING=ed25519.\n"));
}

let idFailures = 0, sigFailures = 0, orderFailures = 0, sigChecked = 0;
let prevOffset = null;

for (const e of bundle.events) {
  // 1) content address — recompute and compare to the claimed id. Any mutation of any field
  //    changes the id; this is the core tamper check.
  const computed = contentAddress(preimageBytes(e));
  if (computed !== e.id) { idFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset} ${e.type}: content address mismatch\n${dim(`      expected ${e.id}\n      computed ${computed}`)}\n`); }

  // 2) signature (Ed25519 only) — verify the detached signature over the id against the public key.
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
      else usedSigningKeys.add(`${e.sig.keyId}#${e.sig.epoch}`);
    }
  }

  // 3) ordering — a run's events are a slice of ONE global ledger; their offsets are global and
  //    strictly increasing (other runs may interleave, so they are NOT necessarily contiguous).
  //    A strictly-increasing check catches re-ordering; the offset is bound into each event's
  //    signed id, so it can't be forged.
  if (prevOffset !== null && !(e.offset > prevOffset)) {
    orderFailures++; process.stdout.write(`  ${bad("✗")} offset ${e.offset}: not strictly after ${prevOffset} — events re-ordered\n`);
  }
  prevOffset = e.offset;
}

// 4) RUN BOUNDARIES — assert the slice spans a WHOLE run: begins at RunStarted, ends at a
//    terminal event (RunCompleted/RunFailed, or AwaitRequested for a run paused on approval).
//    This is what stops head/tail truncation from passing as a complete run. NOTE: because the
//    slice omits other runs' interleaved events, a verifier cannot, from the slice alone, prove
//    NO middle event of this run was dropped — only the issuing instance (which holds the full
//    chain) can. So the copy below claims exactly what is proven and no more.
const TERMINAL = new Set(["RunCompleted", "RunFailed", "AwaitRequested"]);
let boundaryFailures = 0;
const first = bundle.events[0];
const last = bundle.events[bundle.events.length - 1];
if (first?.type !== "RunStarted") { boundaryFailures++; process.stdout.write(`  ${bad("✗")} does not begin with RunStarted (first is ${first?.type}) — the run's start was omitted\n`); }
if (!(last && TERMINAL.has(last.type))) { boundaryFailures++; process.stdout.write(`  ${bad("✗")} does not end at a terminal event (last is ${last?.type}) — the run's end was omitted\n`); }

process.stdout.write("\n");
const pinned = pinnedFps.size > 0;
// When pinned: every key that ACTUALLY signed an event must match a pinned fingerprint.
// (Unused keys carried in the bundle are irrelevant — only signers matter for origin.)
let pinMismatch = false;
if (pinned) {
  for (const id of usedSigningKeys) {
    if (!pinnedFps.has(pubKeyFp.get(id))) {
      pinMismatch = true;
      process.stdout.write(`  ${bad("✗")} signing key ${id} does NOT match any pinned --key — possible forgery\n`);
    }
  }
}
const allOk = idFailures === 0 && sigFailures === 0 && orderFailures === 0 && boundaryFailures === 0 && !pinMismatch;
process.stdout.write(`  content addresses : ${idFailures === 0 ? ok(`all ${bundle.events.length} match`) : bad(`${idFailures} mismatch`)}\n`);
if (isEd25519) {
  process.stdout.write(`  signatures        : ${sigFailures === 0 ? ok(`all ${sigChecked} valid`) : bad(`${sigFailures} invalid`)}\n`);
  process.stdout.write(`  key trust         : ${pinMismatch ? bad("bundle key ≠ pinned key") : pinned ? ok("matches pinned key") : `${C.yellow}self-included (not pinned)${C.reset}`}\n`);
}
process.stdout.write(`  ordering          : ${orderFailures === 0 ? ok("strictly increasing") : bad(`${orderFailures} out of order`)}\n`);
process.stdout.write(`  run boundaries    : ${boundaryFailures === 0 ? ok("RunStarted → terminal") : bad(`${boundaryFailures} problem(s) — start/end omitted`)}\n`);
// Print key fingerprints so an UNPINNED verifier can compare them, out-of-band, to the issuing
// instance's GET /api/ledger/keys — the step that upgrades "consistent" to "authentic".
if (isEd25519 && pubKeys.size) {
  for (const [id, keyObj] of pubKeys) {
    process.stdout.write(dim(`    key ${id} sha256:${keyFingerprint(keyObj).slice(0, 24)}…\n`));
  }
}
process.stdout.write("\n");

if (allOk) {
  if (isEd25519 && pinned) {
    process.stdout.write(`${ok("✓ VERIFIED · authentic")} — ${bundle.events.length} events, every signature valid against your PINNED public key; the slice spans a whole run start-to-finish, in order.\n${dim("  This run provably came from the holder of that key and has not been altered or forged.")}\n`);
  } else if (isEd25519) {
    // Unpinned: signatures are valid against keys the bundle SUPPLIES. That proves the bundle is
    // internally consistent (unaltered), NOT that it came from a particular instance — a forger
    // could supply their own keypair. Say exactly that, and tell the verifier how to upgrade it.
    process.stdout.write(`${ok("✓ CONSISTENT")} — ${bundle.events.length} events, every signature valid against the keys included in the file; the slice spans a whole run start-to-finish, in order.\n${dim("  This proves the run is internally consistent and unaltered. It does NOT prove which instance\n  produced it — the keys came from the file itself. To prove origin, fetch the issuer's public key\n  from GET /api/ledger/keys and re-run with --key <that-key.pem>.")}\n`);
  } else {
    // HMAC: tamper-EVIDENT and instance-local — signatures can't be checked by a third party.
    process.stdout.write(`${C.yellow}~ PARTIALLY VERIFIED${C.reset} (instance-local) — ${bundle.events.length} events; content addresses, ordering and run boundaries all check out.\n${dim(`  Signatures use ${bundle.algorithm}, which is tamper-evident but NOT independently verifiable without the instance's secret. For third-party proof, ask the sender for an Ed25519-signed export.`)}\n`);
  }
  process.exit(0);
} else if (pinMismatch && idFailures === 0 && sigFailures === 0 && orderFailures === 0 && boundaryFailures === 0) {
  // The chain is internally consistent but signed by a key that ISN'T the one you pinned —
  // the classic forgery: valid signatures, wrong signer.
  process.stdout.write(`${bad("✗ WRONG SIGNER")} — the bundle is internally consistent but its signing key does NOT match the key you pinned. It was not produced by that instance. Do not trust it.\n`);
  process.exit(1);
} else {
  process.stdout.write(`${bad("✗ VERIFICATION FAILED")} — the bundle does not match its own signed record, or its run start/end was omitted. Do not trust it.\n`);
  process.exit(1);
}
