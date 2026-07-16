/**
 * The verdict rule layer: pure, deterministic, facts-first. It must classify the headline correctly
 * (parking/looping beat a bare status) and surface the right findings — a visit-cap loop is a STOP,
 * a would-send is a WARN, and every rehearsal always reassures that nothing shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeRehearsal, verdictOf, type RehearsalOutcome } from "./verdict.js";

function outcome(over: Partial<RehearsalOutcome> = {}): RehearsalOutcome {
  return {
    status: "completed", suppressed: [], parkedForApproval: false, cappedNodes: [],
    spentCents: 0, budgetCents: 100, ...over,
  };
}

test("verdict headline: completed / parked / looped / failed", () => {
  assert.equal(verdictOf(outcome()), "completed");
  assert.equal(verdictOf(outcome({ parkedForApproval: true })), "parked");
  assert.equal(verdictOf(outcome({ status: "halted" })), "parked");
  assert.equal(verdictOf(outcome({ status: "failed", cappedNodes: ["lookup"] })), "looped");
  assert.equal(verdictOf(outcome({ status: "failed" })), "failed");
});

test("a visit-cap loop is the top finding and marks STOP", () => {
  const j = judgeRehearsal(outcome({ status: "failed", cappedNodes: ["lookup"] }));
  assert.equal(j.verdict, "looped");
  assert.equal(j.findings[0]!.level, "stop");
  assert.equal(j.findings[0]!.code, "visit_cap_loop");
  assert.match(j.findings[0]!.message, /lookup/);
});

test("a plain failure (no loop) is a STOP with the reason", () => {
  const j = judgeRehearsal(outcome({ status: "failed", reason: "no data" }));
  assert.equal(j.verdict, "failed");
  assert.equal(j.findings[0]!.code, "run_failed");
  assert.match(j.findings[0]!.message, /no data/);
});

test("suppressed consequential effects become a WARN with a per-tool summary", () => {
  const j = judgeRehearsal(outcome({
    suppressed: [
      { nodeId: "a", capability: "email_send", sideEffect: "message-human", input: {} },
      { nodeId: "b", capability: "email_send", sideEffect: "message-human", input: {} },
      { nodeId: "c", capability: "charge", sideEffect: "spend", input: {} },
    ],
  }));
  const w = j.findings.find(f => f.code === "would_send")!;
  assert.equal(w.level, "warn");
  assert.match(w.message, /3 real actions/);
  assert.match(w.message, /2× email_send/);
  assert.match(w.message, /1× charge/);
});

test("parking for approval is a WARN, budget near the limit is a WARN", () => {
  const j = judgeRehearsal(outcome({ parkedForApproval: true, spentCents: 85, budgetCents: 100 }));
  assert.ok(j.findings.some(f => f.code === "parked_for_approval" && f.level === "warn"));
  assert.ok(j.findings.some(f => f.code === "budget_near_limit" && f.level === "warn"));
});

test("a clean completion gets a positive finding and always reassures nothing shipped", () => {
  const j = judgeRehearsal(outcome());
  assert.equal(j.verdict, "completed");
  assert.ok(j.findings.some(f => f.code === "clean" && f.level === "ok"));
  assert.ok(j.findings.some(f => f.code === "nothing_delivered"), "every rehearsal reassures nothing was delivered");
});

test("findings are ordered most-severe first (stop, warn, ok)", () => {
  const j = judgeRehearsal(outcome({
    status: "failed", cappedNodes: ["n"],
    suppressed: [{ nodeId: "a", capability: "x", sideEffect: "spend", input: {} }],
  }));
  const levels = j.findings.map(f => f.level);
  const rank = { stop: 0, warn: 1, ok: 2 } as const;
  for (let i = 1; i < levels.length; i++) {
    assert.ok(rank[levels[i - 1]!] <= rank[levels[i]!], "levels are non-decreasing in severity rank");
  }
});
