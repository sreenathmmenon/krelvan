# Ledger — Design Spec, Invariants & Failure Modes

*The ledger is the foundation: every other subsystem is a pure read of it. So its
correctness bar is the highest in the system. This spec pins the invariants, the
error model, and every edge case BEFORE implementation, and is the checklist the
implementation + tests must satisfy. Nothing here is claimed "done" until a test
proves it.*

---

## 1. What the ledger is

An append-only, content-addressed, signed event log, plus a small set of pure
reducers (projections) over it. The append store is a **port** (interface); the
first adapter is in-memory (for tests + the inversion demo), the next is SQLite
(embedded, offline), then Postgres (scale). The core depends only on the port.

## 2. The invariants (must always hold)

- **I1 — Content address integrity.** `event.id == hash(canonical(event without id/offset/sig))`. Recomputing the hash of any stored event must equal its id. A single mutated byte changes the id.
- **I2 — Append-only.** Events are never updated or deleted. The only write is append.
- **I3 — Monotonic, gap-free offsets per tenant.** Offsets start at 0 and increase by exactly 1 within a tenant keyspace. No duplicates, no gaps.
- **I4 — Chain linkage.** Each event's `prev` equals the id of the immediately preceding appended event in its tenant (or `null` only for the tenant's genesis event). The chain is walkable end-to-end.
- **I5 — Causal parents exist.** Every id in `event.parents` must already exist in the log at append time (no dangling causal references).
- **I6 — Signature validity.** `verify(author_pubkey, event.id, event.sig)` is true for every event. (Authority — *who may emit which type* — is a separate layer; the ledger enforces that the signature is valid and matches `author`.)
- **I7 — Determinism honesty.** `determinism` is `"captured"` only on `EffectResult`; all other event types are `"pure"`. Replay re-serves `captured` results and re-derives `pure` ones.
- **I8 — Projection purity.** A projection is `fold(events) -> state` with no side effects and no I/O. Same events in → same state out, every time. Replaying the log reproduces any projected state exactly.

## 3. The error model (explicit, typed — no silent failures)

Every operation returns a typed `Result<T, LedgerError>` (never throws for expected
conditions; throws only for truly unexpected programmer errors). Error kinds:

| Error | When | Caller's recourse |
|---|---|---|
| `HashMismatch` | stored event's recomputed hash ≠ its id | the log is corrupt → mark run UNVERIFIABLE, halt |
| `BrokenChain` | `prev` doesn't point at the actual previous event | corrupt/forked store → UNVERIFIABLE |
| `OffsetGap` / `OffsetDuplicate` | offsets not gap-free monotonic | corrupt store → UNVERIFIABLE |
| `DanglingParent` | a `parents` id not present | reject the append; programmer/ordering bug |
| `BadSignature` | signature doesn't verify | reject the append; possible tamper |
| `UnknownAuthor` | author key not registered | reject the append |
| `OptimisticConflict` | expected-prev didn't match at append (concurrent append) | retry with fresh head (see §4) |
| `DeterminismViolation` | `captured` on a non-`EffectResult`, or vice versa | reject the append; programmer bug |
| `ScopeViolation` | event scope tenant/run inconsistent with target | reject the append |

**Rule: a verification failure is LOUD.** If the log can't be proven consistent,
the affected run is marked **UNVERIFIABLE** and halts — never "confident but wrong."

## 4. Concurrency & ordering

- Appends within a tenant are **serialized** through the store. The store assigns the
  offset and validates `prev` under that serialization point.
- Optimistic concurrency: an appender may pass `expectedHead` (the id it believes is
  current). If the head moved, the store returns `OptimisticConflict` and the caller
  re-reads the head and rebuilds its proposed event(s). The kernel is a pure reducer,
  so rebuilding is cheap and safe.
- Cross-tenant appends are independent keyspaces — no global lock.

## 5. The edge cases the tests MUST cover

1. **Krelvan event:** first event in a tenant has `prev == null`, `offset == 0`.
2. **Empty log read:** projecting an empty/absent run yields the well-defined empty state, not an error.
3. **Tamper detection:** flip a byte in a stored event → `verify()` returns `HashMismatch`/`BadSignature` and the run is UNVERIFIABLE.
4. **Dangling parent rejected:** appending an event whose parent isn't present is rejected before it lands.
5. **Offset gap/duplicate detection:** a store with a manufactured gap/dup is caught by `verify()`.
6. **Determinism rule enforced:** appending `captured` on a `NodeEntered` is rejected; `EffectResult` may be `captured` or `pure`.
7. **Optimistic conflict:** two appenders race; one wins, the other gets `OptimisticConflict` and succeeds on retry; final log has no gap/dup.
8. **Kill-and-resume (the inversion proof):** start a 2-node run, kill the process after the first node's `EffectResult` is durably appended but before the second runs; on resume, the kernel folds the log, sees node-1 done, and continues node-2 **without re-executing node-1's effect** (idempotency key already has a result → re-served, not re-run). No double-execution.
9. **Crash hole:** an `EffectRequested` with no matching `EffectResult` for a write/spend/irreversible effect is a HOLE → the run HALTS and re-gates on resume; it is never silently re-executed.
10. **Replay determinism:** fold the full log twice → byte-identical projected state (I8).
11. **Idempotency:** the same effect idempotency key appended twice resolves to one logical result (second is a no-op fold), so retries never double-apply.
12. **Large/odd payloads:** unicode, empty payload, nested objects — canonicalization is stable and order-independent on object keys.

## 6. Canonicalization (so hashing is stable)

- Canonical form = JSON with **object keys sorted recursively**, no insignificant
  whitespace, arrays in order. Numbers in a single canonical form. This guarantees
  two semantically-equal payloads hash identically (covers edge case 12).
- The hash excludes `id`, `offset`, `sig` (they're derived/assigned after).

## 7. What the ledger does NOT do (boundaries)

- It does not decide *who may* emit an event type (that's the authority/capability
  layer) — it only checks the signature is valid and the author is known.
- It does not execute effects (that's the effect-runner) — it only records the
  three-event effect protocol.
- It does not mint keys or read the wall clock (that's Identity/Secrets/Time) — `ts`
  and signatures are supplied by those authorities. For the demo/in-memory adapter
  we use a deterministic test signer + a logical clock so tests are reproducible.

## 8. Definition of done (no bluffing — each line needs a passing test)

Status as of the first build (21/21 tests passing, typecheck clean):

- [x] §5 edge cases covered by tests and passing (`npm test` → 21/21). Covered:
      genesis (1), empty-log (2), tamper (3), dangling-parent (4), offset-gap (5),
      determinism rule (6), optimistic-conflict (7), kill-and-resume (8 — demo),
      replay determinism (10), LED-07 truncation, LED-08 key window.
- [x] `verify(log)` catches corruption in I1–I7 (HashMismatch, BrokenChain,
      OffsetGap/Duplicate, DanglingParent, BadSignature/UnknownAuthor,
      DeterminismViolation) — each has a passing test.
- [x] Kill-and-resume demo (`npm run demo:resume`) shows each irreversible effect
      executed EXACTLY ONCE across a simulated crash. Verified output.
- [x] Inversion demo (`npm run demo:ledger`) shows canvas + cost + audit timeline
      all derived from one folded, verified log. Verified output.
- [x] `npm run typecheck` clean under strict mode (noUncheckedIndexedAccess etc.).

Not yet built (next subsystems, tracked in PREMORTEM): crash-hole HALT-and-re-gate
as a kernel rule (demo shows re-serve; the explicit halt path is the kernel's job),
signed checkpoints emitted automatically (LED-07 tested manually), concurrent
cross-process CAS on a real store (SQLite/Postgres adapter), and edge cases 9, 11,
12 as standalone tests.
