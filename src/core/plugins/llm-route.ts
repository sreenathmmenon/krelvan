/**
 * "llm_route" capability — Level 2 adaptive routing.
 *
 * In Level 1 (current default), routing is purely declarative: the kernel evaluates
 * the manifest's edge `when` conditions against run state.
 *
 * In Level 2, a node can declare `llm_route` as one of its capabilities. At runtime
 * the engine calls this capability, which asks the LLM to choose the next node
 * based on the full run state. The LLM's chosen node name is written to run state
 * as "nodeId._next_node".
 *
 * The kernel then evaluates a conventional edge:
 *   { from: "thisNode", to: "targetNode", when: { op: "eq", key: "thisNode._next_node", value: "targetNode" } }
 *
 * This means Level 2 routing is transparent to the ledger — it is just another
 * CAPTURED EffectResult. The graph structure is still declared in the manifest
 * (preventing the LLM from jumping to nodes it cannot see). The LLM can only
 * choose among the declared outgoing edges — not invent new ones.
 *
 * Input:
 *   candidates  — comma-separated node IDs the LLM may choose from
 *   context     — optional extra context to include in the routing prompt
 *
 * Output:
 *   chosen_node — the node ID the LLM selected (must be one of candidates)
 *   reason      — the LLM's one-sentence rationale
 *
 * Cost estimate: 20 cents (lightweight routing decision).
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLLMClient, estimateCostCents } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("llm-route");

function defaultModel(): string {
  if (process.env["KRELVAN_ROUTE_MODEL"]) return process.env["KRELVAN_ROUTE_MODEL"];
  if (process.env["KRELVAN_LLM_MODEL"]) return process.env["KRELVAN_LLM_MODEL"];
  const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "ollama") return "llama3.2";
  return "claude-haiku-4-5-20251001";
}

export const llmRouteCapability: CapabilityPlugin = {
  name: "llm_route",
  sideEffect: "read",

  estimateCents: () => 20,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;

    const candidatesRaw = String(input["candidates"] ?? input[`${call.nodeId}.candidates`] ?? "");
    const candidates = candidatesRaw.split(",").map(s => s.trim()).filter(Boolean);

    if (candidates.length === 0) {
      throw new Error("llm_route: 'candidates' input must be a comma-separated list of node IDs");
    }

    if (candidates.length === 1) {
      return {
        output: { chosen_node: candidates[0], reason: "only one candidate" },
        claimedCostCents: 1,
      };
    }

    const extraContext = String(input["context"] ?? input[`${call.nodeId}.context`] ?? "");

    const stateLines = Object.entries(input)
      .filter(([k]) => !k.startsWith("_") && k !== "candidates" && k !== "context")
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");

    const system = [
      "You are a routing agent. Your job is to choose the BEST next step in a workflow",
      "based on the current state. You must choose exactly one of the given candidates.",
      "",
      "Respond with ONLY a JSON object:",
      "{ \"chosen_node\": \"<exact node id from candidates>\", \"reason\": \"<one sentence>\" }",
      "",
      "Output NOTHING else.",
    ].join("\n");

    const userMsg = [
      `Current node: ${call.nodeId}`,
      "",
      "Run state:",
      stateLines || "  (empty)",
      "",
      extraContext ? `Additional context: ${extraContext}\n` : "",
      `Choose ONE of these next nodes: ${candidates.join(", ")}`,
      "",
      "Return the JSON object.",
    ].filter(Boolean).join("\n");

    const model = defaultModel();
    const provider = (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as "anthropic" | "openai" | "ollama";

    log.info({ nodeId: call.nodeId, candidates, model, provider }, "llm_route: routing");

    const client = getLLMClient();
    const response = await client.complete({
      system,
      messages: [{ role: "user", content: userMsg }],
      model,
      maxTokens: 256,
      temperature: 0,
    });

    let parsed: { chosen_node?: string; reason?: string };
    try {
      let t = response.text;
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence?.[1]) t = fence[1].trim();
      if (!t.startsWith("{")) {
        const s = t.indexOf("{"), e = t.lastIndexOf("}");
        if (s >= 0 && e > s) t = t.slice(s, e + 1);
      }
      parsed = JSON.parse(t) as typeof parsed;
    } catch {
      parsed = {};
    }

    const chosen = parsed.chosen_node?.trim() ?? "";
    const finalChosen = candidates.includes(chosen) ? chosen : candidates[0]!;

    if (!candidates.includes(chosen)) {
      log.warn({ nodeId: call.nodeId, chosen, candidates }, "llm_route: LLM chose invalid node, falling back to first candidate");
    }

    const costCents = estimateCostCents(provider, model, response.inputTokens, response.outputTokens);

    log.info({ nodeId: call.nodeId, chosen: finalChosen, reason: parsed.reason }, "llm_route: decided");

    return {
      output: {
        chosen_node: finalChosen,
        reason: parsed.reason ?? "selected by LLM",
      },
      claimedCostCents: Math.max(costCents, 1),
    };
  },
};
