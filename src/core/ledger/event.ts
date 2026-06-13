/**
 * The Event — the atom of Krelvan.
 *
 * The one principle: the ledger IS the runtime. Execution is a projection of an
 * append-only, content-addressed, signed event log. Every causal step is an event.
 * Every surface (canvas, monitor, cost meter, audit, memory) is a pure read of it.
 *
 * Guards:
 *  - LED-03: the content address covers prev, offset, scope, ts, type, payload,
 *    determinism, author — NOT just the payload — so an event can't be re-parented
 *    or moved without changing its id.
 *  - LED-07: tail truncation is caught by signed checkpoints (see checkpoint.ts),
 *    not by the per-event chain alone.
 *  - I7: `determinism` is "captured" only on EffectResult; "pure" otherwise.
 */

import { canonicalize } from "./canonical.js";
import { contentAddress, type Signature } from "./crypto.js";

export type Hash = string;
export type Offset = number;

export interface EventScope {
  tenantId: string;
  runId: string;
  nodeId?: string;
  branchId: string;
}

export type DeterminismClass = "pure" | "captured";

export type EventType =
  | "RunStarted"
  | "RunCompleted"
  | "RunFailed"
  | "NodeEntered"
  | "NodeConcluded"
  | "AdmissionDecision"
  | "EffectRequested"
  | "EffectResult"
  | "AwaitRequested"
  | "AwaitResolved"
  // ── Sub-run events (agent-as-capability) ──────────────────────────────────
  | "SubRunRequested"   // parent records: sub-run spawned, carries subRunId + idem
  | "SubRunCompleted"   // parent records: sub-run finished, carries output + actualCost
  | "SubRunFailed"      // parent records: sub-run failed, carries reason
  // ── Plugin lifecycle events (append-only, join the main event chain) ──────
  | "PluginInstalled"
  | "PluginEnabled"
  | "PluginDisabled"
  | "PluginUninstalled"
  | "PluginLoadFailed";

/** Only EffectResult may be "captured". Plugin lifecycle events are always "pure". */
const CAPTURE_ALLOWED: ReadonlySet<EventType> = new Set<EventType>(["EffectResult"]);

/**
 * The signed preimage — EXACTLY the fields the content address is computed over
 * (LED-03). `id`, `offset`-as-assigned, and `sig` are derived/assigned after and
 * are NOT in the preimage… except we DO bind offset and prev into the preimage so
 * position can't be forged. To do that the appender must know its offset+prev at
 * sign time, which the store provides before signing (see store.append).
 */
export interface EventPreimage<P = unknown> {
  type: EventType;
  scope: EventScope;
  parents: readonly Hash[];
  prev: Hash | null;
  offset: Offset;
  payload: P;
  determinism: DeterminismClass;
  ts: number;
  author: string;
}

/** A fully-formed, content-addressed, signed event as stored in the log. */
export interface LedgerEvent<P = unknown> extends EventPreimage<P> {
  readonly id: Hash;
  readonly sig: Signature;
}

/** The caller-supplied part; the store fills prev/offset/ts and signs. */
export interface NewEvent<P = unknown> {
  type: EventType;
  scope: EventScope;
  parents?: readonly Hash[];
  payload: P;
  determinism?: DeterminismClass;
  author: string;
}

/**
 * Compute the canonical bytes of a preimage (deterministic; LED-01/02 enforced by
 * canonicalize). Throws CanonicalError on un-canonicalizable payloads.
 */
export function preimageBytes<P>(pre: EventPreimage<P>): string {
  // Build a plain object in a fixed shape; canonicalize sorts keys recursively.
  return canonicalize({
    type: pre.type,
    scope: {
      tenantId: pre.scope.tenantId,
      runId: pre.scope.runId,
      // nodeId omitted when undefined (canonicalize drops undefined)
      ...(pre.scope.nodeId !== undefined ? { nodeId: pre.scope.nodeId } : {}),
      branchId: pre.scope.branchId,
    },
    parents: [...pre.parents],
    prev: pre.prev,
    offset: pre.offset,
    payload: pre.payload as unknown,
    determinism: pre.determinism,
    ts: pre.ts,
    author: pre.author,
  });
}

/** Compute the content address (id) of a preimage. */
export function computeId<P>(pre: EventPreimage<P>): Hash {
  return contentAddress(preimageBytes(pre));
}

/** I7: validate the determinism tag against the event type. */
export function determinismOk(type: EventType, determinism: DeterminismClass): boolean {
  if (determinism === "captured") return CAPTURE_ALLOWED.has(type);
  return true; // "pure" is always allowed
}
