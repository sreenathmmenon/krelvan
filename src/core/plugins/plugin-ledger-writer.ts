/**
 * PluginLedgerWriter — shared helper for writing plugin lifecycle events to the
 * ledger synchronously within an already-open SQLite transaction.
 *
 * Both PluginActivator and PluginLifecycleService used identical copies of
 * appendLedgerEventSync. This module is the single authoritative implementation.
 *
 * The writer is NOT a service — it has no state of its own. It is a pure procedure
 * called inside an already-open BEGIN IMMEDIATE block, so atomicity belongs to
 * the caller.
 */

import { DatabaseSync } from "node:sqlite";
import { computeId, type EventPreimage, type EventType } from "../ledger/event.js";
import type { Signer } from "../ledger/crypto.js";

const PLUGIN_TENANT_ID = "system";
const PLUGIN_RUN_ID = "plugin-lifecycle";
const PLUGIN_BRANCH_ID = "main";

export { PLUGIN_TENANT_ID, PLUGIN_RUN_ID, PLUGIN_BRANCH_ID };

export interface PluginLedgerWriterDeps {
  db: DatabaseSync;
  signer: Signer;
  now: () => number;
}

/**
 * Insert one plugin lifecycle event in the current open transaction.
 * Must be called inside BEGIN IMMEDIATE / COMMIT; does not manage its own transaction.
 */
export function appendPluginEvent(deps: PluginLedgerWriterDeps, type: EventType, payload: unknown): void {
  const ts = deps.now();
  const author = deps.signer.descriptor.keyId;

  const headRow = deps.db
    .prepare("SELECT id, offset FROM events WHERE tenant_id = ? ORDER BY offset DESC LIMIT 1")
    .get(PLUGIN_TENANT_ID) as { id: string; offset: number } | undefined;

  const prevId: string | null = headRow?.id ?? null;
  const nextOffset = headRow ? headRow.offset + 1 : 0;

  const preimage: EventPreimage<unknown> = {
    type,
    scope: { tenantId: PLUGIN_TENANT_ID, runId: PLUGIN_RUN_ID, branchId: PLUGIN_BRANCH_ID },
    parents: [],
    prev: prevId,
    offset: nextOffset,
    payload,
    determinism: "pure",
    ts,
    author,
  };

  const id = computeId(preimage);
  const sig = deps.signer.sign(id, ts);
  const stored = { ...preimage, id, sig };

  deps.db
    .prepare("INSERT INTO events (tenant_id, offset, id, event_json) VALUES (?, ?, ?, ?)")
    .run(PLUGIN_TENANT_ID, nextOffset, id, JSON.stringify(stored));
}

/**
 * Atomically write a ledger event + a registry operation in one BEGIN IMMEDIATE block.
 * `registryFn` is called inside the transaction — it should call repository.save() or .remove().
 * Rolls back and rethrows on any failure.
 */
export function atomicPluginWrite(
  deps: PluginLedgerWriterDeps,
  eventType: EventType,
  payload: unknown,
  registryFn: () => void,
): void {
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    appendPluginEvent(deps, eventType, payload);
    registryFn();
    deps.db.exec("COMMIT");
  } catch (cause) {
    try { deps.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw cause;
  }
}
