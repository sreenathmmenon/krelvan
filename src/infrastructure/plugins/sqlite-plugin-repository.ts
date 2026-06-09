/**
 * SQLite-backed plugin registry.
 *
 * Shares the same DatabaseSync instance as SqliteLedgerStore so lifecycle
 * operations can atomically write both a registry row AND a ledger event in
 * one BEGIN IMMEDIATE / COMMIT block. Two SQLite files would break this.
 *
 * Flat columns (no JSON blobs) for all queryable fields so status filters
 * are index-friendly. Non-queryable metadata is stored as JSON in `meta_json`.
 */

import { DatabaseSync } from "node:sqlite";
import type { PluginRepository } from "../../core/plugins/ports.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";

export const PLUGIN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plugin_records (
    name          TEXT    PRIMARY KEY,
    plugin_kind   TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    source_path   TEXT    NOT NULL,
    source_hash   TEXT    NOT NULL,
    version       TEXT    NOT NULL,
    installed_at  INTEGER NOT NULL,
    enabled_at    INTEGER,
    disabled_at   INTEGER,
    disable_reason TEXT,
    secret_refs   TEXT    NOT NULL DEFAULT '[]',
    meta_json     TEXT    NOT NULL DEFAULT '{}'
  );
`;

interface PluginRow {
  name: string;
  plugin_kind: string;
  status: string;
  source_path: string;
  source_hash: string;
  version: string;
  installed_at: number;
  enabled_at: number | null;
  disabled_at: number | null;
  disable_reason: string | null;
  secret_refs: string;
}

function rowToRecord(row: PluginRow): PersistedPluginRecord {
  const base = {
    name: row.name,
    pluginKind: row.plugin_kind as "yaml" | "typescript",
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    secretRefs: JSON.parse(row.secret_refs) as string[],
    version: row.version,
    installedAt: row.installed_at,
  };

  switch (row.status) {
    case "installed":
      return { ...base, kind: "installed" };
    case "enabled": {
      if (row.enabled_at === null) {
        throw new Error(`Corrupt plugin record: '${row.name}' has status='enabled' but enabled_at IS NULL`);
      }
      return { ...base, kind: "enabled", enabledAt: row.enabled_at };
    }
    case "disabled": {
      if (row.disabled_at === null) {
        throw new Error(`Corrupt plugin record: '${row.name}' has status='disabled' but disabled_at IS NULL`);
      }
      return {
        ...base,
        kind: "disabled",
        disabledAt: row.disabled_at,
        reason: row.disable_reason ?? undefined,
      };
    }
    default:
      throw new Error(`Unknown plugin status in DB: '${row.status}' for plugin '${row.name}'`);
  }
}

export class SqlitePluginRepository implements PluginRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(PLUGIN_SCHEMA);
  }

  save(record: PersistedPluginRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO plugin_records
        (name, plugin_kind, status, source_path, source_hash, version,
         installed_at, enabled_at, disabled_at, disable_reason, secret_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        plugin_kind    = excluded.plugin_kind,
        status         = excluded.status,
        source_path    = excluded.source_path,
        source_hash    = excluded.source_hash,
        version        = excluded.version,
        installed_at   = excluded.installed_at,
        enabled_at     = excluded.enabled_at,
        disabled_at    = excluded.disabled_at,
        disable_reason = excluded.disable_reason,
        secret_refs    = excluded.secret_refs
    `);

    const enabledAt: number | null = record.kind === "enabled" ? record.enabledAt : null;
    const disabledAt: number | null = record.kind === "disabled" ? record.disabledAt : null;
    const disableReason: string | null = record.kind === "disabled" ? (record.reason ?? null) : null;

    stmt.run(
      record.name,
      record.pluginKind,
      record.kind,
      record.sourcePath,
      record.sourceHash,
      record.version,
      record.installedAt,
      enabledAt,
      disabledAt,
      disableReason,
      JSON.stringify(record.secretRefs),
    );
  }

  get(name: string): PersistedPluginRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM plugin_records WHERE name = ?")
      .get(name) as unknown as PluginRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): PersistedPluginRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM plugin_records ORDER BY installed_at ASC")
      .all() as unknown as PluginRow[];
    return rows.map(rowToRecord);
  }

  listEnabled(): PersistedPluginRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM plugin_records WHERE status = 'enabled' ORDER BY enabled_at ASC")
      .all() as unknown as PluginRow[];
    return rows.map(rowToRecord);
  }

  remove(name: string): void {
    this.db.prepare("DELETE FROM plugin_records WHERE name = ?").run(name);
  }
}
