/**
 * "http_get" capability — real HTTP GET that fetches a URL and returns the response body.
 *
 * Security: SSRF guard rejects private/loopback hostnames before any network call.
 *
 * Input:
 *   url         — required; must be a valid URL pointing to a public host.
 *   headers     — optional JSON string of extra request headers; ignored if malformed.
 *   timeout_ms  — optional integer (default 10 000, capped at 30 000).
 *   max_bytes   — optional integer (default 32 768, capped at 131 072).
 *
 * Output:
 *   { ok, status, body, contentType, truncated?, error? }
 *
 * Cost: 3 cents on success, 1 cent on network error, 0 on validation failure.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("http-get");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32_768;
const MAX_MAX_BYTES = 131_072;

/** Patterns that indicate private / loopback addresses. */
const PRIVATE_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[:/,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_PATTERNS.some((re) => re.test(hostname));
}

function parseOptionalHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
      return result;
    }
  } catch {
    // malformed — ignore silently
  }
  return {};
}

export const httpGetCapability: CapabilityPlugin = {
  name: "http_get",
  sideEffect: "read",

  estimateCents: () => 3,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;

    // ── Input validation ──────────────────────────────────────────────────────

    const rawUrl = input["url"];
    if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
      return {
        output: { ok: false, error: "url is required" },
        claimedCostCents: 0,
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      return {
        output: { ok: false, error: "url is required" },
        claimedCostCents: 0,
      };
    }

    // ── SSRF guard ────────────────────────────────────────────────────────────
    if (isPrivateHost(parsed.hostname)) {
      log.warn({ nodeId: call.nodeId, hostname: parsed.hostname }, "http_get: SSRF guard blocked private address");
      return {
        output: { ok: false, error: "SSRF: private addresses are not allowed" },
        claimedCostCents: 0,
      };
    }

    const timeoutRaw = input["timeout_ms"];
    const timeoutMs = Math.min(
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.max(1, Math.floor(timeoutRaw))
        : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    const maxBytesRaw = input["max_bytes"];
    const maxBytes = Math.min(
      typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw)
        ? Math.max(1, Math.floor(maxBytesRaw))
        : DEFAULT_MAX_BYTES,
      MAX_MAX_BYTES,
    );

    const extraHeaders = parseOptionalHeaders(input["headers"]);

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    log.info({ nodeId: call.nodeId, url: rawUrl.trim(), timeoutMs, maxBytes }, "http_get: fetching URL");

    let resp: Response;
    try {
      resp = await fetch(rawUrl.trim(), {
        method: "GET",
        headers: { ...extraHeaders },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).message ?? String(e);
      log.warn({ nodeId: call.nodeId, url: rawUrl.trim(), err: msg }, "http_get: network error");
      return {
        output: { ok: false, status: 0, body: "", contentType: "", error: msg },
        claimedCostCents: 1,
      };
    } finally {
      clearTimeout(timer);
    }

    // ── Read body up to maxBytes ──────────────────────────────────────────────
    let body: string;
    let truncated = false;
    try {
      const text = await resp.text();
      if (text.length > maxBytes) {
        body = text.slice(0, maxBytes);
        truncated = true;
      } else {
        body = text;
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.warn({ nodeId: call.nodeId, url: rawUrl.trim(), err: msg }, "http_get: failed to read response body");
      return {
        output: { ok: false, status: resp.status, body: "", contentType: "", error: msg },
        claimedCostCents: 1,
      };
    }

    const contentType = resp.headers.get("content-type") ?? "";

    log.info(
      { nodeId: call.nodeId, status: resp.status, bodyLen: body.length, truncated },
      "http_get: response received",
    );

    const output: Record<string, unknown> = {
      ok: true,
      status: resp.status,
      body,
      contentType,
    };
    if (truncated) output["truncated"] = true;

    return { output, claimedCostCents: 3 };
  },
};
