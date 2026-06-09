/**
 * Plugin system ports (interfaces).
 *
 * Defines all boundaries before any concrete implementation. No infrastructure
 * imports here — these are pure contracts.
 */

import type { CapabilityPlugin } from "../capability/capability.js";
import type { PluginKind, PersistedPluginRecord, PluginRecord } from "./types.js";

// ── Owner identity ────────────────────────────────────────────────────────────

/**
 * Opaque owner identifier — must match [a-z][a-z0-9_-]{1,63}.
 * Validated by assertValidOwnerId() before being written to the audit log.
 * Using a branded type so callers cannot accidentally pass arbitrary strings.
 */
export type OwnerId = string & { readonly __brand: "OwnerId" };

const OWNER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * Validate and brand an owner string. Call this at the API/service boundary
 * before passing the value into any lifecycle operation.
 * Throws with a descriptive message on invalid input.
 */
export function parseOwnerId(raw: string): OwnerId {
  if (!OWNER_ID_RE.test(raw)) {
    throw new Error(
      `Invalid OwnerId '${raw}' — must match [a-z][a-z0-9_-]{1,63} (e.g. 'alice', 'system-agent', 'owner-demo')`,
    );
  }
  return raw as OwnerId;
}

// ── Secret broker port ────────────────────────────────────────────────────────

export interface SecretBrokerPort {
  /** Validate that all named secret refs are registered (call before enable). */
  validateRefs(refs: ReadonlyArray<string>): { ok: true } | { ok: false; missing: string[] };
  /** Resolve a single secret ref to its value (called only inside plugin invoke). */
  resolve(ref: string): string | undefined;
}

// ── Plugin repository port ────────────────────────────────────────────────────

export interface PluginRepository {
  /** Persist a new or updated plugin record. */
  save(record: PersistedPluginRecord): void;
  /** Load a single record by name (returns undefined if not found). */
  get(name: string): PersistedPluginRecord | undefined;
  /** All records, any status. */
  list(): PersistedPluginRecord[];
  /** Only enabled records. */
  listEnabled(): PersistedPluginRecord[];
  /** Hard-delete a record. Caller must have written the PluginUninstalled event first. */
  remove(name: string): void;
}

// ── Plugin loader strategy port ───────────────────────────────────────────────

export interface PluginLoaderStrategy {
  readonly kind: PluginKind;
  /** Load a persisted record into a live CapabilityPlugin. Pure (no DB, no lifecycle). */
  load(
    record: PersistedPluginRecord,
    resolveSecret: (ref: string) => string | undefined,
  ): Promise<CapabilityPlugin>;
}

// ── Lifecycle service port (the public Facade) ────────────────────────────────

export interface PluginLifecyclePort {
  /**
   * Install a plugin from a file path. Reads + hashes the file, registers the
   * record. Does NOT enable — the plugin is not loaded into the Supervisor yet.
   */
  install(sourcePath: string, version: string, owner: OwnerId): Promise<PluginInstallResult>;

  /**
   * Load the plugin, validate secrets, swap into the Supervisor's live snapshot.
   * Idempotent if already enabled.
   */
  enable(name: string, owner: OwnerId): Promise<PluginEnableResult>;

  /**
   * Remove from the Supervisor's live snapshot. In-flight calls that already hold
   * the old snapshot complete normally (JS single-threaded: pointer swap is atomic).
   */
  disable(name: string, owner: OwnerId, reason?: string): Promise<PluginDisableResult>;

  /**
   * Hard-delete the registry row. Fails if there are open EffectRequested events
   * with no matching EffectResult (pending commitments).
   */
  uninstall(name: string, owner: OwnerId): Promise<PluginUninstallResult>;
}

// ── Result types ──────────────────────────────────────────────────────────────

export type PluginInstallResult =
  | { ok: true; record: PluginRecord }
  | { ok: false; error: "ALREADY_INSTALLED" | "FILE_NOT_FOUND" | "LOAD_FAILED" | "VALIDATION_FAILED"; detail: string };

export type PluginEnableResult =
  | { ok: true; record: PluginRecord }
  | { ok: false; error: "NOT_FOUND" | "ALREADY_ENABLED" | "MISSING_SECRETS" | "LOAD_FAILED" | "SOURCE_CHANGED"; detail: string };

export type PluginDisableResult =
  | { ok: true; record: PluginRecord }
  | { ok: false; error: "NOT_FOUND" | "NOT_ENABLED"; detail: string };

export type PluginUninstallResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" | "PENDING_COMMITMENTS"; detail: string };
