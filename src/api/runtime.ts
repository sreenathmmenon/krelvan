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
import { Supervisor, type CapabilityPlugin, type SupervisorSnapshotHandle } from "../core/capability/capability.js";
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
import { SecretStore } from "./secret-store.js";
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
import { SubprocessPluginLoader } from "../infrastructure/plugins/subprocess-plugin-loader.js";
import type { SecretBrokerPort, OwnerId, PluginInstallResult, PluginEnableResult, PluginDisableResult, PluginUninstallResult } from "../core/plugins/ports.js";
import { parseOwnerId } from "../core/plugins/ports.js";
import { join, resolve as resolvePath } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, unlinkSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import type { NewEvent } from "../core/ledger/event.js";

const log = getLogger("runtime");

/**
 * Choose the TypeScript-plugin loader (the sandbox mechanism). Default is the REAL
 * subprocess sandbox (separate process + Node permission model — no fs-write /
 * child_process / addons, scrubbed env). Set KRELVAN_PLUGIN_SANDBOX=worker to fall back
 * to the lighter worker_threads loader (thread isolation only) — e.g. environments
 * where spawning a child node isn't possible.
 */
function makeTsPluginLoader(): import("../core/plugins/ports.js").PluginLoaderStrategy {
  if (process.env["KRELVAN_PLUGIN_SANDBOX"] === "worker") return new TypeScriptPluginLoader();
  return new SubprocessPluginLoader();
}

function atomicWrite(dest: string, content: string): void {
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, dest);
}

/**
 * Load (or generate-and-persist) a per-install ledger signing secret. The ledger's
 * tamper-evidence is only as strong as this secret, so it must NOT be a shared repo
 * constant — each install gets its own random secret, stored chmod 600 in the data dir.
 * An explicit env override (KRELVAN_LEDGER_OWNER_SECRET / _SUPERVISOR_SECRET) wins, for
 * reproducible/multi-node deploys. Deterministic for tests via the seed param.
 */
function loadOrCreateSigningSecret(dataDir: string, role: "owner" | "supervisor"): string {
  const envKey = role === "owner" ? "KRELVAN_LEDGER_OWNER_SECRET" : "KRELVAN_LEDGER_SUPERVISOR_SECRET";
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const file = join(dataDir, `signing-${role}.key`);
  if (existsSync(file)) {
    try {
      const s = readFileSync(file, "utf8").trim();
      if (s) return s;
    } catch { /* fall through to regenerate */ }
  }
  const secret = createHash("sha256").update(`${role}:${randomBytes(32).toString("hex")}`).digest("hex");
  try {
    writeFileSync(file, secret, "utf8");
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  } catch { /* if we can't persist, the secret rotates on restart — still better than a constant */ }
  return secret;
}

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
    atomicWrite(this.path, JSON.stringify([...this.agents.values()], null, 2));
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
      { name: "remember",       sideEffect: "write-reversible",  maxBudgetCents: 50   },
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
    atomicWrite(this.path, JSON.stringify([...this.runs.values()], null, 2));
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
  /** Compiler guidance: when should the compiler choose this capability. */
  useWhen?: string;
  /** Compiler guidance: extra notes (e.g. required seed keys, input format). */
  notes?: string;
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
  // Resolves {{secret:NAME}} at invoke time. Defaults to env; the runtime points it
  // at the customer's SecretStore so UI-set secrets reach installed YAML capabilities.
  private resolveSecret: (name: string) => string | undefined = (name) => process.env[name];

  constructor(dataDir: string) {
    this.path = join(dataDir, "capabilities.json");
    this.load();
  }

  /** Point secret resolution at the customer secret store (called by the runtime). */
  setSecretResolver(fn: (name: string) => string | undefined): void {
    this.resolveSecret = fn;
    // re-bind already-loaded YAML plugins so they use the new resolver
    for (const c of this.caps.values()) {
      if (c.kind === "yaml" && c.yaml) {
        void this.reloadYaml(c.name, c.yaml);
      }
    }
  }

  private secretResolverFor() {
    return (refs: string[]) => {
      const out: Record<string, string> = {};
      for (const ref of refs) {
        const v = this.resolveSecret(ref);
        if (v !== undefined) out[ref] = v;
      }
      return out;
    };
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
    const result = loadYamlCapability(yaml, this.secretResolverFor());
    if (result.ok) {
      this.plugins.set(name, result.plugin);
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.caps.values()], null, 2));
  }

  installFromYaml(name: string, yaml: string): { ok: true; capability: CapabilityRecord } | { ok: false; error: string } {
    const result = loadYamlCapability(yaml, this.secretResolverFor());
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

  registerBuiltin(plugin: CapabilityPlugin, meta: string | { description?: string; useWhen?: string; notes?: string }, secretRefs?: ReadonlyArray<string>): void {
    const m = typeof meta === "string" ? { description: meta } : meta;
    const record: CapabilityRecord = {
      name: plugin.name,
      kind: "builtin",
      description: m.description,
      useWhen: m.useWhen,
      notes: m.notes,
      sideEffect: plugin.sideEffect,
      estimateCents: plugin.estimateCents({ nodeId: "", capability: plugin.name, input: {} }),
      installedAt: Date.now(),
      ...(secretRefs && secretRefs.length ? { secretRefs: [...secretRefs] } : {}),
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

  /** Return a capability's source for viewing. YAML caps expose their YAML text;
   *  built-ins and TS plugins are not editable here (source lives on disk / in core). */
  getSource(name: string): { ok: true; kind: string; editable: boolean; content: string } | { ok: false; error: string } {
    const cap = this.caps.get(name);
    if (!cap) return { ok: false, error: `capability '${name}' not found` };
    if (cap.kind === "yaml" && cap.yaml) {
      return { ok: true, kind: "yaml", editable: true, content: cap.yaml };
    }
    if (cap.kind === "builtin") {
      return { ok: true, kind: "builtin", editable: false, content: `# "${name}" is a built-in capability.\n# ${cap.description ?? ""}\n# Built-ins ship with Krelvan and are not edited here.` };
    }
    return { ok: true, kind: cap.kind, editable: false, content: `# "${name}" is a ${cap.kind} plugin.\n# TypeScript plugins are viewed/edited as files; not editable in-browser.` };
  }

  /** Update a YAML capability's source in place: validate → swap plugin → persist. */
  updateYaml(name: string, yaml: string): { ok: true; capability: CapabilityRecord } | { ok: false; error: string } {
    const cap = this.caps.get(name);
    if (!cap) return { ok: false, error: `capability '${name}' not found` };
    if (cap.kind !== "yaml") return { ok: false, error: `only YAML capabilities can be edited here (this is ${cap.kind})` };
    const result = loadYamlCapability(yaml, this.secretResolverFor());
    if (!result.ok) return { ok: false, error: result.errors.map(e => e.message).join("; ") };
    const updated: CapabilityRecord = {
      ...cap,
      sideEffect: result.plugin.sideEffect,
      estimateCents: result.plugin.estimateCents({ nodeId: "", capability: name, input: {} }),
      yaml,
    };
    this.caps.set(name, updated);
    this.plugins.set(name, result.plugin);
    this.persist();
    log.info({ name }, "updated yaml capability");
    return { ok: true, capability: updated };
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
  readonly secretStore: SecretStore;
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
  private supervisorSnapshotHandle!: SupervisorSnapshotHandle;
  private lastTs = 0;
  // In-flight resolve guards: runIds currently being resolved.
  // Prevents a double-approve race where two concurrent HTTP calls both pass
  // the status===halted check before either updates the registry.
  private readonly _resolvingApprovals = new Set<string>();

  constructor(config: RuntimeConfig) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });

    this.ring = new HmacKeyring();
    // Per-install random signing secrets (not a shared repo constant) — see
    // loadOrCreateSigningSecret. This is what makes the ledger's tamper-evidence real.
    this.ownerSigner = this.ring.addKey("owner", loadOrCreateSigningSecret(config.dataDir, "owner"), { epoch: 1, validFrom: 0, validUntil: null });
    this.supervisorSigner = this.ring.addKey("supervisor", loadOrCreateSigningSecret(config.dataDir, "supervisor"), { epoch: 1, validFrom: 0, validUntil: null });

    this.store = new SqliteLedgerStore(join(config.dataDir, "ledger.db"));
    this.agentRegistry = new AgentRegistry(config.dataDir);
    this.runRegistry = new RunRegistry(config.dataDir);
    this.capabilityRegistry = new CapabilityRegistry(config.dataDir);
    this.mcpRegistry = new McpRegistry();
    this.scheduleRegistry = new ScheduleRegistry(config.dataDir);
    this.secretStore = new SecretStore(config.dataDir);
    // installed YAML capabilities resolve {{secret:NAME}} from the customer secret store
    this.capabilityRegistry.setSecretResolver((name) => this.secretStore.resolve(name));
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

    const store = this.secretStore;
    const secretBroker: SecretBrokerPort = {
      validateRefs(refs) {
        // a secret is satisfied if it's set in the store OR present as an env var
        const missing = refs.filter(r => !store.has(r));
        return missing.length === 0 ? { ok: true } : { ok: false, missing };
      },
      resolve(ref) { return store.resolve(ref); },
    };

    const factory = new PluginFactory(new Map<import("../core/plugins/types.js").PluginKind, import("../core/plugins/ports.js").PluginLoaderStrategy>([
      ["yaml", new YamlPluginLoader()],
      ["typescript", makeTsPluginLoader()],
    ]));

    // Build initial supervisor from builtins already registered.
    // init() merges persisted-enabled plugins into the snapshot.
    const { supervisor, snapshotHandle } = Supervisor.create(
      new Map(this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>),
    );
    this.supervisor = supervisor;
    this.supervisorSnapshotHandle = snapshotHandle;

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
    const store = this.secretStore;
    const secretBroker: SecretBrokerPort = {
      validateRefs(refs) {
        // a secret is satisfied if it's set in the store OR present as an env var
        const missing = refs.filter(r => !store.has(r));
        return missing.length === 0 ? { ok: true } : { ok: false, missing };
      },
      resolve(ref) { return store.resolve(ref); },
    };

    const factory = new PluginFactory(new Map<import("../core/plugins/types.js").PluginKind, import("../core/plugins/ports.js").PluginLoaderStrategy>([
      ["yaml", new YamlPluginLoader()],
      ["typescript", makeTsPluginLoader()],
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

  installYamlCapability(name: string, yaml: string): { ok: true; capability: CapabilityRecord } | { ok: false; error: string } {
    const result = this.capabilityRegistry.installFromYaml(name, yaml);
    if (!result.ok) return result;
    // Update supervisor snapshot so the plugin is available for runs immediately.
    const allPlugins = new Map(this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>);
    this.supervisorSnapshotHandle.replaceSnapshot(allPlugins);
    return result;
  }

  /** View a capability's source (YAML caps return editable YAML). */
  getCapabilitySource(name: string) {
    return this.capabilityRegistry.getSource(name);
  }

  /** Edit a YAML capability's source online: validate → swap → refresh supervisor. */
  updateYamlCapability(name: string, yaml: string): { ok: true; capability: CapabilityRecord } | { ok: false; error: string } {
    const result = this.capabilityRegistry.updateYaml(name, yaml);
    if (!result.ok) return result;
    const allPlugins = new Map(this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>);
    this.supervisorSnapshotHandle.replaceSnapshot(allPlugins);
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
    // Resolve secrets lazily from the customer's secret store at invoke time.
    const result = loadCapabilityDirectory(dir, (name) => this.secretStore.resolve(name));

    for (const { plugin, source, secretRefs } of result.capabilities) {
      this.capabilityRegistry.registerBuiltin(plugin, `Loaded from ${source}`, secretRefs);
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
        estimateCents: cap.estimateCents,
        ...(cap.description ? { description: cap.description } : {}),
        ...(cap.useWhen ? { useWhen: cap.useWhen } : {}),
        ...(cap.notes ? { notes: cap.notes } : {}),
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

      // Pass the original `intent` as cleanIntent so retry feedback in augmentedIntent
      // never ends up stored as the user-facing manifest intent.
      const result = await compiler.compile(augmentedIntent, principal, this.now(), intent);

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
    // Guard against concurrent resolves — two simultaneous approvals for the same run
    // would both pass the status check above before either updates the registry.
    if (this._resolvingApprovals.has(runId)) return { ok: false, error: "approval already being resolved" };
    this._resolvingApprovals.add(runId);

    const agent = this.agentRegistry.get(run.agentId);
    if (!agent) return { ok: false, error: "agent not found for this run" };

    // Append AwaitResolved — this unblocks the kernel's halt check
    let appendResult: Awaited<ReturnType<typeof this.store.append>>;
    try {
      appendResult = await this.store.append(
        {
          type: "AwaitResolved",
          scope: { tenantId: "default", runId, branchId: "main" },
          payload: { correlationId, decision },
          author: this.ownerSigner.descriptor.keyId,
        } satisfies NewEvent<Record<string, unknown>>,
        { ts: this.now(), signer: this.ownerSigner },
      );
    } finally {
      this._resolvingApprovals.delete(runId);
    }
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

  // ── Secrets (customer-managed) ─────────────────────────────────────────────
  /** Public metadata for all set secrets, plus which are still needed by installed caps. */
  listSecrets(): { secrets: import("./secret-store.js").SecretMeta[]; required: { name: string; capability: string; set: boolean }[] } {
    const secrets = this.secretStore.list();
    // Gather secret refs declared by installed/enabled capabilities.
    const required: { name: string; capability: string; set: boolean }[] = [];
    const seen = new Set<string>();
    for (const cap of this.capabilityRegistry.list()) {
      const refs = cap.secretRefs ?? [];
      for (const ref of refs) {
        const key = `${ref}::${cap.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        required.push({ name: ref, capability: cap.name, set: this.secretStore.has(ref) });
      }
    }
    return { secrets, required };
  }

  setSecret(name: string, value: string): { ok: true; meta: import("./secret-store.js").SecretMeta } | { ok: false; error: string } {
    return this.secretStore.set(name, value);
  }

  deleteSecret(name: string): boolean {
    return this.secretStore.delete(name);
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
    this.capabilityRegistry.registerBuiltin(thinkCapability, {
      description: "Calls an LLM to reason, analyse, or make decisions — outputs thought + result.",
      useWhen: "any node that needs intelligence, analysis, summarisation, decision-making, or extraction from prior results",
    });
    this.capabilityRegistry.registerBuiltin(recallCapability, {
      description: "Reads this agent's semantic memory from past runs.",
      useWhen: "first node of any agent that should remember context or facts across multiple runs",
    });
    this.capabilityRegistry.registerBuiltin(rememberCapability, {
      description: "Writes facts and an episode diary entry to agent memory.",
      useWhen: "last node of any agent that should learn or accumulate knowledge over time",
    });
    this.capabilityRegistry.registerBuiltin(identifyCapability, {
      description: "Sets or updates the agent's identity: name, values, and standing instructions.",
      useWhen: "agents that need a persistent persona or standing rules governing all their runs",
    });
    this.capabilityRegistry.registerBuiltin(llmRouteCapability, {
      description: "LLM examines run state and chooses which node to go to next.",
      useWhen: "when the next step depends on the content of previous results (e.g. high vs low, found vs not found)",
    });
    this.capabilityRegistry.registerBuiltin(webSearchCapability, {
      description: "Searches the web and returns top results as text.",
      useWhen: "fetching current news, prices, facts, or any information not available from a known API URL",
      notes: "always add \"query\": \"<search topic>\" to the manifest seed field so the query is available at run start",
    });
    this.capabilityRegistry.registerBuiltin(composeCapability, {
      description: "Writes text via LLM given a topic and prior context — outputs polished prose or bullets.",
      useWhen: "drafting messages, summaries, reports, briefings, or any human-readable text output",
    });
    this.capabilityRegistry.registerBuiltin(emailSendCapability, {
      description: "Sends an email via Resend API or SMTP.",
      useWhen: "notifying a person by email; requires to, subject, body in run state",
    });
    this.capabilityRegistry.registerBuiltin(telegramSendCapability, {
      description: "Sends a Telegram message via Bot API.",
      useWhen: "real-time notifications or alerts to a Telegram user or group",
    });
    this.capabilityRegistry.registerBuiltin(slackSendCapability, {
      description: "Posts a message to Slack via Incoming Webhook.",
      useWhen: "team notifications, alerts, or digests to a Slack channel",
    });
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
      {
        description: "Pure text transformation: uppercase, lowercase, or trim whitespace.",
        useWhen: "simple text normalisation with no LLM needed",
      },
    );
    this.capabilityRegistry.registerBuiltin(httpGetCapability, {
      description: "Fetches a URL and returns the response body.",
      useWhen: "reading from a known API endpoint, RSS feed, or web page with a specific URL",
      notes:
        "Prefer ONE endpoint that returns the COMPLETE data you need in a single response. " +
        "Do NOT design 'fetch a list of IDs, then fetch each item' flows — run state holds only scalar values, " +
        "so a node cannot fan out over an array of URLs. Pick an API that returns full records directly. " +
        "Example: for Hacker News top stories use https://hn.algolia.com/api/v1/search?tags=front_page (returns titles, " +
        "points, authors and URLs in one call), NOT the firebaseio topstories endpoint (which returns only IDs).",
    });
    this.capabilityRegistry.registerBuiltin(httpPostCapability, {
      description: "Sends an HTTP POST request with a JSON body.",
      useWhen: "writing to an external API, submitting forms, or triggering webhooks",
    });
    this.capabilityRegistry.registerBuiltin(notifyWebhookCapability, {
      description: "POSTs a JSON event payload to a webhook URL.",
      useWhen: "notifying external systems (GitHub, Jira, PagerDuty, custom webhooks)",
    });
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
