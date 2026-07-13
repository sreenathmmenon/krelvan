import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug } from "./slug.js";

test("slugify: lowercases, hyphenates, strips punctuation", () => {
  assert.equal(slugify("Research Analyst"), "research-analyst");
  assert.equal(slugify("  Daily  Digest!! "), "daily-digest");
  assert.equal(slugify("Support Bot 2.0"), "support-bot-2-0");
  assert.equal(slugify("café ☕ agent"), "cafe-agent");
});

test("slugify: never returns an empty string", () => {
  assert.equal(slugify(""), "agent");
  assert.equal(slugify("!!!"), "agent");
  assert.equal(slugify("   "), "agent");
});

test("slugify: caps length", () => {
  assert.ok(slugify("x".repeat(200)).length <= 60);
});

test("uniqueSlug: returns the base slug when free", () => {
  assert.equal(uniqueSlug("Research Analyst", new Set()), "research-analyst");
});

test("uniqueSlug: appends a 4-char suffix on collision", () => {
  const taken = new Set(["research-analyst"]);
  const s = uniqueSlug("Research Analyst", taken, () => "ab12");
  assert.equal(s, "research-analyst-ab12");
  assert.ok(!taken.has(s));
});

test("uniqueSlug: retries until it finds a free suffix", () => {
  const taken = new Set(["digest", "digest-aaaa"]);
  let n = 0;
  const rand = () => (n++ === 0 ? "aaaa" : "bbbb"); // first collides, second is free
  assert.equal(uniqueSlug("Digest", taken, rand), "digest-bbbb");
});
