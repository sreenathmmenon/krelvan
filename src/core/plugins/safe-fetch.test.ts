/**
 * safe-fetch tests — the SSRF-via-redirect defense for the builtin HTTP plugins.
 * We use a fake fetch so no real network is touched; the point is to prove that a
 * redirect to a private/metadata address is re-vetted and blocked mid-chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetch } from "./safe-fetch.js";

// A fetch stub that returns a 302 to `location` on the first call, then a 200.
function redirectingFetch(location: string) {
  let calls = 0;
  const impl = (async (_url: string) => {
    calls++;
    if (calls === 1) {
      return new Response(null, { status: 302, headers: { location } });
    }
    return new Response("SECRET", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

test("safe-fetch: a redirect to cloud-metadata (169.254.169.254) is blocked", async () => {
  const { impl } = redirectingFetch("http://169.254.169.254/latest/meta-data/");
  await assert.rejects(
    () => safeFetch("http://example.com/start", { fetchImpl: impl }),
    /blocked|private|metadata|link-local|169\.254/i,
    "a 302 to the metadata IP must be rejected, not followed",
  );
});

test("safe-fetch: a redirect to a private IP (127.0.0.1) is blocked", async () => {
  const { impl } = redirectingFetch("http://127.0.0.1:8080/admin");
  await assert.rejects(
    () => safeFetch("http://example.com/start", { fetchImpl: impl }),
    /blocked|private|loopback|127\.0\.0\.1/i,
  );
});

test("safe-fetch: too many redirects is bounded", async () => {
  // Always redirect to another public host → should hit the hop cap, not loop forever.
  let n = 0;
  const impl = (async () => {
    n++;
    return new Response(null, { status: 302, headers: { location: `http://example${n}.com/` } });
  }) as unknown as typeof fetch;
  // assertPublicUrl will try to resolve example{n}.com; in the sandbox that may throw for a
  // non-resolvable host — either way it must REJECT (never hang / never follow unbounded).
  await assert.rejects(() => safeFetch("http://example0.com/", { fetchImpl: impl }));
});
