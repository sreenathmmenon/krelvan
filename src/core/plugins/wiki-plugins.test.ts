/**
 * LLM-Wiki capability tests — wiki.ingest + wiki.query.
 *
 * These exercise the DETERMINISTIC capability layer (page bookkeeping, index, log,
 * contradictions, path-safety, growth, query/grounding) — no LLM needed. The end-to-end
 * agent runs (think synthesis → ingest → query → cited answer) are covered live against
 * Ollama in llm-wiki.test.ts.
 */
process.env["KRELVAN_DATA_DIR"] ??= "";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wikiIngestCapability, wikiQueryCapability } from "./wiki-plugins.js";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "krelvan-wiki-")); process.env["KRELVAN_DATA_DIR"] = dir; });
after(() => rmSync(dir, { recursive: true, force: true }));

function ingest(input: Record<string, unknown>) {
  return wikiIngestCapability.invoke({ nodeId: "apply", capability: "wiki.ingest", input } as never);
}
function query(input: Record<string, unknown>) {
  return wikiQueryCapability.invoke({ nodeId: "find", capability: "wiki.query", input } as never);
}
const out = (r: { output: unknown }) => r.output as Record<string, unknown>;

test("wiki.ingest: writes entity pages, index, and log", async () => {
  const r = await ingest({
    wiki: "test-kb", source: "intro",
    pages: [
      { kind: "entity", title: "Krelvan", summary: "A self-hosted agent platform.", content: "Krelvan runs agents with a signed ledger.", links: ["Ledger"] },
      { kind: "concept", title: "Ledger", summary: "A signed event log.", content: "Every step is a signed, replayable event." },
    ],
  });
  const o = out(r);
  assert.equal(o["ok"], true);
  assert.equal(o["pages_touched"], 2);
  assert.equal(o["total_pages"], 2);
  const wd = join(dir, "wikis", "test-kb");
  assert.ok(existsSync(join(wd, "entities", "krelvan.md")), "entity page written");
  assert.ok(existsSync(join(wd, "concepts", "ledger.md")), "concept page written");
  assert.ok(existsSync(join(wd, "index.md")), "index written");
  assert.ok(existsSync(join(wd, "log.md")), "log written");
  // [[wiki-links]] rendered + index catalogs pages
  assert.match(readFileSync(join(wd, "entities", "krelvan.md"), "utf8"), /\[\[ledger\]\]/);
  assert.match(readFileSync(join(wd, "index.md"), "utf8"), /\[\[krelvan\]\]/);
});

test("wiki.query: returns grounded, page-cited context for a matching question", async () => {
  const r = await query({ wiki: "test-kb", question: "What is the Krelvan ledger?" });
  const o = out(r);
  assert.equal(o["ok"], true);
  assert.ok((o["hits"] as number) >= 1, "at least one page matched");
  assert.match(String(o["body"]), /\(page: /, "context cites page names");
  assert.match(String(o["sources"]), /krelvan|ledger/);
});

test("P3/unknown: query with no matching page returns hits:0, never fabricates", async () => {
  const r = await query({ wiki: "test-kb", question: "quarterly revenue of Saturn mining corp" });
  const o = out(r);
  assert.equal(o["ok"], true);
  assert.equal(o["hits"], 0);
  assert.equal(o["body"], "");
  assert.match(String(o["note"]), /no wiki page matches/);
});

test("P3/empty: query against an empty wiki says so", async () => {
  const r = await query({ wiki: "empty-kb", question: "anything" });
  const o = out(r);
  assert.equal(o["ok"], true);
  assert.equal(o["hits"], 0);
  assert.match(String(o["note"]), /empty/);
});

test("P4/empty ingest: no pages produced → ok, pages_touched:0, no crash", async () => {
  const r = await ingest({ wiki: "blank-kb", source: "nothing", pages: [] });
  const o = out(r);
  assert.equal(o["ok"], true);
  assert.equal(o["pages_touched"], 0);
});

test("P4/degraded: a single page from flat title+content works", async () => {
  const r = await ingest({ wiki: "flat-kb", source: "note", title: "Widget", content: "A widget is a thing." });
  assert.equal(out(r)["pages_touched"], 1);
  const q = await query({ wiki: "flat-kb", question: "what is a widget" });
  assert.ok((out(q)["hits"] as number) >= 1);
});

test("P12/growth: re-ingesting updates the SAME page (no duplicate) and tracks both sources", async () => {
  await ingest({ wiki: "grow-kb", source: "src-a", pages: [{ title: "Topic X", content: "First fact about X." }] });
  const r2 = await ingest({ wiki: "grow-kb", source: "src-b", pages: [{ title: "Topic X", content: "Updated, fuller fact about X." }] });
  assert.equal(out(r2)["total_pages"], 1, "still ONE page — updated, not duplicated");
  const page = readFileSync(join(dir, "wikis", "grow-kb", "entities", "topic-x.md"), "utf8");
  assert.match(page, /Updated, fuller fact/);
  assert.match(page, /sources: src-a, src-b/, "provenance accumulates across ingests");
});

test("P16/contradiction: a contradicting ingest is flagged on the page", async () => {
  await ingest({ wiki: "con-kb", source: "s1", pages: [{ title: "Pluto", content: "Pluto is a planet." }] });
  await ingest({ wiki: "con-kb", source: "s2", pages: [{ title: "Pluto", content: "Pluto is a dwarf planet.", contradicts: "earlier source called it a planet" }] });
  const page = readFileSync(join(dir, "wikis", "con-kb", "entities", "pluto.md"), "utf8");
  assert.match(page, /⚠ Contradiction:.*earlier source/);
});

test("P11/multi-page: query spanning two pages cites both", async () => {
  await ingest({ wiki: "multi-kb", source: "doc", pages: [
    { title: "Alpha Protocol", content: "Alpha Protocol governs onboarding." },
    { title: "Beta Protocol", content: "Beta Protocol governs offboarding." },
  ] });
  const r = await query({ wiki: "multi-kb", question: "what do the alpha protocol and beta protocol govern", top_k: 5 });
  const o = out(r);
  assert.ok((o["hits"] as number) >= 2, "both pages retrieved");
  assert.match(String(o["sources"]), /alpha-protocol/);
  assert.match(String(o["sources"]), /beta-protocol/);
});

test("P13/path-traversal: malicious wiki/source/title names are rejected or neutralised", async () => {
  // Wiki name traversal → rejected, nothing written outside the wikis root.
  const bad = await ingest({ wiki: "../escape", source: "x", title: "T", content: "c" });
  assert.equal(out(bad)["ok"], false, "traversal wiki name rejected");
  assert.ok(!existsSync(join(dir, "escape")), "no dir created outside wikis/");
  assert.ok(!existsSync(join(dir, "wikis", "escape")), "and not a sibling either");

  const badSrc = await ingest({ wiki: "ok-kb", source: "../../etc/passwd", title: "T", content: "c" });
  assert.equal(out(badSrc)["ok"], false, "traversal source rejected");

  // A page title with traversal chars is slugged to a safe filename (../ stripped), not escaped.
  const okTitle = await ingest({ wiki: "ok-kb", source: "s", pages: [{ title: "../../secret", content: "data" }] });
  assert.equal(out(okTitle)["ok"], true);
  const ents = readdirSync(join(dir, "wikis", "ok-kb", "entities"));
  assert.ok(ents.every((f) => !f.includes("..") && !f.includes("/")), "no traversal in written filenames");
});

test("P14/concurrent: parallel ingests to one wiki don't corrupt; index reflects all pages", async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    ingest({ wiki: "race-kb", source: `s${i}`, pages: [{ title: `Page ${i}`, content: `content ${i}` }] })));
  const q = await query({ wiki: "race-kb", question: "content", top_k: 8 });
  // All 8 distinct pages exist on disk and are queryable (last-write-wins per file; index rebuilt from dir).
  const ents = readdirSync(join(dir, "wikis", "race-kb", "entities")).filter((f) => f.endsWith(".md"));
  assert.equal(ents.length, 8, "all 8 pages present, none lost to a race");
  assert.ok((out(q)["hits"] as number) >= 1);
});

test("validation: missing question / missing wiki are handled, not thrown", async () => {
  assert.equal(out(await query({ wiki: "test-kb", question: "" }))["ok"], false);
  assert.equal(out(await query({ wiki: "test-kb" }))["ok"], false);
});

test("RELATIVE KRELVAN_DATA_DIR: a valid wiki name still resolves (regression)", async () => {
  // Regression: a RELATIVE data dir (e.g. "./data") made the path-escape check compare an
  // absolute resolved dir against a relative root, wrongly rejecting EVERY valid wiki name.
  // Reproduce it for real by pointing KRELVAN_DATA_DIR at a relative path under cwd.
  const saved = process.env["KRELVAN_DATA_DIR"];
  // Create the data dir UNDER cwd so we can reference it with a relative "./" path.
  const absUnderCwd = mkdtempSync(join(process.cwd(), "wiki-reltest-"));
  const relRoot = "./" + absUnderCwd.slice(process.cwd().length + 1);
  try {
    process.env["KRELVAN_DATA_DIR"] = relRoot; // e.g. "./.../rel-xxxx" — relative
    const r = await ingest({ wiki: "ev-wiki", source: "s", title: "Krelvan", content: "A platform." });
    assert.equal(out(r)["ok"], true, "valid wiki name must resolve under a relative data dir");
    assert.equal(out(r)["pages_touched"], 1);
    const q = await query({ wiki: "ev-wiki", question: "what is krelvan" });
    assert.ok((out(q)["hits"] as number) >= 1, "and the page is queryable");
  } finally {
    process.env["KRELVAN_DATA_DIR"] = saved;
    rmSync(absUnderCwd, { recursive: true, force: true });
  }
});
