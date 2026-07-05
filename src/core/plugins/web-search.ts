/**
 * "web_search" capability — real web search via Brave Search API with LLM fallback.
 *
 * Priority order:
 *   1. BRAVE_SEARCH_API_KEY set → call Brave Search API (https://api.search.brave.com)
 *      Returns top 5 results as { title, url, snippet }.
 *   2. KRELVAN_ANTHROPIC_KEY set (no Brave key) → call Claude haiku to synthesize an
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

// A value is an "instruction" (a role/command prompt), not a search subject, if it reads
// like a directive. Such text must never be used as a search query — it returns junk.
function isInstruction(s: string): boolean {
  if (s.length > 140) return true; // a real search subject is short; a prompt is long
  return /^(you are|search|look up|find |retrieve|fetch|using |produce|output|write|draft|analyze|assess|identify|determine|gather)\b/i.test(s.trim())
    || /\boutput object keys\b/i.test(s);
}

// Shape search hits into the output every downstream node can actually use: the raw
// `results` array AND a readable `findings` text block (what LLM nodes read from context).
// Agents reference either `results` (structured) or `findings` (prose) — both are populated.
function shapeSearchOutput(results: SearchResult[], query: string, costCents: number) {
  const findings = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");
  return {
    output: { results, findings, query, count: results.length },
    claimedCostCents: costCents,
  };
}

// ── Keyless real web search ───────────────────────────────────────────────────
// Returns genuine results (title + real URL + snippet) with no API key, so every agent
// does real research out of the box. Uses DuckDuckGo's HTML endpoint, parsed defensively.
// Isolated + best-effort: if the source or its markup changes, it returns [] and the caller
// degrades gracefully (never throws into the run).
interface SearchResult { title: string; url: string; snippet: string }

async function keylessWebSearch(query: string): Promise<SearchResult[]> {
  const outcome = await fetchWithRetry(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (compatible; Krelvan-agent/1.0)", "Accept": "text/html" } },
    { maxAttempts: 2, baseDelayMs: 400 },
  );
  if (!outcome.ok) throw new Error(`keyless search HTTP ${outcome.status}`);
  const html = await outcome.resp.text();

  const results: SearchResult[] = [];
  const snippets: string[] = [];
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (let sm = snippetRe.exec(html); sm !== null && snippets.length < 12; sm = snippetRe.exec(html)) {
    snippets.push(cleanText(sm[1] ?? ""));
  }
  const linkRe = /class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  for (let lm = linkRe.exec(html); lm !== null && results.length < 6; lm = linkRe.exec(html)) {
    const url = unwrapDdgUrl(lm[1] ?? "");
    const title = cleanText(lm[2] ?? "");
    if (url && title) results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

function cleanText(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded-real-url>. Unwrap it.
function unwrapDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1]) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  if (href.startsWith("//")) return `https:${href}`;
  return href.startsWith("http") ? href : "";
}

// ── Implementation ────────────────────────────────────────────────────────────

export const webSearchCapability: CapabilityPlugin = {
  name: "web_search",
  sideEffect: "read",

  estimateCents: () => 8,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;

    // Build the search query from the real SUBJECT MATTER in state — never the node's role
    // instruction (that's a command, not a query; searching it returns junk). Priority:
    //   1. an explicit query/topic/subject value the agent set
    //   2. a query composed from the concrete subject values in state (product, company,
    //      topic, audience) — this is what makes any research node search for the right thing
    //   3. the agent intent
    const explicitKeys = ["query", "topic", "subject", "search_query", "q"];
    let query = "";
    for (const k of explicitKeys) {
      const v = String(input[k] ?? "").trim();
      if (v && !isInstruction(v)) { query = v; break; }
    }
    if (!query) {
      // Compose from the subject-matter fields agents carry, in priority order. Values that
      // look like instructions/roles or are too long to be a subject are skipped.
      const subjectKeys = ["product", "company", "brand", "site_url", "topic", "audience", "goal", "watch_label"];
      const parts: string[] = [];
      for (const k of subjectKeys) {
        const v = String(input[k] ?? "").trim();
        if (v && v.length <= 120 && !isInstruction(v) && !/^https?:\/\//i.test(v)) parts.push(v);
        if (parts.length >= 2) break;
      }
      query = parts.join(" — ").slice(0, 160);
    }
    if (!query) {
      query = String(input["intent"] ?? "").slice(0, 160).trim();
      if (isInstruction(query)) query = "";
    }
    if (!query) {
      log.warn({ nodeId: call.nodeId }, "web_search: no usable subject in state — set 'query' or 'topic' in the manifest seed");
    }

    // Guard: if still no query after all fallbacks, return early with a clear error.
    if (!query) {
      return {
        output: { results: [] as { title: string; url: string; snippet: string }[], query: "", count: 0, error: "no query available — add \"query\": \"<topic>\" to the manifest seed field" },
        claimedCostCents: 0,
      };
    }

    const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
    const llmProvider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    const hasLlm = llmProvider === "ollama"
      || !!(process.env["KRELVAN_LLM_API_KEY"] || process.env["KRELVAN_ANTHROPIC_KEY"]);

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
        // A Brave error (401 revoked key, 429 rate-limit, 5xx) must NOT hard-fail the run.
        // Every other outbound plugin returns a soft failure the graph can branch on; do the
        // same — degrade to LLM synthesis if a provider is configured, else a soft {ok:false}.
        const msg = outcome.status === 0
          ? `network error: ${outcome.rawBody}`
          : `Brave Search API ${outcome.status}: ${outcome.rawBody}`;
        log.warn({ nodeId: call.nodeId, query, err: msg }, "web_search: Brave failed — degrading");
        if (!hasLlm) {
          return { output: { ok: false, error: `web_search: ${msg}`, results: [], query, count: 0 }, claimedCostCents: 0 };
        }
        // fall through to Path 2 (LLM synthesis) below
      } else {
        const json = (await outcome.resp.json()) as BraveResponse;
        const raw = json.web?.results ?? [];

        const results = raw.slice(0, 5).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.description ?? "",
        }));

        log.info({ nodeId: call.nodeId, count: results.length, query }, "web_search: brave results received");

        return shapeSearchOutput(results, query, 8);
      }
    }

    // ── Path 2: Real keyless web search — works for every customer, no key ────
    // Krelvan's promise is "describe an outcome, get a working agent." A research agent must
    // return REAL results out of the box, not model-imagined ones. This queries a keyless web
    // search and returns genuine {title, url, snippet}. Premium providers (Tavily/Brave/SerpAPI
    // connectors) are the optional upgrade; the LLM-synthesis below is only a last resort.
    try {
      const results = await keylessWebSearch(query);
      if (results.length > 0) {
        log.info({ nodeId: call.nodeId, count: results.length, query }, "web_search: keyless web results received");
        return shapeSearchOutput(results, query, 2);
      }
      log.warn({ nodeId: call.nodeId, query }, "web_search: keyless search returned nothing — degrading");
    } catch (err) {
      log.warn({ nodeId: call.nodeId, query, err: (err as Error)?.message }, "web_search: keyless search failed — degrading");
    }

    // ── Path 3: LLM synthesis via configured provider (last resort) ──────────
    if (hasLlm) {
      const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
      const model = process.env["KRELVAN_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
      log.info({ nodeId: call.nodeId, query, model, provider }, "web_search: keyless search unavailable — LLM synthesis (last resort)");

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
        error: "no search provider configured — set BRAVE_SEARCH_API_KEY, or configure KRELVAN_LLM_PROVIDER",
      },
      claimedCostCents: 0,
    };
  },
};
