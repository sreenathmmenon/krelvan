/**
 * The engine — the thin IMPURE shell. The ONLY code that runs effects and appends
 * events. It loops: fold the log → ask the pure kernel → carry out the decision →
 * repeat. Crash-safe because all state is in the log; on restart it folds and
 * resumes.
 *
 * Node body model: a node's body is the ordered list of capabilities declared in
 * the manifest for that node. The manifest IS the execution plan — there is no
 * separately-passed RunPlan. Each capability call receives the CURRENT run state
 * as its input, re-folded after each preceding effect in the same node, so later
 * capabilities in a multi-capability node see outputs from earlier ones.
 *
 * Run state flow:
 *   NodeConcluded { state: { "nodeId.key": value, … } }
 *   → folded into RunProjection.state by project()
 *   → next node receives state as EffectCall.input
 *   → edge conditions evaluate against the same state
 *
 * nodeOutputState() extracts scalar values from the node's EffectResult outputs and
 * namespaces them as "nodeId.key" so multiple nodes can contribute distinct keys
 * without collision.
 *
 * Guards: KER (sequence only via kernel), LED-10/11 (re-serve, no double-exec),
 * CAP (deny-by-default + budget + supervisor co-signs), durability (resume).
 */

import type { LedgerStore } from "../ledger/store.js";
import type { Signer } from "../ledger/crypto.js";
import type { EventScope, NewEvent } from "../ledger/event.js";
import {
  admit,
  idempotencyKey,
  type EffectCall,
  type Supervisor,
} from "../capability/capability.js";
import { getNode, type Manifest } from "../manifest/manifest.js";
import type { RunState } from "../manifest/expr.js";
import { declaredEdgeKeys, decide, type Decision } from "./kernel.js";
import type { FoldAccumulator, RunProjection } from "./project.js";
import { IncrementalFolder } from "./incremental-fold.js";
import { NoopTracer, type Tracer } from "../observability/spans.js";
import { executeSubRun, deriveSubRunId } from "./sub-agent-executor.js";

/**
 * Recursively converts non-integer numbers to strings so capability outputs
 * (e.g. stock prices like 227.52) never trigger a CanonicalError when the
 * engine writes the EffectResult event to the tamper-evident ledger.
 */
function sanitizeOutput(v: unknown): unknown {
  if (typeof v === "number") {
    return Number.isInteger(v) ? v : String(v);
  }
  if (Array.isArray(v)) return v.map(sanitizeOutput);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeOutput(val);
    }
    return out;
  }
  return v;
}

export interface EngineDeps {
  store: LedgerStore;
  /** authority that signs orchestration events (kernel-authored). */
  owner: Signer;
  /** the supervisor that runs effects and co-signs their results. */
  supervisor: Supervisor;
  supervisorSigner: Signer;
  /** a monotonic logical clock supplied by the Time authority. */
  now: () => number;
  /** structured observability sink; defaults to NoopTracer if omitted. */
  tracer?: Tracer;
  /**
   * Resolve a sub-agent manifest by its pinned ID (for agent-as-capability).
   * Optional: if absent, sub-agent capabilities fail with "manifest not found".
   */
  resolveManifest?: (manifestId: string) => Promise<Manifest | null>;
  /**
   * Injectable sleep for retry backoff (tests pass a no-op to stay fast/deterministic).
   * Defaults to real setTimeout when omitted.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  status: "completed" | "halted" | "failed";
  reason?: string;
  holes?: string[];
  projection: RunProjection;
}

export interface RunOptions {
  maxSteps?: number;
  /**
   * Wall-clock deadline for the whole run, as an absolute epoch-ms timestamp (compared
   * against deps.now()). When the deadline passes, the engine stops at the next step
   * boundary and fails the run with a signed `RunFailed` event — so unattended or
   * stuck/parked runs never wait forever. Omit for no deadline (back-compat default).
   */
  deadlineMs?: number;
  /**
   * Extra retry attempts for a capability invoke that THROWS a transient error
   * (network blip, rate-limit, timeout) before the run fails. Default 2 (so up to 3
   * total attempts), exponential backoff. 0 disables retry.
   */
  effectRetries?: number;
  /** Called when a node effect needs human approval. Return false to park the run. */
  approve?: (call: EffectCall) => boolean;
  /**
   * Seed the run state before the first step. Keys are available to the first
   * node's capability calls as input and to edge conditions immediately.
   * Useful for passing external inputs (e.g. a user's query) into the run.
   */
  initialState?: RunState;
}

export class Engine {
  private readonly declared: ReadonlySet<string>;
  private folder: IncrementalFolder;
  private readonly tracer: Tracer;
  /** transient-failure retry count for capability invokes; set per-run from RunOptions. */
  private effectRetries = 2;

  constructor(
    private readonly m: Manifest,
    private readonly tenantId: string,
    private readonly runId: string,
    private readonly deps: EngineDeps,
  ) {
    this.declared = declaredEdgeKeys(m);
    this.folder = new IncrementalFolder(deps.store, tenantId, runId);
    // Always construct a fresh Tracer bound to this runId so traceId === runId.
    this.tracer = deps.tracer ?? new NoopTracer();
  }

  private scope(nodeId?: string): EventScope {
    return { tenantId: this.tenantId, runId: this.runId, branchId: "main", ...(nodeId ? { nodeId } : {}) };
  }

  private async append<P>(ev: Omit<NewEvent<P>, "author">, signer: Signer): Promise<void> {
    const r = await this.deps.store.append(
      { ...ev, author: signer.descriptor.keyId } as NewEvent<P>,
      { ts: this.deps.now(), signer },
    );
    if (!r.ok) {
      throw new Error(`append failed: ${r.error.kind} ${r.error.message}`);
    }
  }

  private async fold(): Promise<RunProjection> {
    const span = this.tracer.startFold();
    try {
      const p = await this.folder.fold();
      span.end({});
      return p;
    } catch (err) {
      span.endError(err as Error);
      throw err;
    }
  }

  /**
   * Drive the run to a terminal state. Loops: fold → kernel decision → execute → repeat.
   * `maxSteps` is a safety-net bound (the manifest's maxNodeVisits is the real bound).
   *
   * Span lifecycle: runSpan is always closed in a finally block so it is emitted even
   * when an unexpected exception (e.g. store.append failure) exits the loop early.
   */
  async run(opts: RunOptions = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? 10_000;
    const approve = opts.approve ?? (() => true);

    const runSpan = this.tracer.startRun(this.m.name);

    // Initial state is merged into every fold for the entire run duration.
    // It acts as a base layer: log-derived state takes precedence (later keys win),
    // but seeded keys remain visible to all nodes and edge conditions for the
    // lifetime of the run. This is safe because initialState keys are scalars
    // and once a node produces an output under the same key ("nodeId.key" format),
    // the log-derived value will naturally shadow the seed.
    const initialState: RunState = opts.initialState ?? {};

    const deadlineMs = opts.deadlineMs;
    this.effectRetries = opts.effectRetries !== undefined && opts.effectRetries >= 0 ? opts.effectRetries : 2;

    let result: RunResult | undefined;
    try {
      for (let step = 0; step < maxSteps; step++) {
        // Deadline guard (checked at the step boundary so it never interrupts an
        // in-flight effect mid-write). A run that blows its wall-clock budget fails
        // cleanly with a signed event rather than waiting forever — this covers both
        // stuck plugins and runs parked on a never-resolved approval.
        if (deadlineMs !== undefined && this.deps.now() >= deadlineMs) {
          const reason = "run deadline exceeded";
          await this.append({ type: "RunFailed", scope: this.scope(), payload: { reason } }, this.deps.owner);
          const dlP = await this.fold();
          result = { status: "failed", reason, projection: dlP };
          runSpan.end({ status: "failed", reason }, "error");
          return result;
        }

        let p = await this.fold();

        // Merge initial state under the log-derived state so the log always wins.
        if (Object.keys(initialState).length > 0) {
          p = { ...p, state: { ...initialState, ...p.state } };
        }

        const d: Decision = decide(this.m, p, this.declared);

        switch (d.kind) {
          case "start":
            await this.append({ type: "RunStarted", scope: this.scope(), payload: { manifest: this.m.name } }, this.deps.owner);
            break;

          case "enter":
            await this.append({ type: "NodeEntered", scope: this.scope(d.nodeId), payload: {} }, this.deps.owner);
            break;

          case "runNode": {
            const nodeSpan = this.tracer.startNode(d.nodeId);
            let halted = false;
            try {
              halted = await this.runNodeBody(d.nodeId, p, approve);
            } finally {
              nodeSpan.end({ halted });
              this.tracer.endNode();
            }
            if (halted) {
              const p2 = await this.fold();
              result = { status: "halted", reason: "parked for approval", projection: p2 };
              runSpan.end({ status: "halted", spentCents: p2.budget.runSpentCents });
              return result;
            }
            break;
          }

          case "advance":
            await this.append({ type: "NodeEntered", scope: this.scope(d.toNodeId), payload: {} }, this.deps.owner);
            break;

          case "complete": {
            await this.append({ type: "RunCompleted", scope: this.scope(), payload: {} }, this.deps.owner);
            const finalP = await this.fold();
            result = { status: "completed", projection: finalP };
            runSpan.end({ status: "completed", spentCents: finalP.budget.runSpentCents });
            return result;
          }

          case "halt":
            result = { status: "halted", reason: d.reason, ...(d.holes ? { holes: d.holes } : {}), projection: p };
            runSpan.end({ status: "halted", reason: d.reason ?? "" });
            return result;

          case "fail": {
            await this.append({ type: "RunFailed", scope: this.scope(), payload: { reason: d.reason } }, this.deps.owner);
            const failP = await this.fold();
            result = { status: "failed", reason: d.reason, projection: failP };
            runSpan.end({ status: "failed", reason: d.reason ?? "" }, "error");
            return result;
          }

          case "conclude":
            await this.append({ type: "NodeConcluded", scope: this.scope(d.nodeId), payload: {} }, this.deps.owner);
            break;
        }
      }
      const lastP = await this.fold();
      result = { status: "failed", reason: "engine maxSteps exceeded", projection: lastP };
      runSpan.end({ status: "failed", reason: "maxSteps exceeded" }, "error");
      return result;
    } catch (err) {
      // Unexpected exception (e.g. store error). Close the run span before re-throwing
      // so the observability backend receives a completed (error) span record.
      runSpan.endError(err as Error, { status: "failed" });
      throw err;
    }
  }

  /**
   * Invoke a capability via the supervisor with bounded transient-failure retry.
   * Retries ONLY on a thrown error (no EffectResult written yet). `effectRetries`
   * extra attempts (default 2) with exponential backoff (base 200ms, capped 2s).
   * Backoff sleeps are skipped when a test clock is injected (deps.sleep), so the
   * pure/deterministic test path stays fast.
   */
  private async runEffectWithRetry(
    call: EffectCall,
    idem: string,
  ): Promise<Awaited<ReturnType<typeof this.deps.supervisor.run>>> {
    const maxAttempts = 1 + this.effectRetries;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.deps.supervisor.run(call, idem);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          const delay = Math.min(2000, 200 * 2 ** (attempt - 1));
          await (this.deps.sleep ? this.deps.sleep(delay) : new Promise(r => setTimeout(r, delay)));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Run a node's body: for each capability declared in the manifest node, issue one
   * EffectCall using the CURRENT run state as input (re-folded after each preceding
   * effect so later capabilities see outputs from earlier ones in the same node).
   * Perform the 3-event protocol (AdmissionDecision → EffectRequested → EffectResult).
   * Conclude the node with the outputs merged into run state under "nodeId.key" keys.
   * Returns true if the node parked waiting for approval.
   */
  private async runNodeBody(
    nodeId: string,
    p: RunProjection,
    approve: (call: EffectCall) => boolean,
  ): Promise<boolean> {
    const node = getNode(this.m, nodeId);
    if (!node) throw new Error(`manifest references unknown node '${nodeId}'`);

    // Inject the node's declared role into run state so the think/compose plugins
    // can read it as "<nodeId>.role" or "role". This is deterministic — derived
    // from the manifest which is already in the ledger — so no ledger event needed.
    if (node.role) {
      p = { ...p, state: { ...p.state, [`${nodeId}.role`]: node.role, role: node.role } };
    }

    // Collect this node's effect outputs (for run state at conclude time).
    const nodeOutputs: Record<string, unknown> = {};

    // Iterate over declared capabilities by index — do NOT pre-build EffectCall objects,
    // because p.state is re-folded after each effect and later calls must see the updated
    // state (fix: stale input for multi-capability nodes).
    const nodeVisits = p.nodes[nodeId]?.visits ?? 1;
    for (const cap of node.capabilities) {
      // Build the call fresh from the current (possibly updated) p.state.
      const call: EffectCall = { nodeId, capability: cap.name, input: p.state };
      // PER-VISIT keying is OPT-IN via cap.loop. Only a loop-flagged cap suffixes the idem key
      // (and capKey) with the visit count, so a back-edge retry genuinely re-runs it. A non-loop
      // cap keeps attempt=1 -> byte-identical legacy key (existing ledgers unchanged). Within a
      // single visit the key is stable (crash-safe); attempt comes solely from the folded visit
      // count, so replay stays deterministic.
      const attempt = cap.loop ? nodeVisits : 1;
      const idem = idempotencyKey(call, attempt);
      // capKey for the budget accumulator MUST match admit()'s key exactly (per-visit only when
      // the cap is loop-flagged and on a re-visit). Computed once and reused for every
      // AdmissionDecision event below so the fold's per-cap budget stays consistent.
      const capKey = cap.loop && attempt > 1 ? `${nodeId}:${cap.name}#${attempt}` : `${nodeId}:${cap.name}`;

      // RE-SERVE: already has a result → skip (no double-execution).
      if (p.resultsByIdem.has(idem)) continue;

      // ── Sub-agent path ─────────────────────────────────────────────────────
      if (cap.subAgent) {
        const binding = cap.subAgent;

        // SubRunId is deterministic — derived from parent run + node + capability name.
        const subRunId = deriveSubRunId(this.runId, nodeId, cap.name);

        // Admission: reserve budget for the sub-run
        const estimate = cap.budgetCents;
        const verdict = admit(node, call, estimate, this.m.runBudgetCents, p.budget, attempt);

        if (!verdict.admitted) {
          await this.append(
            { type: "AdmissionDecision", scope: this.scope(nodeId), payload: { idem, admitted: false, reason: verdict.reason, detail: verdict.detail } },
            this.deps.owner,
          );
          return false;
        }

        await this.append(
          { type: "AdmissionDecision", scope: this.scope(nodeId), payload: { idem, admitted: true, reservedCents: verdict.reservedCents, capKey } },
          this.deps.owner,
        );

        // Write SubRunRequested to parent ledger (idempotency anchor)
        await this.append(
          { type: "SubRunRequested", scope: this.scope(nodeId), payload: { idem, subRunId, capabilityName: cap.name } },
          this.deps.owner,
        );

        // Re-fold so the projection has _pendingSubRuns updated
        p = await this.fold();

        // Resolve the sub-manifest from the binding — it was pinned at compile time
        // For now we need the manifest passed in via deps. We store a manifest resolver on deps.
        const subManifest = await this.deps.resolveManifest?.(binding.manifestId);
        if (!subManifest) {
          await this.append(
            { type: "SubRunFailed", scope: this.scope(nodeId), payload: { idem, subRunId, reason: `sub-manifest '${binding.manifestId}' not found`, actualCostCents: 0 } },
            this.deps.owner,
          );
          if (binding.onSubFailure === "propagate") return false;
          mergeOutput(nodeOutputs, { error: `sub-manifest '${binding.manifestId}' not found` });
          p = await this.fold();
          continue;
        }

        // Execute sub-run — thread parent's approve callback so HITL policy propagates.
        const outcome = await executeSubRun(
          {
            parentRunId: this.runId,
            tenantId: this.tenantId,
            nodeId,
            capabilityName: cap.name,
            budgetCents: verdict.reservedCents,
            binding,
            subManifest,
            initialState: p.state as Record<string, string | number | boolean | null>,
            approve,
          },
          this.deps.store,
          this.deps,
          p as FoldAccumulator,
        );

        if (outcome.failed) {
          await this.append(
            { type: "SubRunFailed", scope: this.scope(nodeId), payload: { idem, subRunId: outcome.subRunId, reason: outcome.reason, actualCostCents: outcome.actualCostCents } },
            this.deps.owner,
          );
          if (binding.onSubFailure === "propagate") {
            // Engine main loop will see SubRunFailed + propagate → write RunFailed
            return false;
          }
          mergeOutput(nodeOutputs, { error: outcome.reason });
        } else {
          await this.append(
            { type: "SubRunCompleted", scope: this.scope(nodeId), payload: { idem, subRunId: outcome.subRunId, output: sanitizeOutput(outcome.output), actualCostCents: outcome.actualCostCents } },
            this.deps.owner,
          );
          mergeOutput(nodeOutputs, outcome.output);
        }

        p = await this.fold();
        if (p.failed || (p as FoldAccumulator)._admissionDenied) return false;
        continue;
      }

      // ── Normal plugin path ─────────────────────────────────────────────────
      const estimate = this.deps.supervisor.estimate(call);
      const verdict = admit(node, call, estimate, this.m.runBudgetCents, p.budget, attempt);

      if (!verdict.admitted) {
        await this.append(
          { type: "AdmissionDecision", scope: this.scope(nodeId), payload: { idem, admitted: false, reason: verdict.reason, detail: verdict.detail } },
          this.deps.owner,
        );
        // Do NOT append RunFailed here — let the kernel see AdmissionDecision(denied)
        // on the next fold and return {kind:"fail"}, which the engine handles in one
        // place. Appending RunFailed here caused a double-RunFailed: one from this
        // branch and one from the kernel's subsequent "fail" decision.
        return false;
      }

      // approval gate (autonomy gradient).
      // The ledger is the source of truth across a park→resume cycle: if the human already
      // RESOLVED this exact approval (same content-addressed idem), honor that decision —
      // proceed on "approve", fail on "deny" — instead of re-parking forever. Only when there
      // is NO prior resolution do we consult the live `approve` callback (which parks the run).
      if (verdict.requiresApproval) {
        const prior = p.resolvedApprovals.get(idem);
        if (prior === "deny") {
          await this.append(
            { type: "AdmissionDecision", scope: this.scope(nodeId), payload: { idem, admitted: false, reason: "approval denied" } },
            this.deps.owner,
          );
          throw new Error(`approval denied for ${call.capability}`);
        }
        if (prior !== "approve" && !approve(call)) {
          await this.append(
            { type: "AwaitRequested", scope: this.scope(nodeId), payload: { correlationId: idem, kind: "approval", call: { capability: call.capability } } },
            this.deps.owner,
          );
          return true; // parked
        }
      }

      // record admission (with reservation)
      await this.append(
        { type: "AdmissionDecision", scope: this.scope(nodeId), payload: { idem, admitted: true, reservedCents: verdict.reservedCents, capKey } },
        this.deps.owner,
      );

      // request (kernel-authored)
      await this.append(
        { type: "EffectRequested", scope: this.scope(nodeId), payload: { idem, capability: call.capability } },
        this.deps.owner,
      );

      // run via supervisor; the SUPERVISOR signs the result (plugins never self-sign).
      // Transient-failure retry: if the invoke THROWS (network blip, rate-limit, timeout),
      // retry with exponential backoff before giving up — so one flaky call doesn't sink
      // an unattended run. This is safe because a throw means NO EffectResult was written
      // yet (nothing to double-execute); a returned error-output is the plugin's own
      // result and is NOT retried here (the agent graph decides how to handle it).
      const effectSpan = this.tracer.startEffect(call.nodeId, call.capability, estimate);
      let observed: Awaited<ReturnType<typeof this.deps.supervisor.run>>;
      try {
        observed = await this.runEffectWithRetry(call, idem);
        effectSpan.end({ costCents: observed.costCents });
      } catch (err) {
        effectSpan.endError(err as Error);
        throw err;
      }
      await this.append(
        {
          type: "EffectResult",
          scope: this.scope(nodeId),
          payload: { idem, costCents: observed.costCents, output: sanitizeOutput(observed.output), pluginClaim: observed.pluginClaim },
          determinism: "captured",
        },
        this.deps.supervisorSigner,
      );

      // Accumulate this effect's output for the node's state contribution.
      // Scalar values (string | number | boolean) are hoisted; objects are merged.
      mergeOutput(nodeOutputs, observed.output);

      // Re-fold p so budget/results reflect this effect for the next capability in the loop.
      // This also makes the updated state available as input to subsequent capabilities.
      p = await this.fold();
      if (p.failed || (p as FoldAccumulator)._admissionDenied) return false;
    }

    // Conclude the node: write its outputs into run state as "nodeId.key" keys.
    const outState = nodeOutputState(nodeId, nodeOutputs);
    await this.append(
      { type: "NodeConcluded", scope: this.scope(nodeId), payload: outState ? { state: outState } : {} },
      this.deps.owner,
    );
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Namespace a node's raw effect outputs into run state keys.
 * Scalar values from top-level output object keys become "nodeId.key".
 * Example: node "a", output { score: 85, ok: true } → { "a.score": 85, "a.ok": true }
 * Non-scalar values (arrays, nested objects) are skipped — run state is flat scalars.
 * Returns null if there are no scalar outputs to contribute.
 */
function nodeOutputState(
  nodeId: string,
  outputs: Record<string, unknown>,
): Record<string, string | number | boolean | null> | null {
  const state: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(outputs)) {
    if (v === null || typeof v === "string" || typeof v === "boolean") {
      state[`${nodeId}.${k}`] = v;
    } else if (typeof v === "number") {
      // The tamper-evident ledger canonicalizer only accepts INTEGER numbers — a
      // non-integer (a price, a similarity score, any float) would fail the whole run
      // when NodeConcluded is written. Coerce to a string so NO capability can crash a
      // run by returning a decimal. Integers pass through unchanged.
      state[`${nodeId}.${k}`] = Number.isInteger(v) ? v : String(v);
    }
  }
  return Object.keys(state).length > 0 ? state : null;
}

/**
 * Merge an effect output value into the accumulated node outputs map.
 * If output is a plain object, its top-level entries are merged in.
 * If output is a scalar, it is stored under the key "result".
 */
function mergeOutput(acc: Record<string, unknown>, output: unknown): void {
  if (output === null || output === undefined) return;
  if (typeof output === "object" && !Array.isArray(output)) {
    for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
      acc[k] = v;
    }
  } else if (typeof output === "string" || typeof output === "number" || typeof output === "boolean") {
    acc["result"] = output;
  }
}
