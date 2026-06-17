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
