/**
 * Anthropic model adapter tests — deterministic via an injected fake fetch.
 * Proves: defensive parsing, and that an UNTRUSTED model proposal still cannot
 * escalate (compiler rejects it). Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicModel, ModelError, parseManifestProposal } from "./anthropic-model.js";
import { Compiler, type Principal } from "../core/compiler/compiler.js";
import { HmacKeyring } from "../core/ledger/crypto.js";

function fakeFetch(replyText: string, status = 200): typeof fetch {
  // The model adapter uses Anthropic tool-calling: it reads the manifest from a
  // `tool_use` block's `input`, not from free text. Mirror that shape here. When the
  // reply is valid JSON, return it as the tool-call input (the normal path); otherwise
  // fall back to a text block so error/garbage-handling paths still exercise correctly.
  let toolInput: unknown;
  try { toolInput = JSON.parse(replyText); } catch { toolInput = undefined; }
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return toolInput !== undefined
          ? { content: [{ type: "tool_use", name: "build_manifest", input: toolInput }] }
          : { content: [{ type: "text", text: replyText }] };
      },
      async text() {
        return replyText;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

const VALID = JSON.stringify({
  version: 1,
  name: "research",
  intent: "research X",
  entry: "a",
  runBudgetCents: 50,
  maxNodeVisits: 2,
  nodes: [{ id: "a", role: "researcher", autonomy: "full", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 30 }] }],
  edges: [],
});

function modelWith(reply: string) {
  return new AnthropicModel({
    apiKey: "test-key",
    allowedCapabilities: [{ name: "web_search", sideEffect: "read" }],
    suggestedRunBudgetCents: 100,
    fetchImpl: fakeFetch(reply),
  });
}

// ── parsing ────────────────────────────────────────────────────────────────────

test("MODEL: parses a clean JSON manifest", async () => {
  const m = await modelWith(VALID).propose("research X");
  assert.equal(m.name, "research");
  assert.equal(m.nodes.length, 1);
});

test("MODEL: strips ```json fences the model adds anyway", () => {
  const m = parseManifestProposal("```json\n" + VALID + "\n```");
  assert.equal(m.entry, "a");
});

test("MODEL: extracts the JSON object when wrapped in prose", () => {
  const m = parseManifestProposal("Sure! Here is your manifest:\n" + VALID + "\nHope that helps!");
  assert.equal(m.name, "research");
});

test("MODEL: non-JSON output is a typed ModelError, not a crash", () => {
  assert.throws(() => parseManifestProposal("I cannot do that."), ModelError);
});

test("MODEL: wrong-shape output (missing nodes) is a typed ModelError", () => {
  assert.throws(() => parseManifestProposal(JSON.stringify({ version: 1, name: "x", entry: "a", edges: [] })), ModelError);
});

test("MODEL: wrong version is rejected", () => {
  assert.throws(() => parseManifestProposal(JSON.stringify({ version: 2, name: "x", entry: "a", nodes: [], edges: [] })), ModelError);
});

test("MODEL: a non-200 API response is a typed ModelError", async () => {
  const model = new AnthropicModel({
    apiKey: "k",
    allowedCapabilities: [],
    suggestedRunBudgetCents: 10,
    fetchImpl: fakeFetch("rate limited", 429),
  });
  await assert.rejects(() => model.propose("x"), ModelError);
});

// ── the security property: untrusted model output cannot escalate ────────────────

test("MODEL+COMPILER: a malicious model proposal is parsed but REJECTED by the compiler", async () => {
  // The model (manipulated) returns a manifest that grants a spend capability.
  const malicious = JSON.stringify({
    version: 1,
    name: "evil",
    intent: "research X",
    entry: "a",
    runBudgetCents: 9999,
    maxNodeVisits: 2,
    nodes: [{ id: "a", role: "x", autonomy: "full", capabilities: [{ name: "wire_money", sideEffect: "spend", budgetCents: 9999 }] }],
    edges: [],
  });

  const model = modelWith(malicious);
  const ring = new HmacKeyring();
  const compilerSigner = ring.addKey("compiler", "c", { epoch: 1, validFrom: 0, validUntil: null });
  const compiler = new Compiler(model, compilerSigner);

  // a normal principal that may only do read web_search with a small budget
  const principal: Principal = {
    kind: "channel",
    id: "telegram:user",
    maxRunBudgetCents: 50,
    allowedCapabilities: [{ name: "web_search", sideEffect: "read", maxBudgetCents: 20 }],
  };

  const res = await compiler.compile("research X", principal, 1);
  // The security INVARIANT: untrusted model output cannot escalate authority — the
  // proposal must be rejected at the monotonicity boundary. (Defense in depth: the model
  // adapter also drops unknown capability names like "wire_money" at parse-time as
  // normalization, so the surviving escalation the compiler catches is the budget blow-out;
  // either way the proposal never compiles into a signed manifest.)
  assert.ok(!res.ok, "malicious proposal must be rejected");
  assert.equal(res.stage, "monotonicity");
  assert.ok(
    res.issues.some((i) => i.code === "BUDGET_ESCALATION" || i.code === "CAPABILITY_ESCALATION"),
    "must reject for an authority-escalation reason",
  );
});

// ── A2: the compiler must guide output_map for prose-composing agents ─────────────

test("MODEL: the compiler prompt instructs output_map for the final composing node", async () => {
  // Capture the outgoing request body so we can assert on the system prompt the model sees.
  let seenSystem = "";
  const capturingFetch = (async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}") as { system?: string };
    seenSystem = body.system ?? "";
    return {
      ok: true, status: 200,
      async json() { return { content: [{ type: "tool_use", name: "build_manifest", input: JSON.parse(VALID) }] }; },
      async text() { return VALID; },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const model = new AnthropicModel({
    apiKey: "k",
    allowedCapabilities: [{ name: "web_search", sideEffect: "read" }],
    suggestedRunBudgetCents: 100,
    fetchImpl: capturingFetch,
  });
  await model.propose("write me a brief");
  assert.ok(seenSystem.includes("output_map"), "prompt must instruct output_map");
  assert.ok(/final node/i.test(seenSystem), "prompt must tie output_map to the final composing node");
});

test("MODEL+COMPILER: an output_map in a proposal survives compilation intact", async () => {
  const withMap = JSON.stringify({
    version: 1,
    name: "briefer",
    intent: "brief me",
    entry: "write",
    runBudgetCents: 50,
    maxNodeVisits: 2,
    seed: { output_map: "title=write.title,body=write.body,format=markdown" },
    nodes: [{ id: "write", role: "Write a brief. Output keys: body, title.", autonomy: "full", capabilities: [{ name: "think", sideEffect: "read", budgetCents: 30 }] }],
    edges: [],
  });
  const model = modelWith(withMap);
  const ring = new HmacKeyring();
  const compilerSigner = ring.addKey("compiler", "c", { epoch: 1, validFrom: 0, validUntil: null });
  const compiler = new Compiler(model, compilerSigner);
  const owner: Principal = {
    kind: "owner",
    id: "owner",
    maxRunBudgetCents: 1000,
    allowedCapabilities: [{ name: "think", sideEffect: "read", maxBudgetCents: 100 }],
  };
  const res = await compiler.compile("brief me", owner, 1);
  assert.ok(res.ok, !res.ok ? JSON.stringify(res.issues) : "");
  assert.equal(res.signed.manifest.seed?.["output_map"], "title=write.title,body=write.body,format=markdown", "output_map is preserved through compilation");
});

test("MODEL+COMPILER: a valid proposal within authority compiles", async () => {
  const model = modelWith(VALID);
  const ring = new HmacKeyring();
  const compilerSigner = ring.addKey("compiler", "c", { epoch: 1, validFrom: 0, validUntil: null });
  const compiler = new Compiler(model, compilerSigner);
  const owner: Principal = {
    kind: "owner",
    id: "owner",
    maxRunBudgetCents: 1000,
    allowedCapabilities: [{ name: "web_search", sideEffect: "read", maxBudgetCents: 100 }],
  };
  const res = await compiler.compile("research X", owner, 1);
  assert.ok(res.ok, !res.ok ? JSON.stringify(res.issues) : "");
});
