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

  estimateCents(_call: EffectCall): number {
    return 0; // cost is settled by the sub-run's effects; declared budgetCents is the ceiling
  }

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as { agentId?: unknown; intent?: unknown; message?: unknown; runBudgetCents?: unknown };

    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const intent = typeof input.intent === "string" ? input.intent.trim() : "";
    const message = typeof input.message === "string" ? input.message : undefined;
    const budgetOverride = typeof input.runBudgetCents === "number" ? input.runBudgetCents : undefined;

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

    const store = new InMemoryLedgerStore();
    const supervisor = new Supervisor(this.deps.plugins);
    const engine = new Engine(subManifest, `delegate:${call.nodeId}`, label, {
      store,
      owner: this.deps.ownerSigner,
      supervisor,
      supervisorSigner: this.deps.supervisorSigner,
      now: this.deps.now,
    });

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
    // gateAllConsequential forces the approval gate for every consequential effect even on
    // autonomy:"full" sub-nodes; combined with the class-aware `approve` denier, a delegated
    // sub-agent can never take an unsupervised irreversible/outbound/spend action.
    // Seed the synthetic user's opening message into the sub-run under `message` (the key the
    // public-ask / trigger paths already use) so a delegated agent-under-test receives real input.
    const initialState: RunState | undefined = message !== undefined ? { message } : undefined;
    const result = await engine.run({ approve, gateAllConsequential: true, ...(initialState ? { initialState } : {}) });

    const out: DelegateOutput = {
      status: result.status,
      state: result.projection.state,
      spentCents: result.projection.budget.runSpentCents,
    };

    return { output: out, claimedCostCents: out.spentCents };
  }
}
