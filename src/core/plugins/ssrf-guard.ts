/**
 * SSRF guard — shared by every outbound HTTP capability (http_get, http_post,
 * notify_webhook, and the YAML/HTTP capability path).
 *
 * The naive guard (regex on the hostname string) is bypassable: a public name that
 * RESOLVES to 127.0.0.1 / 169.254.169.254 / an internal VPC IP passes the string
 * check. This guard RESOLVES the host with DNS and rejects if ANY resolved address is
 * private, loopback, link-local (incl. the cloud-metadata 169.254.169.254), unique-
 * local IPv6, or IPv4-mapped IPv6 of a blocked range. Literal IPs are checked directly.
 *
 * Use `assertPublicUrl(url)` before fetching; it throws an SsrfError on a blocked host.
 * Node built-ins only (node:dns, node:net).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) { super(message); this.name = "SsrfError"; }
}

/** Is an IPv4 string in a blocked (private/loopback/link-local/reserved) range? */
function isBlockedIpv4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = o as [number, number, number, number];
  if (a === 127) return true;                          // loopback 127.0.0.0/8
  if (a === 10) return true;                           // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // private 172.16/12
  if (a === 192 && b === 168) return true;             // private 192.168/16
  if (a === 169 && b === 254) return true;             // link-local + cloud metadata 169.254/16
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  if (a >= 224) return true;                           // multicast/reserved 224+/4
  return false;
}

/** Is an IPv6 string blocked? (loopback, ULA, link-local, IPv4-mapped of a blocked v4) */
function isBlockedIpv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::1" || s === "::") return true;                  // loopback / unspecified
  if (s.startsWith("fc") || s.startsWith("fd")) return true;   // unique-local fc00::/7
  if (s.startsWith("fe80")) return true;                       // link-local fe80::/10
  if (s.startsWith("ff")) return true;                         // multicast ff00::/8
  // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check as v4
  const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP → block
}

/**
 * Throw SsrfError unless the URL is http(s) to a publicly-routable host.
 * Resolves DNS and checks every returned address.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new SsrfError("invalid URL"); }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfError(`blocked scheme: ${u.protocol}`);
  }

  // Test-only escape hatch: tests mock globalThis.fetch and use non-resolvable hosts
  // (api.example.com). Skipping the DNS step there keeps the scheme/literal-IP checks
  // active while not requiring real DNS. NEVER set this in production.
  if (process.env["KRELVAN_SSRF_ALLOW_UNRESOLVABLE"] === "1") {
    const host0 = u.hostname.replace(/^\[|\]$/g, "");
    if (host0 === "localhost" || host0.endsWith(".localhost")) throw new SsrfError("SSRF: localhost is not allowed");
    if (isIP(host0) !== 0 && isBlockedIp(host0)) throw new SsrfError(`SSRF: blocked address ${host0}`);
    return;
  }

  const host = u.hostname.replace(/^\[|\]$/g, "");

  // Block obvious string forms early (e.g. "localhost").
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfError("SSRF: localhost is not allowed");
  }

  // Literal IP → check directly, no DNS.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new SsrfError(`SSRF: blocked address ${host}`);
    return;
  }

  // Hostname → resolve ALL addresses and reject if any is blocked.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`SSRF: cannot resolve host ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`SSRF: host ${host} resolved to no address`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfError(`SSRF: ${host} resolves to a blocked address (${a.address})`);
    }
  }
}

/** Exposed for unit tests. */
export const _internal = { isBlockedIpv4, isBlockedIpv6, isBlockedIp };
