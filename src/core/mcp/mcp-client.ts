/**
 * MCP (Model Context Protocol) client — connects Krelvan to any MCP server.
 *
 * MCP is Anthropic's open standard for connecting AI to tools and data.
 * Hundreds of companies already publish MCP servers (GitHub, Stripe, Notion,
 * Slack, Linear, Postgres, …). By speaking MCP natively, Krelvan gets all of
 * them for free — no per-integration code needed.
 *
 * Transport: stdio (local process) or HTTP/SSE (remote server).
 *
 * Protocol (JSON-RPC 2.0 over stdio):
 *   → initialize
 *   ← initialized
 *   → tools/list
 *   ← { tools: [{ name, description, inputSchema }] }
 *   → tools/call  { name, arguments }
 *   ← { content: [{ type, text }] }
 *
 * Each MCP tool becomes a Krelvan CapabilityPlugin automatically.
 * Side effect is inferred from the tool name / description heuristics; can be
 * overridden in the MCP server config.
 *
 * Security (fail-closed):
 *   - A tool is classified "read" ONLY if it positively matches a read keyword
 *     (get/list/read/fetch/…). Anything we cannot positively recognize as read-only
 *     defaults to "write-irreversible" so it REQUIRES approval — an unknown
 *     third-party tool can never silently install as a harmless read.
 *   - The Supervisor signs every EffectResult — MCP tools are untrusted data
 *     sources the same way YAML capabilities are
 *   - No eval. The client speaks JSON-RPC only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { getLogger } from "../observability/logger.js";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import type { SideEffectClass } from "../manifest/manifest.js";
import { KRELVAN_VERSION } from "../../version.js";

const log = getLogger("mcp-client");

// ── JSON-RPC 2.0 types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ── MCP protocol types ────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
}

// ── MCP server config ─────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Display name for this MCP server */
  name: string;
  /** stdio transport: command to spawn */
  command?: string;
  /** args for the stdio command */
  args?: string[];
  /**
   * Env vars for the spawned MCP process. Values may reference a Krelvan secret as
   * `{{secret:NAME}}` — it is resolved from the secret store at spawn, so a registry
   * entry never inlines a token. e.g. { "GITHUB_PERSONAL_ACCESS_TOKEN": "{{secret:GITHUB_TOKEN}}" }.
   * The child gets a SCRUBBED base env (PATH/HOME/etc) PLUS these — never Krelvan's own secrets.
   */
  env?: Record<string, string>;
  /** HTTP/SSE transport: base URL of the MCP server */
  url?: string;
  /** Override side effect for all tools from this server */
  defaultSideEffect?: SideEffectClass;
  /** Per-tool side effect overrides: { "tool-name": "write-irreversible" } */
  toolSideEffects?: Record<string, SideEffectClass>;
  /** Optional allowlist — only expose these tool names as capabilities (token-context hygiene). */
  tools?: string[];
  /** Cost estimate in cents per call (default: 5) */
  estimateCents?: number;
}

/** Resolve a Krelvan secret ref to its value (or undefined). Injected per-registry. */
export type McpSecretResolver = (name: string) => string | undefined;

/**
 * Build the env for a spawned MCP child. SECURITY: starts from a small ALLOWLIST of safe
 * host vars (never the full process.env, which holds Krelvan's signing secrets / auth
 * token / LLM keys), then layers the server's declared env with any `{{secret:NAME}}`
 * resolved from the secret store. So a third-party MCP server sees only PATH-class vars +
 * exactly the credentials it was granted.
 */
const MCP_ENV_ALLOW = new Set([
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "NODE_PATH", "NODE_OPTIONS", "SHELL", "USER", "LOGNAME", "SystemRoot", "ComSpec", "APPDATA",
]);
export function buildMcpChildEnv(
  declared: Record<string, string> | undefined,
  resolveSecret: McpSecretResolver | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && MCP_ENV_ALLOW.has(k)) out[k] = v;
  }
  for (const [k, rawVal] of Object.entries(declared ?? {})) {
    out[k] = String(rawVal).replace(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g, (_m, name: string) => {
      const resolved = resolveSecret?.(name);
      return resolved ?? "";
    });
  }
  return out;
}

/** Collect the secret refs a server config declares in its env (for secretRefs validation). */
export function mcpSecretRefs(config: McpServerConfig): string[] {
  const refs = new Set<string>();
  for (const v of Object.values(config.env ?? {})) {
    for (const m of String(v).matchAll(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g)) {
      if (m[1]) refs.add(m[1]);
    }
  }
  return [...refs];
}

// ── Side effect inference ─────────────────────────────────────────────────────

const IRREVERSIBLE_KEYWORDS = ["delete", "destroy", "remove", "drop", "purge", "send_email", "send-email", "wipe", "truncate", "reset"];
const SPEND_KEYWORDS = ["pay", "charge", "purchase", "buy", "transfer_money", "stripe", "refund", "invoice"];
const MESSAGE_KEYWORDS = ["send_message", "post_message", "send_sms", "notify", "message"];
const WRITE_KEYWORDS = ["create", "update", "write", "set", "put", "post", "add", "insert", "upsert", "patch", "exec", "run", "query", "modify", "edit", "rename", "move"];
// Tools we can POSITIVELY recognize as read-only. Only these get the ungated "read"
// class; everything else FAILS CLOSED (see below).
const READ_KEYWORDS = ["get", "list", "read", "fetch", "search", "find", "view", "show", "describe", "lookup", "query_read", "retrieve", "status", "info"];

/**
 * Infer the side-effect class of an MCP tool from its name/description.
 *
 * SECURITY — fail-closed: an MCP server is third-party/untrusted. If we cannot
 * POSITIVELY classify a tool as read-only, we default to `write-irreversible`, which
 * makes the autonomy gate REQUIRE approval before the tool runs (unless the operator
 * granted full autonomy). A tool like `wipeAccount`/`execSql` that we don't recognize
 * must never silently install as a harmless `read`.
 */
export function inferSideEffect(toolName: string, description: string = ""): SideEffectClass {
  const combined = `${toolName} ${description}`.toLowerCase();
  if (SPEND_KEYWORDS.some(k => combined.includes(k))) return "spend";
  if (IRREVERSIBLE_KEYWORDS.some(k => combined.includes(k))) return "write-irreversible";
  if (MESSAGE_KEYWORDS.some(k => combined.includes(k))) return "message-human";
  if (WRITE_KEYWORDS.some(k => combined.includes(k))) return "write-reversible";
  // Positively read-only? (and not caught by any write/spend keyword above)
  if (READ_KEYWORDS.some(k => combined.includes(k))) return "read";
  // Unknown tool → fail closed: treat as irreversible so it gates for approval.
  return "write-irreversible";
}

// ── Stdio MCP transport ───────────────────────────────────────────────────────

export class StdioMcpTransport {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly resolveSecret?: McpSecretResolver,
  ) {}

  async connect(): Promise<void> {
    if (!this.config.command) throw new Error("StdioMcpTransport requires a command");

    // Scrubbed env (PATH-class only) + the server's declared env with {{secret:}} resolved.
    // The MCP child NEVER inherits Krelvan's own secrets.
    const env = buildMcpChildEnv(this.config.env, this.resolveSecret);

    this.proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      log.info({ server: this.config.name, stderr: chunk.toString("utf8").trim() }, "mcp stderr");
    });
    this.proc.on("exit", (code) => {
      log.warn({ server: this.config.name, code }, "mcp server exited");
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server '${this.config.name}' exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Send initialize
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "krelvan", version: KRELVAN_VERSION },
    });

    // Send initialized notification (no response expected)
    this.notify("notifications/initialized", {});
    this.ready = true;
    log.info({ server: this.config.name }, "mcp server connected");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in msg && msg.id !== undefined) {
          const pending = this.pending.get(msg.id as number);
          if (pending) {
            this.pending.delete(msg.id as number);
            pending.resolve(msg as JsonRpcResponse);
          }
        }
        // notifications (no id) are silently dropped — we don't use them yet
      } catch {
        // not JSON — ignore (MCP servers sometimes emit non-JSON on startup)
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => {
          if (r.error) reject(new Error(`MCP error ${r.error.code}: ${r.error.message}`));
          else resolve(r.result);
        },
        reject,
      });

      const line = JSON.stringify(msg) + "\n";
      this.proc?.stdin?.write(line);
    });
  }

  private notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  async disconnect(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }

  isConnected(): boolean {
    return this.ready && this.proc !== null && !this.proc.killed;
  }
}

// ── HTTP/SSE MCP transport ────────────────────────────────────────────────────

export class HttpMcpTransport {
  private ready = false;

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (!this.config.url) throw new Error("HttpMcpTransport requires a url");
    // Initialize handshake
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "krelvan", version: KRELVAN_VERSION },
    });
    this.ready = true;
    log.info({ server: this.config.name, url: this.config.url }, "mcp http server connected");
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.config.url) throw new Error("no url");
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };
    const res = await fetch(this.config.url + "/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as JsonRpcResponse;
    if (data.error) throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    return data.result;
  }

  async disconnect(): Promise<void> {
    this.ready = false;
  }

  isConnected(): boolean {
    return this.ready;
  }
}

type McpTransport = StdioMcpTransport | HttpMcpTransport;

// ── MCP client ────────────────────────────────────────────────────────────────

export class McpClient {
  private transport: McpTransport;
  private tools: McpTool[] = [];

  constructor(private readonly config: McpServerConfig, resolveSecret?: McpSecretResolver) {
    if (config.url) {
      this.transport = new HttpMcpTransport(config);
    } else if (config.command) {
      this.transport = new StdioMcpTransport(config, resolveSecret);
    } else {
      throw new Error(`MCP server '${config.name}' requires either 'command' or 'url'`);
    }
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    const result = await this.transport.request("tools/list", {}) as { tools: McpTool[] };
    let tools = result.tools ?? [];
    // Optional allowlist: expose only the named tools (keeps the agent's tool context tight).
    if (this.config.tools && this.config.tools.length > 0) {
      const allow = new Set(this.config.tools);
      tools = tools.filter((t) => allow.has(t.name));
    }
    this.tools = tools;
    log.info({ server: this.config.name, tools: this.tools.map(t => t.name) }, "mcp tools discovered");
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  /**
   * Convert all discovered MCP tools into Krelvan CapabilityPlugins.
   * Each plugin name is prefixed with the server name: "github.create_issue"
   */
  toCapabilityPlugins(): CapabilityPlugin[] {
    return this.tools.map(tool => this.toolToPlugin(tool));
  }

  private toolToPlugin(tool: McpTool): CapabilityPlugin {
    const serverName = this.config.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const pluginName = `${serverName}.${tool.name}`;
    const estimateCents = this.config.estimateCents ?? 5;

    const sideEffect: SideEffectClass =
      this.config.toolSideEffects?.[tool.name] ??
      this.config.defaultSideEffect ??
      inferSideEffect(tool.name, tool.description);

    const transport = this.transport;
    const serverDisplayName = this.config.name;

    return {
      name: pluginName,
      sideEffect,
      estimateCents: () => estimateCents,
      async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
        const args = (call.input ?? {}) as Record<string, unknown>;
        log.info({ server: serverDisplayName, tool: tool.name, args }, "mcp tool call");

        const result = await transport.request("tools/call", {
          name: tool.name,
          arguments: args,
        }) as McpToolResult;

        if (result.isError) {
          const errText = result.content.find(c => c.type === "text")?.text ?? "unknown error";
          throw new Error(`MCP tool '${tool.name}' returned error: ${errText}`);
        }

        // Normalise output: if single text content, return the string; otherwise return content array
        const output = result.content.length === 1 && result.content[0]?.type === "text"
          ? result.content[0].text
          : result.content;

        return { output, claimedCostCents: estimateCents };
      },
    };
  }
}

// ── MCP registry — manages multiple servers ───────────────────────────────────

export class McpRegistry {
  private clients = new Map<string, McpClient>();

  /** A secret resolver lets `{{secret:NAME}}` in a server's env be filled from the store. */
  constructor(private readonly resolveSecret?: McpSecretResolver) {}

  async connect(config: McpServerConfig): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    try {
      if (this.clients.has(config.name)) {
        await this.clients.get(config.name)!.disconnect();
      }
      const client = new McpClient(config, this.resolveSecret);
      await client.connect();
      this.clients.set(config.name, client);
      const tools = client.getTools().map(t => `${config.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}.${t.name}`);
      return { ok: true, tools };
    } catch (err) {
      log.warn({ server: config.name, err }, "failed to connect mcp server");
      return { ok: false, error: (err as Error).message };
    }
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  allPlugins(): CapabilityPlugin[] {
    return [...this.clients.values()].flatMap(c => c.toCapabilityPlugins());
  }

  listServers(): Array<{ name: string; connected: boolean; tools: string[] }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      connected: client.isConnected(),
      tools: client.getTools().map(t => {
        const prefix = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        return `${prefix}.${t.name}`;
      }),
    }));
  }
}
