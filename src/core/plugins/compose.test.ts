import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanComposedText } from "./compose.js";

test("compose: strips a leading title:/body: label pair", () => {
  const out = cleanComposedText("title: My Headline\nbody: The actual prose here.");
  assert.equal(out, "My Headline\nThe actual prose here.");
});

test("compose: strips title:/body: labels for EVERY item in a digest", () => {
  const raw = [
    "title: Light-Matter Particles for AI Computing",
    "body: Researchers at UPenn developed hybrid particles.",
    "",
    "title: SpaceX's AI Data Centers",
    "body: SpaceX proposed data centers in orbit.",
  ].join("\n");
  const out = cleanComposedText(raw);
  assert.ok(!/title:/i.test(out), "no title: label remains");
  assert.ok(!/body:/i.test(out), "no body: label remains");
  assert.ok(out.includes("Light-Matter Particles for AI Computing"));
  assert.ok(out.includes("Researchers at UPenn developed hybrid particles."));
  assert.ok(out.includes("SpaceX proposed data centers in orbit."));
});

test("compose: strips other field labels (brief:/summary:/message:) at line start", () => {
  assert.equal(cleanComposedText("brief: Customer needs help with an order."), "Customer needs help with an order.");
  assert.equal(cleanComposedText("summary: Three things happened."), "Three things happened.");
  assert.equal(cleanComposedText("message: Please review this."), "Please review this.");
});

test("compose: strips labels using '=' as well as ':' (title=X / body=Y)", () => {
  const raw = "body=Recent advancements in AI are transforming industries.\ntitle=AI Advancements";
  const out = cleanComposedText(raw);
  assert.ok(!/body=/i.test(out) && !/title=/i.test(out), "no = labels remain");
  assert.ok(out.includes("Recent advancements in AI are transforming industries."));
  assert.ok(out.includes("AI Advancements"));
});

test("compose: does NOT mangle a real sentence with a colon mid-line", () => {
  const raw = "The result was clear: the API must stay simple. Here is why: consistency wins.";
  assert.equal(cleanComposedText(raw), raw);
});

test("compose: unwraps a JSON-object answer", () => {
  assert.equal(cleanComposedText('{"text":"Just the prose."}'), "Just the prose.");
});

test("compose: unwraps a fenced code block around the whole answer", () => {
  assert.equal(cleanComposedText("```\nHello world.\n```"), "Hello world.");
});
