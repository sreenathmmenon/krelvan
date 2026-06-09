/**
 * Identity & Secrets: key custody, rotation, revocation, and the scoped-token broker.
 *
 * The council's biggest security decisions live here:
 *  - SECRETS NEVER TOUCH PLUGINS: a plugin asks the broker for a short-lived, scoped
 *    token to reach a specific destination; it never sees the underlying secret.
 *  - Keys have an epoch + validity window; rotation issues a new epoch, revocation
 *    closes the window so signatures after revocation no longer verify (LED-08).
 *
 * Built on the HmacKeyring primitive from the ledger layer; this adds the lifecycle.
 */

import { HmacKeyring, type KeyDescriptor, type Signer, type Verifier } from "../ledger/crypto.js";

export interface KeyRecord {
  keyId: string;
  epoch: number;
  status: "active" | "rotated" | "revoked";
  validFrom: number;
  validUntil: number | null;
}

/**
 * Manages the lifecycle of signing keys on top of the underlying keyring. Verifying
 * always defers to the keyring's time-windowed check, so revoked/rotated keys stop
 * verifying for events whose signing time is outside their window.
 */
export class IdentityManager {
  private readonly ring = new HmacKeyring();
  private readonly records = new Map<string, KeyRecord>(); // key = keyId#epoch
  private readonly latestEpoch = new Map<string, number>();

  /** Issue a brand-new key (epoch 1) and return its signer. */
  issue(keyId: string, secret: string, now: number): Signer {
    if (this.latestEpoch.has(keyId)) {
      throw new Error(`key '${keyId}' already exists; use rotate()`);
    }
    return this.register(keyId, 1, secret, now);
  }

  /**
   * Rotate a key: close the old epoch's window at `now`, open a new epoch. Old
   * signatures (signed before `now`) still verify (LED-08); new signing uses the
   * new epoch.
   */
  rotate(keyId: string, newSecret: string, now: number): Signer {
    const epoch = this.latestEpoch.get(keyId);
    if (epoch === undefined) throw new Error(`cannot rotate unknown key '${keyId}'`);
    const oldRec = this.records.get(mk(keyId, epoch))!;
    oldRec.status = "rotated";
    oldRec.validUntil = now; // window closes now; pre-now signatures remain valid
    this.ring.setValidUntil(keyId, epoch, now); // keep the keyring's window in sync
    return this.register(keyId, epoch + 1, newSecret, now);
  }

  /**
   * Revoke a key entirely as of `now`. Signatures made before `now` still verify
   * (history is immutable); signatures dated >= now are rejected (out_of_window).
   */
  revoke(keyId: string, now: number): void {
    const epoch = this.latestEpoch.get(keyId);
    if (epoch === undefined) throw new Error(`cannot revoke unknown key '${keyId}'`);
    const rec = this.records.get(mk(keyId, epoch))!;
    rec.status = "revoked";
    rec.validUntil = now;
    this.ring.setValidUntil(keyId, epoch, now); // keep the keyring's window in sync
  }

  /** The verifier to pass to ledger verify(). */
  get verifier(): Verifier {
    return this.ring;
  }

  record(keyId: string, epoch: number): KeyRecord | undefined {
    return this.records.get(mk(keyId, epoch));
  }

  private register(keyId: string, epoch: number, secret: string, now: number): Signer {
    const desc: Omit<KeyDescriptor, "keyId"> = { epoch, validFrom: now, validUntil: null };
    const signer = this.ring.addKey(keyId, secret, desc);
    this.records.set(mk(keyId, epoch), {
      keyId,
      epoch,
      status: "active",
      validFrom: now,
      validUntil: null,
    });
    this.latestEpoch.set(keyId, epoch);
    return signer;
  }
}

function mk(keyId: string, epoch: number): string {
  return `${keyId}#${epoch}`;
}

// ── Scoped-token broker ─────────────────────────────────────────────────────────
//
// SECRETS NEVER TOUCH PLUGINS. A plugin holds a capability grant; to actually reach
// an external destination it asks the broker, which mints a short-lived token scoped
// to exactly that destination. The real secret stays in the broker.

export interface ScopedToken {
  /** the destination this token is valid for (e.g. "api.example.com"). */
  destination: string;
  /** opaque token the plugin presents; never the underlying secret. */
  token: string;
  /** monotonic expiry time. */
  expiresAt: number;
}

export class SecretBroker {
  /** secretsByDestination: the real credentials, which never leave this object. */
  private readonly secrets = new Map<string, string>();
  private counter = 0;

  setSecret(destination: string, secret: string): void {
    this.secrets.set(destination, secret);
  }

  /**
   * Mint a scoped, short-lived token for a destination IF the caller's grant allows
   * it. Returns null (denied) if the destination has no secret or is not in the
   * allowlist. The plugin never receives `secret`.
   */
  mint(destination: string, allowlist: ReadonlySet<string>, now: number, ttl = 60): ScopedToken | null {
    if (!allowlist.has(destination)) return null; // egress allowlist (deny-by-default)
    if (!this.secrets.has(destination)) return null;
    this.counter++;
    return {
      destination,
      token: `tok_${destination}_${this.counter}`,
      expiresAt: now + ttl,
    };
  }

  /** Validate a token at use time (destination match + not expired). */
  validate(token: ScopedToken, destination: string, now: number): boolean {
    return token.destination === destination && token.expiresAt > now;
  }
}
