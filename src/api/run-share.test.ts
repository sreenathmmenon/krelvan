/**
 * Run-share store mechanics: minting a "share this run" link caches the plain-English one-pager,
 * rotating invalidates the old link, revoking drops the link AND the cached text, and resolution
 * is by unguessable token only (a wrong token never resolves). This is the persistence contract
 * the public /r/:token page depends on — no LLM involved here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRegistry } from "./runtime.js";

function dataDir(dir: string): string {
  const d = join(dir, "data");
  mkdirSync(d, { recursive: true });
  return d;
}

function reg(): { r: RunRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-runshare-"));
  return { r: new RunRegistry(dataDir(dir)), dir };
}

test("mintShare caches the one-pager and resolves by token", () => {
  const { r, dir } = reg();
  try {
    r.create({ agentId: "a1", runId: "run-1", manifestName: "Analyst" });
    const token = r.mintShare("run-1", "This agent picked a topic and wrote a brief.");
    assert.ok(token && token.length > 20, "a token is returned");

    const resolved = r.resolveShare(token!);
    assert.ok(resolved, "the token resolves");
    assert.equal(resolved!.runId, "run-1");
    assert.equal(resolved!.sharedExplanation, "This agent picked a topic and wrote a brief.");
    assert.ok(resolved!.sharedAt, "sharedAt is stamped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a wrong token never resolves", () => {
  const { r, dir } = reg();
  try {
    r.create({ agentId: "a1", runId: "run-1", manifestName: "Analyst" });
    r.mintShare("run-1", "one-pager");
    assert.equal(r.resolveShare("not-the-token"), undefined);
    assert.equal(r.resolveShare(""), undefined);
    assert.equal(r.resolveShare(undefined), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rotating the link invalidates the previous token", () => {
  const { r, dir } = reg();
  try {
    r.create({ agentId: "a1", runId: "run-1", manifestName: "Analyst" });
    const t1 = r.mintShare("run-1", "v1")!;
    const t2 = r.mintShare("run-1", "v2")!;
    assert.notEqual(t1, t2, "rotation yields a new token");
    assert.equal(r.resolveShare(t1), undefined, "the old token no longer resolves");
    assert.equal(r.resolveShare(t2)!.sharedExplanation, "v2", "the new token resolves the fresh one-pager");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("revokeShare kills the link and drops the cached one-pager", () => {
  const { r, dir } = reg();
  try {
    r.create({ agentId: "a1", runId: "run-1", manifestName: "Analyst" });
    const token = r.mintShare("run-1", "one-pager")!;
    assert.equal(r.revokeShare("run-1"), true, "revoke reports it existed");
    assert.equal(r.resolveShare(token), undefined, "the link 404s after revoke");
    const rec = r.get("run-1")!;
    assert.equal(rec.sharedExplanation, undefined, "the cached one-pager is dropped");
    assert.equal(rec.shareTokenHash, undefined, "no token hash remains");
    assert.equal(r.revokeShare("run-1"), false, "revoking again reports nothing to revoke");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mintShare on a missing run returns undefined", () => {
  const { r, dir } = reg();
  try {
    assert.equal(r.mintShare("nope", "x"), undefined);
    assert.equal(r.revokeShare("nope"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the share link survives a reload from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-runshare-"));
  try {
    const dd = dataDir(dir);
    const r1 = new RunRegistry(dd);
    r1.create({ agentId: "a1", runId: "run-1", manifestName: "Analyst" });
    const token = r1.mintShare("run-1", "persisted one-pager")!;

    // A fresh registry against the same dir loads the persisted token + cached text.
    const r2 = new RunRegistry(dd);
    const resolved = r2.resolveShare(token);
    assert.ok(resolved, "the token resolves after reload");
    assert.equal(resolved!.sharedExplanation, "persisted one-pager");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
