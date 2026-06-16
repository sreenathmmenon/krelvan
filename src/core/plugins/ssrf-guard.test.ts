/**
 * SSRF guard tests — literal-IP blocking, scheme blocking, and the IP-range checks
 * (incl. cloud metadata 169.254.169.254 and IPv4-mapped IPv6). DNS-resolution paths
 * are covered indirectly; here we assert the synchronous IP/scheme logic precisely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, SsrfError, _internal } from "./ssrf-guard.js";

test("blocks loopback + private + metadata literal IPv4", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
    await assert.rejects(assertPublicUrl(`http://${ip}/`), SsrfError, `${ip} should be blocked`);
  }
});

test("blocks loopback / ULA / link-local / mapped IPv6", () => {
  for (const ip of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert.equal(_internal.isBlockedIpv6(ip), true, `${ip} should be blocked`);
  }
});

test("allows a public literal IP", async () => {
  await assert.doesNotReject(assertPublicUrl("https://1.1.1.1/"));
  assert.equal(_internal.isBlockedIpv4("8.8.8.8"), false);
  assert.equal(_internal.isBlockedIpv4("1.1.1.1"), false);
});

test("blocks non-http schemes and localhost name", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), SsrfError);
  await assert.rejects(assertPublicUrl("ftp://example.com/"), SsrfError);
  await assert.rejects(assertPublicUrl("http://localhost/"), SsrfError);
  await assert.rejects(assertPublicUrl("http://api.localhost/"), SsrfError);
});

test("blocks malformed URL", async () => {
  await assert.rejects(assertPublicUrl("not a url"), SsrfError);
});

test("blocks a public hostname that resolves to a private IP (DNS rebind class)", async () => {
  // localtest.me and *.localtest.me resolve to 127.0.0.1 by design — a real
  // public name pointing at loopback. The guard must catch it via DNS resolution.
  await assert.rejects(assertPublicUrl("http://anything.localtest.me/"), SsrfError);
});
