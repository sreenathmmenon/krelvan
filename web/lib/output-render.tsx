/**
 * The universal agent-output renderer — the product's most-seen surface.
 *
 * A customer must NEVER see raw markdown syntax (##, [text](url), ###, **). This turns an
 * agent's body into a clean, designed result:
 *
 *   • A LINK LIST (search results, "top N", research digests) → real result cards: ranked
 *     number, headline as a plain link, the source domain, and a readable snippet. No markdown.
 *   • Anything else (a report, an answer, an email draft) → clean prose blocks with proper
 *     spacing and hierarchy, with every markdown marker stripped to its plain text.
 *
 * It is purely presentational and dependency-free, so the same look holds in the Inbox card,
 * the output page, and a shared public link.
 */
import { Fragment, type ReactNode } from "react";

// ── Plain-text sanitiser: strip every markdown marker so nothing developer-y ever shows ──────
export function toPlainText(md: string): string {
  return (md ?? "")
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```[a-z]*\n?/gi, "").trim()) // code fences → contents
    .replace(/`([^`]+)`/g, "$1")                       // inline code
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")       // [text](url) / ![alt](url) → text
    // A TRUNCATED markdown link at the end ("… [some text](https:/…") — keep the label, drop the
    // dangling "(half-url" so a cut-off snippet never shows raw link syntax.
    .replace(/\[([^\]]*)\]\(\S*$/g, "$1")
    .replace(/#{1,6}\s+/g, "")                          // headings (anywhere, not just line start)
    .replace(/^\s*>\s?/gm, "")                          // blockquotes
    .replace(/\*\*([^*]+)\*\*/g, "$1")                  // bold
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")          // italic *
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")              // italic/underscore
    .replace(/^\s*[-*+]\s+/gm, "")                      // list bullets
    .replace(/^\s*\d+[.)]\s+/gm, "")                    // list numbers
    .replace(/\s*\[[^\]]*$/g, "")                       // dangling "[unterminated" at the very end
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface LinkItem { title: string; url: string; snippet: string; }

// ── Parse a "results list" body into structured items (title / url / snippet) ────────────────
// Recognises the shape web_search emits and similar "numbered link + snippet" answers, WITHOUT
// relying on it being markdown. Returns null when the body isn't a link list (→ prose fallback).
export function parseLinkList(body: string): { heading: string | null; items: LinkItem[] } | null {
  const text = body.replace(/\r\n/g, "\n");
  // Heading: a leading "## Foo" or "Foo" on its own first line before the first item.
  let heading: string | null = null;
  const headingMatch = text.match(/^\s*#{0,6}\s*(.+?)\s*\n/);
  if (headingMatch && /top\s+\d+|results|news|digest|sources|links/i.test(headingMatch[1] ?? "")) {
    heading = toPlainText(headingMatch[1] ?? "").trim() || null;
  }

  const items: LinkItem[] = [];
  // Primary: markdown link items — "1. [Title](url)\n   snippet"
  const mdItem = /(?:^|\n)\s*(?:\d+[.)]\s*)?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)([^\n]*(?:\n(?!\s*(?:\d+[.)]\s*)?\[)[^\n]*)*)?/g;
  let m: RegExpExecArray | null;
  while ((m = mdItem.exec(text)) !== null) {
    const title = toPlainText(m[1] ?? "").trim();
    const url = (m[2] ?? "").trim();
    const snippet = toPlainText(m[3] ?? "").trim();
    if (title && url) items.push({ title, url, snippet });
  }
  // Fallback: bare "[n] Title\nURL\nsnippet" blocks (the raw findings shape) — still render as cards.
  if (items.length === 0) {
    const blocks = text.split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
      const urlLineIdx = lines.findIndex((l) => /^https?:\/\/\S+$/.test(l));
      if (urlLineIdx > 0) {
        const title = toPlainText(lines.slice(0, urlLineIdx).join(" ").replace(/^\[?\d+\]?[.)]?\s*/, "")).trim();
        const url = lines[urlLineIdx]!;
        const snippet = toPlainText(lines.slice(urlLineIdx + 1).join(" ")).trim();
        if (title) items.push({ title, url, snippet });
      }
    }
  }
  if (items.length < 2) return null; // not a list → let prose renderer handle it
  return { heading, items };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ── Result cards ─────────────────────────────────────────────────────────────────────────────
function LinkListView({ items }: { items: LinkItem[] }): ReactNode {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
      {items.map((it, i) => {
        const host = hostOf(it.url);
        return (
          <li key={i} style={{
            display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--s3)",
            padding: "var(--s4)", border: "1px solid var(--line)", borderRadius: "var(--r)",
            background: "var(--surface)", alignItems: "start",
          }}>
            <span aria-hidden style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 999, flexShrink: 0,
              background: "var(--brand-tint)", color: "var(--brand)", fontWeight: 700, fontSize: "0.85rem",
            }}>{i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <a href={it.url} target="_blank" rel="noopener noreferrer nofollow ugc"
                 style={{ color: "var(--ink)", fontWeight: 600, fontSize: "1.02rem", lineHeight: 1.35, textDecoration: "none", display: "inline-block" }}>
                {it.title}
              </a>
              {host && (
                <div className="small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "3px 0 0", color: "var(--brand)" }}>
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: "var(--brand)", display: "inline-block" }} />
                  {host}
                </div>
              )}
              {toPlainText(it.snippet) && (
                <p style={{ margin: "6px 0 0", color: "var(--ink-soft)", lineHeight: 1.6, fontSize: "0.95rem" }}>{toPlainText(it.snippet)}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Prose (non-list) fallback: clean paragraphs, markdown STRIPPED to plain text ─────────────
function ProseView({ body }: { body: string }): ReactNode {
  const paras = toPlainText(body).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
      {paras.map((p, i) => (
        <p key={i} style={{ margin: 0, lineHeight: 1.75, color: "var(--ink-soft)", whiteSpace: "pre-wrap" }}>{p}</p>
      ))}
    </div>
  );
}

/**
 * Render an agent output body as a clean, designed result. `heading` (the artifact title) lets
 * us drop a redundant leading heading line from the body so it isn't shown twice.
 */
export function OutputBody({ body, heading }: { body: string; heading?: string }): ReactNode {
  const list = parseLinkList(body);
  if (list) return <LinkListView items={list.items} />;
  // Prose: strip a leading line that just repeats the title, then render clean paragraphs.
  let b = body;
  if (heading) {
    const firstLine = toPlainText(b.split("\n").find((l) => l.trim()) ?? "").trim();
    if (firstLine && firstLine.toLowerCase() === heading.trim().toLowerCase()) {
      b = b.replace(/^[^\n]*\n/, "");
    }
  }
  return <ProseView body={b} />;
}

// A one-line, plain-text preview for Inbox cards (no markdown, no URLs dumped).
export function previewText(body: string, max = 200): string {
  const list = parseLinkList(body);
  if (list) {
    const names = list.items.slice(0, 3).map((i) => i.title).join(" · ");
    const more = list.items.length > 3 ? ` +${list.items.length - 3} more` : "";
    return (names + more).slice(0, max);
  }
  const plain = toPlainText(body).replace(/\n+/g, " ");
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}
