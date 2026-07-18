/**
 * synthetic_users — casts a spread of synthetic users for testing an agent. With no LLM key set it
 * falls back to the deterministic archetype cast, so these tests are hermetic (no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { syntheticUsersCapability, summariseCast } from "./synthetic-users.js";
import type { EffectCall } from "../capability/capability.js";

// Ensure no LLM is configured so we take the deterministic archetype path.
const priorProvider = process.env["KRELVAN_LLM_PROVIDER"];
const priorKey = process.env["KRELVAN_LLM_API_KEY"];
const priorAnthropic = process.env["KRELVAN_ANTHROPIC_KEY"];
function noLlm() { delete process.env["KRELVAN_LLM_PROVIDER"]; delete process.env["KRELVAN_LLM_API_KEY"]; delete process.env["KRELVAN_ANTHROPIC_KEY"]; }
function restore() {
  if (priorProvider === undefined) delete process.env["KRELVAN_LLM_PROVIDER"]; else process.env["KRELVAN_LLM_PROVIDER"] = priorProvider;
  if (priorKey === undefined) delete process.env["KRELVAN_LLM_API_KEY"]; else process.env["KRELVAN_LLM_API_KEY"] = priorKey;
  if (priorAnthropic === undefined) delete process.env["KRELVAN_ANTHROPIC_KEY"]; else process.env["KRELVAN_ANTHROPIC_KEY"] = priorAnthropic;
}

test("synthetic_users: casts a structured spread from the scenario (no LLM → archetypes)", async () => {
  noLlm();
  try {
    const call: EffectCall = { nodeId: "cast", capability: "synthetic_users", input: { scenario: "a password-reset support bot", count: 5 } };
    const { output } = await syntheticUsersCapability.invoke(call);
    const out = output as { users: Array<{ name: string; message: string }>; count: number; summary: string; generated: boolean };
    assert.equal(out.count, 5);
    assert.equal(out.users.length, 5);
    assert.equal(out.generated, false, "no LLM → deterministic cast");
    // Covers the key failure modes a tester cares about.
    const names = out.users.map((u) => u.name);
    assert.ok(names.includes("Happy path"));
    assert.ok(names.includes("Adversarial"));
    // Each user carries an opening message (possibly empty for the malformed-input persona).
    assert.ok(out.users.every((u) => typeof u.message === "string"));
    // The summary is clean markdown, no leaked field labels.
    assert.ok(out.summary.startsWith("## Synthetic users"));
    assert.ok(!/seedMessage|users\[/.test(out.summary));
  } finally { restore(); }
});

test("synthetic_users: count target is clamped to [3,8]; low end is honored", async () => {
  noLlm();
  try {
    // Low end: count 1 → clamped up to the minimum of 3.
    const lo = await syntheticUsersCapability.invoke({ nodeId: "c", capability: "synthetic_users", input: { scenario: "x", count: 1 } });
    assert.equal((lo.output as { count: number }).count, 3);
    // High end: count 99 → target clamped to 8, but the deterministic archetype cast has 5 fixed
    // archetypes, so with no LLM it returns at most 5 (never more than the target, never > 8).
    const hi = await syntheticUsersCapability.invoke({ nodeId: "c", capability: "synthetic_users", input: { scenario: "x", count: 99 } });
    const n = (hi.output as { count: number }).count;
    assert.ok(n >= 3 && n <= 8, `count ${n} within [3,8]`);
  } finally { restore(); }
});

test("summariseCast: renders a clean numbered list with quoted messages", () => {
  const md = summariseCast(
    [{ name: "Happy path", description: "clear ask", seedMessage: "reset my password" }],
    "support bot",
  );
  assert.ok(md.includes("## Synthetic users — support bot"));
  assert.ok(md.includes("1. **Happy path** — clear ask"));
  assert.ok(md.includes("“reset my password”"));
});
