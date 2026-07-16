/**
 * Report assembly: the roll-up counts verdicts, tallies findings by severity, headlines the most
 * severe finding, and flags hasBlocker when any persona hit a STOP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReport, type PersonaResult } from "./report.js";

function pr(name: string, verdict: PersonaResult["judgement"]["verdict"], findings: PersonaResult["judgement"]["findings"]): PersonaResult {
  return { persona: { name, description: "d", seedMessage: "m" }, runId: `r-${name}`, judgement: { verdict, findings } };
}

test("roll-up counts verdicts and headlines the most severe finding", () => {
  const report = buildReport({
    rehearsalId: "x", agentId: "a", agentName: "A", createdAt: 1, personasGenerated: true,
    results: [
      pr("happy", "completed", [{ level: "ok", code: "clean", message: "" }]),
      pr("edge", "looped", [{ level: "stop", code: "visit_cap_loop", message: "looped" }, { level: "ok", code: "nothing_delivered", message: "" }]),
      pr("send", "parked", [{ level: "warn", code: "would_send", message: "" }, { level: "warn", code: "parked_for_approval", message: "" }]),
    ],
  });
  assert.equal(report.rollup.total, 3);
  assert.equal(report.rollup.byVerdict.completed, 1);
  assert.equal(report.rollup.byVerdict.looped, 1);
  assert.equal(report.rollup.byVerdict.parked, 1);
  assert.equal(report.rollup.headline!.code, "visit_cap_loop", "a stop headlines over warns");
  assert.equal(report.rollup.hasBlocker, true);
  assert.equal(report.rollup.findingCounts.stop, 1);
  assert.equal(report.rollup.findingCounts.warn, 2);
});

test("no stop findings → no blocker, headline is the worst warn (or null)", () => {
  const clean = buildReport({
    rehearsalId: "x", agentId: "a", agentName: "A", createdAt: 1, personasGenerated: false,
    results: [pr("happy", "completed", [{ level: "ok", code: "clean", message: "" }])],
  });
  assert.equal(clean.rollup.hasBlocker, false);
  assert.equal(clean.rollup.headline, null, "all-ok has no headline");

  const warned = buildReport({
    rehearsalId: "x", agentId: "a", agentName: "A", createdAt: 1, personasGenerated: false,
    results: [pr("send", "parked", [{ level: "warn", code: "would_send", message: "" }])],
  });
  assert.equal(warned.rollup.hasBlocker, false);
  assert.equal(warned.rollup.headline!.code, "would_send");
});
