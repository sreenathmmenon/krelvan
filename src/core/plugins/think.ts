/**
 * "think" capability — real LLM reasoning inside a node.
 *
 * This is what makes a node an *agent* rather than an API call.
 * The node sends its current run state + a system prompt to the configured LLM
 * and writes the response back into run state as:
 *   nodeId.thought   — the model's reasoning (string)
 *   nodeId.result    — the final answer/decision (string)
 *   nodeId.next      — optional: name of the next node to route to (Level 2)
 *
 * Provider is configured via GENESIS_LLM_PROVIDER (anthropic/openai/ollama).
 * Model is GENESIS_THINK_MODEL or GENESIS_LLM_MODEL, with provider-appropriate defaults.
 *
 * Side effect class: "read" — the LLM only reads and reasons, no external writes.
 * The result is captured in the ledger as a CAPTURED EffectResult (non-deterministic
 * but recorded) so replay never re-calls the model.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLLMClient, estimateCostCents } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("think");

function defaultModel(): string {
  if (process.env["GENESIS_THINK_MODEL"]) return process.env["GENESIS_THINK_MODEL"];
  if (process.env["GENESIS_LLM_MODEL"]) return process.env["GENESIS_LLM_MODEL"];
  const provider = process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
  if (provider === "openai") return "gpt-4o";
  if (provider === "ollama") return "llama3.2";
  return "claude-sonnet-4-6";
}

export const thinkCapability: CapabilityPlugin = {
  name: "think",
  sideEffect: "read",

  estimateCents: () => 50,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;

    const role = String(input["role"] ?? input[`${call.nodeId}.role`] ?? "You are a helpful assistant.");
    const focus = String(input["focus"] ?? input[`${call.nodeId}.focus`] ?? "");

    // Extract output key names that the role explicitly asks the model to set.
    // Pattern: "Set <key> to" or "set <key> to" anywhere in the role text.
    // These become the mandatory outputs checklist shown to the model.
    const outputKeyMatches = [...role.matchAll(/\bset (\w+) to\b/gi)];
    const requiredOutputKeys = [...new Set(outputKeyMatches.map(m => m[1]))];

    // Build focused data payload for the model.
    // Priority order:
    //   1. *.body values from prior http_get nodes (the actual domain data)
    //   2. Other scalar state values excluding HTTP metadata noise
    // Each value is truncated to 2000 chars to stay within Ollama's context budget.
    const MAX_VALUE_CHARS = 2000;

    const bodyEntries: string[] = [];
    const otherEntries: string[] = [];

    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith("_")) continue;
      // Skip internal/metadata keys that add noise but no domain signal
      const isNoise = k.endsWith(".ok") || k.endsWith(".status") || k.endsWith(".contentType") ||
        k.endsWith(".truncated") || k.endsWith(".headers") || k.endsWith(".role") ||
        k.includes(".recall.") || k.includes(".remembered") || k.includes(".episodeCount") ||
        k.includes(".factsUpdated") || k === "role" || k === "focus";
      if (isNoise) continue;

      const serialised = typeof v === "string" ? v : JSON.stringify(v);
      const truncated = serialised.length > MAX_VALUE_CHARS
        ? serialised.slice(0, MAX_VALUE_CHARS) + `… [truncated, ${serialised.length} chars total]`
        : serialised;

      if (k.endsWith(".body")) {
        bodyEntries.push(`[${k}]\n${truncated}`);
      } else {
        otherEntries.push(`  ${k}: ${truncated}`);
      }
    }

    const dataSection = [
      ...(bodyEntries.length > 0 ? ["=== DATA TO ANALYZE ===", ...bodyEntries] : []),
      ...(otherEntries.length > 0 ? ["=== OTHER STATE ===", ...otherEntries] : []),
    ].join("\n");

    // Build the outputs checklist so the model knows exactly which keys to produce.
    const outputsInstruction = requiredOutputKeys.length > 0
      ? [
          "",
          "REQUIRED: Your 'outputs' object MUST include ALL of these keys:",
          requiredOutputKeys.map(k => `  - "${k}": <value>`).join("\n"),
          "Missing any of these keys is an error.",
        ].join("\n")
      : [
          "",
          "Set any relevant decision keys in 'outputs' (e.g. risk_level, anomaly_detected).",
        ].join("\n");

    const system = [
      "TASK:",
      role,
      outputsInstruction,
      "",
      "OUTPUT FORMAT — respond with ONLY this JSON object, no prose, no code fences:",
      "{",
      '  "thought": "<step-by-step reasoning referencing the actual data>",',
      '  "result": "<final decision or summary as plain string>",',
      '  "next": null,',
      '  "outputs": {',
      requiredOutputKeys.length > 0
        ? requiredOutputKeys.map(k => `    "${k}": <value>`).join(",\n")
        : '    "<key>": <value>',
      "  }",
      "}",
    ].join("\n");

    const userMsg = [
      dataSection || "  (no data available)",
      "",
      focus ? `FOCUS: ${focus}` : "",
      "",
      "Analyze the data above. Follow your TASK instructions exactly. Return the JSON.",
    ].filter(Boolean).join("\n");

    const model = defaultModel();
    const provider = (process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic") as "anthropic" | "openai" | "ollama";

    log.info({ nodeId: call.nodeId, model, provider }, "think: calling LLM");

    const client = getLLMClient();
    const response = await client.complete({
      system,
      messages: [{ role: "user", content: userMsg }],
      model,
      maxTokens: 2048,
      temperature: 0,
    });

    let parsed: { thought?: string; result?: string; next?: string | null; outputs?: Record<string, unknown> };
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
      parsed = { thought: "(unparsed response)", result: response.text, next: null };
    }

    const costCents = estimateCostCents(provider, model, response.inputTokens, response.outputTokens);

    log.info({ nodeId: call.nodeId, inputTok: response.inputTokens, outputTok: response.outputTokens, costCents }, "think: done");

    // Spread domain-specific output keys from parsed.outputs into the top-level output.
    // Only scalar values (string, number, boolean, null) are allowed — objects/arrays
    // are silently dropped here (the kernel projector enforces the same constraint).
    const domainOutputs: Record<string, string | number | boolean | null> = {};
    if (parsed.outputs && typeof parsed.outputs === "object") {
      for (const [k, v] of Object.entries(parsed.outputs)) {
        if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          domainOutputs[k] = v;
        }
      }
    }

    return {
      output: {
        thought: parsed.thought ?? "",
        result: parsed.result ?? "",
        next: parsed.next ?? null,
        ...domainOutputs,
      },
      claimedCostCents: Math.max(costCents, 1),
    };
  },
};
