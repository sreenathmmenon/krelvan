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
import { normalizeThinkOutputs } from "./think.js";

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
