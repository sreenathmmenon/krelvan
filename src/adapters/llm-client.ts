/**
 * LLMClient — the single interface every LLM call in Krelvan goes through.
 *
 * Providers supported (selected via KRELVAN_LLM_PROVIDER env var):
 *   "anthropic"  — Anthropic API (default). Uses KRELVAN_LLM_API_KEY or KRELVAN_ANTHROPIC_KEY.
 *   "openai"     — OpenAI API. Also covers any OpenAI-compatible endpoint:
 *                  OpenRouter, Groq, Together, Fireworks, LM Studio, Ollama (/v1 compat mode).
 *                  Set KRELVAN_LLM_BASE_URL to override the base URL.
 *   "ollama"     — Ollama native API (http://localhost:11434). No API key needed.
 *
 * Env vars:
 *   KRELVAN_LLM_PROVIDER      — "anthropic" | "openai" | "ollama"  (default: "anthropic")
 *   KRELVAN_LLM_API_KEY       — API key for the provider (falls back to KRELVAN_ANTHROPIC_KEY for anthropic)
 *   KRELVAN_LLM_BASE_URL      — Base URL override (e.g. https://openrouter.ai/api/v1)
 *   KRELVAN_LLM_MODEL         — Default model to use (overrides per-capability defaults)
 *
 * Per-capability model overrides (still work):
 *   KRELVAN_THINK_MODEL       — model for think capability
 *   KRELVAN_ROUTE_MODEL       — model for llm_route capability
 *
 * OpenRouter example:
 *   KRELVAN_LLM_PROVIDER=openai
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
 *   KRELVAN_LLM_PROVIDER=openai
 *   KRELVAN_LLM_BASE_URL=https://api.groq.com/openai/v1
 *   KRELVAN_LLM_API_KEY=gsk_...
 *   KRELVAN_LLM_MODEL=llama-3.3-70b-versatile
 */

import { fetchWithRetry } from "./http-retry.js";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("llm-client");

export type LLMProvider = "anthropic" | "openai" | "ollama";

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

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ── Anthropic client ──────────────────────────────────────────────────────────

class AnthropicLLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
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
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
    );

    if (!outcome.ok) {
      const msg = outcome.status === 0
        ? `network error: ${outcome.rawBody}`
        : `LLM API ${outcome.status}: ${outcome.rawBody}`;
      throw new Error(msg);
    }

    const json = (await outcome.resp.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("")
      .trim();

    return {
      text,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
  }
}

// ── OpenAI-compatible client (OpenAI, OpenRouter, Groq, Together, LM Studio) ─

class OpenAILLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [
        { role: "system", content: req.system },
        ...req.messages,
      ],
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const outcome = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      { maxAttempts: 3, baseDelayMs: 1000, timeoutMs: 120_000 },
    );

    if (!outcome.ok) {
      const msg = outcome.status === 0
        ? `network error: ${outcome.rawBody}`
        : `LLM API ${outcome.status}: ${outcome.rawBody}`;
      throw new Error(msg);
    }

    const json = (await outcome.resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const text = (json.choices?.[0]?.message?.content ?? "").trim();

    return {
      text,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}

// ── Ollama native client ──────────────────────────────────────────────────────

class OllamaLLMClient implements LLMClient {
  constructor(private readonly baseUrl: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Ollama supports the OpenAI-compatible /v1/chat/completions endpoint
    const body = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        ...req.messages,
      ],
      stream: false,
      options: {
        temperature: req.temperature,
        num_predict: req.maxTokens,
      },
    };

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

  switch (provider) {
    case "anthropic":
      _sharedClient = new AnthropicLLMClient(
        apiKey,
        baseUrl ?? "https://api.anthropic.com",
      );
      break;

    case "openai":
      _sharedClient = new OpenAILLMClient(
        apiKey,
        baseUrl ?? "https://api.openai.com/v1",
      );
      break;

    case "ollama":
      _sharedClient = new OllamaLLMClient(
        baseUrl ?? "http://localhost:11434",
      );
      break;

    default:
      log.warn({ provider }, "llm-client: unknown provider, falling back to anthropic");
      _sharedClient = new AnthropicLLMClient(
        apiKey,
        baseUrl ?? "https://api.anthropic.com",
      );
  }

  return _sharedClient;
}

/**
 * Returns an LLMClient built from explicit config (used by adapters that receive
 * their config from the runtime, e.g. the compiler and distiller).
 */
export function makeLLMClient(cfg: LLMClientConfig): LLMClient {
  switch (cfg.provider) {
    case "openai":
      return new OpenAILLMClient(
        cfg.apiKey ?? "",
        cfg.baseUrl ?? "https://api.openai.com/v1",
      );
    case "ollama":
      return new OllamaLLMClient(cfg.baseUrl ?? "http://localhost:11434");
    case "anthropic":
    default:
      return new AnthropicLLMClient(
        cfg.apiKey ?? "",
        cfg.baseUrl ?? "https://api.anthropic.com",
      );
  }
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
  if (provider === "ollama") return 0;

  // Anthropic pricing (per-million tokens, in cents)
  const anthropicRates: Record<string, [number, number]> = {
    "claude-opus-4-8":         [1500, 7500],
    "claude-sonnet-4-6":       [300,  1500],
    "claude-haiku-4-5-20251001": [25,  125],
  };

  // OpenAI pricing (rough approximations)
  const openaiRates: Record<string, [number, number]> = {
    "gpt-4o":           [250,  1000],
    "gpt-4o-mini":      [15,   60],
    "gpt-4-turbo":      [1000, 3000],
    "gpt-3.5-turbo":    [50,   150],
  };

  const rateMap = provider === "anthropic" ? anthropicRates : openaiRates;

  // Find the first matching key (model slugs may have suffixes)
  const entry = Object.entries(rateMap).find(([k]) => model.startsWith(k));
  if (!entry) return 0;

  const [inRate, outRate] = entry[1];
  return Math.ceil((inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate);
}

/** Reset the cached client — used in tests and when config changes. */
export function resetLLMClient(): void {
  _sharedClient = null;
}
