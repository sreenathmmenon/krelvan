/**
 * Ed25519Keyring tests — the asymmetric, NON-REPUDIABLE ledger-signing adapter.
 *
 * The properties that matter and that HmacKeyring CANNOT provide:
 *  - a verifier holding ONLY the public key can verify real signatures, and
 *  - that same verifier CANNOT forge one (no private key ⇒ no valid signature).
 * Plus the shared port behavior: tamper detection, key/epoch resolution, validity windows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Ed25519Keyring, generateEd25519Keypair, type Signature } from "./crypto.js";

const W = { epoch: 1, validFrom: 0, validUntil: null as number | null };
const ADDR = "sha256:deadbeef";

test("ed25519: sign → verify round-trips", () => {
  const ring = new Ed25519Keyring();
  const { privateKeyPem } = generateEd25519Keypair();
  const signer = ring.addKey("owner", privateKeyPem, W);
  const sig = signer.sign(ADDR, 100);
  assert.equal(ring.verify(ADDR, sig).ok, true);
  assert.equal(sig.value.length, 128, "Ed25519 signature is 64 bytes = 128 hex chars");
});

test("ed25519: a verifier with ONLY the public key verifies real signatures (non-repudiation, leg 1)", () => {
  // Signer side holds the private key.
  const signerRing = new Ed25519Keyring();
  const { privateKeyPem } = generateEd25519Keypair();
  const signer = signerRing.addKey("owner", privateKeyPem, W);
  const sig = signer.sign(ADDR, 100);
  const pubPem = signerRing.exportPublicKey("owner", 1);

  // A SEPARATE auditor ring loads only the public key — no secret ever leaves the signer.
  const auditor = new Ed25519Keyring();
  auditor.addPublicKey("owner", pubPem, W);
  assert.equal(auditor.verify(ADDR, sig).ok, true, "auditor can verify with the public key alone");
});

test("ed25519: a public-key-only holder CANNOT forge a signature (non-repudiation, leg 2)", () => {
  // The attacker has the public key (it's published) but no private key.
  const real = new Ed25519Keyring();
  const { privateKeyPem } = generateEd25519Keypair();
  const signer = real.addKey("owner", privateKeyPem, W);
  const pubPem = real.exportPublicKey("owner", 1);

  // Attacker mints their OWN keypair, signs with it, but presents it as 'owner'.
  const attacker = new Ed25519Keyring();
  const evil = generateEd25519Keypair();
  const attackerSigner = attacker.addKey("owner", evil.privateKeyPem, W);
  const forged: Signature = attackerSigner.sign(ADDR, 100);

  // The real ring (whose 'owner' public key is the genuine one) must REJECT the forgery.
  const verdict = real.verify(ADDR, forged);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, "bad_signature");

  // Sanity: the published public key really is just a public key (no private material).
  assert.match(pubPem, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(pubPem, /PRIVATE KEY/);
});

test("ed25519: tampering with the signed content address is detected", () => {
  const ring = new Ed25519Keyring();
  const signer = ring.addKey("owner", generateEd25519Keypair().privateKeyPem, W);
  const sig = signer.sign(ADDR, 100);
  const verdict = ring.verify("sha256:tampered", sig);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, "bad_signature");
});

test("ed25519: unknown key and wrong epoch are distinguished", () => {
  const ring = new Ed25519Keyring();
  const signer = ring.addKey("owner", generateEd25519Keypair().privateKeyPem, W);
  const sig = signer.sign(ADDR, 100);

  assert.equal((ring.verify(ADDR, { ...sig, keyId: "ghost" }) as { reason: string }).reason, "unknown_key");
  assert.equal((ring.verify(ADDR, { ...sig, epoch: 99 }) as { reason: string }).reason, "wrong_epoch");
});

test("ed25519: a signature outside the key's validity window is rejected (LED-08)", () => {
  const ring = new Ed25519Keyring();
  const signer = ring.addKey("owner", generateEd25519Keypair().privateKeyPem, { epoch: 1, validFrom: 0, validUntil: null });
  const sig = signer.sign(ADDR, 500);
  // Revoke from t=300: a signature dated 500 no longer verifies; an earlier one still would.
  ring.setValidUntil("owner", 1, 300);
  assert.equal((ring.verify(ADDR, sig) as { reason: string }).reason, "out_of_window");
  const early = signer.sign(ADDR, 100);
  assert.equal(ring.verify(ADDR, early).ok, true, "history before revocation stays valid");
});

test("ed25519: a malformed signature value is rejected cleanly (not thrown)", () => {
  const ring = new Ed25519Keyring();
  const signer = ring.addKey("owner", generateEd25519Keypair().privateKeyPem, W);
  const sig = signer.sign(ADDR, 100);
  assert.equal((ring.verify(ADDR, { ...sig, value: "zz" }) as { reason: string }).reason, "bad_signature");
  assert.equal((ring.verify(ADDR, { ...sig, value: "" }) as { reason: string }).reason, "bad_signature");
});

test("ed25519: addKey rejects a non-Ed25519 key", () => {
  const ring = new Ed25519Keyring();
  // An RSA PKCS#8 key must be refused — the adapter is Ed25519-only.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => ring.addKey("owner", rsa, W), /not an Ed25519 key/);
});
