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
