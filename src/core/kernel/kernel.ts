/**
 * The pure kernel: decide(manifest, projection) -> next Decision.
 *
 * NO I/O. Given the manifest and the folded run state, it returns the single next
 * thing to do. The engine (impure) carries it out and appends events; then the
 * kernel is asked again. This is "execution is a reduction over the log".
 *
 * Guards:
 *  - KER: deterministic — depends only on (manifest, projection).
 *  - LED-10: if there is a crash hole, the decision is HALT (re-gate), never auto-run.
 *  - KER: loop bound — a node visited maxNodeVisits times fails the run (anti-runaway).
 *  - MAN: edge selection uses the restricted expr evaluator, never eval.
 */

import {
  evalCondition,
  referencedKeys,
  type RunState,
} from "../manifest/expr.js";
import { getNode, type Manifest } from "../manifest/manifest.js";
import { crashHoles, type FoldAccumulator, type RunProjection } from "./project.js";

export type Decision =
  | { kind: "start" }
  | { kind: "enter"; nodeId: string }
  | { kind: "runNode"; nodeId: string } // node body: emit effects (engine decides which)
  | { kind: "conclude"; nodeId: string }
  | { kind: "advance"; fromNodeId: string; toNodeId: string }
  | { kind: "complete" }
  | { kind: "halt"; reason: string; holes?: string[] }
  | { kind: "fail"; reason: string };

/** The set of state keys the manifest's edges may reference (for expr validation). */
export function declaredEdgeKeys(m: Manifest): Set<string> {
  const keys = new Set<string>();
  for (const e of m.edges) if (e.when) referencedKeys(e.when, keys);
  return keys;
}

/**
 * Decide the next action. `nodeReady` tells the kernel whether the engine has
 * finished the current node's body (all its effects have results). The kernel
 * itself never runs effects; it sequences.
 */
export function decide(m: Manifest, p: RunProjection, declared: ReadonlySet<string>): Decision {
  if (p.failed) return { kind: "fail", reason: "run already failed" };
  // _admissionDenied is set by the fold when AdmissionDecision(denied) is committed but
  // RunFailed has not been appended yet. The kernel triggers the fail here so the engine
  // appends RunFailed; the subsequent fold sets p.failed=true via the RunFailed handler.
  if ((p as FoldAccumulator)._admissionDenied) return { kind: "fail", reason: "admission denied" };
  if (p.completed) return { kind: "complete" };

  // Crash-hole safety FIRST: never proceed past an unresolved side effect.
  const holes = crashHoles(p);
  if (holes.length > 0) {
    return { kind: "halt", reason: "unresolved effect(s) — re-gate before proceeding", holes };
  }

  if (!p.started) return { kind: "start" };

  // Open awaits: a node is parked waiting for human approval. The engine wrote
  // AwaitRequested but no AwaitResolved yet. Halt — do not re-enter runNode —
  // until an external actor appends AwaitResolved (via the interaction resolver).
  if (p.openAwaits.size > 0) {
    const ids = [...p.openAwaits];
    return { kind: "halt", reason: `awaiting approval for: ${ids.join(", ")}`, holes: ids };
  }

  // Use O(1) projection fields instead of O(n) scans over all nodes.
  const current = p.currentNode;

  if (current === null) {
    // nothing in progress → enter the entry node (first run) … unless entry already concluded
    const entry = p.nodes[m.entry];
    if (!entry || (!entry.entered && !entry.concluded)) {
      return { kind: "enter", nodeId: m.entry };
    }
    // entry concluded → we must advance from the last concluded node
    const last = p.lastConcludedNode;
    if (last) return advanceOrComplete(m, p, declared, last);
    return { kind: "complete" };
  }

  const status = p.nodes[current]!;

  // loop bound: >= so maxNodeVisits:1 means exactly 1 visit, not 2.
  if (status.visits >= m.maxNodeVisits) {
    return { kind: "fail", reason: `node '${current}' exceeded maxNodeVisits (${m.maxNodeVisits})` };
  }

  if (status.entered && !status.concluded) {
    // The node is in progress. The engine runs its body (effects). When the engine
    // reports the body done, it will append NodeConcluded; until then, runNode.
    return { kind: "runNode", nodeId: current };
  }

  // entered & concluded → advance
  return advanceOrComplete(m, p, declared, current);
}

function advanceOrComplete(
  m: Manifest,
  p: RunProjection,
  declared: ReadonlySet<string>,
  fromNodeId: string,
): Decision {
  const outgoing = m.edges.filter((e) => e.from === fromNodeId);
  for (const edge of outgoing) {
    let take = true;
    if (edge.when) {
      try {
        take = evalCondition(edge.when, p.state as RunState, declared);
      } catch (e) {
        return { kind: "fail", reason: `edge condition error from '${fromNodeId}': ${(e as Error).message}` };
      }
    }
    if (take) {
      const target = p.nodes[edge.to];
      // Skip a concluded target ONLY if it has also exhausted its visit budget — otherwise a
      // back-edge (an evaluator->generator retry loop) may re-enter it for a fresh visit. The
      // re-entry resets `concluded` (see project.ts) and maxNodeVisits bounds the loop, so this
      // is anti-runaway. A concluded target at its visit cap falls through to the next edge.
      if (target && target.concluded && target.visits >= m.maxNodeVisits) continue;
      return { kind: "advance", fromNodeId, toNodeId: edge.to };
    }
  }
  // No outgoing edge taken: this node is terminal. A capability may return a
  // typed failure instead of throwing so a graph can route around it. If no
  // route handled that failure, do not stamp the run "completed".
  const ok = p.state[`${fromNodeId}.ok`];
  const error = p.state[`${fromNodeId}.error`];
  const hasUsefulOutput = ["result", "body", "text", "reply"]
    .some((key) => {
      const value = p.state[`${fromNodeId}.${key}`];
      return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
    });
  if (ok === false || (typeof error === "string" && error.trim() && !hasUsefulOutput)) {
    const detail = typeof error === "string" && error.trim() ? `: ${error.trim()}` : "";
    return { kind: "fail", reason: `terminal node '${fromNodeId}' returned an error${detail}` };
  }

  // no outgoing edge taken → the run is complete
  return { kind: "complete" };
}

// re-export for the engine
export { getNode };
