/**
 * think robustness tests — the GENERAL fixes that keep every agent production-grade:
 *   - only DECLARED output keys are adopted from a flat model response (no garbage keys)
 *   - stringified booleans/integers are coerced to real types (so conditional edges match)
 *   - non-integer numbers are coerced to strings (the ledger rejects them)
 *
 * These assert the pure output-normalisation behaviour by exercising thinkCapability with a
 * stubbed LLM (KRELVAN_LLM_PROVIDER pointed at a local stub via the OpenAI-compatible path
 * is heavy), so instead we test the exported normaliser used by invoke. We re-expose it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasUsableThinkOutput,
  createModelContextEvidence,
  normalizeThinkOutputs,
  resolveThinkMaxBodyChars,
  resolveThinkMaxTokens,
  resolveThinkMaxValueChars,
} from "./think.js";

test("think provenance: records exact context coverage without copying source data", () => {
  const evidence = createModelContextEvidence("fetch.body", "private source value", 7, "source");
  assert.equal(evidence.key, "fetch.body");
  assert.equal(evidence.observedChars, 20);
  assert.equal(evidence.includedChars, 7);
  assert.equal(evidence.truncated, true);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /private source value/);
});

test("think: hosted reasoning gets headroom while Ollama keeps a conservative default", () => {
  assert.equal(resolveThinkMaxTokens("openai"), 8192);
  assert.equal(resolveThinkMaxTokens("anthropic"), 4096);
  assert.equal(resolveThinkMaxTokens("ollama"), 2048);
});

test("think: explicit output budget is bounded and invalid values fall back safely", () => {
  assert.equal(resolveThinkMaxTokens("openai", "6000"), 6000);
  assert.equal(resolveThinkMaxTokens("openai", "100"), 512);
  assert.equal(resolveThinkMaxTokens("openai", "999999"), 32768);
  assert.equal(resolveThinkMaxTokens("openai", "not-a-number"), 8192);
});

test("think: hosted providers receive a complete default HTTP body while Ollama stays smaller", () => {
  assert.equal(resolveThinkMaxBodyChars("openai"), 32768);
  assert.equal(resolveThinkMaxBodyChars("anthropic"), 32768);
  assert.equal(resolveThinkMaxBodyChars("ollama"), 12000);
  assert.equal(resolveThinkMaxBodyChars("openai", "48000"), 48000);
});

test("think: hosted downstream steps retain long intermediate results while Ollama stays bounded", () => {
  assert.equal(resolveThinkMaxValueChars("openai"), 12000);
  assert.equal(resolveThinkMaxValueChars("anthropic"), 12000);
  assert.equal(resolveThinkMaxValueChars("ollama"), 2000);
});

test("think: only declared keys are adopted from a FLAT response (garbage ignored)", () => {
  // A model that flattened output AND leaked prose words as keys.
  const parsed = {
    thought: "...", result: "ok", next: null,
    current_price: "39.99", changed: "true",
    // garbage the model leaked at the top level:
    your: "answer", the: "user's", sentence: "blah", you: "used",
  };
  const out = normalizeThinkOutputs(parsed, ["current_price", "changed", "result"]);
  assert.equal(out["current_price"], "39.99");
  assert.equal(out["changed"], true, "stringified boolean must become a real boolean");
  // garbage must NOT be adopted
  assert.equal("your" in out, false);
  assert.equal("the" in out, false);
  assert.equal("you" in out, false);
});

test("think: nested outputs object is captured fully (no whitelist needed)", () => {
  const parsed = { thought: "", result: "", next: null, outputs: { a: "1", b: true, c: "x" } };
  const out = normalizeThinkOutputs(parsed, []);
  assert.equal(out["a"], 1, "stringified integer coerced");
  assert.equal(out["b"], true);
  assert.equal(out["c"], "x");
});

test("think: non-integer numbers are coerced to strings (ledger-safe)", () => {
  const parsed = { outputs: { price: 49.99, count: 3, score: 0.6767 } };
  const out = normalizeThinkOutputs(parsed, []);
  assert.equal(out["price"], "49.99", "float -> string");
  assert.equal(out["count"], 3, "integer stays a number");
  assert.equal(out["score"], "0.6767");
});

test("think: 'false'/'true' strings coerce; arbitrary prose stays a string", () => {
  const parsed = { outputs: { changed: "false", grounded: "TRUE", note: "true story" } };
  const out = normalizeThinkOutputs(parsed, []);
  assert.equal(out["changed"], false);
  assert.equal(out["grounded"], true);
  assert.equal(out["note"], "true story", "non-exact match stays a string");
});

test("think: leading-zero identifiers are NOT coerced to numbers (zip/code/order id)", () => {
  const parsed = { outputs: { zip: "02134", code: "007", order_id: "0042", qty: "42" } };
  const out = normalizeThinkOutputs(parsed, []);
  assert.equal(out["zip"], "02134", "zip keeps leading zero + string type");
  assert.equal(out["code"], "007", "code keeps leading zeros");
  assert.equal(out["order_id"], "0042");
  assert.equal(out["qty"], 42, "a genuine quantity still coerces to a number");
});

test("think: empty model output is not considered a real result", () => {
  assert.equal(hasUsableThinkOutput("", {}), false);
  assert.equal(hasUsableThinkOutput("   ", { answer: "" }), false);
  assert.equal(hasUsableThinkOutput("customer-facing result", {}), true);
  assert.equal(hasUsableThinkOutput("", { exact_answer: 391 }), true);
});
