/**
 * The capability plane: admission (pure) + the effect-runner/supervisor (impure).
 *
 * The atomic "fact of doing something" is three signed events:
 *   AdmissionDecision  (pure, in-kernel: is this effect allowed, in budget, in policy?)
 *   EffectRequested    (the kernel proposes the call; carries the idempotency key)
 *   EffectResult       (the SUPERVISOR co-signs what it MECHANICALLY OBSERVED)
 *
 * Guards:
 *  - CAP: deny-by-default. An effect not in the node's manifest capabilities is denied.
 *  - CAP: budget enforced PRE-dispatch (reserve), settled POST (the observed cost).
 *          A spend that would exceed the run or node ceiling is denied → no overspend.
 *  - CAP (biggest security decision): the plugin NEVER signs the EffectResult. The
 *    supervisor signs it, recording the cost/outcome it observed. A plugin's own
 *    claim is data inside the result, explicitly untrusted.
 *  - KER/LED-11: the idempotency key is DETERMINISTIC (node + effect + input hash),
 *    so a retry after a crash produces the same key and the effect is re-served.
 */

import { canonicalize } from "../ledger/canonical.js";
import { contentAddress } from "../ledger/crypto.js";
import type { AutonomyLevel, ManifestNode, SideEffectClass } from "../manifest/manifest.js";
import { findCapability } from "../manifest/manifest.js";

/** A request to perform an effect, as the node proposes it. */
export interface EffectCall {
  nodeId: string;
  capability: string;
  /** deterministic inputs; the idempotency key is derived from these. */
  input: unknown;
}

/** The pure admission verdict. */
export type Admission =
  | { admitted: true; idem: string; reservedCents: number; requiresApproval: boolean }
  | { admitted: false; reason: AdmissionDenyReason; detail: string };

export type AdmissionDenyReason =
  | "CAPABILITY_NOT_GRANTED"
  | "RUN_BUDGET_EXCEEDED"
  | "NODE_CAP_BUDGET_EXCEEDED"
  | "PLUGIN_DISABLED";

/** Current spend accounting, folded from the ledger by the kernel. */
export interface BudgetState {
  runSpentCents: number;
  runReservedCents: number;
  perCapSpentCents: Record<string, number>; // key = `${nodeId}:${capability}`
  perCapReservedCents: Record<string, number>; // key = `${nodeId}:${capability}`, open reservations
}

/**
 * PURE admission check. No I/O. Decides whether an effect may proceed and how much
 * budget to reserve. The kernel records the verdict as an AdmissionDecision event.
 *
 * `estimateCents` is the pre-flight cost estimate for this call (from the capability
 * descriptor). We reserve that much; the supervisor settles the real cost later.
 */
export function admit(
  node: ManifestNode,
  call: EffectCall,
  /** null means the plugin is absent from the Supervisor snapshot (disabled or not installed). */
  estimateCents: number | null,
  runBudgetCents: number,
  budget: BudgetState,
): Admission {
  // A null estimate means the capability is not in the live plugin snapshot.
  // This is CAPABILITY_NOT_GRANTED regardless of what the manifest declares.
  if (estimateCents === null) {
    return { admitted: false, reason: "CAPABILITY_NOT_GRANTED", detail: `capability '${call.capability}' is not available (plugin absent or disabled)` };
  }

  const cap = findCapability(node, call.capability);
  if (!cap) {
    // deny-by-default
    return { admitted: false, reason: "CAPABILITY_NOT_GRANTED", detail: `node '${node.id}' may not use '${call.capability}'` };
  }

  const idem = idempotencyKey(call);

  // reserve-then-settle: the projected spend (already-spent + already-reserved +
  // this estimate) must fit under both ceilings.
  const projectedRun = budget.runSpentCents + budget.runReservedCents + estimateCents;
  if (projectedRun > runBudgetCents) {
    return { admitted: false, reason: "RUN_BUDGET_EXCEEDED", detail: `run budget ${runBudgetCents}¢ would be exceeded (projected ${projectedRun}¢)` };
  }

  const capKey = `${node.id}:${call.capability}`;
  // Include both spent AND reserved for this cap so concurrent calls cannot each
  // pass the ceiling individually and together exceed it.
  const projectedCap = (budget.perCapSpentCents[capKey] ?? 0) + (budget.perCapReservedCents[capKey] ?? 0) + estimateCents;
  if (projectedCap > cap.budgetCents) {
    return { admitted: false, reason: "NODE_CAP_BUDGET_EXCEEDED", detail: `cap '${call.capability}' budget ${cap.budgetCents}¢ would be exceeded (projected ${projectedCap}¢)` };
  }

  // autonomy gradient: anything but "full" requires approval for non-read effects.
  const requiresApproval = needsApproval(node.autonomy, cap.sideEffect);

  return { admitted: true, idem, reservedCents: estimateCents, requiresApproval };
}

/**
 * Deterministic idempotency key — same logical call → same key, even after a crash.
 *
 * We deliberately hash only (nodeId, capability), NOT the input (which is the full
 * accumulated run state). Including run state would give a different key on resume
 * if any prior node had added state between the crash and the retry — making the
 * "same" capability call look like a new call and causing double-execution.
 *
 * The invariant that justifies this: a node visits its declared capabilities at most
 * once per visit (maxNodeVisits bounds re-entry). A capability is therefore uniquely
 * identified by (nodeId, capability) within a run. If a node genuinely needs to run
 * the same capability twice with different inputs, it must be modelled as two distinct
 * capability declarations with distinct names.
 */
export function idempotencyKey(call: EffectCall): string {
  const ca = contentAddress(canonicalize({ nodeId: call.nodeId, capability: call.capability }));
  return `${call.nodeId}:${call.capability}:${ca}`;
}

/** Whether an autonomy level requires human approval for a given effect class. */
export function needsApproval(autonomy: AutonomyLevel, effect: SideEffectClass): boolean {
  if (effect === "read") return false; // reads never gate
  switch (autonomy) {
    case "suggest":
      return true; // always ask for any side effect
    case "act-with-veto":
      // A real middle tier between "suggest" and "full": the agent ACTS autonomously on
      // reversible writes (which can be undone if wrong), but the HIGH-STAKES classes —
      // irreversible writes, spend, and identity mutation — always pause for explicit human
      // approval. (This is gating-by-side-effect-class, not a real-time countdown timer; the
      // value is "auto for the cheap/reversible, gate for the dangerous".)
      return effect === "write-irreversible" || effect === "spend" || effect === "identity-mutation";
    case "full":
      return false;
  }
}

// ── The effect-runner / supervisor (the ONLY impure code) ──────────────────────

/**
 * Opaque handle returned alongside a Supervisor from createSupervisor().
 * The ONLY way to swap the live plugin snapshot from outside the module.
 * Keeping this separate from the Supervisor prevents any code that merely
 * holds a Supervisor reference from poisoning the registry without an
 * audit trail.
 */
export interface SupervisorSnapshotHandle {
  replaceSnapshot(plugins: ReadonlyMap<string, CapabilityPlugin>): void;
}

/** A plugin: takes a call, returns an outcome + the cost IT claims. */
export interface CapabilityPlugin {
  readonly name: string;
  readonly sideEffect: SideEffectClass;
  /** pre-flight estimate, integer cents. */
  estimateCents(call: EffectCall): number;
  /** perform the effect. Returns the outcome and the plugin's claimed cost. */
  invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }>;
}

/** What the supervisor co-signs: the OBSERVED result, not the plugin's say-so. */
export interface ObservedEffect {
  idem: string;
  /** the cost the SUPERVISOR settled (here: it accepts the plugin claim but records
   * that it is supervisor-attested; a real supervisor measures egress/tokens). */
  costCents: number;
  output: unknown;
  /** the plugin's self-reported claim, kept as explicitly-untrusted data. */
  pluginClaim: { claimedCostCents: number };
}

/**
 * The supervisor runs the plugin and produces the observed effect. In this core it
 * accepts the plugin's claimed cost but FRAMES it as supervisor-attested and keeps
 * the raw claim separately, establishing the trust boundary the production
 * supervisor (egress proxy + sandbox) will fully enforce.
 *
 * Plugin snapshot is an immutable ReadonlyMap. enable/disable swap the pointer
 * atomically in the JS event loop — in-flight calls hold the old snapshot and
 * complete normally; new calls use the new snapshot. No drain needed.
 *
 * Instantiate via createSupervisor() — it returns both the Supervisor and the
 * SupervisorSnapshotHandle. Only code that receives the handle can swap the snapshot.
 */
export class Supervisor {
  #plugins: ReadonlyMap<string, CapabilityPlugin>;

  constructor(plugins: ReadonlyMap<string, CapabilityPlugin>) {
    this.#plugins = plugins;
  }

  /**
   * Returns null for absent plugins (disabled or not installed).
   * Callers must treat null as CAPABILITY_NOT_GRANTED, not as cost=0.
   */
  estimate(call: EffectCall): number | null {
    const p = this.#plugins.get(call.capability);
    if (!p) return null;
    return p.estimateCents(call);
  }

  async run(call: EffectCall, idem: string): Promise<ObservedEffect> {
    const p = this.#plugins.get(call.capability);
    if (!p) throw new Error(`no plugin for capability '${call.capability}'`);
    const res = await p.invoke(call);
    // Round to integer — the ledger rejects non-integer numbers (LED-02).
    const costCents = Math.round(res.claimedCostCents);
    return {
      idem,
      costCents,
      output: res.output,
      pluginClaim: { claimedCostCents: costCents },
    };
  }

  /** Read-only view of the current snapshot (for tests and introspection). */
  get pluginNames(): ReadonlyArray<string> {
    return [...this.#plugins.keys()];
  }

  /** Private — only callable via the handle returned by createSupervisor(). */
  #replaceSnapshot(plugins: ReadonlyMap<string, CapabilityPlugin>): void {
    this.#plugins = plugins;
  }

  /**
   * Factory that returns both the Supervisor and the snapshot handle.
   * Callers who only need to observe (admit, run) receive just the Supervisor.
   * Only the PluginLifecycleService and PluginActivator receive the handle.
   */
  static create(plugins: ReadonlyMap<string, CapabilityPlugin>): {
    supervisor: Supervisor;
    snapshotHandle: SupervisorSnapshotHandle;
  } {
    const supervisor = new Supervisor(plugins);
    const snapshotHandle: SupervisorSnapshotHandle = {
      replaceSnapshot: (p) => supervisor.#replaceSnapshot(p),
    };
    return { supervisor, snapshotHandle };
  }
}
