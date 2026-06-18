/**
 * MCP side-effect inference — fail-closed behavior.
 * An unrecognized third-party tool must NOT install as a harmless "read".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSideEffect } from "./mcp-client.js";

test("inferSideEffect: positively-read tools are read", () => {
  for (const t of ["get_user", "list_repos", "read_file", "search_issues", "fetch_data", "describe_table"]) {
    assert.equal(inferSideEffect(t), "read", `${t} should be read`);
  }
});

test("inferSideEffect: write/irreversible/spend/message keywords classify correctly", () => {
  assert.equal(inferSideEffect("create_issue"), "write-reversible");
  assert.equal(inferSideEffect("delete_account"), "write-irreversible");
  assert.equal(inferSideEffect("charge_card"), "spend");
  assert.equal(inferSideEffect("send_message"), "message-human");
  assert.equal(inferSideEffect("wipe_database"), "write-irreversible");
  assert.equal(inferSideEffect("exec_sql"), "write-reversible");
});

test("inferSideEffect: UNKNOWN tools fail closed (not read)", () => {
  // tools that match no read/write/spend/message keyword must gate for approval
  for (const t of ["frobnicate", "xyzzy", "doTheThing", "qwopfoo"]) {
    const cls = inferSideEffect(t);
    assert.notEqual(cls, "read", `${t} must NOT default to read`);
    assert.equal(cls, "write-irreversible", `${t} should fail closed to write-irreversible`);
  }
});

test("inferSideEffect: the classic dangerous unknown names are gated", () => {
  assert.notEqual(inferSideEffect("wipeAccount"), "read");
  assert.notEqual(inferSideEffect("execSql"), "read");
});

// ── MCP child env: scrubbed + secret-injected (security-critical) ───────────────
import { buildMcpChildEnv, mcpSecretRefs } from "./mcp-client.js";

test("buildMcpChildEnv: resolves {{secret:NAME}} from the resolver", () => {
  const env = buildMcpChildEnv(
    { GITHUB_PERSONAL_ACCESS_TOKEN: "{{secret:GITHUB_TOKEN}}" },
    (name) => (name === "GITHUB_TOKEN" ? "ghp_realtoken" : undefined),
  );
  assert.equal(env["GITHUB_PERSONAL_ACCESS_TOKEN"], "ghp_realtoken");
});

test("buildMcpChildEnv: Krelvan's OWN secrets are NOT leaked to the child", () => {
  process.env["KRELVAN_LEDGER_OWNER_SECRET"] = "leak-me";
  process.env["KRELVAN_AUTH_TOKEN"] = "leak-me-too";
  process.env["KRELVAN_LLM_API_KEY"] = "sk-leak";
  try {
    const env = buildMcpChildEnv({ MY_TOKEN: "{{secret:X}}" }, () => "ok");
    assert.equal(env["KRELVAN_LEDGER_OWNER_SECRET"], undefined, "ledger secret must not leak");
    assert.equal(env["KRELVAN_AUTH_TOKEN"], undefined, "auth token must not leak");
    assert.equal(env["KRELVAN_LLM_API_KEY"], undefined, "llm key must not leak");
    assert.equal(env["MY_TOKEN"], "ok", "but the granted secret IS injected");
  } finally {
    delete process.env["KRELVAN_LEDGER_OWNER_SECRET"];
    delete process.env["KRELVAN_AUTH_TOKEN"];
    delete process.env["KRELVAN_LLM_API_KEY"];
  }
});

test("buildMcpChildEnv: keeps PATH-class vars so the server can actually run", () => {
  const env = buildMcpChildEnv(undefined, undefined);
  assert.ok("PATH" in env || "Path" in env, "PATH must survive for npx/uvx to work");
});

test("buildMcpChildEnv: an unresolved secret becomes empty (never the literal placeholder)", () => {
  const env = buildMcpChildEnv({ TOK: "{{secret:MISSING}}" }, () => undefined);
  assert.equal(env["TOK"], "", "missing secret resolves to empty, not the {{secret:}} text");
});

test("mcpSecretRefs: extracts the declared secret refs from a server env", () => {
  const refs = mcpSecretRefs({ name: "x", command: "y", env: { A: "{{secret:GITHUB_TOKEN}}", B: "plain", C: "{{secret:SLACK_BOT_TOKEN}}" } });
  assert.deepEqual(refs.sort(), ["GITHUB_TOKEN", "SLACK_BOT_TOKEN"]);
});
