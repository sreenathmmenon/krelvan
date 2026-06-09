/**
 * The ledger store PORT + an in-memory adapter, and the verifier.
 *
 * The store is the only place that assigns offset/prev and serializes appends.
 * The core depends on this interface; SQLite/Postgres adapters implement the same
 * contract later.
 *
 * Guards: LED-05 (CAS append, no forks), LED-06 (offset = prev+1 inside the CAS,
 * never a DB sequence), LED-10/11 handled at the kernel layer, I1–I7 + LED-07 in
 * verify().
 */

import {
  computeId,
  determinismOk,
  preimageBytes,
  type EventPreimage,
  type EventScope,
  type Hash,
  type LedgerEvent,
  type NewEvent,
  type Offset,
} from "./event.js";
import { contentAddress, type Signer, type Verifier } from "./crypto.js";
import { err, ok, type Result } from "./errors.js";

/** Head of a tenant stream: the last event's id + offset (null/-1 at genesis). */
export interface Head {
  prev: Hash | null;
  offset: Offset; // -1 means "empty stream; next offset is 0"
}

export interface AppendOptions {
  /** Optimistic concurrency: the head the caller believes is current (§4). */
  expectedHead?: Head;
  /** Notarized time for this append (supplied by the Time authority). */
  ts: number;
  /** Signer for this event's author. */
  signer: Signer;
}

export interface LedgerStore {
  /** Current head for a tenant. */
  head(tenantId: string): Promise<Head>;
  /** Append one event atomically. Assigns offset/prev, signs, returns the stored event. */
  append<P>(ev: NewEvent<P>, opts: AppendOptions): Promise<Result<LedgerEvent<P>>>;
  /** All events for a tenant in offset order. */
  read(tenantId: string): Promise<LedgerEvent[]>;
  /** Events for one run (across branches) in offset order. */
  readRun(tenantId: string, runId: string): Promise<LedgerEvent[]>;
}

/** A signed checkpoint anchoring the tail so truncation is detectable (LED-07). */
export interface Checkpoint {
  tenantId: string;
  offset: Offset; // max offset covered
  headHash: Hash;
  count: number; // number of events covered (offset + 1)
  sig: import("./crypto.js").Signature;
}

// ── In-memory adapter ─────────────────────────────────────────────────────────

export class InMemoryLedgerStore implements LedgerStore {
  private readonly streams = new Map<string, LedgerEvent[]>();
  // a tiny async mutex per tenant to serialize appends (LED-05)
  private readonly locks = new Map<string, Promise<void>>();

  async head(tenantId: string): Promise<Head> {
    const s = this.streams.get(tenantId);
    if (!s || s.length === 0) return { prev: null, offset: -1 };
    const last = s[s.length - 1]!;
    return { prev: last.id, offset: last.offset };
  }

  async append<P>(ev: NewEvent<P>, opts: AppendOptions): Promise<Result<LedgerEvent<P>>> {
    const tenantId = ev.scope.tenantId;
    // Serialize per-tenant appends.
    const release = await this.acquire(tenantId);
    try {
      return this.appendLocked(ev, opts);
    } finally {
      release();
    }
  }

  private appendLocked<P>(ev: NewEvent<P>, opts: AppendOptions): Result<LedgerEvent<P>> {
    const tenantId = ev.scope.tenantId;
    const stream = this.streams.get(tenantId) ?? [];

    const current: Head =
      stream.length === 0
        ? { prev: null, offset: -1 }
        : { prev: stream[stream.length - 1]!.id, offset: stream[stream.length - 1]!.offset };

    // §4 optimistic concurrency
    if (opts.expectedHead) {
      if (opts.expectedHead.prev !== current.prev || opts.expectedHead.offset !== current.offset) {
        return err(
          "OptimisticConflict",
          `expected head offset ${opts.expectedHead.offset}/${opts.expectedHead.prev} but current is ${current.offset}/${current.prev}`,
        );
      }
    }

    const determinism = ev.determinism ?? "pure";
    // I7
    if (!determinismOk(ev.type, determinism)) {
      return err(
        "DeterminismViolation",
        `event type ${ev.type} may not be 'captured'; only EffectResult may be captured`,
      );
    }

    const parents = ev.parents ?? [];
    // I5: every parent must already exist.
    const known = new Set(stream.map((e) => e.id));
    for (const p of parents) {
      if (!known.has(p)) {
        return err("DanglingParent", `parent ${p} not present in tenant ${tenantId}`, p);
      }
    }

    const offset = current.offset + 1; // LED-06: offset = prev + 1, inside the lock

    const preimage: EventPreimage<P> = {
      type: ev.type,
      scope: ev.scope,
      parents,
      prev: current.prev,
      offset,
      payload: ev.payload,
      determinism,
      ts: opts.ts,
      author: ev.author,
    };

    let id: Hash;
    try {
      id = computeId(preimage); // may throw CanonicalError (LED-01/02)
    } catch (e) {
      return err("CanonicalError", (e as Error).message);
    }

    // author must match the signer's key id (no impersonation) — check BEFORE sign()
    // so we never invoke the signer for an invalid event.
    if (ev.author !== opts.signer.descriptor.keyId) {
      return err(
        "ScopeViolation",
        `event.author '${ev.author}' != signer keyId '${opts.signer.descriptor.keyId}'`,
      );
    }

    // LED-09: sign the id (content address), not the object.
    const sig = opts.signer.sign(id, opts.ts);

    const stored: LedgerEvent<P> = { ...preimage, id, sig };

    // Push onto the existing mutable array (O(1)) rather than slice()+push (O(n)).
    // The stream array is private and only ever mutated here inside the per-tenant lock.
    if (!this.streams.has(tenantId)) this.streams.set(tenantId, []);
    this.streams.get(tenantId)!.push(stored);
    return ok(stored);
  }

  async read(tenantId: string): Promise<LedgerEvent[]> {
    return (this.streams.get(tenantId) ?? []).slice();
  }

  async readRun(tenantId: string, runId: string): Promise<LedgerEvent[]> {
    return (this.streams.get(tenantId) ?? []).filter((e) => e.scope.runId === runId);
  }

  /** TEST/INTERNAL: raw mutate, to simulate corruption/tamper for verify() tests. */
  _unsafeReplace(tenantId: string, events: LedgerEvent[]): void {
    this.streams.set(tenantId, events.slice());
  }

  private async acquire(tenantId: string): Promise<() => void> {
    const prev = this.locks.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => (release = res));
    this.locks.set(
      tenantId,
      prev.then(() => next),
    );
    await prev;
    return release;
  }
}

// ── Verification ────────────────────────────────────────────────────────────
//
// verify() walks a tenant's events and checks every invariant. ANY failure is
// returned as a typed error so the caller can mark the run UNVERIFIABLE and halt.

export function verify(
  events: readonly LedgerEvent[],
  verifier: Verifier,
  checkpoint?: Checkpoint,
): Result<true> {
  let expectedOffset = 0;
  let expectedPrev: Hash | null = null;
  const seen = new Set<Hash>();
  const seenOffsets = new Set<Offset>();

  for (const e of events) {
    // I3: offsets contiguous from 0, no dup.
    if (seenOffsets.has(e.offset)) {
      return err("OffsetDuplicate", `duplicate offset ${e.offset}`, String(e.offset));
    }
    seenOffsets.add(e.offset);
    if (e.offset !== expectedOffset) {
      return err("OffsetGap", `expected offset ${expectedOffset} but got ${e.offset}`, e.id);
    }

    // I4: chain linkage.
    if (e.prev !== expectedPrev) {
      return err("BrokenChain", `event ${e.id} prev ${e.prev} != expected ${expectedPrev}`, e.id);
    }

    // I1: content address integrity — recompute and compare.
    let recomputed: Hash;
    try {
      recomputed = contentAddress(preimageBytes(e));
    } catch (err2) {
      return err("CanonicalError", (err2 as Error).message, e.id);
    }
    if (recomputed !== e.id) {
      return err("HashMismatch", `event id ${e.id} != recomputed ${recomputed}`, e.id);
    }

    // I7: determinism rule.
    if (!determinismOk(e.type, e.determinism)) {
      return err("DeterminismViolation", `event ${e.id} type ${e.type} cannot be captured`, e.id);
    }

    // I5: parents exist among already-seen events (causal, must precede).
    for (const p of e.parents) {
      if (!seen.has(p)) {
        return err("DanglingParent", `event ${e.id} references unseen parent ${p}`, p);
      }
    }

    // I6: signature verifies and author matches the signing key.
    if (e.sig.keyId !== e.author) {
      return err("UnknownAuthor", `event ${e.id} author ${e.author} != sig keyId ${e.sig.keyId}`, e.id);
    }
    const v = verifier.verify(e.id, e.sig);
    if (!v.ok) {
      const kind = v.reason === "unknown_key" ? "UnknownAuthor" : "BadSignature";
      return err(kind, `event ${e.id} signature: ${v.reason}`, e.id);
    }

    seen.add(e.id);
    expectedOffset = e.offset + 1;
    expectedPrev = e.id;
  }

  // LED-07: tail-truncation detection via checkpoint.
  if (checkpoint) {
    const cv = verifier.verify(checkpoint.headHash, checkpoint.sig);
    if (!cv.ok) {
      return err("BadSignature", `checkpoint signature: ${cv.reason}`);
    }
    const maxOffset = events.length === 0 ? -1 : events[events.length - 1]!.offset;
    if (maxOffset < checkpoint.offset) {
      return err(
        "Truncated",
        `checkpoint covers offset ${checkpoint.offset} but log only reaches ${maxOffset}`,
      );
    }
  }

  return ok(true);
}
