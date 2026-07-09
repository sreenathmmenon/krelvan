/**
 * PluginLifecycleService — the Facade for all plugin state transitions.
 *
 * Every mutating operation atomically writes:
 *   1. A registry row mutation (SqlitePluginRepository.save / .remove)
 *   2. A ledger event using the same integrity path as SqliteLedgerStore
 *
 * Both writes share the same DatabaseSync handle in a single BEGIN IMMEDIATE /
 * COMMIT block — a crash between the two is impossible.
 *
 * Supervisor snapshot swaps happen AFTER the transaction commits. If the process
 * dies after commit but before the swap, the activator re-loads enabled plugins
 * from the DB at next startup and rebuilds the snapshot correctly.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve as resolvePath } from "node:path";
import type { CapabilityPlugin } from "../capability/capability.js";
import type { SupervisorSnapshotHandle } from "../capability/capability.js";
import { hasTeardown } from "../../infrastructure/plugins/typescript-plugin-loader.js";
import type { EventType } from "../ledger/event.js";
import type { Signer } from "../ledger/crypto.js";
import { atomicPluginWrite } from "./plugin-ledger-writer.js";
import type {
  PluginLifecyclePort,
  PluginInstallResult,
  PluginEnableResult,
  PluginDisableResult,
  PluginUninstallResult,
  PluginRepository,
  SecretBrokerPort,
  OwnerId,
} from "./ports.js";
import { PluginFactory } from "./plugin-factory.js";
import type { PersistedPluginRecord, PersistedEnabledPlugin, DisabledPlugin, PluginKind } from "./types.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("plugin-lifecycle");

interface PluginEventPayload {
  pluginName: string;
  pluginKind: string;
  version: string;
  sourceHash: string;
  actorId: OwnerId;
  [key: string]: unknown;
}

export interface LifecycleDeps {
  repository: PluginRepository;
  factory: PluginFactory;
  snapshotHandle: SupervisorSnapshotHandle;
  broker: SecretBrokerPort;
  signer: Signer;
  /** The shared DatabaseSync for atomic registry+ledger transactions. */
  db: DatabaseSync;
  now: () => number;
  /**
   * Absolute path to the directory plugins must reside in.
   * install() rejects any sourcePath that does not resolve inside this root.
   * Example: path.resolve(process.cwd(), "capabilities")
   */
  pluginsRoot: string;
}

export class PluginLifecycleService implements PluginLifecyclePort {
  /** Tracks the current live plugin snapshot so enable/disable can do Map operations. */
  private liveSnapshot: Map<string, CapabilityPlugin>;

  constructor(private readonly deps: LifecycleDeps) {
    this.liveSnapshot = new Map();
  }

  /**
   * Call after PluginActivator.loadAll() to seed the initial snapshot.
   */
  setInitialSnapshot(snapshot: ReadonlyMap<string, CapabilityPlugin>): void {
    this.liveSnapshot = new Map(snapshot);
    this.deps.snapshotHandle.replaceSnapshot(snapshot);
  }

  async install(sourcePath: string, version: string, owner: OwnerId, egressHosts?: ReadonlyArray<string>): Promise<PluginInstallResult> {
    // Validate the declared egress allowlist up front — a plugin can never be installed
    // with a malformed allowlist (no "*", scheme, port, path, or IP literal).
    const egress = validateEgressHosts(egressHosts);
    if (!egress.ok) {
      return { ok: false, error: "VALIDATION_FAILED", detail: egress.detail };
    }

    // Path containment: resolve to an absolute path and ensure it is inside pluginsRoot.
    // This prevents path traversal (../../etc/passwd) and loading arbitrary files.
    const absPath = resolvePath(sourcePath);
    const root = resolvePath(this.deps.pluginsRoot);
    if (!absPath.startsWith(root + "/") && absPath !== root) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        detail: `sourcePath '${sourcePath}' resolves to '${absPath}' which is outside the allowed plugins root '${root}'`,
      };
    }

    if (!existsSync(absPath)) {
      return { ok: false, error: "FILE_NOT_FOUND", detail: `No file at '${absPath}'` };
    }

    const pluginKind = inferPluginKind(absPath);
    if (!pluginKind) {
      return { ok: false, error: "VALIDATION_FAILED", detail: `Cannot determine plugin kind from extension: '${absPath}'` };
    }

    // Read + hash the source file once — reuse for both dry-load and final record
    let content: Buffer;
    try {
      content = readFileSync(absPath);
    } catch (cause) {
      return { ok: false, error: "FILE_NOT_FOUND", detail: `Cannot read '${absPath}': ${String(cause)}` };
    }

    const sourceHash = createHash("sha256").update(content).digest("hex");
    const installedAt = this.deps.now(); // captured once

    // Discover the plugin's declared name and secret refs.
    //
    // SECURITY: a 'typescript' plugin is arbitrary code. We must NOT execute it at install time —
    // otherwise a malicious plugin runs its top-level code the moment a user clicks "Install",
    // before the untrusted-code gate (which only guards enable()) ever applies. So for TypeScript
    // plugins we extract the name/refs STATICALLY from the source text (no execution). Only YAML —
    // which is safe-by-construction (declarative, no eval) — gets the code path via a dry-load.
    let secretRefs: string[] = [];
    let resolvedName = inferName(absPath);
    const staticFromText = () => {
      const text = content.toString("utf-8");
      secretRefs = extractSecretRefsFromText(text);
      const nameMatch = text.match(/^name:\s*(.+)$/m) ?? text.match(/name\s*[:=]\s*["'`]([a-z][a-z0-9._-]*)["'`]/);
      if (nameMatch?.[1]) resolvedName = nameMatch[1].trim();
    };
    if (pluginKind === "typescript") {
      // Never execute untrusted plugin code to read its name — extract statically.
      staticFromText();
    } else {
      const dryResult = await this.deps.factory.load(
        {
          kind: "installed",
          name: resolvedName,
          pluginKind,
          sourcePath: absPath,
          sourceHash,
          secretRefs: [],
          version,
          installedAt,
        },
        { resolve: () => undefined, validateRefs: (_refs) => ({ ok: true as const }) },
      );
      if (dryResult.ok) {
        resolvedName = dryResult.plugin.name;
      } else {
        staticFromText();
      }
    }

    // Validate the resolved name against the canonical plugin name format.
    // This applies to ALL plugin kinds — YAML goes through validateYamlCapability,
    // but TypeScript plugins self-declare their name and must also pass this guard.
    if (!/^[a-z][a-z0-9._-]*$/.test(resolvedName)) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        detail: `Plugin name '${resolvedName}' is invalid — must match [a-z][a-z0-9._-]* (e.g. 'text.transform', 'stripe.charge')`,
      };
    }

    const existingByCapName = this.deps.repository.get(resolvedName);
    if (existingByCapName) {
      return { ok: false, error: "ALREADY_INSTALLED", detail: `Plugin '${resolvedName}' is already installed (status: ${existingByCapName.kind})` };
    }

    const record: PersistedPluginRecord = {
      kind: "installed",
      name: resolvedName,
      pluginKind,
      sourcePath: absPath,
      sourceHash,
      secretRefs,
      ...(egress.hosts.length > 0 ? { egressHosts: egress.hosts } : {}),
      version,
      installedAt,
    };

    const payload: PluginEventPayload = {
      pluginName: record.name,
      pluginKind: record.pluginKind,
      version: record.version,
      sourceHash: record.sourceHash,
      actorId: owner,
      // Record the declared egress allowlist in the tamper-evident ledger event.
      ...(egress.hosts.length > 0 ? { egressHosts: egress.hosts } : {}),
    };

    this.atomicSaveWithEvent(record, "PluginInstalled", payload);

    log.info({ plugin: record.name, kind: pluginKind, path: sourcePath }, "plugin installed");
    return { ok: true, record };
  }

  async enable(name: string, owner: OwnerId): Promise<PluginEnableResult> {
    const existing = this.deps.repository.get(name);
    if (!existing) {
      return { ok: false, error: "NOT_FOUND", detail: `No plugin named '${name}'` };
    }
    if (existing.kind === "enabled") {
      return { ok: false, error: "ALREADY_ENABLED", detail: `Plugin '${name}' is already enabled` };
    }

    // Source file must exist — absence is an explicit error, not a silent pass-through
    if (!existsSync(existing.sourcePath)) {
      return { ok: false, error: "LOAD_FAILED", detail: `Source file missing: '${existing.sourcePath}'. Re-install to restore.` };
    }

    // Verify source hash — file must match what was recorded at install time
    const currentHash = createHash("sha256").update(readFileSync(existing.sourcePath)).digest("hex");
    if (currentHash !== existing.sourceHash) {
      return {
        ok: false,
        error: "SOURCE_CHANGED",
        detail: `Plugin '${name}' source changed since install (stored: ${existing.sourceHash.slice(0, 8)}, current: ${currentHash.slice(0, 8)}). Re-install to pick up changes.`,
      };
    }

    // SECURITY: a 'typescript' plugin is arbitrary code. The worker it runs in is
    // thread isolation, NOT a security sandbox — an enabled TS plugin has full host
    // access. So enabling one is gated behind an explicit operator opt-in; without it,
    // only declarative (YAML) and MCP capabilities run. (Removed once a real sandbox
    // ships — see docs/SANDBOX_PLAN.md.)
    if (existing.pluginKind === "typescript" && process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"] !== "1") {
      return {
        ok: false,
        error: "UNTRUSTED_BLOCKED",
        detail: `Plugin '${name}' runs untrusted code (TypeScript/JS) with full host access — not yet sandboxed. Enable only code you trust by setting KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1.`,
      };
    }

    // Validate secrets before loading
    if (existing.secretRefs.length > 0) {
      const validation = this.deps.broker.validateRefs(existing.secretRefs);
      if (!validation.ok) {
        return { ok: false, error: "MISSING_SECRETS", detail: `Missing secrets: ${validation.missing.join(", ")}` };
      }
    }

    // Load the plugin
    const factoryResult = await this.deps.factory.load(existing, this.deps.broker);
    if (!factoryResult.ok) {
      return { ok: false, error: "LOAD_FAILED", detail: factoryResult.detail };
    }

    const now = this.deps.now();
    const enabledRecord: PersistedEnabledPlugin = {
      kind: "enabled",
      name: existing.name,
      pluginKind: existing.pluginKind,
      sourcePath: existing.sourcePath,
      sourceHash: existing.sourceHash,
      secretRefs: existing.secretRefs,
      ...(existing.egressHosts && existing.egressHosts.length > 0 ? { egressHosts: existing.egressHosts } : {}),
      version: existing.version,
      installedAt: existing.installedAt,
      enabledAt: now,
    };

    const payload: PluginEventPayload = {
      pluginName: existing.name,
      pluginKind: existing.pluginKind,
      version: existing.version,
      sourceHash: existing.sourceHash,
      actorId: owner,
    };

    // DB commit first — snapshot swap only after successful commit
    this.atomicSaveWithEvent(enabledRecord, "PluginEnabled", payload);

    const next = new Map(this.liveSnapshot);
    next.set(existing.name, factoryResult.plugin);
    this.liveSnapshot = next;
    this.deps.snapshotHandle.replaceSnapshot(next);

    log.info({ plugin: existing.name }, "plugin enabled");
    return { ok: true, record: { ...enabledRecord, capability: factoryResult.plugin } };
  }

  async disable(name: string, owner: OwnerId, reason?: string): Promise<PluginDisableResult> {
    const existing = this.deps.repository.get(name);
    if (!existing) {
      return { ok: false, error: "NOT_FOUND", detail: `No plugin named '${name}'` };
    }
    if (existing.kind !== "enabled") {
      return { ok: false, error: "NOT_ENABLED", detail: `Plugin '${name}' is not enabled (status: ${existing.kind})` };
    }

    const now = this.deps.now();
    const disabledRecord: DisabledPlugin = {
      kind: "disabled",
      name: existing.name,
      pluginKind: existing.pluginKind,
      sourcePath: existing.sourcePath,
      sourceHash: existing.sourceHash,
      secretRefs: existing.secretRefs,
      ...(existing.egressHosts && existing.egressHosts.length > 0 ? { egressHosts: existing.egressHosts } : {}),
      version: existing.version,
      installedAt: existing.installedAt,
      disabledAt: now,
      reason,
    };

    const payload: PluginEventPayload = {
      pluginName: existing.name,
      pluginKind: existing.pluginKind,
      version: existing.version,
      sourceHash: existing.sourceHash,
      actorId: owner,
      ...(reason ? { reason } : {}),
    };

    // DB commit first — snapshot swap only after successful commit
    this.atomicSaveWithEvent(disabledRecord, "PluginDisabled", payload);

    // Hard-cut: remove from snapshot. In-flight calls that already hold a reference
    // to the old snapshot complete normally (JS single-threaded pointer swap).
    const evicted = this.liveSnapshot.get(name);
    const next = new Map(this.liveSnapshot);
    next.delete(name);
    this.liveSnapshot = next;
    this.deps.snapshotHandle.replaceSnapshot(next);

    // Teardown after snapshot swap so no new calls can reach the worker.
    if (evicted && hasTeardown(evicted)) evicted.teardown();

    log.info({ plugin: name, reason }, "plugin disabled");
    return { ok: true, record: disabledRecord };
  }

  async uninstall(name: string, owner: OwnerId): Promise<PluginUninstallResult> {
    const existing = this.deps.repository.get(name);
    if (!existing) {
      return { ok: false, error: "NOT_FOUND", detail: `No plugin named '${name}'` };
    }

    // Check for pending commitments across ALL tenants — not just 'system'.
    // Real agent runs write EffectRequested under per-agent tenantIds.
    const pendingCheck = this.deps.db
      .prepare(`
        SELECT COUNT(*) as count FROM events
        WHERE json_extract(event_json, '$.type') = 'EffectRequested'
          AND json_extract(event_json, '$.payload.capability') = ?
          AND NOT EXISTS (
            SELECT 1 FROM events e2
            WHERE json_extract(e2.event_json, '$.type') = 'EffectResult'
              AND json_extract(e2.event_json, '$.payload.idem') = json_extract(events.event_json, '$.payload.idem')
          )
      `)
      .get(name) as { count: number };

    if (pendingCheck.count > 0) {
      return {
        ok: false,
        error: "PENDING_COMMITMENTS",
        detail: `Plugin '${name}' has ${pendingCheck.count} EffectRequested event(s) with no matching EffectResult. Wait for them to complete or fail.`,
      };
    }

    const payload: PluginEventPayload = {
      pluginName: existing.name,
      pluginKind: existing.pluginKind,
      version: existing.version,
      sourceHash: existing.sourceHash,
      actorId: owner,
    };

    // DB commit (ledger event + row delete) FIRST — snapshot swap only after success
    this.atomicDeleteWithEvent(name, "PluginUninstalled", payload);

    // Only mutate the live snapshot after the transaction succeeds
    let evicted: CapabilityPlugin | undefined;
    if (existing.kind === "enabled") {
      evicted = this.liveSnapshot.get(name);
      const next = new Map(this.liveSnapshot);
      next.delete(name);
      this.liveSnapshot = next;
      this.deps.snapshotHandle.replaceSnapshot(next);
    }

    // Teardown after snapshot swap so no new calls can reach the worker.
    if (evicted && hasTeardown(evicted)) evicted.teardown();

    log.info({ plugin: name }, "plugin uninstalled");
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private atomicSaveWithEvent(record: PersistedPluginRecord, eventType: EventType, payload: unknown): void {
    atomicPluginWrite(
      { db: this.deps.db, signer: this.deps.signer, now: this.deps.now },
      eventType,
      payload,
      () => this.deps.repository.save(record),
    );
  }

  private atomicDeleteWithEvent(deleteKey: string, eventType: EventType, payload: unknown): void {
    atomicPluginWrite(
      { db: this.deps.db, signer: this.deps.signer, now: this.deps.now },
      eventType,
      payload,
      () => this.deps.repository.remove(deleteKey),
    );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function inferPluginKind(sourcePath: string): PluginKind | null {
  if (sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml")) return "yaml";
  if (sourcePath.endsWith(".ts") || sourcePath.endsWith(".js")) return "typescript";
  return null;
}

function inferName(sourcePath: string): string {
  const base = sourcePath.split("/").pop() ?? sourcePath;
  return base.replace(/\.(yaml|yml|ts|js)$/, "");
}

function extractSecretRefsFromText(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g)) {
    if (m[1]) refs.add(m[1]);
  }
  return [...refs];
}

/** A hostname is a dotted label sequence (a.b.c) — no scheme, port, path, wildcard, or IP-literal junk. */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Validate + normalize a declared egress allowlist. Each entry must be a plain lowercase
 * hostname (no scheme/port/path). Returns the deduped, lowercased set or an error string.
 * Deny-by-default lives downstream; this just rejects malformed declarations early so a
 * plugin can never be installed with a bogus "*" / "http://evil" / "1.2.3.4" allowlist.
 */
export function validateEgressHosts(raw: ReadonlyArray<string> | undefined): { ok: true; hosts: string[] } | { ok: false; detail: string } {
  if (!raw || raw.length === 0) return { ok: true, hosts: [] };
  const out = new Set<string>();
  for (const entry of raw) {
    const h = String(entry).trim().toLowerCase();
    if (h === "") continue;
    if (!HOST_RE.test(h)) {
      return { ok: false, detail: `Invalid egress host '${entry}' — must be a bare hostname like 'api.stripe.com' (no scheme, port, path, wildcard, or IP literal)` };
    }
    out.add(h);
  }
  return { ok: true, hosts: [...out] };
}
