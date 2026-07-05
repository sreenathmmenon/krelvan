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
 *   { notified, status, via, error? }
 *
 * Delivery floor: this is a "notify the human" step. When no webhook `url` is configured,
 * it does NOT fail — the message is already captured in the run state and surfaces in the
 * Agent Inbox (the always-available delivery floor). A webhook `url` is an optional upgrade
 * that additionally POSTs the payload to an external endpoint. This guarantees an agent's
 * work is never lost just because the human hasn't wired an external webhook.
 *
 * Cost: 2 on webhook POST, 1 on webhook failure, 0 on the inbox-only path.
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

    // Delivery floor: no webhook url configured → the message still reaches the human via the
    // Agent Inbox (it is captured in run state). Succeed as an inbox notification rather than
    // failing the agent's final "notify the human" step.
    const rawUrl = input["url"];
    if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
      return {
        output: { notified: true, status: 0, via: "inbox" },
        claimedCostCents: 0,
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      // A malformed url is a misconfiguration, but the human is still reachable via the Inbox
      // floor — don't lose the agent's work over a bad optional webhook. Surface it, don't fail.
      return {
        output: { notified: true, status: 0, via: "inbox", note: "webhook url was invalid; delivered to inbox instead" },
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
