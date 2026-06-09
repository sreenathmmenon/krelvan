/**
 * Observability — the trust surface. Pure reducers (zero ambient authority: no I/O,
 * no clock, no eval) that fold the one signed ledger into the views a human reads:
 * the canvas, the cost meter, the audit timeline, and the two replay modes.
 *
 * The decided trust guarantee is EVIDENTIARY FIDELITY ("what you see is exactly what
 * executed"), NOT reproducibility — LLMs are stochastic, so we re-serve captured
 * results rather than promising the agent would choose identically again.
 *
 * Two replay modes (the headline "wow" + the anti-footgun):
 *  - VERIFICATION replay: a pure fold; zero side effects; reconciles cost to the
 *    cent. A re-fold that doesn't reconcile renders the run UNVERIFIABLE (loud).
 *  - COUNTERFACTUAL replay: forks at a node; would RE-GATE every downstream effect
 *    through admission — so a "what if" branch can never silently re-spend money or
 *    re-send messages. Here we expose the plan (which effects WOULD re-gate) so the
 *    UI shows projected cost instead of executing.
 */

import { verify, type LedgerStore } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/event.js";
import type { Verifier } from "../ledger/crypto.js";
import { project, type RunProjection } from "../kernel/project.js";
import { asObj, str, num } from "../ledger/payload.js";

export interface CanvasView {
  nodes: { id: string; status: "idle" | "running" | "done" | "failed"; visits: number }[];
}

export interface CostView {
  spentCents: number;
  reservedCents: number;
  /** per-effect settled cost. */
  byEffect: Record<string, number>;
}

export interface TimelineEntry {
  offset: number;
  scope: string;
  type: string;
  author: string;
}

/** Canvas = node states folded from the log. */
export function canvasView(p: RunProjection): CanvasView {
  return {
    nodes: Object.entries(p.nodes).map(([id, s]) => ({
      id,
      status: s.concluded ? "done" : s.entered ? "running" : "idle",
      visits: s.visits,
    })),
  };
}

/** Cost meter = settled costs + open reservations, folded from the log. */
export function costView(events: readonly LedgerEvent[]): CostView {
  const p = project(events);
  const byEffect: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "EffectResult") {
      const pl = asObj(e.payload);
      const idem = str(pl["idem"]);
      if (idem) byEffect[idem] = num(pl["costCents"]);
    }
  }
  return { spentCents: p.budget.runSpentCents, reservedCents: p.budget.runReservedCents, byEffect };
}

/** Audit timeline = one line per event. */
export function timelineView(events: readonly LedgerEvent[]): TimelineEntry[] {
  return events.map((e) => ({
    offset: e.offset,
    scope: e.scope.nodeId ?? "run",
    type: e.type,
    author: e.author,
  }));
}

export type VerificationResult =
  | { ok: true; reconciledCostCents: number }
  | { ok: false; reason: "UNVERIFIABLE"; detail: string };

/**
 * VERIFICATION replay: re-verify the chain (catches any corruption) and recompute
 * the cost purely from the log. Zero side effects. If the chain doesn't verify, the
 * run is UNVERIFIABLE — loud, never confident-but-wrong.
 */
export function verificationReplay(events: readonly LedgerEvent[], verifier: Verifier): VerificationResult {
  const v = verify(events, verifier);
  if (!v.ok) return { ok: false, reason: "UNVERIFIABLE", detail: `${v.error.kind}: ${v.error.message}` };
  const cost = costView(events);
  return { ok: true, reconciledCostCents: cost.spentCents };
}

/** A planned counterfactual step: an effect that WOULD re-gate (not execute) on a fork. */
export interface CounterfactualPlan {
  forkAtNodeId: string;
  /** effects downstream of the fork that would be re-gated through admission. */
  wouldRegate: { idem: string; effect: string; projectedCostCents: number }[];
  /** total PROJECTED cost if the fork ran (reserved, not spent). */
  projectedCostCents: number;
}

/**
 * Plan a counterfactual replay forked at a node WITHOUT executing anything. Every
 * downstream effect is marked "wouldRegate" — meaning on a real fork it would pass
 * through the admission gate again (re-prompting for spend/irreversible), so a "what
 * if" can never silently re-spend. The UI shows projectedCost; nothing is charged.
 *
 * Effect name is read from EffectRequested (which carries the capability name) rather
 * than EffectResult (which does not). We correlate via the idem key.
 */
export function planCounterfactual(events: readonly LedgerEvent[], forkAtNodeId: string): CounterfactualPlan {
  // Build capability name lookup from EffectRequested events (which carry the capability field).
  const capabilityByIdem = new Map<string, string>();
  for (const e of events) {
    if (e.type === "EffectRequested") {
      const pl = asObj(e.payload);
      const idem = str(pl["idem"]);
      const capability = str(pl["capability"]);
      if (idem && capability) capabilityByIdem.set(idem, capability);
    }
  }

  const wouldRegate: CounterfactualPlan["wouldRegate"] = [];
  let pastFork = false;
  let projected = 0;

  for (const e of events) {
    if (e.scope.nodeId === forkAtNodeId && e.type === "NodeEntered") pastFork = true;
    if (!pastFork) continue;
    if (e.type === "EffectResult") {
      const pl = asObj(e.payload);
      const idem = str(pl["idem"]) ?? "?";
      const cost = num(pl["costCents"]);
      projected += cost;
      wouldRegate.push({
        idem,
        effect: capabilityByIdem.get(idem) ?? "unknown",
        projectedCostCents: cost,
      });
    }
  }
  return { forkAtNodeId, wouldRegate, projectedCostCents: projected };
}

/** Convenience: fold everything for one run straight from a store. */
export async function observeRun(store: LedgerStore, tenantId: string, runId: string, verifier: Verifier) {
  const events = await store.readRun(tenantId, runId);
  const p = project(events);
  return {
    canvas: canvasView(p),
    cost: costView(events),
    timeline: timelineView(events),
    verification: verificationReplay(events, verifier),
  };
}
