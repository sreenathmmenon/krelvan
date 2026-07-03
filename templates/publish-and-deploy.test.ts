/**
 * Combination-workflow proof for "Publish & Deploy" — the build-and-ship loop:
 *   research (web_search) -> write (compose) -> commit (github.dispatch, reversible)
 *   -> deploy (deploy.vercel, IRREVERSIBLE — human-gated) -> record.
 *
 * This is the "agents at scale" test the platform needs: a chain of MULTIPLE
 * side-effects across connectors, where the irreversible deploy step MUST pause at the
 * human-approval gate, denying stops the ship, approving lets it through, and the signed
 * ledger of the whole chain verifies either way. Uses fake plugins (no real network) so
 * the orchestration + the gate are what's under test, not the providers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";
import { HmacKeyring } from "../src/core/ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../src/core/ledger/store.js";
import { Supervisor, type CapabilityPlugin, type EffectCall } from "../src/core/capability/capability.js";
import { Engine } from "../src/core/kernel/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "publish-and-deploy.manifest.json"), "utf8")) as Manifest;

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

function plugins(): Map<string, CapabilityPlugin> {
  const search: CapabilityPlugin = { name: "web_search", sideEffect: "read", estimateCents: () => 8,
    async invoke() { return { output: { findings: "Open platforms are consolidating; self-host + extensibility win.", angle: "Own your agents." }, claimedCostCents: 8 }; } };
  const compose: CapabilityPlugin = { name: "compose", sideEffect: "read", estimateCents: () => 35,
    async invoke(c: EffectCall) {
      if (c.nodeId === "write") return { output: { title: "The State of Open Agent Platforms", body: "Open, self-hostable agent platforms are winning. ..." }, claimedCostCents: 35 };
      return { output: { result: "shipped: The State of Open Agent Platforms" }, claimedCostCents: 10 };
    } };
  const dispatch: CapabilityPlugin = { name: "github.dispatch", sideEffect: "write-reversible", estimateCents: () => 2,
    async invoke() { return { output: { dispatched: true }, claimedCostCents: 2 }; } };
  const deploy: CapabilityPlugin = { name: "deploy.vercel", sideEffect: "write-irreversible", estimateCents: () => 1,
    async invoke() { return { output: { job: "dpl_abc123" }, claimedCostCents: 1 }; } };
  return new Map<string, CapabilityPlugin>([
    ["web_search", search], ["compose", compose], ["github.dispatch", dispatch], ["deploy.vercel", deploy],
  ]);
}

async function run(approve: (c: EffectCall) => boolean) {
  const { ring, owner, supervisorSigner, store, now } = rig();
  const { supervisor } = Supervisor.create(plugins());
  const initialState = { ...(manifest.seed ?? {}) } as Record<string, string | number | boolean | null>;
  const engine = new Engine(manifest, "t1", "r1", { store, owner, supervisor, supervisorSigner, now });
  const res = await engine.run({ maxSteps: 60, approve, initialState });
  const events = await store.read("t1");
  const seq = events.filter((e) => e.type === "NodeEntered").map((e) => (e.scope as { nodeId?: string }).nodeId);
  return { res, ring, store, events, seq };
}

test("publish-and-deploy validates structurally", () => {
  assert.deepEqual(validateManifest(manifest), []);
  // the deploy node is the only irreversible, human-gated step
  const deployNode = manifest.nodes.find((n) => n.id === "deploy")!;
  assert.equal(deployNode.autonomy, "suggest", "deploy must be approval-gated (suggest)");
  assert.equal(deployNode.capabilities[0]!.sideEffect, "write-irreversible", "deploy must be irreversible");
  // commit is a reversible write — should NOT need a gate
  const commitNode = manifest.nodes.find((n) => n.id === "commit")!;
  assert.equal(commitNode.capabilities[0]!.sideEffect, "write-reversible");
});

test("APPROVE path: the whole chain runs and the deploy ships — ledger verifies", async () => {
  const { res, ring, store, seq } = await run(() => true);
  assert.equal(res.status, "completed", `expected completed, got ${res.status} ${res.reason ?? ""}`);
  // the full build-and-ship chain executed in order
  assert.deepEqual(seq, ["research", "write", "commit", "deploy", "record"], "the full chain must run in order");
  // the irreversible deploy actually happened
  assert.equal(res.projection.state["deploy.job"], "dpl_abc123", "the deploy job must be in run state");
  // the whole signed ledger of the multi-side-effect chain verifies
  assert.ok(verify(await store.read("t1"), ring).ok, "the signed ledger must verify");
});

test("DENY path: the irreversible deploy is BLOCKED at the gate — nothing ships", async () => {
  // Approve everything EXCEPT the irreversible deploy.
  const { res, ring, store, seq } = await run((c) => c.capability !== "deploy.vercel");
  // the run must NOT complete a shipped deploy — it halts (awaiting approval) or ends without deploying.
  assert.notEqual(res.status, "completed", "a denied irreversible deploy must not complete as if it shipped");
  // research/write/commit ran, but the deploy never produced a job
  assert.ok(seq.includes("commit"), "the reversible steps up to commit still run");
  assert.equal(res.projection.state["deploy.job"], undefined, "the deploy MUST NOT have executed — nothing shipped");
  // even a halted/denied run's ledger is fully signed and verifies
  assert.ok(verify(await store.read("t1"), ring).ok, "the partial signed ledger must still verify");
});
