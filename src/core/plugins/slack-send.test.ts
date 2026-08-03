import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSlackInput } from "./slack-send.js";

test("Slack escalation binds the pre-investigated case brief", () => {
  const resolved = resolveSlackInput("notify_human", {
    message: "raw customer input",
    slack_text_key: "escalate.brief",
    "escalate.brief": "Customer escalation case file",
  });

  assert.equal(resolved.text, "Customer escalation case file");
});
