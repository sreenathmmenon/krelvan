/**
 * EgressBroker unit tests — the parent-side gate every sandboxed plugin's outbound HTTP
 * passes through. Proves: allowlist deny-by-default, SSRF block (even for an allowlisted
 * host that resolves to a blocked IP), parent-side secret injection (the credential
 * reaches the DESTINATION request, never the caller), plugin-set auth headers are
 * stripped, response is size-capped, and cost is measured.
 *
 * The outbound `fetch` is injected (a captured stub), so these tests assert exactly what
 * the broker would put on the wire without making a real network call. The SSRF test
 * bypass (`KRELVAN_SSRF_ALLOW_UNRESOLVABLE=1`) keeps scheme + literal-IP checks active
 * while skipping DNS for the fake public host, mirroring the other capability tests.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EgressBroker, EgressDenied } from "./egress-broker.js";

before(() => { process.env["KRELVAN_SSRF_ALLOW_UNRESOLVABLE"] = "1"; });
after(() => { delete process.env["KRELVAN_SSRF_ALLOW_UNRESOLVABLE"]; });

/** A fetch stub that records the request and returns a canned response. */
function captureFetch(resBody = `{"ok":true}`, contentType = "application/json") {
  const seen: { url: string; headers: Record<string, string>; method: string; body: string | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = v;
    seen.push({ url: String(url), headers: h, method: (init?.method ?? "GET").toString(), body: init?.body as string | undefined });
    return new Response(resBody, { status: 200, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function broker(allow: string[], fetchImpl: typeof fetch, secret?: { host: string; value: string }) {
  return new EgressBroker({
    allowlist: new Set(allow.map((h) => h.toLowerCase())),
    injectSecret: (host) => (secret && host === secret.host ? { header: "authorization", value: `Bearer ${secret.value}` } : null),
    now: () => 1_000,
    fetchImpl,
  });
}

test("DENIED: a host not on the allowlist is rejected (deny-by-default)", async () => {
  const { impl, seen } = captureFetch();
  const b = broker([], impl); // empty allowlist ⇒ nothing reachable
  await assert.rejects(b.request({ url: "https://api.example.com/x" }), (e) => e instanceof EgressDenied && /allowlist/.test(e.message));
  assert.equal(seen.length, 0, "no outbound call may happen for a denied host");
});

test("DENIED: an allowlisted host that is a loopback IP is still SSRF-blocked", async () => {
  const { impl, seen } = captureFetch();
  const b = broker(["127.0.0.1"], impl); // allowlisted, but SSRF must still block loopback
  await assert.rejects(b.request({ url: "http://127.0.0.1:9/" }), (e) => e instanceof EgressDenied);
  assert.equal(seen.length, 0, "SSRF block must prevent the outbound call");
});

test("DENIED: cloud-metadata IP is blocked even if allowlisted", async () => {
  const { impl } = captureFetch();
  const b = broker(["169.254.169.254"], impl);
  await assert.rejects(b.request({ url: "http://169.254.169.254/latest/meta-data/" }), (e) => e instanceof EgressDenied);
});

test("DENIED: non-http scheme is rejected", async () => {
  const { impl } = captureFetch();
  const b = broker(["api.example.com"], impl);
  await assert.rejects(b.request({ url: "file:///etc/passwd" }), (e) => e instanceof EgressDenied);
});

test("INJECTED on the parent: the destination gets the credential; it is the broker's, not the plugin's", async () => {
  const { impl, seen } = captureFetch();
  const b = broker(["api.example.com"], impl, { host: "api.example.com", value: "super-secret-key" });
  const res = await b.request({ url: "https://api.example.com/charge", method: "POST", body: "{}" });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.headers["authorization"], "Bearer super-secret-key", "broker must inject the credential on the outbound request");
});

test("STRIPPED: a plugin cannot set its own Authorization/Host/Cookie headers", async () => {
  const { impl, seen } = captureFetch();
  const b = broker(["api.example.com"], impl, { host: "api.example.com", value: "real-key" });
  await b.request({
    url: "https://api.example.com/x",
    headers: { Authorization: "Bearer FORGED", Host: "evil.example", Cookie: "a=b", "X-Allowed": "ok" },
  });
  const h = seen[0]!.headers;
  assert.equal(h["authorization"], "Bearer real-key", "plugin's forged Authorization must be overridden by the broker's injected one");
  assert.equal(h["host"], undefined, "plugin may not set Host");
  assert.equal(h["cookie"], undefined, "plugin may not set Cookie");
  assert.equal(h["x-allowed"], "ok", "a non-forbidden header passes through");
});

test("MEASURED + CAPPED: response is size-capped and bytes/time are measured", async () => {
  const { impl } = captureFetch("Y".repeat(500_000));
  const b = broker(["api.example.com"], impl);
  const res = await b.request({ url: "https://api.example.com/big", maxBytes: 1024 });
  assert.equal(res.body.length, 1024, "body must be truncated to maxBytes");
  assert.equal(res.truncated, true);
  assert.equal(res.measured.bytesIn, 500_000, "measured bytesIn reflects the full response, not the truncated slice");
  assert.equal(typeof res.measured.ms, "number");
});

/** A fetch stub that emits a redirect (302 → Location) on the first call, then a 200. */
function redirectFetch(location: string) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = v;
    seen.push({ url: String(url), headers: h });
    if (n++ === 0) return new Response("", { status: 302, headers: { location } });
    return new Response(`{"ok":true}`, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("REDIRECT BYPASS BLOCKED: a 302 to a metadata IP is rejected, not followed", async () => {
  // The classic SSRF-via-redirect: allowlisted host 302s to the cloud-metadata IP.
  const { impl, seen } = redirectFetch("http://169.254.169.254/latest/meta-data/");
  const b = broker(["api.example.com"], impl, { host: "api.example.com", value: "real-key" });
  await assert.rejects(
    b.request({ url: "https://api.example.com/start" }),
    (e) => e instanceof EgressDenied && /redirect/.test(e.message),
    "a redirect to a private/metadata IP must be blocked",
  );
  assert.equal(seen.length, 1, "the broker must NOT have followed the redirect");
});

test("REDIRECT BYPASS BLOCKED: a 302 to an off-allowlist host is rejected", async () => {
  const { impl, seen } = redirectFetch("https://attacker.example/steal");
  const b = broker(["api.example.com"], impl, { host: "api.example.com", value: "real-key" });
  await assert.rejects(
    b.request({ url: "https://api.example.com/start" }),
    (e) => e instanceof EgressDenied && /off-allowlist|allowlist/.test(e.message),
    "a redirect to an off-allowlist host must be blocked",
  );
  assert.equal(seen.length, 1, "the broker must NOT have followed the off-allowlist redirect");
});

test("CROSS-HOST REDIRECT: the injected credential is DROPPED on a hop to a different allowlisted host", async () => {
  // Both hosts allowlisted, but the secret is minted for host A only. On the cross-host
  // hop the broker must NOT forward host A's Authorization to host B.
  const { impl, seen } = redirectFetch("https://b.example.com/next");
  const b = broker(["a.example.com", "b.example.com"], impl, { host: "a.example.com", value: "secret-for-A" });
  const res = await b.request({ url: "https://a.example.com/start" });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 2, "the broker should have followed the in-allowlist redirect");
  assert.equal(seen[0]!.headers["authorization"], "Bearer secret-for-A", "hop 1 carries host A's credential");
  assert.equal(seen[1]!.headers["authorization"], undefined, "hop 2 (different host) must NOT carry host A's credential");
});
