import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTelegramInput } from "./telegram-send.js";

test("telegram resolves the explicitly prepared page instead of the incoming alert", () => {
  const resolved = resolveTelegramInput("page", {
    message: "raw monitoring payload",
    telegram_text_key: "prepare_page.result",
    "prepare_page.result": "SEV-HIGH: checkout failures in eu-west",
  });

  assert.equal(resolved.text, "SEV-HIGH: checkout failures in eu-west");
});

test("node-scoped telegram text wins over a mapped value", () => {
  const resolved = resolveTelegramInput("page", {
    "page.text": "operator-edited page",
    telegram_text_key: "prepare_page.result",
    "prepare_page.result": "original page",
    "page.chat_id": "ops-room",
  });

  assert.deepEqual(resolved, { text: "operator-edited page", chatId: "ops-room" });
});

test("telegram mapping wins over an unrelated generic text value", () => {
  const resolved = resolveTelegramInput("page", {
    text: "unrelated earlier output",
    telegram_text_key: "prepare_page.result",
    "prepare_page.result": "approved incident page",
  });

  assert.equal(resolved.text, "approved incident page");
});
