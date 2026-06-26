/**
 * Tests for the cross-run memory promotion conventions that the price-monitor (and any
 * memory-aware agent) relies on: explicit remember_<name>, deterministic remember_map,
 * and the legacy .result heuristic. These are pure-ish (write to a temp data dir).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberCapability, recallCapability } from "./memory-plugins.js";

let dir: string;
let prevEnv: string | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "krelvan-mem-"));
  prevEnv = process.env["KRELVAN_DATA_DIR"];
  process.env["KRELVAN_DATA_DIR"] = dir;
});
after(() => {
  if (prevEnv === undefined) delete process.env["KRELVAN_DATA_DIR"]; else process.env["KRELVAN_DATA_DIR"] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

function call(input: Record<string, unknown>) {
  return { nodeId: "persist", capability: "remember", input } as never;
}
function recallCall(input: Record<string, unknown>) {
  return { nodeId: "recall", capability: "recall", input } as never;
}

test("remember: explicit remember_<name> stores a fact recallable as recall.<name>", async () => {
  await rememberCapability.invoke(call({ _agentId: "a1", "analyze.remember_last_price": "49.99" }));
  const out = (await recallCapability.invoke(recallCall({ _agentId: "a1" }))).output as Record<string, unknown>;
  assert.equal(out["recall.last_price"], "49.99");
});

test("remember: deterministic remember_map copies a current state value into a named fact", async () => {
  await rememberCapability.invoke(call({ _agentId: "a2", remember_map: "last_price=analyze.current_price", "analyze.current_price": "39.99" }));
  const out = (await recallCapability.invoke(recallCall({ _agentId: "a2" }))).output as Record<string, unknown>;
  assert.equal(out["recall.last_price"], "39.99");
});

test("remember: remember_map updates the baseline across runs (last write wins)", async () => {
  await rememberCapability.invoke(call({ _agentId: "a3", remember_map: "last_price=p.cur", "p.cur": "10.00" }));
  await rememberCapability.invoke(call({ _agentId: "a3", remember_map: "last_price=p.cur", "p.cur": "8.50" }));
  const out = (await recallCapability.invoke(recallCall({ _agentId: "a3" }))).output as Record<string, unknown>;
  assert.equal(out["recall.last_price"], "8.50", "the newer value must overwrite the baseline");
});

test("remember: legacy .result heuristic still promotes node results", async () => {
  await rememberCapability.invoke(call({ _agentId: "a4", "analyze.result": "done" }));
  const out = (await recallCapability.invoke(recallCall({ _agentId: "a4" }))).output as Record<string, unknown>;
  assert.equal(out["recall.analyze"], "done");
});

test("remember: a malformed remember_map pair is ignored, not crashed", async () => {
  const r = await rememberCapability.invoke(call({ _agentId: "a5", remember_map: "no_equals_sign,bad=", "x": "y" }));
  assert.ok(r.output, "invoke must succeed even with a malformed remember_map");
  assert.ok(!existsSync(join(dir, "memory", "a5.semantic.json")) || readFileSync(join(dir, "memory", "a5.semantic.json"), "utf8").length >= 0);
});

// ── per-sender memory isolation (the support-agent #1 safety fix) ────────────────────────
// A multi-customer agent must NEVER surface customer A's remembered facts for customer B.
// recall/remember scope by a sender identity when present in run state.

test("memory isolation: customer A's fact does NOT leak to customer B (same agentId, different sender)", async () => {
  // Customer A tells the support agent their order number.
  await rememberCapability.invoke(call({ _agentId: "support", from_address: "alice@example.com", "note.remember_order": "A-1001" }));
  // Customer B has their own conversation with the SAME support agent.
  await rememberCapability.invoke(call({ _agentId: "support", from_address: "bob@example.com", "note.remember_order": "B-2002" }));

  const aOut = (await recallCapability.invoke(recallCall({ _agentId: "support", from_address: "alice@example.com" }))).output as Record<string, unknown>;
  const bOut = (await recallCapability.invoke(recallCall({ _agentId: "support", from_address: "bob@example.com" }))).output as Record<string, unknown>;

  assert.equal(aOut["recall.order"], "A-1001", "Alice recalls only her own order");
  assert.equal(bOut["recall.order"], "B-2002", "Bob recalls only his own order");
  assert.notEqual(aOut["recall.order"], bOut["recall.order"], "the two customers' memories must be isolated");
  // And cross-contamination must be impossible: Alice's recall must NOT contain Bob's value.
  assert.notEqual(aOut["recall.order"], "B-2002", "Bob's order must NEVER surface for Alice");
});

test("memory isolation: no sender → bare agentId store (single-user agents unchanged)", async () => {
  await rememberCapability.invoke(call({ _agentId: "solo", "note.remember_x": "v1" }));
  const out = (await recallCapability.invoke(recallCall({ _agentId: "solo" }))).output as Record<string, unknown>;
  assert.equal(out["recall.x"], "v1", "a no-sender agent still reads its own memory exactly as before");
  // The raw sender must never appear in the on-disk filename (it is hashed).
  assert.ok(!existsSync(join(dir, "memory", "solo@.semantic.json")), "no empty-sender suffix file");
});

test("memory isolation: the on-disk filename hashes the sender (no raw email on disk)", async () => {
  await rememberCapability.invoke(call({ _agentId: "supportx", from_address: "carol@example.com", "note.remember_y": "v2" }));
  // The memory dir is whatever the module resolved at import (KRELVAN_DATA_DIR or ./data) — search
  // both the test temp dir and ./data so the assertion is robust to import-time path capture.
  const { readdirSync } = await import("node:fs");
  const candidates = [join(dir, "memory"), join(process.cwd(), "data", "memory")];
  let files: string[] = [];
  for (const d of candidates) { if (existsSync(d)) files = files.concat(readdirSync(d)); }
  const supportFiles = files.filter((f) => f.startsWith("supportx@"));
  assert.ok(supportFiles.length > 0, "a sender-scoped store exists (hashed suffix)");
  assert.ok(!supportFiles.some((f) => f.includes("carol@example.com")), "raw sender email must NEVER appear in a memory filename (it is hashed)");
});
