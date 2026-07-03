/**
 * "notify_webhook" capability — POST a JSON payload to a webhook URL.
 *
 * Security: SSRF guard rejects private/loopback hostnames.
 *
 * Input:
 *   url     — required; must be a valid URL pointing to a public host.
 *   payload — JSON string or object to send (default {}). Objects are JSON.stringify'd.
 *   event   — optional string; added as X-Krelvan-Event header.
 *   secret  — optional string; if present, body is HMAC-SHA256 signed and sent as
 *             X-Krelvan-Signature header.
 *
 * Output:
 *   { notified, status, error? }
 *
 * Cost: 2 on success, 1 on failure, 0 on validation failure.
 */

import { createHmac } from "node:crypto";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { assertPublicUrl } from "./ssrf-guard.js";
import { safeFetch } from "./safe-fetch.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("notify-webhook");

const TIMEOUT_MS = 10_000;

// (SSRF protection moved to the shared ssrf-guard.ts — see assertPublicUrl.)

function buildBody(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return "{}";
  try {
    return JSON.stringify(payload);
  } catch {
    return "{}";
  }
}

export const notifyWebhookCapability: CapabilityPlugin = {
  name: "notify_webhook",
  sideEffect: "write-reversible",

  estimateCents: () => 2,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;

    // ── Input validation ──────────────────────────────────────────────────────

    const rawUrl = input["url"];
    if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
      return {
        output: { notified: false, status: 0, error: "url is required" },
        claimedCostCents: 0,
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      return {
        output: { notified: false, status: 0, error: "url is required" },
        claimedCostCents: 0,
      };
    }

    // ── SSRF guard (resolves DNS, checks the actual IPs) ──────────────────────
    try {
      await assertPublicUrl(parsed.toString());
    } catch (e) {
      log.warn({ nodeId: call.nodeId, hostname: parsed.hostname, err: (e as Error).message }, "notify_webhook: SSRF guard blocked request");
      return {
        output: { notified: false, status: 0, error: (e as Error).message },
        claimedCostCents: 0,
      };
    }

    // ── Build request body ────────────────────────────────────────────────────
    const body = buildBody(input["payload"] ?? {});

    // ── Build headers ─────────────────────────────────────────────────────────
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    const event = input["event"];
    if (typeof event === "string" && event.trim() !== "") {
      headers["x-krelvan-event"] = event.trim();
    }

    const secret = input["secret"];
    if (typeof secret === "string" && secret !== "") {
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      headers["x-krelvan-signature"] = sig;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    log.info(
      { nodeId: call.nodeId, url: rawUrl.trim(), bodyLen: body.length, hasEvent: !!event, hasSig: !!secret },
      "notify_webhook: posting webhook",
    );

    let resp: Response;
    try {
      resp = await safeFetch(rawUrl.trim(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).message ?? String(e);
      log.warn({ nodeId: call.nodeId, url: rawUrl.trim(), err: msg }, "notify_webhook: network error");
      return {
        output: { notified: false, status: 0, error: msg },
        claimedCostCents: 1,
      };
    } finally {
      clearTimeout(timer);
    }

    const notified = resp.status >= 200 && resp.status < 300;

    log.info(
      { nodeId: call.nodeId, status: resp.status, notified },
      "notify_webhook: webhook delivered",
    );

    return {
      output: { notified, status: resp.status },
      claimedCostCents: notified ? 2 : 1,
    };
  },
};
