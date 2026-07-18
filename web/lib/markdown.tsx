/**
 * A tiny, dependency-free, SAFE markdown renderer for artifact bodies.
 *
 * It renders to React NODES — it never builds an HTML string and never uses
 * dangerouslySetInnerHTML, so there is no HTML-injection surface: any raw HTML in the
 * source is shown as literal text, and link hrefs are restricted to safe schemes. This
 * keeps the `web/` app zero-markdown-dep and the shared design tokens the single source of
 * truth. It covers the common subset our agents actually emit: headings, bold/italic/inline
 * code, links, ordered/unordered lists, blockquotes, fenced code blocks, and paragraphs.
 */
import { Fragment, type ReactNode } from "react";

// Only these link schemes are allowed; everything else (javascript:, data:, …) is dropped.
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:|\/)/i.test(u)) return u;
  return null;
}

// Decode the HTML entities that leak into agent output (a source page's &#x27; / &amp; / &nbsp;
// survives into a snippet and would otherwise show literally to the customer). We render to React
// nodes — never innerHTML — so this decode is display-only and introduces no injection surface.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Inline: **bold**, *italic* / _italic_, `code`, [text](url). Order matters (code first). */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on the first-matching token, recursing on the remainder.
  const patterns: { re: RegExp; make: (m: RegExpExecArray, k: string) => ReactNode }[] = [
    { re: /`([^`]+)`/, make: (m, k) => <code key={k} className="mono" style={{ background: "var(--surface-sunken)", padding: "0.1em 0.35em", borderRadius: 4, fontSize: "0.9em" }}>{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/, make: (m, k) => <strong key={k}>{renderInline(m[1] ?? "", k)}</strong> },
    { re: /(?:\*([^*\n]+)\*|_([^_\n]+)_)/, make: (m, k) => <em key={k}>{renderInline(m[1] ?? m[2] ?? "", k)}</em> },
    // Label may contain one level of balanced [ ] (e.g. a title like "Foo [Top 9 in 2026]"); the
    // (?:[^\][]|\[[^\]]*\])+ subpattern allows those so the link still parses instead of showing raw.
    { re: /\[((?:[^\][]|\[[^\]]*\])+)\]\(([^)\s]+)\)/, make: (m, k) => {
      const href = safeHref(m[2] ?? "");
      const label = renderInline(m[1] ?? "", k);
      return href
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: "var(--brand)", fontWeight: 600 }}>{label}</a>
        : <Fragment key={k}>{label}</Fragment>;
    } },
  ];

  let earliest: { index: number; len: number; node: ReactNode } | null = null;
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    const m = p.re.exec(text);
    if (m && (earliest === null || m.index < earliest.index)) {
      earliest = { index: m.index, len: m[0].length, node: p.make(m, `${keyBase}-${i}`) };
    }
  }
  if (!earliest) return [decodeEntities(text)];
  if (earliest.index > 0) out.push(decodeEntities(text.slice(0, earliest.index)));
  out.push(earliest.node);
  const rest = text.slice(earliest.index + earliest.len);
  if (rest) out.push(...renderInline(rest, `${keyBase}x`));
  return out;
}

/** Block-level render → an array of React elements. */
export function renderMarkdown(md: string): ReactNode {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nk = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
      i++; // consume closing fence
      blocks.push(
        <pre key={nk()} className="mono" style={{ background: "var(--surface-sunken)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "var(--s3)", overflowX: "auto", fontSize: "0.85em", lineHeight: 1.5 }}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const cls = level <= 1 ? "h2" : level === 2 ? "h3" : "h4";
      blocks.push(<p key={nk()} className={cls} style={{ margin: "var(--s5) 0 var(--s2)" }}>{renderInline(h[2] ?? "", nk())}</p>);
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines)
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) { buf.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={nk()} style={{ borderLeft: "3px solid var(--line-strong)", paddingLeft: "var(--s3)", margin: "var(--s3) 0", color: "var(--ink-soft)" }}>
          {renderInline(buf.join(" "), nk())}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*[-*+]\s+/, "")); i++; }
      blocks.push(
        <ul key={nk()} style={{ margin: "var(--s2) 0", paddingLeft: "var(--s5)", lineHeight: 1.6 }}>
          {items.map((it, j) => <li key={j} style={{ marginBottom: "var(--s1)" }}>{renderInline(it, `${nk()}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, "")); i++; }
      blocks.push(
        <ol key={nk()} style={{ margin: "var(--s2) 0", paddingLeft: "var(--s5)", lineHeight: 1.6 }}>
          {items.map((it, j) => <li key={j} style={{ marginBottom: "var(--s1)" }}>{renderInline(it, `${nk()}-${j}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === "") { i++; continue; }

    // Paragraph (consume consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(```|#{1,6}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)
    ) { para.push(lines[i]!); i++; }
    blocks.push(
      <p key={nk()} style={{ margin: "0 0 var(--s3)", lineHeight: 1.7, color: "var(--ink-soft)" }}>
        {renderInline(para.join("\n"), nk()).map((n, j) => <Fragment key={j}>{n}</Fragment>)}
      </p>,
    );
  }

  return <div className="md-body">{blocks}</div>;
}
