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
import { defaultModelForProvider, makeLLMClient, type LLMClientConfig } from "./llm-client.js";
import { fetchWithRetry, type RetryOptions } from "./http-retry.js";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("manifest-compiler");

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  /** allowed capability NAMES the model may reference (it cannot invent others usefully —
   *  the compiler would reject them anyway, but telling the model keeps proposals valid). */
  allowedCapabilities: { name: string; sideEffect: string; description?: string; useWhen?: string; notes?: string; estimateCents?: number }[];
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
    const provider = cfg.llmConfig?.provider ??
      (process.env["KRELVAN_LLM_PROVIDER"] as LLMClientConfig["provider"] | undefined) ??
      "anthropic";
    const providerDefault = defaultModelForProvider(provider);
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
          description: "Initial run state (e.g. {\"query\": \"...\"} for web_search). When the FINAL node composes prose to deliver, set output_map here, e.g. {\"output_map\": \"title=<node>.title,body=<node>.body,format=markdown\"} pointing at that node's output keys.",
          additionalProperties: true,
        },
        schedule: {
          type: ["object", "null"],
          description: "OPTIONAL. Include this ONLY when the user's own words explicitly request recurring execution. Never infer or invent recurrence for a one-off task. Use {\"kind\":\"cron\",\"expr\":\"0 8 * * 1-5\"} (5-field cron, server-local time) or {\"kind\":\"interval\",\"ms\":3600000} (>= 60000). Omit or null otherwise. This suggestion is re-validated and cannot create recurrence without explicit user intent.",
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
                    budgetCents:  { type: "integer", minimum: 10, description: "Must be >= the capability's base cost. Use at least 50 for unknown plugins." },
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

    // System prompt: capability descriptions. The numeric "weight" is only used to
    // set each node's budgetCents — an internal safety ceiling (deny-by-default /
    // budget-before-spend), never a price shown to anyone.
    const capDescriptions = this.cfg.allowedCapabilities.map(c => {
      let line = `- ${c.name} (${c.sideEffect}, budget weight: ${c.estimateCents ?? 5}): ${c.description ?? c.name}`;
      if (c.useWhen) line += `. USE WHEN: ${c.useWhen}`;
      if (c.notes) line += `. NOTE: ${c.notes}`;
      return line;
    }).join("\n");

    const agentLines = this.cfg.knownAgents?.length
      ? ["", "EXISTING AGENTS you can run/test (match the user's reference by NAME, then use its exact id in seed.agentId + a delegate node):",
          ...this.cfg.knownAgents.map(a => `- ${a.id}  (${a.name}): ${a.intent.slice(0, 90)}`)]
      : [];

    const system = [
      "You are a manifest compiler. Given a user's intent, output a complete agent manifest as a graph of nodes.",
      "",
      "RULES (follow EXACTLY):",
      "- Each node has: id, role, autonomy, capabilities.",
      "  * id = a short identifier YOU invent for the step, e.g. \"fetch\", \"summarize\", \"notify\". NEVER a capability name.",
      "  * role = a plain-English instruction describing what the step does, e.g. \"Fetch the page contents\". NEVER a capability name.",
      "  * capabilities = a list; each item's name MUST be chosen from the CAPABILITIES list below (use the exact name). Set sideEffect to that capability's listed side-effect.",
      "- entry = the id of the FIRST node. It MUST exactly match one of your node ids.",
      "- Every node MUST be reachable from entry through edges. Connect the complete sequence, including the final result node. Never emit disconnected/dead nodes.",
      "- Pick capabilities by matching their descriptions to the intent. Every node should have at least one capability.",
      "- Never choose http_get for calculation, transformation, reasoning, or any task without a URL input. For arithmetic or other local reasoning, use think. If the user says not to use external data, do not use http_get or web_search.",
      "- autonomy: full=read-only steps, act-with-veto=steps that message a human (user reviews before send), suggest=irreversible writes/spend.",
      "- OUTPUT: if the agent's FINAL node composes prose to DELIVER (a brief, digest, summary, reply), that node's role must instruct it to produce a `body` (and ideally a `title`), and you MUST set seed.output_map to \"title=<finalNodeId>.title,body=<finalNodeId>.body,format=markdown\" so the delivered output is captured deterministically. Omit output_map only for agents whose last step is an action (send/write) rather than composed text.",
      "",
      "EXAMPLE — intent: \"fetch a webpage and summarize it for me\":",
      "{",
      "  \"version\": 1, \"name\": \"Page Summarizer\", \"intent\": \"...\", \"entry\": \"fetch\",",
      "  \"runBudgetCents\": 100, \"maxNodeVisits\": 5,",
      "  \"seed\": { \"output_map\": \"title=summarize.title,body=summarize.body,format=markdown\" },",
      "  \"nodes\": [",
      "    { \"id\": \"fetch\", \"role\": \"Fetch the webpage content\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"http_get\", \"sideEffect\": \"read\", \"budgetCents\": 10 } ] },",
      "    { \"id\": \"summarize\", \"role\": \"Summarize the fetched page into a short brief. Output object keys: body (the brief), title (a short headline).\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"think\", \"sideEffect\": \"read\", \"budgetCents\": 50 } ] }",
      "  ],",
      "  \"edges\": [ { \"from\": \"fetch\", \"to\": \"summarize\" } ]",
      "}",
      "",
      "EXAMPLE — a TESTER agent, intent: \"cast synthetic users to test my Support Bot (id sha256:abc…), run each through it, judge, and report\":",
      "When the intent is to TEST/rehearse/stress-test ANOTHER agent with synthetic/fake users, build EXACTLY this 4-node chain: cast (synthetic_users) → run (delegate, with agentId of the agent under test) → judge (think) → report (compose). Put the target agent's id in seed.agentId and pass it into the delegate node. Do NOT collapse this to fewer nodes — the cast and the delegate run are both required.",
      "{",
      "  \"version\": 1, \"name\": \"Support Bot Tester\", \"intent\": \"...\", \"entry\": \"cast\",",
      "  \"runBudgetCents\": 800, \"maxNodeVisits\": 8,",
      "  \"seed\": { \"agentId\": \"sha256:abc…\", \"output_map\": \"title=report.title,body=report.body,format=markdown\" },",
      "  \"nodes\": [",
      "    { \"id\": \"cast\", \"role\": \"Cast synthetic users to test the support bot. Set scenario to what is being tested.\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"synthetic_users\", \"sideEffect\": \"read\", \"budgetCents\": 10 } ] },",
      "    { \"id\": \"run\", \"role\": \"Run each synthetic user's message through the agent under test.\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"delegate\", \"sideEffect\": \"read\", \"budgetCents\": 300 } ] },",
      "    { \"id\": \"judge\", \"role\": \"Judge how well the agent handled each user — pass or fail with a reason.\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"think\", \"sideEffect\": \"read\", \"budgetCents\": 50 } ] },",
      "    { \"id\": \"report\", \"role\": \"Write a short report of which cases passed or failed. Output object keys: body (the report), title (a headline).\", \"autonomy\": \"full\", \"capabilities\": [ { \"name\": \"compose\", \"sideEffect\": \"read\", \"budgetCents\": 50 } ] }",
      "  ],",
      "  \"edges\": [ { \"from\": \"cast\", \"to\": \"run\" }, { \"from\": \"run\", \"to\": \"judge\" }, { \"from\": \"judge\", \"to\": \"report\" } ]",
      "}",
      "",
      "CAPABILITIES (use only these names):",
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
        // The manifest schema intentionally has optional seed/schedule fields, so
        // it is not in OpenAI's all-properties-required strict subset. Krelvan
        // validates the returned manifest before signing or running it.
        schema: { name: "build_manifest", description: "Build the agent manifest", schema: manifestSchema, strict: false },
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
  // Entry must be a REAL node id. Local models often invent an entry name that matches
  // no node (e.g. "start_monitoring"), or set it to a capability name — both fail
  // compilation. Validate against actual node ids and fall back to the first node.
  {
    const nodeIds = new Set((m.nodes as Record<string, unknown>[]).map((n) => n["id"]).filter((x): x is string => typeof x === "string"));
    const firstId = (m.nodes[0] as Record<string, unknown> | undefined)?.["id"];
    if (typeof m.entry !== "string" || !nodeIds.has(m.entry)) {
      m.entry = typeof firstId === "string" ? firstId : "";
    }
  }
  if (typeof m.name !== "string" || !m.name) m.name = "unnamed-agent";
  if (typeof m.intent !== "string") m.intent = "";
  if (typeof m.runBudgetCents !== "number") m.runBudgetCents = 100;
  if (typeof m.maxNodeVisits !== "number") m.maxNodeVisits = 10;
  // Always coerce version to integer 1.
  m.version = 1;

  // Normalize each node's capabilities — fill in missing budgetCents and sideEffect defaults.
  const capDefaultBudget: Record<string, number> = {
    think: 50, web_search: 20, http_get: 10, http_post: 10, recall: 5, remember: 5,
    compose: 20, email_send: 10, telegram_send: 5, slack_send: 5, notify_webhook: 5,
    text_transform: 5, llm_route: 10,
  };
  const capDefaultSideEffect: Record<string, string> = {
    think: "read", web_search: "read", http_get: "read", recall: "read", llm_route: "read",
    compose: "read", text_transform: "read",
    remember: "write-reversible", http_post: "write-reversible", notify_webhook: "write-reversible",
    email_send: "message-human", telegram_send: "message-human", slack_send: "message-human",
  };
  const ALL_CAP_NAMES = new Set(Object.keys(capDefaultSideEffect));
  for (const node of m.nodes as Record<string, unknown>[]) {
    if (!Array.isArray(node["capabilities"])) continue;
    // Local models often put a CAPABILITY NAME in `role` instead of a natural-language
    // instruction (e.g. role:"http_get"). Replace such a role with a readable instruction
    // derived from the node's capabilities, so the canvas + audit stay meaningful.
    const roleVal = node["role"];
    if (typeof roleVal !== "string" || !roleVal.trim() || ALL_CAP_NAMES.has(roleVal.trim())) {
      const capNamesOnNode = (node["capabilities"] as Record<string, unknown>[])
        .map((c) => c["name"]).filter((x): x is string => typeof x === "string");
      node["role"] = capNamesOnNode.length > 0
        ? `Use ${capNamesOnNode.join(", ")} to accomplish this step.`
        : "Perform this step.";
    }
    // Snap capability names to known built-ins. Local models that don't honour the JSON
    // schema enum often emit a near-miss (e.g. "text.transform" for "text_transform",
    // "http.get" for "http_get"). Normalise dot/underscore variants to the real name;
    // drop any capability that still doesn't resolve (a node may end up with none).
    const snap = (name: string): string | null => {
      if (ALL_CAP_NAMES.has(name)) return name;
      const us = name.replace(/\./g, "_");
      if (ALL_CAP_NAMES.has(us)) return us;
      const dot = name.replace(/_/g, ".");
      if (ALL_CAP_NAMES.has(dot)) return dot;
      return null;
    };
    node["capabilities"] = (node["capabilities"] as Record<string, unknown>[]).filter((cap) => {
      const nm = typeof cap["name"] === "string" ? snap(cap["name"]) : null;
      if (nm === null) return false;
      cap["name"] = nm;
      return true;
    });
    for (const cap of node["capabilities"] as Record<string, unknown>[]) {
      if (typeof cap["budgetCents"] !== "number" || !Number.isInteger(cap["budgetCents"]) || cap["budgetCents"] < 5) {
        const name = typeof cap["name"] === "string" ? cap["name"] : "";
        cap["budgetCents"] = capDefaultBudget[name] ?? 50;
      }
      // ALWAYS set sideEffect from the canonical map — the model often emits a wrong or
      // "none" value (e.g. compose:"none"), which fails the compiler's SIDE_EFFECT check.
      const name = typeof cap["name"] === "string" ? cap["name"] : "";
      if (capDefaultSideEffect[name]) cap["sideEffect"] = capDefaultSideEffect[name];
      else if (typeof cap["sideEffect"] !== "string" || !cap["sideEffect"]) cap["sideEffect"] = "read";
    }
  }

  // Drop nodes that ended up with NO usable capabilities (they can't do anything) and
  // any node missing an id. Then re-point entry/edges at surviving nodes so the graph
  // stays connected and runnable.
  const survivors = (m.nodes as Record<string, unknown>[]).filter(
    (n) => typeof n["id"] === "string" && Array.isArray(n["capabilities"]) && (n["capabilities"] as unknown[]).length > 0,
  );
  if (survivors.length > 0 && survivors.length !== (m.nodes as unknown[]).length) {
    const keptIds = new Set(survivors.map((n) => n["id"]));
    m.nodes = survivors;
    // re-chain edges among survivors in declaration order
    m.edges = survivors.slice(0, -1).map((n, i) => ({ from: n["id"], to: survivors[i + 1]!["id"] }));
    if (!keptIds.has(m.entry)) m.entry = survivors[0]!["id"];
  } else {
    // keep edges only between existing nodes
    const ids = new Set((m.nodes as Record<string, unknown>[]).map((n) => n["id"]));
    m.edges = (m.edges as Record<string, unknown>[]).filter((e) => ids.has(e["from"]) && ids.has(e["to"]));
  }

  // Coerce/normalize into the Manifest shape; the compiler does the real validation.
  return m as unknown as Manifest;
}
