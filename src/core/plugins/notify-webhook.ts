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
 *   { notified, status, via, destination?, error? }
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

// Webhook URLs commonly contain an unguessable path or query token. Resolve those endpoints
// through the encrypted SecretStore at execution time instead of carrying plaintext URLs in a
// manifest, run state, approval event, or ledger payload. Env fallback keeps headless installs
// compatible with the same named-secret convention.
let secretResolver: (name: string) => string | undefined = (name) => process.env[name];

export function setWebhookSecretResolver(fn: (name: string) => string | undefined): void {
  secretResolver = fn;
}

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

export interface ResolvedWebhookInput {
  url: string;
  payload: unknown;
  event?: string;
  secret?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve an explicit state-to-webhook binding. The engine passes the complete run state to a
 * capability, so selecting the first value named `body` is unsafe: it might be fetched HTML from
 * an earlier research step rather than the intended deliverable. Templates may therefore set:
 *
 *   webhook_url_key      = state key containing the destination URL
 *   webhook_payload_keys = comma-separated state keys to include in the JSON payload
 *
 * Direct node-scoped `url` / `payload` values still win. The resolver is pure and is shared by
 * execution and the human approval preview, ensuring the customer approves the exact request.
 */
export function resolveWebhookInput(nodeId: string, input: Record<string, unknown>): ResolvedWebhookInput {
  const mappedUrlKey = nonEmptyString(input["webhook_url_key"]);
  const mappedUrl = mappedUrlKey ? nonEmptyString(input[mappedUrlKey]) : undefined;
  const urlSecretRef = nonEmptyString(input[`${nodeId}.url_ref`])
    ?? nonEmptyString(input["webhook_url_ref"]);
  const secretUrl = urlSecretRef ? nonEmptyString(secretResolver(urlSecretRef)) : undefined;
  const url = nonEmptyString(input[`${nodeId}.url`])
    ?? nonEmptyString(input[`${nodeId}.webhook_url`])
    ?? mappedUrl
    ?? secretUrl
    ?? nonEmptyString(input["url"])
    ?? nonEmptyString(input["webhook_url"])
    ?? nonEmptyString(input["publish_webhook"])
    ?? nonEmptyString(input["status_channel"])
    ?? "";

  const nodePayload = input[`${nodeId}.payload`];
  const genericPayload = input["payload"];
  const payloadKeys = nonEmptyString(input["webhook_payload_keys"])
    ?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
  const mappedPayload: Record<string, unknown> = {};
  for (const key of payloadKeys) {
    if (input[key] !== undefined) mappedPayload[key] = input[key];
  }
  const payload = nodePayload !== undefined
    ? nodePayload
    : Object.keys(mappedPayload).length > 0 ? mappedPayload
      : genericPayload !== undefined ? genericPayload : {};

  const signingSecretRef = nonEmptyString(input[`${nodeId}.secret_ref`])
    ?? nonEmptyString(input["webhook_signing_secret_ref"]);
  const resolvedSigningSecret = signingSecretRef
    ? nonEmptyString(secretResolver(signingSecretRef))
    : undefined;

  return {
    url,
    payload,
    ...(nonEmptyString(input[`${nodeId}.event`] ?? input["webhook_event"] ?? input["event"]) ? { event: nonEmptyString(input[`${nodeId}.event`] ?? input["webhook_event"] ?? input["event"])! } : {}),
    ...(resolvedSigningSecret ?? nonEmptyString(input[`${nodeId}.secret`] ?? input["webhook_secret"] ?? input["secret"])
      ? { secret: resolvedSigningSecret ?? nonEmptyString(input[`${nodeId}.secret`] ?? input["webhook_secret"] ?? input["secret"])! }
      : {}),
  };
}

export const notifyWebhookCapability: CapabilityPlugin = {
  name: "notify_webhook",
  sideEffect: "write-reversible",

  estimateCents: () => 2,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;
    const resolved = resolveWebhookInput(call.nodeId, input);

    // ── Input validation ──────────────────────────────────────────────────────

    // Delivery floor: no webhook url configured → the message still reaches the human via the
    // Agent Inbox (it is captured in run state). Succeed as an inbox notification rather than
    // failing the agent's final "notify the human" step.
    const rawUrl = resolved.url;
    if (!rawUrl) {
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
        output: { notified: false, status: 0, via: "blocked", error: (e as Error).message },
        claimedCostCents: 0,
      };
    }

    // ── Build request body ────────────────────────────────────────────────────
    const body = buildBody(resolved.payload);

    // ── Build headers ─────────────────────────────────────────────────────────
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    const event = resolved.event;
    if (event) {
      headers["x-krelvan-event"] = event;
    }

    const secret = resolved.secret;
    if (secret) {
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      headers["x-krelvan-signature"] = sig;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    log.info(
      { nodeId: call.nodeId, destination: parsed.origin, bodyLen: body.length, hasEvent: !!event, hasSig: !!secret },
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
      log.warn({ nodeId: call.nodeId, destination: parsed.origin, err: msg }, "notify_webhook: network error");
      return {
        output: { notified: false, status: 0, via: "webhook", destination: parsed.origin, error: msg },
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
      // Report only the origin, never the path/query: webhook URLs commonly embed credentials.
      // This is enough for later agent steps to make an evidence-backed delivery claim without
      // leaking the secret-bearing endpoint into an Inbox artifact or model prompt.
      output: { notified, status: resp.status, via: "webhook", destination: parsed.origin },
      claimedCostCents: notified ? 2 : 1,
    };
  },
};
