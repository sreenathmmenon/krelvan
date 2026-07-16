/**
 * Persona casting: works with no LLM (deterministic archetypes), uses the model when present, and
 * degrades on ANY bad model output. A rehearsal must never be blocked by persona generation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generatePersonas, archetypeCast } from "./personas.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../../adapters/llm-client.js";

function fakeClient(text: string): LLMClient {
  return { async complete(_req: LLMRequest): Promise<LLMResponse> { return { text, inputTokens: 0, outputTokens: 0 }; } };
}

test("with no client, the deterministic archetype cast is used", async () => {
  const { personas, generated } = await generatePersonas({ intent: "answer refund questions", graphSummary: "one node", client: null });
  assert.equal(generated, false);
  assert.ok(personas.length >= 3);
  assert.ok(personas.some(p => /happy/i.test(p.name)));
  assert.ok(personas.some(p => p.seedMessage === ""), "the malformed-input archetype has an empty message");
});

test("archetype messages reference the agent's own goal", () => {
  const cast = archetypeCast("book meeting rooms");
  assert.ok(cast[0]!.seedMessage.includes("book meeting rooms"));
});

test("a valid model response is parsed and marked generated", async () => {
  const client = fakeClient(JSON.stringify({ personas: [
    { name: "Eager", description: "wants it now", seedMessage: "do it" },
    { name: "Vague", description: "unclear", seedMessage: "hmm" },
    { name: "Angry", description: "hostile", seedMessage: "this is broken" },
  ] }));
  const { personas, generated } = await generatePersonas({ intent: "x", graphSummary: "y", client });
  assert.equal(generated, true);
  assert.equal(personas.length, 3);
  assert.equal(personas[0]!.name, "Eager");
});

test("a JSON blob wrapped in prose/fences is still parsed", async () => {
  const client = fakeClient('Here is your cast:\n```json\n{"personas":[{"name":"A","description":"d","seedMessage":"m"},{"name":"B","description":"d","seedMessage":"m"},{"name":"C","description":"d","seedMessage":"m"}]}\n```\nEnjoy.');
  const { personas, generated } = await generatePersonas({ intent: "x", graphSummary: "y", client });
  assert.equal(generated, true);
  assert.equal(personas.length, 3);
});

test("garbage model output falls back to archetypes", async () => {
  const { personas, generated } = await generatePersonas({ intent: "help users", graphSummary: "y", client: fakeClient("not json at all") });
  assert.equal(generated, false, "fell back");
  assert.ok(personas.length >= 3);
});

test("too-few personas from the model falls back", async () => {
  const client = fakeClient(JSON.stringify({ personas: [{ name: "Only one", description: "d", seedMessage: "m" }] }));
  const { generated } = await generatePersonas({ intent: "x", graphSummary: "y", client });
  assert.equal(generated, false, "fewer than 3 usable personas → fallback");
});

test("count is clamped to [3,8]", async () => {
  const a = await generatePersonas({ intent: "x", graphSummary: "y", client: null, count: 1 });
  assert.ok(a.personas.length >= 3);
  const b = await generatePersonas({ intent: "x", graphSummary: "y", client: null, count: 99 });
  assert.ok(b.personas.length <= 8);
});
