/**
 * AnthropicDistiller — memory distillation via the Anthropic API.
 *
 * Distillation is the process of turning episodic run summaries into durable,
 * queryable SemanticFacts. It is a CAPTURED non-deterministic effect: the LLM
 * produced this; we record exactly what it said. On replay we re-serve the
 * captured result — we never re-call the model.
 *
 * Trust model:
 *   - Facts inherit the LEAST-trusted provenance of their source episodes
 *     (distilledProvenance() from memory.ts — untrustedness propagates).
 *   - The distiller produces DATA only: a JSON array of {key, value} pairs.
 *     The caller (the distillation capability plugin) wraps each into a full
 *     SemanticFact and writes it to the ledger as a CAPTURED EffectResult.
 *
 * Robustness:
 *   - Retried up to 3× on transient failures (429/5xx) via fetchWithRetry.
 *   - On total failure, raw response body is included in the thrown error so
 *     the engine can capture it as the "failed" EffectResult payload.
 */

import type { Episode, SemanticFact, Provenance } from "../core/memory/memory.js";
import { distilledProvenance } from "../core/memory/memory.js";
import { makeLLMClient, type LLMClientConfig } from "./llm-client.js";
import { fetchWithRetry, type RetryOptions } from "./http-retry.js";

export interface DistillerConfig {
  apiKey: string;
  model?: string;
  /** Max semantic facts to extract per distillation call. Default 10. */
  maxFacts?: number;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  /** Override the LLM provider/baseUrl (defaults to env-configured provider). */
  llmConfig?: LLMClientConfig;
}

/** A raw key/value pair as the model proposes it. */
interface RawFact {
  key: string;
  value: string | number | boolean;
}

export class DistillationError extends Error {
  constructor(
    message: string,
    /** The raw model output, for capture in the ledger on failure. */
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = "DistillationError";
  }
}

/**
 * Calls the Anthropic API to distill a list of episodes into key/value semantic
 * facts. Returns SemanticFact[] with provenance computed from the source episodes.
 *
 * `distilledBy` is set to the model id used. `version` starts at 1; callers
 * increment when re-distilling from updated episodes.
 */
export class AnthropicDistiller {
  private readonly model: string;
  private readonly maxFacts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: DistillerConfig) {
    const providerDefault = (() => {
      const p = cfg.llmConfig?.provider ?? process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
      if (p === "openai") return "gpt-4o-mini";
      if (p === "ollama") return "llama3.2";
      return "claude-haiku-4-5-20251001";
    })();
    this.model = cfg.model ?? process.env["GENESIS_LLM_MODEL"] ?? providerDefault;
    this.maxFacts = cfg.maxFacts ?? 10;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async distill(
    episodes: readonly Episode[],
    existingFacts: readonly SemanticFact[],
    version: number,
    ts: number,
  ): Promise<SemanticFact[]> {
    if (episodes.length === 0) return [];

    const episodeSummaries = episodes
      .map((e, i) => `Episode ${i + 1} (run ${e.runId}): ${e.summary}`)
      .join("\n");

    const existingSummary =
      existingFacts.length > 0
        ? "Currently known facts:\n" + existingFacts.map((f) => `  ${f.key}: ${JSON.stringify(f.value)}`).join("\n") + "\n\n"
        : "";

    const system = [
      "You are a memory distiller. Given run episode summaries, extract durable semantic facts.",
      `Return ONLY a JSON array of up to ${this.maxFacts} objects, each with "key" (snake_case string) and "value" (string, number, or boolean).`,
      "Output NOTHING else — no prose, no code fences, just the JSON array.",
      "",
      "Rules:",
      "- Keys must be snake_case (e.g. preferred_vendor, last_error_type, user_timezone).",
      "- Values must be strings, numbers, or booleans — never objects or arrays.",
      "- Only extract facts that would be useful across future runs.",
      "- If a fact is already known and unchanged, you may omit it.",
      "- If a known fact has changed, include it with the new value.",
      "",
      "Return [] if nothing useful can be distilled.",
    ].join("\n");

    const userMsg =
      existingSummary +
      "Episodes to distill:\n" +
      episodeSummaries +
      "\n\nReturn ONLY the JSON array of {key, value} facts.";

    let rawText: string;

    if (this.cfg.fetchImpl) {
      // Test-injection path: use direct Anthropic fetch with injected fetchImpl
      const body = {
        model: this.model,
        max_tokens: 1024,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userMsg }],
      };
      const outcome = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.cfg.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        this.cfg.retry,
        this.fetchImpl,
      );
      if (!outcome.ok) {
        const msg = outcome.status === 0
          ? `network error: ${outcome.rawBody}`
          : `distiller API ${outcome.status} after ${outcome.attempts} attempt(s): ${outcome.rawBody}`;
        throw new DistillationError(msg, outcome.rawBody);
      }
      const json = (await outcome.resp.json()) as { content?: { type: string; text?: string }[] };
      rawText = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    } else {
      // Production path: use the shared LLM client (supports all providers)
      const clientConfig: LLMClientConfig = this.cfg.llmConfig ?? {
        provider: (process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic") as LLMClientConfig["provider"],
        apiKey: this.cfg.apiKey || process.env["GENESIS_LLM_API_KEY"],
        baseUrl: process.env["GENESIS_LLM_BASE_URL"],
      };
      const client = makeLLMClient(clientConfig);
      try {
        const response = await client.complete({
          system,
          messages: [{ role: "user", content: userMsg }],
          model: this.model,
          maxTokens: 1024,
          temperature: 0,
        });
        rawText = response.text;
      } catch (err) {
        const msg = (err as Error).message;
        throw new DistillationError(msg, msg);
      }
    }

    const rawFacts = parseFactArray(rawText);
    const provenance: Provenance = distilledProvenance(episodes.map((e) => e.provenance));

    return rawFacts.map((f) => ({
      key: f.key,
      value: f.value,
      derivedFrom: episodes.map((e) => e.runId),
      provenance,
      distilledBy: this.model,
      version,
      ts,
    }));
  }
}

/**
 * Defensively parse the model's text output into RawFact[].
 * Strips code fences, extracts the outermost [...], validates element shapes.
 * Any parsing failure throws DistillationError with the raw text.
 */
function parseFactArray(text: string): RawFact[] {
  let t = text;

  // Strip code fences.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();

  // Extract the outermost [...].
  if (!t.startsWith("[")) {
    const start = t.indexOf("[");
    const end = t.lastIndexOf("]");
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }

  let arr: unknown;
  try {
    arr = JSON.parse(t);
  } catch (e) {
    throw new DistillationError(`distiller output is not valid JSON: ${(e as Error).message}`, text);
  }

  if (!Array.isArray(arr)) throw new DistillationError("distiller output is not an array", text);

  const facts: RawFact[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || r.key.length === 0) continue;
    if (typeof r.value !== "string" && typeof r.value !== "number" && typeof r.value !== "boolean") continue;
    // enforce snake_case key
    if (!/^[a-z][a-z0-9_]*$/.test(r.key)) continue;
    facts.push({ key: r.key, value: r.value as string | number | boolean });
  }

  return facts;
}
