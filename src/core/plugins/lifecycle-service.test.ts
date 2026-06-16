/**
 * Plugin lifecycle service tests.
 * Covers: install → enable → invoke → disable → re-enable → uninstall.
 * Uses an in-memory SQLite DB and a stub factory to avoid real Worker threads.
 */

// These tests exercise the trusted-plugin lifecycle (TS plugins, stub factory), so
// they opt into untrusted-plugin execution. Production gates this behind the operator.
process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"] = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

import { PluginLifecycleService } from "./lifecycle-service.js";
import { PluginActivator } from "./plugin-activator.js";
import { PluginFactory } from "./plugin-factory.js";
import { SqlitePluginRepository, PLUGIN_SCHEMA } from "../../infrastructure/plugins/sqlite-plugin-repository.js";
import { Supervisor } from "../capability/capability.js";
import { HmacKeyring } from "../ledger/crypto.js";
import { parseOwnerId } from "./ports.js";
import type { PluginLoaderStrategy, SecretBrokerPort } from "./ports.js";
import type { CapabilityPlugin } from "../capability/capability.js";
import type { PersistedPluginRecord } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Plugin registry table
  db.exec(PLUGIN_SCHEMA);
  // Minimal ledger events table (lifecycle-service writes events to it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      tenant_id   TEXT    NOT NULL,
      offset      INTEGER NOT NULL,
      id          TEXT    NOT NULL,
      event_json  TEXT    NOT NULL,
      PRIMARY KEY (tenant_id, offset)
    );
  `);
  return db;
}

let clock = 1;

function makeRig(db: DatabaseSync, pluginsRoot: string) {
  const ring = new HmacKeyring();
  const signer = ring.addKey("owner", "k-owner", { epoch: 1, validFrom: 0, validUntil: null });

  const repository = new SqlitePluginRepository(db);

  // Stub loader: returns a simple echo plugin regardless of file content
  const stubbedPlugins = new Map<string, CapabilityPlugin>();

  const stubLoader: PluginLoaderStrategy = {
    kind: "typescript",
    async load(record) {
      // Re-use any overridden plugin, otherwise make a fresh echo plugin
      const override = stubbedPlugins.get(record.name);
      if (override) return override;
      const plugin: CapabilityPlugin = {
        name: record.name,
        sideEffect: "read",
        estimateCents: () => 5,
        async invoke(call) {
          return { output: { echo: call.input }, claimedCostCents: 5 };
        },
      };
      return plugin;
    },
  };

  const factory = new PluginFactory(new Map([["typescript", stubLoader], ["yaml", stubLoader]]));

  const broker: SecretBrokerPort = {
    validateRefs: () => ({ ok: true }),
    resolve: () => undefined,
  };

  const { supervisor, snapshotHandle } = Supervisor.create(new Map());

  const lifecycle = new PluginLifecycleService({
    repository,
    factory,
    snapshotHandle,
    broker,
    signer,
    db,
    now: () => clock++,
    pluginsRoot,
  });

  return { lifecycle, repository, supervisor, stubbedPlugins, signer, broker, factory };
}

/** Write a minimal .ts plugin file and return its path. */
function writePluginFile(dir: string, name: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, `export default { name: "${name}", sideEffect: "read", estimateCents: () => 5, async invoke(c) { return { output: { echo: c.input }, claimedCostCents: 5 }; } };\n`);
  return path;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("lifecycle: install → record persisted as 'installed'", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "test-plugin");
  const db = makeTestDb();
  const { lifecycle, repository } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  const result = await lifecycle.install(filePath, "1.0.0", owner);
  assert.equal(result.ok, true, `install failed: ${!result.ok ? result.detail : ""}`);
  assert.equal(result.ok && result.record.kind, "installed");
  assert.equal(result.ok && result.record.name, "test-plugin");

  const persisted = repository.get("test-plugin");
  assert.ok(persisted, "should be in DB after install");
  assert.equal(persisted?.kind, "installed");
});

test("lifecycle: install → enable → plugin in supervisor snapshot", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "echo-plugin");
  const db = makeTestDb();
  const { lifecycle, supervisor } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  const enableResult = await lifecycle.enable("echo-plugin", owner);
  assert.equal(enableResult.ok, true, `enable failed: ${!enableResult.ok ? enableResult.detail : ""}`);
  assert.equal(enableResult.ok && enableResult.record.kind, "enabled");

  // Supervisor snapshot should now contain the plugin
  assert.ok(supervisor.pluginNames.includes("echo-plugin"), "plugin should be in supervisor snapshot after enable");
});

test("lifecycle: enable → invoke works end-to-end", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "invoke-plugin");
  const db = makeTestDb();
  const { lifecycle, supervisor } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  await lifecycle.enable("invoke-plugin", owner);

  const result = await supervisor.run(
    { nodeId: "node1", capability: "invoke-plugin", input: { msg: "hello" } },
    "idem-1",
  );
  assert.deepEqual(result.output, { echo: { msg: "hello" } });
  assert.equal(result.costCents, 5);
});

test("lifecycle: enable → disable → plugin removed from supervisor snapshot", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "disable-plugin");
  const db = makeTestDb();
  const { lifecycle, supervisor } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  await lifecycle.enable("disable-plugin", owner);
  assert.ok(supervisor.pluginNames.includes("disable-plugin"), "should be enabled");

  const disableResult = await lifecycle.disable("disable-plugin", owner, "test reason");
  assert.equal(disableResult.ok, true, `disable failed: ${!disableResult.ok ? disableResult.detail : ""}`);
  assert.ok(!supervisor.pluginNames.includes("disable-plugin"), "should be removed from supervisor after disable");
});

test("lifecycle: disable → re-enable → back in supervisor", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "re-enable-plugin");
  const db = makeTestDb();
  const { lifecycle, supervisor } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  await lifecycle.enable("re-enable-plugin", owner);
  await lifecycle.disable("re-enable-plugin", owner);
  await lifecycle.enable("re-enable-plugin", owner);

  assert.ok(supervisor.pluginNames.includes("re-enable-plugin"), "should be back in supervisor after re-enable");
});

test("lifecycle: uninstall → record removed from DB", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "uninstall-plugin");
  const db = makeTestDb();
  const { lifecycle, repository } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  const uninstallResult = await lifecycle.uninstall("uninstall-plugin", owner);
  assert.equal(uninstallResult.ok, true, `uninstall failed: ${!uninstallResult.ok ? uninstallResult.detail : ""}`);

  const persisted = repository.get("uninstall-plugin");
  assert.equal(persisted, undefined, "record should be removed from DB after uninstall");
});

test("lifecycle: install same plugin twice → ALREADY_INSTALLED error", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "dupe-plugin");
  const db = makeTestDb();
  const { lifecycle } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  const second = await lifecycle.install(filePath, "1.0.0", owner);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error, "ALREADY_INSTALLED");
});

test("lifecycle: enable unknown plugin → NOT_FOUND error", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const db = makeTestDb();
  const { lifecycle } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  const result = await lifecycle.enable("ghost-plugin", owner);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "NOT_FOUND");
});

test("lifecycle: install outside pluginsRoot → VALIDATION_FAILED", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const outside = join(tmpdir(), `gen-outside-${randomBytes(4).toString("hex")}`);
  mkdirSync(outside, { recursive: true });
  const filePath = writePluginFile(outside, "outside-plugin");
  const db = makeTestDb();
  const { lifecycle } = makeRig(db, dir); // pluginsRoot = dir, file is in outside
  const owner = parseOwnerId("owner-demo");

  const result = await lifecycle.install(filePath, "1.0.0", owner);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "VALIDATION_FAILED");
});

test("lifecycle: install missing file → FILE_NOT_FOUND", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const db = makeTestDb();
  const { lifecycle } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  const result = await lifecycle.install(join(dir, "does-not-exist.ts"), "1.0.0", owner);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "FILE_NOT_FOUND");
});

test("lifecycle: missing secrets → MISSING_SECRETS on enable", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "secret-plugin");
  const db = makeTestDb();
  const ring = new HmacKeyring();
  const signer = ring.addKey("owner", "k-owner", { epoch: 1, validFrom: 0, validUntil: null });
  const repository = new SqlitePluginRepository(db);

  const stubLoader: PluginLoaderStrategy = {
    kind: "typescript",
    async load(rec) {
      const p: CapabilityPlugin = { name: rec.name, sideEffect: "read", estimateCents: () => 0, async invoke() { return { output: {}, claimedCostCents: 0 }; } };
      return p;
    },
  };
  const factory = new PluginFactory(new Map([["typescript", stubLoader], ["yaml", stubLoader]]));

  // Broker that says MY_SECRET is missing
  const broker: SecretBrokerPort = {
    validateRefs: (refs) => {
      const missing = refs.filter(r => r === "MY_SECRET");
      return missing.length > 0 ? { ok: false, missing } : { ok: true };
    },
    resolve: () => undefined,
  };

  const { supervisor, snapshotHandle } = Supervisor.create(new Map());
  const lifecycle = new PluginLifecycleService({
    repository, factory, snapshotHandle, broker, signer, db,
    now: () => clock++,
    pluginsRoot: dir,
  });

  // Write a YAML-style file with secret ref so secretRefs gets extracted
  const path = join(dir, "secret-plugin.ts");
  writeFileSync(path, `// {{secret:MY_SECRET}}\nexport default { name: "secret-plugin", sideEffect: "read", estimateCents: () => 0, async invoke() { return { output: {}, claimedCostCents: 0 }; } };\n`);

  const installResult = await lifecycle.install(path, "1.0.0", parseOwnerId("owner-demo"));
  assert.equal(installResult.ok, true, !installResult.ok ? installResult.detail : "");

  // Manually set secretRefs on the record to test the enable path
  const rec = repository.get("secret-plugin");
  if (rec) {
    repository.save({ ...rec, secretRefs: ["MY_SECRET"] });
  }

  const enableResult = await lifecycle.enable("secret-plugin", parseOwnerId("owner-demo"));
  assert.equal(enableResult.ok, false, "should fail with MISSING_SECRETS");
  assert.equal(!enableResult.ok && enableResult.error, "MISSING_SECRETS");
});

test("activator: enabled plugin in DB → reloaded on startup", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "persist-plugin");
  const db = makeTestDb();
  const { lifecycle, repository, signer, factory, broker } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  // Install + enable
  await lifecycle.install(filePath, "1.0.0", owner);
  await lifecycle.enable("persist-plugin", owner);

  const rec = repository.get("persist-plugin");
  assert.equal(rec?.kind, "enabled", "should be enabled in DB");

  // Simulate restart: create a new activator on the same DB
  const activator = new PluginActivator({
    repository,
    factory,
    broker,
    db,
    signer,
    now: () => clock++,
  });

  const restored = await activator.loadAll();
  assert.ok(restored.has("persist-plugin"), "plugin should be restored on restart");
});

test("activator: missing source file → plugin disabled on startup", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "deleted-plugin");
  const db = makeTestDb();
  const { lifecycle, repository, signer, factory, broker } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);
  await lifecycle.enable("deleted-plugin", owner);

  // Delete the source file (simulate plugin file removed from disk)
  unlinkSync(filePath);

  const activator = new PluginActivator({
    repository,
    factory,
    broker,
    db,
    signer,
    now: () => clock++,
  });

  const restored = await activator.loadAll();
  assert.ok(!restored.has("deleted-plugin"), "deleted-file plugin should NOT be in restored map");

  // Record should now be 'disabled' in DB
  const rec = repository.get("deleted-plugin");
  assert.equal(rec?.kind, "disabled", "plugin should be disabled in DB after source file missing");
});

test("SECURITY: a typescript plugin is BLOCKED from enabling without the opt-in", async () => {
  const dir = join(tmpdir(), `gen-lc-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const filePath = writePluginFile(dir, "untrusted-plugin");
  const db = makeTestDb();
  const { lifecycle } = makeRig(db, dir);
  const owner = parseOwnerId("owner-demo");

  await lifecycle.install(filePath, "1.0.0", owner);

  // Temporarily turn OFF the opt-in (this file sets it globally for the other tests).
  const prev = process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"];
  delete process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"];
  try {
    const blocked = await lifecycle.enable("untrusted-plugin", owner);
    assert.equal(blocked.ok, false, "enable must be blocked without the opt-in");
    assert.equal(!blocked.ok && blocked.error, "UNTRUSTED_BLOCKED");
  } finally {
    if (prev !== undefined) process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"] = prev;
  }

  // With the opt-in, the same plugin enables.
  process.env["KRELVAN_ALLOW_UNTRUSTED_PLUGINS"] = "1";
  const allowed = await lifecycle.enable("untrusted-plugin", owner);
  assert.equal(allowed.ok, true, `enable should succeed with opt-in: ${!allowed.ok ? allowed.detail : ""}`);
});
