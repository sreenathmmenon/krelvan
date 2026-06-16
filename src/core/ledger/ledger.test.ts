/**
 * Ledger test suite — proves the guards in LEDGER_SPEC §5 and the LED-* premortem
 * items. Run: `npm test`.
 *
 * Each test names the guard/premortem id it covers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalize, CanonicalError } from "./canonical.js";
import { contentAddress } from "./crypto.js";
import { HmacKeyring, Ed25519Keyring, generateEd25519Keypair } from "./crypto.js";
import { computeId, determinismOk, preimageBytes, type EventScope, type LedgerEvent } from "./event.js";
import { InMemoryLedgerStore, verify, type Checkpoint } from "./store.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function keyring(): { ring: HmacKeyring; signer: ReturnType<HmacKeyring["addKey"]> } {
  const ring = new HmacKeyring();
  const signer = ring.addKey("owner", "test-secret", { epoch: 1, validFrom: 0, validUntil: null });
  return { ring, signer };
}

function scope(over: Partial<EventScope> = {}): EventScope {
  return { tenantId: "t1", runId: "r1", branchId: "main", ...over };
}

let clock = 1000;
const tick = () => clock++;

// ── LED-01 / LED-02: canonicalization ──────────────────────────────────────────

test("LED-01 canonical: key order does not matter, output is stable", () => {
  const a = canonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } });
  const b = canonicalize({ a: 2, nested: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b);
});

test("LED-01 canonical: idempotent through parse round-trip", () => {
  const v = { z: [3, 2, 1], msg: "héllo", ok: true, n: null };
  const c1 = canonicalize(v);
  const c2 = canonicalize(JSON.parse(c1));
  assert.equal(c1, c2);
});

test("LED-02 canonical: rejects floats", () => {
  assert.throws(() => canonicalize({ cost: 0.1 }), CanonicalError);
});

test("LED-02 canonical: rejects NaN/Infinity and bigint", () => {
  assert.throws(() => canonicalize({ x: NaN }), CanonicalError);
  assert.throws(() => canonicalize({ x: Infinity }), CanonicalError);
  assert.throws(() => canonicalize({ x: 10n }), CanonicalError);
});

test("LED-02 canonical: accepts safe integers, rejects unsafe", () => {
  assert.equal(canonicalize({ x: 42 }), '{"x":42}');
  assert.throws(() => canonicalize({ x: Number.MAX_SAFE_INTEGER + 2 }), CanonicalError);
});

// ── LED-03: id covers position, not just payload ───────────────────────────────

test("LED-03 id changes if prev/offset/scope change", () => {
  const base = {
    type: "NodeEntered" as const,
    scope: scope(),
    parents: [],
    prev: null,
    offset: 0,
    payload: { x: 1 },
    determinism: "pure" as const,
    ts: 1,
    author: "owner",
  };
  const id0 = computeId(base);
  assert.notEqual(id0, computeId({ ...base, offset: 1 }));
  assert.notEqual(id0, computeId({ ...base, prev: "sha256:deadbeef" }));
  assert.notEqual(id0, computeId({ ...base, scope: scope({ runId: "r2" }) }));
});

// ── I7 / LED determinism ───────────────────────────────────────────────────────

test("I7 determinism: only EffectResult may be captured", () => {
  assert.equal(determinismOk("EffectResult", "captured"), true);
  assert.equal(determinismOk("NodeEntered", "captured"), false);
  assert.equal(determinismOk("NodeEntered", "pure"), true);
});

// ── append: genesis, contiguity, signing ───────────────────────────────────────

test("spec-1 genesis event: prev null, offset 0", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const r = await store.append(
    { type: "RunStarted", scope: scope(), payload: {}, author: "owner" },
    { ts: tick(), signer },
  );
  assert.ok(r.ok);
  assert.equal(r.value.prev, null);
  assert.equal(r.value.offset, 0);
});

test("append assigns contiguous offsets and links prev", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const a = await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  const b = await store.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: {}, author: "owner" }, { ts: tick(), signer });
  assert.ok(a.ok && b.ok);
  assert.equal(b.value.offset, 1);
  assert.equal(b.value.prev, a.value.id);
});

test("spec-2 empty log verifies as ok", async () => {
  const { ring } = keyring();
  const store = new InMemoryLedgerStore();
  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok);
});

// ── I5: dangling parent rejected ────────────────────────────────────────────────

test("spec-4 dangling parent is rejected at append", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const r = await store.append(
    { type: "NodeEntered", scope: scope(), parents: ["sha256:nope"], payload: {}, author: "owner" },
    { ts: tick(), signer },
  );
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "DanglingParent");
});

// ── I7 at append ─────────────────────────────────────────────────────────────────

test("spec-6 determinism violation rejected at append", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const r = await store.append(
    { type: "NodeEntered", scope: scope(), payload: {}, determinism: "captured", author: "owner" },
    { ts: tick(), signer },
  );
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "DeterminismViolation");
});

test("EffectResult may be captured", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const r = await store.append(
    { type: "EffectResult", scope: scope(), payload: { out: "x" }, determinism: "captured", author: "owner" },
    { ts: tick(), signer },
  );
  assert.ok(r.ok);
});

// ── §4: optimistic concurrency ─────────────────────────────────────────────────

test("spec-7 optimistic conflict on stale expectedHead, succeeds on retry", async () => {
  const { signer } = keyring();
  const store = new InMemoryLedgerStore();
  const a = await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  assert.ok(a.ok);

  // stale head (genesis) — should conflict because head has moved to offset 0
  const stale = await store.append(
    { type: "NodeEntered", scope: scope(), payload: {}, author: "owner" },
    { ts: tick(), signer, expectedHead: { prev: null, offset: -1 } },
  );
  assert.ok(!stale.ok);
  assert.equal(stale.error.kind, "OptimisticConflict");

  // retry with fresh head succeeds
  const head = await store.head("t1");
  const retry = await store.append(
    { type: "NodeEntered", scope: scope(), payload: {}, author: "owner" },
    { ts: tick(), signer, expectedHead: head },
  );
  assert.ok(retry.ok);
  assert.equal(retry.value.offset, 1);
});

test("LED-05 concurrent appends produce no offset gaps or dups", async () => {
  const { ring, signer } = keyring();
  const store = new InMemoryLedgerStore();
  // fire 50 appends concurrently; the per-tenant lock serializes them
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.append({ type: "NodeEntered", scope: scope({ nodeId: `n${i}` }), payload: { i }, author: "owner" }, { ts: tick(), signer }),
    ),
  );
  const events = await store.read("t1");
  assert.equal(events.length, 50);
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
  // offsets are exactly 0..49
  events.forEach((e, i) => assert.equal(e.offset, i));
});

test("LED-09 a real ledger signed with Ed25519 verifies with the public key ALONE (non-repudiable)", async () => {
  // Sign a real append-chain with the asymmetric adapter…
  const signerRing = new Ed25519Keyring();
  const { privateKeyPem } = generateEd25519Keypair();
  const signer = signerRing.addKey("owner", privateKeyPem, { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  await store.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: {}, author: "owner" }, { ts: tick(), signer });
  const events = await store.read("t1");

  // …and verify the whole chain with a ring that holds ONLY the published public key.
  const auditor = new Ed25519Keyring();
  auditor.addPublicKey("owner", signerRing.exportPublicKey("owner", 1), { epoch: 1, validFrom: 0, validUntil: null });
  const v = verify(events, auditor);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

// ── verify(): tamper / corruption detection ─────────────────────────────────────

async function buildChain(): Promise<{ store: InMemoryLedgerStore; ring: HmacKeyring; events: LedgerEvent[] }> {
  const { ring, signer } = keyring();
  const store = new InMemoryLedgerStore();
  await store.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer });
  await store.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: { step: 1 }, author: "owner" }, { ts: tick(), signer });
  await store.append({ type: "NodeConcluded", scope: scope({ nodeId: "n1" }), payload: { ok: true }, author: "owner" }, { ts: tick(), signer });
  const events = await store.read("t1");
  return { store, ring, events };
}

test("spec-3 tamper: mutating a stored payload is caught (HashMismatch)", async () => {
  const { ring, events } = await buildChain();
  const tampered = events.map((e, i) =>
    i === 1 ? ({ ...e, payload: { step: 999 } } as LedgerEvent) : e,
  );
  const v = verify(tampered, ring);
  assert.ok(!v.ok);
  assert.equal(v.error.kind, "HashMismatch");
});

test("spec-3 tamper: forging an id without resigning is caught", async () => {
  const { ring, events } = await buildChain();
  // recompute a valid id for a changed payload but keep the OLD signature
  const e1 = events[1]!;
  const forgedPayload = { step: 42 };
  const forgedId = computeId({ ...e1, payload: forgedPayload });
  const forged = events.map((e, i) =>
    i === 1 ? ({ ...e, payload: forgedPayload, id: forgedId } as LedgerEvent) : e,
  );
  const v = verify(forged, ring);
  // chain breaks (next event's prev no longer matches) OR signature fails — both loud
  assert.ok(!v.ok);
  assert.ok(["BrokenChain", "BadSignature", "HashMismatch"].includes(v.error.kind));
});

test("spec-5 offset gap is detected", async () => {
  const { ring, events } = await buildChain();
  const withGap = [events[0]!, events[2]!]; // drop the middle → gap
  const v = verify(withGap, ring);
  assert.ok(!v.ok);
  assert.ok(["OffsetGap", "BrokenChain"].includes(v.error.kind));
});

test("LED-07 tail truncation detected via checkpoint", async () => {
  const { ring, signer, store } = await (async () => {
    const k = keyring();
    const s = new InMemoryLedgerStore();
    await s.append({ type: "RunStarted", scope: scope(), payload: {}, author: "owner" }, { ts: tick(), signer: k.signer });
    await s.append({ type: "NodeEntered", scope: scope({ nodeId: "n1" }), payload: {}, author: "owner" }, { ts: tick(), signer: k.signer });
    await s.append({ type: "EffectResult", scope: scope({ nodeId: "n1" }), payload: { spent: 5 }, determinism: "captured", author: "owner" }, { ts: tick(), signer: k.signer });
    return { ring: k.ring, signer: k.signer, store: s };
  })();

  const full = await store.read("t1");
  const head = full[full.length - 1]!;
  const checkpoint: Checkpoint = {
    tenantId: "t1",
    offset: head.offset,
    headHash: head.id,
    count: full.length,
    sig: signer.sign(head.id, tick()),
  };

  // truncate the tail (drop the EffectResult)
  const truncated = full.slice(0, full.length - 1);
  const v = verify(truncated, ring, checkpoint);
  assert.ok(!v.ok);
  assert.equal(v.error.kind, "Truncated");

  // full log with the checkpoint verifies fine
  const vFull = verify(full, ring, checkpoint);
  assert.ok(vFull.ok, vFull.ok ? "" : vFull.error.message);
});

test("spec-10 replay determinism: id is a pure function of content", async () => {
  const { events } = await buildChain();
  for (const e of events) {
    assert.equal(contentAddress(preimageBytes(e)), e.id);
  }
});

// ── LED-08: key validity window ─────────────────────────────────────────────────

test("LED-08 signature out of key validity window is rejected", () => {
  const ring = new HmacKeyring();
  const signer = ring.addKey("k", "s", { epoch: 1, validFrom: 100, validUntil: 200 });
  const id = "sha256:abc";
  const inWindow = signer.sign(id, 150);
  assert.ok(ring.verify(id, inWindow).ok);
  const tooLate = signer.sign(id, 250);
  const res = ring.verify(id, tooLate);
  assert.ok(!res.ok && res.reason === "out_of_window");
});
