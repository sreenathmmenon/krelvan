/**
 * EgressBroker — the parent-side gate for ALL outbound HTTP a sandboxed plugin makes.
 *
 * A plugin in the subprocess sandbox (Node --permission, no net flag) CAN open raw
 * sockets, but it is given (a) no secrets and (b) no direct fetch — its only path to
 * the network is to ASK the parent over IPC. This broker is what the parent runs to
 * answer that ask. Every brokered request is:
 *
 *   1. ALLOWLIST-checked  — deny-by-default against the plugin's declared egress hosts.
 *                           A plugin can only reach hosts it declared at install time.
 *   2. SSRF-guarded       — assertPublicUrl() rejects loopback / metadata / private
 *                           ranges, so the broker can't be used to pivot internally.
 *   3. SECRET-injected on the PARENT — if the destination has a registered credential,
 *                           the broker attaches it to the OUTBOUND request here. The
 *                           secret value never crosses back into the child.
 *   4. MEASURED           — bytes in/out + wall time are recorded, so a networked
 *                           plugin's cost is supervisor-attested, not self-reported.
 *
 * The credential-stays-in-the-broker pattern mirrors SecretBroker.mint (identity.ts):
 * the plugin proves intent (a destination it's allowed to reach); the broker holds the
 * real secret and applies it at the egress boundary.
 *
 * Node built-ins only (global fetch, node:url via the SSRF guard).
 */

import { assertPublicUrl, SsrfError } from "./ssrf-guard.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("egress-broker");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 131_072; // 128 KiB
const MAX_MAX_BYTES = 1_048_576; // 1 MiB hard ceiling on a brokered response

/** A request the child plugin asks the parent to perform on its behalf. */
export interface EgressRequest {
  url: string;
  method?: string;
  /** Header NAMES only the plugin may set; the broker strips Authorization-class headers
   *  the plugin tries to set itself (those are the broker's job to inject). */
  headers?: Record<string, string>;
  /** Request body, already serialized to a string by the plugin. */
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The result the broker returns to the child — never includes the injected secret. */
export interface EgressResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  truncated?: boolean;
  error?: string;
  /** Measured cost of this single brokered call (supervisor-attested). */
  measured: { bytesIn: number; bytesOut: number; ms: number };
}

/** How the broker injects a credential for a destination host. */
export type SecretInjector = (host: string) => { header: string; value: string } | null;

/**
 * Header names a plugin is NOT allowed to set itself — the broker owns auth, and a
 * plugin must not be able to smuggle a header that overrides or forges the injected
 * credential, nor set hop-by-hop headers.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

export interface EgressBrokerDeps {
  /** Hosts this plugin may reach. Empty set ⇒ the plugin has no egress at all. */
  allowlist: ReadonlySet<string>;
  /** Returns the credential to inject for a destination host, or null for none. */
  injectSecret: SecretInjector;
  /** Wall clock for measurement (injectable for tests). */
  now: () => number;
  /** The fetch used for the (already allowlisted + SSRF-guarded) outbound call. Defaults
   *  to global fetch; overridable for tests and a future hosted egress-proxy adapter. */
  fetchImpl?: typeof fetch;
}

export class EgressDenied extends Error {
  constructor(message: string) { super(message); this.name = "EgressDenied"; }
}

export class EgressBroker {
  constructor(private readonly deps: EgressBrokerDeps) {}

  /**
   * Perform a brokered outbound request. Throws EgressDenied on an allowlist/SSRF
   * rejection (the caller surfaces that to the plugin as a denied result); other
   * failures (network/timeout) are returned as `ok: false` results so a plugin can
   * handle them like any fetch error.
   */
  async request(req: EgressRequest): Promise<EgressResult> {
    const started = this.deps.now();
    const measured0 = { bytesIn: 0, bytesOut: 0, ms: 0 };

    // ── parse + scheme ─────────────────────────────────────────────────────────
    let u: URL;
    try { u = new URL(req.url); } catch { throw new EgressDenied("egress: invalid URL"); }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

    // ── 1. allowlist (deny-by-default) ─────────────────────────────────────────
    if (!this.deps.allowlist.has(host)) {
      log.warn({ host, allowlist: [...this.deps.allowlist] }, "egress: host not on plugin allowlist");
      throw new EgressDenied(`egress: host '${host}' is not on this plugin's allowlist`);
    }

    // ── 2. SSRF guard (resolves DNS, blocks loopback/metadata/private) ─────────
    try {
      await assertPublicUrl(u.toString());
    } catch (e) {
      const msg = e instanceof SsrfError ? e.message : String(e);
      log.warn({ host, err: msg }, "egress: SSRF guard blocked brokered request");
      throw new EgressDenied(`egress: ${msg}`);
    }

    // ── build outbound headers: plugin headers MINUS forbidden, PLUS injection ──
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (typeof v !== "string") continue;
      if (FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) continue; // plugin may not set auth/host/etc
      headers[k] = v;
    }
    // 3. secret injection — on the PARENT; the value never returns to the child.
    const injected = this.deps.injectSecret(host);
    if (injected) headers[injected.header] = injected.value;

    const method = (req.method ?? "GET").toUpperCase();
    const timeoutMs = Math.min(
      typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs) ? Math.max(1, Math.floor(req.timeoutMs)) : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const maxBytes = Math.min(
      typeof req.maxBytes === "number" && Number.isFinite(req.maxBytes) ? Math.max(1, Math.floor(req.maxBytes)) : DEFAULT_MAX_BYTES,
      MAX_MAX_BYTES,
    );

    const bodyOut = typeof req.body === "string" ? req.body : undefined;
    measured0.bytesOut = bodyOut ? Buffer.byteLength(bodyOut) : 0;

    // ── 4. fetch (measured) ────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch = this.deps.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await doFetch(u.toString(), {
        method,
        headers,
        ...(bodyOut !== undefined && method !== "GET" && method !== "HEAD" ? { body: bodyOut } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).message ?? String(e);
      measured0.ms = this.deps.now() - started;
      log.warn({ host, err: msg }, "egress: brokered fetch failed");
      return { ok: false, status: 0, body: "", contentType: "", error: msg, measured: measured0 };
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    let truncated = false;
    try {
      const full = await resp.text();
      measured0.bytesIn = Buffer.byteLength(full);
      if (full.length > maxBytes) { text = full.slice(0, maxBytes); truncated = true; }
      else text = full;
    } catch (e) {
      measured0.ms = this.deps.now() - started;
      return { ok: false, status: resp.status, body: "", contentType: "", error: (e as Error).message, measured: measured0 };
    }

    measured0.ms = this.deps.now() - started;
    const out: EgressResult = {
      ok: resp.ok,
      status: resp.status,
      body: text,
      contentType: resp.headers.get("content-type") ?? "",
      measured: measured0,
    };
    if (truncated) out.truncated = true;
    log.info({ host, status: resp.status, bytesIn: measured0.bytesIn, bytesOut: measured0.bytesOut, ms: measured0.ms }, "egress: brokered request completed");
    return out;
  }
}
