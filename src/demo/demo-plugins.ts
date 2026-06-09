/**
 * demo:plugins — End-to-end proof of the plugin lifecycle system.
 *
 * Demonstrates:
 *   1. Install a YAML plugin (web.fetch)
 *   2. Install a TypeScript plugin (text.transform) — as a pre-compiled .js
 *   3. Enable both — they appear in the Supervisor's live snapshot
 *   4. Invoke text.transform via the Supervisor directly (no engine needed)
 *   5. Disable web.fetch — it disappears from the snapshot instantly
 *   6. Attempt to enable web.fetch again — succeeds (re-enable path)
 *   7. Uninstall text.transform — row gone, ledger event written
 *   8. Print the plugin_records table + plugin lifecycle ledger events
 *
 * Run: npm run demo:plugins
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { HmacKeyring } from "../core/ledger/crypto.js";
import { Supervisor } from "../core/capability/capability.js";
import type { EffectCall } from "../core/capability/capability.js";
import { SqlitePluginRepository, PLUGIN_SCHEMA } from "../infrastructure/plugins/sqlite-plugin-repository.js";
import { YamlPluginLoader } from "../infrastructure/plugins/yaml-plugin-loader.js";
import { TypeScriptPluginLoader } from "../infrastructure/plugins/typescript-plugin-loader.js";
import { PluginFactory } from "../core/plugins/plugin-factory.js";
import { PluginActivator } from "../core/plugins/plugin-activator.js";
import { PluginLifecycleService } from "../core/plugins/lifecycle-service.js";
import type { SecretBrokerPort } from "../core/plugins/ports.js";
import { parseOwnerId } from "../core/plugins/ports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CAPABILITIES_DIR = join(ROOT, "capabilities");

// ── Bootstrap ────────────────────────────────────────────────────────────────

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
// Ledger events table (mirrors SqliteLedgerStore schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    tenant_id   TEXT    NOT NULL,
    offset      INTEGER NOT NULL,
    id          TEXT    NOT NULL,
    event_json  TEXT    NOT NULL,
    PRIMARY KEY (tenant_id, offset)
  );
`);
db.exec(PLUGIN_SCHEMA);

const ring = new HmacKeyring();
const systemSigner = ring.addKey("system", "demo-system-secret", { epoch: 1, validFrom: 0, validUntil: null });

const { supervisor, snapshotHandle } = Supervisor.create(new Map());
const repository = new SqlitePluginRepository(db);

const yamlLoader = new YamlPluginLoader();
const tsLoader = new TypeScriptPluginLoader();
const strategies = new Map<import("../core/plugins/types.js").PluginKind, import("../core/plugins/ports.js").PluginLoaderStrategy>([
  ["yaml", yamlLoader],
  ["typescript", tsLoader],
]);

const broker: SecretBrokerPort = {
  validateRefs: (refs) => {
    const missing = refs.filter((r) => r !== "webhook-secret"); // only webhook-secret is "registered"
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  },
  resolve: (ref) => (ref === "webhook-secret" ? "demo-webhook-token" : undefined),
};

let clock = 1000;
const now = () => clock++;

const factory = new PluginFactory(strategies);
const activator = new PluginActivator({ repository, factory, broker, db, signer: systemSigner, now });

const OWNER = parseOwnerId("owner-demo");

const lifecycle = new PluginLifecycleService({
  repository,
  factory,
  snapshotHandle,
  broker,
  signer: systemSigner,
  db,
  now,
  pluginsRoot: CAPABILITIES_DIR,
});

// ── Paths ─────────────────────────────────────────────────────────────────────

const YAML_PATH = join(CAPABILITIES_DIR, "web-fetch.yaml");
const TS_COMPILED_PATH = join(CAPABILITIES_DIR, "text-transform.js");

// Write a compiled .js version of the TS plugin for the demo (since we can't
// run tsc here — we inline a pre-compiled equivalent)
if (!existsSync(TS_COMPILED_PATH)) {
  writeFileSync(
    TS_COMPILED_PATH,
    `
export const TextTransformPlugin = {
  name: 'text.transform',
  sideEffect: 'read',
  estimateCents: () => 0,
  async invoke(call) {
    const input = call.input;
    let result;
    switch (input.operation) {
      case 'uppercase': result = input.text.toUpperCase(); break;
      case 'lowercase': result = input.text.toLowerCase(); break;
      case 'trim': result = input.text.trim(); break;
      case 'reverse': result = input.text.split('').reverse().join(''); break;
      case 'word-count': result = input.text.trim().split(/\\s+/).filter(Boolean).length; break;
      default: throw new Error('unknown operation');
    }
    return { output: { result }, claimedCostCents: 0 };
  },
};
export default TextTransformPlugin;
`,
  );
}

// ── Demo ──────────────────────────────────────────────────────────────────────

console.log("\n=== Genesis Plugin Lifecycle Demo ===\n");

// 1. Install YAML plugin
console.log("1. Installing web.fetch (YAML)...");
const installYaml = await lifecycle.install(YAML_PATH, "1.0.0", OWNER);
console.log("   Result:", installYaml.ok ? `✓ installed as '${(installYaml as { ok: true; record: { name: string } }).record.name}'` : `✗ ${installYaml.error}: ${installYaml.detail}`);

// 2. Install TypeScript plugin
console.log("\n2. Installing text.transform (TypeScript compiled)...");
const installTs = await lifecycle.install(TS_COMPILED_PATH, "1.0.0", OWNER);
console.log("   Result:", installTs.ok ? `✓ installed as '${(installTs as { ok: true; record: { name: string } }).record.name}'` : `✗ ${installTs.error}: ${installTs.detail}`);

// 3. Show supervisor snapshot (should be empty — nothing enabled yet)
console.log("\n3. Supervisor snapshot after install (nothing enabled yet):", supervisor.pluginNames);

// 4. Enable text.transform (registry name = capability name = 'text.transform' after install resolution)
console.log("\n4. Enabling text.transform...");
const enableTs = await lifecycle.enable("text.transform", OWNER);
console.log("   Result:", enableTs.ok ? `✓ enabled` : `✗ ${enableTs.error}: ${enableTs.detail}`);
console.log("   Supervisor snapshot:", supervisor.pluginNames);

// 5. Invoke text.transform via the Supervisor
if (enableTs.ok) {
  console.log("\n5. Invoking text.transform (uppercase 'hello world')...");
  const call: EffectCall = { nodeId: "demo-node", capability: "text.transform", input: { text: "hello world", operation: "uppercase" } };
  const estimate = supervisor.estimate(call);
  console.log("   Estimate:", estimate, "cents");
  const result = await supervisor.run(call, "demo-idem-001");
  console.log("   Output:", result.output);
  console.log("   Cost settled:", result.costCents, "cents");

  // word count
  const call2: EffectCall = { nodeId: "demo-node", capability: "text.transform", input: { text: "the quick brown fox jumps", operation: "word-count" } };
  const result2 = await supervisor.run(call2, "demo-idem-002");
  console.log("   Word count 'the quick brown fox jumps':", (result2.output as { result: number }).result);
}

// 6. Enable web.fetch
console.log("\n6. Enabling web.fetch...");
const enableYaml = await lifecycle.enable("web.fetch", OWNER);
console.log("   Result:", enableYaml.ok ? `✓ enabled` : `✗ ${enableYaml.error}: ${enableYaml.detail}`);
console.log("   Supervisor snapshot:", supervisor.pluginNames);

// 7. Disable web.fetch
console.log("\n7. Disabling web.fetch...");
const disableYaml = await lifecycle.disable("web.fetch", OWNER, "demo: testing disable flow");
console.log("   Result:", disableYaml.ok ? `✓ disabled` : `✗ ${disableYaml.error}: ${disableYaml.detail}`);
console.log("   Supervisor snapshot after disable:", supervisor.pluginNames);

// 8. Verify disabled plugin is not in snapshot — estimate returns null
const disabledCall: EffectCall = { nodeId: "demo-node", capability: "web.fetch", input: { url: "https://example.com" } };
const estimateAfterDisable = supervisor.estimate(disabledCall);
console.log("\n8. supervisor.estimate('web.fetch') after disable:", estimateAfterDisable, "(null = CAPABILITY_NOT_GRANTED)");

// 9. Re-enable web.fetch
console.log("\n9. Re-enabling web.fetch...");
const reEnable = await lifecycle.enable("web.fetch", OWNER);
console.log("   Result:", reEnable.ok ? `✓ re-enabled` : `✗ ${reEnable.error}: ${reEnable.detail}`);
console.log("   Supervisor snapshot:", supervisor.pluginNames);

// 10. Uninstall text.transform
console.log("\n10. Uninstalling text.transform...");
const uninstall = await lifecycle.uninstall("text.transform", OWNER);
console.log("    Result:", uninstall.ok ? `✓ uninstalled` : `✗ ${uninstall.error}: ${uninstall.detail}`);
console.log("    Supervisor snapshot:", supervisor.pluginNames);
console.log("    Repository list:", repository.list().map((r) => `${r.name}(${r.kind})`));

// 11. Inspect plugin_records table
console.log("\n11. plugin_records table:");
const rows = db.prepare("SELECT name, plugin_kind, status, version FROM plugin_records ORDER BY name").all();
if (rows.length === 0) {
  console.log("    (empty — text-transform was uninstalled)");
} else {
  for (const row of rows as Array<{ name: string; plugin_kind: string; status: string; version: string }>) {
    console.log(`    - ${row.name} [${row.plugin_kind}] status=${row.status} v${row.version}`);
  }
}

// 12. Inspect plugin lifecycle ledger events
console.log("\n12. Plugin lifecycle events in ledger:");
const events = db
  .prepare("SELECT event_json FROM events WHERE tenant_id = 'system' ORDER BY offset ASC")
  .all() as Array<{ event_json: string }>;
for (const ev of events) {
  const parsed = JSON.parse(ev.event_json) as { type: string; payload: { pluginName: string; actorId: string } };
  console.log(`    [${parsed.type}] plugin=${parsed.payload.pluginName} actor=${parsed.payload.actorId}`);
}

console.log("\n=== Plugin Lifecycle Demo Complete ===\n");
