/**
 * "compose" capability — text composition via the configured LLM.
 *
 * Supports three styles: "brief" (default), "detailed", "bullet".
 * Provider is configured via GENESIS_LLM_PROVIDER (anthropic/openai/ollama).
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
  if (process.env["GENESIS_LLM_MODEL"]) return process.env["GENESIS_LLM_MODEL"];
  const provider = process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
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
    const provider = (process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic") as "anthropic" | "openai" | "ollama";

    log.info({ nodeId: call.nodeId, topic, style, model, provider }, "compose: calling LLM");

    const userParts: string[] = [];
    if (topic) userParts.push(`Topic: ${topic}`);
    if (prompt) userParts.push(`Additional instructions: ${prompt}`);
    if (userParts.length === 0) userParts.push("Write something helpful.");

    const client = getLLMClient();
    const response = await client.complete({
      system: [
        "You are a skilled writer. Compose text based on the given topic and instructions.",
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
