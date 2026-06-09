/**
 * SQLite ledger store adapter — real on-disk durability behind the same LedgerStore
 * port as the in-memory adapter. Uses Node's built-in `node:sqlite` (zero
 * third-party dependency → license-clean, single-binary self-host).
 *
 * Guards:
 *  - LED-05: append is a transaction; a UNIQUE(tenant, offset) constraint makes the
 *    compare-and-set atomic — two racers can't both claim the same offset (no fork).
 *  - LED-06: offset = prev_offset + 1, computed inside the transaction, never a
 *    DB autoincrement that could skip.
 *  - durability: events are fsynced rows; a process restart re-reads them and the
 *    kernel resumes by folding — the on-disk equivalent of the in-memory proof.
 *
 * NOTE: node:sqlite is experimental in Node 22; we isolate it entirely here so the
 * rest of the core is unaffected and the adapter is swappable for Postgres later.
 */

import { DatabaseSync } from "node:sqlite";

import {
  computeId,
  determinismOk,
  preimageBytes,
  type EventPreimage,
  type Hash,
  type LedgerEvent,
  type NewEvent,
  type Offset,
} from "./event.js";
import { contentAddress } from "./crypto.js";
import { err, ok, type Result } from "./errors.js";
import type { AppendOptions, Head, LedgerStore } from "./store.js";

export class SqliteLedgerStore implements LedgerStore {
  /** Exposed so PluginLifecycleService can share the same handle for atomic plugin+ledger writes. */
  readonly db: DatabaseSync;

  /** path = ":memory:" for tests, or a file path for real durability. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        tenant_id   TEXT    NOT NULL,
        offset      INTEGER NOT NULL,
        id          TEXT    NOT NULL,
        event_json  TEXT    NOT NULL,
        PRIMARY KEY (tenant_id, offset)
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(tenant_id, json_extract(event_json,'$.scope.runId'), offset);
    `);
    // Durability: full fsync on commit.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  }

  async head(tenantId: string): Promise<Head> {
    const row = this.db
      .prepare("SELECT id, offset FROM events WHERE tenant_id = ? ORDER BY offset DESC LIMIT 1")
      .get(tenantId) as { id: string; offset: number } | undefined;
    if (!row) return { prev: null, offset: -1 };
    return { prev: row.id, offset: row.offset };
  }

  async append<P>(ev: NewEvent<P>, opts: AppendOptions): Promise<Result<LedgerEvent<P>>> {
    const tenantId = ev.scope.tenantId;
    const determinism = ev.determinism ?? "pure";

    // I7
    if (!determinismOk(ev.type, determinism)) {
      return err("DeterminismViolation", `event type ${ev.type} may not be 'captured'`);
    }
    // author must match signer
    if (ev.author !== opts.signer.descriptor.keyId) {
      return err("ScopeViolation", `event.author '${ev.author}' != signer keyId '${opts.signer.descriptor.keyId}'`);
    }

    // The whole append is one transaction so the CAS is atomic (LED-05/06).
    try {
      this.db.exec("BEGIN IMMEDIATE");

      const headRow = this.db
        .prepare("SELECT id, offset FROM events WHERE tenant_id = ? ORDER BY offset DESC LIMIT 1")
        .get(tenantId) as { id: string; offset: number } | undefined;
      const current: Head = headRow ? { prev: headRow.id, offset: headRow.offset } : { prev: null, offset: -1 };

      // §4 optimistic concurrency
      if (opts.expectedHead) {
        if (opts.expectedHead.prev !== current.prev || opts.expectedHead.offset !== current.offset) {
          this.db.exec("ROLLBACK");
          return err("OptimisticConflict", `expected head ${opts.expectedHead.offset} but current ${current.offset}`);
        }
      }

      // I5: parents must exist
      const parents = ev.parents ?? [];
      for (const p of parents) {
        const found = this.db.prepare("SELECT 1 FROM events WHERE tenant_id = ? AND id = ? LIMIT 1").get(tenantId, p);
        if (!found) {
          this.db.exec("ROLLBACK");
          return err("DanglingParent", `parent ${p} not present`, p);
        }
      }

      const offset: Offset = current.offset + 1; // LED-06

      const preimage: EventPreimage<P> = {
        type: ev.type,
        scope: ev.scope,
        parents,
        prev: current.prev,
        offset,
        payload: ev.payload,
        determinism,
        ts: opts.ts,
        author: ev.author,
      };

      let id: Hash;
      try {
        id = computeId(preimage);
      } catch (e) {
        this.db.exec("ROLLBACK");
        return err("CanonicalError", (e as Error).message);
      }

      const sig = opts.signer.sign(id, opts.ts);
      const stored: LedgerEvent<P> = { ...preimage, id, sig };

      // The UNIQUE(tenant, offset) primary key makes this the atomic CAS: if another
      // writer committed this offset first, the insert throws and we roll back.
      this.db
        .prepare("INSERT INTO events (tenant_id, offset, id, event_json) VALUES (?, ?, ?, ?)")
        .run(tenantId, offset, id, JSON.stringify(stored));

      this.db.exec("COMMIT");
      return ok(stored);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      const msg = (e as Error).message;
      // a PK collision means a concurrent writer won the offset → optimistic conflict
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) {
        return err("OptimisticConflict", `offset taken concurrently: ${msg}`);
      }
      return err("ScopeViolation", `append failed: ${msg}`);
    }
  }

  async read(tenantId: string): Promise<LedgerEvent[]> {
    const rows = this.db
      .prepare("SELECT event_json FROM events WHERE tenant_id = ? ORDER BY offset ASC")
      .all(tenantId) as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as LedgerEvent);
  }

  async readRun(tenantId: string, runId: string): Promise<LedgerEvent[]> {
    const all = await this.read(tenantId);
    return all.filter((e) => e.scope.runId === runId);
  }

  /** Recompute every stored event's id and check it matches (on-disk integrity). */
  selfCheck(tenantId: string): Result<true> {
    const events = this.readSync(tenantId);
    for (const e of events) {
      const recomputed = contentAddress(preimageBytes(e));
      if (recomputed !== e.id) {
        return err("HashMismatch", `on-disk event ${e.id} != recomputed ${recomputed}`, e.id);
      }
    }
    return ok(true);
  }

  private readSync(tenantId: string): LedgerEvent[] {
    const rows = this.db
      .prepare("SELECT event_json FROM events WHERE tenant_id = ? ORDER BY offset ASC")
      .all(tenantId) as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as LedgerEvent);
  }

  close(): void {
    this.db.close();
  }
}
