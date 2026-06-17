/**
 * RAG capabilities — rag.ingest and rag.search.
 *
 * A self-contained, portable, offline-capable retrieval layer:
 *   - rag.ingest  (write-reversible): chunk text → embed each chunk → store vectors
 *   - rag.search  (read): embed the query → cosine top-k → inject context into run state
 *
 * Storage is a per-agent JSON file (cosine over an in-memory array) so RAG works on a
 * laptop with zero infra and fully offline (Ollama nomic-embed-text by default). A Qdrant
 * adapter can replace the store later behind the same plugin surface without touching the
 * agent graph. Embeddings resolve via getEmbeddingsClient() — independent of the chat
 * provider, since Anthropic (the default) has no embeddings API.
 *
 * Node built-ins only.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getEmbeddingsClient } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("rag");

interface VectorPoint { id: string; text: string; source: string; vector: number[] }

function ragDir(): string {
  const dir = join(process.env["KRELVAN_DATA_DIR"] ?? "./data", "rag");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function storePath(agentId: string): string {
  return join(ragDir(), `${agentId}.json`);
}
function loadStore(agentId: string): VectorPoint[] {
  const p = storePath(agentId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")) as VectorPoint[]; } catch { return []; }
}
function saveStore(agentId: string, points: VectorPoint[]): void {
  writeFileSync(storePath(agentId), JSON.stringify(points));
}

/** Split text into overlapping chunks (~char-budget windows; respects paragraph breaks). */
function chunk(text: string, size = 1200, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    // Prefer to break on a paragraph/sentence boundary within the window.
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const br = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
      if (br > size * 0.5) end = i + br + 1;
    }
    const c = clean.slice(i, end).trim();
    if (c) chunks.push(c);
    if (end >= clean.length) break;
    i = end - overlap;
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Resolve the text to ingest from run state — explicit input, a scoped key, or any *.body. */
function resolveText(input: Record<string, unknown>, nodeId: string): string {
  for (const k of ["text", `${nodeId}.text`, "document", "body"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  // Fall back to the first non-empty *.body produced by an upstream fetch/scrape node.
  for (const [k, v] of Object.entries(input)) {
    if (k.endsWith(".body") && typeof v === "string" && v.trim()) return v;
  }
  return "";
}

export const ragIngestCapability: CapabilityPlugin = {
  name: "rag.ingest",
  sideEffect: "write-reversible",
  estimateCents: () => 3,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;
    // An explicit `kb` (named knowledge base) lets an ingest agent and a query agent SHARE
    // a store; otherwise the KB is scoped to the running agent's id.
    const agentId = String(input["kb"] ?? input["_agentId"] ?? input["agentId"] ?? "default");
    const text = resolveText(input, call.nodeId);
    const source = String(input["source"] ?? input[`${call.nodeId}.source`] ?? "ingested");
    if (!text) return { output: { ok: false, error: "no text to ingest (set 'text' or provide a *.body)" }, claimedCostCents: 0 };

    const chunks = chunk(text);
    if (chunks.length === 0) return { output: { ok: false, error: "text produced no chunks" }, claimedCostCents: 0 };

    const { client, model } = getEmbeddingsClient();
    let vectors: number[][];
    try {
      ({ vectors } = await client.embed(chunks, model));
    } catch (e) {
      log.warn({ nodeId: call.nodeId, err: (e as Error).message }, "rag.ingest: embedding failed");
      return { output: { ok: false, error: `embedding failed: ${(e as Error).message}` }, claimedCostCents: 1 };
    }

    const store = loadStore(agentId);
    const base = store.length;
    chunks.forEach((c, i) => store.push({ id: `${source}#${base + i}`, text: c, source, vector: vectors[i]! }));
    saveStore(agentId, store);

    log.info({ agentId, source, chunks: chunks.length, total: store.length, model }, "rag.ingest: stored chunks");
    return { output: { ok: true, ingested: chunks.length, total_chunks: store.length, source }, claimedCostCents: Math.max(1, Math.ceil(chunks.length / 4)) };
  },
};

export const ragSearchCapability: CapabilityPlugin = {
  name: "rag.search",
  sideEffect: "read",
  estimateCents: () => 2,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;
    const agentId = String(input["kb"] ?? input["_agentId"] ?? input["agentId"] ?? "default");
    const query = String(input["query"] ?? input[`${call.nodeId}.query`] ?? input["question"] ?? "").trim();
    const topK = Math.min(10, Math.max(1, Number(input["top_k"]) || 4));
    if (!query) return { output: { ok: false, error: "query is required" }, claimedCostCents: 0 };

    const store = loadStore(agentId);
    if (store.length === 0) return { output: { ok: true, hits: 0, context: "", note: "knowledge base is empty — ingest documents first" }, claimedCostCents: 1 };

    const { client, model } = getEmbeddingsClient();
    let qVec: number[];
    try {
      qVec = (await client.embed([query], model)).vectors[0]!;
    } catch (e) {
      return { output: { ok: false, error: `embedding failed: ${(e as Error).message}` }, claimedCostCents: 1 };
    }

    const ranked = store
      .map((p) => ({ p, score: cosine(qVec, p.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Build a context block the next think node can ground on, with source tags for citation.
    const context = ranked.map((r, i) => `[${i + 1}] (source: ${r.p.source})\n${r.p.text}`).join("\n\n");
    const sources = [...new Set(ranked.map((r) => r.p.source))].join(", ");
    const topScore = ranked[0]?.score ?? 0;

    log.info({ agentId, query: query.slice(0, 60), hits: ranked.length, topScore: topScore.toFixed(3) }, "rag.search: retrieved");
    return {
      output: {
        ok: true,
        hits: ranked.length,
        // String, not number: the ledger canonicalizer rejects non-integer numbers.
        top_score: topScore.toFixed(4),
        sources,
        // Expose the retrieved context as a *.body so a downstream think node picks it up
        // as DATA TO ANALYZE (think already surfaces *.body), plus a plain key.
        body: context,
        context,
      },
      claimedCostCents: 2,
    };
  },
};
