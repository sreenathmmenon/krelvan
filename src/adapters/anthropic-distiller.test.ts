/**
 * Tests for AnthropicDistiller. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicDistiller, DistillationError } from "./anthropic-distiller.js";
import type { Episode } from "../core/memory/memory.js";

const noSleep = () => Promise.resolve();

function modelResp(body: string): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: body }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

const episodes: Episode[] = [
  { runId: "r1", summary: "Searched for AI news, found 5 articles", provenance: "tool-observed", ts: 1 },
  { runId: "r2", summary: "User prefers short briefs, under 200 words", provenance: "owner", ts: 2 },
];

test("distiller: extracts valid facts from a clean model response", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp('[{"key":"user_brief_preference","value":"short"},{"key":"articles_found","value":5}]'),
  });

  const facts = await d.distill(episodes, [], 1, 100);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.key, "user_brief_preference");
  assert.equal(facts[0]!.value, "short");
  assert.equal(facts[0]!.version, 1);
  assert.equal(facts[0]!.ts, 100);
  assert.equal(facts[0]!.distilledBy, "claude-haiku-4-5-20251001");
  assert.deepEqual(facts[0]!.derivedFrom, ["r1", "r2"]);
});

test("distiller: provenance inherits least-trusted source (owner + tool-observed → owner)", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp('[{"key":"x","value":1}]'),
  });
  const facts = await d.distill(episodes, [], 1, 1);
  assert.equal(facts[0]!.provenance, "owner");
});

test("distiller: untrusted episode taints all facts (channel provenance propagates)", async () => {
  const channelEp: Episode = { runId: "r3", summary: "Via Telegram", provenance: "channel", ts: 3 };
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp('[{"key":"x","value":true}]'),
  });
  const facts = await d.distill([...episodes, channelEp], [], 1, 1);
  assert.equal(facts[0]!.provenance, "channel");
});

test("distiller: strips code fences from model output", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp('```json\n[{"key":"k","value":"v"}]\n```'),
  });
  const facts = await d.distill(episodes, [], 1, 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.key, "k");
});

test("distiller: skips malformed fact entries silently", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp('[{"key":"valid","value":1},{"key":"BadCase","value":"x"},{"value":"no-key"},{"key":"ok","value":true}]'),
  });
  const facts = await d.distill(episodes, [], 1, 1);
  // "BadCase" fails snake_case check; {"value":"no-key"} has no key → both skipped
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.key, "valid");
  assert.equal(facts[1]!.key, "ok");
});

test("distiller: returns [] for empty episodes", async () => {
  const d = new AnthropicDistiller({ apiKey: "test" });
  const facts = await d.distill([], [], 1, 1);
  assert.equal(facts.length, 0);
});

test("distiller: model returns [] → empty facts array", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp("[]"),
  });
  const facts = await d.distill(episodes, [], 1, 1);
  assert.equal(facts.length, 0);
});

test("distiller: non-JSON response throws DistillationError", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 1, sleepImpl: noSleep },
    fetchImpl: modelResp("here are your facts!"),
  });
  await assert.rejects(
    () => d.distill(episodes, [], 1, 1),
    (e) => e instanceof DistillationError,
  );
});

test("distiller: API 429 → retry → 200 succeeds", async () => {
  let calls = 0;
  const f: typeof fetch = async () => {
    calls++;
    if (calls === 1)
      return new Response("rate limited", { status: 429 });
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: '[{"key":"retry_worked","value":true}]' }] }),
      { status: 200 },
    );
  };
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 2, sleepImpl: noSleep },
    fetchImpl: f,
  });
  const facts = await d.distill(episodes, [], 1, 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.key, "retry_worked");
  assert.equal(calls, 2);
});

test("distiller: API 500 × maxAttempts throws DistillationError with rawOutput", async () => {
  const d = new AnthropicDistiller({
    apiKey: "test",
    retry: { maxAttempts: 2, sleepImpl: noSleep },
    fetchImpl: async () => new Response("internal error", { status: 500 }),
  });
  await assert.rejects(
    () => d.distill(episodes, [], 1, 1),
    (e) => e instanceof DistillationError && e.rawOutput.includes("internal error"),
  );
});
