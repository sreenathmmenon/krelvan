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
import { getLLMClient, estimateCostCents, currentProvider, resolveModel } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("compose");

/**
 * Turn a raw model response into clean, customer-facing prose. Models sometimes:
 *   • wrap the whole answer in a JSON object ({ "text": "…" }),
 *   • fence it in ``` … ```,
 *   • echo the output_map field names as line labels ("title: …\nbody: …"), once at the top or
 *     — in a multi-item digest — for EVERY item.
 * A customer must see none of that. Exported so the exact behaviour is unit-tested.
 */
export function cleanComposedText(raw: string): string {
  let text = (raw ?? "").trim();
  // Unwrap a JSON-object answer → its text/result/output field (or first string value).
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const pick = obj["text"] ?? obj["result"] ?? obj["output"] ?? obj["translation"] ??
        Object.values(obj).find((v) => typeof v === "string");
      if (typeof pick === "string" && pick.trim()) text = pick.trim();
    } catch { /* not JSON after all — keep as-is */ }
  }
  // Unwrap a whole-answer ``` code fence.
  const fenced = text.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1]!.trim();
  // Strip field-name labels wherever they open a line (every occurrence, not just the first), so a
  // digest / brief / message reads as prose. These are output_map / manifest field names that some
  // models echo as "label: value" — the reader should never see them. Only a bare known label at
  // line-start is stripped; a real sentence with a colon mid-line ("The result was clear: …") is
  // untouched because it doesn't start with one of these exact words.
  // Match a leading label followed by ":" OR "=" — models emit both ("title: X" and "title=X").
  const LABELS = ["title", "body", "brief", "summary", "message", "note", "subject", "headline", "content"];
  const labelRe = new RegExp(`^[ \\t]*(?:${LABELS.join("|")})\\s*[:=][ \\t]*`, "gim");
  text = text
    .replace(labelRe, "")
    // Krelvan renders composed output as customer-facing prose, not as a TeX document.
    // Models occasionally wrap a simple equation in inline/display TeX despite being asked for
    // plain text. Remove only the unambiguous delimiters and translate common arithmetic
    // operators; leave every operand and the rest of the prose untouched.
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\\times\b/g, "×")
    .replace(/\\div\b/g, "÷")
    .replace(/\\cdot\b/g, "·")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** Assemble a report from exact prior outputs without asking a model to rewrite them.
 * Mapping format: "Section title=state.key,Another section=other.key". This is useful for final
 * dossiers where model recomposition would be slower, lossy, and capable of changing facts. */
export function assembleComposedReport(
  title: string,
  sectionMap: string,
  input: Record<string, unknown>,
): string {
  const sections: string[] = [];
  for (const rawPair of sectionMap.split(",")) {
    const eq = rawPair.indexOf("=");
    if (eq <= 0) continue;
    const label = rawPair.slice(0, eq).trim();
    const key = rawPair.slice(eq + 1).trim();
    if (!label || !key) continue;
    const value = input[key];
    const body = typeof value === "string" ? value.trim() : "";
    sections.push(`## ${label}\n\n${body || "Not available in this run."}`);
  }
  if (sections.length === 0) return "";
  return [`# ${title.trim() || "Report"}`, ...sections].join("\n\n");
}

type CompositionStyle = "brief" | "detailed" | "bullet";

/** Reasoning-model output budgets include hidden reasoning tokens. A substantial article can
 * exhaust a nominal 2K ceiling before enough visible prose is emitted, so hosted reasoning
 * models get explicit headroom while local models retain conservative memory use. */
export function resolveComposeMaxTokens(
  provider: string,
  style: CompositionStyle,
  configured?: string,
): number {
  const fallback = provider === "openai"
    ? (style === "detailed" ? 8192 : 4096)
    : provider === "ollama"
      ? (style === "detailed" ? 2048 : 1024)
      : (style === "detailed" ? 4096 : 2048);
  if (!configured?.trim()) return fallback;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(512, Math.min(32768, Math.floor(parsed)));
}

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
  // resolveModel guards against a stale KRELVAN_LLM_MODEL that belongs to another provider
  // (e.g. an Ollama tag left in .env while the provider is Gemini) — see llm-client.resolveModel.
  return resolveModel(currentProvider(), "cheap");
}

/**
 * Build the grounded context handed to the composing model.
 *
 * Short scalar values are often the entire answer: `392`, `true`, `low`, or `US`. Dropping
 * values shorter than ten characters caused a correct upstream calculation to disappear before
 * the final composing step. Keep every non-empty scalar while still excluding engine metadata
 * and the current node's role (which is sent separately as the task).
 */
export function buildCompositionContext(
  input: Record<string, unknown>,
  currentNodeId?: string,
  maxChars = 12000,
): string[] {
  const MAX_CHARS = Math.max(1000, Math.min(32768, Math.floor(maxChars)));
  const deliveryEvidence: string[] = [];
  const decisionEvidence: string[] = [];
  const priority: string[] = [];
  const rest: string[] = [];

  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("_")) continue;
    if (k === "topic" || k === "prompt" || k === "style" || k === "role") continue;
    // The PRIOR node's role often contains the original operands, URL, source, or constraints.
    // Keep it as grounding. Only the current role is redundant because it is sent separately as
    // "Your instruction for this step".
    if ((currentNodeId && k === `${currentNodeId}.role`) ||
        k.endsWith(".ok") ||
        k.endsWith(".contentType") || k.endsWith(".truncated") || k.endsWith(".headers") ||
        k.endsWith(".next") || k.endsWith(".thought")) continue;

    let val: string;
    if (typeof v === "string") val = v.trim();
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") val = String(v);
    else {
      try { val = JSON.stringify(v) ?? ""; }
      catch { continue; }
    }
    if (!val) continue;

    const truncated = val.length > MAX_CHARS ? val.slice(0, MAX_CHARS) + "…" : val;
    const item = k.endsWith(".result") || k.endsWith(".body") || k.endsWith(".snippet")
      ? `[${k}]\n${truncated}`
      : `[${k}]: ${truncated}`;
    // Delivery claims are high-risk: a final report must see mechanically observed connector
    // results before long model-generated prose. Keep these facts at the front of the context so
    // the model can distinguish "prepared" from "actually sent/posted" even in a large run.
    if (k.endsWith(".notified") || k.endsWith(".sent") || k.endsWith(".delivered") ||
        k.endsWith(".status") || k.endsWith(".messageId") || k.endsWith(".destination") ||
        k.endsWith(".via") || k.endsWith(".error")) {
      deliveryEvidence.push(item);
    } else if (k.includes(".qa_") || k.endsWith(".score") || k.endsWith(".verdict") ||
        k.endsWith(".confidence") || k.endsWith(".chosen_node") || k.endsWith(".route")) {
      // Compact decision/quality scalars are often load-bearing for the final report. Keep them
      // ahead of long prose so an eight-item context window cannot turn a real score into
      // "not provided" or hide the route that actually ran.
      decisionEvidence.push(item);
    } else if (k.endsWith(".result") || k.endsWith(".body") || k.endsWith(".snippet")) priority.push(item);
    else rest.push(item);
  }

  return [...deliveryEvidence, ...decisionEvidence, ...priority, ...rest];
}

/** Pack context under a provider-appropriate total size instead of blindly taking eight values.
 * Hosted models can safely receive the complete evidence needed by complex finalizers; local
 * models keep a conservative ceiling. Ordering comes from buildCompositionContext, so delivery
 * and decision facts are retained first. */
export function selectCompositionContext(parts: string[], provider: string): string[] {
  const maxItems = provider === "ollama" ? 8 : 24;
  const maxChars = provider === "ollama" ? 24_000 : 96_000;
  const selected: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (selected.length >= maxItems || used >= maxChars) break;
    const remaining = maxChars - used;
    if (part.length <= remaining) {
      selected.push(part);
      used += part.length;
    } else if (remaining >= 1000) {
      selected.push(`${part.slice(0, remaining)}… [context truncated]`);
      used = maxChars;
    }
  }
  return selected;
}

export const composeCapability: CapabilityPlugin = {
  name: "compose",
  sideEffect: "read",

  estimateCents: () => 15,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const topic = String(input["topic"] ?? "");
    const prompt = String(input["prompt"] ?? "");
    // The node's own role IS the user's instruction for this step — it carries the format/length
    // constraints the customer asked for ("write a short 2-sentence summary", "as a numbered
    // list"). The engine injects it into state as `<nodeId>.role`/`role`. Use it as the task so
    // compose actually respects "2 sentences" instead of writing a generic multi-paragraph block.
    const role = String(input[`${call.nodeId}.role`] ?? input["role"] ?? "").trim();

    const sectionMap = String(input[`${call.nodeId}.section_map`] ?? "").trim();
    if (sectionMap) {
      const report = assembleComposedReport(
        String(input[`${call.nodeId}.title`] ?? "Report"),
        sectionMap,
        input,
      );
      if (!report) throw new Error(`compose: ${call.nodeId}.section_map contains no valid sections`);
      const words = report.split(/\s+/).filter(Boolean).length;
      const firstLine = report.split("\n")[0]!.replace(/^#\s*/, "").trim();
      return {
        output: { result: report, text: report, body: report, title: firstLine, words, model: "deterministic-assembly" },
        claimedCostCents: 0,
      };
    }

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
    const contextParts = buildCompositionContext(
      input,
      call.nodeId,
      currentProvider() === "ollama" ? 3000 : 12000,
    );

    log.info({ nodeId: call.nodeId, topic, style, model, provider, contextKeys: contextParts.length }, "compose: calling LLM");

    const userParts: string[] = [];
    if (contextParts.length > 0) {
      userParts.push("=== CONTEXT FROM PRIOR STEPS ===");
      userParts.push(selectCompositionContext(contextParts, provider).join("\n\n"));
      userParts.push("=== YOUR TASK ===");
    }
    // The step's instruction (its role) is the customer's actual ask, including any length/format
    // constraint — put it first and label it clearly so the model treats it as the task to obey.
    if (role) userParts.push(`Your instruction for this step: ${role}`);
    if (topic) userParts.push(`Topic: ${topic}`);
    if (prompt) userParts.push(`Additional instructions: ${prompt}`);
    if (userParts.length === 0) userParts.push("Write something helpful.");

    const client = getLLMClient();
    const response = await client.complete({
      system: [
        "You are a skilled writer. Compose text based on the provided context and topic.",
        "IMPORTANT: Base your writing on the CONTEXT provided above — do not invent facts.",
        "If context is available, summarise and synthesise it rather than writing from scratch.",
        // Format fidelity: obey any length/shape the instruction asks for (e.g. \"2 sentences\",
        // \"3 bullets\", \"one paragraph\"). Do NOT add a heading, a title label, or extra sections
        // the instruction didn't request.",
        "FOLLOW THE REQUESTED FORMAT EXACTLY. If the instruction specifies a length (e.g. \"2 sentences\", \"3 bullets\") or shape, match it precisely. Do not add a title, heading, or extra sections unless asked.",
        "NEVER prefix lines with field labels like \"title:\" or \"body:\" — write the actual prose directly. Those are internal field names, not something the reader should ever see.",
        "Use plain customer-facing text. For equations, use Unicode operators such as × and ÷; never emit LaTeX delimiters or commands.",
        "Do not mention prices, costs, money, or budgets in the customer-facing output.",
        styleInstruction(style),
        "Output only the composed text — no preamble, no meta-commentary, no JSON wrapper.",
      ].join("\n"),
      messages: [{ role: "user", content: userParts.join("\n\n") }],
      model,
      maxTokens: resolveComposeMaxTokens(provider, style, process.env["KRELVAN_COMPOSE_MAX_TOKENS"]),
      temperature: 0.4,
      plainText: true,
    });

    const text = cleanComposedText(response.text);

    const words = text.split(/\s+/).filter(Boolean).length;
    const costCents = estimateCostCents(provider, model, response.inputTokens, response.outputTokens);

    log.info({ nodeId: call.nodeId, words, costCents }, "compose: done");

    // Expose the composed text under the keys downstream/output_map look for: `result` and
    // `text` (conventional/back-compat), and `body` — compilers frequently declare an output_map
    // of `title=<node>.title,body=<node>.body`, so emitting `body` lets that resolve to clean
    // prose instead of falling back to the raw blob. `title` is a short first-line derived from
    // the text (never the whole body) so the artifact gets a real headline.
    const firstLine = (text.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "")
      .replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    const title = firstLine.length > 70 ? firstLine.slice(0, 68).trimEnd() + "…" : firstLine;
    return {
      output: { result: text, text, body: text, title, words, model },
      claimedCostCents: Math.max(costCents, 1),
    };
  },
};
