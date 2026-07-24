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

import { HmacKeyring, Ed25519Keyring, generateEd25519Keypair, contentAddress, type Signer, type Verifier } from "../core/ledger/crypto.js";
import { SqliteLedgerStore } from "../core/ledger/sqlite-store.js";
import { Engine } from "../core/kernel/engine.js";
import { resetLLMClient, getLLMClient } from "../adapters/llm-client.js";
import { Supervisor, type CapabilityPlugin, type SupervisorSnapshotHandle } from "../core/capability/capability.js";
import { Compiler } from "../core/compiler/compiler.js";
import { getLogger } from "../core/observability/logger.js";
import type { LedgerStore } from "../core/ledger/store.js";
import { verify } from "../core/ledger/store.js";
import { validateManifest, fatalIssues, type Manifest } from "../core/manifest/manifest.js";
import { canonicalize } from "../core/ledger/canonical.js";
import type { SignedManifest, AllowedCapability } from "../core/compiler/compiler.js";
import type { SideEffectClass } from "../core/manifest/manifest.js";
import { loadYamlCapability } from "../core/extensions/yaml-capability.js";
import { AnthropicModel } from "../adapters/anthropic-model.js";
import { McpRegistry, type McpServerConfig } from "../core/mcp/mcp-client.js";
import { loadCapabilityDirectory, loadJsCapabilities } from "../core/capability/directory-loader.js";
import { Scheduler, ScheduleRegistry, validateCron, FAIL_STREAK_WARN, type ScheduleRecord, type OnMissed } from "./scheduler.js";
import { SecretStore } from "./secret-store.js";
import { TriggerStore } from "./trigger-store.js";
import { ArtifactStore } from "./artifact-store.js";
import { extractArtifact } from "./artifact-extractor.js";
import { uniqueSlug } from "./slug.js";
import { AdminAuth } from "./admin-auth.js";
import { thinkCapability } from "../core/plugins/think.js";
import { recallCapability, rememberCapability, identifyCapability, loadSoul, saveSoul } from "../core/plugins/memory-plugins.js";
import { ragIngestCapability, ragSearchCapability } from "../core/plugins/rag-plugins.js";
import { wikiIngestCapability, wikiQueryCapability } from "../core/plugins/wiki-plugins.js";
import { llmRouteCapability } from "../core/plugins/llm-route.js";
import { webSearchCapability, setSearchSecretResolver } from "../core/plugins/web-search.js";
import { composeCapability } from "../core/plugins/compose.js";
import { syntheticUsersCapability } from "../core/plugins/synthetic-users.js";
import { DelegatePlugin } from "../core/plugins/delegate-plugin.js";
import { buildTesterManifest } from "./tester-agent.js";
import { emailSendCapability, setEmailSecretResolver } from "../core/plugins/email-send.js";
import { telegramSendCapability, setTelegramSecretResolver } from "../core/plugins/telegram-send.js";
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
import { createHash, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto";
import type { NewEvent } from "../core/ledger/event.js";

const log = getLogger("runtime");

/**
 * Reserved secret names that hold in-app LLM model configuration. Stored in the encrypted
 * secret store (so a self-hoster can wire up a model from the UI), but hidden from the
 * user-facing Secrets list — they're managed through the dedicated /api/model surface.
 */
const MODEL_PROVIDER_SECRET = "KRELVAN_LLM_PROVIDER";
const MODEL_API_KEY_SECRET = "KRELVAN_LLM_API_KEY";
const MODEL_NAME_SECRET = "KRELVAN_LLM_MODEL";
const MODEL_BASE_URL_SECRET = "KRELVAN_LLM_BASE_URL";
const RESERVED_MODEL_SECRETS = new Set([MODEL_PROVIDER_SECRET, MODEL_API_KEY_SECRET, MODEL_NAME_SECRET, MODEL_BASE_URL_SECRET]);

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

/** Reserved SecretStore name for an agent's public site-key plaintext (encrypted at rest).
 *  Agent ids are content addresses ("sha256:…") — sanitize to the store's allowed name charset. */
function siteKeySecretName(agentId: string): string {
  return `__sitekey__${agentId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
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

/**
 * Load (or create) a per-install Ed25519 PKCS#8 private key PEM for a signing role.
 * The private key (chmod 600) and its public SPKI PEM are persisted side by side; the
 * public key is safe to publish so a third party can independently verify the ledger.
 * Env override: KRELVAN_LEDGER_OWNER_PRIVKEY / KRELVAN_LEDGER_SUPERVISOR_PRIVKEY (PEM).
 */
function loadOrCreateSigningKeypair(dataDir: string, role: "owner" | "supervisor"): string {
  const envKey = role === "owner" ? "KRELVAN_LEDGER_OWNER_PRIVKEY" : "KRELVAN_LEDGER_SUPERVISOR_PRIVKEY";
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.includes("PRIVATE KEY")) return fromEnv;

  const privFile = join(dataDir, `signing-${role}-ed25519.key`);
  const pubFile = join(dataDir, `signing-${role}-ed25519.pub`);
  if (existsSync(privFile)) {
    try {
      const pem = readFileSync(privFile, "utf8").trim();
      if (pem.includes("PRIVATE KEY")) return pem;
    } catch { /* fall through to regenerate */ }
  }
  const { privateKeyPem, publicKeyPem } = generateEd25519Keypair();
  try {
    writeFileSync(privFile, privateKeyPem, "utf8");
    try { chmodSync(privFile, 0o600); } catch { /* best-effort */ }
    writeFileSync(pubFile, publicKeyPem, "utf8"); // public half is publishable for third-party verify
  } catch { /* if we can't persist, the keypair rotates on restart — still asymmetric & per-install */ }
  return privateKeyPem;
}

/**
 * Which ledger-signing adapter to use.
 *  - Explicit `KRELVAN_LEDGER_SIGNING=ed25519|hmac` always wins.
 *  - Otherwise: a FRESH data dir defaults to Ed25519 (non-repudiable — the strong default the
 *    product's "anyone can verify" wedge promises, and what the homepage demonstrates).
 *  - An EXISTING HMAC data dir (it already has `signing-owner.key`) stays on HMAC, so the
 *    history it already signed keeps verifying. Switching it would make old events look tampered.
 */
function useAsymmetricSigning(dataDir: string): boolean {
  const explicit = process.env["KRELVAN_LEDGER_SIGNING"]?.toLowerCase();
  if (explicit === "ed25519") return true;
  if (explicit === "hmac") return false;
  // No explicit choice: keep an existing HMAC install on HMAC; default everything else to Ed25519.
  const hasPriorHmac = existsSync(join(dataDir, "signing-owner.key"));
  return !hasPriorHmac;
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
  /** Human description of what this node does (from the manifest node role). */
  nodeRole?: string;
  /** The actual proposed action — the field/value pairs the capability will act on (e.g. the
   *  email body + recipient, the message to post). So the operator approves WHAT, not just "send". */
  preview?: { label: string; value: string }[];
}

// ── Agent registry ─────────────────────────────────────────────────────────────

/**
 * The agent's PUBLIC surface config. Deny-by-default (AGENTS.md rule 9): every flag is off
 * until the owner flips it, so nothing is reachable off the admin panel by default.
 */
export interface AgentPublicConfig {
  /** master switch — the public profile/feed/ask routes 404 unless this is true. */
  enabled: boolean;
  /** expose the published-artifact feed on the public page. */
  showFeed: boolean;
  /** allow public chat turns via /ask (requires a site key). */
  chat: boolean;
  /** sha256 of the live site key (`pk_…`); absent = no key minted. Never the plaintext. */
  siteKeyHash?: string;
  /** if set, /ask only accepts requests whose Origin is in this allowlist (deny-by-default:
   *  an unlisted site can't embed the widget and drain runs). Unset = any origin (the widget
   *  is site-key-authed regardless; this is an extra, opt-in lock). */
  allowedOrigins?: string[];
}

export interface AgentRecord {
  id: string;
  signed: SignedManifest;
  createdAt: number;
  scheduleMs?: number;  // if set, run on this interval
  lastRunId?: string;
  /** Where this agent's output is delivered when a run completes (in addition to the Inbox). */
  deliverTo?: import("./delivery.js").DeliveryTarget[];
  /** Stable URL-safe public handle (used in /a/:slug). Assigned at save time. */
  slug?: string;
  /** Public-surface config. Absent/all-off = fully private (the default). */
  public?: AgentPublicConfig;
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
      // Backfill slugs for agents saved before slugs existed, so every agent has a stable
      // public handle. Deterministic within one load (uniqueSlug sees the growing taken-set).
      let backfilled = false;
      for (const a of this.agents.values()) {
        if (!a.slug) { a.slug = uniqueSlug(a.signed.manifest.name, this.takenSlugs(a.id)); backfilled = true; }
      }
      if (backfilled) this.persist();
      log.info({ count: this.agents.size }, "loaded agents from disk");
    } catch (err) {
      log.warn({ err }, "failed to load agents.json — starting fresh");
    }
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify([...this.agents.values()], null, 2));
  }

  save(signed: SignedManifest): AgentRecord {
    // Re-importing the same manifest (same content-address id) keeps its existing slug so a
    // public URL stays stable; a new agent gets a fresh unique slug from its name.
    const existing = this.agents.get(signed.id);
    const slug = existing?.slug ?? uniqueSlug(signed.manifest.name, this.takenSlugs(signed.id));
    const record: AgentRecord = { id: signed.id, signed, createdAt: existing?.createdAt ?? Date.now(), slug, ...(existing?.public ? { public: existing.public } : {}) };
    this.agents.set(record.id, record);
    this.persist();
    return record;
  }

  /** The set of slugs in use, excluding one agent id (so re-saving doesn't collide with itself). */
  private takenSlugs(exceptId?: string): Set<string> {
    const s = new Set<string>();
    for (const a of this.agents.values()) if (a.slug && a.id !== exceptId) s.add(a.slug);
    return s;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Look up an agent by its public slug (for the /api/public/agents/:slug routes). */
  getBySlug(slug: string): AgentRecord | undefined {
    for (const a of this.agents.values()) if (a.slug === slug) return a;
    return undefined;
  }

  /**
   * Set an agent's public config. Deny-by-default is enforced by the caller passing the full
   * desired state; this just persists it. Returns the updated record, or undefined if absent.
   */
  setPublicConfig(agentId: string, cfg: AgentPublicConfig): AgentRecord | undefined {
    const a = this.agents.get(agentId);
    if (!a) return undefined;
    a.public = cfg;
    this.persist();
    return a;
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  updateLastRun(agentId: string, runId: string): void {
    const a = this.agents.get(agentId);
    if (a) { a.lastRunId = runId; this.persist(); }
  }

  /** Set where this agent's output is delivered when a run completes. */
  setDeliverTo(agentId: string, targets: import("./delivery.js").DeliveryTarget[]): boolean {
    const a = this.agents.get(agentId);
    if (!a) return false;
    a.deliverTo = targets;
    this.persist();
    return true;
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
    ];
  }
}

// ── Run registry ───────────────────────────────────────────────────────────────

export type RunStatus = "pending" | "running" | "completed" | "failed" | "halted";

/** How a run was started. Powers the schedule-history view and the "from schedule" chip. */
export interface RunOrigin {
  kind: "manual" | "schedule" | "trigger" | "public-ask";
  /** present when kind === "schedule": which schedule fired this run. */
  scheduleId?: string;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  manifestName: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
  spentCents?: number;
  reason?: string;
  /** How the run was started. "chat" runs are conversation turns — they must NOT appear in
   *  the Inbox (which shows deliverable agent output, not chat replies). Default: a normal run. */
  kind?: "run" | "chat";
  /** How the run was triggered (manual/schedule/trigger/public-ask). Absent = manual (no
   *  migration needed — old records render as manual). */
  origin?: RunOrigin;
  /** sha256 hex of the live "share this run" token; absent = private. Mirrors the artifact
   *  share model — only the hash is stored, minting rotates, and resolve is constant-time. */
  shareTokenHash?: string;
  /** the plain-English one-pager, generated once at share time and cached so the public page
   *  needs no LLM and shows a stable explanation. */
  sharedExplanation?: string;
  /** when the one-pager was generated (ms). */
  sharedAt?: number;
  /** Cached private Explain result. It is valid only for explanationEventId, so a running
   *  run cannot serve a stale explanation after more signed events arrive. */
  explanation?: string;
  explanationGeneratedAt?: number;
  explanationEventId?: string;
  explanationSource?: "model" | "signed-record";
  explanationWarning?: string;
  /** true when this run is a REHEARSAL: it ran the real engine against a synthetic world (no real
   *  side effects). Rehearsal runs never enter the Inbox or the public feed and are never
   *  delivered — they exist to be inspected, not shipped. */
  rehearsal?: boolean;
  /** groups the persona-runs of a single rehearsal together (one rehearsal → N persona runs). */
  rehearsalId?: string;
  /** the persona this rehearsal run exercised (its name/label), for the report. */
  personaName?: string;
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

  create(opts: {
    agentId: string; runId: string; manifestName: string; kind?: "run" | "chat"; origin?: RunOrigin;
    rehearsal?: boolean; rehearsalId?: string; personaName?: string;
  }): RunRecord {
    const record: RunRecord = {
      runId: opts.runId,
      agentId: opts.agentId,
      manifestName: opts.manifestName,
      status: "pending",
      createdAt: Date.now(),
      kind: opts.kind ?? "run",
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.rehearsal ? { rehearsal: true } : {}),
      ...(opts.rehearsalId ? { rehearsalId: opts.rehearsalId } : {}),
      ...(opts.personaName ? { personaName: opts.personaName } : {}),
    };
    this.runs.set(record.runId, record);
    this.persist();
    return record;
  }

  /** All persona-runs of one rehearsal, in creation order. */
  listByRehearsal(rehearsalId: string): RunRecord[] {
    return [...this.runs.values()]
      .filter(r => r.rehearsalId === rehearsalId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Runs fired by a specific schedule, newest-first (for the schedule-history view). */
  listBySchedule(scheduleId: string, limit = 20): RunRecord[] {
    return [...this.runs.values()]
      .filter(r => r.origin?.kind === "schedule" && r.origin.scheduleId === scheduleId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** All runs, newest first. Chat runs (conversation turns) and REHEARSAL runs are excluded —
   *  neither is deliverable output, and a rehearsal is a synthetic dry-run that must never
   *  pollute the Inbox / runs list. */
  list(): RunRecord[] {
    return [...this.runs.values()].filter(r => r.kind !== "chat" && !r.rehearsal).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All halted runs, INCLUDING chat runs — a public-ask (chat-kind) turn that parks for approval
   *  must still surface in the admin Approvals page so the owner can release it. */
  listHalted(): RunRecord[] {
    return [...this.runs.values()].filter(r => r.status === "halted").sort((a, b) => b.createdAt - a.createdAt);
  }

  update(runId: string, patch: Partial<RunRecord>): void {
    const r = this.runs.get(runId);
    if (r) { Object.assign(r, patch); this.persist(); }
  }

  /** Remove a run record. Returns true if it existed. */
  delete(runId: string): boolean {
    const existed = this.runs.delete(runId);
    if (existed) this.persist();
    return existed;
  }

  /**
   * Mint (or rotate) a "share this run" link and cache the plain-English one-pager on the
   * record. Returns the PLAINTEXT token ONCE — only its hash is stored; minting again rotates
   * the link. Returns undefined if the run doesn't exist. The one-pager is generated by the
   * caller and passed in, so the public page never needs an LLM.
   */
  mintShare(runId: string, explanation: string): string | undefined {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    const plaintext = randomBytes(32).toString("base64url");
    r.shareTokenHash = createHash("sha256").update(plaintext).digest("hex");
    r.sharedExplanation = explanation;
    r.sharedAt = Date.now();
    this.persist();
    return plaintext;
  }

  /** Revoke a run's share link (and drop the cached one-pager). Returns true if a link existed. */
  revokeShare(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || r.shareTokenHash === undefined) return false;
    delete r.shareTokenHash;
    delete r.sharedExplanation;
    delete r.sharedAt;
    this.persist();
    return true;
  }

  /** Resolve the shared run for a presented token, constant-time. Never short-circuits on the
   *  first mismatch (no timing signal). The caller projects it to the public shape. */
  resolveShare(token: string | undefined): RunRecord | undefined {
    if (!token) return undefined;
    const presented = Buffer.from(createHash("sha256").update(token).digest("hex"), "hex");
    let match: RunRecord | undefined;
    for (const r of this.runs.values()) {
      if (r.shareTokenHash === undefined) continue;
      const stored = Buffer.from(r.shareTokenHash, "hex");
      if (presented.length === stored.length && timingSafeEqual(presented, stored)) match = r;
    }
    return match;
  }

  /** Remove all terminal runs (completed / failed / halted), optionally only for one agent.
   *  Active runs (pending / running) are left untouched. Returns how many were removed. */
  clearTerminal(agentId?: string): number {
    let n = 0;
    for (const [id, r] of this.runs) {
      const terminal = r.status === "completed" || r.status === "failed" || r.status === "halted";
      if (terminal && (!agentId || r.agentId === agentId)) { this.runs.delete(id); n++; }
    }
    if (n > 0) this.persist();
    return n;
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
    // atomic (temp+rename) so a crash / kill -9 / full disk mid-write can't truncate the file
    // and silently wipe every installed capability on next boot (matches AgentRegistry/RunRegistry).
    atomicWrite(this.path, JSON.stringify([...this.caps.values()], null, 2));
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

  /** A fresh copy of the current plugin map — for sub-runs (delegate) that need the live set. */
  snapshot(): Map<string, CapabilityPlugin> {
    return new Map(this.plugins);
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
  /** Per-agent webhook trigger tokens (the inbound/interactive path). */
  readonly triggerStore: TriggerStore;
  /** Completed-run outputs as first-class, rendered, shareable artifacts (the consume side). */
  readonly artifactStore: ArtifactStore;
  /** Admin login (first-run setup + username/password + sessions). */
  readonly adminAuth: AdminAuth;
  readonly scheduler: Scheduler;
  readonly compiler: Compiler;
  private readonly ring: Verifier;
  private readonly ownerSigner: Signer;
  private readonly supervisorSigner: Signer;
  private readonly config: RuntimeConfig;
  private readonly anthropicApiKey: string | null;
  /** Constructor/env-provided defaults. In-app config (stored as reserved secrets) overrides these. */
  private readonly llmProviderDefault: string;
  private readonly llmApiKeyDefault: string | null;
  private readonly llmBaseUrlDefault: string | undefined;
  private readonly llmModelDefault: string | undefined;
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

    // Ledger signing adapter. Default: per-install HMAC (tamper-evident). Opt-in
    // KRELVAN_LEDGER_SIGNING=ed25519 → asymmetric, NON-REPUDIABLE: the public key is
    // published so an auditor/regulator/counterparty can verify the ledger without ever
    // being able to forge it. Both are per-install (never a shared repo constant).
    const window_ = { epoch: 1, validFrom: 0, validUntil: null };
    if (useAsymmetricSigning(config.dataDir)) {
      // Footgun guard: switching an EXISTING HMAC-signed data dir to Ed25519 leaves the prior
      // events signed with HMAC under the same keyId/epoch — the Ed25519 verifier can't check
      // them, so they'd read as "tampered". Detect the switch (an old HMAC key file present)
      // and warn loudly; the right move is a fresh data dir for Ed25519. New events sign fine.
      if (existsSync(join(config.dataDir, "signing-owner.key"))) {
        log.warn({}, "KRELVAN_LEDGER_SIGNING=ed25519 enabled on a data dir that previously used HMAC signing. Events written before this switch were signed with HMAC and will FAIL Ed25519 verification (they will look tampered). Use a FRESH data dir for Ed25519, or expect historical runs to show 'verification failed'. New runs are unaffected.");
      }
      const ring = new Ed25519Keyring();
      this.ownerSigner = ring.addKey("owner", loadOrCreateSigningKeypair(config.dataDir, "owner"), window_);
      this.supervisorSigner = ring.addKey("supervisor", loadOrCreateSigningKeypair(config.dataDir, "supervisor"), window_);
      this.ring = ring;
      log.info({ signing: "ed25519", ownerPub: ring.exportPublicKey("owner", 1).split("\n")[1]?.slice(0, 16) }, "ledger signing: asymmetric Ed25519 (non-repudiable)");
    } else {
      const ring = new HmacKeyring();
      this.ownerSigner = ring.addKey("owner", loadOrCreateSigningSecret(config.dataDir, "owner"), window_);
      this.supervisorSigner = ring.addKey("supervisor", loadOrCreateSigningSecret(config.dataDir, "supervisor"), window_);
      this.ring = ring;
    }

    this.store = new SqliteLedgerStore(join(config.dataDir, "ledger.db"));
    this.agentRegistry = new AgentRegistry(config.dataDir);
    this.runRegistry = new RunRegistry(config.dataDir);
    this.capabilityRegistry = new CapabilityRegistry(config.dataDir);
    this.scheduleRegistry = new ScheduleRegistry(config.dataDir);
    this.secretStore = new SecretStore(config.dataDir);
    this.triggerStore = new TriggerStore(config.dataDir);
    this.artifactStore = new ArtifactStore(config.dataDir);
    this.adminAuth = new AdminAuth(config.dataDir);
    // MCP servers resolve their {{secret:NAME}} env refs from the encrypted secret store;
    // the child gets a scrubbed env (never Krelvan's own secrets).
    this.mcpRegistry = new McpRegistry((name) => this.secretStore.resolve(name));
    // installed YAML capabilities resolve {{secret:NAME}} from the customer secret store
    this.capabilityRegistry.setSecretResolver((name) => this.secretStore.resolve(name));
    // The telegram_send builtin reads KRELVAN_TELEGRAM_TOKEN/CHAT_ID; route those through
    // the encrypted SecretStore so a UI-connected Telegram works with no env var / restart.
    setTelegramSecretResolver((name) => this.secretStore.resolve(name));
    setEmailSecretResolver((name) => this.secretStore.resolve(name));
    // web_search resolves its search-provider key (Brave/Tavily/Serper/… — the customer's choice)
    // through the same encrypted SecretStore, so a customer configures search in the UI with no
    // env var or restart. Falls back to env for a platform default.
    setSearchSecretResolver((name) => this.secretStore.resolve(name));
    this.scheduler = new Scheduler(
      this.scheduleRegistry,
      (agentId, scheduleId) => this.startScheduledRun(agentId, scheduleId),
      {
        // When a schedule fails repeatedly, tell the owner through the agent's existing
        // delivery targets (best-effort, detached) so a broken schedule can't fail silently.
        notifyFailure: (schedule, reason) => {
          const agent = this.agentRegistry.get(schedule.agentId);
          if (!agent?.deliverTo?.length) return;
          const body = `Your schedule "${schedule.label}" has failed ${FAIL_STREAK_WARN} times in a row.` +
            (reason ? ` Latest reason: ${reason}` : "") +
            ` It is still scheduled — check the agent's configuration.`;
          void this.deliverOutput(agent.deliverTo, agent.signed.manifest.name, schedule.lastRunId ?? "schedule", `Schedule "${schedule.label}" is failing`, body);
        },
      },
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
    this.llmProviderDefault = config.llmProvider ?? process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    this.llmApiKeyDefault = config.llmApiKey ?? config.anthropicApiKey ??
      process.env["KRELVAN_LLM_API_KEY"] ??
      (this.llmProviderDefault === "openai" ? process.env["OPENAI_API_KEY"] : undefined) ??
      (this.llmProviderDefault === "anthropic" ? process.env["KRELVAN_ANTHROPIC_KEY"] : undefined) ??
      null;
    this.llmBaseUrlDefault = config.llmBaseUrl ?? process.env["KRELVAN_LLM_BASE_URL"];
    this.llmModelDefault = config.llmModel ?? process.env["KRELVAN_LLM_MODEL"];
    // SecretStore loads synchronously above. Mirror its effective model connection into
    // the process environment before any built-in capability can create the shared client.
    // This also makes an in-app connection survive a process restart.
    this.syncEffectiveModelConfigToEnv();
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

  /**
   * Ledger signing info for verification clients. In ed25519 mode this returns the
   * PUBLIC keys (SPKI PEM) so a third party can independently verify the ledger without
   * any secret. In HMAC mode there is no publishable key (the verify key is the secret),
   * so only the algorithm is reported.
   */
  getLedgerSigningInfo(): {
    krelvanIssuerKeyring: 1;
    issuerId: string | null;
    algorithm: "ed25519" | "hmac-sha256";
    nonRepudiable: boolean;
    keys: { keyId: string; epoch: number; publicKeyPem: string; fingerprint: string }[];
  } {
    if (this.ring instanceof Ed25519Keyring) {
      const ring = this.ring;
      const keys = (["owner", "supervisor"] as const).map((keyId) => ({
        keyId,
        epoch: 1,
        publicKeyPem: ring.exportPublicKey(keyId, 1),
        fingerprint: `sha256:${createHash("sha256")
          .update(createPublicKey(ring.exportPublicKey(keyId, 1)).export({ type: "spki", format: "der" }))
          .digest("hex")}`,
      }));
      const issuerId = `sha256:${createHash("sha256")
        .update(keys.map((key) => `${key.keyId}#${key.epoch}:${key.fingerprint}`).sort().join("\n"), "utf8")
        .digest("hex")}`;
      return { krelvanIssuerKeyring: 1, issuerId, algorithm: "ed25519", nonRepudiable: true, keys };
    }
    return { krelvanIssuerKeyring: 1, issuerId: null, algorithm: "hmac-sha256", nonRepudiable: false, keys: [] };
  }

  /**
   * Re-verify the full signed event chain of a run — the strongest "prove what happened"
   * surface. Re-folds the ledger events and runs verify() against the active keyring
   * (HMAC or Ed25519): checks hash-chaining, contiguous offsets, content-addresses, and
   * every signature. Returns ok + a per-event signed count, or the first corruption found.
   */
  async verifyRun(runId: string): Promise<{ ok: true; runEvents: number; signedEvents: number; ledgerEvents: number; algorithm: string; nonRepudiable: boolean; issuerId: string | null } | { ok: false; error: string; detail: string }> {
    // The ledger is ONE hash-chained log per tenant (offsets are global, not per-run).
    // Verifying the run therefore means verifying the whole chain it lives in — a stronger
    // guarantee than a per-run slice: it proves the run's events sit in an intact,
    // untampered, signed history with no gaps, reordering, or forged signatures.
    const all = await this.store.read("default");
    const runEvents = all.filter((e) => e.scope.runId === runId);
    if (runEvents.length === 0) return { ok: false, error: "NOT_FOUND", detail: `no events for run ${runId}` };
    const result = verify(all, this.ring);
    const algorithm = this.ring instanceof Ed25519Keyring ? "ed25519" : "hmac-sha256";
    if (!result.ok) return { ok: false, error: result.error.kind, detail: result.error.message };
    return {
      ok: true,
      runEvents: runEvents.length,
      signedEvents: runEvents.filter((e) => e.sig).length,
      ledgerEvents: all.length,
      algorithm,
      issuerId: this.getLedgerSigningInfo().issuerId,
      // Ed25519 = non-repudiable (a public key proves it; the signer can't deny it). HMAC =
      // tamper-EVIDENT but repudiable (the same per-install secret signs and verifies). The UI
      // must not call the HMAC default "tamper-proof".
      nonRepudiable: algorithm === "ed25519",
    };
  }

  /**
   * Export a run as a portable, self-verifiable proof bundle — the payoff of the whole
   * "prove what they did" wedge. A third party can re-check it offline with `npx krelvan
   * verify <file>` (or the bundled bin/krelvan-verify.mjs), recomputing every content
   * address and signature against the included public keys WITHOUT trusting this instance.
   *
   * The bundle is the run's own event slice (every causal step), each carrying the exact
   * preimage fields the content-address is computed over, its id, and its signature — plus
   * the Ed25519 public keys (for HMAC, signatures are instance-local and the bundle says so).
   */
  async exportRun(runId: string): Promise<{ ok: true; bundle: Record<string, unknown> } | { ok: false; error: string }> {
    const all = await this.store.read("default");
    const runEvents = all.filter((e) => e.scope.runId === runId);
    if (runEvents.length === 0) return { ok: false, error: `no events for run ${runId}` };
    const signing = this.getLedgerSigningInfo();
    const verification = await this.verifyRun(runId);

    const events = runEvents.map((e) => ({
      // exactly the preimage fields (LED-03) the id is computed over — order-independent;
      // the verifier canonicalizes (sorted keys) before hashing.
      type: e.type,
      scope: {
        tenantId: e.scope.tenantId,
        runId: e.scope.runId,
        ...(e.scope.nodeId !== undefined ? { nodeId: e.scope.nodeId } : {}),
        branchId: e.scope.branchId,
      },
      parents: [...e.parents],
      prev: e.prev,
      offset: e.offset,
      payload: e.payload,
      determinism: e.determinism,
      ts: e.ts,
      author: e.author,
      // the derived/assigned fields the verifier recomputes and checks against:
      id: e.id,
      sig: e.sig,
    }));

    const bundle: Record<string, unknown> = {
      krelvanProofBundle: 1,
      runId,
      exportedAt: this.now(),
      algorithm: signing.algorithm,
      nonRepudiable: signing.nonRepudiable,
      issuer: {
        issuerId: signing.issuerId,
        keyFingerprints: signing.keys.map((key) => ({
          keyId: key.keyId,
          epoch: key.epoch,
          fingerprint: key.fingerprint,
        })),
        // A discovery hint is convenient, but never a trust anchor: authenticity still requires
        // the auditor to obtain/pin the keyring separately from the proof bundle.
        keyDiscoveryPath: "/api/ledger/keys",
      },
      // Public keys an auditor verifies against. Empty for HMAC (signatures are instance-local).
      publicKeys: signing.keys,
      verification: verification.ok
        ? { ok: true, runEvents: verification.runEvents, signedEvents: verification.signedEvents }
        : { ok: false, error: verification.error, detail: verification.detail },
      hashAlgorithm: "sha256",
      events,
      howToVerify: signing.algorithm === "ed25519"
        ? "First obtain the issuer keyring independently from GET /api/ledger/keys and save it. Run `npx krelvan verify <this-file> --keyring <issuer-keyring.json>` for origin-authenticated verification. Running without --keyring checks internal consistency only and must not be treated as proof of origin."
        : "This instance signs with HMAC-SHA256, which is tamper-EVIDENT but instance-local: the verify key is the sign key, so an outside party cannot independently verify it. For non-repudiable proof a third party can check, run this instance with Ed25519 signing (KRELVAN_LEDGER_SIGNING=ed25519).",
    };
    return { ok: true, bundle };
  }

  /**
   * Install a TEMPLATE — a whole pre-built agent: a signed manifest plus the YAML
   * capabilities it needs. This is the "install a working agent in one click" path that
   * turns the marketplace from a catalogue of parts into a catalogue of finished agents.
   *
   * Steps (each idempotent / best-effort so a partial state is recoverable):
   *   1. Install each bundled YAML capability the template ships (skip if already present).
   *   2. Import + sign the manifest as a new agent (reuses importManifest's validation).
   *   3. Report which declared secrets are still unset, so the UI can prompt for them.
   *
   * The manifest is validated and signed exactly like any imported agent — the template
   * cannot smuggle in an unvalidated graph.
   */
  installTemplate(template: {
    manifest: Manifest;
    capabilities?: { name: string; yaml: string }[];
    secretRefs?: string[];
  }): { ok: true; agent: AgentRecord; installedCapabilities: string[]; missingSecrets: string[] } | { ok: false; error: string; issues?: string[] } {
    // 1) Install each YAML capability the template bundles (idempotent).
    const installedCapabilities: string[] = [];
    for (const cap of template.capabilities ?? []) {
      const existing = this.capabilityRegistry.list().find((c) => c.name === cap.name);
      if (existing) { installedCapabilities.push(cap.name); continue; }
      const r = this.installYamlCapability(cap.name, cap.yaml);
      if (!r.ok) return { ok: false, error: `capability '${cap.name}' failed to install: ${r.error}` };
      installedCapabilities.push(cap.name);
    }

    // 2) Import + sign the manifest as an agent — but DEDUPE first so re-installing the same
    //    template (even with a tweaked seed/query) UPDATES the existing agent instead of piling
    //    up duplicates. Two installs are "the same agent" when they share a name AND the same
    //    node/edge shape (the structure the user sees on the canvas); only seed values differ.
    //    This keeps the Agents list clean no matter how many times anyone re-installs or a test
    //    runs. An explicitly renamed clone (a different name) is intentionally kept separate.
    const shapeKey = (m: Manifest) =>
      `${m.name}::${m.nodes.map(n => `${n.id}:${n.capabilities.map(c => c.name).join(",")}`).join("|")}::${m.edges.map(e => `${e.from}>${e.to}`).join("|")}`;
    const incomingKey = shapeKey(template.manifest);
    const dup = this.agentRegistry.list().find(a => shapeKey(a.signed.manifest) === incomingKey);
    if (dup) {
      // Re-installing the same agent. Save the (possibly seed-tweaked) manifest, then remove the
      // prior record if its content-hash id changed — so exactly ONE card remains, always.
      const refreshed = this.importManifest(template.manifest);
      if (!refreshed.ok) return { ok: false, error: "invalid_manifest", issues: refreshed.issues };
      if (refreshed.agent.id !== dup.id) this.agentRegistry.delete(dup.id);
      log.info({ agentId: refreshed.agent.id, name: template.manifest.name }, "template re-install → updated existing agent (deduped)");
      return { ok: true, agent: refreshed.agent, installedCapabilities, missingSecrets: [...new Set(template.secretRefs ?? [])].filter((s) => !this.secretStore.has(s)) };
    }

    const imported = this.importManifest(template.manifest);
    if (!imported.ok) return { ok: false, error: "invalid_manifest", issues: imported.issues };

    // 3) Which declared secrets are still missing? (drives the "set these to finish" step)
    const missingSecrets = [...new Set(template.secretRefs ?? [])].filter((s) => !this.secretStore.has(s));

    // 4) If the manifest declares a schedule, auto-arm it so a "set it and forget it" agent
    //    (a price monitor, a daily digest) genuinely runs itself the moment it's installed.
    const sched = template.manifest.schedule;
    if (sched) {
      try {
        const rec = {
          id: `sched-${imported.agent.id.slice(0, 16)}-${this.now()}`,
          agentId: imported.agent.id,
          agentName: imported.agent.signed.manifest.name,
          kind: sched.kind,
          spec: sched.kind === "cron" ? sched.expr : String(sched.ms),
          label: `Auto-scheduled on install (${sched.kind === "cron" ? sched.expr : sched.ms + "ms"})`,
          enabled: true,
          createdAt: this.now(),
        };
        this.scheduleRegistry.create(rec);
        this.scheduler.arm(rec);
        log.info({ agentId: imported.agent.id, schedule: sched }, "template auto-scheduled on install");
      } catch (e) { log.warn({ err: (e as Error).message }, "could not auto-arm template schedule"); }
    }

    log.info(
      { agentId: imported.agent.id, name: imported.agent.signed.manifest.name, installedCapabilities, missingSecrets },
      "template installed",
    );
    return { ok: true, agent: imported.agent, installedCapabilities, missingSecrets };
  }

  // ── Plugin management public API ───────────────────────────────────────────

  /**
   * Install a capability plugin from a file on disk.
   * The file must be inside capsDir (enforced by PluginLifecycleService).
   * version defaults to "1.0.0" if not provided.
   * On success, registers a metadata record in capabilityRegistry with status "installed".
   */
  async installPlugin(sourcePath: string, version = "1.0.0", egressHosts?: ReadonlyArray<string>): Promise<PluginInstallResult> {
    const owner = parseOwnerId("owner-demo");
    const result = await this.pluginLifecycle.install(sourcePath, version, owner, egressHosts);
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
    egressHosts?: ReadonlyArray<string>;
  }): Promise<PluginInstallResult & { savedPath?: string }> {
    const safeFileName = opts.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = join(this.capsDir, safeFileName);
    try {
      writeFileSync(destPath, opts.content);
    } catch (err) {
      return { ok: false, error: "FILE_NOT_FOUND", detail: `Could not write plugin file: ${String(err)}` };
    }
    const result = await this.installPlugin(destPath, opts.version ?? "1.0.0", opts.egressHosts);
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

    // Register new plugins from this server, then refresh the supervisor snapshot so the
    // MCP tools are immediately admissible in runs (without this they exist in the
    // registry but admission says CAPABILITY_NOT_GRANTED).
    const allMcp = this.mcpRegistry.allPlugins();
    for (const plugin of allMcp) {
      this.capabilityRegistry.registerBuiltin(plugin, `MCP: ${mcpConfig.name}`);
    }
    const snapshot = new Map(this.capabilityRegistry["plugins"] as Map<string, CapabilityPlugin>);
    this.supervisorSnapshotHandle.replaceSnapshot(snapshot);
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
    const issues = fatalIssues(validateManifest(manifest));
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
   * Build a deterministic TESTER agent for a target agent (agent-tests-agent), one-click and with
   * no LLM assembly. Emits the fixed cast → delegate → judge → report graph pinned to the target's
   * id, then imports it. This is the reliable path — the LLM builder can drop nodes on weak models.
   */
  buildTesterAgent(targetId: string, count = 5): { ok: true; agent: AgentRecord } | { ok: false; error: string } {
    const target = this.agentRegistry.get(targetId);
    if (!target) return { ok: false, error: `agent ${targetId} not found` };
    const manifest = buildTesterManifest(
      { id: target.signed.id, name: target.signed.manifest.name, intent: target.signed.manifest.intent },
      count,
    );
    const res = this.importManifest(manifest);
    if (!res.ok) return { ok: false, error: res.issues.join("; ") };
    return { ok: true, agent: res.agent };
  }

  // ── Public surface (B1) ────────────────────────────────────────────────────────

  /**
   * Set an agent's public config (deny-by-default: caller sends the full desired state).
   * When chat is turned ON and no site key exists yet, a fresh site key is minted and its
   * PLAINTEXT is returned ONCE (only its hash is stored). Turning chat OFF clears the key,
   * so re-enabling later mints a new one. Returns the updated record + any one-time key.
   */
  setAgentPublic(
    agentId: string,
    desired: { enabled: boolean; showFeed: boolean; chat: boolean; allowedOrigins?: string[] },
  ): { ok: true; agent: AgentRecord; siteKey?: string } | { ok: false; error: string } {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { ok: false, error: "agent not found" };
    const prev = agent.public;
    const cfg: AgentPublicConfig = {
      enabled: desired.enabled, showFeed: desired.showFeed, chat: desired.chat,
      ...(desired.allowedOrigins && desired.allowedOrigins.length > 0 ? { allowedOrigins: desired.allowedOrigins } : {}),
    };
    let siteKey: string | undefined;
    if (desired.chat) {
      if (prev?.siteKeyHash) {
        cfg.siteKeyHash = prev.siteKeyHash; // keep the existing key when chat stays on
      } else {
        siteKey = this.mintAndStoreSiteKey(agentId);
        cfg.siteKeyHash = createHash("sha256").update(siteKey, "utf8").digest("hex");
      }
    } else {
      // chat off → drop the key entirely (any embedded widget stops working immediately).
      this.secretStore.delete(siteKeySecretName(agentId));
    }
    const updated = this.agentRegistry.setPublicConfig(agentId, cfg);
    if (!updated) return { ok: false, error: "agent not found" };
    return siteKey ? { ok: true, agent: updated, siteKey } : { ok: true, agent: updated };
  }

  /** Mint a fresh site key, store its plaintext ENCRYPTED (it's a public credential the
   *  storefront/widget re-serve), and return the plaintext. */
  private mintAndStoreSiteKey(agentId: string): string {
    const siteKey = `pk_${randomBytes(24).toString("base64url")}`;
    this.secretStore.set(siteKeySecretName(agentId), siteKey);
    return siteKey;
  }

  /** The live plaintext site key for an agent (for the public storefront/widget snippet), or
   *  undefined if chat isn't enabled. It is a deliberately-public credential. */
  publicSiteKey(agentId: string): string | undefined {
    const agent = this.agentRegistry.get(agentId);
    if (!agent?.public?.enabled || !agent.public.chat) return undefined;
    return this.secretStore.resolve(siteKeySecretName(agentId));
  }

  /** Rotate an agent's site key (invalidates the old one). Chat must be enabled. */
  rotateSiteKey(agentId: string): { ok: true; siteKey: string } | { ok: false; error: string } {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { ok: false, error: "agent not found" };
    if (!agent.public?.enabled || !agent.public.chat) return { ok: false, error: "public chat is not enabled for this agent" };
    const siteKey = this.mintAndStoreSiteKey(agentId);
    this.agentRegistry.setPublicConfig(agentId, { ...agent.public, siteKeyHash: createHash("sha256").update(siteKey, "utf8").digest("hex") });
    return { ok: true, siteKey };
  }

  /** Constant-time check that `presented` is the live site key for this agent's public chat. */
  verifySiteKey(agent: AgentRecord, presented: string | undefined): boolean {
    if (!presented) return false;
    const hash = agent.public?.siteKeyHash;
    if (!agent.public?.enabled || !agent.public.chat || !hash) return false;
    const a = Buffer.from(createHash("sha256").update(presented, "utf8").digest("hex"), "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
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
  /** Public accessor for the LIVE allowed-capability set (builtins + installed YAML/MCP/wiki/RAG),
   *  so callers like the create-agent endpoint compile against what is actually registered rather
   *  than a stale hardcoded list. */
  liveAllowedCapabilities(): AllowedCapability[] { return this.allowedCapabilities(); }

  private allowedCapabilities(): AllowedCapability[] {
    const BUILTIN_BUDGETS: Record<string, number> = {
      think: 2000, recall: 50, remember: 50, llm_route: 500,
      web_search: 500, compose: 500, telegram_send: 100, slack_send: 100,
      email_send: 100, http_get: 200, http_post: 200, text_transform: 50,
      notify_webhook: 100,
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
    atomicWrite(semanticPath, "[]");
    atomicWrite(episodicPath, "[]");
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
    // Include chat-kind runs: a public /ask that parks at the human gate is a chat run, and the
    // owner must be able to see and release it here (it's excluded from the Inbox/runs list only).
    const halted = this.runRegistry.listHalted();
    const results: PendingApproval[] = [];

    const { project } = await import("../core/kernel/project.js");

    for (const run of halted) {
      const events = await this.store.readRun("default", run.runId);
      const resolved = new Set<string>();
      const awaits: PendingApproval[] = [];

      // Project the run so we can show WHAT the gated action will do (its inputs).
      const proj = project(events);
      const state = proj.state as Record<string, unknown>;
      const manifest = this.agentRegistry.get(run.agentId)?.signed.manifest;

      for (const e of events) {
        const pl = e.payload as Record<string, unknown>;
        if (e.type === "AwaitResolved") {
          const cid = pl["correlationId"] as string | undefined;
          if (cid) resolved.add(cid);
        }
        if (e.type === "AwaitRequested") {
          const cid = pl["correlationId"] as string | undefined;
          const cap = (pl["call"] as Record<string, unknown> | undefined)?.["capability"] as string | undefined;
          const nodeId = e.scope.nodeId ?? "unknown";
          if (cid) {
            const nodeRole = manifest?.nodes.find(n => n.id === nodeId)?.role;
            awaits.push({
              correlationId: cid,
              runId: run.runId,
              agentId: run.agentId,
              agentName: run.manifestName || this.agentRegistry.get(run.agentId)?.signed.manifest.name || "Untitled agent",
              nodeId,
              capability: cap ?? "unknown",
              requestedAt: e.ts,
              nodeRole: nodeRole ? nodeRole.split(".")[0]?.slice(0, 160) : undefined,
              preview: this.buildApprovalPreview(cap ?? "", state),
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
   * Build a human-readable preview of the proposed action so an approver sees WHAT they're
   * approving (the email body, the message, the URL) — not just "Send an email". Pulls the
   * relevant fields from the run's projected state by capability, with a generic fallback.
   */
  private buildApprovalPreview(capability: string, state: Record<string, unknown>): { label: string; value: string }[] {
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        // exact, then any "<node>.<key>" match
        if (typeof state[k] === "string" && (state[k] as string).trim()) return state[k] as string;
        for (const [sk, sv] of Object.entries(state)) {
          if (sk.endsWith(`.${k}`) && typeof sv === "string" && (sv as string).trim()) return sv as string;
        }
      }
      return undefined;
    };
    const out: { label: string; value: string }[] = [];
    const add = (label: string, v?: string) => { if (v) out.push({ label, value: v.slice(0, 600) }); };

    if (capability === "remember") {
      // A remember node is normally bound to an exact upstream deliverable through
      // remember_map ("fact_name=nodeId.outputKey"). Show only those values. A generic
      // result/body preview can otherwise select an earlier fetch and expose pages of
      // raw HTML instead of the memory write the customer is approving.
      const map = typeof state["remember_map"] === "string" ? state["remember_map"] : "";
      for (const pair of map.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const fact = pair.slice(0, eq).trim();
        const sourceKey = pair.slice(eq + 1).trim();
        const value = state[sourceKey];
        if (!fact || !sourceKey || typeof value !== "string" || !value.trim()) continue;
        const label = fact === "last_output"
          ? "Memory"
          : `Memory · ${fact.replace(/[_-]+/g, " ")}`;
        add(label, value);
      }

      // Older manifests may not have remember_map. Keep the preview useful, but skip
      // fetched markup so approval never masquerades a source document as the fact.
      if (out.length === 0) {
        const fallback = Object.entries(state).reverse().find(([key, value]) =>
          /\.(body|result|output|text)$/.test(key) &&
          typeof value === "string" &&
          value.trim().length > 0 &&
          !/^\s*(?:<!doctype|<html[\s>])/i.test(value),
        );
        add("Memory", typeof fallback?.[1] === "string" ? fallback[1] : undefined);
      }
    } else if (capability === "email_send") {
      add("To", pick("to", "recipient", "creator_handle"));
      add("Subject", pick("subject"));
      add("Message", pick("message", "body", "reply"));
    } else if (capability === "slack_send" || capability === "slack.post") {
      add("Channel", pick("channel"));
      add("Message", pick("message", "text", "result"));
    } else if (capability === "telegram_send") {
      add("Message", pick("message", "text", "result"));
    } else if (capability === "notify_webhook" || capability === "http_post" || capability === "webhook.post") {
      add("URL", pick("url", "target_url"));
      add("Payload", pick("payload", "body", "message", "result"));
    } else {
      // generic: show the most likely "what it will say/do" fields
      add("Message", pick("message", "reply"));
      add("Result", pick("result"));
      add("Body", pick("body"));
    }
    return out;
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
    // Look up the agent BEFORE claiming the concurrency guard. If we claimed the guard first and
    // then early-returned here (e.g. the agent was deleted), the runId would stay in the set
    // forever and permanently wedge every future resolve of this run ("already being resolved").
    const agent = this.agentRegistry.get(run.agentId);
    if (!agent) return { ok: false, error: "agent not found for this run" };
    // Guard against concurrent resolves — two simultaneous approvals for the same run
    // would both pass the status check above before either updates the registry.
    if (this._resolvingApprovals.has(runId)) return { ok: false, error: "approval already being resolved" };
    this._resolvingApprovals.add(runId);

    // Hold the guard across the ENTIRE resolution — the ledger append AND the status flip AND
    // the executeRun launch. Releasing it right after the append (in a finally) opened a window
    // where a second racing approve could pass the status check, append a second AwaitResolved,
    // and launch a SECOND concurrent executeRun for the same run (a double-execution / double-
    // charge window). Guard released only once everything is committed or a terminal state is set.
    try {
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

      // On approve: flip status to running (the atomic gate — a racing resolve now fails the
      // status !== "halted" check) THEN resume execution asynchronously.
      this.runRegistry.update(runId, { status: "running" });
      void this.executeRun(runId, agent.signed.manifest, {}, run.agentId);
      return { ok: true };
    } finally {
      this._resolvingApprovals.delete(runId);
    }
  }

  // ── Secrets (customer-managed) ─────────────────────────────────────────────
  /** Public metadata for all set secrets, plus which are still needed by installed caps. */
  listSecrets(): { secrets: import("./secret-store.js").SecretMeta[]; required: { name: string; capability: string; set: boolean }[] } {
    // Hide the reserved model-config secrets — they're managed via the dedicated /api/model surface.
    const secrets = this.secretStore.list().filter((s) => !RESERVED_MODEL_SECRETS.has(s.name));
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
    if (RESERVED_MODEL_SECRETS.has(name.trim())) {
      return { ok: false, error: `'${name.trim()}' is managed in Settings → Model, not as a secret` };
    }
    return this.secretStore.set(name, value);
  }

  deleteSecret(name: string): boolean {
    if (RESERVED_MODEL_SECRETS.has(name.trim())) return false;
    return this.secretStore.delete(name);
  }

  now(): number {
    // Simple monotonic clock — always >= previous value
    const raw = Date.now();
    this.lastTs = raw > this.lastTs ? raw : this.lastTs + 1;
    return this.lastTs;
  }

  /**
   * Effective LLM config — in-app config (stored under reserved secret names) wins over
   * constructor/env defaults, so a self-hoster can wire up a model from the UI without
   * SSHing in to edit env vars or restarting. buildCompiler() reads these fresh per build.
   */
  private get llmProvider(): string {
    return this.secretStore.isStored(MODEL_PROVIDER_SECRET)
      ? (this.secretStore.resolve(MODEL_PROVIDER_SECRET) ?? this.llmProviderDefault)
      : this.llmProviderDefault;
  }
  private get llmApiKey(): string | null {
    if (this.secretStore.isStored(MODEL_API_KEY_SECRET)) {
      return this.secretStore.resolve(MODEL_API_KEY_SECRET) ?? null;
    }
    // A key supplied for one provider must never be silently sent to another after
    // the operator changes only the provider in the UI.
    if (this.llmProvider === this.llmProviderDefault) return this.llmApiKeyDefault;
    if (this.llmProvider === "openai") return process.env["OPENAI_API_KEY"] ?? null;
    if (this.llmProvider === "anthropic") return process.env["KRELVAN_ANTHROPIC_KEY"] ?? null;
    return null;
  }
  private get llmBaseUrl(): string | undefined {
    if (this.secretStore.isStored(MODEL_BASE_URL_SECRET)) {
      return this.secretStore.resolve(MODEL_BASE_URL_SECRET);
    }
    return this.llmProvider === this.llmProviderDefault ? this.llmBaseUrlDefault : undefined;
  }
  private get llmModel(): string | undefined {
    if (this.secretStore.isStored(MODEL_NAME_SECRET)) {
      return this.secretStore.resolve(MODEL_NAME_SECRET);
    }
    return this.llmProvider === this.llmProviderDefault ? this.llmModelDefault : undefined;
  }

  /**
   * Built-in capabilities use the process-wide shared LLM client. Keep it aligned with
   * this runtime's durable/effective model config. The constructor calls this after the
   * encrypted store is loaded; setModelConfig calls it after every update.
   */
  private syncEffectiveModelConfigToEnv(): void {
    const assign = (name: string, value: string | null | undefined) => {
      if (value) process.env[name] = value;
      else delete process.env[name];
    };
    assign("KRELVAN_LLM_PROVIDER", this.llmProvider);
    assign("KRELVAN_LLM_API_KEY", this.llmApiKey);
    assign("KRELVAN_LLM_MODEL", this.llmModel);
    assign("KRELVAN_LLM_BASE_URL", this.llmBaseUrl);
    resetLLMClient();
  }

  get hasLlm(): boolean {
    return !!(this.llmApiKey) || this.llmProvider === "ollama";
  }

  /** Readiness for the UI: is a model wired up, and which provider/model. Drives the build gate + pill. */
  get modelStatus(): { hasLlm: boolean; provider: string; model: string | null; source: "in-app" | "env" } {
    const inApp = this.secretStore.isStored(MODEL_PROVIDER_SECRET)
      || this.secretStore.isStored(MODEL_API_KEY_SECRET);
    return { hasLlm: this.hasLlm, provider: this.llmProvider, model: this.llmModel ?? null, source: inApp ? "in-app" : "env" };
  }

  /**
   * Configure the LLM provider from the UI. Stored encrypted via the secret store under
   * reserved names; takes effect on the next build (buildCompiler reads fresh). Passing an
   * empty/whitespace value for a field clears it (reverting to env/default). For Ollama, an
   * API key is not required.
   */
  setModelConfig(cfg: { provider?: string; apiKey?: string; model?: string; baseUrl?: string }): { ok: true; status: ReturnType<KrelvanRuntime["modelStatusGetter"]> } | { ok: false; error: string } {
    const provider = (cfg.provider ?? "").trim().toLowerCase();
    // The llm-client adapter natively supports these OpenAI-compatible providers (each with a
    // built-in base URL) plus anthropic and local ollama — keep this list in sync with it so a
    // supported provider isn't rejected here. "compatible" requires an explicit baseUrl.
    const SUPPORTED = ["anthropic", "openai", "ollama", "groq", "mistral", "gemini", "compatible"];
    if (provider && !SUPPORTED.includes(provider)) {
      return { ok: false, error: `provider must be one of: ${SUPPORTED.join(", ")}` };
    }
    const apply = (name: string, value: string | undefined) => {
      const v = (value ?? "").trim();
      if (v) { this.secretStore.set(name, v); } else { this.secretStore.delete(name); }
    };
    if (cfg.provider !== undefined) apply(MODEL_PROVIDER_SECRET, provider);
    if (cfg.apiKey !== undefined) apply(MODEL_API_KEY_SECRET, cfg.apiKey);
    if (cfg.model !== undefined) apply(MODEL_NAME_SECRET, cfg.model);
    if (cfg.baseUrl !== undefined) apply(MODEL_BASE_URL_SECRET, cfg.baseUrl);
    // Built-ins use the process-wide shared client. Apply the effective values (including
    // constructor/env fallbacks after a field is cleared), then invalidate its cache.
    this.syncEffectiveModelConfigToEnv();
    // anthropic/openai with no key set at all → not actually ready; report honestly via status
    return { ok: true, status: this.modelStatus };
  }

  // helper purely so the return type of setModelConfig can name modelStatus's shape
  private modelStatusGetter() { return this.modelStatus; }

  /** Build a fresh Compiler with current agent registry injected into the model prompt. */
  /** The model port used to compile manifests — shared by buildCompiler and the delegate plugin. */
  private buildModelPort(): import("../core/compiler/compiler.js").ModelPort {
    const modelPort = this.hasLlm
      ? new AnthropicModel({
          apiKey: this.llmApiKey ?? "",
          model: this.llmModel,
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
    return modelPort as import("../core/compiler/compiler.js").ModelPort;
  }

  private buildCompiler(): Compiler {
    return new Compiler(this.buildModelPort(), this.ownerSigner);
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
    this.capabilityRegistry.registerBuiltin(syntheticUsersCapability, {
      description: "Casts a spread of SYNTHETIC USERS (happy-path, confused, adversarial, out-of-scope, malformed) for testing an agent — outputs users[] each with a name, description, and opening message.",
      useWhen: "the FIRST node of a TESTER agent (an agent that tests another agent). Follow it with a delegate node (agentId of the target) run over each user, then a think node to grade, then compose to report. Set \"scenario\" in the seed to what you're testing.",
      notes: "read-only; generates test data only, sends/charges nothing. Pair with delegate(agentId=<target agent>) to run each synthetic user through the agent under test.",
    });
    this.capabilityRegistry.registerBuiltin(ragIngestCapability, {
      description: "Chunks + embeds text into this agent's vector knowledge base for later retrieval.",
      useWhen: "ingestion step of a RAG agent: load docs/pages, then ingest them so future queries can ground on them",
    });
    this.capabilityRegistry.registerBuiltin(ragSearchCapability, {
      description: "Embeds a question and retrieves the most relevant ingested chunks as context (with sources).",
      useWhen: "query step of a RAG/support agent: retrieve grounding context before a think node answers and cites",
    });
    this.capabilityRegistry.registerBuiltin(wikiIngestCapability, {
      description: "Compiles a source into a persistent, interlinked markdown wiki — creates/updates entity + concept pages, maintains an index, flags contradictions. Knowledge accumulates instead of being re-chunked per query.",
      useWhen: "ingest step of an LLM-Wiki agent: after a think node synthesises which pages a source touches, apply those page updates to the named wiki",
    });
    this.capabilityRegistry.registerBuiltin(wikiQueryCapability, {
      description: "Reads the compiled wiki pages relevant to a question and returns them as grounded, page-cited context. Answers from the maintained wiki, not by re-retrieving raw text.",
      useWhen: "query step of an LLM-Wiki agent: fetch the relevant wiki pages before a think node synthesises a cited answer",
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

    // delegate — run a sub-agent. Two modes: agentId (run an EXISTING saved agent, for
    // agent-tests-agent) or intent (compile a fresh sub-agent). This is what pairs with
    // synthetic_users to build tester agents. Constructed with the runtime's authority; the
    // plugin snapshot is read live per invoke so it always sees the current capability set.
    const rt = this;
    this.capabilityRegistry.registerBuiltin(
      new DelegatePlugin({
        model: this.buildModelPort(),
        compilerSigner: this.ownerSigner,
        ownerSigner: this.ownerSigner,
        supervisorSigner: this.supervisorSigner,
        principal: {
          kind: "owner",
          id: "owner-delegate",
          allowedCapabilities: this.allowedCapabilities(),
          maxRunBudgetCents: 10_000,
        },
        get plugins() { return rt.capabilityRegistry.snapshot(); },
        now: () => rt.now(),
        agentLookup: (agentId: string) => rt.agentRegistry.get(agentId)?.signed.manifest ?? null,
      }),
      {
        description: "Runs another agent as a sub-step and returns its result. Give agentId to run an EXISTING saved agent (agent-tests-agent), or intent to compile a fresh sub-agent. Seed the run with a `message`.",
        useWhen: "a TESTER agent: after synthetic_users casts users, delegate(agentId=<target agent>) runs each user's message through the agent under test. Also for agents that call other agents.",
        notes: "delegated sub-runs never take unsupervised irreversible/outbound/spend actions — those gate for approval. Set agentId to the id of the agent you want to test.",
      },
    );
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
      origin: { kind: "schedule", scheduleId },
    });

    log.info({ runId, agentId, scheduleId }, "starting scheduled run");
    this.agentRegistry.updateLastRun(agentId, runId);
    void this.executeRun(runRecord.runId, agent.signed.manifest, {}, agentId);
    return runId;
  }

  /**
   * "Run now" from the Schedules page — fires the schedule's agent THROUGH the same
   * startScheduledRun path, so the run carries origin { kind: "schedule", scheduleId } and
   * shows up in the schedule's history exactly like an automatic fire.
   */
  async runScheduleNow(scheduleId: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const schedule = this.scheduleRegistry.get(scheduleId);
    if (!schedule) return { ok: false, error: "schedule not found" };
    try {
      const runId = await this.startScheduledRun(schedule.agentId, scheduleId);
      return { ok: true, runId };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Create a new schedule for an agent. */
  createSchedule(opts: {
    agentId: string;
    kind: "cron" | "interval";
    spec: string;
    label?: string;
    /** Missed-run policy across downtime. Defaults to "skip"; the builder passes "runOnce"
     *  for digest-style daily/weekly schedules (you still want yesterday's digest, once). */
    onMissed?: OnMissed;
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
      onMissed: opts.onMissed ?? "skip",
    };

    this.scheduleRegistry.create(schedule);
    this.scheduler.arm(schedule);
    log.info({ id: schedule.id, agentId: opts.agentId, kind: opts.kind, spec: opts.spec }, "schedule created");
    return { ok: true, schedule };
  }

  /**
   * Start a run for an agent with the given initial state, async. Shared by the
   * authenticated POST /api/runs handler, the scheduler, and the public webhook trigger.
   * Returns the run record immediately (the run executes in the background).
   */
  triggerRun(agentId: string, initialState: Record<string, string | number | boolean | null>): { ok: true; run: RunRecord } | { ok: false; error: string } {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { ok: false, error: "agent not found" };
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const run = this.runRegistry.create({ agentId, runId, manifestName: agent.signed.manifest.name, origin: { kind: "trigger" } });
    void this.executeRun(runId, agent.signed.manifest, initialState, agentId);
    return { ok: true, run };
  }

  // ── Public ask (B2) ────────────────────────────────────────────────────────────
  // A public visitor talks to a published agent via a per-agent SITE KEY. The turn is a
  // normal chat run — it inherits the agent's EXISTING grants (zero capability widening) and
  // the human-approval gate is honored verbatim (a parked turn awaits an ADMIN approval; the
  // public caller can never approve). Sliding-window run caps per (key-scoped) thread and per
  // agent stop an exposed instance from being cost-drained.

  /** thread → the runId currently executing/executed for it (so a 202 can be polled). */
  private readonly _publicThreadRun = new Map<string, string>();
  /** sliding-window timestamps of public asks, keyed by agentId and by thread, for rate caps. */
  private readonly _publicAskWindow = new Map<string, number[]>();

  /** True if `key` has had >= `max` asks in the last `windowMs`; also records this ask. */
  private _publicCapTripped(key: string, max: number, windowMs: number): boolean {
    const now = this.now();
    const arr = (this._publicAskWindow.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this._publicAskWindow.set(key, arr); return true; }
    arr.push(now);
    this._publicAskWindow.set(key, arr);
    return false;
  }

  /** Pull the human-facing reply out of a finished run's state (shared with chatWithAgent). */
  private async extractReply(runId: string): Promise<string> {
    const { project } = await import("../core/kernel/project.js");
    const events = await this.store.readRun("default", runId);
    const state = project(events).state as Record<string, unknown>;
    const suffixes = [".reply", ".result", ".answer", ".response", ".message", ".body", ".text"];
    for (const suf of suffixes) {
      const hit = Object.entries(state).find(([k, v]) => k.endsWith(suf) && typeof v === "string" && (v as string).trim().length > 0);
      if (hit) return String(hit[1]).trim();
    }
    const first = Object.entries(state).find(([k, v]) => typeof v === "string" && (v as string).trim().length > 20 && !k.startsWith("_"));
    return first ? String(first[1]).trim() : "(the agent produced no text reply)";
  }

  /**
   * Public ask. `slug` selects the agent; the site key is verified constant-time by the caller
   * (server passes the resolved agent). Returns:
   *  - { status: "reply", reply, thread } when the run finished within the timeout,
   *  - { status: "pending", thread } when it's still running (caller returns 202 + poll url),
   *  - { status: "awaiting-approval", thread } when it parked at the human gate,
   *  - { status: "rate-limited" } when a run cap tripped (caller returns 429, NO numbers).
   */
  async publicAsk(agent: AgentRecord, message: string, thread: string):
    Promise<{ status: "reply"; reply: string; thread: string } | { status: "pending" | "awaiting-approval"; thread: string } | { status: "rate-limited" }> {
    // Run caps: env-tunable, sane defaults. Per-thread and per-agent sliding windows.
    const perThread = Number(process.env["KRELVAN_PUBLIC_THREAD_MAX"]) || 10;   // asks / window / thread
    const perAgent = Number(process.env["KRELVAN_PUBLIC_AGENT_MAX"]) || 120;    // asks / window / agent
    const windowMs = Number(process.env["KRELVAN_PUBLIC_WINDOW_MS"]) || 60_000;
    if (this._publicCapTripped(`agent:${agent.id}`, perAgent, windowMs)) return { status: "rate-limited" };
    if (this._publicCapTripped(`thread:${agent.id}:${thread}`, perThread, windowMs)) return { status: "rate-limited" };

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this._publicThreadRun.set(`${agent.id}:${thread}`, runId);
    // kind:"chat" (inbox-excluded) + origin public-ask. Memory scoped to the thread.
    this.runRegistry.create({ agentId: agent.id, runId, manifestName: agent.signed.manifest.name, kind: "chat", origin: { kind: "public-ask" } });
    const initialState: Record<string, string | number | boolean | null> = { message, history: "", sender_id: `public:${thread}` };

    // Execute in the background; race it against the ask timeout.
    const exec = this.executeRun(runId, agent.signed.manifest, initialState, agent.id);
    const timeoutMs = Number(process.env["KRELVAN_ASK_TIMEOUT_MS"]) || 25_000;
    let timedOut = false;
    await Promise.race([exec, new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, timeoutMs))]);

    const status = this.runRegistry.get(runId)?.status;
    if (timedOut && status !== "completed" && status !== "failed" && status !== "halted") return { status: "pending", thread };
    if (status === "halted") return { status: "awaiting-approval", thread };
    if (status === "completed") return { status: "reply", reply: await this.extractReply(runId), thread };
    // failed (or unknown) — surface a neutral message, never an internal reason.
    return { status: "reply", reply: "Sorry — I couldn't answer that just now. Please try again.", thread };
  }

  /** Poll a public thread's latest run for the reply (the 202 path). */
  async publicAskPoll(agent: AgentRecord, thread: string):
    Promise<{ status: "reply"; reply: string } | { status: "pending" | "awaiting-approval" } | { status: "unknown" }> {
    const runId = this._publicThreadRun.get(`${agent.id}:${thread}`);
    if (!runId) return { status: "unknown" };
    const status = this.runRegistry.get(runId)?.status;
    if (status === "completed") return { status: "reply", reply: await this.extractReply(runId) };
    if (status === "halted") return { status: "awaiting-approval" };
    if (status === "failed") return { status: "reply", reply: "Sorry — I couldn't answer that just now. Please try again." };
    return { status: "pending" };
  }

  /** Published, non-archived artifacts for an agent's public feed (title/body/createdAt only). */
  publicFeed(agentId: string, limit = 20): { title: string; body: string; createdAt: number }[] {
    return this.artifactStore.list({ agentId, archived: false, limit: 200 })
      .filter((a) => a.published === true)
      .slice(0, limit)
      .map((a) => ({ title: a.title, body: a.body, createdAt: a.createdAt }));
  }

  /**
   * Talk to an agent conversationally. Runs the agent with the user's message (and the thread
   * history, so it remembers the conversation) as input, waits for it to finish, and returns
   * the agent's reply — the human-facing output of the run. This turns a scheduled runner into
   * something you can actually converse with and redirect.
   */
  async chatWithAgent(
    agentId: string,
    message: string,
    threadId: string,
    history: string,
  ): Promise<{ ok: true; reply: string; runId: string; status: string } | { ok: false; error: string }> {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { ok: false, error: "agent not found" };
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Mark as a chat turn so it does NOT appear in the Inbox / runs list.
    this.runRegistry.create({ agentId, runId, manifestName: agent.signed.manifest.name, kind: "chat" });
    // Pass the message + prior thread as run input. `sender_id` scopes memory to this thread so
    // each conversation is isolated and compounds. The manifest's nodes read `message`/`history`.
    const initialState: Record<string, string | number | boolean | null> = {
      message,
      history,
      sender_id: threadId,
    };
    await this.executeRun(runId, agent.signed.manifest, initialState, agentId);
    const rec = this.runRegistry.get(runId);
    const status = rec?.status ?? "unknown";
    // Extract the reply: the run's human-facing output text.
    const { project } = await import("../core/kernel/project.js");
    const events = await this.store.readRun("default", runId);
    const state = project(events).state as Record<string, unknown>;
    // Prefer a prose reply field; fall back to the first substantial text output.
    const suffixes = [".reply", ".result", ".answer", ".response", ".message", ".body", ".text"];
    let reply = "";
    for (const suf of suffixes) {
      const hit = Object.entries(state).find(([k, v]) => k.endsWith(suf) && typeof v === "string" && (v as string).trim().length > 0);
      if (hit) { reply = String(hit[1]).trim(); break; }
    }
    if (!reply) {
      const first = Object.entries(state).find(([k, v]) => typeof v === "string" && (v as string).trim().length > 20 && !k.startsWith("_"));
      reply = first ? String(first[1]).trim() : "(the agent produced no text reply)";
    }
    return { ok: true, reply, runId, status };
  }

  /**
   * Run ONE rehearsal: execute the agent's real graph on the real engine against a SYNTHETIC
   * world. Read tools return plausible fake data (shaped by `synthesize` if provided); every
   * consequential tool is recorded, not performed. The run is marked `rehearsal`, so it never
   * enters the Inbox, never delivers, and is excluded from the runs list — but it IS a real signed
   * run, fully replayable on the canvas.
   *
   * Returns the run record and the list of consequential effects that WOULD have fired in
   * production. Seed the persona's opening input via `seedState`.
   */
  async rehearseOnce(opts: {
    agentId: string;
    manifest: Manifest;
    seedState?: Record<string, string | number | boolean | null>;
    rehearsalId?: string;
    personaName?: string;
    synthesize?: import("./rehearsal/synthetic-supervisor.js").ReadSynthesizer;
  }): Promise<{ ok: true; run: RunRecord; suppressed: import("./rehearsal/synthetic-supervisor.js").SuppressedEffect[] } | { ok: false; error: string }> {
    const { buildSyntheticLayer } = await import("./rehearsal/synthetic-supervisor.js");
    const layer = buildSyntheticLayer(this.supervisor.snapshot(), opts.synthesize);

    const runId = `reh-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.runRegistry.create({
      agentId: opts.agentId,
      runId,
      manifestName: opts.manifest.name,
      rehearsal: true,
      ...(opts.rehearsalId ? { rehearsalId: opts.rehearsalId } : {}),
      ...(opts.personaName ? { personaName: opts.personaName } : {}),
    });

    await this.executeRun(runId, opts.manifest, opts.seedState ?? {}, opts.agentId, layer);

    const run = this.runRegistry.get(runId);
    if (!run) return { ok: false, error: "rehearsal run vanished" };
    return { ok: true, run, suppressed: layer.suppressed };
  }

  /**
   * Assemble the objective outcome for one finished rehearsal run — the facts the verdict rules
   * reason over: did it park for approval, did any node hit its visit cap, how much budget it used.
   */
  private async _rehearsalOutcome(
    run: RunRecord,
    manifest: Manifest,
    suppressed: import("./rehearsal/synthetic-supervisor.js").SuppressedEffect[],
  ): Promise<import("./rehearsal/verdict.js").RehearsalOutcome> {
    const { project } = await import("../core/kernel/project.js");
    const events = await this.store.readRun("default", run.runId);
    const proj = project(events);
    const cappedNodes = Object.entries(proj.nodes)
      .filter(([, ns]) => ns.visits >= manifest.maxNodeVisits)
      .map(([id]) => id);
    return {
      status: run.status,
      ...(run.reason ? { reason: run.reason } : {}),
      suppressed,
      parkedForApproval: proj.openAwaits.size > 0,
      cappedNodes,
      spentCents: proj.budget.runSpentCents + proj.budget.runReservedCents,
      budgetCents: manifest.runBudgetCents,
    };
  }

  /**
   * Run a full REHEARSAL of an agent: cast a spread of synthetic users, run each one through the
   * real graph against a synthetic world, and return a report — per-persona verdict + findings,
   * plus a roll-up. Nothing is delivered, charged, or written.
   *
   * `count` targets a cast size (clamped 3–8). Read tools return synthetic data shaped by the LLM
   * when one is configured; consequential tools are always recorded, never performed.
   */
  async rehearseAgent(agentId: string, count?: number): Promise<
    | { ok: true; report: import("./rehearsal/report.js").RehearsalReport }
    | { ok: false; error: string }
  > {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { ok: false, error: "agent not found" };
    const manifest = agent.signed.manifest;

    const { generatePersonas } = await import("./rehearsal/personas.js");
    const { judgeRehearsal } = await import("./rehearsal/verdict.js");
    const { buildReport } = await import("./rehearsal/report.js");

    const graphSummary = manifest.nodes.map(n => n.role).join(" → ") || manifest.entry;
    const client = this.hasLlm ? getLLMClient() : null;
    const { personas, generated } = await generatePersonas({
      intent: manifest.intent, graphSummary, count, client,
      model: process.env["KRELVAN_LLM_MODEL"],
    });

    const rehearsalId = `rehset-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // A read-tool synthesizer that gives each persona-run plausible fake data without the network.
    // Kept deliberately simple + LLM-optional: it echoes the persona's message so downstream nodes
    // have something coherent to work with; richer shaping can hang off `client` later.
    const results: import("./rehearsal/report.js").PersonaResult[] = [];
    for (const persona of personas) {
      const seedState: Record<string, string | number | boolean | null> = {
        message: persona.seedMessage,
        history: "",
        sender_id: `rehearsal:${persona.name}`,
      };
      const outcome = await this.rehearseOnce({
        agentId, manifest, seedState, rehearsalId, personaName: persona.name,
      });
      if (!outcome.ok) {
        results.push({ persona, runId: "", judgement: { verdict: "failed", findings: [{ level: "stop", code: "rehearsal_error", message: outcome.error }] } });
        continue;
      }
      const facts = await this._rehearsalOutcome(outcome.run, manifest, outcome.suppressed);
      results.push({ persona, runId: outcome.run.runId, judgement: judgeRehearsal(facts) });
    }

    const report = buildReport({
      rehearsalId, agentId, agentName: manifest.name,
      personasGenerated: generated, results, createdAt: this.now(),
    });
    return { ok: true, report };
  }

  /**
   * Time-travel: FORK a run at a chosen node and re-run FORWARD from there, optionally with one
   * of that node's outputs edited — "what if this step had produced X instead?".
   *
   * Mechanism (no core changes — the engine/kernel/ledger are untouched):
   *  1. Read the source run's events. Take the prefix up to AND INCLUDING the chosen node's
   *     NodeConcluded, and copy each event onto a BRAND-NEW runId (re-signed by the store, so the
   *     fork gets its own clean, valid, tamper-evident chain). Copying the upstream NodeEntered/
   *     EffectResult/NodeConcluded events means the fork's projection shows those nodes concluded
   *     and their effect idem-keys already have results — so the pure kernel advances FROM the
   *     fork point and re-runs only the DOWNSTREAM nodes.
   *  2. If an edit is supplied, override that one key in the chosen node's NodeConcluded.state as
   *     it is copied — the downstream re-run sees the edited value.
   *  3. executeRun the fork forward. Because it's a new runId, downstream effect idem-keys are
   *     empty, so consequential effects genuinely re-execute (and re-gate for approval) with the
   *     new value — a "what if" branch can never silently re-spend or re-send the old effects.
   *
   * Returns the new run record. Deterministic events (RunStarted/NodeEntered/NodeConcluded/
   * Admission/EffectRequested) are owner-signed; EffectResult is supervisor-signed + "captured",
   * exactly as the engine writes them.
   */
  async forkRun(
    sourceRunId: string,
    throughNodeId: string,
    edit?: { key: string; value: string | number | boolean | null },
  ): Promise<{ ok: true; run: RunRecord } | { ok: false; error: string }> {
    const source = this.runRegistry.get(sourceRunId);
    if (!source) return { ok: false, error: "source run not found" };
    const agent = this.agentRegistry.get(source.agentId);
    if (!agent) return { ok: false, error: "agent not found for the source run" };
    if (source.kind === "chat") return { ok: false, error: "chat runs cannot be forked" };

    const events = await this.store.readRun("default", sourceRunId);
    // The cutoff is the chosen node's LAST NodeConcluded (its most recent visit). Everything up
    // to and including it is copied; everything after is dropped so the fork re-runs forward.
    let cutoff = -1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === "NodeConcluded" && e.scope.nodeId === throughNodeId) cutoff = i;
    }
    if (cutoff < 0) return { ok: false, error: `node '${throughNodeId}' has no concluded step in this run to fork from` };

    const newRunId = `run-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // A fork is a normal (non-chat) run so it appears in the Inbox/runs list like any other.
    this.runRegistry.create({
      agentId: source.agentId, runId: newRunId, manifestName: agent.signed.manifest.name,
      origin: { kind: "manual" },
    });

    // Copy the prefix onto the new runId, re-signing each event. The store assigns fresh
    // offset/prev/id — the fork is its own independent, verifiable chain.
    for (let i = 0; i <= cutoff; i++) {
      const e = events[i]!;
      let payload = e.payload as Record<string, unknown>;
      // Apply the edit to the chosen node's conclusion as it's copied.
      if (edit && i === cutoff && e.type === "NodeConcluded") {
        const prevState = (payload["state"] as Record<string, unknown> | undefined) ?? {};
        payload = { ...payload, state: { ...prevState, [`${throughNodeId}.${edit.key}`]: edit.value } };
      }
      const signer = e.type === "EffectResult" ? this.supervisorSigner : this.ownerSigner;
      const scope: import("../core/ledger/event.js").EventScope = {
        tenantId: "default", runId: newRunId, branchId: "main",
        ...(e.scope.nodeId ? { nodeId: e.scope.nodeId } : {}),
      };
      const appended = await this.store.append(
        {
          type: e.type,
          scope,
          payload,
          ...(e.determinism === "captured" ? { determinism: "captured" as const } : {}),
          author: signer.descriptor.keyId,
        } satisfies NewEvent<Record<string, unknown>>,
        { ts: this.now(), signer },
      );
      if (!appended.ok) {
        this.runRegistry.update(newRunId, { status: "failed", finishedAt: this.now(), reason: `fork copy failed: ${appended.error.message}` });
        return { ok: false, error: `could not copy the run up to the fork point: ${appended.error.message}` };
      }
    }

    log.info({ sourceRunId, newRunId, throughNodeId, edited: !!edit }, "run forked");
    this.agentRegistry.updateLastRun(source.agentId, newRunId);
    // Re-run FORWARD from the fork point. The copied prefix means the kernel resumes past the
    // chosen node; downstream nodes execute fresh (and re-gate consequential effects).
    void this.executeRun(newRunId, agent.signed.manifest, {}, source.agentId);
    const run = this.runRegistry.get(newRunId)!;
    return { ok: true, run };
  }

  async executeRun(
    runId: string,
    manifest: Manifest,
    initialState: Record<string, string | number | boolean | null>,
    agentId?: string,
    rehearsal?: import("./rehearsal/synthetic-supervisor.js").SyntheticLayer,
  ): Promise<void> {
    this.runRegistry.update(runId, { status: "running" });
    // Production uses the live supervisor (reflects runtime enable/disable of plugins). A
    // REHEARSAL swaps in a synthetic Supervisor built from the same plugin set — same names,
    // side-effect classes and estimates, so admission/budget/gating are identical — but its tools
    // touch nothing real. This is the ONLY behavioural difference between a rehearsal and a run.
    const supervisor = rehearsal ? new Supervisor(rehearsal.plugins) : this.supervisor;

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
      // approve=()=>false: a gated effect (autonomy "suggest"/etc. on a non-read side-effect)
      // PARKS the run for human approval the first time it is reached (status → halted, an
      // AwaitRequested lands in the ledger, the Approvals page shows it). On resume after the
      // human approves, the engine sees the ledger's AwaitResolved and proceeds — so the
      // human-in-the-loop gate is actually enforced for API-triggered runs (it was previously
      // bypassed because the default approve=()=>true auto-approved everything).
      // Wall-clock deadline so an unattended run (stuck plugin, or parked on an approval
      // nobody resolves) fails cleanly instead of sitting "running"/"halted" forever.
      // Default 10 min; tune via KRELVAN_RUN_DEADLINE_MS (0 disables).
      const deadlineEnv = Number(process.env["KRELVAN_RUN_DEADLINE_MS"]);
      const deadlineWindowMs = Number.isFinite(deadlineEnv) && deadlineEnv >= 0 ? deadlineEnv : 600_000;
      // Transient-failure retry for capability invokes (network blip / rate-limit /
      // timeout). Default 2 extra attempts; tune via KRELVAN_EFFECT_RETRIES (0 disables).
      const retriesEnv = Number(process.env["KRELVAN_EFFECT_RETRIES"]);
      const effectRetries = Number.isFinite(retriesEnv) && retriesEnv >= 0 ? retriesEnv : 2;
      const runOpts: { initialState: typeof enrichedState; approve: () => boolean; deadlineMs?: number; effectRetries: number } = {
        initialState: enrichedState,
        approve: () => false,
        effectRetries,
      };
      if (deadlineWindowMs > 0) runOpts.deadlineMs = Date.now() + deadlineWindowMs;
      const result = await engine.run(runOpts);
      const finalStatus: "completed" | "halted" | "failed" =
        result.status === "completed" ? "completed" : result.status === "halted" ? "halted" : "failed";
      this.runRegistry.update(runId, {
        status: finalStatus,
        finishedAt: Date.now(),
        spentCents: result.projection.budget.runSpentCents,
        reason: result.reason,
      });
      // Reservation/accounting fields remain internal safety controls. Customer-facing logs
      // report the outcome only; the internal estimate must never be presented as a price.
      log.info({ runId, status: result.status }, "run finished");

      // If this run was fired by a schedule, record the outcome so the failure-streak logic
      // (C1) can warn after repeated failures. A completed run resets the streak.
      const origin = this.runRegistry.get(runId)?.origin;
      if (origin?.kind === "schedule" && origin.scheduleId) {
        this.scheduler.recordRunOutcome(origin.scheduleId, finalStatus, result.reason ?? "");
      }

      // On a completed NON-CHAT run: extract the deliverable output ONCE (output_map first,
      // else the heuristic) and make it a first-class Artifact (the Inbox feed). Chat runs
      // are conversation turns — never artifacts (same exclusion the Inbox already applies).
      // The SAME extracted title/body is then handed to delivery, so the Inbox and the
      // email/slack/… copy are guaranteed identical (one extractor, two consumers).
      // A rehearsal NEVER produces an Inbox artifact and NEVER delivers — it is a synthetic
      // dry-run. This is the third independent stop (after the synthetic tool layer and the
      // no-network fetchImpl) guaranteeing a rehearsal cannot ship anything to the real world.
      if (result.status === "completed" && !rehearsal) {
        const isChat = this.runRegistry.get(runId)?.kind === "chat";
        if (!isChat) {
          const extracted = extractArtifact(manifest, result.projection.state as Record<string, unknown>);
          if (extracted) {
            const agent = agentId ? this.agentRegistry.get(agentId) : undefined;
            // create() is idempotent by runId — a re-fold/re-serve never duplicates.
            this.artifactStore.create({
              agentId: agentId ?? manifest.name,
              agentName: agent?.signed.manifest.name ?? manifest.name,
              runId,
              ...(origin?.kind === "schedule" && origin.scheduleId ? { scheduleId: origin.scheduleId } : {}),
              title: extracted.title,
              body: extracted.body,
              format: extracted.format,
            });
            // Deliver to the customer's chosen destinations. Best-effort and detached: a
            // delivery failure must never affect the run (the output is already in the Inbox).
            if (agent?.deliverTo && agent.deliverTo.length > 0) {
              void this.deliverOutput(agent.deliverTo, manifest.name, runId, extracted.title, extracted.body);
            }
          }
        }
      }
    } catch (err) {
      // An Error object serializes to {} in structured logs — extract message + stack so a
      // production failure is actually diagnosable (this is what obscured a real run failure).
      const e = err as Error;
      log.error({ runId, error: e?.message ?? String(err), stack: e?.stack }, "run threw unexpectedly");
      this.runRegistry.update(runId, { status: "failed", finishedAt: Date.now(), reason: e?.message ?? "unexpected error" });
    }
  }

  /**
   * Push an already-extracted run output to the agent's chosen delivery targets. The title
   * and body come from the ONE shared extractor (extractArtifact) so the delivered copy is
   * byte-identical to the Inbox artifact — there is no separate extraction here anymore.
   */
  private async deliverOutput(
    targets: import("./delivery.js").DeliveryTarget[],
    agentName: string,
    runId: string,
    title: string,
    body: string,
  ): Promise<void> {
    try {
      // Resolve any *_ref delivery secrets (stored encrypted, never in plaintext on the record)
      // back into their plaintext values only at send time, in memory, for this one delivery.
      const resolvedTargets = targets.map((t) => {
        if (!t.config) return t;
        const config: Record<string, string> = {};
        for (const [k, v] of Object.entries(t.config)) {
          if (k.endsWith("_ref")) {
            const val = this.secretStore.resolve(v);
            if (val) config[k.slice(0, -"_ref".length)] = val;
          } else {
            config[k] = v;
          }
        }
        return { ...t, config };
      });
      const { deliver } = await import("./delivery.js");
      await deliver(resolvedTargets, { agentName, runId, title, body });
    } catch (err) {
      log.warn({ runId, error: (err as Error)?.message }, "output delivery failed (run unaffected)");
    }
  }
}

// ── Stub model port (when no Anthropic key is configured) ──────────────────────

class StubModelPort {
  async propose(_intent: string): Promise<import("../core/compiler/compiler.js").ManifestProposal> {
    // No LLM is configured. We MUST NOT silently emit a placeholder agent and pass it off as a
    // real build — that's the worst first-run outcome (a confident junk result). Fail loudly.
    // The API build route gates on hasLlm before reaching here, so this is a belt-and-braces guard.
    void _intent;
    throw new Error("no LLM provider configured — cannot build an agent. Set KRELVAN_LLM_PROVIDER + a provider API key (OPENAI_API_KEY is accepted for OpenAI), or run Ollama locally.");
  }
}
