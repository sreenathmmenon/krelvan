/**
 * Plugin lifecycle discriminated union types.
 *
 * Three live states only: installed | enabled | disabled.
 * 'uninstalled' is never persisted — uninstall() hard-deletes the row and writes
 * a PluginUninstalled ledger event. The registry is not an audit log; the ledger is.
 *
 * Illegal states are structurally unrepresentable:
 *   - Only EnabledPlugin carries a live CapabilityPlugin reference
 *   - A disabled or installed plugin cannot be dispatched to
 *   - Transitions are enforced by PluginLifecycleService, not by a runtime guard
 */

import type { CapabilityPlugin } from "../capability/capability.js";

export type PluginKind = "yaml" | "typescript";
// 'npm' intentionally absent — requires Worker thread sandbox boundary (v2)

/** Shared fields across all plugin lifecycle states. */
type PluginBase = {
  readonly name: string;
  readonly pluginKind: PluginKind;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly secretRefs: ReadonlyArray<string>;
  readonly version: string;
  readonly installedAt: number;
};

export type InstalledPlugin = PluginBase & {
  readonly kind: "installed";
};

export type EnabledPlugin = PluginBase & {
  readonly kind: "enabled";
  /** Only this variant carries a live CapabilityPlugin reference. */
  readonly capability: CapabilityPlugin;
  readonly enabledAt: number;
};

export type DisabledPlugin = PluginBase & {
  readonly kind: "disabled";
  readonly disabledAt: number;
  readonly reason?: string;
};

export type PluginRecord = InstalledPlugin | EnabledPlugin | DisabledPlugin;

// ── Type guards ───────────────────────────────────────────────────────────────

export function isInstalled(r: PluginRecord): r is InstalledPlugin {
  return r.kind === "installed";
}

export function isEnabled(r: PluginRecord): r is EnabledPlugin {
  return r.kind === "enabled";
}

export function isDisabled(r: PluginRecord): r is DisabledPlugin {
  return r.kind === "disabled";
}

/** Runtime guard: throws if the object is not a CapabilityPlugin. */
export function assertIsCapabilityPlugin(obj: unknown, pluginName: string): asserts obj is CapabilityPlugin {
  if (
    typeof obj !== "object" ||
    obj === null ||
    typeof (obj as Record<string, unknown>)["name"] !== "string" ||
    typeof (obj as Record<string, unknown>)["sideEffect"] !== "string" ||
    typeof (obj as Record<string, unknown>)["estimateCents"] !== "function" ||
    typeof (obj as Record<string, unknown>)["invoke"] !== "function"
  ) {
    throw new Error(`Plugin '${pluginName}' does not implement CapabilityPlugin interface`);
  }
}

/** Enabled plugin without the live runtime reference — the shape stored in the DB. */
export type PersistedEnabledPlugin = PluginBase & {
  readonly kind: "enabled";
  readonly enabledAt: number;
};

/** A persisted record — only the fields that go to/from the DB (no live CapabilityPlugin reference). */
export type PersistedPluginRecord = InstalledPlugin | PersistedEnabledPlugin | DisabledPlugin;
