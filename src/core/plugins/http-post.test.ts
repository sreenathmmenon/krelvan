import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHttpPostInput } from "./http-post.js";

test("http_post binds a reviewed upstream request into the connector call", () => {
  assert.deepEqual(resolveHttpPostInput("refund", {
    url: "https://api.example.test/refunds",
    "refund.body_key": "prepare_refund.body",
    "prepare_refund.body": '{"order_id":"SYN-2481","amount_minor_units":12900}',
    body: "stale body",
  }), {
    url: "https://api.example.test/refunds",
    body: '{"order_id":"SYN-2481","amount_minor_units":12900}',
  });
});

test("http_post can bind a node-specific URL without executing an expression", () => {
  assert.deepEqual(resolveHttpPostInput("publish", {
    "publish.url_key": "connector.endpoint",
    "connector.endpoint": "https://hooks.example.test/publish",
    "http_body_key": "draft.result",
    "draft.result": "reviewed payload",
  }), {
    url: "https://hooks.example.test/publish",
    body: "reviewed payload",
  });
});
