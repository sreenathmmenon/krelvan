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
import { getLogger } from "../observability/logger.js";

const log = getLogger("slack-send");

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

    // Resolve webhook URL: per-call override takes precedence over env var.
    const webhookUrl =
      input["webhook_url"] != null
        ? String(input["webhook_url"])
        : (process.env["KRELVAN_SLACK_WEBHOOK_URL"] ?? "");

    if (!webhookUrl) {
      log.warn({ nodeId: call.nodeId }, "slack-send: KRELVAN_SLACK_WEBHOOK_URL not set");
      return {
        output: { sent: false, error: "KRELVAN_SLACK_WEBHOOK_URL not set" } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    const text = input["text"] != null ? String(input["text"]) : "";
    if (!text) {
      log.warn({ nodeId: call.nodeId }, "slack-send: missing required input 'text'");
      return {
        output: { sent: false, error: "missing required input: 'text'" } satisfies SlackSendOutput,
        claimedCostCents: 0,
      };
    }

    // Build the payload
    const payload: Record<string, unknown> = { text };

    const channel = input["channel"] != null ? String(input["channel"]) : "";
    if (channel) payload["channel"] = channel;

    const blocksRaw = input["blocks"] != null ? String(input["blocks"]) : "";
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
      { maxAttempts: 3, baseDelayMs: 500 },
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
