/**
 * RAG capability tests. The embedding step needs a real embeddings provider; we use
 * Ollama (nomic-embed-text) when reachable and SKIP gracefully if it isn't, so the suite
 * still passes in CI without Ollama. The retrieval logic (ingest → search → right chunk
 * ranks first) is the real assertion.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ragIngestCapability, ragSearchCapability } from "./rag-plugins.js";

let dir: string;
let prevData: string | undefined;
let prevProvider: string | undefined;
let ollamaUp = false;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "krelvan-rag-"));
  prevData = process.env["KRELVAN_DATA_DIR"];
  prevProvider = process.env["KRELVAN_LLM_PROVIDER"];
  process.env["KRELVAN_DATA_DIR"] = dir;
  process.env["KRELVAN_EMBED_PROVIDER"] = "ollama";
  // Probe Ollama; if down, the embedding-dependent tests will be skipped.
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    ollamaUp = r.ok;
  } catch { ollamaUp = false; }
});
after(() => {
  if (prevData === undefined) delete process.env["KRELVAN_DATA_DIR"]; else process.env["KRELVAN_DATA_DIR"] = prevData;
  if (prevProvider === undefined) delete process.env["KRELVAN_LLM_PROVIDER"]; else process.env["KRELVAN_LLM_PROVIDER"] = prevProvider;
  delete process.env["KRELVAN_EMBED_PROVIDER"];
  rmSync(dir, { recursive: true, force: true });
});

function ingest(input: Record<string, unknown>) { return { nodeId: "ingest", capability: "rag.ingest", input } as never; }
function search(input: Record<string, unknown>) { return { nodeId: "search", capability: "rag.search", input } as never; }

test("rag.search on an empty store returns ok with 0 hits (no crash)", async () => {
  const r = await ragSearchCapability.invoke(search({ _agentId: "empty", query: "anything" }));
  const o = r.output as { ok: boolean; hits: number };
  assert.equal(o.ok, true);
  assert.equal(o.hits, 0);
});

test("rag.ingest validates: no text → ok:false", async () => {
  const r = await ragIngestCapability.invoke(ingest({ _agentId: "x" }));
  assert.equal((r.output as { ok: boolean }).ok, false);
});

test("rag: ingest a doc then retrieve the relevant chunk (Ollama)", async (t) => {
  if (!ollamaUp) { t.skip("Ollama not running — skipping embedding-dependent test"); return; }
  const doc = [
    "Krelvan refunds: customers can request a refund within 30 days of purchase.",
    "Shipping: orders ship within 2 business days and arrive in 5-7 days.",
    "Account: to reset your password, use the 'Forgot password' link on the login page.",
  ].join("\n\n");

  const ing = await ragIngestCapability.invoke(ingest({ _agentId: "kb1", text: doc, source: "handbook" }));
  assert.equal((ing.output as { ok: boolean }).ok, true, "ingest should succeed");

  const res = await ragSearchCapability.invoke(search({ _agentId: "kb1", query: "How long do I have to get my money back?", top_k: 1 }));
  const o = res.output as { ok: boolean; hits: number; context: string; sources: string };
  assert.equal(o.ok, true);
  assert.ok(o.hits >= 1, "should retrieve at least one chunk");
  assert.match(o.context, /refund|30 days/i, "the top chunk should be the refunds policy, not shipping/account");
  assert.equal(o.sources, "handbook");
});
