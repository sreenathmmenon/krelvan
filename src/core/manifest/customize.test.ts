/**
 * applyCustomize — the "make it mine" bake step. These tests prove the clone-and-customize model
 * clone flow: a builder's settings bake into a fresh valid manifest; anything not
 * declared customizable is rejected (deny-by-default); the template itself is never
 * mutated; and validateManifest rejects malformed customize blocks at load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateManifest, type Manifest } from "./manifest.js";
import { applyCustomize } from "./customize.js";

function template(): Manifest {
  return {
    version: 1,
    name: "Support Agent",
    intent: "resolve tickets",
    entry: "answer",
    runBudgetCents: 500,
    maxNodeVisits: 3,
    seed: { kb: "default-kb", tone: "warm" },
    nodes: [
      { id: "answer", role: "answer the ticket", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 60 }] },
      { id: "send", role: "send the reply", autonomy: "suggest", capabilities: [{ name: "email_send", sideEffect: "message-human", budgetCents: 5 }] },
    ],
    edges: [{ from: "answer", to: "send" }],
    customize: {
      agent_name: { label: "Agent name", type: "text", rename: true, default: "Support Agent" },
      kb: { label: "Knowledge base", type: "text", seedKey: "kb" },
      tone: { label: "Reply tone", type: "choice", options: ["warm", "formal", "concise"], seedKey: "tone" },
      auto_send: { label: "Send automatically?", type: "toggle", autonomy: { nodeId: "send", on: "full", off: "suggest" } },
    },
  };
}

test("customize: bakes name, seed values, choice, and autonomy toggle into a fresh valid manifest", () => {
  const t = template();
  const r = applyCustomize(t, { agent_name: "Acme Support", kb: "acme-docs", tone: "formal", auto_send: true });
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.manifest.name, "Acme Support");
  assert.equal(r.manifest.seed?.["kb"], "acme-docs");
  assert.equal(r.manifest.seed?.["tone"], "formal");
  assert.equal(r.manifest.nodes.find((n) => n.id === "send")?.autonomy, "full", "auto_send=true must flip the send node to full");
  assert.deepEqual(validateManifest(r.manifest), [], "the customized manifest must validate");
});

test("customize: the clone is independent — template untouched, customize surface stripped", () => {
  const t = template();
  const before = JSON.stringify(t);
  const r = applyCustomize(t, { agent_name: "Acme Support", auto_send: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(JSON.stringify(t), before, "the template manifest must never be mutated");
  assert.equal(r.manifest.customize, undefined, "the cloned agent does not re-expose the customize surface");
  assert.equal(t.nodes.find((n) => n.id === "send")?.autonomy, "suggest", "template's own autonomy unchanged");
});

test("customize: omitted settings leave the template's own values standing", () => {
  const r = applyCustomize(template(), { agent_name: "Beta Helpdesk" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.manifest.seed?.["kb"], "default-kb", "untouched seed value stands");
  assert.equal(r.manifest.nodes.find((n) => n.id === "send")?.autonomy, "suggest", "untouched toggle stands");
});

test("customize: deny-by-default — an undeclared setting key is an error, never a silent ignore", () => {
  const r = applyCustomize(template(), { run_budget: 99999 });
  assert.ok(!r.ok, "undeclared key must be rejected");
  if (r.ok) return;
  assert.match(r.error, /not a customizable setting/);
});

test("customize: values are type-checked (bad choice, non-boolean toggle, empty name all rejected)", () => {
  const badChoice = applyCustomize(template(), { tone: "sarcastic" });
  assert.ok(!badChoice.ok && /one of/.test(badChoice.ok ? "" : badChoice.error), "choice outside options rejected");
  const badToggle = applyCustomize(template(), { auto_send: "yes" as unknown as boolean });
  assert.ok(!badToggle.ok, "non-boolean toggle rejected");
  const emptyName = applyCustomize(template(), { agent_name: "   " });
  assert.ok(!emptyName.ok, "empty agent name rejected");
});

test("validateManifest: a malformed customize block is rejected at load", () => {
  const t = template();
  // choice with no options
  t.customize!["bad_choice"] = { label: "x", type: "choice", seedKey: "x" };
  // toggle targeting an unknown node
  t.customize!["bad_node"] = { label: "y", type: "toggle", autonomy: { nodeId: "ghost", on: "full", off: "suggest" } };
  // double binding (rename + seedKey)
  t.customize!["double"] = { label: "z", type: "text", rename: true, seedKey: "z" };
  const codes = validateManifest(t).map((i) => i.code);
  assert.equal(codes.filter((c) => c === "BAD_CUSTOMIZE").length >= 3, true, `expected 3+ BAD_CUSTOMIZE issues, got: ${codes.join(",")}`);
});

test("customize: no customize block at all -> only empty settings are acceptable", () => {
  const t = template();
  delete t.customize;
  const empty = applyCustomize(t, {});
  assert.ok(empty.ok, "cloning with no settings is a plain copy");
  const withSetting = applyCustomize(t, { agent_name: "X" });
  assert.ok(!withSetting.ok, "any setting against a customize-less template is rejected");
});
