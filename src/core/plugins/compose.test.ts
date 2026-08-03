import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleComposedReport, buildCompositionContext, cleanComposedText, resolveComposeMaxTokens, selectCompositionContext } from "./compose.js";

test("compose: hosted reasoning models get enough output headroom for substantial writing", () => {
  assert.equal(resolveComposeMaxTokens("openai", "detailed"), 8192);
  assert.equal(resolveComposeMaxTokens("openai", "brief"), 4096);
  assert.equal(resolveComposeMaxTokens("anthropic", "detailed"), 4096);
  assert.equal(resolveComposeMaxTokens("ollama", "detailed"), 2048);
  assert.equal(resolveComposeMaxTokens("openai", "detailed", "12000"), 12000);
  assert.equal(resolveComposeMaxTokens("openai", "detailed", "100"), 512);
});

test("compose: deterministically assembles exact prior outputs into a report", () => {
  const report = assembleComposedReport("Launch dossier", "Evidence=research.result,Assets=draft.result", {
    "research.result": "Source-backed findings.",
    "draft.result": "# Complete article\n\nExact draft.",
  });
  assert.equal(report, "# Launch dossier\n\n## Evidence\n\nSource-backed findings.\n\n## Assets\n\n# Complete article\n\nExact draft.");
});

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

test("compose: turns simple model-emitted TeX arithmetic into clean customer-facing text", () => {
  assert.equal(cleanComposedText(String.raw`Verified: \(28 \times 14 = 392\).`), "Verified: 28 × 14 = 392.");
  assert.equal(cleanComposedText(String.raw`\[144 \div 12 = 12\]`), "144 ÷ 12 = 12");
});

test("compose: keeps short scalar results from prior nodes as grounded context", () => {
  const context = buildCompositionContext({
    "calculate.result": 392,
    "calculate.verified": true,
    "calculate.risk_level": "low",
    "calculate.role": "Calculate 28 multiplied by 14 and verify the arithmetic.",
    "answer.role": "Compose the exact equation.",
    role: "current composing instruction",
    _engine: "hidden",
  }, "answer");

  assert.deepEqual(context, [
    "[calculate.result]\n392",
    "[calculate.verified]: true",
    "[calculate.risk_level]: low",
    "[calculate.role]: Calculate 28 multiplied by 14 and verify the arithmetic.",
  ]);
});

test("compose: hosted context keeps a multi-record result beyond the former 3000-char ceiling", () => {
  const longResult = "record;".repeat(700);
  const context = buildCompositionContext({ "audit.result": longResult }, "report");
  assert.equal(context[0], `[audit.result]\n${longResult}`);
});

test("compose: puts observed connector delivery evidence before long prose", () => {
  const context = buildCompositionContext({
    "analysis.result": "A".repeat(5000),
    "draft.result": "B".repeat(5000),
    "update_status.notified": true,
    "update_status.status": 200,
    "update_status.error": null,
  }, "final_report");

  assert.deepEqual(context.slice(0, 2), [
    "[update_status.notified]: true",
    "[update_status.status]: 200",
  ]);
});

test("compose: keeps QA decisions ahead of long narrative context", () => {
  const context = buildCompositionContext({
    "analysis.result": "A".repeat(5000),
    "draft.result": "B".repeat(5000),
    "qa.qa_relevant": true,
    "qa.qa_accurate": true,
    "qa.qa_safe": true,
    "qa.qa_resolved": false,
    "qa.qa_score": 68,
    "qa.qa_note": "Safe handoff, but delivery failed.",
  }, "finalize");

  assert.deepEqual(context.slice(0, 6), [
    "[qa.qa_relevant]: true",
    "[qa.qa_accurate]: true",
    "[qa.qa_safe]: true",
    "[qa.qa_resolved]: false",
    "[qa.qa_score]: 68",
    "[qa.qa_note]: Safe handoff, but delivery failed.",
  ]);
  assert.ok(selectCompositionContext(context, "openai").some(part => part === "[qa.qa_score]: 68"));
});

test("compose: packs hosted context beyond eight entries but bounds total size", () => {
  const parts = Array.from({ length: 30 }, (_, index) => `[k${index}]: ${"x".repeat(5000)}`);
  const hosted = selectCompositionContext(parts, "openai");
  const local = selectCompositionContext(parts, "ollama");
  assert.ok(hosted.length > 8);
  assert.ok(hosted.join("").length <= 96_100);
  assert.ok(local.length <= 8);
  assert.ok(local.join("").length <= 24_100);
});
