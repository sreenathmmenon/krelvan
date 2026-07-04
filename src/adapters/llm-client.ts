/**
 * LLMClient — the single interface every LLM call in Krelvan goes through.
 *
 * Providers supported (selected via KRELVAN_LLM_PROVIDER env var):
 *   "anthropic"   — Anthropic API (default). Uses KRELVAN_LLM_API_KEY or KRELVAN_ANTHROPIC_KEY.
 *   "openai"      — OpenAI API (chat/completions). Set KRELVAN_LLM_BASE_URL to override.
 *   "ollama"      — Ollama native API (http://localhost:11434). No API key needed.
 *   "gemini"      — Google Gemini (generativelanguage API). Uses KRELVAN_LLM_API_KEY.
 *   "groq"        — Groq (OpenAI-compatible, https://api.groq.com/openai/v1).
 *   "mistral"     — Mistral (OpenAI-compatible, https://api.mistral.ai/v1).
 *   "compatible"  — Generic OpenAI-compatible endpoint. REQUIRES KRELVAN_LLM_BASE_URL.
 *                   Unlocks OpenRouter, Together, Fireworks, DeepSeek, vLLM, LM Studio,
 *                   and any other server that speaks the OpenAI /chat/completions shape.
 *
 * Env vars:
 *   KRELVAN_LLM_PROVIDER      — see list above (default: "anthropic")
 *   KRELVAN_LLM_API_KEY       — API key for the provider (falls back to KRELVAN_ANTHROPIC_KEY for anthropic)
 *   KRELVAN_LLM_BASE_URL      — Base URL override (required for "compatible")
 *   KRELVAN_LLM_MODEL         — Default model to use (overrides per-capability defaults).
 *                               For "compatible"/"groq"/"mistral"/openrouter you must set this
 *                               to whatever model id the endpoint expects.
 *
 * Per-capability model overrides (still work):
 *   KRELVAN_THINK_MODEL       — model for think capability
 *   KRELVAN_ROUTE_MODEL       — model for llm_route capability
 *
 * OpenRouter example (via the generic compatible adapter):
 *   KRELVAN_LLM_PROVIDER=compatible
 *   KRELVAN_LLM_BASE_URL=https://openrouter.ai/api/v1
 *   KRELVAN_LLM_API_KEY=sk-or-...
 *   KRELVAN_LLM_MODEL=anthropic/claude-sonnet-4-6   (or any OpenRouter model slug)
 *
 * Ollama example:
 *   KRELVAN_LLM_PROVIDER=ollama
 *   KRELVAN_LLM_MODEL=llama3.2
 *   (no API key needed; Ollama must be running locally)
 *
 * Groq example:
 *   KRELVAN_LLM_PROVIDER=groq
 *   KRELVAN_LLM_API_KEY=gsk_...
 *   KRELVAN_LLM_MODEL=llama-3.3-70b-versatile
 *
 * Gemini example:
 *   KRELVAN_LLM_PROVIDER=gemini
 *   KRELVAN_LLM_API_KEY=...
 *   KRELVAN_LLM_MODEL=gemini-2.0-flash
 */

import { fetchWithRetry } from "./http-retry.js";
import { getLogger } from "../core/observability/logger.js";
import { recordMeteredCost } from "../core/capability/cost-meter.js";

const log = getLogger("llm-client");

/**
 * Provider identifiers. "openai", "groq", "mistral", and "compatible" all use the
 * OpenAI-compatible /chat/completions wire format under the hood — they differ only
 * in their default base URL. "gemini" uses Google's native generativelanguage API.
 */
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "ollama"
  | "gemini"
  | "groq"
  | "mistral"
  | "compatible";

/** Providers that speak the OpenAI /chat/completions wire format. */
const OPENAI_COMPATIBLE: ReadonlySet<LLMProvider> = new Set<LLMProvider>([
  "openai",
  "groq",
  "mistral",
  "compatible",
]);

/** Default base URL per OpenAI-compatible provider. "compatible" has none — it MUST be supplied. */
const OPENAI_COMPATIBLE_DEFAULT_BASE: Partial<Record<LLMProvider, string>> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
};

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  /**
   * When set, the provider is asked to return a JSON object matching this schema.
   * Each provider implements this via its native mechanism:
   *   Anthropic → forced tool call (tool_choice: tool, schema as input_schema)
   *   OpenAI    → response_format json_schema
   *   Ollama    → format: <schema>
   * The response `.text` will be valid JSON matching the schema.
   */
  schema?: { name: string; description?: string; schema: Record<string, unknown> };
  /**
   * Ask for PLAIN TEXT output (prose), not JSON. Matters for Ollama: its client otherwise
   * forces `format:"json"` on every call, which wraps a translation/haiku/summary in a JSON
   * object. Set this for free-text generations (compose, etc.). Ignored when `schema` is set.
   */
  plainText?: boolean;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClientConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbedResponse {
  vectors: number[][];
  inputTokens: number;
}

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>;
  /** Embed one or more texts into vectors. Optional — not every provider supports it
   *  (Anthropic has no embeddings API); callers should check or use getEmbeddingsClient(). */
  embed?(texts: string[], model: string): Promise<EmbedResponse>;
}

// ── Anthropic client ──────────────────────────────────────────────────────────

class AnthropicLLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // When a schema is requested, use a forced tool call — Anthropic's native
    // structured output mechanism. The response is guaranteed to match the schema.
    if (req.schema) {
      const tool = {
        name: req.schema.name,
        description: req.schema.description ?? req.schema.name,
        input_schema: req.schema.schema,
      };
      const body = {
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        tools: [tool],
        tool_choice: { type: "tool", name: req.schema.name },
        messages: req.messages,
      };
      const outcome = await fetchWithRetry(
        `${this.baseUrl}/v1/messages`,
        { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) },
        { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
      );
      if (!outcome.ok) throw new Error(outcome.status === 0 ? `network error: ${outcome.rawBody}` : `LLM API ${outcome.status}: ${outcome.rawBody}`);
      const json = (await outcome.resp.json()) as { content?: { type: string; name?: string; input?: unknown }[]; usage?: { input_tokens: number; output_tokens: number } };
      const toolUse = (json.content ?? []).find(c => c.type === "tool_use" && c.name === req.schema!.name);
      if (!toolUse?.input) throw new Error(`model did not call ${req.schema.name} tool`);
      return { text: JSON.stringify(toolUse.input), inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
    }

    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages,
    };

    const outcome = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      },
      { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
    );

    if (!outcome.ok) throw new Error(outcome.status === 0 ? `network error: ${outcome.rawBody}` : `LLM API ${outcome.status}: ${outcome.rawBody}`);

    const json = (await outcome.resp.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    const text = (json.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("").trim();
    return { text, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
  }
}

// ── OpenAI-compatible client (OpenAI, OpenRouter, Groq, Together, LM Studio) ─

class OpenAILLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const baseBody: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [{ role: "system", content: req.system }, ...req.messages],
    };

    // Structured output, best-effort across the OpenAI-compatible zoo. Not every model
    // supports json_schema (e.g. many Groq models don't) or even json_object. So we try the
    // strongest mode first and DEGRADE on a 400 that names the response_format, rather than
    // failing the whole run: json_schema → json_object → plain text. When we fall back to a
    // weaker/no mode, the schema's required keys are injected into the prompt so the model is
    // still steered toward the right shape (think.ts already lists them in the role).
    const modes: Array<Record<string, unknown> | null> = req.schema
      ? [
          { type: "json_schema", json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } },
          { type: "json_object" },
          null,
        ]
      : [null];

    // OpenAI/Groq json_object mode REQUIRES the word "json" somewhere in the prompt, else it
    // 400s. When we use it (schema present but json_schema unsupported), make sure the system
    // prompt says so — otherwise the model returns prose and think.ts can't parse it.
    const jsonNudge = "\n\nReturn your answer as a single valid JSON object and nothing else.";
    let outcome: Awaited<ReturnType<typeof fetchWithRetry>> | null = null;
    for (let i = 0; i < modes.length; i++) {
      const rf = modes[i];
      const useJsonObject = rf && (rf as { type?: string }).type === "json_object";
      const body = rf
        ? {
            ...baseBody,
            ...(useJsonObject && !/json/i.test(req.system)
              ? { messages: [{ role: "system", content: req.system + jsonNudge }, ...req.messages] }
              : {}),
            response_format: rf,
          }
        : { ...baseBody };
      outcome = await fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(body) },
        { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
      );
      // Degrade on a 400 that means "this structured mode won't work here":
      //  - response_format unsupported (model can't do json_schema/json_object), OR
      //  - json_validate_failed (Groq: the model produced JSON that didn't match the schema).
      // In both cases, fall through to a looser mode instead of failing the whole run. The last
      // mode (plain text) always "succeeds", and think.ts parses the JSON out of the text.
      const degradable = !outcome.ok && outcome.status === 400
        && /response_format|json_schema|json_object|json_validate_failed|structured output/i.test(outcome.rawBody ?? "");
      if (degradable && i < modes.length - 1) continue;
      // Last-resort recovery: if even the final structured attempt 400s with a json_validate
      // failure, Groq still hands back what the model generated under `failed_generation` —
      // use it rather than throwing, since think.ts can parse partial JSON out of it.
      if (degradable && !outcome.ok) {
        try {
          const err = JSON.parse(outcome.rawBody ?? "{}") as { error?: { failed_generation?: string } };
          const fg = err.error?.failed_generation;
          if (fg && fg.trim()) return { text: fg.trim(), inputTokens: 0, outputTokens: 0 };
        } catch { /* fall through to the throw below */ }
      }
      break;
    }
    if (!outcome) throw new Error("LLM request produced no response");

    if (!outcome.ok) throw new Error(outcome.status === 0 ? `network error: ${outcome.rawBody}` : `LLM API ${outcome.status}: ${outcome.rawBody}`);

    const raw = (await outcome.resp.json()) as Record<string, unknown>;
    // Most OpenAI-compatible providers return { choices, usage } at the top level. Some
    // gateways (e.g. ClinePass) wrap the payload in { data: { choices, usage }, success }.
    // Unwrap a single `data` envelope when the standard `choices` field is absent, so the
    // same client works for both shapes instead of silently reading an empty completion.
    const body = (!("choices" in raw) && raw["data"] && typeof raw["data"] === "object")
      ? (raw["data"] as Record<string, unknown>)
      : raw;
    const json = body as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    return { text, inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 };
  }

  /** OpenAI-compatible embeddings — POST /embeddings (text-embedding-3-small, etc.).
   *  Batches all texts in one call. Works for OpenAI, OpenRouter, Together, vLLM, LM Studio. */
  async embed(texts: string[], model: string): Promise<EmbedResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const outcome = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      { method: "POST", headers, body: JSON.stringify({ model, input: texts }) },
      { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
    );
    if (!outcome.ok) throw new Error(outcome.status === 0 ? `embeddings network error: ${outcome.rawBody}` : `embeddings API ${outcome.status}: ${outcome.rawBody}`);
    const json = (await outcome.resp.json()) as { data?: { embedding: number[] }[]; usage?: { prompt_tokens: number } };
    const vectors = (json.data ?? []).map((d) => d.embedding);
    if (vectors.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${vectors.length}`);
    return { vectors, inputTokens: json.usage?.prompt_tokens ?? 0 };
  }
}

// ── Ollama native client ──────────────────────────────────────────────────────

class OllamaLLMClient implements LLMClient {
  constructor(private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Ollama native API — format:"json" forces valid JSON; passing the full schema
    // constrains the output to match it (supported in Ollama ≥0.4).
    // format: a schema constrains to that shape; plainText asks for prose (no format);
    // otherwise default to "json" (the think/route/compiler callers parse JSON).
    const format = req.schema ? req.schema.schema : req.plainText ? undefined : "json";
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      stream: false,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
    };
    if (format !== undefined) body["format"] = format;

    // Ollama local inference can be slow on large prompts — allow up to 10 minutes.
    const outcome = await fetchWithRetry(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { maxAttempts: 1, baseDelayMs: 0, timeoutMs: 600_000 },
    );

    if (!outcome.ok) {
      const msg = outcome.status === 0
        ? `network error (is Ollama running?): ${outcome.rawBody}`
        : `Ollama API ${outcome.status}: ${outcome.rawBody}`;
      throw new Error(msg);
    }

    const json = (await outcome.resp.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const text = (json.message?.content ?? "").trim();

    return {
      text,
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
    };
  }

  /** Ollama native embeddings — POST /api/embeddings, one call per text (the native
   *  endpoint embeds a single prompt). Local + free (e.g. nomic-embed-text, 768-dim). */
  async embed(texts: string[], model: string): Promise<EmbedResponse> {
    const vectors: number[][] = [];
    for (const prompt of texts) {
      const outcome = await fetchWithRetry(
        `${this.baseUrl}/api/embeddings`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt }) },
        { maxAttempts: 2, baseDelayMs: 500, timeoutMs: 120_000 },
      );
      if (!outcome.ok) {
        throw new Error(outcome.status === 0 ? `embeddings network error (is Ollama running?): ${outcome.rawBody}` : `Ollama embeddings ${outcome.status}: ${outcome.rawBody}`);
      }
      const json = (await outcome.resp.json()) as { embedding?: number[] };
      if (!Array.isArray(json.embedding) || json.embedding.length === 0) throw new Error("Ollama embeddings returned no vector");
      vectors.push(json.embedding);
    }
    return { vectors, inputTokens: 0 };
  }
}

// ── Google Gemini client (generativelanguage API) ──────────────────────────────

class GeminiLLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Gemini's generateContent endpoint. The system prompt is passed via
    // systemInstruction; user/assistant turns map to role "user"/"model".
    // Structured output uses responseMimeType + responseSchema (OpenAPI subset).
    const contents = req.messages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature,
      maxOutputTokens: req.maxTokens,
    };

    if (req.schema) {
      generationConfig["responseMimeType"] = "application/json";
      // Gemini accepts a JSON-Schema-like object; strip the unsupported
      // additionalProperties key which the API rejects.
      generationConfig["responseSchema"] = stripUnsupportedSchemaKeys(req.schema.schema);
    }

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig,
    };

    // API key goes in a query param (?key=...) — Gemini's standard auth.
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const outcome = await fetchWithRetry(
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
    );

    if (!outcome.ok) throw new Error(outcome.status === 0 ? `network error: ${outcome.rawBody}` : `Gemini API ${outcome.status}: ${outcome.rawBody}`);

    const json = (await outcome.resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map(p => p.text ?? "")
      .join("")
      .trim();
    return {
      text,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

/**
 * Gemini's responseSchema rejects `additionalProperties` (and a few other JSON-Schema
 * keys). Recursively strip them so a schema authored for Anthropic/OpenAI still works.
 */
function stripUnsupportedSchemaKeys(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "additionalProperties" || k === "$schema") continue;
      out[k] = stripUnsupportedSchemaKeys(v);
    }
    return out;
  }
  return schema;
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _sharedClient: LLMClient | null = null;

/**
 * Returns the shared LLM client, built from environment variables.
 * Called lazily — reads env at first use, not at import time.
 */
export function getLLMClient(): LLMClient {
  if (_sharedClient) return _sharedClient;

  const provider = (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMProvider;
  const apiKey = process.env["KRELVAN_LLM_API_KEY"] ?? process.env["KRELVAN_ANTHROPIC_KEY"] ?? "";
  const baseUrl = process.env["KRELVAN_LLM_BASE_URL"];

  log.info({ provider, hasApiKey: !!apiKey, baseUrl }, "llm-client: initialising");

  const inner = buildClient({ provider, apiKey, baseUrl });
  // Metering wrapper: every completion's cost — computed HERE from the provider-reported
  // token usage and the rate table, never from anything the caller claims — is recorded
  // into the supervisor's meter scope (a no-op outside one). This is what lets budget
  // settlement use max(pluginClaim, metered): a plugin cannot under-report LLM spend
  // made through the shared client.
  _sharedClient = {
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      const res = await inner.complete(req);
      recordMeteredCost(estimateCostCents(provider, req.model, res.inputTokens, res.outputTokens));
      return res;
    },
    ...(inner.embed ? { embed: inner.embed.bind(inner) } : {}),
  };
  return _sharedClient;
}

/**
 * Returns an EMBEDDINGS client + the model to use, resolved independently of the chat
 * provider (Anthropic — the default chat provider — has NO embeddings API, so RAG must
 * use a different one). Resolution:
 *   KRELVAN_EMBED_PROVIDER / _MODEL / _BASE_URL / _API_KEY override everything; else
 *   reuse the chat provider if it can embed (ollama/openai/compatible/gemini); else
 *   fall back to local Ollama (nomic-embed-text) so RAG works offline with no key.
 */
export function getEmbeddingsClient(): { client: LLMClient & { embed: NonNullable<LLMClient["embed"]> }; model: string } {
  const chatProvider = (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMProvider;
  const explicit = process.env["KRELVAN_EMBED_PROVIDER"] as LLMProvider | undefined;
  let provider: LLMProvider = explicit ?? chatProvider;
  // Anthropic (or anything that can't embed) → fall back to local Ollama.
  if (!explicit && provider === "anthropic") provider = "ollama";

  const apiKey = process.env["KRELVAN_EMBED_API_KEY"] ?? process.env["KRELVAN_LLM_API_KEY"] ?? process.env["KRELVAN_ANTHROPIC_KEY"] ?? "";
  const baseUrl = process.env["KRELVAN_EMBED_BASE_URL"] ?? (provider === (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") ? process.env["KRELVAN_LLM_BASE_URL"] : undefined);
  const model = process.env["KRELVAN_EMBED_MODEL"] ?? defaultEmbedModel(provider);

  const client = buildClient({ provider, apiKey, baseUrl });
  if (typeof client.embed !== "function") {
    throw new Error(`llm-client: embeddings provider "${provider}" does not support embed(). Set KRELVAN_EMBED_PROVIDER to ollama or openai.`);
  }
  return { client: client as LLMClient & { embed: NonNullable<LLMClient["embed"]> }, model };
}

function defaultEmbedModel(provider: LLMProvider): string {
  switch (provider) {
    case "ollama": return "nomic-embed-text";          // 768-dim, local, free
    case "gemini": return "text-embedding-004";        // 768-dim
    default:       return "text-embedding-3-small";    // openai/compatible, 1536-dim
  }
}

/**
 * Shared construction logic used by both getLLMClient (env-driven) and makeLLMClient
 * (explicit-config). Keeping it in one place means every provider behaves identically
 * regardless of how its config arrived.
 */
function buildClient(cfg: LLMClientConfig): LLMClient {
  const apiKey = cfg.apiKey ?? "";

  if (OPENAI_COMPATIBLE.has(cfg.provider)) {
    const base = cfg.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_BASE[cfg.provider];
    if (!base) {
      // "compatible" has no sensible default — fail loud rather than silently
      // pointing at OpenAI with the wrong key.
      throw new Error(
        `llm-client: provider "${cfg.provider}" requires KRELVAN_LLM_BASE_URL (e.g. https://openrouter.ai/api/v1)`,
      );
    }
    return new OpenAILLMClient(apiKey, base);
  }

  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicLLMClient(apiKey, cfg.baseUrl ?? "https://api.anthropic.com");
    case "ollama":
      return new OllamaLLMClient(cfg.baseUrl ?? "http://localhost:11434");
    case "gemini":
      return new GeminiLLMClient(apiKey, cfg.baseUrl ?? "https://generativelanguage.googleapis.com");
    default:
      log.warn({ provider: cfg.provider }, "llm-client: unknown provider, falling back to anthropic");
      return new AnthropicLLMClient(apiKey, cfg.baseUrl ?? "https://api.anthropic.com");
  }
}

/**
 * Returns an LLMClient built from explicit config (used by adapters that receive
 * their config from the runtime, e.g. the compiler and distiller).
 */
export function makeLLMClient(cfg: LLMClientConfig): LLMClient {
  return buildClient(cfg);
}

/**
 * Approximate cost in cents for a given provider/model and token counts.
 * Used by plugins to report claimedCostCents accurately.
 * Defaults to zero for unknown models (e.g. local Ollama).
 */
export function estimateCostCents(
  provider: LLMProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Local inference is free; for arbitrary OpenAI-compatible gateways we can't know
  // the price, so we don't guess (claimedCostCents stays 0 rather than wrong).
  if (provider === "ollama" || provider === "compatible") return 0;

  // Per-million-token rates in cents, [input, output].
  const anthropicRates: Record<string, [number, number]> = {
    "claude-opus-4-8":   [500,  2500],
    "claude-sonnet-4-6": [300,  1500],
    "claude-haiku-4-5":  [100,  500],
    "claude-fable-5":    [1000, 5000],
  };

  const openaiRates: Record<string, [number, number]> = {
    "gpt-4o":        [250,  1000],
    "gpt-4o-mini":   [15,   60],
    "gpt-4-turbo":   [1000, 3000],
    "gpt-3.5-turbo": [50,   150],
    "o3-mini":       [110,  440],
  };

  // Gemini public pricing (approximate, per million tokens).
  const geminiRates: Record<string, [number, number]> = {
    "gemini-2.0-flash":  [10,  40],
    "gemini-1.5-flash":  [7,   30],
    "gemini-1.5-pro":    [125, 500],
  };

  // Groq / Mistral are cheap and price-volatile; left at 0 (no reliable per-model map).
  let rateMap: Record<string, [number, number]>;
  if (provider === "anthropic") rateMap = anthropicRates;
  else if (provider === "gemini") rateMap = geminiRates;
  else if (provider === "openai") rateMap = openaiRates;
  else return 0;

  // Find the first matching key (model slugs may have suffixes/prefixes).
  const entry = Object.entries(rateMap).find(([k]) => model.startsWith(k));
  if (!entry) return 0;

  const [inRate, outRate] = entry[1];
  return Math.ceil((inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate);
}

/** Reset the cached client — used in tests and when config changes. */
export function resetLLMClient(): void {
  _sharedClient = null;
}

// ── Model registry ──────────────────────────────────────────────────────────────

/**
 * One selectable model. `model` is the exact id sent on the wire; `label` is the
 * human-facing name; `note` flags anything the picker should know (e.g. "needs base URL").
 */
export interface ModelOption {
  provider: LLMProvider;
  /** Exact model id to send to the provider. Empty string means "user supplies it". */
  model: string;
  label: string;
  note?: string;
}

export interface ProviderInfo {
  provider: LLMProvider;
  label: string;
  /** Whether this provider needs an API key. */
  needsApiKey: boolean;
  /** Whether the user MUST supply KRELVAN_LLM_BASE_URL for this provider. */
  needsBaseUrl: boolean;
  /** True when the user types an arbitrary model id rather than picking from a fixed list. */
  customModel: boolean;
  models: ModelOption[];
}

/**
 * Curated, REAL model registry. Every id here is one that actually works against its
 * provider's API as of this writing. Where we are not certain an id is current, we omit
 * it and rely on the `customModel` path instead of shipping a wrong hardcoded id.
 *
 * The "compatible" provider intentionally ships NO fixed model list — its whole point is
 * that the user points KRELVAN_LLM_BASE_URL at any OpenAI-compatible gateway (OpenRouter,
 * Together, Fireworks, DeepSeek, vLLM, LM Studio, …) and types whatever model id that
 * gateway expects.
 */
export const PROVIDER_REGISTRY: readonly ProviderInfo[] = [
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    needsApiKey: true,
    needsBaseUrl: false,
    customModel: false,
    models: [
      { provider: "anthropic", model: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { provider: "anthropic", model: "claude-fable-5", label: "Claude Fable 5" },
    ],
  },
  {
    provider: "openai",
    label: "OpenAI",
    needsApiKey: true,
    needsBaseUrl: false,
    customModel: false,
    models: [
      { provider: "openai", model: "gpt-4o", label: "GPT-4o" },
      { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini" },
      { provider: "openai", model: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { provider: "openai", model: "o3-mini", label: "o3-mini" },
      { provider: "openai", model: "", label: "Custom model id…", note: "type any OpenAI model id" },
    ],
  },
  {
    provider: "gemini",
    label: "Google Gemini",
    needsApiKey: true,
    needsBaseUrl: false,
    customModel: false,
    models: [
      { provider: "gemini", model: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { provider: "gemini", model: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
      { provider: "gemini", model: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { provider: "gemini", model: "", label: "Custom model id…", note: "type any Gemini model id" },
    ],
  },
  {
    provider: "groq",
    label: "Groq",
    needsApiKey: true,
    needsBaseUrl: false,
    customModel: false,
    models: [
      { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (versatile)" },
      { provider: "groq", model: "llama-3.1-8b-instant", label: "Llama 3.1 8B (instant)" },
      { provider: "groq", model: "", label: "Custom model id…", note: "type any Groq model id" },
    ],
  },
  {
    provider: "mistral",
    label: "Mistral",
    needsApiKey: true,
    needsBaseUrl: false,
    customModel: false,
    models: [
      { provider: "mistral", model: "mistral-large-latest", label: "Mistral Large" },
      { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small" },
      { provider: "mistral", model: "", label: "Custom model id…", note: "type any Mistral model id" },
    ],
  },
  {
    provider: "ollama",
    label: "Ollama (local)",
    needsApiKey: false,
    needsBaseUrl: false,
    customModel: true,
    models: [
      { provider: "ollama", model: "llama3.2", label: "llama3.2 (example)" },
      { provider: "ollama", model: "", label: "Any local model…", note: "whatever you've pulled" },
    ],
  },
  {
    provider: "compatible",
    label: "OpenAI-compatible (OpenRouter, Together, Fireworks, vLLM, LM Studio…)",
    needsApiKey: true,
    needsBaseUrl: true,
    customModel: true,
    models: [
      {
        provider: "compatible",
        model: "",
        label: "Any model — set base URL + model id",
        note: "one adapter unlocks any OpenAI-compatible endpoint; you supply base URL, key and model id",
      },
    ],
  },
] as const;

/** Flat list of every concrete (non-empty-id) model option across all providers. */
export function listAllModels(): ModelOption[] {
  return PROVIDER_REGISTRY.flatMap(p => p.models.filter(m => m.model !== ""));
}

/** The configured provider from the environment (defaults to anthropic). */
export function currentProvider(): LLMProvider {
  return (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMProvider;
}

/**
 * A sensible default model for a provider when the user hasn't set KRELVAN_LLM_MODEL.
 * `tier` lets cheaper capabilities (llm_route, compose) prefer a smaller model.
 * Returns "" for providers with no safe default (compatible) — the caller must then
 * have KRELVAN_LLM_MODEL set, which is enforced upstream.
 */
export function defaultModelForProvider(
  provider: LLMProvider,
  tier: "smart" | "cheap" = "smart",
): string {
  switch (provider) {
    case "anthropic": return tier === "cheap" ? "claude-haiku-4-5" : "claude-sonnet-4-6";
    case "openai":    return tier === "cheap" ? "gpt-4o-mini" : "gpt-4o";
    case "gemini":    return tier === "cheap" ? "gemini-1.5-flash" : "gemini-2.0-flash";
    case "groq":      return tier === "cheap" ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile";
    case "mistral":   return tier === "cheap" ? "mistral-small-latest" : "mistral-large-latest";
    case "ollama":    return "llama3.2";
    case "compatible": return "";
    default:          return "claude-sonnet-4-6";
  }
}
