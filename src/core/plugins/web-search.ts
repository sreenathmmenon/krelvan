/**
 * "web_search" capability — real web search, provider-agnostic, with graceful fallback.
 *
 * The customer is NOT locked to one search vendor. Whichever provider they configure a key for
 * (in the in-app Secrets UI or via env) is used: Brave, Tavily, Serper, SerpApi, You.com, Bing.
 * Adding another provider is one entry in SEARCH_PROVIDERS — no other code changes.
 *
 * Priority order:
 *   1. Configured provider (the customer's chosen search source) → real results.
 *   2. Keyless web search (works with no key at all, best-effort).
 *   3. LLM synthesis from training knowledge (clearly labelled as not-live) — last resort.
 *   4. Nothing available → soft {ok:false} with a clear message. Never throws into the run.
 *
 * Output shape: { results: [{ title, url, snippet }], findings, query, count, synthetic?, error? }
 * Side effect: "read" — no external writes.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { fetchWithRetry } from "../../adapters/http-retry.js";
import { getLLMClient, currentProvider, resolveModel } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("web-search");

// ── secret resolver hook ────────────────────────────────────────────────────────
// A customer configures their OWN search source in the in-app Secrets/Connections UI (no env
// edits, no redeploy) — the same mechanism email/telegram use. The runtime overrides this at boot
// (setSearchSecretResolver) to read the encrypted secret store; it still falls back to
// process.env, so a platform owner can set a default for everyone. Precedence per lookup:
// in-app secret → environment variable.
let secretResolver: (name: string) => string | undefined = (n) => process.env[n];
export function setSearchSecretResolver(fn: (name: string) => string | undefined): void {
  secretResolver = fn;
}
function secret(...names: string[]): string | undefined {
  for (const n of names) { const v = secretResolver(n); if (v && v.trim()) return v.trim(); }
  return undefined;
}

// ── Provider-AGNOSTIC search ───────────────────────────────────────────────────
// Krelvan doesn't lock a customer to one search vendor. Any supported provider works: the
// customer sets a key for whichever they have (Brave, Tavily, Serper, SerpApi, Bing, You.com…)
// and web_search uses it. Adding a provider = one entry here; no other code changes.
// Each provider: the key names it reads (in-app secret or env) + how to call it + how to shape
// results into { title, url, snippet }. Ordered by preference; the first with a key wins.
interface SearchProvider {
  id: string;
  keyNames: string[];  // secret/env names the customer might use for this provider's key
  run(query: string, key: string): Promise<SearchResult[]>;
}

// Small helper: GET/POST JSON and map a results array through a shaper.
async function jsonSearch(
  url: string,
  init: Parameters<typeof fetchWithRetry>[1],
  pick: (json: unknown) => SearchResult[],
): Promise<SearchResult[]> {
  const outcome = await fetchWithRetry(url, init, { maxAttempts: 3, baseDelayMs: 500 });
  if (!outcome.ok) throw new Error(`HTTP ${outcome.status}: ${String(outcome.rawBody).slice(0, 120)}`);
  return pick(await outcome.resp.json());
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
const S = (v: unknown): string => (typeof v === "string" ? v : "");

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: "linkup",
    keyNames: ["LINKUP_API_KEY", "linkup-api-key"],
    run: (q, key) => jsonSearch(
      "https://api.linkup.so/v1/search",
      { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ q, depth: "standard", outputType: "searchResults" }) },
      (j) => arr((j as { results?: unknown }).results).slice(0, 5)
        .map((r) => ({ title: S(r["name"]), url: S(r["url"]), snippet: S(r["content"]) })),
    ),
  },
  {
    id: "brave",
    keyNames: ["BRAVE_SEARCH_API_KEY", "brave-api-key", "BRAVE_API_KEY"],
    run: (q, key) => jsonSearch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
      { method: "GET", headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key } },
      (j) => arr((j as { web?: { results?: unknown } }).web?.results).slice(0, 5)
        .map((r) => ({ title: S(r["title"]), url: S(r["url"]), snippet: S(r["description"]) })),
    ),
  },
  {
    id: "tavily",
    keyNames: ["TAVILY_API_KEY", "tavily-api-key"],
    run: (q, key) => jsonSearch(
      "https://api.tavily.com/search",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key, query: q, max_results: 5 }) },
      (j) => arr((j as { results?: unknown }).results).slice(0, 5)
        .map((r) => ({ title: S(r["title"]), url: S(r["url"]), snippet: S(r["content"]) })),
    ),
  },
  {
    id: "serper",
    keyNames: ["SERPER_API_KEY", "serper-api-key"],
    run: (q, key) => jsonSearch(
      "https://google.serper.dev/search",
      { method: "POST", headers: { "content-type": "application/json", "X-API-KEY": key }, body: JSON.stringify({ q }) },
      (j) => arr((j as { organic?: unknown }).organic).slice(0, 5)
        .map((r) => ({ title: S(r["title"]), url: S(r["link"]), snippet: S(r["snippet"]) })),
    ),
  },
  {
    id: "serpapi",
    keyNames: ["SERPAPI_API_KEY", "serpapi-key", "SERP_API_KEY"],
    run: (q, key) => jsonSearch(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      (j) => arr((j as { organic_results?: unknown }).organic_results).slice(0, 5)
        .map((r) => ({ title: S(r["title"]), url: S(r["link"]), snippet: S(r["snippet"]) })),
    ),
  },
  {
    id: "you",
    keyNames: ["YOU_API_KEY", "you-api-key", "YDC_API_KEY"],
    run: (q, key) => jsonSearch(
      `https://api.ydc-index.io/search?query=${encodeURIComponent(q)}`,
      { method: "GET", headers: { "X-API-Key": key, Accept: "application/json" } },
      (j) => arr((j as { hits?: unknown }).hits).slice(0, 5)
        .map((r) => ({ title: S(r["title"]), url: S(r["url"]), snippet: Array.isArray(r["snippets"]) ? S((r["snippets"] as unknown[])[0]) : S(r["description"]) })),
    ),
  },
  {
    id: "bing",
    keyNames: ["BING_SEARCH_API_KEY", "bing-api-key", "AZURE_BING_KEY"],
    run: (q, key) => jsonSearch(
      `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=5`,
      { method: "GET", headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" } },
      (j) => arr((j as { webPages?: { value?: unknown } }).webPages?.value).slice(0, 5)
        .map((r) => ({ title: S(r["name"]), url: S(r["url"]), snippet: S(r["snippet"]) })),
    ),
  },
];

/** The first configured provider (customer's chosen search source), or null for none. */
function activeSearchProvider(): { provider: SearchProvider; key: string } | null {
  // A customer can also pin a provider explicitly via SEARCH_PROVIDER=tavily; otherwise the first
  // provider that has a key wins.
  const pinned = secret("SEARCH_PROVIDER", "search-provider")?.toLowerCase();
  const ordered = pinned
    ? [...SEARCH_PROVIDERS].sort((a, b) => (a.id === pinned ? -1 : b.id === pinned ? 1 : 0))
    : SEARCH_PROVIDERS;
  for (const provider of ordered) {
    const key = secret(...provider.keyNames)
      // a generic name the customer can use with SEARCH_PROVIDER pinned
      ?? (pinned === provider.id ? secret("SEARCH_API_KEY", "search-api-key") : undefined);
    if (key) return { provider, key };
  }
  return null;
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

    const llmProvider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    const hasLlm = llmProvider === "ollama"
      || !!(process.env["KRELVAN_LLM_API_KEY"] || process.env["KRELVAN_ANTHROPIC_KEY"]);

    // ── Path 1: the customer's configured search provider (ANY vendor) ─────────
    // Whichever provider the customer set a key for (Brave/Tavily/Serper/SerpApi/You/Bing/…) is
    // used. A provider error (bad key, rate-limit, 5xx) is soft: degrade to keyless → LLM rather
    // than hard-failing the run.
    const configured = activeSearchProvider();
    if (configured) {
      log.info({ nodeId: call.nodeId, query, provider: configured.provider.id }, "web_search: calling configured provider");
      try {
        const results = await configured.provider.run(query, configured.key);
        if (results.length > 0) {
          log.info({ nodeId: call.nodeId, provider: configured.provider.id, count: results.length, query }, "web_search: provider results received");
          return shapeSearchOutput(results, query, 8);
        }
        log.warn({ nodeId: call.nodeId, provider: configured.provider.id, query }, "web_search: provider returned nothing — degrading");
      } catch (err) {
        log.warn({ nodeId: call.nodeId, provider: configured.provider.id, query, err: (err as Error)?.message }, "web_search: provider failed — degrading");
        if (!hasLlm) {
          return { output: { ok: false, error: `web_search (${configured.provider.id}): ${(err as Error)?.message}`, results: [], query, count: 0 }, claimedCostCents: 0 };
        }
        // fall through to keyless / LLM synthesis below
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
      const provider = currentProvider();
      const model = resolveModel(provider, "cheap");
      log.info({ nodeId: call.nodeId, query, model, provider }, "web_search: keyless search unavailable — LLM synthesis (last resort)");

      const client = getLLMClient();
      const response = await client.complete({
        system: [
          "You are a knowledgeable assistant answering a query from your training knowledge",
          "because live web search is unavailable (no search API key configured).",
          "Synthesize a clear, factual, concise answer. Focus on accuracy — do NOT fabricate URLs,",
          "citations, dates, or claim knowledge of events after your training cutoff.",
          "If the query asks for the LATEST/current/today's information, be explicit that you are",
          "describing general knowledge and cannot confirm the most recent developments.",
          "Respond with only the answer text — no preamble, no JSON wrapper.",
        ].join("\n"),
        messages: [{ role: "user", content: `Query: ${query}\n\nProvide a concise, accurate answer from your knowledge.` }],
        model,
        maxTokens: 1024,
        temperature: 0,
      });

      log.info({ nodeId: call.nodeId, query }, "web_search: LLM synthesis complete");

      // Prefix the findings with an honest note so a downstream summary doesn't present training
      // knowledge as if it were fresh, live web results. (Set BRAVE_SEARCH_API_KEY for real search.)
      const note = "[Note: no live web search available — the following is from general knowledge, not current sources.]";
      const findings = `${note}\n\n${response.text}`;
      // IMPORTANT: expose the answer as a FLAT string (`findings`), not only nested in
      // results[].snippet. The engine's nodeOutputState drops arrays/objects from run state, so a
      // downstream compose/think node would otherwise receive NO usable content.
      return {
        output: {
          results: [{ title: "General knowledge (no live search)", url: "", snippet: response.text }],
          findings,
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
        error: "no search available — add a search provider key (Linkup, Brave, Tavily, Serper, SerpApi, You.com, or Bing) in Secrets, or configure an LLM provider for a knowledge-based fallback",
      },
      claimedCostCents: 0,
    };
  },
};
