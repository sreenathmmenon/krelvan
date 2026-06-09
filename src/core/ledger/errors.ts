/**
 * The ledger's typed error model (LEDGER_SPEC §3).
 *
 * Expected conditions return a Result<T, LedgerError> — they never throw. We throw
 * only for genuine programmer errors. A verification failure is LOUD: the affected
 * run is marked UNVERIFIABLE and halts, never "confident but wrong".
 */

export type LedgerErrorKind =
  | "HashMismatch" // stored event's recomputed hash != its id (I1)
  | "BrokenChain" // prev doesn't point at the actual previous event (I4)
  | "OffsetGap" // offsets not contiguous (I3)
  | "OffsetDuplicate" // two events share an offset (I3)
  | "DanglingParent" // a parents[] id not present (I5)
  | "BadSignature" // signature doesn't verify (I6)
  | "UnknownAuthor" // author key not registered (I6)
  | "OptimisticConflict" // expected head moved under us (§4)
  | "DeterminismViolation" // captured on non-EffectResult or vice versa (I7)
  | "ScopeViolation" // event scope inconsistent with target (I7-adjacent)
  | "CanonicalError" // payload couldn't be canonicalized (LED-01/02)
  | "Truncated"; // checkpoint says there should be more events than present (LED-07)

export interface LedgerError {
  kind: LedgerErrorKind;
  message: string;
  /** the offset or event id the error concerns, when known. */
  at?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: LedgerError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(kind: LedgerErrorKind, message: string, at?: string): Result<T> {
  return { ok: false, error: at !== undefined ? { kind, message, at } : { kind, message } };
}

/** Thrown only for programmer errors that should never happen in correct code. */
export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}
