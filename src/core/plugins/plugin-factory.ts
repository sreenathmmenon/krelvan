/**
 * PluginFactory — pure construction, zero knowledge of Registry or Supervisor.
 *
 * Dispatches by pluginKind via a Map<PluginKind, PluginLoaderStrategy>.
 * Returns a typed result (not a throw) so callers can handle failure gracefully.
 */

import type { CapabilityPlugin } from "../capability/capability.js";
import type { PluginLoaderStrategy, SecretBrokerPort } from "./ports.js";
import type { PersistedPluginRecord, PluginKind } from "./types.js";

export type FactoryResult =
  | { ok: true; plugin: CapabilityPlugin }
  | { ok: false; error: "MISSING_STRATEGY" | "LOAD_FAILED"; detail: string };

export class PluginFactory {
  private readonly strategies: Map<PluginKind, PluginLoaderStrategy>;

  constructor(strategies: Map<PluginKind, PluginLoaderStrategy>) {
    this.strategies = strategies;
  }

  async load(record: PersistedPluginRecord, broker: SecretBrokerPort): Promise<FactoryResult> {
    const strategy = this.strategies.get(record.pluginKind);
    if (!strategy) {
      return {
        ok: false,
        error: "MISSING_STRATEGY",
        detail: `No loader registered for pluginKind '${record.pluginKind}'`,
      };
    }

    try {
      const plugin = await strategy.load(record, (ref) => broker.resolve(ref));
      return { ok: true, plugin };
    } catch (cause) {
      return {
        ok: false,
        error: "LOAD_FAILED",
        detail: String(cause),
      };
    }
  }
}
