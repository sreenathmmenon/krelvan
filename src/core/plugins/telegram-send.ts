/**
 * "telegram_send" capability — send a message via Telegram Bot API.
 *
 * Requires:
 *   KRELVAN_TELEGRAM_TOKEN   — bot token (required)
 *   KRELVAN_TELEGRAM_CHAT_ID — default chat_id (used when call.input["chat_id"] absent)
 *
 * If the token is not configured, returns { sent: false, error: "..." }
 * without throwing (graceful degradation).
 *
 * Input keys:
 *   text       — message text (required)
 *   chat_id    — override KRELVAN_TELEGRAM_CHAT_ID (optional)
 *   parse_mode — "HTML" | "Markdown" (default: "HTML")
 *
 * Output: { sent, messageId?, chatId?, error? }
 *
 * Side effect: "message-human"
 * Cost estimate: 1 cent per call.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { fetchWithRetry } from "../../adapters/http-retry.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("telegram-send");

// ── secret resolver hook ────────────────────────────────────────────────────────
// By default the token/chat come from env vars. The runtime overrides this at boot
// (setTelegramSecretResolver) so a UI-saved secret in the encrypted SecretStore is
// used automatically — no env var, no restart. The resolver still falls back to env.
let secretResolver: (name: string) => string | undefined = (n) => process.env[n];

/** Runtime wiring point: route KRELVAN_TELEGRAM_* lookups through the SecretStore. */
export function setTelegramSecretResolver(fn: (name: string) => string | undefined): void {
  secretResolver = fn;
}

// ── types ─────────────────────────────────────────────────────────────────────

interface TelegramSendOutput {
  sent: boolean;
  messageId?: number;
  chatId?: string | number;
  error?: string;
}

// ── Telegram Bot API response shape ──────────────────────────────────────────

interface TelegramApiResult {
  ok: boolean;
  result?: {
    message_id: number;
    chat: { id: number | string };
  };
  description?: string;
}

// ── capability export ─────────────────────────────────────────────────────────

export const telegramSendCapability: CapabilityPlugin = {
  name: "telegram_send",
  sideEffect: "message-human",

  estimateCents: () => 1,

  async invoke(call: EffectCall) {
    const token = secretResolver("KRELVAN_TELEGRAM_TOKEN");
    if (!token) {
      log.warn({ nodeId: call.nodeId }, "telegram-send: KRELVAN_TELEGRAM_TOKEN not set");
      return {
        output: { sent: false, error: "KRELVAN_TELEGRAM_TOKEN not set" } satisfies TelegramSendOutput,
        claimedCostCents: 0,
      };
    }

    const input = call.input as Record<string, unknown>;

    const text = input["text"] != null ? String(input["text"]) : "";
    if (!text) {
      log.warn({ nodeId: call.nodeId }, "telegram-send: missing required input 'text'");
      return {
        output: { sent: false, error: "missing required input: 'text'" } satisfies TelegramSendOutput,
        claimedCostCents: 0,
      };
    }

    const chatIdInput = input["chat_id"];
    const defaultChatId = secretResolver("KRELVAN_TELEGRAM_CHAT_ID");
    const chatId: string | number | undefined =
      chatIdInput != null
        ? (typeof chatIdInput === "number" ? chatIdInput : String(chatIdInput))
        : (defaultChatId != null ? defaultChatId : undefined);

    if (chatId === undefined || chatId === "") {
      log.warn({ nodeId: call.nodeId }, "telegram-send: no chat_id provided (set KRELVAN_TELEGRAM_CHAT_ID or pass chat_id in input)");
      return {
        output: { sent: false, error: "no chat_id provided — set KRELVAN_TELEGRAM_CHAT_ID or pass chat_id in input" } satisfies TelegramSendOutput,
        claimedCostCents: 0,
      };
    }

    const rawParseMode = input["parse_mode"] != null ? String(input["parse_mode"]) : "HTML";
    const parseMode: "HTML" | "Markdown" = rawParseMode === "Markdown" ? "Markdown" : "HTML";

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    log.info({ nodeId: call.nodeId, chatId, parseMode }, "telegram-send: sending message");

    const outcome = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
      },
      { maxAttempts: 3, baseDelayMs: 500 },
    );

    if (!outcome.ok) {
      const errMsg = outcome.status === 0
        ? `network error: ${outcome.rawBody}`
        : `Telegram API ${outcome.status}: ${outcome.rawBody}`;
      log.error({ status: outcome.status }, `telegram-send: request failed — ${errMsg}`);
      return {
        output: { sent: false, error: errMsg } satisfies TelegramSendOutput,
        claimedCostCents: 0,
      };
    }

    const json = (await outcome.resp.json()) as TelegramApiResult;

    if (!json.ok) {
      const errMsg = json.description ?? "Telegram returned ok=false";
      log.error({ telegramError: errMsg }, "telegram-send: Telegram error in response");
      return {
        output: { sent: false, error: errMsg } satisfies TelegramSendOutput,
        claimedCostCents: 0,
      };
    }

    const messageId = json.result?.message_id;
    const respondedChatId = json.result?.chat.id ?? chatId;

    log.info({ nodeId: call.nodeId, messageId, chatId: respondedChatId }, "telegram-send: message sent");

    return {
      output: {
        sent: true,
        messageId,
        chatId: respondedChatId,
      } satisfies TelegramSendOutput,
      claimedCostCents: 1,
    };
  },
};
