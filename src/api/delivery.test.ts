/**
 * Delivery layer — routes a completed run's output to the customer's chosen channels,
 * best-effort (never throws), and sanitizes targets coming from the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, sanitizeTargets, type DeliveryTarget } from "./delivery.js";

test("sanitizeTargets keeps valid channels, drops junk, dedupes, caps config", () => {
  const raw = [
    { channel: "inbox" },
    { channel: "email", config: { to: "me@example.com", from: "a@b.co" } },
    { channel: "bogus" },                                  // dropped: unknown channel
    { channel: "email", config: { to: "second@example.com" } }, // dedupe: last email wins
    "not an object",                                        // dropped
    { channel: "webhook", config: { url: "https://hooks.example.com/x", n: 5 } }, // non-string config dropped
  ];
  const out = sanitizeTargets(raw);
  const channels = out.map(t => t.channel).sort();
  assert.deepEqual(channels, ["email", "inbox", "webhook"]);
  const email = out.find(t => t.channel === "email")!;
  assert.equal(email.config?.["to"], "second@example.com", "last email target wins");
  const webhook = out.find(t => t.channel === "webhook")!;
  assert.equal(webhook.config?.["url"], "https://hooks.example.com/x");
  assert.equal(webhook.config?.["n"], undefined, "non-string config values are dropped");
});

test("sanitizeTargets returns [] for non-array input", () => {
  assert.deepEqual(sanitizeTargets(null), []);
  assert.deepEqual(sanitizeTargets({ channel: "email" }), []);
  assert.deepEqual(sanitizeTargets("email"), []);
});

test("deliver: inbox is a no-op success and never calls out", async () => {
  const out = await deliver([{ channel: "inbox" }], { agentName: "A", runId: "r1", title: "t", body: "b" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.channel, "inbox");
  assert.equal(out[0]!.ok, true);
});

test("sanitizeTargets accepts the direct-API channels (sms/whatsapp/twitter/linkedin/discord)", () => {
  const raw = [
    { channel: "sms", config: { to: "+15551234567" } },
    { channel: "whatsapp", config: { to: "+15551234567" } },
    { channel: "twitter", config: { bearer_token: "x" } },
    { channel: "linkedin", config: { bearer_token: "x", author_urn: "urn:li:person:1" } },
    { channel: "discord", config: { url: "https://discord.com/api/webhooks/1/x" } },
  ];
  const out = sanitizeTargets(raw);
  assert.deepEqual(out.map(t => t.channel).sort(), ["discord", "linkedin", "sms", "twitter", "whatsapp"]);
});

test("deliver: unconfigured direct channels fail gracefully with a helpful hint, never throw", async () => {
  const targets: DeliveryTarget[] = [
    { channel: "sms", config: {} },
    { channel: "whatsapp", config: {} },
    { channel: "twitter", config: {} },
    { channel: "linkedin", config: {} },
  ];
  const out = await deliver(targets, { agentName: "Poster", runId: "r3", title: "Update", body: "Big news…" });
  assert.equal(out.length, 4);
  for (const o of out) {
    assert.equal(o.ok, false, `${o.channel} with no creds must not report success`);
    assert.match(o.detail ?? "", /needs|add/i, `${o.channel} must explain what's missing`);
  }
});

test("deliver: an unconfigured external channel fails gracefully, never throws", async () => {
  // No KRELVAN_* env / no config → the underlying send plugins return sent:false, and
  // deliver() surfaces that as ok:false with a helpful detail — but must NOT throw.
  const targets: DeliveryTarget[] = [
    { channel: "email", config: {} },
    { channel: "slack", config: {} },
    { channel: "telegram", config: {} },
    { channel: "webhook", config: {} },
  ];
  const out = await deliver(targets, { agentName: "Digest", runId: "r2", title: "News", body: "Top 3 stories…" });
  assert.equal(out.length, 4);
  for (const o of out) {
    assert.equal(typeof o.ok, "boolean");
    assert.ok(o.detail && o.detail.length > 0, `channel ${o.channel} must explain its outcome`);
  }
  // none of them should have thrown — reaching here is the assertion
});
