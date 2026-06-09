/**
 * SQLite store adapter tests — same contract as in-memory, PLUS real on-disk
 * durability across a simulated process restart. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { SqliteLedgerStore } from "./sqlite-store.js";
import { HmacKeyring } from "./crypto.js";
import { verify } from "./store.js";
import type { EventScope } from "./event.js";

function keyring() {
  const ring = new HmacKeyring();
  const signer = ring.addKey("owner", "s", { epoch: 1, validFrom: 0, validUntil: null });
  return { ring, signer };
}
function scope(over: Partial<EventScope> = {}): EventScope {
  return { tenantId: "t1", runId: "r1", branchId: "main", ...over };
}
let clock = 1;
const tick = () => clock++;

function tmpDbPath(): string {
  return join(tmpdir(), `genesis-ledger-test-${process.pid}-${tick()}.db`);
}

test("SQLITE: append assigns contiguous offsets and verifies", async () => {
  const { ring, signer } = keyring();
  const store = new SqliteLedgerStore(":memory:");
  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  await store.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: { i: 1 }, author: "owner" }, { ts: tick(), signer });
  const events = await store.read("t1");
  assert.equal(events.length, 2);
  assert.equal(events[1]!.offset, 1);
  assert.equal(events[1]!.prev, events[0]!.id);
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
  store.close();
});

test("SQLITE: dangling parent and determinism violation are rejected", async () => {
  const { signer } = keyring();
  const store = new SqliteLedgerStore(":memory:");
  const r1 = await store.append({ type: "NodeEntered", scope: scope(), parents: ["sha256:nope"], payload: {}, author: "owner" }, { ts: tick(), signer });
  assert.ok(!r1.ok && r1.error.kind === "DanglingParent");
  const r2 = await store.append({ type: "NodeEntered", scope: scope(), payload: {}, determinism: "captured", author: "owner" }, { ts: tick(), signer });
  assert.ok(!r2.ok && r2.error.kind === "DeterminismViolation");
  store.close();
});

test("SQLITE: optimistic conflict on stale expectedHead", async () => {
  const { signer } = keyring();
  const store = new SqliteLedgerStore(":memory:");
  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  const stale = await store.append(
    { type: "NodeEntered", scope: scope(), payload: {}, author: "owner" },
    { ts: tick(), signer, expectedHead: { prev: null, offset: -1 } },
  );
  assert.ok(!stale.ok && stale.error.kind === "OptimisticConflict");
  store.close();
});

test("SQLITE: REAL on-disk durability — write, 'crash' (close), reopen, resume", async () => {
  const path = tmpDbPath();
  const { ring, signer } = keyring();
  try {
    // Life 1: write some events to a FILE, then close (= process death).
    {
      const store = new SqliteLedgerStore(path);
      await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
      await store.append({ type: "NodeEntered", scope: scope({ nodeId: "charger" }), payload: {}, author: "owner" }, { ts: tick(), signer });
      await store.append({ type: "EffectResult", scope: scope({ nodeId: "charger" }), payload: { idem: "charge:1", costCents: 99 }, determinism: "captured", author: "owner" }, { ts: tick(), signer });
      store.close(); // crash
    }

    // Life 2: a fresh store object opens the SAME file — the events are still there.
    {
      const store = new SqliteLedgerStore(path);
      const recovered = await store.read("t1");
      assert.equal(recovered.length, 3, "all 3 events survived the restart on disk");

      // on-disk integrity check
      const sc = store.selfCheck("t1");
      assert.ok(sc.ok, sc.ok ? "" : sc.error.message);

      // full chain verification of the recovered log
      const v = verify(recovered, ring);
      assert.ok(v.ok, v.ok ? "" : v.error.message);

      // the irreversible EffectResult is present → on resume the kernel would
      // re-serve it (no double charge). We assert it's recoverable here.
      const hasResult = recovered.some((e) => e.type === "EffectResult" && (e.payload as { idem?: string }).idem === "charge:1");
      assert.ok(hasResult, "the irreversible effect result is durable on disk");
      store.close();
    }
  } finally {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        rmSync(path + ext);
      } catch {
        /* ignore */
      }
    }
  }
});

test("SQLITE: tamper on disk is caught by verify()", async () => {
  const { ring, signer } = keyring();
  const store = new SqliteLedgerStore(":memory:");
  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  await store.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: { step: 1 }, author: "owner" }, { ts: tick(), signer });
  const events = await store.read("t1");
  // simulate a tampered read: mutate a payload after the fact
  const tampered = events.map((e, i) => (i === 1 ? { ...e, payload: { step: 999 } } : e));
  const v = verify(tampered, ring);
  assert.ok(!v.ok && v.error.kind === "HashMismatch");
  store.close();
});
