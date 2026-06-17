/**
 * Guards the shipped price-monitor template: its manifest must always validate, declare
 * only real built-in capabilities, and keep the conditional alert edge well-formed. If
 * someone edits the JSON and breaks it, this test fails before it ever reaches a user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "price-monitor.manifest.json"), "utf8")) as Manifest;

// The capabilities the template uses must all be real built-ins (registered in runtime.ts).
const BUILTINS = new Set(["think", "llm_route", "compose", "recall", "remember", "identify", "web_search", "http_get", "http_post", "notify_webhook", "text_transform", "email_send", "telegram_send", "slack_send"]);

test("price-monitor manifest is structurally valid", () => {
  const issues = validateManifest(manifest);
  assert.deepEqual(issues, [], `validation issues: ${issues.map(i => i.message).join("; ")}`);
});

test("price-monitor uses only real built-in capabilities", () => {
  for (const node of manifest.nodes) {
    for (const cap of node.capabilities) {
      assert.ok(BUILTINS.has(cap.name), `node '${node.id}' uses unknown capability '${cap.name}'`);
    }
  }
});

test("price-monitor has the conditional alert edge (alert fires only when changed)", () => {
  const alertEdge = manifest.edges.find(e => e.to === "alert");
  assert.ok(alertEdge, "there must be an edge into the alert node");
  assert.ok(alertEdge!.when, "the alert edge MUST be conditional (only alert on a change)");
  // The gate is DETERMINISTIC (injection-proof): it compares the extracted current_price
  // to the recalled baseline in the engine, never trusting an LLM-set 'changed' flag.
  const json = JSON.stringify(alertEdge!.when);
  assert.match(json, /"key":"analyze\.current_price"/, "alert gate must compare the current price");
  assert.match(json, /"key":"recall_baseline\.recall\.last_price"/, "alert gate must compare against the recalled baseline");
});

test("price-monitor persists a baseline deterministically (remember_map in seed)", () => {
  assert.ok(manifest.seed, "template must seed config");
  assert.match(String(manifest.seed!["remember_map"]), /last_price=analyze\.current_price/);
});

test("price-monitor always ends at the persist node (baseline saved on every path)", () => {
  // Both the alert path and the no-change path must reach persist.
  const fromAnalyze = manifest.edges.filter(e => e.from === "analyze").map(e => e.to);
  assert.ok(fromAnalyze.includes("persist"), "analyze must have an unconditional edge to persist");
  const fromAlert = manifest.edges.filter(e => e.from === "alert").map(e => e.to);
  assert.ok(fromAlert.includes("persist"), "alert must continue to persist");
});
