import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWebhookInput, setWebhookSecretResolver } from "./notify-webhook.js";

test("notify webhook resolves encrypted endpoint and signing-secret references", () => {
  const values: Record<string, string> = {
    "publishing-endpoint": "https://example.com/hooks/private-path?token=sensitive",
    "publishing-signing-key": "signing-secret",
  };
  setWebhookSecretResolver((name) => values[name]);

  try {
    const resolved = resolveWebhookInput("publish", {
      webhook_url_ref: "publishing-endpoint",
      webhook_signing_secret_ref: "publishing-signing-key",
      webhook_payload_keys: "draft.result",
      "draft.result": "Approved draft",
    });

    assert.deepEqual(resolved, {
      url: values["publishing-endpoint"],
      payload: { "draft.result": "Approved draft" },
      secret: "signing-secret",
    });
  } finally {
    setWebhookSecretResolver((name) => process.env[name]);
  }
});

test("encrypted webhook endpoint wins over an unrelated generic URL", () => {
  setWebhookSecretResolver((name) => name === "alert-endpoint" ? "https://example.com/alerts" : undefined);

  try {
    const resolved = resolveWebhookInput("alert", {
      webhook_url_ref: "alert-endpoint",
      url: "https://example.com/product-being-watched",
      webhook_payload_keys: "analyze.result",
      "analyze.result": "Price changed",
    });

    assert.equal(resolved.url, "https://example.com/alerts");
  } finally {
    setWebhookSecretResolver((name) => process.env[name]);
  }
});

test("notify webhook resolves explicit destination and payload mappings", () => {
  const resolved = resolveWebhookInput("publish", {
    webhook_url_key: "publish_webhook",
    publish_webhook: "https://example.com/hook",
    webhook_payload_keys: "draft.result, plan.result",
    webhook_event: "growth.plan.ready",
    "study.body": "<!doctype html><html>wrong payload</html>",
    "draft.result": "Publish-ready article",
    "plan.result": "Prioritized plan",
  });

  assert.deepEqual(resolved, {
    url: "https://example.com/hook",
    payload: {
      "draft.result": "Publish-ready article",
      "plan.result": "Prioritized plan",
    },
    event: "growth.plan.ready",
  });
});

test("notify webhook never guesses a fetched body as its payload", () => {
  const resolved = resolveWebhookInput("publish", {
    status_channel: "https://example.com/incidents",
    "fetch.body": "<!doctype html><html>source page</html>",
    "compose.result": "actual output",
  });

  assert.equal(resolved.url, "https://example.com/incidents");
  assert.deepEqual(resolved.payload, {});
});

test("node-scoped connector values override generic manifest mappings", () => {
  const resolved = resolveWebhookInput("publish", {
    "publish.url": "https://example.com/explicit",
    "publish.payload": "exact body",
    webhook_url_key: "status_channel",
    status_channel: "https://example.com/fallback",
    webhook_payload_keys: "plan.result",
    "plan.result": "fallback body",
  });

  assert.equal(resolved.url, "https://example.com/explicit");
  assert.equal(resolved.payload, "exact body");
});

test("explicit webhook mappings override unrelated generic connector fields", () => {
  const resolved = resolveWebhookInput("publish", {
    url: "https://example.com/unrelated",
    payload: "unrelated payload",
    webhook_url_key: "publish_webhook",
    publish_webhook: "https://example.com/delivery",
    webhook_payload_keys: "dossier.result",
    "dossier.result": "approved dossier",
  });

  assert.equal(resolved.url, "https://example.com/delivery");
  assert.deepEqual(resolved.payload, { "dossier.result": "approved dossier" });
});
