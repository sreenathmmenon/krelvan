/**
 * KrelvanRuntime — the single wiring object for the API server.
 *
 * Holds:
 *  - The ledger store (SQLite)
 *  - The agent registry (in-memory, backed by a JSON sidecar file)
 *  - The run registry (in-memory, backed by a JSON sidecar file)
 *  - The capability registry (in-memory, YAML plugins loaded from disk)
 *  - The compiler (NL → manifest)
 *  - The engine factory
 *  - The scheduler
 *
 * This is the only place that does impure wiring. Everything below it is pure or
 * takes its dependencies as arguments.
 */

import { HmacKeyring, contentAddress } from "../core/ledger/crypto.js";
import { SqliteLedgerStore } from "../core/ledger/sqlite-store.js";
import { Engine } from "../core/kernel/engine.js";
import { Supervisor, type CapabilityPlugin } from "../core/capability/capability.js";
import { Compiler } from "../core/compiler/compiler.js";
import { getLogger } from "../core/observability/logger.js";
import type { LedgerStore } from "../core/ledger/store.js";
import { validateManifest, type Manifest } from "../core/manifest/manifest.js";
import { canonicalize } from "../core/ledger/canonical.js";
import type { SignedManifest, AllowedCapability } from "../core/compiler/compiler.js";
import type { SideEffectClass } from "../core/manifest/manifest.js";
import { loadYamlCapability } from "../core/extensions/yaml-capability.js";
import { AnthropicModel } from "../adapters/anthropic-model.js";
import { McpRegistry, type McpServerConfig } from "../core/mcp/mcp-client.js";
import { loadCapabilityDirectory, loadJsCapabilities } from "../core/capability/directory-loader.js";
import { Scheduler, ScheduleRegistry, validateCron, type ScheduleRecord } from "./scheduler.js";
import { thinkCapability } from "../core/plugins/think.js";
import { recallCapability, rememberCapability, identifyCapability, loadSoul, saveSoul } from "../core/plugins/memory-plugins.js";
import { llmRouteCapability } from "../core/plugins/llm-route.js";
import { webSearchCapability } from "../core/plugins/web-search.js";
import { composeCapability } from "../core/plugins/compose.js";
import { emailSendCapability } from "../core/plugins/email-send.js";
import { telegramSendCapability } from "../core/plugins/telegram-send.js";
import { slackSendCapability } from "../core/plugins/slack-send.js";
import { httpGetCapability } from "../core/plugins/http-get.js";
import { httpPostCapability } from "../core/plugins/http-post.js";
import { notifyWebhookCapability } from "../core/plugins/notify-webhook.js";
import { PluginLifecycleService } from "../core/plugins/lifecycle-service.js";
import { PluginActivator } from "../core/plugins/plugin-activator.js";
import { PluginFactory } from "../core/plugins/plugin-factory.js";
import { SqlitePluginRepository } from "../infrastructure/plugins/sqlite-plugin-repository.js";
import { YamlPluginLoader } from "../infrastructure/plugins/yaml-plugin-loader.js";
import { TypeScriptPluginLoader } from "../infrastructure/plugins/typescript-plugin-loader.js";
import type { SecretBrokerPort, OwnerId, PluginInstallResult, PluginEnableResult, PluginDisableResult, PluginUninstallResult } from "../core/plugins/ports.js";
import { parseOwnerId } from "../core/plugins/ports.js";
import { join, resolve as resolvePath } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { NewEvent } from "../core/ledger/event.js";

const log = getLogger("runtime");

// ── HITL approval record ───────────────────────────────────────────────────────

export interface PendingApproval {
  correlationId: string;
  runId: string;
  agentId: string;
  agentName: string;
  nodeId: string;
  capability: string;
  requestedAt: number;
}

// ── Agent registry ─────────────────────────────────────────────────────────────

export interface AgentRecord {
  id: string;
  signed: SignedManifest;
  createdAt: number;
  scheduleMs?: number;  // if set, run on this interval
  lastRunId?: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "agents.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as AgentRecord[];
      for (const a of raw) this.agents.set(a.id, a);
      log.info({ count: this.agents.size }, "loaded agents from disk");
    } catch (err) {
      log.warn({ err }, "failed to load agents.json — starting fresh");
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.agents.values()], null, 2));
  }

  save(signed: SignedManifest): AgentRecord {
    const record: AgentRecord = { id: signed.id, signed, createdAt: Date.now() };
    this.agents.set(record.id, record);
    this.persist();
    return record;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  updateLastRun(agentId: string, runId: string): void {
    const a = this.agents.get(agentId);
    if (a) { a.lastRunId = runId; this.persist(); }
  }

  delete(id: string): boolean {
    const existed = this.agents.has(id);
    if (existed) { this.agents.delete(id); this.persist(); }
    return existed;
  }

  defaultAllowedCapabilities(): AllowedCapability[] {
    return [
      { name: "think",          sideEffect: "read",              maxBudgetCents: 2000 },
      { name: "recall",         sideEffect: "read",              maxBudgetCents: 50   },
      { name: "remember",       sideEffect: "read",              maxBudgetCents: 50   },
      { name: "llm_route",      sideEffect: "read",              maxBudgetCents: 500  },
      { name: "web_search",     sideEffect: "read",              maxBudgetCents: 500  },
      { name: "compose",        sideEffect: "read",              maxBudgetCents: 500  },
      { name: "telegram_send",  sideEffect: "message-human",     maxBudgetCents: 100  },
      { name: "slack_send",     sideEffect: "message-human",     maxBudgetCents: 100  },
      { name: "email_send",     sideEffect: "message-human",     maxBudgetCents: 100  },
      { name: "http_get",       sideEffect: "read",              maxBudgetCents: 200  },
      { name: "http_post",      sideEffect: "write-reversible",  maxBudgetCents: 200  },
      { name: "text_transform", sideEffect: "read",              maxBudgetCents: 50   },
      { name: "notify_webhook", sideEffect: "write-reversible",  maxBudgetCents: 100  },
      // subAgent capabilities use "read" side-effect from the parent's perspective;
      // the sub-run's own capabilities enforce their own side-effect classes.
      { name: "delegate",       sideEffect: "read",              maxBudgetCents: 5000 },
    ];
  }
}

// ── Run registry ───────────────────────────────────────────────────────────────

export type RunStatus = "pending" | "running" | "completed" | "failed" | "halted";

export interface RunRecord {
  runId: string;
  agentId: string;
  manifestName: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
  spentCents?: number;
  reason?: string;
}

export class RunRegistry {
  private runs = new Map<string, RunRecord>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "runs.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as RunRecord[];
      for (const r of raw) this.runs.set(r.runId, r);
    } catch (err) {
      log.warn({ err }, "failed to load runs.json — starting fresh");
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.runs.values()], null, 2));
  }

  create(opts: { agentId: string; runId: string; manifestName: string }): RunRecord {
    const record: RunRecord = {
      runId: opts.runId,
      agentId: opts.agentId,
      manifestName: opts.manifestName,
      status: "pending",
      createdAt: Date.now(),
    };
    this.runs.set(record.runId, record);
    this.persist();
    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  update(runId: string, patch: Partial<RunRecord>): void {
    const r = this.runs.get(runId);
    if (r) { Object.assign(r, patch); this.persist(); }
  }
}

// ── Capability registry ────────────────────────────────────────────────────────

export interface CapabilityRecord {
  name: string;
  /** "builtin" = hardcoded in runtime; "yaml" / "typescript" = user-installed plugin */
  kind: "builtin" | "yaml" | "typescript";
  description?: string;
  sideEffect: string;
  estimateCents: number;
  installedAt: number;
  /** Only present for user-installed plugins */
  status?: "installed" | "enabled" | "disabled";
  version?: string;
  sourceHash?: string;
  secretRefs?: string[];
  /** Original YAML source — only present for legacy in-memory YAML installs */
  yaml?: string;
}

export class CapabilityRegistry {
  private caps = new Map<string, CapabilityRecord>();
  private plugins = new Map<string, CapabilityPlugin>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "capabilities.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as CapabilityRecord[];
      for (const c of raw) {
        this.caps.set(c.name, c);
        // Re-load YAML plugins from their saved yaml
        if (c.kind === "yaml" && c.yaml) {
          this.reloadYaml(c.name, c.yaml).catch(err => log.warn({ err, name: c.name }, "failed to reload yaml capability"));
        }
      }
    } catch (err) {
      log.warn({ err }, "failed to load capabilities.json — starting fresh");
    }
  }

  private async reloadYaml(name: string, yaml: string): Promise<void> {
    const result = loadYamlCapability(yaml, () => ({}));
    if (result.ok) {
      this.plugins.set(name, result.plugin);
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.caps.values()], null, 2));
  }

  installFromYaml(name: string, yaml: string): { ok: true; capability: CapabilityRecord } | { ok: false; error: string } {
    const result = loadYamlCapability(yaml, () => ({}));
    if (!result.ok) return { ok: false, error: result.errors.map(e => e.message).join("; ") };

    const record: CapabilityRecord = {
      name,
      kind: "yaml",
      status: "enabled",
      sideEffect: result.plugin.sideEffect,
      estimateCents: result.plugin.estimateCents({ nodeId: "", capability: name, input: {} }),
      installedAt: Date.now(),
      yaml,
    };
    this.caps.set(name, record);
    this.plugins.set(name, result.plugin);
    this.persist();
    log.info({ name }, "installed yaml capability");
    return { ok: true, capability: record };
  }

  registerBuiltin(plugin: CapabilityPlugin, description?: string): void {
    const record: CapabilityRecord = {
      name: plugin.name,
      kind: "builtin",
      description,
      sideEffect: plugin.sideEffect,
      estimateCents: plugin.estimateCents({ nodeId: "", capability: plugin.name, input: {} }),
      installedAt: Date.now(),
    };
    this.caps.set(plugin.name, record);
    this.plugins.set(plugin.name, plugin);
  }

  uninstall(name: string): { ok: true } | { ok: false; error: string } {
    if (!this.caps.has(name)) return { ok: false, error: `capability '${name}' not found` };
    if (this.caps.get(name)?.kind === "builtin") return { ok: false, error: "cannot uninstall builtin capabilities" };
    this.caps.delete(name);
    this.plugins.delete(name);
    this.persist();
    return { ok: true };
  }

  /** Merge a live plugin from the lifecycle service into the in-memory map. */
  registerPlugin(plugin: CapabilityPlugin, record: { kind: "yaml" | "typescript"; status: "installed" | "enabled" | "disabled"; version: string; sourceHash: string; secretRefs: ReadonlyArray<string>; installedAt: number; description?: string }): void {
    const cap: CapabilityRecord = {
      name: plugin.name,
      kind: record.kind,
      sideEffect: plugin.sideEffect,
      estimateCents: plugin.estimateCents({ nodeId: "", capability: plugin.name, input: {} }),
      installedAt: record.installedAt,
      status: record.status,
      version: record.version,
      sourceHash: record.sourceHash,
      secretRefs: [...record.secretRefs],
    };
    this.caps.set(plugin.name, cap);
    if (record.status === "enabled") this.plugins.set(plugin.name, plugin);
    this.persist();
  }

  /** Update a capability's status in the map (e.g. after enable/disable). */
  setCapabilityStatus(name: string, status: "installed" | "enabled" | "disabled", plugin?: CapabilityPlugin): void {
    const cap = this.caps.get(name);
    if (!cap) return;
    cap.status = status;
    if (status === "enabled" && plugin) {
      this.plugins.set(name, plugin);
    } else if (status !== "enabled") {
      this.plugins.delete(name);
    }
    this.persist();
  }

  list(): CapabilityRecord[] {
    return [...this.caps.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  buildSupervisor(): Supervisor {
    return new Supervisor(new Map(this.plugins));
  }
}

// ── KrelvanRuntime ─────────────────────────────────────────────────────────────

export interface RuntimeConfig {
  dataDir: string;
  port: number;
  /** Legacy: Anthropic API key. Superseded by llmProvider/llmApiKey but still honoured. */
  anthropicApiKey?: string;
  /** LLM provider: "anthropic" | "openai" | "ollama". Default: "anthropic". */
  llmProvider?: string;
  /** API key for the chosen provider. Falls back to anthropicApiKey for anthropic. */
  llmApiKey?: string;
  /** Base URL override for OpenAI-compatible or self-hosted endpoints. */
  llmBaseUrl?: string;
  /** Default model to use across all capabilities. Provider-appropriate defaults apply if absent. */
  llmModel?: string;
  /** Directory to auto-load YAML capabilities and mcp-servers.json from.
   *  Also used as the pluginsRoot for user-installed plugins. */
  capabilitiesDir?: string;
}

export class KrelvanRuntime {
  readonly store: SqliteLedgerStore;
  readonly agentRegistry: AgentRegistry;
  readonly runRegistry: RunRegistry;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly scheduleRegistry: ScheduleRegistry;
  readonly scheduler: Scheduler;
  readonly compiler: Compiler;
  private readonly ring: HmacKeyring;
  private readonly ownerSigner: ReturnType<HmacKeyring["addKey"]>;
  private readonly supervisorSigner: ReturnType<HmacKeyring["addKey"]>;
  private readonly config: RuntimeConfig;
  private readonly anthropicApiKey: string | null;
  private readonly llmProvider: string;
  private readonly llmApiKey: string | null;
  private readonly llmBaseUrl: string | undefined;
  private readonly pluginLifecycle: PluginLifecycleService;
  private readonly pluginRepository: SqlitePluginRepository;
  private readonly capsDir: string;
  private supervisor: Supervisor;
  private lastTs = 0;

  constructor(config: RuntimeConfig) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });

    this.ring = new HmacKeyring();
    this.ownerSigner = this.ring.addKey("owner", "krelvan-owner-secret", { epoch: 1, validFrom: 0, validUntil: null });
    this.supervisorSigner = this.ring.addKey("supervisor", "krelvan-sup-secret", { epoch: 1, validFrom: 0, validUntil: null });

    this.store = new SqliteLedgerStore(join(config.dataDir, "ledger.db"));
    this.agentRegistry = new AgentRegistry(config.dataDir);
    this.runRegistry = new RunRegistry(config.dataDir);
    this.capabilityRegistry = new CapabilityRegistry(config.dataDir);
    this.mcpRegistry = new McpRegistry();
    this.scheduleRegistry = new ScheduleRegistry(config.dataDir);
    this.scheduler = new Scheduler(this.scheduleRegistry, (agentId, scheduleId) =>
      this.startScheduledRun(agentId, scheduleId),
    );
    this.capsDir = resolvePath(config.capabilitiesDir ?? join(config.dataDir, "..", "capabilities"));
    mkdirSync(this.capsDir, { recursive: true });

    // Register builtins into capability registry
    this.registerBuiltinCapabilities();

    // Auto-load YAML capabilities + MCP from directory
    this.loadCapabilitiesDir(this.capsDir);

    // ── Plugin lifecycle wiring ──────────────────────────────────────────────
    this.pluginRepository = new SqlitePluginRepository(this.store.db);

    const secretBroker: SecretBrokerPort = {
      validateRefs(refs) {
        const missing = refs.filter(r => process.env[r] === undefined);
        return missing.length === 0 ? { ok: true } : { ok: false, missing };
      },
      resolve(ref) { return process.env[ref]; },
    };

    const factory = new PluginFactory(new Map<import("../core/plugins/types.js").PluginKind, import("../core/plugins/ports.js").PluginLoaderStrategy>([
      ["yaml", new YamlPluginLoader()],
      ["typescript", new TypeScriptPluginLoader()],
    ]));

    // Build initial supervisor from builtins already registered.
    // init() merges persisted-enabled plugins into the snapshot.
    const { supervisor, snapshotHandle } = Supervisor.create(
      new Map(this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>),
    );
    this.supervisor = supervisor;

    this.pluginLifecycle = new PluginLifecycleService({
      repository: this.pluginRepository,
      factory,
      snapshotHandle,
      broker: secretBroker,
      signer: this.ownerSigner,
      db: this.store.db,
      now: () => this.now(),
      pluginsRoot: this.capsDir,
    });

    // Compiler — built lazily per compile so knownAgents is always current.
    this.anthropicApiKey = config.anthropicApiKey ?? null;
    this.llmProvider = config.llmProvider ?? process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    this.llmApiKey = config.llmApiKey ?? config.anthropicApiKey ?? process.env["KRELVAN_LLM_API_KEY"] ?? process.env["KRELVAN_ANTHROPIC_KEY"] ?? null;
    this.llmBaseUrl = config.llmBaseUrl ?? process.env["KRELVAN_LLM_BASE_URL"];
    this.compiler = this.buildCompiler();
  }

  /** Async initialisation — must be called after constructor before serving requests. */
  async init(): Promise<void> {
    const secretBroker: SecretBrokerPort = {
      validateRefs(refs) {
        const missing = refs.filter(r => process.env[r] === undefined);
        return missing.length === 0 ? { ok: true } : { ok: false, missing };
      },
      resolve(ref) { return process.env[ref]; },
    };

    const factory = new PluginFactory(new Map<import("../core/plugins/types.js").PluginKind, import("../core/plugins/ports.js").PluginLoaderStrategy>([
      ["yaml", new YamlPluginLoader()],
      ["typescript", new TypeScriptPluginLoader()],
    ]));

    const activator = new PluginActivator({
      repository: this.pluginRepository,
      factory,
      broker: secretBroker,
      db: this.store.db,
      signer: this.ownerSigner,
      now: () => this.now(),
    });

    // Reload previously-enabled plugins from DB, merge into supervisor
    const restoredPlugins = await activator.loadAll();
    if (restoredPlugins.size > 0) {
      // Merge restored plugins into the live snapshot alongside builtins
      const combined = new Map<string, CapabilityPlugin>(
        this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>,
      );
      for (const [name, plugin] of restoredPlugins) {
        combined.set(name, plugin);
      }
      this.pluginLifecycle.setInitialSnapshot(combined);

      // Sync CapabilityRegistry so list() shows them
      const allRecords = this.pluginRepository.listEnabled();
      for (const rec of allRecords) {
        const plugin = restoredPlugins.get(rec.name);
        if (plugin) {
          this.capabilityRegistry.registerPlugin(plugin, {
            kind: rec.pluginKind,
            status: "enabled",
            version: rec.version,
            sourceHash: rec.sourceHash,
            secretRefs: rec.secretRefs,
            installedAt: rec.installedAt,
          });
        }
      }
      log.info({ count: restoredPlugins.size }, "restored enabled plugins from DB");
    }

    // Start the scheduler — arms all enabled schedules persisted from last run
    this.scheduler.start();
  }

  // ── Plugin management public API ───────────────────────────────────────────

  /**
   * Install a capability plugin from a file on disk.
   * The file must be inside capsDir (enforced by PluginLifecycleService).
   * version defaults to "1.0.0" if not provided.
   * On success, registers a metadata record in capabilityRegistry with status "installed".
   */
  async installPlugin(sourcePath: string, version = "1.0.0"): Promise<PluginInstallResult> {
    const owner = parseOwnerId("owner-demo");
    const result = await this.pluginLifecycle.install(sourcePath, version, owner);
    if (result.ok) {
      const rec = result.record;
      // Register a placeholder so list() shows this plugin with status "installed"
      const stub: CapabilityPlugin = {
        name: rec.name,
        sideEffect: "read",
        estimateCents: () => 0,
        invoke: async () => { throw new Error(`Plugin '${rec.name}' is installed but not enabled`); },
      };
      this.capabilityRegistry.registerPlugin(stub, {
        kind: rec.pluginKind,
        status: "installed",
        version: rec.version,
        sourceHash: rec.sourceHash,
        secretRefs: rec.secretRefs,
        installedAt: rec.installedAt,
      });
    }
    return result;
  }

  async enablePlugin(name: string): Promise<PluginEnableResult> {
    const owner = parseOwnerId("owner-demo");
    const result = await this.pluginLifecycle.enable(name, owner);
    if (result.ok) {
      // Sync metadata — the lifecycle service already swapped the supervisor snapshot.
      this.capabilityRegistry.setCapabilityStatus(name, "enabled");
    }
    return result;
  }

  async disablePlugin(name: string, reason?: string): Promise<PluginDisableResult> {
    const owner = parseOwnerId("owner-demo");
    const result = await this.pluginLifecycle.disable(name, owner, reason);
    if (result.ok) {
      this.capabilityRegistry.setCapabilityStatus(name, "disabled");
    }
    return result;
  }

  async uninstallPlugin(name: string): Promise<PluginUninstallResult> {
    const owner = parseOwnerId("owner-demo");
    const result = await this.pluginLifecycle.uninstall(name, owner);
    if (result.ok) {
      this.capabilityRegistry.uninstall(name);
    }
    return result;
  }

  /**
   * Install a plugin from uploaded file bytes.
   * Saves the file into capsDir, then calls installPlugin().
   * pluginKind must be "yaml" or "typescript".
   */
  async installPluginFromBytes(opts: {
    fileName: string;
    content: Buffer;
    version?: string;
  }): Promise<PluginInstallResult & { savedPath?: string }> {
    const safeFileName = opts.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = join(this.capsDir, safeFileName);
    try {
      writeFileSync(destPath, opts.content);
    } catch (err) {
      return { ok: false, error: "FILE_NOT_FOUND", detail: `Could not write plugin file: ${String(err)}` };
    }
    const result = await this.installPlugin(destPath, opts.version ?? "1.0.0");
    if (!result.ok) {
      // Clean up the written file on failure
      try { unlinkSync(destPath); } catch { /* ignore */ }
    }
    return result.ok ? { ...result, savedPath: destPath } : result;
  }

  private loadCapabilitiesDir(dir: string): void {
    const result = loadCapabilityDirectory(dir);

    for (const { plugin, source } of result.capabilities) {
      this.capabilityRegistry.registerBuiltin(plugin, `Loaded from ${source}`);
    }

    for (const { file, error } of result.errors) {
      log.warn({ file, error }, "capability file failed to load");
    }

    // JS/TS modules and MCP servers are async — load without blocking startup
    if (result.jsModulePaths.length > 0) {
      void this.loadJsCapabilities(result.jsModulePaths);
    }

    if (result.mcpConfigs.length > 0) {
      void this.connectMcpServers(result.mcpConfigs);
    }
  }

  private async loadJsCapabilities(paths: string[]): Promise<void> {
    const { loaded, errors } = await loadJsCapabilities(paths);
    for (const { plugin, source } of loaded) {
      this.capabilityRegistry.registerBuiltin(plugin, `JS module: ${source}`);
      log.info({ name: plugin.name, source }, "auto-loaded js/ts capability");
    }
    for (const { file, error } of errors) {
      log.warn({ file, error }, "js capability failed to load");
    }
  }

  private async connectMcpServers(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      const result = await this.mcpRegistry.connect(config);
      if (result.ok) {
        // Register MCP plugins into the capability registry
        const plugins = this.mcpRegistry.allPlugins();
        for (const plugin of plugins) {
          this.capabilityRegistry.registerBuiltin(plugin, `MCP: ${config.name}`);
        }
        log.info({ server: config.name, tools: result.tools }, "mcp server connected and tools registered");
      } else {
        log.warn({ server: config.name, error: result.error }, "mcp server failed to connect");
      }
    }
  }

  /** Connect an MCP server at runtime (via API). */
  async connectMcp(mcpConfig: McpServerConfig): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    const result = await this.mcpRegistry.connect(mcpConfig);
    if (!result.ok) return result;

    // Register new plugins from this server
    const allPlugins = this.mcpRegistry.allPlugins();
    for (const plugin of allPlugins) {
      this.capabilityRegistry.registerBuiltin(plugin, `MCP: ${mcpConfig.name}`);
    }
    return result;
  }

  /** Disconnect an MCP server at runtime. */
  async disconnectMcp(name: string): Promise<void> {
    await this.mcpRegistry.disconnect(name);
  }

  /**
   * Import a pre-authored manifest directly — no LLM involved.
   * Validates the manifest structurally, signs it with the owner key, and saves it.
   */
  importManifest(manifest: Manifest): { ok: true; agent: AgentRecord } | { ok: false; issues: string[] } {
    const issues = validateManifest(manifest);
    if (issues.length) return { ok: false, issues: issues.map(i => i.message) };

    const id = contentAddress(canonicalize(manifest as unknown));
    const now = this.now();
    const provenance = {
      intent: manifest.intent,
      principalKind: "owner" as const,
      principalId: "owner-import",
      compiledAt: now,
    };
    const signedPayload = contentAddress(canonicalize({ id, provenance }));
    const sig = this.ownerSigner.sign(signedPayload, now);
    const signed = { manifest, id, provenance, sig };
    const agent = this.agentRegistry.save(signed);
    return { ok: true, agent };
  }

  /**
   * Builder Agent — agentic compile loop.
   *
   * Attempts up to maxAttempts times:
   *   1. Propose manifest from intent
   *   2. Validate structurally + monotonicity
   *   3. If invalid, append the error list to the intent as feedback and retry
   *
   * On success: saves the agent and returns it.
   * On total failure: returns all attempts with their errors so the UI can show what went wrong.
   */
  /**
   * Build the allowed-capabilities list for the compiler from the live registry.
   * Builtins keep their hardcoded budget ceilings; enabled user plugins get a
   * generous default so the model can freely reference them.
   */
  private allowedCapabilities(): AllowedCapability[] {
    const BUILTIN_BUDGETS: Record<string, number> = {
      think: 2000, recall: 50, remember: 50, llm_route: 500,
      web_search: 500, compose: 500, telegram_send: 100, slack_send: 100,
      email_send: 100, http_get: 200, http_post: 200, text_transform: 50,
      notify_webhook: 100, delegate: 5000,
    };
    const result: AllowedCapability[] = [];
    for (const cap of this.capabilityRegistry.list()) {
      if (cap.status === "disabled") continue;
      result.push({
        name: cap.name,
        sideEffect: cap.sideEffect as SideEffectClass,
        maxBudgetCents: BUILTIN_BUDGETS[cap.name] ?? 500,
      });
    }
    return result;
  }

  async buildAgent(intent: string): Promise<{
    ok: true;
    agent: AgentRecord;
    attempts: number;
    warnings: string[];
  } | {
    ok: false;
    error: string;
    attempts: number;
    issues: string[];
  }> {
    const principal = {
      kind: "owner" as const,
      id: "owner-demo",
      allowedCapabilities: this.allowedCapabilities(),
      maxRunBudgetCents: 10_000,
    };

    const maxAttempts = 3;
    let lastIssues: string[] = [];
    let augmentedIntent = intent;

    // Rebuild compiler per buildAgent call so knownAgents reflects the current registry.
    const compiler = this.buildCompiler();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.info({ attempt, maxAttempts, intent: intent.slice(0, 80) }, "builder: compiling");

      const result = await compiler.compile(augmentedIntent, principal, this.now());

      if (result.ok) {
        const agent = this.agentRegistry.save(result.signed);
        log.info({ agentId: agent.id, attempt, name: agent.signed.manifest.name }, "builder: agent compiled successfully");

        // Bootstrap soul at version 0 only if no soul file exists yet (preserves any
        // soul already written by the identify plugin from a prior run).
        const existingSoul = loadSoul(agent.id);
        if (!existingSoul) {
          saveSoul(agent.id, {
            name: agent.signed.manifest.name,
            values: [],
            standingInstructions: [],
            version: 0,
          });
          log.info({ agentId: agent.id }, "builder: bootstrapped soul at version 0");
        }

        return {
          ok: true,
          agent,
          attempts: attempt,
          warnings: attempt > 1 ? [`Succeeded on attempt ${attempt} after self-correction`] : [],
        };
      }

      // Compile failed — collect issues and retry with feedback
      lastIssues = result.issues.map(i => `[${i.code}] ${i.message}`);
      log.warn({ attempt, issues: lastIssues }, "builder: compile failed, retrying with feedback");

      // Augment intent with error feedback so the model can self-correct
      augmentedIntent = [
        intent,
        "",
        `Previous attempt ${attempt} failed with these validation errors — fix them:`,
        ...lastIssues.map(e => `  - ${e}`),
      ].join("\n");
    }

    return {
      ok: false,
      error: `Failed to compile after ${maxAttempts} attempts`,
      attempts: maxAttempts,
      issues: lastIssues,
    };
  }

  /** Return runs for a specific agent. */
  getAgentRuns(agentId: string): RunRecord[] {
    return this.runRegistry.list().filter(r => r.agentId === agentId);
  }

  /** Read agent memory from disk (semantic facts + episodic log + soul). */
  getAgentMemory(agentId: string): {
    agentId: string;
    semantic: import("../core/memory/memory.js").SemanticFact[];
    episodic: import("../core/memory/memory.js").Episode[];
    soul: import("../core/memory/memory.js").Soul | null;
    counts: { semantic: number; episodic: number };
  } {
    const memDir = join(this.config.dataDir, "memory");
    const semanticPath = join(memDir, `${agentId}.semantic.json`);
    const episodicPath = join(memDir, `${agentId}.episodes.json`);

    let semantic: import("../core/memory/memory.js").SemanticFact[] = [];
    let episodic: import("../core/memory/memory.js").Episode[] = [];

    try {
      if (existsSync(semanticPath)) {
        semantic = JSON.parse(readFileSync(semanticPath, "utf8")) as import("../core/memory/memory.js").SemanticFact[];
      }
    } catch { /* return empty on corrupt file */ }

    try {
      if (existsSync(episodicPath)) {
        episodic = JSON.parse(readFileSync(episodicPath, "utf8")) as import("../core/memory/memory.js").Episode[];
      }
    } catch { /* return empty on corrupt file */ }

    const soul = loadSoul(agentId);

    return { agentId, semantic, episodic, soul, counts: { semantic: semantic.length, episodic: episodic.length } };
  }

  /** Clear agent memory from disk and record audit event in the ledger. */
  async clearAgentMemory(agentId: string): Promise<{ ok: boolean; clearedAt: number; semanticCount: number; episodicCount: number }> {
    const existing = this.getAgentMemory(agentId);
    const memDir = join(this.config.dataDir, "memory");
    const semanticPath = join(memDir, `${agentId}.semantic.json`);
    const episodicPath = join(memDir, `${agentId}.episodes.json`);

    try { mkdirSync(memDir, { recursive: true }); } catch { /* already exists */ }
    writeFileSync(semanticPath, "[]");
    writeFileSync(episodicPath, "[]");
    // Reset soul back to a clean version-0 bootstrap so it is never null after clear
    const agent = this.agentRegistry.get(agentId);
    saveSoul(agentId, {
      name: agent?.signed.manifest.name ?? agentId,
      values: [],
      standingInstructions: [],
      version: 0,
    });

    const clearedAt = Date.now();

    // Append audit event to the ledger under a synthetic "memory-clear" run scope
    const clearRunId = `mem-clear-${this.now()}-${agentId.slice(0, 8)}`;
    try {
      await this.store.append(
        {
          type: "RunStarted" as const,
          author: "owner",
          scope: { tenantId: "default", runId: clearRunId, branchId: "main" },
          payload: { manifest: `memory-clear:${agentId}`, agentId, semanticCount: existing.counts.semantic, episodicCount: existing.counts.episodic, clearedAt },
        },
        { ts: clearedAt, signer: this.ownerSigner },
      );
    } catch (err) {
      log.warn({ err, agentId }, "failed to write memory-clear audit event — memory still cleared");
    }

    log.info({ agentId, semanticCount: existing.counts.semantic, episodicCount: existing.counts.episodic }, "agent memory cleared");
    return { ok: true, clearedAt, semanticCount: existing.counts.semantic, episodicCount: existing.counts.episodic };
  }

  /**
   * List all pending HITL approvals across all halted runs.
   * Scans every halted run's ledger for open AwaitRequested events.
   */
  async listPendingApprovals(): Promise<PendingApproval[]> {
    const halted = this.runRegistry.list().filter(r => r.status === "halted");
    const results: PendingApproval[] = [];

    for (const run of halted) {
      const events = await this.store.readRun("default", run.runId);
      const resolved = new Set<string>();
      const awaits: PendingApproval[] = [];

      for (const e of events) {
        const pl = e.payload as Record<string, unknown>;
        if (e.type === "AwaitResolved") {
          const cid = pl["correlationId"] as string | undefined;
          if (cid) resolved.add(cid);
        }
        if (e.type === "AwaitRequested") {
          const cid = pl["correlationId"] as string | undefined;
          const cap = (pl["call"] as Record<string, unknown> | undefined)?.["capability"] as string | undefined;
          if (cid) {
            awaits.push({
              correlationId: cid,
              runId: run.runId,
              agentId: run.agentId,
              agentName: run.manifestName,
              nodeId: e.scope.nodeId ?? "unknown",
              capability: cap ?? "unknown",
              requestedAt: e.ts,
            });
          }
        }
      }

      for (const a of awaits) {
        if (!resolved.has(a.correlationId)) results.push(a);
      }
    }

    return results.sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /**
   * Resolve a pending approval — append AwaitResolved then resume the run.
   * decision: "approve" | "deny"
   */
  async resolveApproval(
    runId: string,
    correlationId: string,
    decision: "approve" | "deny",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const run = this.runRegistry.get(runId);
    if (!run) return { ok: false, error: "run not found" };
    if (run.status !== "halted") return { ok: false, error: `run is ${run.status}, not halted` };

    const agent = this.agentRegistry.get(run.agentId);
    if (!agent) return { ok: false, error: "agent not found for this run" };

    // Append AwaitResolved — this unblocks the kernel's halt check
    const appendResult = await this.store.append(
      {
        type: "AwaitResolved",
        scope: { tenantId: "default", runId, branchId: "main" },
        payload: { correlationId, decision },
        author: this.ownerSigner.descriptor.keyId,
      } satisfies NewEvent<Record<string, unknown>>,
      { ts: this.now(), signer: this.ownerSigner },
    );
    if (!appendResult.ok) {
      return { ok: false, error: `ledger append failed: ${appendResult.error.message}` };
    }

    log.info({ runId, correlationId, decision }, "approval resolved");

    if (decision === "deny") {
      // On deny: the kernel will see AwaitResolved(deny) → the engine's approve()
      // callback returns false for the already-park'd call, so the run halts again
      // at the same node. Mark it failed so it doesn't stay halted.
      this.runRegistry.update(runId, {
        status: "failed",
        finishedAt: this.now(),
        reason: `approval denied for correlation ${correlationId}`,
      });
      return { ok: true };
    }

    // On approve: resume execution asynchronously
    this.runRegistry.update(runId, { status: "running" });
    void this.executeRun(runId, agent.signed.manifest, {}, run.agentId);
    return { ok: true };
  }

  now(): number {
    // Simple monotonic clock — always >= previous value
    const raw = Date.now();
    this.lastTs = raw > this.lastTs ? raw : this.lastTs + 1;
    return this.lastTs;
  }

  get hasLlm(): boolean {
    return !!(this.llmApiKey) || this.llmProvider === "ollama";
  }

  /** Build a fresh Compiler with current agent registry injected into the model prompt. */
  private buildCompiler(): Compiler {
    const modelPort = this.hasLlm
      ? new AnthropicModel({
          apiKey: this.llmApiKey ?? "",
          allowedCapabilities: this.allowedCapabilities(),
          suggestedRunBudgetCents: 1000,
          knownAgents: this.agentRegistry.list().map((a) => ({
            id: a.signed.id,
            name: a.signed.manifest.name,
            intent: a.signed.manifest.intent,
          })),
          llmConfig: {
            provider: this.llmProvider as "anthropic" | "openai" | "ollama",
            apiKey: this.llmApiKey ?? undefined,
            baseUrl: this.llmBaseUrl,
          },
        })
      : new StubModelPort();
    return new Compiler(modelPort as import("../core/compiler/compiler.js").ModelPort, this.ownerSigner);
  }

  private registerBuiltinCapabilities(): void {
    // LLM + memory capabilities — always available, require KRELVAN_ANTHROPIC_KEY at invoke time
    this.capabilityRegistry.registerBuiltin(thinkCapability, "LLM reasoning node — calls Claude to think and produce a result");
    this.capabilityRegistry.registerBuiltin(recallCapability, "Read from agent semantic memory across runs");
    this.capabilityRegistry.registerBuiltin(rememberCapability, "Write episode to agent memory after a run");
    this.capabilityRegistry.registerBuiltin(identifyCapability, "Write or update agent soul (name, values, standing instructions) — identity-mutation");
    this.capabilityRegistry.registerBuiltin(llmRouteCapability, "Level 2 adaptive routing — LLM chooses next node at runtime");

    // Demo/builtin plugins — always available
    this.capabilityRegistry.registerBuiltin(webSearchCapability, "Web search via Brave API or LLM synthesis");
    this.capabilityRegistry.registerBuiltin(composeCapability, "Compose text via Claude haiku (brief, detailed, or bullet style)");
    this.capabilityRegistry.registerBuiltin(emailSendCapability, "Send email via Resend API or SMTP");
    this.capabilityRegistry.registerBuiltin(telegramSendCapability, "Send Telegram message via Bot API");
    this.capabilityRegistry.registerBuiltin(slackSendCapability, "Send Slack message via Incoming Webhook");

    this.capabilityRegistry.registerBuiltin(
      {
        name: "text_transform",
        sideEffect: "read",
        estimateCents: () => 2,
        async invoke(call) {
          const input = (call.input as Record<string, unknown>);
          const text = String(input["text"] ?? "");
          const op = String(input["op"] ?? "upper");
          const result = op === "lower" ? text.toLowerCase() : op === "upper" ? text.toUpperCase() : text.trim();
          return { output: { text: result }, claimedCostCents: 2 };
        },
      },
      "Transform text: upper, lower, trim",
    );

    this.capabilityRegistry.registerBuiltin(httpGetCapability, "Real HTTP GET — fetches a URL and returns the response body");
    this.capabilityRegistry.registerBuiltin(httpPostCapability, "Real HTTP POST — sends a request to an external URL");
    this.capabilityRegistry.registerBuiltin(notifyWebhookCapability, "POST a JSON payload to a webhook URL with optional HMAC signature");
  }

  /** Called by the scheduler when a schedule fires. Returns the new runId. */
  private async startScheduledRun(agentId: string, scheduleId: string): Promise<string> {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);

    const runId = `run-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const runRecord = this.runRegistry.create({
      agentId,
      runId,
      manifestName: agent.signed.manifest.name,
    });

    log.info({ runId, agentId, scheduleId }, "starting scheduled run");
    this.agentRegistry.updateLastRun(agentId, runId);
    void this.executeRun(runRecord.runId, agent.signed.manifest, {}, agentId);
    return runId;
  }

  /** Create a new schedule for an agent. */
  createSchedule(opts: {
    agentId: string;
    kind: "cron" | "interval";
    spec: string;
    label?: string;
  }): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
    const agent = this.agentRegistry.get(opts.agentId);
    if (!agent) return { ok: false, error: `agent ${opts.agentId} not found` };

    if (opts.kind === "cron") {
      const cronErr = validateCron(opts.spec);
      if (cronErr) return { ok: false, error: `invalid cron expression: ${cronErr}` };
    } else {
      const ms = parseInt(opts.spec);
      if (isNaN(ms) || ms < 60_000) return { ok: false, error: "interval must be at least 60000ms (1 minute)" };
    }

    const schedule: ScheduleRecord = {
      id: `sched-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
      agentId: opts.agentId,
      agentName: agent.signed.manifest.name,
      kind: opts.kind,
      spec: opts.spec,
      label: opts.label ?? opts.spec,
      enabled: true,
      createdAt: this.now(),
    };

    this.scheduleRegistry.create(schedule);
    this.scheduler.arm(schedule);
    log.info({ id: schedule.id, agentId: opts.agentId, kind: opts.kind, spec: opts.spec }, "schedule created");
    return { ok: true, schedule };
  }

  async executeRun(runId: string, manifest: Manifest, initialState: Record<string, string | number | boolean | null>, agentId?: string): Promise<void> {
    this.runRegistry.update(runId, { status: "running" });
    // Use the live supervisor — reflects any runtime enable/disable of plugins.
    const supervisor = this.supervisor;

    // Inject system keys so memory plugins know which agent and run they belong to.
    // These are prefixed with "_" to signal they are engine-injected, not user data.
    // manifest.seed provides static inputs the agent always needs (e.g. data URLs).
    // initialState overrides seed, so callers can still override at run-start.
    const enrichedState: Record<string, string | number | boolean | null> = {
      _agentId: agentId ?? manifest.name,
      _runId: runId,
      ...(manifest.seed ?? {}),
      ...initialState,
    };

    const engine = new Engine(manifest, "default", runId, {
      store: this.store,
      owner: this.ownerSigner,
      supervisor,
      supervisorSigner: this.supervisorSigner,
      now: () => this.now(),
      resolveManifest: async (manifestId: string) => {
        const agent = this.agentRegistry.get(manifestId);
        return agent ? agent.signed.manifest : null;
      },
    });

    try {
      const result = await engine.run({ initialState: enrichedState });
      this.runRegistry.update(runId, {
        status: result.status === "completed" ? "completed" : result.status === "halted" ? "halted" : "failed",
        finishedAt: Date.now(),
        spentCents: result.projection.budget.runSpentCents,
        reason: result.reason,
      });
      log.info({ runId, status: result.status, spentCents: result.projection.budget.runSpentCents }, "run finished");
    } catch (err) {
      log.error({ err, runId }, "run threw unexpectedly");
      this.runRegistry.update(runId, { status: "failed", finishedAt: Date.now(), reason: (err as Error).message });
    }
  }
}

// ── Stub model port (when no Anthropic key is configured) ──────────────────────

class StubModelPort {
  async propose(intent: string): Promise<import("../core/compiler/compiler.js").ManifestProposal> {
    // Returns a valid minimal manifest that exercises the full engine pipeline.
    // In production, replace with a real AnthropicModelAdapter.
    const name = intent.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-agent";
    return {
      version: 1,
      name,
      intent,
      entry: "main",
      runBudgetCents: 100,
      maxNodeVisits: 3,
      nodes: [
        { id: "main", role: "primary task", autonomy: "full", capabilities: [{ name: "compose", sideEffect: "read", budgetCents: 50 }] },
      ],
      edges: [],
    };
  }
}
