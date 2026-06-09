/**
 * PluginActivator — startup Application Service.
 *
 * Loads all 'enabled' records from the registry at startup, verifies source hashes,
 * and returns a ReadonlyMap<string, CapabilityPlugin> for the Supervisor's initial
 * snapshot. When a plugin fails to load:
 *   - its DB record is updated to 'disabled' (so it doesn't retry on every restart)
 *   - a PluginLoadFailed ledger event is written
 *   - startup continues (one bad plugin must not prevent the system from starting)
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EventType } from "../ledger/event.js";
import type { Signer } from "../ledger/crypto.js";
import { atomicPluginWrite } from "./plugin-ledger-writer.js";
import { getLogger } from "../observability/logger.js";
import type { PluginFactory } from "./plugin-factory.js";
import type { PluginRepository, SecretBrokerPort } from "./ports.js";
import type { CapabilityPlugin } from "../capability/capability.js";
import type { PersistedPluginRecord, DisabledPlugin } from "./types.js";

const log = getLogger("plugin-activator");

export interface ActivatorDeps {
  repository: PluginRepository;
  factory: PluginFactory;
  broker: SecretBrokerPort;
  /** Shared DatabaseSync for writing PluginLoadFailed events. */
  db: DatabaseSync;
  signer: Signer;
  now: () => number;
}

export class PluginActivator {
  constructor(private readonly deps: ActivatorDeps) {}

  async loadAll(): Promise<ReadonlyMap<string, CapabilityPlugin>> {
    const enabled = this.deps.repository.listEnabled();
    const result = new Map<string, CapabilityPlugin>();

    for (const record of enabled) {
      const loaded = await this.loadOne(record);
      if (loaded) {
        result.set(record.name, loaded);
      }
    }

    log.info({ count: result.size, total: enabled.length }, "plugins activated at startup");
    return result;
  }

  private async loadOne(record: PersistedPluginRecord): Promise<CapabilityPlugin | null> {
    // File must exist
    if (!existsSync(record.sourcePath)) {
      const detail = `Source file missing: '${record.sourcePath}'`;
      log.warn({ plugin: record.name, path: record.sourcePath }, detail);
      this.failPlugin(record, detail);
      return null;
    }

    // Hash must match what was recorded at install time
    const currentHash = hashFile(record.sourcePath);
    if (currentHash !== record.sourceHash) {
      const detail = `Source hash mismatch (stored: ${record.sourceHash.slice(0, 8)}, current: ${currentHash.slice(0, 8)}) — source changed since install`;
      log.warn({ plugin: record.name, stored: record.sourceHash, current: currentHash }, detail);
      this.failPlugin(record, detail);
      return null;
    }

    const result = await this.deps.factory.load(record, this.deps.broker);
    if (!result.ok) {
      const detail = `Load failed: ${result.detail}`;
      log.warn({ plugin: record.name, error: result.error, detail: result.detail }, "plugin failed to load at startup");
      this.failPlugin(record, detail);
      return null;
    }

    log.info({ plugin: record.name, kind: record.pluginKind }, "plugin loaded");
    return result.plugin;
  }

  /**
   * Mark a plugin as disabled in the DB and write a PluginLoadFailed ledger event.
   * Wrapped in its own transaction so a failure here doesn't block startup.
   */
  private failPlugin(record: PersistedPluginRecord, reason: string): void {
    try {
      const now = this.deps.now();
      const disabledRecord: DisabledPlugin = {
        kind: "disabled",
        name: record.name,
        pluginKind: record.pluginKind,
        sourcePath: record.sourcePath,
        sourceHash: record.sourceHash,
        secretRefs: record.secretRefs,
        version: record.version,
        installedAt: record.installedAt,
        disabledAt: now,
        reason,
      };
      atomicPluginWrite(
        { db: this.deps.db, signer: this.deps.signer, now: this.deps.now },
        "PluginLoadFailed",
        { pluginName: record.name, pluginKind: record.pluginKind, version: record.version, sourceHash: record.sourceHash, reason },
        () => this.deps.repository.save(disabledRecord),
      );
    } catch (cause) {
      log.error({ plugin: record.name, cause: String(cause) }, "failed to write PluginLoadFailed event — continuing startup");
    }
  }
}

export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}
