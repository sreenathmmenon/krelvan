/**
 * "slack_send" capability — send a message via Slack Incoming Webhooks.
 *
 * Requires:
 *   KRELVAN_SLACK_WEBHOOK_URL — incoming webhook URL (can be overridden per call)
 *
 * If no webhook URL is available (not in env, not in input), returns
 * { sent: false, error: "..." } without throwing (graceful degradation).
 *
 * Input keys:
 *   text        — message text (required)
 *   channel     — override channel (optional; only works with bot-token webhooks)
 *   blocks      — optional JSON string for Block Kit blocks array
 *   webhook_url — per-call override of KRELVAN_SLACK_WEBHOOK_URL (optional)
 *
 * Output: { sent, error? }
 *
 * Side effect: "message-human"
 * Cost estimate: 1 cent per call.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { fetchWithRetry } from "../../adapters/http-retry.js";
import { assertPublicUrl } from "./ssrf-guard.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("slack-send");

export interface ResolvedSlackInput {
  webhookUrl: string;
  text: string;
  channel?: string;
  blocks?: string;
}

/** Resolve explicit state bindings for a Slack action. An escalation may bind
 * `slack_text_key=escalate.brief`; this must win over unrelated generic results. */
export function resolveSlackInput(nodeId: string, input: Record<string, unknown>): ResolvedSlackInput {
  const mapped = (mappingKey: string): string | undefined => {
    const key = typeof input[mappingKey] === "string" ? input[mappingKey].trim() : "";
    const value = key ? input[key] : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const str = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    webhookUrl: str(`${nodeId}.webhook_url`) ?? mapped("slack_webhook_url_key") ?? str("slack_webhook_url") ?? str("webhook_url") ?? process.env["KRELVAN_SLACK_WEBHOOK_URL"] ?? "",
    text: str(`${nodeId}.text`) ?? mapped("slack_text_key") ?? str("slack_text") ?? str("text") ?? "",
    ...(str(`${nodeId}.channel`) ?? str("channel") ? { channel: str(`${nodeId}.channel`) ?? str("channel")! } : {}),
    ...(str(`${nodeId}.blocks`) ?? str("blocks") ? { blocks: str(`${nodeId}.blocks`) ?? str("blocks")! } : {}),
  };
}

// ── types ─────────────────────────────────────────────────────────────────────

interface SlackSendOutput {
  sent: boolean;
  error?: string;
}

// ── capability export ─────────────────────────────────────────────────────────

export const slackSendCapability: CapabilityPlugin = {
  name: "slack_send",
  sideEffect: "message-human",

  estimateCents: () => 1,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const resolved = resolveSlackInput(call.nodeId, input);

    // Resolve webhook URL: per-call override takes precedence over env var.
    const webhookUrl = resolved.webhookUrl;

    if (!webhookUrl) {
      log.warn({ nodeId: call.nodeId }, "slack-send: KRELVAN_SLACK_WEBHOOK_URL not set");
      return {
        output: { sent: false, error: "KRELVAN_SLACK_WEBHOOK_URL not set" } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    const text = resolved.text;
    if (!text) {
      log.warn({ nodeId: call.nodeId }, "slack-send: missing required input 'text'");
      return {
        output: { sent: false, error: "missing required input: 'text'" } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    // Build the payload
    const payload: Record<string, unknown> = { text };

    const channel = resolved.channel ?? "";
    if (channel) payload["channel"] = channel;

    const blocksRaw = resolved.blocks ?? "";
    if (blocksRaw) {
      try {
        const parsed: unknown = JSON.parse(blocksRaw);
        if (Array.isArray(parsed)) {
          payload["blocks"] = parsed;
        } else {
          log.warn({ nodeId: call.nodeId }, "slack-send: 'blocks' input is not a JSON array — ignoring");
        }
      } catch {
        log.warn({ nodeId: call.nodeId }, "slack-send: 'blocks' input is not valid JSON — ignoring");
      }
    }

    // SSRF guard: the webhook URL can be caller-supplied (per-call override), so it must be
    // vetted against private/loopback/metadata ranges — same protection every sibling outbound
    // plugin (notify_webhook, http_get/post) applies — before we ever fetch it.
    try {
      await assertPublicUrl(webhookUrl.trim());
    } catch (e) {
      log.warn({ nodeId: call.nodeId, err: (e as Error).message }, "slack-send: webhook URL rejected by SSRF guard");
      return {
        output: { sent: false, error: "webhook URL is not allowed (must be a public host)" } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    log.info({ nodeId: call.nodeId, channel: channel || "(default)" }, "slack-send: posting message");

    const outcome = await fetchWithRetry(
      webhookUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      { maxAttempts: 3, baseDelayMs: 500, timeoutMs: 15000 },
    );

    if (!outcome.ok) {
      const errMsg = outcome.status === 0
        ? `network error: ${outcome.rawBody}`
        : `Slack webhook ${outcome.status}: ${outcome.rawBody}`;
      log.error({ status: outcome.status }, `slack-send: request failed — ${errMsg}`);
      return {
        output: { sent: false, error: errMsg } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    // Slack webhooks return "ok" as plain text on success.
    const body = await outcome.resp.text();
    if (body.trim() !== "ok") {
      log.error({ body }, "slack-send: unexpected response body from Slack webhook");
      return {
        output: { sent: false, error: `unexpected Slack response: ${body.slice(0, 200)}` } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    log.info({ nodeId: call.nodeId }, "slack-send: message sent");

    return {
      output: { sent: true } satisfies SlackSendOutput,
      claimedCostCents: 1,
    };
  },
};
