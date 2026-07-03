/**
 * Guards the first-run magic moment (`krelvan hello`): with zero keys, zero config, and
 * no server, a real deterministic agent must run to completion through the real signed
 * ledger, export a proof bundle, and that bundle must pass the standalone offline
 * verifier (exit 0). If this breaks, the very first thing a new user tries is broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHello } from "./hello.js";

test("hello: runs a real agent, exports a proof, and the standalone verifier accepts it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "krelvan-hello-data-"));
  const outDir = mkdtempSync(join(tmpdir(), "krelvan-hello-out-"));
  try {
    const r = await runHello(dataDir, outDir);
    assert.equal(r.status, "completed", "the hello agent must complete");
    assert.ok(r.events >= 10, `a 2-node run should produce a real event chain (got ${r.events})`);
    assert.ok(existsSync(r.proofPath), "the proof bundle must be written");
    assert.equal(r.verifyExit, 0, "the standalone verifier must accept the bundle (exit 0)");

    const bundle = JSON.parse(readFileSync(r.proofPath, "utf8")) as Record<string, unknown>;
    assert.equal(bundle["algorithm"], "ed25519", "a fresh data dir signs with Ed25519 (third-party verifiable)");
    assert.ok(Array.isArray(bundle["events"]) && (bundle["events"] as unknown[]).length === r.events);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
