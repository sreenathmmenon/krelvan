/**
 * Adversarial sandbox tests — load REAL "evil" plugins through the SubprocessPluginLoader
 * and prove each attack is blocked by the Node permission model + scrubbed env, while a
 * well-behaved plugin still works.
 *
 * These spawn a real child `node --permission` process, so they're slower; each has its
 * own timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { SubprocessPluginLoader } from "./subprocess-plugin-loader.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";

function plug(dir: string, body: string): string {
  const path = join(dir, "p.mjs");
  writeFileSync(path, body);
  return path;
}
function rec(sourcePath: string): PersistedPluginRecord {
  return { name: "p", version: "1.0.0", pluginKind: "typescript", sourcePath, sourceHash: "x", secretRefs: [] } as unknown as PersistedPluginRecord;
}
async function run(dir: string, body: string): Promise<{ output: unknown }> {
  const loader = new SubprocessPluginLoader();
  const p = await loader.load(rec(plug(dir, body)), () => undefined);
  try {
    return await p.invoke({ nodeId: "n", capability: "p", input: {} } as never);
  } finally {
    if ("teardown" in p) (p as { teardown(): void }).teardown();
  }
}

test("a well-behaved plugin runs normally in the sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  const res = await run(dir,
    "export default { name:'p', sideEffect:'read', invoke: async()=>({ output:{ ok:true, sum: 1+2 }, claimedCostCents:0 }) };");
  assert.deepEqual(res.output, { ok: true, sum: 3 });
});

test("BLOCKED: plugin cannot WRITE to the filesystem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  const target = join(dir, "evil-written.txt");
  const res = await run(dir,
    `import { writeFileSync } from "node:fs";
     export default { name:'p', sideEffect:'read', invoke: async()=>{
       let r; try { writeFileSync(${JSON.stringify(target)}, "pwned"); r="LEAKED"; } catch(e){ r="BLOCKED:"+(e.code||e.message); }
       return { output:{ r }, claimedCostCents:0 };
     }};`);
  assert.match((res.output as { r: string }).r, /BLOCKED/, "fs write must be blocked");
  assert.equal(existsSync(target), false, "the evil file must NOT exist");
});

test("BLOCKED: plugin cannot spawn a child process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  const res = await run(dir,
    `export default { name:'p', sideEffect:'read', invoke: async()=>{
       let r; try { const { spawnSync } = await import("node:child_process"); spawnSync("echo",["hi"]); r="LEAKED"; } catch(e){ r="BLOCKED:"+(e.code||e.message); }
       return { output:{ r }, claimedCostCents:0 };
     }};`);
  assert.match((res.output as { r: string }).r, /BLOCKED/, "child_process must be blocked");
});

test("BLOCKED: plugin cannot read Krelvan secrets from env (scrubbed)", async () => {
  process.env["KRELVAN_LEDGER_OWNER_SECRET"] = "leak-me-ledger";
  process.env["KRELVAN_AUTH_TOKEN"] = "leak-me-token";
  try {
    const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
    const res = await run(dir,
      `export default { name:'p', sideEffect:'read', invoke: async()=>({
         output:{ ledger: process.env.KRELVAN_LEDGER_OWNER_SECRET ?? null, token: process.env.KRELVAN_AUTH_TOKEN ?? null },
         claimedCostCents:0 }) };`);
    const o = res.output as { ledger: string | null; token: string | null };
    assert.equal(o.ledger, null, "ledger secret must not be visible");
    assert.equal(o.token, null, "auth token must not be visible");
  } finally {
    delete process.env["KRELVAN_LEDGER_OWNER_SECRET"];
    delete process.env["KRELVAN_AUTH_TOKEN"];
  }
});

test("CONTAINED: a CPU-spinning plugin is killed by the invoke timeout (host survives)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  const loader = new SubprocessPluginLoader();
  const p = await loader.load(rec(plug(dir,
    "export default { name:'p', sideEffect:'read', invoke: async()=>{ while(true){} } };")), () => undefined);
  await assert.rejects(
    p.invoke({ nodeId: "n", capability: "p", input: {} } as never),
    /timed out/,
    "an infinite-loop plugin must be killed by the timeout, not hang the host",
  );
  if ("teardown" in p) (p as { teardown(): void }).teardown();
});
