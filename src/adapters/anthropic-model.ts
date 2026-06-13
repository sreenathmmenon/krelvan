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
    const capNames = this.cfg.allowedCapabilities.map(c => c.name);

    // Build the manifest JSON schema with capability names as an enum.
    // Every provider (Anthropic, OpenAI, Ollama) uses this schema via its native
    // structured-output mechanism — the LLMClient handles provider differences.
    // The model reads capability descriptions and picks from the enum.
    const manifestSchema = {
      type: "object" as const,
      required: ["version", "name", "intent", "entry", "runBudgetCents", "nodes", "edges"],
      additionalProperties: false,
      properties: {
        version:        { type: "integer", description: "Always 1" },
        name:           { type: "string",  description: "Short kebab-case agent name" },
        intent:         { type: "string",  description: "The user's intent verbatim" },
        entry:          { type: "string",  description: "ID of the first node to run" },
        runBudgetCents: { type: "integer", description: `Total budget in cents, max ${this.cfg.suggestedRunBudgetCents}` },
        maxNodeVisits:  { type: "integer", description: "Max node visits (default 5)" },
        seed: {
          type: "object",
          description: "Initial run state (e.g. {\"query\": \"...\"} for web_search)",
          additionalProperties: true,
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "role", "autonomy", "capabilities"],
            additionalProperties: false,
            properties: {
              id:       { type: "string" },
              role:     { type: "string", description: "Precise instruction for what this node does" },
              autonomy: { type: "string", enum: ["full", "act-with-veto", "suggest"],
                description: "full=read-only, act-with-veto=message-human (user reviews before send), suggest=irreversible writes" },
              capabilities: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "sideEffect", "budgetCents"],
                  additionalProperties: false,
                  properties: {
                    name:         { type: "string", enum: capNames },
                    sideEffect:   { type: "string" },
                    budgetCents:  { type: "integer" },
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
            additionalProperties: false,
            properties: {
              from:      { type: "string" },
              to:        { type: "string" },
              condition: { type: "string" },
            },
          },
        },
      },
    };

    // System prompt: capability descriptions only — no hardcoded names.
    const capDescriptions = this.cfg.allowedCapabilities.map(c => {
      let line = `- ${c.name} (${c.sideEffect}): ${c.description ?? c.name}`;
      if (c.notes) line += `. NOTE: ${c.notes}`;
      return line;
    }).join("\n");

    const agentLines = this.cfg.knownAgents?.length
      ? ["", "Sub-agents you may delegate to (use exact id in subAgent.manifestId):",
          ...this.cfg.knownAgents.map(a => `- ${a.id}: ${a.intent.slice(0, 100)}`)]
      : [];

    const system = [
      "You are a manifest compiler. Given a user's intent, output a complete agent manifest.",
      "Pick capabilities by matching their descriptions to the intent. Only use names from the capability list.",
      "autonomy: full=read, act-with-veto=message-human (requires approval before sending), suggest=irreversible writes.",
      "",
      "CAPABILITIES:",
      capDescriptions,
      ...agentLines,
    ].join("\n");

    const clientConfig: LLMClientConfig = this.cfg.llmConfig ?? {
      provider: (process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic") as LLMClientConfig["provider"],
      apiKey: this.cfg.apiKey || process.env["KRELVAN_LLM_API_KEY"],
      baseUrl: process.env["KRELVAN_LLM_BASE_URL"],
    };

    // Test-injection path uses a raw Anthropic fetch (no shared client).
    if (this.cfg.fetchImpl) {
      const body = {
        model: this.model, max_tokens: 4096, temperature: 0, system,
        tools: [{ name: "build_manifest", description: "Build the manifest", input_schema: manifestSchema }],
        tool_choice: { type: "tool", name: "build_manifest" },
        messages: [{ role: "user", content: intent }],
      };
      const outcome = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.cfg.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) },
        this.cfg.retry, this.cfg.fetchImpl,
      );
      if (!outcome.ok) throw new ModelError(`model API ${outcome.status}: ${outcome.rawBody}`);
      const json = (await outcome.resp.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
      const toolUse = (json.content ?? []).find(c => c.type === "tool_use");
      if (!toolUse?.input) throw new ModelError("model did not return a tool call");
      return parseManifestProposal(JSON.stringify(toolUse.input));
    }

    // Production path — LLMClient handles structured output for each provider.
    const client = makeLLMClient(clientConfig);
    try {
      const response = await client.complete({
        system,
        messages: [{ role: "user", content: intent }],
        model: this.model,
        maxTokens: 4096,
        temperature: 0,
        schema: { name: "build_manifest", description: "Build the agent manifest", schema: manifestSchema },
      });
      log.info({ model: this.model, preview: response.text.slice(0, 120) }, "manifest-compiler: structured output received");
      return parseManifestProposal(response.text);
    } catch (err) {
      throw new ModelError(`model call failed: ${(err as Error).message}`);
    }
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
