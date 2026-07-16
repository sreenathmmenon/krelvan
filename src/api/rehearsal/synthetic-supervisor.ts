/**
 * The synthetic tool layer — the safety core of the Rehearsal Room.
 *
 * A rehearsal runs the REAL engine, kernel, budget, idempotency and approval gates against a
 * SYNTHETIC world: read-tools return plausible fake data, and every consequential tool
 * (message-human / spend / write-* / identity-mutation) is RECORDED but NOT PERFORMED. Nothing
 * touches Resend, Twilio, a Slack webhook, or any real endpoint.
 *
 * We do this by wrapping each CapabilityPlugin in the live snapshot with a synthetic stand-in
 * that keeps the SAME name, sideEffect and estimateCents — so admission, budget reservation,
 * side-effect classification and approval gating are byte-identical to production. Only
 * `invoke()` is replaced. The kernel cannot tell the difference; that is the whole point.
 *
 * This module performs ZERO real I/O of its own. The optional `synthesize` callback (LLM-backed)
 * only shapes the fake OUTPUT of read tools; if absent, a deterministic stub is returned.
 */
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { SideEffectClass } from "../../core/manifest/manifest.js";

/** Side-effect classes that must NEVER be performed in a rehearsal — recorded instead. */
const CONSEQUENTIAL: ReadonlySet<SideEffectClass> = new Set<SideEffectClass>([
  "write-reversible",
  "write-irreversible",
  "spend",
  "message-human",
  "identity-mutation",
]);

export function isConsequential(sideEffect: SideEffectClass): boolean {
  return CONSEQUENTIAL.has(sideEffect);
}

/** One consequential effect that WOULD have happened in production, captured instead of performed. */
export interface SuppressedEffect {
  nodeId: string;
  capability: string;
  sideEffect: SideEffectClass;
  /** the input the node handed the tool (the message it would have sent, the amount, etc.). */
  input: unknown;
}

/**
 * Shapes the fake output of a READ tool. Given the call, return a plausible synthetic result
 * object. Implementations may use an LLM; this module never calls the network itself. Returning
 * undefined falls back to the deterministic stub.
 */
export type ReadSynthesizer = (call: EffectCall, sideEffect: SideEffectClass) => Promise<unknown | undefined>;

export interface SyntheticLayer {
  /** the wrapped plugin map to hand a rehearsal Supervisor. */
  plugins: ReadonlyMap<string, CapabilityPlugin>;
  /** every consequential effect that was suppressed, in the order it was reached. */
  suppressed: SuppressedEffect[];
}

/**
 * A deterministic, network-free fake result for a read tool when no synthesizer is supplied (or it
 * declines). Deliberately bland and honest — it signals "synthetic" so a downstream judge/report
 * never mistakes it for real data.
 */
function stubReadOutput(call: EffectCall): Record<string, unknown> {
  return {
    _synthetic: true,
    capability: call.capability,
    note: `synthetic result for '${call.capability}' — no real call was made`,
  };
}

/**
 * Build the synthetic plugin layer from the live snapshot. The returned `suppressed` array is
 * mutated as consequential tools are reached during the run, so read it AFTER the run completes.
 *
 * @param live      the runtime's current plugin snapshot (supervisor.pluginNames source).
 * @param synthesize optional LLM-backed shaper for read-tool output. Never required.
 */
export function buildSyntheticLayer(
  live: ReadonlyMap<string, CapabilityPlugin>,
  synthesize?: ReadSynthesizer,
): SyntheticLayer {
  const suppressed: SuppressedEffect[] = [];
  const wrapped = new Map<string, CapabilityPlugin>();

  for (const [name, plugin] of live) {
    const sideEffect = plugin.sideEffect;

    const synthetic: CapabilityPlugin = {
      name: plugin.name,
      sideEffect: plugin.sideEffect,
      // Keep the real estimate so budget reservation and per-cap ceilings are identical to prod.
      estimateCents: (call: EffectCall) => plugin.estimateCents(call),
      async invoke(call: EffectCall) {
        if (isConsequential(sideEffect)) {
          // RECORD, don't perform. Claim zero cost — the rehearsal shows what WOULD have been
          // spent via the estimate/gate, but a rehearsal itself never settles real spend.
          suppressed.push({ nodeId: call.nodeId, capability: call.capability, sideEffect, input: call.input });
          return {
            output: {
              _synthetic: true,
              _suppressed: true,
              capability: call.capability,
              note: `'${call.capability}' would run in production — recorded, not performed`,
            },
            claimedCostCents: 0,
          };
        }
        // Read tool: return synthetic-but-plausible data. The synthesizer may not touch the
        // network; if it declines or throws, fall back to the deterministic stub.
        let output: unknown;
        if (synthesize) {
          try { output = await synthesize(call, sideEffect); } catch { output = undefined; }
        }
        if (output === undefined) output = stubReadOutput(call);
        return { output, claimedCostCents: 0 };
      },
    };

    wrapped.set(name, synthetic);
  }

  return { plugins: wrapped, suppressed };
}
