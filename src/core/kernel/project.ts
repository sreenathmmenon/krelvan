/**
 * Pure projections: fold the ledger into the views the kernel & UI need.
 * No I/O, no clock, no randomness — same events in, same state out (I8).
 *
 * Guards:
 *  - KER: the kernel decides only from folded log state (deterministic).
 *  - LED-10: a crash hole = an EffectRequested with no matching EffectResult.
 *  - cost: budget is folded from EffectResult costs + open reservations.
 */

import type { LedgerEvent } from "../ledger/event.js";
import type { BudgetState } from "../capability/capability.js";
import type { RunState } from "../manifest/expr.js";
import { asObj, isObj, str, num, bool } from "../ledger/payload.js";

export interface NodeStatus {
  entered: boolean;
  concluded: boolean;
  visits: number;
}

export interface RunProjection {
  started: boolean;
  completed: boolean;
  failed: boolean;
  nodes: Record<string, NodeStatus>;
  /** effect idem keys that have a result. */
  resultsByIdem: Set<string>;
  /** effect idem keys that were requested. */
  requestedByIdem: Set<string>;
  /** open await: correlation id → true, until resolved. */
  openAwaits: Set<string>;
  /** resolved approvals: correlation id → the human's decision (survives the resume re-fold). */
  resolvedApprovals: Map<string, "approve" | "deny">;
  budget: BudgetState;
  /** run state keys derived from NodeConcluded outputs (for edge conditions). */
  state: RunState;
  /** the node currently entered but not yet concluded, or null. O(1) kernel look-up. */
  currentNode: string | null;
  /** the last node that was concluded (in event order), or null. O(1) kernel look-up. */
  lastConcludedNode: string | null;
}

/** Mutable accumulator used during a fold — identical shape to RunProjection. */
export interface FoldAccumulator extends RunProjection {
  /** Tracks reserved cents per idem key; needed to release on EffectResult settle. */
  _reservedByIdem: Map<string, number>;
  /** Tracks the capKey per idem key for per-capability spend accounting. */
  _capKeyByIdem: Map<string, string>;
  /**
   * Set when an AdmissionDecision(denied) event is folded. NOT the same as `failed`.
   * `failed` is true only once a RunFailed event has been committed — that invariant
   * must hold for any consumer reading the projection. `_admissionDenied` signals to
   * the kernel that it should return {kind:"fail"}, which causes the engine to append
   * RunFailed, after which the next fold sets `failed=true` via the RunFailed handler.
   * This separates fold-layer state reconstruction from run-failure business logic.
   */
  _admissionDenied: boolean;
  /**
   * Sub-runs that have been requested but not yet completed.
   * Maps idemKey → subRunId. Used by the engine on crash-resume to re-attach.
   */
  _pendingSubRuns: Map<string, string>;
  /**
   * Sub-runs that have completed (succeeded or failed).
   * Maps idemKey → { output, error }. Used by the engine to skip re-execution.
   */
  _completedSubRuns: Map<string, { output?: Record<string, unknown>; error?: string }>;
}

/** Create a fresh empty fold accumulator (the zero state). */
export function emptyAccumulator(): FoldAccumulator {
  return {
    started: false,
    completed: false,
    failed: false,
    nodes: {},
    resultsByIdem: new Set(),
    requestedByIdem: new Set(),
    openAwaits: new Set(),
    resolvedApprovals: new Map(),
    budget: { runSpentCents: 0, runReservedCents: 0, perCapSpentCents: {}, perCapReservedCents: {} },
    state: {},
    currentNode: null,
    lastConcludedNode: null,
    _reservedByIdem: new Map(),
    _capKeyByIdem: new Map(),
    _admissionDenied: false,
    _pendingSubRuns: new Map(),
    _completedSubRuns: new Map(),
  };
}

/**
 * Apply a single event to an accumulator IN PLACE.
 * Both project() and foldDelta() call this — one source of truth for fold logic.
 * The caller owns the accumulator and is responsible for deep-copying before
 * calling this if immutability is required.
 */
export function applyEvent(acc: FoldAccumulator, e: LedgerEvent): void {
  const node = e.scope.nodeId;
  const pl = asObj(e.payload);

  switch (e.type) {
    case "RunStarted":
      acc.started = true;
      break;
    case "RunCompleted":
      acc.completed = true;
      break;
    case "RunFailed":
      acc.failed = true;
      break;
    case "NodeEntered": {
      if (node) {
        const ns = (acc.nodes[node] ??= { entered: false, concluded: false, visits: 0 });
        ns.entered = true;
        ns.visits += 1;
        acc.currentNode = node;
      }
      break;
    }
    case "NodeConcluded": {
      if (node) {
        const ns = (acc.nodes[node] ??= { entered: false, concluded: false, visits: 0 });
        ns.concluded = true;
        if (isObj(pl["state"])) {
          for (const [k, v] of Object.entries(pl["state"] as Record<string, unknown>)) {
            // Only flat scalars enter run state — arrays/objects are silently dropped.
            if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              acc.state[k] = v;
            }
          }
        }
        if (acc.currentNode === node) acc.currentNode = null;
        acc.lastConcludedNode = node;
      }
      break;
    }
    case "AdmissionDecision": {
      const idem = str(pl["idem"]);
      const admitted = bool(pl["admitted"]);
      if (!admitted) {
        // Signal that the kernel should return {kind:"fail"} on the next decide().
        // We do NOT set acc.failed=true here — that field must only be set by the
        // RunFailed event handler so the invariant "failed===true iff RunFailed is
        // committed" holds for any consumer reading the projection at any point.
        acc._admissionDenied = true;
      }
      const reservedCents = num(pl["reservedCents"]);
      if (admitted && idem && reservedCents > 0) {
        acc.budget.runReservedCents += reservedCents;
        acc._reservedByIdem.set(idem, reservedCents);
        const capKey = str(pl["capKey"]);
        if (capKey) {
          acc._capKeyByIdem.set(idem, capKey);
          acc.budget.perCapReservedCents[capKey] = (acc.budget.perCapReservedCents[capKey] ?? 0) + reservedCents;
        }
      }
      break;
    }
    case "EffectRequested": {
      const idem = str(pl["idem"]);
      if (idem) acc.requestedByIdem.add(idem);
      break;
    }
    case "EffectResult": {
      const idem = str(pl["idem"]);
      if (idem) {
        acc.resultsByIdem.add(idem);
        // Clamp to >= 0: a malicious/buggy plugin returning negative costCents must
        // never corrupt runSpentCents downward and defeat budget gating.
        const cost = Math.max(0, num(pl["costCents"]));
        acc.budget.runSpentCents += cost;
        const reserved = acc._reservedByIdem.get(idem) ?? 0;
        acc.budget.runReservedCents = Math.max(0, acc.budget.runReservedCents - reserved);
        const capKey = acc._capKeyByIdem.get(idem);
        if (capKey) {
          acc.budget.perCapSpentCents[capKey] = (acc.budget.perCapSpentCents[capKey] ?? 0) + cost;
          // Release per-cap reservation so subsequent admit() sees the correct reserved amount.
          acc.budget.perCapReservedCents[capKey] = Math.max(0, (acc.budget.perCapReservedCents[capKey] ?? 0) - reserved);
        }
      }
      break;
    }
    case "AwaitRequested": {
      const correlationId = str(pl["correlationId"]);
      if (correlationId) acc.openAwaits.add(correlationId);
      break;
    }
    case "AwaitResolved": {
      const correlationId = str(pl["correlationId"]);
      if (correlationId) {
        acc.openAwaits.delete(correlationId);
        const decision = str(pl["decision"]);
        if (decision === "approve" || decision === "deny") acc.resolvedApprovals.set(correlationId, decision);
      }
      break;
    }
    case "SubRunRequested": {
      // Parent records: a sub-run was spawned for this idem key.
      const idem = str(pl["idem"]);
      const subRunId = str(pl["subRunId"]);
      if (idem && subRunId) acc._pendingSubRuns.set(idem, subRunId);
      break;
    }
    case "SubRunCompleted": {
      // Parent records: sub-run finished. Move from pending → completed, merge output.
      const idem = str(pl["idem"]);
      if (idem) {
        acc._pendingSubRuns.delete(idem);
        const output = isObj(pl["output"]) ? (pl["output"] as Record<string, unknown>) : {};
        acc._completedSubRuns.set(idem, { output });
        // Sub-run cost settles against parent budget (same as EffectResult).
        const cost = Math.max(0, num(pl["actualCostCents"]));
        acc.budget.runSpentCents += cost;
        const reserved = acc._reservedByIdem.get(idem) ?? 0;
        acc.budget.runReservedCents = Math.max(0, acc.budget.runReservedCents - reserved);
        const capKey = acc._capKeyByIdem.get(idem);
        if (capKey) {
          acc.budget.perCapSpentCents[capKey] = (acc.budget.perCapSpentCents[capKey] ?? 0) + cost;
          acc.budget.perCapReservedCents[capKey] = Math.max(0, (acc.budget.perCapReservedCents[capKey] ?? 0) - reserved);
        }
        // Also mark as a result so the normal idempotency check (resultsByIdem) catches it.
        acc.resultsByIdem.add(idem);
      }
      break;
    }
    case "SubRunFailed": {
      // Parent records: sub-run failed. Move from pending → completed with error.
      const idem = str(pl["idem"]);
      if (idem) {
        acc._pendingSubRuns.delete(idem);
        const reason = str(pl["reason"]) ?? "sub-run failed";
        acc._completedSubRuns.set(idem, { error: reason });
        // Settle reserved budget even on failure (the sub-run consumed it).
        const cost = Math.max(0, num(pl["actualCostCents"]));
        acc.budget.runSpentCents += cost;
        const reserved = acc._reservedByIdem.get(idem) ?? 0;
        acc.budget.runReservedCents = Math.max(0, acc.budget.runReservedCents - reserved);
        const capKey = acc._capKeyByIdem.get(idem);
        if (capKey) {
          acc.budget.perCapSpentCents[capKey] = (acc.budget.perCapSpentCents[capKey] ?? 0) + cost;
          acc.budget.perCapReservedCents[capKey] = Math.max(0, (acc.budget.perCapReservedCents[capKey] ?? 0) - reserved);
        }
        acc.resultsByIdem.add(idem);
      }
      break;
    }
  }
}

export function project(events: readonly LedgerEvent[]): FoldAccumulator {
  const acc = emptyAccumulator();
  for (const e of events) applyEvent(acc, e);
  return acc;
}

/**
 * A crash hole: an effect was requested but has no result.
 * Returns the set of idem keys that are holes (the kernel HALTs and re-gates these).
 */
export function crashHoles(p: RunProjection): string[] {
  const holes: string[] = [];
  for (const idem of p.requestedByIdem) {
    if (!p.resultsByIdem.has(idem)) holes.push(idem);
  }
  return holes;
}
