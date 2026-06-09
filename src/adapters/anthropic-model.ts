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
      const p = cfg.llmConfig?.provider ?? process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
      if (p === "openai") return "gpt-4o";
      if (p === "ollama") return "llama3.2";
      return "claude-sonnet-4-6";
    })();
    this.model = cfg.model ?? process.env["GENESIS_LLM_MODEL"] ?? providerDefault;
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
        provider: (process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic") as LLMClientConfig["provider"],
        apiKey: this.cfg.apiKey || process.env["GENESIS_LLM_API_KEY"],
        baseUrl: process.env["GENESIS_LLM_BASE_URL"],
      };
      const client = makeLLMClient(clientConfig);
      try {
        const response = await client.complete({
          system,
          messages: [{ role: "user", content: `Intent: ${intent}\n\nReturn ONLY the JSON manifest.` }],
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
      "You are a manifest compiler for Genesis — an AI agent platform. Given a user's natural-language intent,",
      "output ONLY a JSON object describing a multi-node agent workflow. Output NOTHING else — no prose, no code fences.",
      "",
      "The JSON MUST match exactly this shape:",
      "{",
      '  "version": 1,',
      '  "name": "<short-slug>",',
      '  "intent": "<echo the intent>",',
      '  "entry": "<id of the first node>",',
      '  "runBudgetCents": <integer>,',
      '  "maxNodeVisits": <integer >= 1>,',
      '  "nodes": [ { "id": "<slug>", "role": "<role description>", "autonomy": "suggest|act-with-veto|full",',
      '              "capabilities": [ { "name": "<cap>", "sideEffect": "<class>", "budgetCents": <integer> } ] } ],',
      '  "edges": [ { "from": "<id>", "to": "<id>" } ]',
      "}",
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
  const m = obj as Record<string, unknown>;
  if (m.version !== 1) throw new ModelError("manifest version must be 1");
  if (!Array.isArray(m.nodes)) throw new ModelError("manifest.nodes must be an array");
  if (!Array.isArray(m.edges)) throw new ModelError("manifest.edges must be an array");
  if (typeof m.entry !== "string") throw new ModelError("manifest.entry must be a string");
  if (typeof m.name !== "string") throw new ModelError("manifest.name must be a string");

  // Coerce/normalize into the Manifest shape; the compiler does the real validation.
  return obj as Manifest;
}
