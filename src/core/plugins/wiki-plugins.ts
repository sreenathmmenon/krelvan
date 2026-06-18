/**
 * LLM-Wiki capabilities — wiki.ingest and wiki.query (Karpathy's LLM Wiki pattern).
 *
 * Unlike RAG (which re-chunks and re-retrieves raw text on every query), an LLM-Wiki is a
 * persistent, agent-maintained knowledge base: the agent COMPILES sources into interlinked
 * markdown pages once, and answers from the compiled pages. Knowledge accumulates and is kept
 * current instead of being re-derived per question. (https://gist.github.com/karpathy/442a6bf5...)
 *
 *   - wiki.ingest (write-reversible): apply LLM-proposed entity/concept page updates to a named
 *     wiki — create/update pages under entities/ + concepts/, maintain index.md (catalog with
 *     [[wiki-links]]), append to log.md, flag contradictions. The CAPABILITY is mechanical and
 *     deterministic (so each write is a clean, signed ledger event); the SYNTHESIS — deciding
 *     which pages a source touches and what they should say — is done by an upstream think node.
 *   - wiki.query (read): read index.md, select the relevant pages, return their content as
 *     grounded context with page citations for a downstream think node to synthesize a cited
 *     answer. If nothing matches, it says so (never fabricates).
 *
 * Storage: <dataDir>/wikis/<wiki>/{index.md, log.md, entities/<name>.md, concepts/<name>.md}.
 * Node built-ins only. Pure + offline (no network, no secrets). Krelvan's twist: every page
 * write is a signed ledger event — a provable, replayable history of how the wiki evolved.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("wiki");

// ── path safety ────────────────────────────────────────────────────────────────
// Wiki and page names become directory/file names, so they MUST be constrained — no
// traversal, no separators, no absolute paths. Anything else is rejected, not sanitised
// silently, so a caller can't smuggle "../../etc" past us.
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,63}$/;

/** Normalise a human page title into a safe slug, or null if it can't be made safe. */
function slug(name: string): string | null {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s && s.length <= 64 ? s : null;
}

function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name.trim());
}

function wikisRoot(): string {
  // resolve() so the root is ABSOLUTE — KRELVAN_DATA_DIR may be relative (e.g. "./data"),
  // and the path-escape check below compares against it, so both sides must be absolute.
  const dir = resolve(process.env["KRELVAN_DATA_DIR"] ?? "./data", "wikis");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The directory for one wiki, GUARANTEED to live inside wikisRoot (defence in depth). */
function wikiDir(wiki: string): string {
  const root = wikisRoot();
  const dir = resolve(root, wiki);
  // Even with SAFE_NAME, verify the resolved path can't escape the root.
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error("invalid wiki name");
  }
  mkdirSync(join(dir, "entities"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

type PageKind = "entities" | "concepts";

function pagePath(dir: string, kind: PageKind, pageSlug: string): string {
  const p = resolve(dir, kind, `${pageSlug}.md`);
  const base = resolve(dir, kind);
  if (!p.startsWith(base + sep)) throw new Error("invalid page name");
  return p;
}

function readPage(dir: string, kind: PageKind, pageSlug: string): string | null {
  const p = pagePath(dir, kind, pageSlug);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function writePage(dir: string, kind: PageKind, pageSlug: string, content: string): void {
  writeFileSync(pagePath(dir, kind, pageSlug), content.endsWith("\n") ? content : content + "\n");
}

function appendLog(dir: string, line: string): void {
  const p = join(dir, "log.md");
  const head = existsSync(p) ? "" : "# Wiki change log\n\n";
  writeFileSync(p, (existsSync(p) ? readFileSync(p, "utf8") : head) + line + "\n");
}

/** Rebuild index.md from the pages actually on disk — a catalog with one-line summaries. */
function rebuildIndex(dir: string): { pages: number } {
  const lines: string[] = ["# Wiki index", ""];
  let count = 0;
  for (const kind of ["entities", "concepts"] as PageKind[]) {
    const sub = join(dir, kind);
    const files = existsSync(sub) ? readdirSync(sub).filter((f) => f.endsWith(".md")).sort() : [];
    if (files.length === 0) continue;
    lines.push(`## ${kind}`, "");
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      const body = readFileSync(join(sub, f), "utf8");
      // One-line summary = first non-heading, non-empty line.
      const summary = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
      lines.push(`- [[${name}]] — ${summary.slice(0, 140)}`);
      count++;
    }
    lines.push("");
  }
  writeFileSync(join(dir, "index.md"), lines.join("\n") + "\n");
  return { pages: count };
}

// ── inputs ───────────────────────────────────────────────────────────────────
// The synthesize (think) node proposes page edits. We accept them as JSON in `pages`, or
// degrade gracefully to a single page from `title`/`content` (so a simpler graph still works).

interface PageEdit {
  kind?: string;        // "entity" | "concept" (default entity)
  title: string;        // human page title; we slug it
  summary?: string;     // one-line summary (used for index + page top)
  content: string;      // the page body the LLM synthesised
  links?: string[];     // related page titles → rendered as [[wiki-links]]
  contradicts?: string; // optional note: new info conflicts with an earlier claim
}

/** Find a value at `field`, `<node>.field` for our node, or ANY `*.field` an upstream node set. */
function resolveField(input: Record<string, unknown>, nodeId: string, field: string): unknown {
  for (const k of [field, `${nodeId}.${field}`]) {
    if (input[k] !== undefined) return input[k];
  }
  for (const [k, v] of Object.entries(input)) {
    if (k.endsWith(`.${field}`) && v !== undefined) return v;
  }
  return undefined;
}

function parsePageEdits(input: Record<string, unknown>, nodeId: string): PageEdit[] {
  // Preferred: a JSON array/object of page edits (a synthesize node may emit several).
  // Accept it under `pages`/`page_edits`, our own node prefix, or any upstream node's prefix.
  for (const [k, raw] of Object.entries(input)) {
    if (!(k === "pages" || k === "page_edits" || k.endsWith(".pages") || k.endsWith(".page_edits"))) continue;
    if (raw == null) continue;
    let parsed: unknown = raw;
    if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { continue; } }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const edits = arr.filter((e): e is PageEdit =>
      !!e && typeof e === "object" && typeof (e as PageEdit).title === "string" && typeof (e as PageEdit).content === "string");
    if (edits.length) return edits;
  }
  // Degrade (the reliable path for local models): a single page from flat fields produced by
  // the upstream synthesize node — title/content/summary/kind/links anywhere in state.
  const title = resolveField(input, nodeId, "title");
  const content = resolveField(input, nodeId, "content") ?? resolveField(input, nodeId, "result");
  if (typeof title === "string" && typeof content === "string" && title.trim() && content.trim()) {
    const summary = resolveField(input, nodeId, "summary");
    const kind = resolveField(input, nodeId, "kind");
    const linksRaw = resolveField(input, nodeId, "links");
    const links = typeof linksRaw === "string" && linksRaw.trim()
      ? linksRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const contradicts = resolveField(input, nodeId, "contradicts");
    return [{
      title, content,
      summary: typeof summary === "string" ? summary : undefined,
      kind: typeof kind === "string" ? kind : undefined,
      links,
      contradicts: typeof contradicts === "string" ? contradicts : undefined,
    }];
  }
  return [];
}

function renderPage(edit: PageEdit, source: string, existing: string | null): string {
  const title = edit.title.trim();
  const summary = (edit.summary ?? "").trim();
  const links = (edit.links ?? []).map((l) => `[[${(slug(l) ?? l)}]]`).filter(Boolean);
  const parts: string[] = [`# ${title}`, ""];
  if (summary) parts.push(summary, "");
  parts.push(edit.content.trim(), "");
  if (links.length) parts.push(`**Related:** ${links.join(" · ")}`, "");
  if (edit.contradicts && edit.contradicts.trim()) {
    parts.push(`> ⚠ Contradiction: ${edit.contradicts.trim()}`, "");
  }
  // Preserve a compact provenance trail across updates (Karpathy: "kept current").
  const priorSources = existing
    ? (existing.match(/^<!-- sources: (.+) -->$/m)?.[1]?.split(",").map((s) => s.trim()) ?? [])
    : [];
  const allSources = [...new Set([...priorSources, source].filter(Boolean))];
  parts.push(`<!-- sources: ${allSources.join(", ")} -->`);
  return parts.join("\n");
}

export const wikiIngestCapability: CapabilityPlugin = {
  name: "wiki.ingest",
  sideEffect: "write-reversible",
  estimateCents: () => 2,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;
    const wiki = String(input["wiki"] ?? input["_agentId"] ?? input["agentId"] ?? "default").trim();
    const source = String(input["source"] ?? input[`${call.nodeId}.source`] ?? "source").trim() || "source";

    if (!isSafeName(wiki)) {
      return { output: { ok: false, error: "invalid wiki name (use letters, numbers, . _ - space, max 64)" }, claimedCostCents: 0 };
    }
    if (!isSafeName(source)) {
      return { output: { ok: false, error: "invalid source label" }, claimedCostCents: 0 };
    }

    const edits = parsePageEdits(input, call.nodeId);
    if (edits.length === 0) {
      // Graceful: nothing to compile (empty/whitespace source, or synthesis produced no pages).
      return { output: { ok: true, pages_touched: 0, wiki, note: "no pages to write (source produced no entities)" }, claimedCostCents: 1 };
    }

    let dir: string;
    try { dir = wikiDir(wiki); } catch (e) { log.warn({ wiki, err: (e as Error).message }, "wiki.ingest DBG wikiDir threw"); return { output: { ok: false, error: "invalid wiki name" }, claimedCostCents: 0 }; }

    const touched: string[] = [];
    const contradictions: string[] = [];
    for (const edit of edits) {
      const kind: PageKind = (String(edit.kind ?? "entity").toLowerCase().startsWith("concept")) ? "concepts" : "entities";
      const pageSlug = slug(edit.title);
      if (!pageSlug) continue; // skip un-sluggable titles rather than crash
      const existing = readPage(dir, kind, pageSlug);
      writePage(dir, kind, pageSlug, renderPage(edit, source, existing));
      touched.push(`${kind}/${pageSlug}`);
      if (edit.contradicts && edit.contradicts.trim()) contradictions.push(pageSlug);
    }

    const { pages } = rebuildIndex(dir);
    const date = new Date(Date.now()).toISOString().slice(0, 10);
    appendLog(dir, `## [${date}] ingest | ${source} → touched ${touched.length} page(s): ${touched.join(", ")}`);

    log.info({ wiki, source, touched: touched.length, total: pages }, "wiki.ingest: pages updated");
    return {
      output: {
        ok: true,
        wiki,
        pages_touched: touched.length,
        total_pages: pages,
        contradictions_flagged: contradictions.length,
        result: `Compiled "${source}" into ${touched.length} wiki page(s); the wiki now has ${pages} page(s).`,
      },
      claimedCostCents: Math.max(1, touched.length),
    };
  },
};

/** Score a page's relevance to a query by simple term overlap (offline, no embeddings). */
function relevance(query: string, pageText: string): number {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  if (terms.length === 0) return 0;
  const hay = pageText.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

export const wikiQueryCapability: CapabilityPlugin = {
  name: "wiki.query",
  sideEffect: "read",
  estimateCents: () => 1,

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    const input = call.input as Record<string, unknown>;
    const wiki = String(input["wiki"] ?? input["_agentId"] ?? input["agentId"] ?? "default").trim();
    const question = String(input["question"] ?? input[`${call.nodeId}.question`] ?? input["query"] ?? "").trim();
    const topK = Math.min(8, Math.max(1, Number(input["top_k"]) || 3));

    if (!isSafeName(wiki)) return { output: { ok: false, error: "invalid wiki name" }, claimedCostCents: 0 };
    if (!question) return { output: { ok: false, error: "question is required" }, claimedCostCents: 0 };

    let dir: string;
    try { dir = wikiDir(wiki); } catch { return { output: { ok: false, error: "invalid wiki name" }, claimedCostCents: 0 }; }

    // Read every page (the wiki is small + curated; we rank by term overlap, offline).
    const pages: { name: string; kind: PageKind; text: string }[] = [];
    for (const kind of ["entities", "concepts"] as PageKind[]) {
      const sub = join(dir, kind);
      if (!existsSync(sub)) continue;
      for (const f of readdirSync(sub).filter((f) => f.endsWith(".md"))) {
        pages.push({ name: f.replace(/\.md$/, ""), kind, text: readFileSync(join(sub, f), "utf8") });
      }
    }

    if (pages.length === 0) {
      return { output: { ok: true, hits: 0, body: "", sources: "", note: "the wiki is empty — ingest sources first" }, claimedCostCents: 1 };
    }

    const ranked = pages
      .map((p) => ({ p, score: relevance(question, p.text) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (ranked.length === 0) {
      return { output: { ok: true, hits: 0, body: "", sources: "", note: "no wiki page matches this question" }, claimedCostCents: 1 };
    }

    // Strip the provenance comment from the body shown to the model; keep the page name as the cite.
    const body = ranked
      .map((r, i) => `[${i + 1}] (page: ${r.p.name})\n${r.p.text.replace(/^<!-- sources:.*-->$/m, "").trim()}`)
      .join("\n\n");
    const sources = ranked.map((r) => r.p.name).join(", ");

    log.info({ wiki, question: question.slice(0, 60), hits: ranked.length }, "wiki.query: pages retrieved");
    return {
      output: { ok: true, hits: ranked.length, sources, body, context: body },
      claimedCostCents: 1,
    };
  },
};
