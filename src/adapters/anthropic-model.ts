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
  allowedCapabilities: { name: string; sideEffect: string; description?: string; useWhen?: string; notes?: string }[];
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
    const provider = this.cfg.llmConfig?.provider ?? process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";

    // Anthropic supports native tool calling — use it so the model applies its
    // trained tool-selection logic to pick capabilities by description, not by
    // reading a text list and guessing.
    if (provider === "anthropic" && !this.cfg.fetchImpl) {
      return this.proposeWithTools(intent);
    }

    // Fallback for Ollama / OpenAI / test injection: structured JSON prompt.
    return this.proposeWithPrompt(intent);
  }

  /**
   * Anthropic tool-calling path.
   * We define one tool — build_manifest — whose input_schema has a capability
   * enum built from the live registry. The model uses its native tool-selection
   * training to pick the right capabilities by reading their descriptions.
   */
  private async proposeWithTools(intent: string): Promise<ManifestProposal> {
    const capNames = this.cfg.allowedCapabilities.map(c => c.name);

    // Build a tools array: one tool per capability so Anthropic's tool-selection
    // logic fires for each node the model wants to add. Plus one submit tool.
    // Simpler and more reliable: one build_manifest tool whose schema enumerates
    // capabilities — the model fills in the nodes array using the descriptions.
    const tool = {
      name: "build_manifest",
      description: "Build the agent manifest. Call this once with the complete manifest.",
      input_schema: {
        type: "object",
        required: ["version", "name", "intent", "entry", "runBudgetCents", "nodes", "edges"],
        properties: {
          version: { type: "number", description: "Always 1" },
          name: { type: "string", description: "Short kebab-case agent name" },
          intent: { type: "string", description: "The user's intent verbatim" },
          entry: { type: "string", description: "ID of the first node to run" },
          runBudgetCents: { type: "integer", description: "Total budget in cents" },
          maxNodeVisits: { type: "integer", description: "Max times any node may be visited (default 5)" },
          seed: { type: "object", description: "Initial run state key/value pairs (e.g. query for web_search)" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "role", "autonomy", "capabilities"],
              properties: {
                id: { type: "string" },
                role: { type: "string", description: "Precise instruction for what this node does" },
                autonomy: { type: "string", enum: ["full", "act-with-veto", "suggest"] },
                capabilities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "sideEffect", "budgetCents"],
                    properties: {
                      name: { type: "string", enum: capNames, description: "Capability name — must be from the allowed list" },
                      sideEffect: { type: "string" },
                      budgetCents: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              required: ["from", "to"],
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                condition: { type: "string" },
              },
            },
          },
        },
      },
    };

    // Build tool descriptions list so the model knows what each capability does.
    const capDescriptions = this.cfg.allowedCapabilities.map(c => {
      let line = `- **${c.name}**: ${c.description ?? c.name}`;
      if (c.useWhen) line += ` — USE: ${c.useWhen}`;
      if (c.notes) line += ` (NOTE: ${c.notes})`;
      return line;
    }).join("\n");

    const system = [
      "You are a manifest compiler. Given a user's intent, call build_manifest exactly once with the complete agent manifest.",
      "Choose capabilities by matching their descriptions to the intent. Only use capability names from the enum.",
      "autonomy: 'full' for read side-effects, 'act-with-veto' for message-human, 'suggest' for irreversible writes.",
      "runBudgetCents must be an integer. budgetCents on each capability must be an integer.",
      "",
      "AVAILABLE CAPABILITIES:",
      capDescriptions,
    ].join("\n");

    const clientConfig: LLMClientConfig = this.cfg.llmConfig ?? {
      provider: "anthropic",
      apiKey: this.cfg.apiKey || process.env["KRELVAN_LLM_API_KEY"],
    };

    const fetchImpl = (globalThis as Record<string, unknown>)["fetch"] as typeof fetch;
    const apiKey = clientConfig.apiKey ?? "";

    const body = {
      model: this.model,
      max_tokens: 4096,
      temperature: 0,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: "build_manifest" },
      messages: [{ role: "user", content: intent }],
    };

    const outcome = await fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      this.cfg.retry,
      fetchImpl,
    );

    if (!outcome.ok) {
      throw new ModelError(
        outcome.status === 0
          ? `network error calling model: ${outcome.rawBody}`
          : `model API ${outcome.status}: ${outcome.rawBody}`,
      );
    }

    const json = (await outcome.resp.json()) as {
      content?: { type: string; name?: string; input?: unknown }[];
    };

    const toolUse = (json.content ?? []).find(c => c.type === "tool_use" && c.name === "build_manifest");
    if (!toolUse?.input) throw new ModelError("model did not call build_manifest tool");

    log.info({ model: this.model }, "manifest-compiler: tool call received");
    // tool input is already a parsed object — convert to JSON string for the shared parser
    return parseManifestProposal(JSON.stringify(toolUse.input));
  }

  /**
   * Fallback path for Ollama / OpenAI / test injection.
   * Uses a structured JSON prompt with few-shot example.
   */
  private async proposeWithPrompt(intent: string): Promise<ManifestProposal> {
    const system = this.buildSystemPrompt();
    let text: string;

    if (this.cfg.fetchImpl) {
      // Test-injection path
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
        this.cfg.fetchImpl,
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
      const clientConfig: LLMClientConfig = this.cfg.llmConfig ?? {
        provider: (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMClientConfig["provider"],
        apiKey: this.cfg.apiKey || process.env["KRELVAN_LLM_API_KEY"],
        baseUrl: process.env["KRELVAN_LLM_BASE_URL"],
      };
      const client = makeLLMClient(clientConfig);
      try {
        const exampleQ = "Intent: Monitor RSS feed for new posts and send a Telegram alert";
        const exampleA = JSON.stringify({
          version: 1, name: "rss-telegram-monitor",
          intent: "Monitor RSS feed for new posts and send a Telegram alert",
          entry: "fetch", runBudgetCents: 50, maxNodeVisits: 5,
          seed: { url: "https://feeds.example.com/rss.xml" },
          nodes: [
            { id: "fetch", role: "Fetch the RSS feed", autonomy: "full", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 2 }] },
            { id: "analyse", role: "Analyse the feed and identify new posts", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 30 }] },
            { id: "notify", role: "Send a Telegram message summarising new posts", autonomy: "act-with-veto", capabilities: [{ name: "telegram_send", sideEffect: "write-reversible", budgetCents: 2 }] },
          ],
          edges: [{ from: "fetch", to: "analyse" }, { from: "analyse", to: "notify" }],
        });
        const response = await client.complete({
          system,
          messages: [
            { role: "user", content: exampleQ },
            { role: "assistant", content: exampleA },
            { role: "user", content: `Intent: ${intent}` },
          ],
          model: this.model, maxTokens: 2048, temperature: 0,
        });
        text = response.text;
      } catch (err) {
        throw new ModelError(`model call failed: ${(err as Error).message}`);
      }
    }

    if (!text.trim()) throw new ModelError("model returned no text content");
    log.info({ model: this.model, preview: text.slice(0, 200) }, "manifest-compiler: raw model output");
    return parseManifestProposal(text);
  }

  private buildSystemPrompt(): string {
    // Build the capabilities section entirely from the registry — no hardcoded names.
    const capLines = this.cfg.allowedCapabilities.map((c) => {
      let line = `  "${c.name}" (side-effect: "${c.sideEffect}")`;
      if (c.description) line += ` — ${c.description}`;
      if (c.useWhen) line += `\n    USE: ${c.useWhen}`;
      if (c.notes) line += `\n    NOTE: ${c.notes}`;
      return line;
    });
    const caps = capLines.join("\n");

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
      "AVAILABLE CAPABILITIES — what each one does, when to use it, and its side-effect class:",
      caps,
      ...agentSection,
      "",
      "DESIGN GUIDANCE:",
      "- Read the USE: guidance for each capability above — it tells you exactly when to pick it.",
      "- Any agent that needs to REASON or analyse: include a node whose capability's USE says 'intelligence' or 'analysis'.",
      "- Agents that LEARN over time: start with a memory-read capability, end with a memory-write capability.",
      "- Agents that ADAPT path based on content: use a routing capability instead of static edges.",
      "- Match the notification channel to what the user asked for — read the USE guidance for each messaging capability.",
      "- Prefer a user-installed plugin over a built-in when the plugin's description better matches the intent.",
      "- Typical patterns (use capability names from the list above, not these literals):",
      "    Monitoring:  [memory-read] → [reasoning] → [conditional] → [notification] → [memory-write]",
      "    Research:    [web/API fetch] → [reasoning] → [text composition] → [notification]",
      "    Digest:      [memory-read] → [web/API fetch] → [reasoning] → [composition] → [notification] → [memory-write]",
      "    API pipeline: [http-read] → [reasoning] → [http-write]",
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
      "Autonomy rules: use 'full' for capabilities with side-effect 'read'. Use 'act-with-veto' for 'message-human' side-effects so the user can review before sending. Use 'suggest' for irreversible write side-effects.",
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
