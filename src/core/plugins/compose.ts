/**
 * "compose" capability — text composition via the configured LLM.
 *
 * Supports three styles: "brief" (default), "detailed", "bullet".
 * Provider is configured via KRELVAN_LLM_PROVIDER (anthropic/openai/ollama).
 *
 * Input keys:
 *   topic   — the subject to write about (required)
 *   prompt  — optional extra instructions / context
 *   style   — "brief" | "detailed" | "bullet" (default: "brief")
 *
 * Output:
 *   { text, words, model }
 *
 * Cost estimate: 15 cents per call.
 * Side effect: "read" — no external writes.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLLMClient, estimateCostCents } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("compose");

type CompositionStyle = "brief" | "detailed" | "bullet";

function styleInstruction(style: CompositionStyle): string {
  switch (style) {
    case "brief":
      return "Write a clear, concise response of 2–4 short paragraphs. Be direct and to the point.";
    case "detailed":
      return "Write a thorough, well-structured response with multiple sections. Include relevant details and context.";
    case "bullet":
      return "Respond using a clear bullet-point list. Each bullet should be a complete, useful point. No lengthy prose.";
  }
}

function defaultModel(): string {
  if (process.env["KRELVAN_LLM_MODEL"]) return process.env["KRELVAN_LLM_MODEL"];
  const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "ollama") return "llama3.2";
  return "claude-haiku-4-5-20251001";
}

export const composeCapability: CapabilityPlugin = {
  name: "compose",
  sideEffect: "read",

  estimateCents: () => 15,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const topic = String(input["topic"] ?? "");
    const prompt = String(input["prompt"] ?? "");

    const rawStyle = String(input["style"] ?? "brief");
    const style: CompositionStyle =
      rawStyle === "detailed" ? "detailed"
      : rawStyle === "bullet" ? "bullet"
      : "brief";

    const model = defaultModel();
    const provider = (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as "anthropic" | "openai" | "ollama";

    // Build a context section from prior node outputs — same approach as think.
    // Priority: .result and .body values first (domain content), then other scalars.
    // This is what prevents compose from writing generic articles when real data exists.
    const MAX_CHARS = 3000;
    const contextParts: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith("_")) continue;
      if (k === "topic" || k === "prompt" || k === "style") continue;
      if (k.endsWith(".role") || k.endsWith(".ok") || k.endsWith(".status") ||
          k.endsWith(".contentType") || k.endsWith(".truncated") || k.endsWith(".headers") ||
          k.endsWith(".next") || k.endsWith(".thought")) continue;
      const val = typeof v === "string" ? v : JSON.stringify(v);
      if (val.length < 10) continue;
      const truncated = val.length > MAX_CHARS ? val.slice(0, MAX_CHARS) + "…" : val;
      // Prioritise .result and .body (most informative)
      if (k.endsWith(".result") || k.endsWith(".body") || k.endsWith(".snippet")) {
        contextParts.unshift(`[${k}]\n${truncated}`);
      } else {
        contextParts.push(`[${k}]: ${truncated}`);
      }
    }

    log.info({ nodeId: call.nodeId, topic, style, model, provider, contextKeys: contextParts.length }, "compose: calling LLM");

    const userParts: string[] = [];
    if (contextParts.length > 0) {
      userParts.push("=== CONTEXT FROM PRIOR STEPS ===");
      userParts.push(contextParts.slice(0, 8).join("\n\n"));
      userParts.push("=== YOUR TASK ===");
    }
    if (topic) userParts.push(`Topic: ${topic}`);
    if (prompt) userParts.push(`Additional instructions: ${prompt}`);
    if (userParts.length === 0) userParts.push("Write something helpful.");

    const client = getLLMClient();
    const response = await client.complete({
      system: [
        "You are a skilled writer. Compose text based on the provided context and topic.",
        "IMPORTANT: Base your writing on the CONTEXT provided above — do not invent facts.",
        "If context is available, summarise and synthesise it rather than writing from scratch.",
        styleInstruction(style),
        "Output only the composed text — no preamble, no meta-commentary, no JSON wrapper.",
      ].join("\n"),
      messages: [{ role: "user", content: userParts.join("\n\n") }],
      model,
      maxTokens: style === "detailed" ? 2048 : 1024,
      temperature: 0.4,
    });

    const words = response.text.split(/\s+/).filter(Boolean).length;
    const costCents = estimateCostCents(provider, model, response.inputTokens, response.outputTokens);

    log.info({ nodeId: call.nodeId, words, costCents }, "compose: done");

    return {
      output: { text: response.text, words, model },
      claimedCostCents: Math.max(costCents, 1),
    };
  },
};
