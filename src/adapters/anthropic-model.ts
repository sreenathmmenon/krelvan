/**
 * Anthropic model adapter — a real implementation of the compiler's ModelPort.
 *
 * This is an ADAPTER (it does network I/O), deliberately OUTSIDE the pure core. It
 * uses the built-in `fetch` (no SDK dependency → the project stays license-clean and
 * dependency-free).
 *
 * The model is UNTRUSTED. Its only job is to PROPOSE a manifest as JSON. Whatever it
 * returns is then run through the Compiler's structural validation + capability
 * monotonicity + signing. So a hallucinated or adversarial proposal cannot escalate
 * privileges or run anything — it can only be rejected. We additionally:
 *  - constrain the model with a strict schema-shaped system prompt,
 *  - parse defensively (a non-JSON or wrong-shape reply is a typed failure, not a crash),
 *  - never execute anything the model returns; it is pure DATA.
 */

import type { ModelPort, ManifestProposal } from "../core/compiler/compiler.js";
import type { Manifest } from "../core/manifest/manifest.js";
import { makeLLMClient, type LLMClientConfig } from "./llm-client.js";
import { fetchWithRetry, type RetryOptions } from "./http-retry.js";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("manifest-compiler");

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  /** allowed capability NAMES the model may reference (it cannot invent others usefully —
   *  the compiler would reject them anyway, but telling the model keeps proposals valid). */
  allowedCapabilities: { name: string; sideEffect: string }[];
  /** the run-budget ceiling to suggest to the model (compiler enforces the real cap). */
  suggestedRunBudgetCents: number;
  /** injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  /** Known registered agents the model may reference by ID in subAgent bindings. */
  knownAgents?: { id: string; name: string; intent: string }[];
  /** Override the provider/baseUrl (defaults to anthropic). */
  llmConfig?: LLMClientConfig;
}

export class AnthropicModel implements ModelPort {
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: AnthropicConfig) {
    const providerDefault = (() => {
      const p = cfg.llmConfig?.provider ?? process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
      if (p === "openai") return "gpt-4o";
      if (p === "ollama") return "llama3.2";
      return "claude-sonnet-4-6";
    })();
    this.model = cfg.model ?? process.env["KRELVAN_LLM_MODEL"] ?? providerDefault;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async propose(intent: string): Promise<ManifestProposal> {
    const system = this.buildSystemPrompt();

    let text: string;

    if (this.cfg.fetchImpl) {
      // Test-injection path: use direct Anthropic fetch with injected fetchImpl
      const body = {
        model: this.model,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages: [{ role: "user", content: `Intent: ${intent}\n\nReturn ONLY the JSON manifest.` }],
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
        throw new ModelError(
          outcome.status === 0
            ? `network error calling model: ${outcome.rawBody}`
            : `model API ${outcome.status} after ${outcome.attempts} attempt(s): ${outcome.rawBody}`,
        );
      }
      const json = (await outcome.resp.json()) as { content?: { type: string; text?: string }[] };
      text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    } else {
      // Production path: use the shared LLM client (supports all providers)
      const clientConfig: LLMClientConfig = this.cfg.llmConfig ?? {
        provider: (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMClientConfig["provider"],
        apiKey: this.cfg.apiKey || process.env["KRELVAN_LLM_API_KEY"],
        baseUrl: process.env["KRELVAN_LLM_BASE_URL"],
      };
      const client = makeLLMClient(clientConfig);
      try {
        // Few-shot: give one complete Q→A exchange so the model learns the exact output format.
        const exampleQ = "Intent: Monitor RSS feed for new posts and send a Telegram alert";
        const exampleA = JSON.stringify({
          version: 1,
          name: "rss-telegram-monitor",
          intent: "Monitor RSS feed for new posts and send a Telegram alert",
          entry: "fetch",
          runBudgetCents: 50,
          maxNodeVisits: 5,
          seed: { url: "https://feeds.example.com/rss.xml" },
          nodes: [
            { id: "fetch", role: "Fetch the RSS feed and return its content", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 2 }] },
            { id: "analyse", role: "Analyse the RSS feed content and identify new posts. Set alert_needed to true if new posts found.", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 30 }] },
            { id: "notify", role: "Send a Telegram message summarising new posts", autonomy: "act-with-veto", capabilities: [{ name: "telegram_send", sideEffect: "write-reversible", budgetCents: 2 }] },
          ],
          edges: [{ from: "fetch", to: "analyse" }, { from: "analyse", to: "notify" }],
        });
        const userMsg = `Intent: ${intent}`;
        const response = await client.complete({
          system,
          messages: [
            { role: "user", content: exampleQ },
            { role: "assistant", content: exampleA },
            { role: "user", content: userMsg },
          ],
          model: this.model,
          maxTokens: 2048,
          temperature: 0,
        });
        text = response.text;
      } catch (err) {
        throw new ModelError(`model call failed: ${(err as Error).message}`);
      }
    }

    if (!text.trim()) throw new ModelError("model returned no text content");

    log.info({ model: this.model, textLen: text.length, preview: text.slice(0, 200) }, "manifest-compiler: raw model output");

    return parseManifestProposal(text);
  }

  private buildSystemPrompt(): string {
    const caps = this.cfg.allowedCapabilities.map((c) => `  - "${c.name}" (side-effect: "${c.sideEffect}")`).join("\n");

    const agentSection: string[] = [];
    if (this.cfg.knownAgents?.length) {
      agentSection.push(
        "",
        "REGISTERED AGENTS — available for subAgent delegation (use their exact ID):",
        ...this.cfg.knownAgents.map((a) => `  - id: "${a.id}"  name: "${a.name}"  purpose: "${a.intent.slice(0, 120)}"`),
        "IMPORTANT: Only use an id from the list above in subAgent.manifestId. Never invent an id.",
      );
    }

    return [
      "You are a manifest compiler for Krelvan. Output ONLY valid JSON. No prose, no code fences, no wrapper keys.",
      "",
      "CRITICAL OUTPUT RULES (violating any of these makes the output unusable):",
      "- Output a single JSON object at the top level. Do NOT wrap it in a 'manifest' key or any other key.",
      "- 'version' MUST be the integer 1. Not '1', not '1.0' — the JSON number 1.",
      "- Every node MUST have: id, role, autonomy, capabilities.",
      "- 'entry' MUST match one of the node ids.",
      "",
      "CONCRETE EXAMPLE — a research agent that searches the web then summarises:",
      '{"version":1,"name":"ai-news-digest","intent":"Find latest AI news and summarise","entry":"search","runBudgetCents":100,"maxNodeVisits":5,',
      ' "seed":{"query":"latest artificial intelligence news 2025"},',
      ' "nodes":[',
      '   {"id":"search","role":"Search for the latest AI news","autonomy":"full","capabilities":[{"name":"web_search","sideEffect":"read","budgetCents":10}]},',
      '   {"id":"summarise","role":"Summarise the top 3 AI developments from the search results","autonomy":"full","capabilities":[{"name":"think","sideEffect":"read","budgetCents":50}]}',
      ' ],',
      ' "edges":[{"from":"search","to":"summarise"}]}',
      "",
      "KEY CAPABILITIES — what each one does and WHEN to use it:",
      '  "think"          — calls an LLM (Claude) to reason about run state → outputs thought + result + optional next node.',
      '                     USE: any node that needs intelligence, analysis, summarisation, or decision-making.',
      '  "recall"         — reads this agent\'s memory from past runs → outputs remembered facts.',
      '                     USE: first node of any agent that should remember context across runs.',
      '  "remember"       — writes an episode to agent memory after a run.',
      '                     USE: last node of any agent that should learn over time.',
      '  "llm_route"      — LLM chooses the next node from declared candidates based on run state.',
      '                     USE: when which node to go to next depends on the content of results.',
      '  "web_search"     — searches the web (Brave API) and returns top results as text.',
      '                     USE: any agent that needs current information, news, prices, or facts.',
      '                     IMPORTANT: web_search reads its search query from the "query" key in run state.',
      '                     ALWAYS include "query": "<what to search for>" in the manifest "seed" field',
      '                     when using web_search, so the query is available from the start of the run.',
      '  "compose"        — writes text via Claude haiku given a topic, prompt, and style.',
      '                     USE: drafting messages, summaries, reports, or any text output.',
      '  "email_send"     — sends an email (Resend or SMTP). Input: to, subject, body.',
      '                     USE: whenever the agent should notify a person by email.',
      '  "telegram_send"  — sends a Telegram message via Bot API. Input: text, optional chat_id.',
      '                     USE: real-time Telegram notifications or alerts to a user.',
      '  "slack_send"     — posts to Slack via Incoming Webhook. Input: text, optional blocks.',
      '                     USE: team notifications, alerts, or summaries to a Slack channel.',
      '  "http_get"       — fetches a URL and returns the response body. Input: url, optional headers.',
      '                     USE: reading APIs, RSS feeds, web pages, or any external data source.',
      '  "http_post"      — sends an HTTP POST. Input: url, body, content_type.',
      '                     USE: calling external APIs, submitting forms, triggering webhooks.',
      '  "notify_webhook" — POSTs a JSON payload to a webhook URL with optional HMAC signature.',
      '                     USE: notifying external systems (GitHub, Jira, PagerDuty, etc.).',
      '  "text_transform" — transforms text: upper, lower, trim. Input: text, op.',
      '                     USE: simple text normalization steps.',
      "",
      "ALL available capabilities and their side-effect classes:",
      caps,
      ...agentSection,
      "",
      "DESIGN GUIDANCE:",
      "- Any agent that needs to REASON or analyse: include a 'think' node — this is what makes it an agent, not just a workflow.",
      "- Agents that LEARN over time: start with 'recall', end with 'remember'.",
      "- Agents that ADAPT path based on content: use 'llm_route' instead of static edges.",
      "- Agents that NOTIFY people: end with 'email_send', 'telegram_send', or 'slack_send' depending on the channel.",
      "- Agents that FETCH external data: use 'web_search' for general web, 'http_get' for a specific API endpoint.",
      "  When using web_search: always add the search topic to seed, e.g. \"seed\": { \"query\": \"latest AI news\" }.",
      "- Agents that TRIGGER external systems: use 'http_post' or 'notify_webhook'.",
      "- Typical patterns:",
      "    Monitoring agent:    recall → think → [if alert needed] → telegram_send/email_send → remember",
      "    Research agent:      web_search → think → compose → email_send",
      "    Digest agent:        recall → web_search → think → compose → slack_send → remember",
      "    API agent:           http_get → think → http_post",
      "    Multi-agent pipeline: delegate-node (subAgent) → think → compose → slack_send",
      "    Agent-as-validator:   think → validate-node (subAgent, onSubFailure:'return-error') → compose",
      "",
      "MULTI-AGENT CHAINING — using subAgent to delegate to a registered agent:",
      "  A capability can delegate to a pre-existing registered agent by adding a 'subAgent' field.",
      "  The engine spawns a full sub-run of that agent, enforces budget ceiling, and maps outputs back.",
      "  Use ONLY when the agent's ID appears in the REGISTERED AGENTS list above.",
      "  subAgent capability shape:",
      '  { "name": "<slug>", "sideEffect": "read", "budgetCents": <integer>,',
      '    "subAgent": { "manifestId": "<registered agent id>", "onSubFailure": "return-error",',
      '                  "outputMapping": { "<parentStateKey>": "<subAgentNodeId.outputKey>" } } }',
      "  outputMapping note: sub-agent state keys are namespaced 'nodeId.key'.",
      "  Example: sub-agent node 'summarise' outputting 'result' → key is 'summarise.result'.",
      "  Map it to a parent key: { \"summary\": \"summarise.result\" }",
      "",
      `Keep total runBudgetCents <= ${this.cfg.suggestedRunBudgetCents}. All cents are integers (no decimals).`,
      "Autonomy rules: 'full' for read-only nodes (think, recall, web_search, http_get, subAgent).",
      "Use 'act-with-veto' for message-human nodes (email_send, telegram_send, slack_send) so the user can review before sending.",
      "Use 'suggest' for irreversible external writes (http_post to production APIs).",
      "The 'role' field on each node is the system prompt shown to 'think' at runtime — make it a precise, specific instruction.",
      "",
      "CRITICAL OUTPUT RULES:",
      "- Output ONLY the JSON object. No explanation, no markdown, no code fences, no wrapper objects.",
      "- Do NOT wrap the JSON in a 'manifest' key or any other key. The top-level object IS the manifest.",
      "- 'version' MUST be the integer 1 (not '1', not '1.0', not a string — exactly the number 1).",
      "- Every node MUST have 'id', 'role', 'autonomy', and 'capabilities' keys.",
    ].join("\n");
  }
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * Parse the model's text into a ManifestProposal DEFENSIVELY. Strips code fences if
 * present, extracts the first JSON object, and shape-checks the top level. Any
 * deviation is a typed ModelError, never a crash. (Deep validation is the compiler's
 * job; this just guarantees we hand the compiler a plausibly-shaped object.)
 */
export function parseManifestProposal(text: string): Manifest {
  let t = text.trim();
  // strip ```json … ``` fences if the model added them despite instructions
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) t = fence[1].trim();
  // else extract the outermost {...}
  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }

  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    throw new ModelError(`model output is not valid JSON: ${(e as Error).message}`);
  }

  if (typeof obj !== "object" || obj === null) throw new ModelError("model output is not an object");
  let m = obj as Record<string, unknown>;

  // Some models (e.g. Ollama/qwen) wrap the manifest in a nested key like {"manifest": {...}}.
  // Unwrap one level if the top-level object doesn't have the expected "nodes" or "entries" key.
  if (!Array.isArray(m["nodes"]) && typeof m["manifest"] === "object" && m["manifest"] !== null) {
    m = m["manifest"] as Record<string, unknown>;
  }

  // Normalize version: accept "1", "1.0", 1, 1.0 — all mean version 1.
  if (Math.floor(Number(m.version)) !== 1) throw new ModelError("manifest version must be 1");
  if (!Array.isArray(m.nodes)) throw new ModelError("manifest.nodes must be an array");

  // Tolerate missing optional top-level fields — fill in safe defaults.
  // The compiler validates and rejects unusable manifests; the parser just ensures shape.
  if (!Array.isArray(m.edges)) m.edges = [];
  // If edges are empty but multiple nodes exist, auto-chain them in declaration order.
  // This is the most common model omission — the nodes are in the right order, just not wired.
  if ((m.edges as unknown[]).length === 0 && (m.nodes as unknown[]).length > 1) {
    const nodes = m.nodes as Record<string, unknown>[];
    m.edges = nodes.slice(0, -1).map((n, i) => ({
      from: n["id"],
      to: (nodes[i + 1] as Record<string, unknown>)["id"],
    }));
  }
  if (typeof m.entry !== "string") {
    // Default entry to the first node id if present.
    const firstNode = m.nodes[0] as Record<string, unknown> | undefined;
    m.entry = typeof firstNode?.["id"] === "string" ? firstNode["id"] : "";
  }
  if (typeof m.name !== "string" || !m.name) m.name = "unnamed-agent";
  if (typeof m.intent !== "string") m.intent = "";
  if (typeof m.runBudgetCents !== "number") m.runBudgetCents = 100;
  if (typeof m.maxNodeVisits !== "number") m.maxNodeVisits = 10;
  // Always coerce version to integer 1.
  m.version = 1;

  // Normalize each node's capabilities — fill in missing budgetCents and sideEffect defaults.
  const capDefaultBudget: Record<string, number> = {
    think: 50, web_search: 10, http_get: 2, http_post: 2, recall: 2, remember: 2,
    compose: 20, email_send: 5, telegram_send: 2, slack_send: 2, notify_webhook: 2,
    text_transform: 1, llm_route: 10,
  };
  const capDefaultSideEffect: Record<string, string> = {
    think: "read", web_search: "read", http_get: "read", recall: "read", llm_route: "read",
    remember: "write", http_post: "write", compose: "read",
    email_send: "write-reversible", telegram_send: "write-reversible",
    slack_send: "write-reversible", notify_webhook: "write-reversible", text_transform: "read",
  };
  for (const node of m.nodes as Record<string, unknown>[]) {
    if (!Array.isArray(node["capabilities"])) continue;
    for (const cap of node["capabilities"] as Record<string, unknown>[]) {
      if (typeof cap["budgetCents"] !== "number" || !Number.isInteger(cap["budgetCents"]) || cap["budgetCents"] < 0) {
        const name = typeof cap["name"] === "string" ? cap["name"] : "";
        cap["budgetCents"] = capDefaultBudget[name] ?? 10;
      }
      if (typeof cap["sideEffect"] !== "string" || !cap["sideEffect"]) {
        const name = typeof cap["name"] === "string" ? cap["name"] : "";
        cap["sideEffect"] = capDefaultSideEffect[name] ?? "read";
      }
    }
  }

  // Coerce/normalize into the Manifest shape; the compiler does the real validation.
  return m as unknown as Manifest;
}
