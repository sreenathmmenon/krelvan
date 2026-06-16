/**
 * Real-Worker tests for the TypeScript plugin loader:
 *  (1) a real plugin still loads + invokes with the SCRUBBED env, and
 *  (2) the plugin CANNOT read Krelvan's secrets from process.env (A3 fix).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { TypeScriptPluginLoader } from "./typescript-plugin-loader.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";

function writePlugin(dir: string, body: string): string {
  const path = join(dir, "p.js");
  writeFileSync(path, body);
  return path;
}

function record(sourcePath: string): PersistedPluginRecord {
  return {
    name: "p", version: "1.0.0", pluginKind: "typescript",
    sourcePath, sourceHash: "x", secretRefs: [],
  } as unknown as PersistedPluginRecord;
}

test("real worker: plugin loads + invokes with scrubbed env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-ts-"));
  const file = writePlugin(dir,
    "export default { name:'p', sideEffect:'read', estimateCents:()=>0, " +
    "async invoke(call){ return { output:{ ok:true, got: call.input }, claimedCostCents:0 }; } };");
  const loader = new TypeScriptPluginLoader();
  const plugin = await loader.load(record(file), () => undefined);
  const res = await plugin.invoke({ nodeId: "n", capability: "p", input: { a: 1 } } as never);
  assert.deepEqual((res.output as { ok: boolean }).ok, true);
  if ("teardown" in plugin) (plugin as { teardown(): void }).teardown();
});

test("real worker: plugin CANNOT read Krelvan secrets from process.env", async () => {
  // set a secret in the PARENT env — the worker must not inherit it
  process.env["KRELVAN_LEDGER_OWNER_SECRET"] = "super-secret-do-not-leak";
  process.env["KRELVAN_AUTH_TOKEN"] = "auth-do-not-leak";
  try {
    const dir = mkdtempSync(join(tmpdir(), "krelvan-ts-"));
    const file = writePlugin(dir,
      "export default { name:'p', sideEffect:'read', estimateCents:()=>0, " +
      "async invoke(){ return { output:{ " +
      "  ledger: process.env.KRELVAN_LEDGER_OWNER_SECRET ?? null, " +
      "  token: process.env.KRELVAN_AUTH_TOKEN ?? null " +
      "}, claimedCostCents:0 }; } };");
    const loader = new TypeScriptPluginLoader();
    const plugin = await loader.load(record(file), () => undefined);
    const res = await plugin.invoke({ nodeId: "n", capability: "p", input: {} } as never);
    const out = res.output as { ledger: string | null; token: string | null };
    assert.equal(out.ledger, null, "plugin must NOT see the ledger signing secret");
    assert.equal(out.token, null, "plugin must NOT see the auth token");
    if ("teardown" in plugin) (plugin as { teardown(): void }).teardown();
  } finally {
    delete process.env["KRELVAN_LEDGER_OWNER_SECRET"];
    delete process.env["KRELVAN_AUTH_TOKEN"];
  }
});
