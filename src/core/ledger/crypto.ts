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

import { createHash, createHmac } from "node:crypto";

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
