/**
 * Incremental fold — eliminates the O(n²) re-read in the engine loop.
 *
 * The engine calls fold() after EVERY step. Without checkpointing, each fold
 * re-reads the entire event log from offset 0, so a run with N steps does
 * O(N²) total I/O. IncrementalFolder keeps a checkpoint projection and only
 * processes NEW events since the last checkpoint.
 *
 * Two paths:
 *  - Hot (no open reservations): deep-copy the checkpoint accumulator, apply
 *    only the new events via applyEvent(), return the result.
 *  - Safe (open reservations): full fold from scratch. This only happens
 *    mid-node (between AdmissionDecision and EffectResult) — a tiny window
 *    that doesn't affect the typical multi-node run's O(n) amortised cost.
 *
 * Correctness: applyEvent() is the single source of truth for the fold
 * transition function — both project() and foldDelta() call it, so they
 * can never diverge.
 *
 * Snapshot index: snapshotIndex is an ARRAY INDEX into the events slice
 * returned by readRun(), NOT a global event offset. Global offsets are
 * non-contiguous across tenants (readRun filters by runId), so using
 * the event's .offset field as an array index would produce wrong slice
 * boundaries and permanently defeat the hot path in multi-run tenants.
 */

import type { LedgerStore } from "../ledger/store.js";
import { project, applyEvent, emptyAccumulator, type RunProjection, type FoldAccumulator } from "./project.js";
import type { LedgerEvent } from "../ledger/event.js";

export class IncrementalFolder {
  /** Array index of the last checkpointed event in the readRun() result slice. -1 = no checkpoint. */
  private snapshotIndex = -1;
  private snapshotAcc: FoldAccumulator = emptyAccumulator();

  constructor(
    private readonly store: LedgerStore,
    private readonly tenantId: string,
    private readonly runId: string,
  ) {}

  async fold(): Promise<RunProjection> {
    const all = await this.store.readRun(this.tenantId, this.runId);

    // Safety reset: log shrank (only happens in tests that replace the store).
    if (this.snapshotIndex >= 0 && all.length <= this.snapshotIndex) {
      this.reset();
    }

    if (this.snapshotIndex < 0) {
      return this.fullFold(all);
    }

    // Open reservations → safe path: full fold from scratch.
    // This is O(n) but only during the brief AdmissionDecision→EffectResult window.
    if (this.snapshotAcc.budget.runReservedCents > 0) {
      return this.fullFold(all);
    }

    // Hot path: apply only new events on top of the checkpoint.
    // snapshotIndex is the array index of the last checkpointed event, so
    // new events start at snapshotIndex + 1.
    const newEvents = all.slice(this.snapshotIndex + 1);
    // Return via foldDelta even for zero new events so the caller never receives
    // a direct reference to snapshotAcc (whose Set/Map fields are mutable).
    if (newEvents.length === 0) return foldDelta(this.snapshotAcc, []);

    const p = foldDelta(this.snapshotAcc, newEvents);
    this.save(all, p);
    return p;
  }

  reset(): void {
    this.snapshotIndex = -1;
    this.snapshotAcc = emptyAccumulator();
  }

  private fullFold(all: LedgerEvent[]): FoldAccumulator {
    // project() now returns FoldAccumulator — no cast needed.
    const p = project(all);
    this.save(all, p);
    // Return via foldDelta so the caller never receives a direct reference to
    // snapshotAcc (whose Set/Map fields are mutable). Same protection as the
    // zero-new-events hot path.
    return foldDelta(p, []);
  }

  private save(all: LedgerEvent[], acc: FoldAccumulator): void {
    // Store the array index (not the event's .offset field) so slice() works correctly
    // even when global offsets are non-contiguous (e.g., readRun() filters by runId).
    this.snapshotIndex = all.length - 1;
    this.snapshotAcc = acc;
  }
}

/**
 * Apply `newEvents` on top of a deep copy of `base`.
 * Uses applyEvent() — the single fold transition function shared with project().
 * Only valid when base.runReservedCents === 0 (no open reservations).
 */
function foldDelta(base: FoldAccumulator, newEvents: LedgerEvent[]): FoldAccumulator {
  // Deep-copy the mutable accumulator so the checkpoint is not mutated.
  const acc: FoldAccumulator = {
    started: base.started,
    completed: base.completed,
    failed: base.failed,
    nodes: Object.fromEntries(Object.entries(base.nodes).map(([k, v]) => [k, { ...v }])),
    resultsByIdem: new Set(base.resultsByIdem),
    requestedByIdem: new Set(base.requestedByIdem),
    openAwaits: new Set(base.openAwaits),
    budget: {
      runSpentCents: base.budget.runSpentCents,
      runReservedCents: base.budget.runReservedCents,
      perCapSpentCents: { ...base.budget.perCapSpentCents },
      perCapReservedCents: { ...base.budget.perCapReservedCents },
    },
    state: { ...base.state },
    currentNode: base.currentNode,
    lastConcludedNode: base.lastConcludedNode,
    _admissionDenied: base._admissionDenied,
    // base has runReservedCents=0, so _reservedByIdem/_capKeyByIdem are fresh for new events.
    _reservedByIdem: new Map(),
    _capKeyByIdem: new Map(),
    _pendingSubRuns: new Map(base._pendingSubRuns),
    _completedSubRuns: new Map(base._completedSubRuns),
  };

  for (const e of newEvents) applyEvent(acc, e);
  return acc;
}
