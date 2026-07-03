/**
 * "http_post" capability — real HTTP POST to an external URL.
 *
 * Security: SSRF guard rejects private/loopback hostnames before any network call.
 *
 * Input:
 *   url          — required; must be a valid URL pointing to a public host.
 *   body         — string body to send (default "").
 *   content_type — default "application/json".
 *   headers      — optional JSON string of extra request headers; ignored if malformed.
 *   timeout_ms   — optional integer (default 10 000, capped at 30 000).
 *
 * Output:
 *   { ok, status, body, error? }
 *
 * Cost: 5 on success (2xx), 3 on non-2xx, 1 on network error, 0 on validation failure.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLogger } from "../observability/logger.js";
import { assertPublicUrl } from "./ssrf-guard.js";
import { safeFetch } from "./safe-fetch.js";

const log = getLogger("http-post");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 16_384;

// (SSRF protection moved to the shared ssrf-guard.ts — see assertPublicUrl.)

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

export const httpPostCapability: CapabilityPlugin = {
  name: "http_post",
  sideEffect: "write-reversible",

  estimateCents: () => 5,

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

    // ── SSRF guard (resolves DNS, checks the actual IPs) ──────────────────────
    try {
      await assertPublicUrl(parsed.toString());
    } catch (e) {
      log.warn({ nodeId: call.nodeId, hostname: parsed.hostname, err: (e as Error).message }, "http_post: SSRF guard blocked request");
      return {
        output: { ok: false, error: (e as Error).message },
        claimedCostCents: 0,
      };
    }

    const bodyRaw = input["body"];
    const bodyStr = typeof bodyRaw === "string" ? bodyRaw : "";

    const contentType =
      typeof input["content_type"] === "string" && input["content_type"].trim() !== ""
        ? input["content_type"].trim()
        : "application/json";

    const timeoutRaw = input["timeout_ms"];
    const timeoutMs = Math.min(
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.max(1, Math.floor(timeoutRaw))
        : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    const extraHeaders = parseOptionalHeaders(input["headers"]);

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    log.info(
      { nodeId: call.nodeId, url: rawUrl.trim(), contentType, timeoutMs, bodyLen: bodyStr.length },
      "http_post: sending POST",
    );

    let resp: Response;
    try {
      resp = await safeFetch(rawUrl.trim(), {
        method: "POST",
        headers: { "content-type": contentType, ...extraHeaders },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).message ?? String(e);
      log.warn({ nodeId: call.nodeId, url: rawUrl.trim(), err: msg }, "http_post: network error");
      return {
        output: { ok: false, status: 0, body: "", error: msg },
        claimedCostCents: 1,
      };
    } finally {
      clearTimeout(timer);
    }

    // ── Read response up to RESPONSE_MAX_BYTES ────────────────────────────────
    let responseBody: string;
    try {
      const text = await resp.text();
      responseBody = text.length > RESPONSE_MAX_BYTES ? text.slice(0, RESPONSE_MAX_BYTES) : text;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.warn({ nodeId: call.nodeId, err: msg }, "http_post: failed to read response body");
      responseBody = "";
    }

    const isSuccess = resp.status >= 200 && resp.status < 300;

    log.info(
      { nodeId: call.nodeId, status: resp.status, ok: isSuccess },
      "http_post: response received",
    );

    return {
      output: { ok: isSuccess, status: resp.status, body: responseBody },
      claimedCostCents: isSuccess ? 5 : 3,
    };
  },
};
