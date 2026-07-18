/**
 * DelegatePlugin — agent-to-agent delegation as a CapabilityPlugin.
 *
 * A node can delegate work to a sub-agent by declaring a capability with
 * sideEffect = "read" (the sub-run is read-only from the delegating node's
 * perspective) or the appropriate class. The plugin compiles the intent into
 * a manifest (using the caller's authority ceiling), runs it through a fresh
 * Engine instance, and returns the sub-run's final RunState as its output.
 *
 * Security model:
 *   - The sub-manifest is compiled under the SAME principal as the parent run
 *     (authority does not widen — monotonicity holds transitively).
 *   - The sub-run uses a fresh InMemoryLedgerStore so its events are isolated.
 *     The sub-run's full event log is returned in the output for the caller to
 *     optionally persist (the caller decides, not the plugin).
 *   - Budget: the delegate capability's budgetCents in the manifest limits the
 *     sub-run's total spend. The plugin enforces this via runBudgetCents on the
 *     sub-manifest.
 *
 * Input shape (EffectCall.input) — provide EITHER agentId OR intent:
 *   {
 *     agentId?: string;         // run an EXISTING saved agent by id (agent-tests-agent)
 *     intent?: string;          // OR compile a fresh sub-agent from this goal
 *     message?: string;         // opening input seeded into the sub-run (the synthetic user's msg)
 *     runBudgetCents?: number;  // overrides the sub-manifest's budget cap
 *   }
 *
 * When `agentId` is given, delegate loads that agent's SIGNED manifest and runs it directly — this
 * is what powers a TESTER agent: cast synthetic users, then delegate(agentId=<target>) each one
 * through the real agent under test. When only `intent` is given, delegate compiles a fresh
 * sub-agent (the original behaviour).
 *
 * Output shape:
 *   {
 *     status: "completed" | "halted" | "failed";
 *     state: RunState;          // the sub-run's final run state
 *     spentCents: number;
 *   }
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { Supervisor } from "../capability/capability.js";
import { Engine } from "../kernel/engine.js";
import { InMemoryLedgerStore } from "../ledger/store.js";
import { Compiler, type ModelPort, type Principal } from "../compiler/compiler.js";
import type { Signer } from "../ledger/crypto.js";
import type { RunState } from "../manifest/expr.js";
import type { Manifest } from "../manifest/manifest.js";

export interface DelegatePluginDeps {
  model: ModelPort;
  compilerSigner: Signer;
  ownerSigner: Signer;
  supervisorSigner: Signer;
  /** The principal whose authority ceiling applies to sub-manifests. */
  principal: Principal;
  /** Plugins available to the sub-agent. Same snapshot as the parent run. */
  plugins: ReadonlyMap<string, CapabilityPlugin>;
  /** Logical clock shared with the parent run for consistent ordering. */
  now: () => number;
  /**
   * Resolve a saved agent id to its signed manifest, for delegate-by-agentId (agent-tests-agent).
   * Optional: when absent, only intent-based delegation works. Returns null for an unknown id.
   */
  agentLookup?: (agentId: string) => Manifest | null;
}

export interface DelegateOutput {
  status: "completed" | "halted" | "failed";
  state: RunState;
  spentCents: number;
}

export class DelegatePlugin implements CapabilityPlugin {
  readonly name = "delegate";
  readonly sideEffect = "read" as const;

  constructor(private readonly deps: DelegatePluginDeps) {}

  estimateCents(call: EffectCall): number {
    // A non-zero pre-flight estimate so admission can RESERVE against the node/run ceiling before a
    // batch runs — estimate 0 disabled gating entirely, letting N heavy sub-runs settle far past the
    // node cap. Estimate ~a modest per-user cost times the number of synthetic users in the batch.
    const input = (call.input ?? {}) as Record<string, unknown>;
    let n = 1;
    const uj = input["users_json"] ?? Object.entries(input).find(([k]) => k.endsWith(".users_json"))?.[1];
    if (typeof uj === "string" && uj.trim().startsWith("[")) {
      try { const arr = JSON.parse(uj); if (Array.isArray(arr)) n = Math.max(1, arr.length); } catch { /* keep 1 */ }
    }
    return 50 * n;
  }

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;

    // Find a value in the input by an exact key OR any namespaced "<node>.<key>" (the engine passes
    // the WHOLE run state as input, so a prior node's `users` output arrives as e.g. "cast.users").
    const pick = (key: string): unknown => {
      if (input[key] !== undefined) return input[key];
      const hit = Object.entries(input).find(([k, v]) => (k === key || k.endsWith(`.${key}`)) && v !== undefined && v !== "");
      return hit?.[1];
    };

    const agentIdVal = pick("agentId");
    const agentId = typeof agentIdVal === "string" ? agentIdVal.trim() : "";
    const intent = typeof input["intent"] === "string" ? (input["intent"] as string).trim() : "";
    const budgetOverride = typeof input["runBudgetCents"] === "number" ? input["runBudgetCents"] as number : undefined;

    // Collect the message(s) to run through the target. A TESTER agent casts a `users` array (each
    // with a message) — delegate must run the target ONCE PER USER (run-state can't fan out, so the
    // loop lives here). Run-state only keeps SCALARS, so the array arrives as a JSON STRING under
    // `users_json` (the synthetic_users capability emits it precisely so this survives). We also
    // accept a live `users`/`messages` array (same-node / test paths), then a single `message`.
    let usersArr: unknown = pick("users");
    if (!Array.isArray(usersArr)) {
      const uj = pick("users_json");
      if (typeof uj === "string" && uj.trim().startsWith("[")) {
        try { usersArr = JSON.parse(uj); } catch { /* leave as-is */ }
      }
    }
    const messagesVal = pick("messages");
    const messageVal = pick("message");
    const batch: { message: string; name?: string }[] = [];
    if (Array.isArray(usersArr)) {
      for (const u of usersArr) {
        if (u && typeof u === "object") {
          const m = (u as Record<string, unknown>)["message"];
          if (typeof m === "string") batch.push({ message: m, name: typeof (u as Record<string, unknown>)["name"] === "string" ? (u as Record<string, unknown>)["name"] as string : undefined });
        }
      }
    } else if (Array.isArray(messagesVal)) {
      for (const m of messagesVal) if (typeof m === "string") batch.push({ message: m });
    } else if (typeof messageVal === "string") {
      batch.push({ message: messageVal });
    }
    const isBatch = Array.isArray(usersArr) || Array.isArray(messagesVal);

    if (!agentId && !intent) {
      throw new Error("delegate: provide either input.agentId (run a saved agent) or input.intent (compile a fresh sub-agent)");
    }

    // Apply budget override BEFORE compile so the principal ceiling narrows the
    // model's budget proposal — never mutate the signed manifest after signing.
    const principal =
      budgetOverride !== undefined
        ? { ...this.deps.principal, maxRunBudgetCents: Math.min(this.deps.principal.maxRunBudgetCents, budgetOverride) }
        : this.deps.principal;

    let subManifest: Manifest;
    let label: string;
    if (agentId) {
      // Run an EXISTING saved agent by id (agent-tests-agent). The manifest is already signed and
      // compiled under the owner's authority; we run it as-is under the same principal ceiling.
      const found = this.deps.agentLookup?.(agentId) ?? null;
      if (!found) throw new Error(`delegate: no saved agent found for agentId "${agentId}"`);
      subManifest = found;
      label = `agent:${agentId.slice(0, 16)}`;
    } else {
      const compiler = new Compiler(this.deps.model, this.deps.compilerSigner);
      const compiled = await compiler.compile(intent, principal, this.deps.now());
      if (!compiled.ok) {
        const issues = compiled.issues.map((i) => `${i.code}: ${i.message}`).join("; ");
        throw new Error(`delegate: sub-manifest compile failed at stage '${compiled.stage}': ${issues}`);
      }
      subManifest = compiled.signed.manifest;
      label = `sub:${intent.slice(0, 32)}`;
    }

    // A delegated sub-run must NOT silently auto-approve consequential actions. Delegation is for
    // bounded research/drafting; approve only non-consequential effects (read / reversible writes)
    // and DENY anything irreversible, outbound-to-a-human, spend, or identity-mutating — the sub-run
    // halts at that gate rather than taking an unsupervised consequential action on the user's behalf.
    const CONSEQUENTIAL = new Set(["write-irreversible", "spend", "identity-mutation", "message-human"]);
    const approve = (subCall: EffectCall): boolean => {
      const plugin = this.deps.plugins.get(subCall.capability);
      const effect = plugin?.sideEffect;
      return !effect || !CONSEQUENTIAL.has(effect);
    };

    // Run the target ONCE with a given opening message. Fresh isolated ledger per sub-run.
    // gateAllConsequential forces the approval gate for every consequential effect even on
    // autonomy:"full" sub-nodes; combined with the class-aware `approve` denier, a delegated
    // sub-agent can never take an unsupervised irreversible/outbound/spend action.
    // Per-sub-run budget cap: split the delegate node's budget across the batch so N sub-runs can't
    // blow past the node ceiling (each sub-run gets at most its share). Never below a small floor.
    const perSubBudget = isBatch && batch.length > 0
      ? Math.max(200, Math.floor((budgetOverride ?? this.deps.principal.maxRunBudgetCents) / batch.length))
      : (budgetOverride ?? undefined);

    const runOnce = async (msg: string | undefined): Promise<DelegateOutput> => {
      const store = new InMemoryLedgerStore();
      const supervisor = new Supervisor(this.deps.plugins);
      // Cap each sub-run's budget and give it a wall-clock deadline so one slow/stuck target
      // capability can't stall the whole batch past the run's advertised deadline.
      const subM = perSubBudget !== undefined
        ? { ...subManifest, runBudgetCents: Math.min(subManifest.runBudgetCents, perSubBudget) }
        : subManifest;
      const engine = new Engine(subM, `delegate:${call.nodeId}`, label, {
        store, owner: this.deps.ownerSigner, supervisor,
        supervisorSigner: this.deps.supervisorSigner, now: this.deps.now,
      });
      const initialState: RunState | undefined = msg !== undefined ? { message: msg } : undefined;
      const deadlineMs = this.deps.now() + 120_000; // 2 min per sub-run — a stuck target can't hang the batch
      try {
        const result = await engine.run({ approve, gateAllConsequential: true, deadlineMs, ...(initialState ? { initialState } : {}) });
        return { status: result.status, state: result.projection.state, spentCents: result.projection.budget.runSpentCents };
      } catch (err) {
        // A sub-run that THROWS (LLM rate-limit/timeout/5xx) must NOT abort the batch or make the
        // parent retry the whole delegate node. Convert it into a failed result the judge/report
        // can surface — the crashing user is reported as a FAIL and the run reaches judge/report.
        return { status: "failed", state: { "delegate.error": (err as Error)?.message ?? "sub-run failed" }, spentCents: 0 };
      }
    };

    // BATCH (tester): run the target once per synthetic user. The downstream judge/report need to
    // see every case, but run-state keeps only SCALARS — so alongside the (dropped) `results` array
    // we emit a scalar `results_summary` (a readable per-user recap the judge/report can reason over)
    // and `results_json` (the full data as a string). SINGLE: back-compat, return one DelegateOutput.
    if (isBatch) {
      const results: Array<DelegateOutput & { name?: string; message: string }> = [];
      for (const item of batch) {
        const r = await runOnce(item.message);
        results.push({ ...r, name: item.name, message: item.message });
      }
      const totalCents = results.reduce((s, r) => s + r.spentCents, 0);
      // A compact per-user recap: name, the message they sent, the target's status, and its final
      // reply/result if any. This is what the judge reads to decide pass/fail per user. We spell out
      // what a status MEANS so the judge/report can be precise instead of lumping every non-success
      // into a bare "fail" — a run that HALTED for human approval is a different outcome than one
      // that produced a wrong answer, and the customer's report should say so.
      const recap = (r: DelegateOutput & { name?: string; message: string }, i: number): string => {
        const finalKeys = Object.entries(r.state)
          .filter(([k, v]) => (k.endsWith(".result") || k.endsWith(".reply") || k.endsWith(".answer") || k.endsWith(".body")) && typeof v === "string" && (v as string).trim())
          .map(([, v]) => String(v).trim());
        const reply = finalKeys[finalKeys.length - 1];
        const outcome =
          r.status === "completed" ? (reply ? `completed — replied: ${reply.slice(0, 400)}` : "completed but produced NO reply")
          : r.status === "halted" ? `HALTED — paused for human approval or a blocked action before replying${reply ? ` (partial: ${reply.slice(0, 200)})` : ""}`
          : `FAILED to run${reply ? ` (partial: ${reply.slice(0, 200)})` : ""}`;
        return `User ${i + 1} — ${r.name ?? "user"} sent: "${r.message.slice(0, 160)}"\n  outcome: ${outcome}`;
      };
      const resultsSummary = results.map(recap).join("\n\n");
      return {
        output: {
          count: results.length,
          totalCents,
          results_summary: resultsSummary,
          results_json: JSON.stringify(results.map((r) => ({ name: r.name, message: r.message, status: r.status }))),
          result: resultsSummary,
          text: resultsSummary,
        },
        claimedCostCents: totalCents,
      };
    }

    const out = await runOnce(batch[0]?.message);
    return { output: out, claimedCostCents: out.spentCents };
  }
}
