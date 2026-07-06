/**
 * SubAgentExecutor — runs an agent-as-capability sub-run.
 *
 * Architecture (from the design session):
 *
 *  LEDGER TOPOLOGY: Separate runs, linked by ID.
 *    The sub-run gets its own runId (deterministic: hash of parentRunId+nodeId+capName).
 *    The parent ledger records only SubRunRequested / SubRunCompleted / SubRunFailed.
 *    Each ledger is independently auditable.
 *
 *  BUDGET: Parent reserves → sub-run draws from that reservation.
 *    budgetCents from the CapabilityRef becomes the sub-run's entire ceiling.
 *    Actual spend settles back to parent via SubRunCompleted(actualCostCents).
 *
 *  IDEMPOTENCY: subRunId is deterministic.
 *    subRunId = hash(parentRunId + nodeId + capabilityName)
 *    On crash-resume, the parent folds SubRunRequested → knows the subRunId →
 *    checks sub-run ledger for terminal state → re-attaches or continues.
 *
 *  FAILURE: configurable per capability ref (default: return-error).
 *    "propagate"   → parent fails with the sub-run's reason
 *    "return-error" → parent gets EffectResult({ error }) and can route around it
 *
 *  OUTPUT: declared mapping.
 *    Sub-agent manifest declares public output keys.
 *    Parent capability ref maps those keys → parent state keys.
 *    Validated at admission time.
 */

import { contentAddress } from "../ledger/crypto.js";
import { canonicalize } from "../ledger/canonical.js";
import { Engine, type EngineDeps, type RunResult } from "./engine.js";
import type { EffectCall } from "../capability/capability.js";
import type { Manifest } from "../manifest/manifest.js";
import type { SubAgentBinding } from "../manifest/manifest.js";
import type { LedgerStore } from "../ledger/store.js";
import type { FoldAccumulator } from "./project.js";
import { project } from "./project.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("sub-agent-executor");

export interface SubRunContext {
  parentRunId: string;
  tenantId: string;
  nodeId: string;
  capabilityName: string;
  budgetCents: number;
  binding: SubAgentBinding;
  subManifest: Manifest;
  initialState: Record<string, string | number | boolean | null>;
  /** Parent's approval callback — threaded into sub-run so HITL policy propagates. */
  approve: (call: EffectCall) => boolean;
}

export interface SubRunOutcome {
  subRunId: string;
  /** Mapped output keys for the parent's run state. */
  output: Record<string, unknown>;
  actualCostCents: number;
  failed: false;
}

export interface SubRunFailure {
  subRunId: string;
  reason: string;
  actualCostCents: number;
  failed: true;
}

export type SubRunResult = SubRunOutcome | SubRunFailure;

/**
 * Deterministic sub-run ID.
 * Same inputs after a crash → same ID → no double spawn.
 */
export function deriveSubRunId(parentRunId: string, nodeId: string, capabilityName: string): string {
  return `sub-${contentAddress(canonicalize({ parentRunId, nodeId, capabilityName })).slice(0, 24)}`;
}

/**
 * Validate that a SubAgentBinding's outputMapping references only keys
 * that exist in the sub-manifest's node outputs.
 *
 * We do a best-effort check: we verify the sub-manifest is structurally valid
 * and that outputMapping keys are non-empty strings. Full schema validation
 * (checking declared output keys) would require the sub-manifest to declare
 * outputs explicitly — a future enhancement.
 *
 * Returns null if valid, or an error message.
 */
export function validateSubAgentBinding(
  binding: SubAgentBinding,
  subManifest: Manifest,
): string | null {
  if (!subManifest.nodes.length) return "sub-agent manifest has no nodes";
  if (!binding.outputMapping || typeof binding.outputMapping !== "object") {
    return "outputMapping must be an object";
  }
  for (const [parentKey, subKey] of Object.entries(binding.outputMapping)) {
    if (!parentKey.trim()) return "outputMapping has an empty parent key";
    if (typeof subKey !== "string" || !subKey.trim()) {
      return `outputMapping['${parentKey}'] must be a non-empty string`;
    }
  }
  return null;
}

/**
 * Execute a sub-agent run on behalf of a parent capability call.
 *
 * This is called by the engine when it encounters a CapabilityRef with a
 * `subAgent` binding. It:
 *   1. Derives the deterministic subRunId
 *   2. Checks if a sub-run with this ID already exists in the ledger (crash recovery)
 *   3. If terminal: returns the result directly (idempotent re-serve)
 *   4. If pending: waits for it to complete (re-attach)
 *   5. If absent: spawns a new Engine for the sub-manifest
 *
 * The parent ledger events (SubRunRequested / SubRunCompleted / SubRunFailed)
 * are written by the ENGINE after calling this function, not here.
 * This function only runs the sub-agent and returns the outcome.
 */
export async function executeSubRun(
  ctx: SubRunContext,
  store: LedgerStore,
  deps: EngineDeps,
  parentProjection: FoldAccumulator,
): Promise<SubRunResult> {
  const subRunId = deriveSubRunId(ctx.parentRunId, ctx.nodeId, ctx.capabilityName);
  const idem = `${ctx.nodeId}:${ctx.capabilityName}`;

  // ── Crash recovery: check if already completed ─────────────────────────────
  const completed = parentProjection._completedSubRuns.get(idem);
  if (completed) {
    log.info({ subRunId, idem }, "sub-run already completed (idempotent re-serve)");
    if (completed.error) {
      return { subRunId, reason: completed.error, actualCostCents: 0, failed: true };
    }
    return {
      subRunId,
      output: completed.output ?? {},
      actualCostCents: 0,
      failed: false,
    };
  }

  // ── Check if sub-run is already in the ledger (pending) ──────────────────
  const pendingSubRunId = parentProjection._pendingSubRuns.get(idem);
  if (pendingSubRunId) {
    // Sub-run was spawned but parent crashed before recording completion.
    // Check the sub-run's own ledger for terminal state.
    log.info({ subRunId: pendingSubRunId, idem }, "resuming pending sub-run");
    return checkAndWaitForSubRun(pendingSubRunId, ctx, store, deps);
  }

  // ── Fresh spawn ────────────────────────────────────────────────────────────
  log.info({ subRunId, parentRunId: ctx.parentRunId, nodeId: ctx.nodeId, cap: ctx.capabilityName }, "spawning sub-run");

  return runSubAgent(subRunId, ctx, store, deps);
}

/**
 * Check the sub-run ledger for terminal state. If already terminated, return result.
 * If still running (e.g. parent crashed mid-run), re-run from current state.
 */
async function checkAndWaitForSubRun(
  subRunId: string,
  ctx: SubRunContext,
  store: LedgerStore,
  deps: EngineDeps,
): Promise<SubRunResult> {
  const events = await store.readRun(ctx.tenantId, subRunId);
  if (events.length > 0) {
    const p = project(events);
    if (p.completed) {
      log.info({ subRunId }, "sub-run already completed in ledger");
      return buildOutcome(subRunId, p, ctx.binding);
    }
    if (p.failed) {
      const lastEvent = events[events.length - 1];
      const reason = lastEvent ? String((lastEvent.payload as Record<string, unknown>)["reason"] ?? "sub-run failed") : "sub-run failed";
      log.info({ subRunId, reason }, "sub-run already failed in ledger");
      return { subRunId, reason, actualCostCents: p.budget.runSpentCents, failed: true };
    }
  }
  // Sub-run exists in ledger but hasn't terminated — resume it.
  return runSubAgent(subRunId, ctx, store, deps);
}

/**
 * Run the sub-agent engine to completion and return the outcome.
 */
async function runSubAgent(
  subRunId: string,
  ctx: SubRunContext,
  store: LedgerStore,
  deps: EngineDeps,
): Promise<SubRunResult> {
  // Build a sub-manifest with the reserved budget as ceiling.
  const subManifest: Manifest = {
    ...ctx.subManifest,
    runBudgetCents: ctx.budgetCents,
  };

  const subEngine = new Engine(subManifest, ctx.tenantId, subRunId, deps);

  let result: RunResult;
  try {
    // gateAllConsequential forces the approval gate for every consequential effect even on an
    // autonomy:"full" sub-node — so a delegated sub-agent can never take an unsupervised
    // irreversible / spend / message-human / identity-mutation action, regardless of its manifest.
    result = await subEngine.run({ initialState: ctx.initialState, approve: ctx.approve, gateAllConsequential: true });
  } catch (err) {
    log.error({ err, subRunId }, "sub-run engine threw unexpectedly");
    return { subRunId, reason: (err as Error).message, actualCostCents: 0, failed: true };
  }

  if (result.status === "completed") {
    return buildOutcome(subRunId, result.projection as FoldAccumulator, ctx.binding);
  }

  return {
    subRunId,
    reason: result.reason ?? result.status,
    actualCostCents: result.projection.budget.runSpentCents,
    failed: true,
  };
}

/**
 * Build a SubRunOutcome from a completed sub-run projection.
 * Applies the outputMapping: sub-agent state keys → parent state keys.
 */
function buildOutcome(
  subRunId: string,
  projection: FoldAccumulator,
  binding: SubAgentBinding,
): SubRunOutcome {
  const output: Record<string, unknown> = {};

  for (const [parentKey, subKey] of Object.entries(binding.outputMapping)) {
    // Sub-agent state keys are namespaced as "nodeId.key" by the engine.
    // The outputMapping should reference the full namespaced key.
    const val = projection.state[subKey];
    if (val !== undefined) {
      output[parentKey] = val;
    }
  }

  return {
    subRunId,
    output,
    actualCostCents: projection.budget.runSpentCents,
    failed: false,
  };
}
