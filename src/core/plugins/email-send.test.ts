import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEmailInput } from "./email-send.js";

test("email binding sends the drafted reply rather than the inbound customer body", () => {
  const resolved = resolveEmailInput("send_reply", {
    from_address: "customer@example.com",
    subject: "Refund question",
    body: "Original customer message",
    "answer.reply": "Grounded support response",
    email_to_key: "from_address",
    email_subject_key: "subject",
    email_body_keys: "answer.reply,clarify.reply",
  });

  assert.equal(resolved.to, "customer@example.com");
  assert.equal(resolved.subject, "Refund question");
  assert.equal(resolved.body, "Grounded support response");
});

test("email binding selects the first populated branch output", () => {
  const resolved = resolveEmailInput("send_reply", {
    email_body_keys: "answer.reply,clarify.reply",
    "clarify.reply": "Which order are you asking about?",
  });

  assert.equal(resolved.body, "Which order are you asking about?");
});
