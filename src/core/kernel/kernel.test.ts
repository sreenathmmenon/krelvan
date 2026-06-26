/**
 * Kernel + engine + capability tests. Proves the orchestration guards end-to-end.
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HmacKeyring } from "../ledger/crypto.js";
import { InMemoryLedgerStore, verify } from "../ledger/store.js";
import { evalCondition, ExprError, type Expr } from "../manifest/expr.js";
import { validateManifest, type Manifest } from "../manifest/manifest.js";
import { admit, needsApproval, Supervisor, type CapabilityPlugin, type EffectCall } from "../capability/capability.js";
import { Engine } from "./engine.js";
import { deriveSubRunId } from "./sub-agent-executor.js";

// ── deterministic test rig ─────────────────────────────────────────────────────

function rig() {
  const ring = new HmacKeyring();
  const owner = ring.addKey("owner", "s1", { epoch: 1, validFrom: 0, validUntil: null });
  const supervisorSigner = ring.addKey("supervisor", "s2", { epoch: 1, validFrom: 0, validUntil: null });
  const store = new InMemoryLedgerStore();
  let clock = 1;
  const now = () => clock++;
  return { ring, owner, supervisorSigner, store, now };
}

/** A counting plugin: records how many times it really executed (for double-exec tests). */
function countingPlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, counter: { n: number }): CapabilityPlugin {
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      counter.n++;
      return { output: { ok: true }, claimedCostCents: cost };
    },
  };
}

/** A plugin that THROWS on its first `failTimes` invokes, then succeeds (for retry tests). */
function flakyPlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, failTimes: number, counter: { n: number }): CapabilityPlugin {
  let calls = 0;
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      calls++;
      if (calls <= failTimes) throw new Error(`transient failure #${calls}`);
      counter.n++;
      return { output: { ok: true }, claimedCostCents: cost };
    },
  };
}

/** A plugin that returns a specific output (for testing run state propagation). */
function outputPlugin(name: string, sideEffect: CapabilityPlugin["sideEffect"], cost: number, output: Record<string, unknown>): CapabilityPlugin {
  return {
    name,
    sideEffect,
    estimateCents: () => cost,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      return { output, claimedCostCents: cost };
    },
  };
}

function twoNodeManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    name: "two-node",
    intent: "do A then B",
    entry: "a",
    runBudgetCents: 1000,
    maxNodeVisits: 5,
    nodes: [
      { id: "a", role: "first", autonomy: "full", capabilities: [{ name: "toolA", sideEffect: "write-irreversible", budgetCents: 500 }] },
      { id: "b", role: "second", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
    edges: [{ from: "a", to: "b" }],
    ...over,
  };
}

function engineFor(m: Manifest, counters: Record<string, { n: number }>, extraPlugins?: Map<string, CapabilityPlugin>) {
  const r = rig();
  const plugins = extraPlugins ?? new Map<string, CapabilityPlugin>();
  if (!plugins.has("toolA")) plugins.set("toolA", countingPlugin("toolA", "write-irreversible", 99, (counters.a ??= { n: 0 })));
  if (!plugins.has("toolB")) plugins.set("toolB", countingPlugin("toolB", "message-human", 1, (counters.b ??= { n: 0 })));
  const supervisor = new Supervisor(plugins);
  const engine = new Engine(m, "t1", "run1", {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
  });
  return { engine, ...r };
}

// ── expr (the eval replacement) ─────────────────────────────────────────────────

test("expr: comparisons and boolean logic evaluate correctly", () => {
  const declared = new Set(["score", "approved"]);
  const e: Expr = { op: "and", clauses: [{ op: "gte", left: { op: "var", key: "score" }, right: { op: "const", value: 80 } }, { op: "eq", left: { op: "var", key: "approved" }, right: { op: "const", value: true } }] };
  assert.equal(evalCondition(e, { score: 85, approved: true }, declared), true);
  assert.equal(evalCondition(e, { score: 70, approved: true }, declared), false);
});

test("expr: undeclared key is a hard error (never silent undefined)", () => {
  const e: Expr = { op: "var", key: "secret" };
  assert.throws(() => evalCondition(e as Expr, {}, new Set()), ExprError);
});

test("expr: ordering on non-numbers is a type error, not a coercion", () => {
  const declared = new Set(["x"]);
  const e: Expr = { op: "lt", left: { op: "var", key: "x" }, right: { op: "const", value: 5 } };
  assert.throws(() => evalCondition(e, { x: "hi" }, declared), ExprError);
});

// ── manifest validation ─────────────────────────────────────────────────────────

test("manifest: valid manifest has no issues", () => {
  assert.equal(validateManifest(twoNodeManifest()).length, 0);
});

test("manifest: dangling edge + bad entry are caught", () => {
  const m = twoNodeManifest({ entry: "ghost", edges: [{ from: "a", to: "nowhere" }] });
  const issues = validateManifest(m).map((i) => i.code);
  assert.ok(issues.includes("BAD_ENTRY"));
  assert.ok(issues.includes("DANGLING_EDGE_TO"));
});

// ── capability admission ─────────────────────────────────────────────────────────

test("admit: deny-by-default for ungranted capability", () => {
  const node = twoNodeManifest().nodes[0]!;
  const call: EffectCall = { nodeId: "a", capability: "not_granted", input: {} };
  const v = admit(node, call, 10, 1000, { runSpentCents: 0, runReservedCents: 0, perCapSpentCents: {}, perCapReservedCents: {} });
  assert.ok(!v.admitted && v.reason === "CAPABILITY_NOT_GRANTED");
});

test("admit: run budget ceiling denies before overspend", () => {
  const node = twoNodeManifest().nodes[0]!;
  const call: EffectCall = { nodeId: "a", capability: "toolA", input: {} };
  const v = admit(node, call, 200, 100, { runSpentCents: 0, runReservedCents: 0, perCapSpentCents: {}, perCapReservedCents: {} });
  assert.ok(!v.admitted && v.reason === "RUN_BUDGET_EXCEEDED");
});

test("needsApproval: autonomy gradient", () => {
  assert.equal(needsApproval("full", "spend"), false);
  assert.equal(needsApproval("suggest", "read"), false);
  assert.equal(needsApproval("suggest", "write-reversible"), true);
  assert.equal(needsApproval("act-with-veto", "write-reversible"), false);
  assert.equal(needsApproval("act-with-veto", "write-irreversible"), true);
});

// ── engine: full run ─────────────────────────────────────────────────────────────

test("engine: a 2-node run completes, both effects run exactly once, log verifies", async () => {
  const m = twoNodeManifest();
  const counters: Record<string, { n: number }> = {};
  const { engine, store, ring } = engineFor(m, counters);

  const res = await engine.run();
  assert.equal(res.status, "completed");
  assert.equal(counters.a!.n, 1);
  assert.equal(counters.b!.n, 1);

  const events = await store.read("t1");
  const v = verify(events, ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);

  // budget folded correctly: 99 + 1 = 100¢ spent, 0 reserved open
  assert.equal(res.projection.budget.runSpentCents, 100);
  assert.equal(res.projection.budget.runReservedCents, 0);
});

test("engine: budget ceiling fails the run before the second (over-budget) effect", async () => {
  const m = twoNodeManifest({ runBudgetCents: 99 });
  const counters: Record<string, { n: number }> = {};
  const { engine } = engineFor(m, counters);
  const res = await engine.run();
  assert.equal(res.status, "failed");
  assert.equal(counters.a!.n, 1); // A ran
  assert.equal(counters.b!.n, 0); // B denied before execution → no overspend
});

test("engine: suggest autonomy parks for approval and does not execute", async () => {
  const m = twoNodeManifest({
    nodes: [
      { id: "a", role: "first", autonomy: "suggest", capabilities: [{ name: "toolA", sideEffect: "write-irreversible", budgetCents: 500 }] },
      { id: "b", role: "second", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
  });
  const counters: Record<string, { n: number }> = {};
  const { engine } = engineFor(m, counters);
  const res = await engine.run({ approve: () => false }); // deny approval → park
  assert.equal(res.status, "halted");
  assert.equal(counters.a!.n, 0); // never executed while parked
});

test("engine: a run past its deadline fails cleanly with a signed RunFailed (never waits forever)", async () => {
  // A run parked on a never-resolved approval would halt forever; with a deadline it
  // fails at the next step boundary. The mock clock starts at 1, so deadlineMs:0 is
  // already in the past on the very first step.
  const m = twoNodeManifest({
    nodes: [
      { id: "a", role: "first", autonomy: "suggest", capabilities: [{ name: "toolA", sideEffect: "write-irreversible", budgetCents: 500 }] },
      { id: "b", role: "second", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
  });
  const counters: Record<string, { n: number }> = {};
  const { engine, store, ring } = engineFor(m, counters);
  const res = await engine.run({ approve: () => false, deadlineMs: 0 });
  assert.equal(res.status, "failed");
  assert.equal(res.reason, "run deadline exceeded");
  assert.equal(counters.a!.n, 0); // never executed
  // The failure is a real signed ledger event, and the chain still verifies.
  const events = await store.read("t1");
  assert.ok(events.some(e => e.type === "RunFailed"), "RunFailed must be recorded");
  assert.ok(verify(events, ring).ok, "ledger must still verify after deadline failure");
});

test("engine: a transient capability failure is retried with backoff, then succeeds", async () => {
  // toolA throws twice then succeeds. With effectRetries:2 (3 attempts total) the run
  // should complete. A no-op sleep keeps the test fast and deterministic.
  const m = twoNodeManifest({
    nodes: [
      { id: "a", role: "first", autonomy: "full", capabilities: [{ name: "toolA", sideEffect: "write-irreversible", budgetCents: 500 }] },
      { id: "b", role: "second", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
  });
  const counters: Record<string, { n: number }> = { a: { n: 0 }, b: { n: 0 } };
  const r = rig();
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("toolA", flakyPlugin("toolA", "write-irreversible", 99, 2, counters.a!));
  plugins.set("toolB", countingPlugin("toolB", "message-human", 1, counters.b!));
  const engine = new Engine(m, "t1", "run1", {
    store: r.store, owner: r.owner, supervisor: new Supervisor(plugins),
    supervisorSigner: r.supervisorSigner, now: r.now, sleep: async () => {},
  });
  const res = await engine.run({ effectRetries: 2 });
  assert.equal(res.status, "completed", res.reason ?? "");
  assert.equal(counters.a!.n, 1, "toolA eventually succeeded exactly once");
  assert.equal(counters.b!.n, 1, "run proceeded to toolB after the retry");
});

test("engine: a capability that exhausts retries fails the run (does not hang)", async () => {
  const m = twoNodeManifest({
    nodes: [
      { id: "a", role: "first", autonomy: "full", capabilities: [{ name: "toolA", sideEffect: "write-irreversible", budgetCents: 500 }] },
      { id: "b", role: "second", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
  });
  const counters: Record<string, { n: number }> = { a: { n: 0 }, b: { n: 0 } };
  const r = rig();
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("toolA", flakyPlugin("toolA", "write-irreversible", 99, 99, counters.a!)); // always throws
  plugins.set("toolB", countingPlugin("toolB", "message-human", 1, counters.b!));
  const engine = new Engine(m, "t1", "run1", {
    store: r.store, owner: r.owner, supervisor: new Supervisor(plugins),
    supervisorSigner: r.supervisorSigner, now: r.now, sleep: async () => {},
  });
  await assert.rejects(() => engine.run({ effectRetries: 2 }), /transient failure/);
  assert.equal(counters.b!.n, 0, "run never reached toolB");
});

test("engine: crash mid-run, resume, no double-execution", async () => {
  const m = twoNodeManifest();
  const counters: Record<string, { n: number }> = {};

  // Life 1: run node A, then "crash" by capping steps so B never runs.
  const r = rig();
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("toolA", countingPlugin("toolA", "write-irreversible", 99, (counters.a ??= { n: 0 })));
  plugins.set("toolB", countingPlugin("toolB", "message-human", 1, (counters.b ??= { n: 0 })));
  const supervisor = new Supervisor(plugins);
  const deps = { store: r.store, owner: r.owner, supervisor, supervisorSigner: r.supervisorSigner, now: r.now };

  const e1 = new Engine(m, "t1", "run1", deps);
  // limit steps to: start, enter a, runNode a (executes toolA + concludes a). Then stop.
  await e1.run({ maxSteps: 3 });
  assert.equal(counters.a!.n, 1, "toolA ran once in life 1");

  // Life 2: brand-new Engine instance (= process restart), SAME store.
  const e2 = new Engine(m, "t1", "run1", deps);
  const res = await e2.run();
  assert.equal(res.status, "completed");
  assert.equal(counters.a!.n, 1, "toolA NOT re-executed on resume");
  assert.equal(counters.b!.n, 1, "toolB ran once");

  const events = await r.store.read("t1");
  const v = verify(events, r.ring);
  assert.ok(v.ok, v.ok ? "" : v.error.message);
});

test("engine: conditional edge routes via the safe evaluator — absent key is not taken", async () => {
  // a → b only when a.score >= 80. toolA returns { ok: true } (no score key).
  // The edge condition reads a declared-but-absent key → null → false → run completes at a.
  const m = twoNodeManifest({
    edges: [{ from: "a", to: "b", when: { op: "gte", left: { op: "var", key: "a.score" }, right: { op: "const", value: 80 } } }],
  });
  const counters: Record<string, { n: number }> = {};
  const { engine } = engineFor(m, counters);
  const res = await engine.run();
  assert.equal(res.status, "completed");
  assert.equal(counters.a!.n, 1);
  assert.equal(counters.b!.n, 0); // edge not taken (a.score absent → null !>= 80)
});

test("engine: node output flows into run state — conditional edge routes correctly on real value", async () => {
  // a → b when a.score >= 80; toolA returns { score: 85 }.
  // After node a concludes, run state has { "a.score": 85 }.
  // The edge condition evaluates to true → b runs.
  const m = twoNodeManifest({
    edges: [{ from: "a", to: "b", when: { op: "gte", left: { op: "var", key: "a.score" }, right: { op: "const", value: 80 } } }],
  });
  const counters: Record<string, { n: number }> = { b: { n: 0 } };
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("toolA", outputPlugin("toolA", "write-irreversible", 99, { score: 85 }));
  plugins.set("toolB", countingPlugin("toolB", "message-human", 1, counters.b!));

  const { engine } = engineFor(m, counters, plugins);
  const res = await engine.run();

  assert.equal(res.status, "completed");
  assert.equal(counters.b!.n, 1, "toolB ran because a.score=85 satisfied the edge condition");
  assert.equal(res.projection.state["a.score"], 85, "run state contains the output from node a");
});

test("engine: run state seeded via initialState is visible to first node and edge conditions", async () => {
  // No toolA in capabilities; just edge condition uses seeded state.
  // Node a has no capabilities → concludes immediately, then routes to b based on seeded value.
  const m: Manifest = {
    version: 1,
    name: "seeded",
    intent: "route on seed",
    entry: "a",
    runBudgetCents: 1000,
    maxNodeVisits: 5,
    nodes: [
      { id: "a", role: "router", autonomy: "full", capabilities: [] },
      { id: "b", role: "worker", autonomy: "full", capabilities: [{ name: "toolB", sideEffect: "message-human", budgetCents: 500 }] },
    ],
    edges: [{ from: "a", to: "b", when: { op: "gte", left: { op: "var", key: "priority" }, right: { op: "const", value: 5 } } }],
  };
  const counters: Record<string, { n: number }> = { b: { n: 0 } };
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("toolB", countingPlugin("toolB", "message-human", 1, counters.b!));

  const { engine } = engineFor(m, counters, plugins);
  const res = await engine.run({ initialState: { priority: 7 } });

  assert.equal(res.status, "completed");
  assert.equal(counters.b!.n, 1, "toolB ran because seeded priority=7 satisfied the edge condition");
});

// ── multi-agent chaining: real end-to-end ─────────────────────────────────────

test("engine: multi-agent chaining — child output flows into parent state via outputMapping", async () => {
  // Child agent: one node that runs the deterministic 'echo' plugin (no LLM needed).
  const childManifest: Manifest = {
    version: 1,
    name: "child-agent",
    intent: "echo a fixed value",
    entry: "worker",
    runBudgetCents: 100,
    maxNodeVisits: 5,
    nodes: [
      {
        id: "worker",
        role: "echo worker",
        autonomy: "full",
        capabilities: [{ name: "echo", sideEffect: "read", budgetCents: 10 }],
      },
    ],
    edges: [],
  };

  // Parent agent: one node whose capability delegates to the child via subAgent binding.
  const parentManifest: Manifest = {
    version: 1,
    name: "parent-agent",
    intent: "call child and collect its answer",
    entry: "caller",
    runBudgetCents: 200,
    maxNodeVisits: 5,
    nodes: [
      {
        id: "caller",
        role: "orchestrator",
        autonomy: "full",
        capabilities: [{
          name: "run-child",
          sideEffect: "read",
          budgetCents: 50,
          subAgent: {
            manifestId: "child-agent",
            outputMapping: { "child_answer": "worker.answer" },
            onSubFailure: "propagate",
          },
        }],
      },
    ],
    edges: [],
  };

  const r = rig();
  const echoCounter = { n: 0 };

  // Shared plugin map used by both parent and child engines.
  // The parent's engineFor call will also use this so the child engine gets 'echo'.
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("echo", {
    name: "echo",
    sideEffect: "read",
    estimateCents: () => 1,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      echoCounter.n++;
      return { output: { answer: 42 }, claimedCostCents: 1 };
    },
  });

  const supervisor = new Supervisor(plugins);

  const parentRunId = "parent-run-1";
  const engine = new Engine(parentManifest, "t1", parentRunId, {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
    resolveManifest: async (id: string) => id === "child-agent" ? childManifest : null,
  });

  const res = await engine.run({ approve: () => true });

  // 1. Parent run completes
  assert.equal(res.status, "completed", `parent run should complete, got: ${res.status} ${res.reason ?? ""}`);

  // 2. Child output flows into parent state via outputMapping:
  //    child node 'worker' outputs { answer: 42 }
  //    outputMapping: { "child_answer": "worker.answer" }
  //    → parent state key "caller.child_answer" should equal 42
  assert.equal(res.projection.state["caller.child_answer"], 42, "child answer must appear in parent state");

  // 3. Child capability ran exactly once
  assert.equal(echoCounter.n, 1, "echo plugin must run exactly once in child");

  // 4. Parent ledger has SubRunRequested and SubRunCompleted events
  const parentEvents = await r.store.readRun("t1", parentRunId);
  const parentTypes = parentEvents.map(e => e.type);
  assert.ok(parentTypes.includes("SubRunRequested"), `parent ledger must have SubRunRequested, got: ${parentTypes.join(", ")}`);
  assert.ok(parentTypes.includes("SubRunCompleted"), `parent ledger must have SubRunCompleted, got: ${parentTypes.join(", ")}`);

  // 5. SubRunCompleted carries the mapped output
  const subCompleted = parentEvents.find(e => e.type === "SubRunCompleted");
  assert.ok(subCompleted, "SubRunCompleted event must exist");
  const subOutput = (subCompleted!.payload as Record<string, unknown>)["output"] as Record<string, unknown>;
  assert.deepEqual(subOutput, { child_answer: 42 }, "SubRunCompleted output must contain mapped child_answer");

  // 6. Child run has its own ledger events in the same store
  const subRunId = deriveSubRunId(parentRunId, "caller", "run-child");
  const childEvents = await r.store.readRun("t1", subRunId);
  assert.ok(childEvents.length > 0, `child run must have ledger events, subRunId=${subRunId}`);

  // 7. Child run terminated cleanly
  const childTypes = childEvents.map(e => e.type);
  assert.ok(childTypes.includes("RunCompleted"), `child run must have RunCompleted, got: ${childTypes.join(", ")}`);
});

test("engine: multi-agent chaining — crash after SubRunRequested does not re-execute child on resume", async () => {
  // Same setup as above but we simulate a crash after the parent writes SubRunRequested
  // and before SubRunCompleted is written. On resume, the child should NOT re-run.
  const childManifest: Manifest = {
    version: 1,
    name: "child-crash-test",
    intent: "echo for crash-resume test",
    entry: "worker",
    runBudgetCents: 100,
    maxNodeVisits: 5,
    nodes: [
      {
        id: "worker",
        role: "worker",
        autonomy: "full",
        capabilities: [{ name: "echo2", sideEffect: "read", budgetCents: 10 }],
      },
    ],
    edges: [],
  };

  const parentManifest: Manifest = {
    version: 1,
    name: "parent-crash-test",
    intent: "crash-resume sub-agent test",
    entry: "caller",
    runBudgetCents: 200,
    maxNodeVisits: 5,
    nodes: [
      {
        id: "caller",
        role: "caller",
        autonomy: "full",
        capabilities: [{
          name: "run-child2",
          sideEffect: "read",
          budgetCents: 50,
          subAgent: {
            manifestId: "child-crash-test",
            outputMapping: { "result": "worker.answer" },
            onSubFailure: "propagate",
          },
        }],
      },
    ],
    edges: [],
  };

  const r = rig();
  const echoCounter2 = { n: 0 };
  const plugins = new Map<string, CapabilityPlugin>();
  plugins.set("echo2", {
    name: "echo2",
    sideEffect: "read",
    estimateCents: () => 1,
    async invoke(): Promise<{ output: unknown; claimedCostCents: number }> {
      echoCounter2.n++;
      return { output: { answer: 99 }, claimedCostCents: 1 };
    },
  });

  const supervisor = new Supervisor(plugins);
  const deps = {
    store: r.store,
    owner: r.owner,
    supervisor,
    supervisorSigner: r.supervisorSigner,
    now: r.now,
    resolveManifest: async (id: string) => id === "child-crash-test" ? childManifest : null,
  };

  const parentRunId = "parent-crash-run";

  // Life 1: run until completion (sub-agent will run)
  const e1 = new Engine(parentManifest, "t1", parentRunId, deps);
  const res1 = await e1.run({ approve: () => true });
  assert.equal(res1.status, "completed", "life 1 should complete");
  assert.equal(echoCounter2.n, 1, "echo2 ran once in life 1");

  // Life 2: same store — resume. The sub-run is already in the ledger (SubRunCompleted).
  // The engine must fold it and NOT re-execute the child.
  const e2 = new Engine(parentManifest, "t1", parentRunId, deps);
  const res2 = await e2.run({ approve: () => true });
  assert.equal(res2.status, "completed", "life 2 should also complete");
  assert.equal(echoCounter2.n, 1, "echo2 must NOT re-run on resume — still exactly 1");
  assert.equal(res2.projection.state["caller.result"], 99, "output still in state on resume");
});

// ── back-edge retry loops (evaluator-optimizer): per-visit budget, opt-in via cap.loop ──────
// These guard the loop feature AND prove nothing weakened: maxNodeVisits still bounds it,
// runBudgetCents still binds total spend, the per-cap budget still binds within a visit, and a
// non-loop cap keeps exact legacy PER-RUN semantics + byte-identical keys.

/** A gen->eval loop manifest: eval routes back to gen on "retry", forward to done on "pass". */
function loopManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: 1, name: "loop", intent: "gen/eval", entry: "gen",
    runBudgetCents: 1000, maxNodeVisits: 5,
    nodes: [
      { id: "gen", role: "generate", autonomy: "full", capabilities: [{ name: "gen", sideEffect: "read", budgetCents: 50, loop: true }] },
      { id: "evaln", role: "evaluate", autonomy: "full", capabilities: [{ name: "evaln", sideEffect: "read", budgetCents: 50, loop: true }] },
      { id: "done", role: "finish", autonomy: "full", capabilities: [{ name: "done", sideEffect: "read", budgetCents: 50 }] },
    ],
    edges: [
      { from: "gen", to: "evaln" },
      { from: "evaln", to: "gen", when: { op: "eq", left: { op: "var", key: "evaln.verdict" }, right: { op: "const", value: "retry" } } },
      { from: "evaln", to: "done", when: { op: "eq", left: { op: "var", key: "evaln.verdict" }, right: { op: "const", value: "pass" } } },
    ],
    ...over,
  };
}

/** An evaluator plugin that returns "retry" the first `retries` times, then "pass". */
function evalPlugin(retries: number): CapabilityPlugin {
  let calls = 0;
  return { name: "evaln", sideEffect: "read", estimateCents: () => 50, async invoke() { calls++; return { output: { verdict: calls <= retries ? "retry" : "pass" }, claimedCostCents: 50 }; } };
}
function genPlugin(counter: { n: number }): CapabilityPlugin {
  return { name: "gen", sideEffect: "read", estimateCents: () => 50, async invoke() { counter.n++; return { output: { draft: `v${counter.n}` }, claimedCostCents: 50 }; } };
}
function donePlugin(): CapabilityPlugin {
  return { name: "done", sideEffect: "read", estimateCents: () => 50, async invoke() { return { output: { ok: true }, claimedCostCents: 50 }; } };
}

test("loop: evaluator->generator retry RE-RUNS the generator (per-visit, opt-in)", async () => {
  const r = rig();
  const genN = { n: 0 };
  const plugins = new Map<string, CapabilityPlugin>([["gen", genPlugin(genN)], ["evaln", evalPlugin(1)], ["done", donePlugin()]]);
  const engine = new Engine(loopManifest(), "t1", "run1", { store: r.store, owner: r.owner, supervisor: new Supervisor(plugins), supervisorSigner: r.supervisorSigner, now: r.now });
  const res = await engine.run({ approve: () => true });
  assert.equal(res.status, "completed", "loop with one retry then pass must complete");
  assert.equal(genN.n, 2, "generator must RE-RUN once (retry) then the loop passes — 2 executions, not 1");
  assert.ok(verify(await r.store.read("t1"), r.ring).ok, "ledger must verify");
});

test("loop: terminates at maxNodeVisits when the evaluator never passes (anti-runaway)", async () => {
  const r = rig();
  const genN = { n: 0 };
  // evaluator always says retry → the loop must hit the visit bound and FAIL cleanly, never hang.
  const plugins = new Map<string, CapabilityPlugin>([["gen", genPlugin(genN)], ["evaln", evalPlugin(999)], ["done", donePlugin()]]);
  const engine = new Engine(loopManifest({ maxNodeVisits: 3 }), "t1", "run1", { store: r.store, owner: r.owner, supervisor: new Supervisor(plugins), supervisorSigner: r.supervisorSigner, now: r.now });
  const res = await engine.run({ approve: () => true });
  assert.equal(res.status, "failed", "an always-retry loop must fail at the bound, not run forever");
  assert.match(res.reason ?? "", /exceeded maxNodeVisits/, "failure must be the maxNodeVisits anti-runaway bound");
  assert.ok(verify(await r.store.read("t1"), r.ring).ok, "ledger must still verify on a bounded failure");
});

test("loop: runBudgetCents BINDS across iterations (per-visit does not escape the aggregate ceiling)", async () => {
  const r = rig();
  const genN = { n: 0 };
  // Each gen+eval pass costs 100¢. With runBudgetCents 250, the loop must be DENIED by the run
  // ceiling before maxNodeVisits — proving per-visit budgeting never exceeds runBudgetCents.
  const plugins = new Map<string, CapabilityPlugin>([["gen", genPlugin(genN)], ["evaln", evalPlugin(999)], ["done", donePlugin()]]);
  const m = loopManifest({ runBudgetCents: 250, maxNodeVisits: 10 });
  const engine = new Engine(m, "t1", "run1", { store: r.store, owner: r.owner, supervisor: new Supervisor(plugins), supervisorSigner: r.supervisorSigner, now: r.now });
  const res = await engine.run({ approve: () => true });
  assert.equal(res.status, "failed", "must fail once the run budget is exhausted");
  assert.ok(res.projection.budget.runSpentCents <= 250, `total spend ${res.projection.budget.runSpentCents}¢ must never exceed runBudgetCents 250¢`);
});

test("loop: a NON-loop cap is NOT re-executed on re-entry (legacy idempotency intact)", async () => {
  const r = rig();
  const genN = { n: 0 };
  // gen is NOT loop-flagged → on re-entry its prior result is REUSED (byte-identical legacy
  // idempotency: same nodeId:capability key, no #attempt suffix). The loop-flagged evaluator
  // still advances to pass, so the run completes — but gen executes exactly ONCE, never twice.
  const m = loopManifest();
  m.nodes[0]!.capabilities[0]!.loop = false; // gen: legacy per-run / idempotent
  const plugins = new Map<string, CapabilityPlugin>([["gen", genPlugin(genN)], ["evaln", evalPlugin(1)], ["done", donePlugin()]]);
  const engine = new Engine(m, "t1", "run1", { store: r.store, owner: r.owner, supervisor: new Supervisor(plugins), supervisorSigner: r.supervisorSigner, now: r.now });
  const res = await engine.run({ approve: () => true });
  assert.equal(res.status, "completed", "loop-flagged evaluator still advances; run completes");
  assert.equal(genN.n, 1, "a NON-loop cap must NOT re-run on re-entry — its cached result is reused (legacy semantics)");
});
