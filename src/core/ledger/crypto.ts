/**
 * Hashing & signing primitives for the ledger.
 *
 * Uses ONLY Node's built-in `crypto` — no third-party dependency, so the core
 * stays license-clean (IP-* guards) and the self-host artifact stays small.
 *
 * Guards:
 *  - LED-04: content addresses are self-describing — algo-tagged ("sha256:…"), so
 *    a future hash migration cannot silently fork the address space.
 *  - LED-09: signatures are computed over the content address (the id), never over
 *    a live object, so the signed thing IS the addressed thing.
 *  - LED-08: a key has an id + epoch + validity window; verification resolves the
 *    key valid at the event's notarized time.
 */

import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";

/** Hash algorithm tag. Self-describing so we can migrate without ambiguity (LED-04). */
const HASH_ALGO = "sha256";

/** Compute the content address of canonical bytes: "sha256:<hex>". */
export function contentAddress(canonicalBytes: string): string {
  const hex = createHash(HASH_ALGO).update(canonicalBytes, "utf8").digest("hex");
  return `${HASH_ALGO}:${hex}`;
}

/** Parse a content address into (algo, hex). Throws on malformed input. */
export function parseContentAddress(addr: string): { algo: string; hex: string } {
  const idx = addr.indexOf(":");
  if (idx <= 0) throw new Error(`malformed content address: ${addr}`);
  return { algo: addr.slice(0, idx), hex: addr.slice(idx + 1) };
}

// ── Signing ──────────────────────────────────────────────────────────────────
//
// A Signer is a PORT. The default in-process adapter below is an HMAC signer used
// for tests and the offline single-owner case. Production Identity/Secrets/Time
// will provide an asymmetric, hardware-anchored adapter behind this same port.

/** A registered signing key with a validity window (LED-08). */
export interface KeyDescriptor {
  keyId: string;
  epoch: number;
  /** notarized-time window [validFrom, validUntil); validUntil null = open. */
  validFrom: number;
  validUntil: number | null;
}

/** A detached signature record bound to a key id + epoch (LED-08). */
export interface Signature {
  keyId: string;
  epoch: number;
  /** signing time (notarized), used to resolve key validity on verify. */
  signedAt: number;
  /** the signature bytes (hex). */
  value: string;
}

export interface Signer {
  /** Identity of the key this signer signs with. */
  readonly descriptor: KeyDescriptor;
  /** Sign a content address (LED-09: we sign the id, not the object). */
  sign(contentAddr: string, signedAt: number): Signature;
}

export interface Verifier {
  /**
   * Verify a signature over a content address. Returns a typed reason on failure
   * so callers never silently accept. `now` is the notarized time used to resolve
   * key validity windows.
   */
  verify(contentAddr: string, sig: Signature):
    | { ok: true }
    | { ok: false; reason: "unknown_key" | "wrong_epoch" | "out_of_window" | "bad_signature" };
}

/**
 * In-process HMAC signer/verifier registry. Deterministic (no clock reads of its
 * own), so tests are reproducible. The secret never leaves this process; this is
 * the offline single-owner adapter, NOT the multi-tenant production trust root.
 */
export class HmacKeyring implements Verifier {
  private readonly keys = new Map<string, { secret: string; desc: KeyDescriptor }>();

  /** Register a key. Returns a Signer bound to it. */
  addKey(keyId: string, secret: string, desc: Omit<KeyDescriptor, "keyId">): Signer {
    const descriptor: KeyDescriptor = { keyId, ...desc };
    this.keys.set(mapKey(keyId, desc.epoch), { secret, desc: descriptor });
    const self = this;
    return {
      descriptor,
      sign(contentAddr: string, signedAt: number): Signature {
        return {
          keyId,
          epoch: desc.epoch,
          signedAt,
          value: hmac(secret, contentAddr),
        };
      },
    };
  }

  /**
   * Update a key epoch's validity window (used by rotation/revocation). Closing the
   * window at time `t` means signatures dated >= t no longer verify, while earlier
   * signatures still do (LED-08 — history stays immutable).
   */
  setValidUntil(keyId: string, epoch: number, validUntil: number | null): void {
    const entry = this.keys.get(mapKey(keyId, epoch));
    if (!entry) throw new Error(`cannot set window for unknown key ${keyId}#${epoch}`);
    entry.desc.validUntil = validUntil;
  }

  verify(
    contentAddr: string,
    sig: Signature,
  ): { ok: true } | { ok: false; reason: "unknown_key" | "wrong_epoch" | "out_of_window" | "bad_signature" } {
    const entry = this.keys.get(mapKey(sig.keyId, sig.epoch));
    if (!entry) {
      // distinguish "key id unknown at any epoch" from "epoch mismatch"
      const anyEpoch = [...this.keys.values()].some((e) => e.desc.keyId === sig.keyId);
      return { ok: false, reason: anyEpoch ? "wrong_epoch" : "unknown_key" };
    }
    const { secret, desc } = entry;
    // LED-08: resolve validity at signing time.
    if (sig.signedAt < desc.validFrom || (desc.validUntil !== null && sig.signedAt >= desc.validUntil)) {
      return { ok: false, reason: "out_of_window" };
    }
    const expected = hmac(secret, contentAddr);
    if (!timingSafeEqualHex(expected, sig.value)) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true };
  }
}

/**
 * Asymmetric Ed25519 signer/verifier registry — the NON-REPUDIABLE adapter.
 *
 * Unlike HmacKeyring (where the verify key IS the sign key, so anyone who can verify can
 * also forge), Ed25519 signatures can be verified with ONLY the public key. The private
 * key never has to leave the signer. A third party — a regulator, an auditor, a
 * counterparty — can be handed the public key and independently verify the ledger without
 * ever being able to forge an entry. That is the difference between tamper-EVIDENT and
 * tamper-EVIDENT + NON-REPUDIABLE.
 *
 * Same Signer/Verifier/Signature port as HmacKeyring — a drop-in swap. `Signature.value`
 * holds the Ed25519 signature (hex); keyId/epoch/signedAt/validity windows are identical
 * (LED-08/09 preserved). Node built-in crypto only — no third-party dependency.
 */
export class Ed25519Keyring implements Verifier {
  private readonly keys = new Map<string, { publicKey: KeyObject; privateKey?: KeyObject; desc: KeyDescriptor }>();

  /**
   * Register a keypair and return a Signer bound to it. `privateKeyPem` is a PKCS#8 PEM;
   * the matching public key is derived from it.
   */
  addKey(keyId: string, privateKeyPem: string, desc: Omit<KeyDescriptor, "keyId">): Signer {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    assertEd25519(privateKey, keyId);
    const descriptor: KeyDescriptor = { keyId, ...desc };
    this.keys.set(mapKey(keyId, desc.epoch), { publicKey, privateKey, desc: descriptor });
    return {
      descriptor,
      sign(contentAddr: string, signedAt: number): Signature {
        // Ed25519 signs the message directly (no pre-hash / digest algorithm).
        const value = cryptoSign(null, Buffer.from(contentAddr, "utf8"), privateKey).toString("hex");
        return { keyId, epoch: desc.epoch, signedAt, value };
      },
    };
  }

  /**
   * Register a VERIFY-ONLY public key (SPKI PEM). This is the whole point of the
   * asymmetric adapter: an auditor loads only public keys and can verify the entire
   * ledger without ever holding a secret — forgery is impossible for them.
   */
  addPublicKey(keyId: string, publicKeyPem: string, desc: Omit<KeyDescriptor, "keyId">): void {
    const publicKey = createPublicKey(publicKeyPem);
    assertEd25519(publicKey, keyId);
    this.keys.set(mapKey(keyId, desc.epoch), { publicKey, desc: { keyId, ...desc } });
  }

  /** Export a key epoch's public half as SPKI PEM — safe to hand to a third party. */
  exportPublicKey(keyId: string, epoch: number): string {
    const entry = this.keys.get(mapKey(keyId, epoch));
    if (!entry) throw new Error(`cannot export unknown key ${keyId}#${epoch}`);
    return entry.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  /** Rotation/revocation: close (or reopen) a key epoch's validity window (LED-08). */
  setValidUntil(keyId: string, epoch: number, validUntil: number | null): void {
    const entry = this.keys.get(mapKey(keyId, epoch));
    if (!entry) throw new Error(`cannot set window for unknown key ${keyId}#${epoch}`);
    entry.desc.validUntil = validUntil;
  }

  verify(
    contentAddr: string,
    sig: Signature,
  ): { ok: true } | { ok: false; reason: "unknown_key" | "wrong_epoch" | "out_of_window" | "bad_signature" } {
    const entry = this.keys.get(mapKey(sig.keyId, sig.epoch));
    if (!entry) {
      const anyEpoch = [...this.keys.values()].some((e) => e.desc.keyId === sig.keyId);
      return { ok: false, reason: anyEpoch ? "wrong_epoch" : "unknown_key" };
    }
    const { publicKey, desc } = entry;
    if (sig.signedAt < desc.validFrom || (desc.validUntil !== null && sig.signedAt >= desc.validUntil)) {
      return { ok: false, reason: "out_of_window" };
    }
    let sigBytes: Buffer;
    try { sigBytes = Buffer.from(sig.value, "hex"); } catch { return { ok: false, reason: "bad_signature" }; }
    // Ed25519 signatures are exactly 64 bytes; reject anything malformed before verify.
    if (sigBytes.length !== 64) return { ok: false, reason: "bad_signature" };
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(contentAddr, "utf8"), publicKey, sigBytes);
    } catch {
      return { ok: false, reason: "bad_signature" };
    }
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  }
}

/** Generate a fresh Ed25519 keypair as { privateKey: PKCS#8 PEM, publicKey: SPKI PEM }. */
export function generateEd25519Keypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function assertEd25519(key: KeyObject, keyId: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`key '${keyId}' is not an Ed25519 key (got ${key.asymmetricKeyType ?? "unknown"})`);
  }
}

function mapKey(keyId: string, epoch: number): string {
  return `${keyId}#${epoch}`;
}

function hmac(secret: string, msg: string): string {
  return createHmac("sha256", secret).update(msg, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
