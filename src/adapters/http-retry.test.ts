/**
 * Tests for the shared HTTP retry utility. Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./http-retry.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function fakeResp(status: number, body = ""): Response {
  return new Response(body, { status });
}

/** Builds a fetchImpl that cycles through the given responses. */
function fakeFetch(...responses: Response[]): typeof fetch {
  let i = 0;
  return async () => {
    const r = responses[i];
    if (!r) throw new Error("fakeFetch: no more responses");
    i++;
    return r;
  };
}

/** A no-op sleep (no real delay in tests). */
const noSleep = () => Promise.resolve();

// ── tests ─────────────────────────────────────────────────────────────────────

test("retry: 200 on first attempt — ok, no retries", async () => {
  const outcome = await fetchWithRetry(
    "https://example.com",
    {},
    { sleepImpl: noSleep },
    fakeFetch(fakeResp(200)),
  );
  assert.ok(outcome.ok);
});

test("retry: 429 → retry → 200 succeeds", async () => {
  const outcome = await fetchWithRetry(
    "https://example.com",
    {},
    { sleepImpl: noSleep },
    fakeFetch(fakeResp(429, "rate limited"), fakeResp(200)),
  );
  assert.ok(outcome.ok);
});

test("retry: 500 → 500 → 500 returns failure after maxAttempts", async () => {
  const outcome = await fetchWithRetry(
    "https://example.com",
    {},
    { maxAttempts: 3, sleepImpl: noSleep },
    fakeFetch(fakeResp(500, "server error"), fakeResp(500, "server error"), fakeResp(500, "server error")),
  );
  assert.ok(!outcome.ok);
  assert.equal(outcome.status, 500);
  assert.equal(outcome.attempts, 3);
  assert.ok(outcome.rawBody.includes("server error"));
});

test("retry: 400 is NOT retried (client error)", async () => {
  let calls = 0;
  const f: typeof fetch = async () => { calls++; return fakeResp(400, "bad request"); };
  const outcome = await fetchWithRetry("https://example.com", {}, { sleepImpl: noSleep }, f);
  assert.ok(!outcome.ok);
  assert.equal(outcome.status, 400);
  assert.equal(calls, 1, "400 is not retried");
});

test("retry: network error is retried, final failure returns status=0", async () => {
  let calls = 0;
  const f: typeof fetch = async () => { calls++; throw new Error("ECONNREFUSED"); };
  const outcome = await fetchWithRetry(
    "https://example.com",
    {},
    { maxAttempts: 2, sleepImpl: noSleep },
    f,
  );
  assert.ok(!outcome.ok);
  assert.equal(outcome.status, 0);
  assert.equal(calls, 2);
  assert.ok(outcome.rawBody.includes("ECONNREFUSED"));
});

test("retry: network error → retry → 200 succeeds", async () => {
  let calls = 0;
  const f: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("ETIMEDOUT");
    return fakeResp(200);
  };
  const outcome = await fetchWithRetry("https://example.com", {}, { sleepImpl: noSleep }, f);
  assert.ok(outcome.ok);
  assert.equal(calls, 2);
});
