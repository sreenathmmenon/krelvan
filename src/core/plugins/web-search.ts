/**
 * "web_search" capability — real web search via Brave Search API with LLM fallback.
 *
 * Priority order:
 *   1. BRAVE_SEARCH_API_KEY set → call Brave Search API (https://api.search.brave.com)
 *      Returns top 5 results as { title, url, snippet }.
 *   2. GENESIS_ANTHROPIC_KEY set (no Brave key) → call Claude haiku to synthesize an
 *      answer from its training knowledge. Returns a single synthetic result.
 *   3. Neither key set → returns empty results with a clear error message. Never throws.
 *
 * Output shape:
 *   { results: [{ title, url, snippet }], query, count, synthetic?, error? }
 *
 * Cost estimate: 8 cents per call.
 * Side effect: "read" — no external writes.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { fetchWithRetry } from "../../adapters/http-retry.js";
import { getLLMClient } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("web-search");

// ── Brave Search response shape ───────────────────────────────────────────────

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
}

// ── Implementation ────────────────────────────────────────────────────────────

export const webSearchCapability: CapabilityPlugin = {
  name: "web_search",
  sideEffect: "read",

  estimateCents: () => 8,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const query = String(input["query"] ?? "");

    const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
    // LLM fallback works with any configured provider
    const hasLlm = !!(process.env["GENESIS_LLM_API_KEY"] ?? process.env["GENESIS_ANTHROPIC_KEY"] ?? process.env["GENESIS_LLM_PROVIDER"] === "ollama");

    // ── Path 1: Brave Search API ───────────────────────────────────────────────
    if (braveKey) {
      log.info({ nodeId: call.nodeId, query }, "web_search: calling Brave Search API");

      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;

      const outcome = await fetchWithRetry(
        url,
        {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": braveKey,
          },
        },
        { maxAttempts: 3, baseDelayMs: 500 },
      );

      if (!outcome.ok) {
        const msg = outcome.status === 0
          ? `network error: ${outcome.rawBody}`
          : `Brave Search API ${outcome.status}: ${outcome.rawBody}`;
        throw new Error(`web_search: ${msg}`);
      }

      const json = (await outcome.resp.json()) as BraveResponse;
      const raw = json.web?.results ?? [];

      const results = raw.slice(0, 5).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));

      log.info({ nodeId: call.nodeId, count: results.length, query }, "web_search: brave results received");

      return {
        output: { results, query, count: results.length },
        claimedCostCents: 8,
      };
    }

    // ── Path 2: LLM synthesis via configured provider ────────────────────────
    if (hasLlm) {
      const provider = process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
      const model = process.env["GENESIS_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
      log.info({ nodeId: call.nodeId, query, model, provider }, "web_search: no Brave key — falling back to LLM synthesis");

      const client = getLLMClient();
      const response = await client.complete({
        system: [
          "You are a knowledgeable assistant. The user is performing a web search.",
          "Synthesize a clear, factual, concise answer to their query based on your training knowledge.",
          "Focus on accuracy. Do not fabricate URLs or citations.",
          "Respond with only the answer text — no preamble, no JSON wrapper.",
        ].join("\n"),
        messages: [{ role: "user", content: `Search query: ${query}\n\nProvide a concise, accurate answer.` }],
        model,
        maxTokens: 1024,
        temperature: 0,
      });

      log.info({ nodeId: call.nodeId, query }, "web_search: LLM synthesis complete");

      return {
        output: {
          results: [{ title: "LLM synthesis", url: "", snippet: response.text }],
          query,
          count: 1,
          synthetic: true,
        },
        claimedCostCents: 8,
      };
    }

    // ── Path 3: No provider configured ───────────────────────────────────────
    log.warn({ nodeId: call.nodeId, query }, "web_search: no search provider configured");

    return {
      output: {
        results: [] as { title: string; url: string; snippet: string }[],
        query,
        count: 0,
        error: "no search provider configured — set BRAVE_SEARCH_API_KEY, or configure GENESIS_LLM_PROVIDER",
      },
      claimedCostCents: 0,
    };
  },
};
