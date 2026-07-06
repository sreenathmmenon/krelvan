"use client";
/**
 * Shared builder + graph-preview helpers used by both the landing page (/) and the
 * dashboard (/dashboard). The NL builder behavior (buildAgent, BuildPreviewModal,
 * EXAMPLES, the mini graphs and the agent card) lives here so both surfaces reuse
 * the exact same data/API logic instead of duplicating it.
 */
import { useState, useEffect, useRef, Fragment } from "react";
import {
  deleteAgent, explainBuild, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult, type ManifestNode, type ManifestEdge,
} from "../lib/api";
import { edgeGeometry, type Box } from "../lib/graph-edges";
import { glyphFor } from "../lib/glyphs";

// Chips span Krelvan's real range — a scheduled watcher, a grounded support bot, a
// personal advisor, and a research digest — so the box doesn't read as research-only.
export const EXAMPLES: { text: string; label: string; hero?: boolean }[] = [
  {
    text: "Watch this product page and alert me the moment the price drops",
    label: "Price watcher",
    hero: true,
  },
  {
    text: "Answer customer questions using only my ingested docs, cite the source, and refuse if the answer isn't there",
    label: "Support bot",
  },
  {
    text: "Be my honest advisor: weigh this decision against my goals and principles, and remember what I learn",
    label: "Personal advisor",
  },
  {
    text: "Search the web for the latest AI news and summarise the top 3 developments in a clear digest",
    label: "Research digest",
  },
];

export const BUILD_STAGES = ["Proposing graph…", "Validating…", "Finalising agent…"];

// ── Agent-card flow strip ─────────────────────────────────────────────────────
// A dense 12-node graph crammed into a 90px card thumbnail renders as an illegible
// grey smear. For the CARD we instead show a clean horizontal "flow" — each step's
// primary-capability glyph in a chip, arrow-separated, wrapping to at most 2 rows,
// with a trailing "+N" when there are more steps than fit. It reads instantly at
// card size and communicates the agent's shape; the full graph lives on the canvas.
export function AgentCardFlow({ nodes }: { nodes: ManifestNode[] }) {
  if (nodes.length === 0) return null;
  const MAX = 7;
  const shown = nodes.slice(0, MAX);
  const extra = nodes.length - shown.length;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, rowGap: 6 }}>
      {shown.map((n, i) => {
        const cap = n.capabilities[0]?.name ?? "";
        return (
          <Fragment key={n.id}>
            <span title={`${n.id}${cap ? " · " + cap : ""}`} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "3px 7px", borderRadius: "var(--r-pill)",
              background: "var(--surface)", border: "1px solid var(--line)",
              fontSize: 10.5, color: "var(--ink-soft)", whiteSpace: "nowrap", maxWidth: 96, overflow: "hidden",
            }}>
              <svg viewBox="0 0 16 16" width={11} height={11} fill="none" aria-hidden="true" style={{ display: "block", color: "var(--brand)", flexShrink: 0 }}>
                <path d={glyphFor(cap)} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{n.id.replace(/[_-]+/g, " ")}</span>
            </span>
            {i < shown.length - 1 && <span aria-hidden="true" style={{ color: "var(--ink-muted)", fontSize: 11 }}>→</span>}
          </Fragment>
        );
      })}
      {extra > 0 && <span style={{ fontSize: 10.5, color: "var(--ink-muted)", fontWeight: 600 }}>+{extra}</span>}
    </div>
  );
}

// ── Mini graph preview ────────────────────────────────────────────────────────

interface MiniNodePos { x: number; y: number; }

const MNW = 104;
const MNH = 30;
const MHG = 34;
const MVG = 20;

function miniLayout(nodes: ManifestNode[], edges: ManifestEdge[], entry: string): Map<string, MiniNodePos> {
  const layer = new Map<string, number>();

  // CYCLE-SAFE longest-path layering. Evaluator-optimizer manifests have back-edges
  // (judge -> answer -> judge), so the naive "deeper path => revisit" walk recurses forever
  // ("Maximum call stack size exceeded") and crashes the agent card. Guard with a per-path set
  // (do not descend through a node already on the current path) + a hard depth cap.
  const maxDepth = nodes.length;
  function visit(id: string, depth: number, inPath: Set<string>) {
    if (depth > maxDepth) return;
    // Cycle re-entry must not deepen the node (see agents/[id] layoutNodes): otherwise a
    // retry loop inflates its target past the judge and the loop renders backwards.
    if (inPath.has(id)) return;
    const prev = layer.get(id);
    if (prev === undefined || prev < depth) layer.set(id, depth);
    inPath.add(id);
    for (const e of edges) if (e.from === id) visit(e.to, depth + 1, inPath);
    inPath.delete(id);
  }
  visit(entry, 0, new Set<string>());
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }

  const positions = new Map<string, MiniNodePos>();
  const maxLayer = Math.max(0, ...[...layer.values()]);
  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) ?? [];
    col.forEach((id, rowIdx) => {
      positions.set(id, { x: l * (MNW + MHG), y: rowIdx * (MNH + MVG) });
    });
  }
  return positions;
}

export function MiniGraph({ nodes, edges, entry, variant = "light", maxHeight = 70 }: { nodes: ManifestNode[]; edges: ManifestEdge[]; entry: string; variant?: "light" | "dark"; maxHeight?: number }) {
  if (nodes.length === 0) return null;
  const positions = miniLayout(nodes, edges, entry);

  let maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + MNW);
    maxY = Math.max(maxY, p.y + MNH);
  }
  const dark = variant === "dark";
  const nodeFill = dark ? "var(--dark-node-fill)" : "var(--surface)";
  const lineColor = dark ? "var(--dark-line)" : "var(--line-strong)";
  const entryStroke = dark ? "var(--dark-brand-bright)" : "var(--brand)";
  const arrowId = dark ? "mg-arrow-dark" : "mg-arrow";

  // Back-edges (retry loops) arc through a lane above/below the rows — extend the
  // viewBox so the arc isn't clipped.
  const boxes: Box[] = [...positions.values()].map(p => ({ x: p.x, y: p.y, w: MNW, h: MNH }));
  const geoms = edges.map(e => {
    const fp = positions.get(e.from);
    const tp = positions.get(e.to);
    if (!fp || !tp) return null;
    return { when: e.when, g: edgeGeometry({ x: fp.x, y: fp.y, w: MNW, h: MNH }, { x: tp.x, y: tp.y, w: MNW, h: MNH }, boxes, 14) };
  });
  let top = 0, bottom = Math.max(maxY + MVG, 50);
  for (const it of geoms) {
    if (it?.g.laneY == null) continue;
    if (it.g.side === "above") top = Math.min(top, it.g.laneY - 4);
    if (it.g.side === "below") bottom = Math.max(bottom, it.g.laneY + 4);
  }
  const vw = maxX + MHG;
  const vh = bottom - top;

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 ${top} ${vw} ${vh}`}
        width="100%"
        style={{ display: "block", maxHeight, overflow: "visible" }}
        aria-hidden
      >
        <defs>
          <marker id={arrowId} markerWidth="5" markerHeight="5" refX="4" refY="2" orient="auto">
            <path d="M0,0 L0,4 L5,2 z" fill={lineColor} />
          </marker>
          <marker id={`${arrowId}-loop`} markerWidth="5" markerHeight="5" refX="4" refY="2" orient="auto">
            <path d="M0,0 L0,4 L5,2 z" fill={entryStroke} fillOpacity={0.75} />
          </marker>
        </defs>
        {geoms.map((it, i) => {
          if (!it) return null;
          const { when, g } = it;
          return (
            <g key={i}>
              <path d={g.d}
                fill="none"
                stroke={g.back ? entryStroke : lineColor}
                strokeOpacity={g.back ? 0.6 : 1}
                strokeWidth={1.4}
                strokeDasharray={g.back ? "4 3" : undefined}
                markerEnd={`url(#${arrowId}${g.back ? "-loop" : ""})`} />
              {/* conditional edge: a quiet decision dot at the source end */}
              {when && (
                <circle cx={g.sx} cy={g.sy} r={2} fill={nodeFill} stroke={g.back ? entryStroke : lineColor} strokeWidth={1.2} />
              )}
            </g>
          );
        })}
        {nodes.map(n => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isEntry = n.id === entry;
          const caps = n.capabilities;
          const dotColor = caps.some(c => c.name === "think") ? (dark ? "var(--dark-brand-bright)" : "var(--brand)")
            : caps.some(c => c.name === "remember" || c.name === "recall") ? "var(--ok)"
            : (dark ? "var(--dark-ink-muted)" : "var(--ink-muted)");
          // a short, human label inside the node so even a 1-node graph reads as a real
          // step (not an anonymous grey dot): the primary capability or the node role.
          const primaryCap = caps[0]?.name?.replace(/^[a-z]+\./, "") ?? "";
          const label = (primaryCap || n.role || n.id).slice(0, 14);
          const labelColor = dark ? "var(--dark-ink-soft)" : "var(--ink-soft)";
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              {/* Clean single-stroke node — no heavy double ring (which read as a stray
                  'selected' lasso on a one-node preview). The entry is marked by a quiet
                  teal left accent bar, not a thick full border. */}
              <rect width={MNW} height={MNH} rx={8}
                fill={nodeFill}
                stroke={lineColor}
                strokeWidth={1.4}
              />
              {isEntry && <rect width={3} height={MNH} rx={1.5} fill={entryStroke} />}
              <circle cx={14} cy={MNH / 2} r={3} fill={dotColor} opacity={dark ? 0.95 : 0.75} />
              <text x={25} y={MNH / 2} dominantBaseline="central" fontSize={11} fill={labelColor} fontFamily="var(--font-mono)">{label}</text>
            </g>
          );
        })}
      </svg>
      {/* node count overlay — only when there are multiple nodes (a "1 node" pill reads as filler) */}
      {nodes.length > 1 && (
        <div className="mono" style={{
          position: "absolute", bottom: "var(--s1)", right: "var(--s1)",
          fontSize: 11, color: dark ? "var(--dark-ink-muted)" : "var(--ink-muted)",
          background: dark ? "rgba(255,255,255,0.06)" : "var(--surface-sunken)",
          padding: "var(--s1)", borderRadius: "var(--r-sm)",
        }}>
          {nodes.length} nodes
        </div>
      )}
    </div>
  );
}

// ── Build preview modal ───────────────────────────────────────────────────────

const MFN_W = 140;
const MFN_H = 64;
const MFH_G = 64;
const MFV_G = 44;

// ── Capability glyphs (teal geometric SVG — no emoji; matches the hero glyph
// style on page.tsx). Each glyph is authored on a 16×16 grid; drawn centered on
// (cx, cy) at scale via a translate to (cx-8, cy-8). Stroke uses --brand; falls
// back to a neutral square for unknown capabilities. ──────────────────────────
function capGlyphPaths(name: string): React.ReactNode {
  switch (name) {
    case "think": // brain/reason — concentric ring + spark
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <circle cx="8" cy="8" r="1.7" fill="var(--brand)" />
        </>
      );
    case "recall": // book outline
      return (
        <>
          <path d="M2.5 3.2h4.2c.7 0 1.3.6 1.3 1.3v8.3c0-.7-.6-1.3-1.3-1.3H2.5V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M13.5 3.2H9.3c-.7 0-1.3.6-1.3 1.3v8.3c0-.7.6-1.3 1.3-1.3h4.2V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "remember": // disk/save
      return (
        <>
          <path d="M3 3h7.5L13 5.5V13H3V3z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <rect x="5.5" y="3" width="5" height="3" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
          <rect x="5" y="8.5" width="6" height="3.5" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "llm_route": // branch/route — split arrows
      return (
        <>
          <path d="M3 8h3.5M9.5 4.5L12.5 4.5M9.5 11.5L12.5 11.5M6.5 8c1.2 0 1.6-3.5 3-3.5M6.5 8c1.2 0 1.6 3.5 3 3.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M11 3l1.8 1.5L11 6M11 10l1.8 1.5L11 13" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "web_search": // magnifying glass
      return (
        <>
          <circle cx="7" cy="7" r="4" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <path d="M10 10l3.2 3.2" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "compose": // pen/write
      return (
        <>
          <path d="M3 13l1-3 6.5-6.5 2 2L6 12l-3 1z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M10 4.5l1.5-1.5 2 2L12 6.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "http_get":
    case "http_post": // globe
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M2.8 8h10.4M8 2.8c1.6 1.4 2.4 3.3 2.4 5.2S9.6 12.8 8 13.2C6.4 12.8 5.6 10.9 5.6 8S6.4 4.2 8 2.8z" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "telegram_send":
    case "email_send": // envelope / send
      return (
        <>
          <rect x="2.5" y="4" width="11" height="8" rx="1" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M3 4.8l5 4 5-4" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "slack_send": // chat bubble
      return (
        <>
          <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3v-6z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "notify_webhook": // bell
      return (
        <>
          <path d="M8 2.6c2 0 3.3 1.5 3.3 3.4v2.4l1.2 1.8H3.5l1.2-1.8V6c0-1.9 1.3-3.4 3.3-3.4z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M6.6 12.2c.2.8.8 1.2 1.4 1.2s1.2-.4 1.4-1.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    default: // unknown capability — neutral gear-ish square
      return (
        <>
          <rect x="3.5" y="3.5" width="9" height="9" rx="2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="1.6" fill="var(--brand)" />
        </>
      );
  }
}

// Capability names covered by the hand-drawn vocabulary above; anything else
// (rag.search, delegate, …) falls back to the marketplace glyph set (lib/glyphs.ts)
// so unknown capabilities never collapse to an anonymous square.
const KNOWN_CAP_GLYPHS = new Set([
  "think", "recall", "remember", "llm_route", "web_search", "compose",
  "http_get", "http_post", "telegram_send", "email_send", "slack_send", "notify_webhook",
]);

function CapGlyph({ name, cx, cy }: { name: string; cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx - 8},${cy - 8})`} opacity={0.85}>
      {KNOWN_CAP_GLYPHS.has(name)
        ? capGlyphPaths(name)
        : <path d={glyphFor(name)} stroke="var(--brand)" strokeWidth={1.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </g>
  );
}

function FullMiniGraph({ nodes, edges, entry }: { nodes: ManifestNode[]; edges: ManifestEdge[]; entry: string }) {
  const positions = miniLayout(nodes.map(n => ({ ...n })), edges, entry);

  // Scale the mini layout up to full-preview node dimensions FIRST, then measure —
  // measuring the unscaled x with a different factor used to under-size the viewBox
  // and clip the last column.
  const scaledPositions = new Map<string, MiniNodePos>();
  for (const [id, p] of positions.entries()) {
    scaledPositions.set(id, {
      x: p.x * (MFN_W + MFH_G) / (MNW + MHG),
      y: p.y * (MFN_H + MFV_G) / (MNH + MVG),
    });
  }

  let maxX = 0, maxY = 0;
  for (const p of scaledPositions.values()) {
    maxX = Math.max(maxX, p.x + MFN_W);
    maxY = Math.max(maxY, p.y + MFN_H);
  }

  // Edge geometry — back-edges (retry loops) arc through a lane above/below the rows.
  const boxes: Box[] = [...scaledPositions.values()].map(p => ({ x: p.x, y: p.y, w: MFN_W, h: MFN_H }));
  const geoms = edges.map(e => {
    const fp = scaledPositions.get(e.from);
    const tp = scaledPositions.get(e.to);
    if (!fp || !tp) return null;
    return { when: e.when, g: edgeGeometry({ x: fp.x, y: fp.y, w: MFN_W, h: MFN_H }, { x: tp.x, y: tp.y, w: MFN_W, h: MFN_H }, boxes, 24) };
  });
  let top = 0, bottom = Math.max(maxY + MFV_G, 100);
  for (const it of geoms) {
    if (it?.g.laneY == null) continue;
    if (it.g.side === "above") top = Math.min(top, it.g.laneY - 6);
    if (it.g.side === "below") bottom = Math.max(bottom, it.g.laneY + 6);
  }
  const vw = maxX + MFH_G;
  const vh = bottom - top;

  return (
    <svg viewBox={`0 ${top} ${vw} ${vh}`} width="100%" style={{ display: "block", maxHeight: 220 }} aria-hidden>
      <defs>
        <marker id="fp-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="var(--ink-muted)" />
        </marker>
        <marker id="fp-arrow-loop" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="var(--brand)" fillOpacity={0.75} />
        </marker>
      </defs>
      {geoms.map((it, i) => {
        if (!it) return null;
        const { when, g } = it;
        return (
          <g key={i}>
            <path d={g.d}
              fill="none"
              stroke={g.back ? "var(--brand)" : "var(--line-strong)"}
              strokeOpacity={g.back ? 0.6 : 1}
              strokeWidth={1.5}
              strokeDasharray={g.back ? "5 4" : undefined}
              markerEnd={g.back ? "url(#fp-arrow-loop)" : "url(#fp-arrow)"} />
            {/* conditional edge: a quiet decision dot at the source end */}
            {when && (
              <circle cx={g.sx} cy={g.sy} r={2.5} fill="var(--surface)" stroke={g.back ? "var(--brand)" : "var(--ink-muted)"} strokeWidth={1.2} />
            )}
          </g>
        );
      })}
      {nodes.map(n => {
        const p = scaledPositions.get(n.id);
        if (!p) return null;
        const isEntry = n.id === entry;
        // up to two leading capability glyphs, centered in the node body
        const glyphCaps = n.capabilities.slice(0, 2);
        const glyphGap = 22;
        const glyphStartX = MFN_W / 2 - ((glyphCaps.length - 1) * glyphGap) / 2;
        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`}>
            <rect width={MFN_W} height={MFN_H} rx={8}
              fill="var(--surface)"
              stroke={isEntry ? "var(--brand)" : "var(--line-strong)"}
              strokeWidth={isEntry ? 2 : 1.5}
            />
            {isEntry && <rect width={MFN_W} height={4} rx={2} fill="var(--brand)" />}
            <text x={MFN_W / 2} y={22} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink)" fontFamily="var(--font-sans)">
              {n.id.length > 14 ? n.id.slice(0, 13) + "…" : n.id}
            </text>
            {glyphCaps.length > 0 ? (
              glyphCaps.map((c, gi) => (
                <CapGlyph key={c.name} name={c.name} cx={glyphStartX + gi * glyphGap} cy={36} />
              ))
            ) : (
              <circle cx={MFN_W / 2} cy={36} r={3} stroke="var(--ink-muted)" strokeWidth={1.2} fill="none" />
            )}
            <text x={MFN_W / 2} y={54} textAnchor="middle" fontSize={8.5} fill="var(--brand)" fontFamily="var(--font-mono)">
              {(() => {
                const line = n.capabilities.map(c => c.name).join(" · ");
                return line.length > 26 ? line.slice(0, 25) + "…" : line;
              })()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function BuildPreviewModal({ result, onRun, onDiscard }: { result: BuildResult; onRun: () => void; onDiscard: () => void }) {
  const { agent, graph, attempts, warnings } = result;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [rationaleLoading, setRationaleLoading] = useState(true);

  useEffect(() => {
    setRationaleLoading(true);
    void explainBuild(agent.id)
      .then(r => setRationale(r.rationale))
      .catch(() => setRationale(null))
      .finally(() => setRationaleLoading(false));
  }, [agent.id]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onDiscard();
      if (e.key === "Tab") {
        const focusable = Array.from(
          document.getElementById("build-preview-dialog")?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          ) ?? []
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDiscard]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(17,32,31,.42)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--s6)",
      }}
      onClick={e => { if (e.target === e.currentTarget) onDiscard(); }}
    >
      <div
        id="build-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-preview-title"
        className="card"
        style={{ maxWidth: 680, width: "100%", padding: "var(--s6)", animation: "fade-in 150ms ease forwards" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s5)" }}>
          <div>
            <h2 id="build-preview-title" className="h2" style={{ marginBottom: "var(--s1)" }}>
              Agent compiled — review before running
            </h2>
            <p className="soft small">
              {agent.signed.manifest.name} · <span className="mono">{graph.nodes.length}</span> node{graph.nodes.length !== 1 ? "s" : ""} · <span className="mono">{graph.edges.length}</span> edge{graph.edges.length !== 1 ? "s" : ""}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onDiscard}
            aria-label="Close"
            className="btn btn-ghost btn-sm"
            style={{
              color: "var(--ink-muted)", fontSize: 20, lineHeight: 1,
              width: 30, padding: 0, flexShrink: 0,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>

        {attempts > 1 && (
          <div className="small" style={{ marginBottom: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--info-tint)", borderRadius: "var(--r)", color: "var(--info)" }}>
            Self-corrected: succeeded on attempt <span className="mono">{attempts}</span> of <span className="mono">3</span>
          </div>
        )}

        {warnings.map((w, i) => (
          <div key={i} className="small" style={{ marginBottom: "var(--s3)", padding: "var(--s3) var(--s4)", background: "var(--brand-tint)", borderRadius: "var(--r)", color: "var(--brand)" }}>
            {w}
          </div>
        ))}

        <div
          style={{
            background: "linear-gradient(180deg, var(--surface) 0%, var(--graph-bg) 100%)",
            border: "1px solid var(--line)", borderRadius: "var(--r)",
            padding: "var(--s4)", marginBottom: "var(--s4)", overflow: "auto",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div className="micro" style={{ marginBottom: "var(--s3)" }}>Compiled graph</div>
          <FullMiniGraph nodes={graph.nodes} edges={graph.edges} entry={graph.entry} />
        </div>

        {/* architect's rationale — why this graph */}
        <div style={{
          marginBottom: "var(--s5)", padding: "var(--s4)",
          background: "var(--brand-tint)", borderRadius: "var(--r)",
          border: "1px solid var(--line)",
          minHeight: 52, display: "flex", alignItems: "flex-start", gap: "var(--s3)",
        }}>
          <span aria-hidden="true" style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2 }}><SparkMark size={16} /></span>
          {rationaleLoading ? (
            <span className="small" style={{ color: "var(--brand)", fontStyle: "italic" }}>Understanding the design…</span>
          ) : rationale ? (
            <p className="small" style={{ color: "var(--ink)", lineHeight: 1.65, margin: 0 }}>{rationale}</p>
          ) : null}
        </div>

        {/* divider + lifted node-details panel — clear hierarchy below the graph */}
        <div className="divider" style={{ margin: "var(--s5) 0" }} />
        <div
          style={{
            marginBottom: "var(--s5)", padding: "var(--s4)",
            background: "var(--surface)", border: "1px solid var(--line)",
            borderRadius: "var(--r)", boxShadow: "var(--shadow-sm)",
          }}
        >
          <div className="micro" style={{ marginBottom: "var(--s3)" }}>
            Node details · <span className="mono">{graph.nodes.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          {graph.nodes.map(n => (
            <div key={n.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--s2) var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0 }}>
                <span className="small" style={{ fontWeight: 600, color: "var(--ink)", flexShrink: 0 }}>{n.id}</span>
                {n.id === graph.entry && <span className="micro" style={{ padding: "var(--s1)", background: "var(--brand-tint)", color: "var(--brand)", borderRadius: "var(--r-pill)", flexShrink: 0 }}>entry</span>}
                <span className="small" style={{ color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.role.slice(0, 60)}{n.role.length > 60 ? "…" : ""}</span>
              </div>
              <div style={{ display: "flex", gap: "var(--s1)", flexWrap: "wrap", flexShrink: 0, marginLeft: "var(--s3)" }}>
                {n.capabilities.map(c => (
                  <span key={c.name} className="mono" style={{ fontSize: 11, padding: "var(--s1)", background: "var(--brand-tint)", color: "var(--brand)", borderRadius: "var(--r-pill)" }}>{c.name}</span>
                ))}
              </div>
            </div>
          ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end", alignItems: "center" }}>
          <button className="btn btn-secondary" onClick={onDiscard}>Discard</button>
          <button className="btn btn-primary btn-lg" onClick={onRun}>
            Run now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

export function AgentCard({ agent, agentRuns, onRun, onDelete, summary }: {
  agent: AgentRecord;
  agentRuns: RunRecord[];
  onRun: () => void;
  onDelete: () => void;
  summary?: string | null;
}) {
  const lastRun = agentRuns[0];
  const runningCount = agentRuns.filter(r => r.status === "running").length;
  const status = runningCount > 0 ? "running" : lastRun?.status ?? "idle";
  const nodes = agent.signed.manifest.nodes ?? [];
  const edges = agent.signed.manifest.edges ?? [];
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleRunClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmRun) {
      setConfirmRun(true);
      confirmTimerRef.current = setTimeout(() => setConfirmRun(false), 3000);
    } else {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmRun(false);
      onRun();
    }
  }

  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
    } else {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setConfirmDelete(false);
      setDeleting(true);
      deleteAgent(agent.id).then(onDelete).catch(() => setDeleting(false));
    }
  }

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  return (
    <a href={`/agents/${agent.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div
        className="card card-hover"
        style={{ padding: "var(--s5)", minHeight: 200, display: "flex", flexDirection: "column", gap: "var(--s4)", cursor: "pointer" }}
      >
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}>
          <span className="h3" title={agent.signed.manifest.name} style={{
            color: "var(--ink)", flex: 1, minWidth: 0,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            overflow: "hidden", lineHeight: 1.25,
          }}>
            {agent.signed.manifest.name}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexShrink: 0 }}>
            <a
              href={`/canvas/${agent.id}`}
              onClick={e => e.stopPropagation()}
              title="Open canvas"
              style={{ fontSize: 11, color: "var(--brand)", fontWeight: 600, padding: "var(--s1) var(--s2)", background: "var(--brand-tint)", borderRadius: "var(--r-pill)", textDecoration: "none", lineHeight: 1.6 }}
            >
              Canvas ↗
            </a>
            <span className={`badge badge-${status === "completed" ? "done" : status === "running" ? "running" : "neutral"}`}>
              {status === "running" && <span className="dot" />}{status}
            </span>
          </div>
        </div>

        {/* flow strip — a clean, readable capability sequence (a dense 12-node graph
            crammed into a 90px card thumbnail was an illegible grey smear). */}
        {nodes.length > 0 && (
          <div style={{
            background: "var(--graph-bg)", borderRadius: "var(--r)",
            border: "1px solid var(--line)", padding: "var(--s3)",
          }}>
            <AgentCardFlow nodes={nodes} />
          </div>
        )}

        {/* summary or intent */}
        {summary ? (
          <div style={{ flex: 1 }}>
            <p className="small" style={{ lineHeight: 1.5, color: "var(--ink-soft)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
              {summary}
            </p>
            {lastRun && (
              <a
                href={`/runs/${lastRun.runId}?tab=explain`}
                onClick={e => e.stopPropagation()}
                style={{ fontSize: 11, color: "var(--brand)", fontWeight: 500, display: "inline-block", marginTop: "var(--s1)" }}
              >
                View reasoning trace →
              </a>
            )}
          </div>
        ) : (
          <p className="small soft" style={{ lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", flex: 1 }}>
            {/* Always show real text — the agent's intent. The auto-summary, when it resolves,
                replaces it; we never sit on an indefinite "Generating…" placeholder. */}
            {summary || agent.signed.provenance.intent}
          </p>
        )}

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {lastRun && <div className="small muted">last run {timeAgo(lastRun.createdAt)}</div>}
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            <button
              onClick={handleDeleteClick}
              disabled={deleting || status === "running"}
              className={`btn btn-sm agent-card__delete${confirmDelete ? " is-confirming" : ""}`}
              style={{ minWidth: 60 }}
            >
              {deleting ? "…" : confirmDelete ? "Sure?" : "Delete"}
            </button>
            <button
              onClick={handleRunClick}
              className="btn btn-sm btn-primary"
              style={{ minWidth: 72 }}
            >
              {confirmRun ? "Confirm?" : "Run now"}
            </button>
          </div>
        </div>
      </div>
    </a>
  );
}

// ── Hero artifact: a REAL run (N events · cost), or a labelled live example ─────
// Shared by the homepage hero and the dashboard hero so both render the SAME proof
// anchor: "this is what you get after you describe a goal." A real completed run
// links to its run record; until one exists we show the pre-built example graph,
// clearly framed as a "live example" — never fabricated proof fields.
const EXAMPLE_NODES: ManifestNode[] = [
  { id: "entry", role: "intake", autonomy: "auto", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 1 }] },
  { id: "reason", role: "reason over findings", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 3 }] },
  { id: "compose", role: "write the digest", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
];
const EXAMPLE_EDGES: ManifestEdge[] = [
  { from: "entry", to: "reason" },
  { from: "reason", to: "compose" },
];

// ── Animated hero: a self-running "agent runs, each step recorded" loop ──────────
// Pure SVG + CSS keyframes (defined in globals.css, .heroanim-*), no GIF/image, no
// libs. Nodes light in sequence; as each executes, its ledger row writes in; a
// "VERIFIED" seal lands; then we rotate to the NEXT agentic use case and replay.
// Use cases are real agentic patterns (deep research, autonomous code review,
// incident triage) — not pre-agentic trigger/connector automation.
// Honoured by the global prefers-reduced-motion block (shows the final frame).
interface HeroScene {
  label: string;
  nodes: [string, string, string];
  /** index (0-2) of the node that pauses for human approval, if any. */
  gateNode?: number;
  rows: { hash: string; action: string; gate?: boolean }[];
}
const HERO_SCENES: HeroScene[] = [
  {
    label: "deep research",
    nodes: ["search", "reason", "compose"],
    rows: [
      { hash: "e7a2c", action: "agent.build" },
      { hash: "9f31d", action: "node.search" },
      { hash: "4b08a", action: "node.reason" },
      { hash: "c1e6f", action: "node.compose" },
      { hash: "2da90", action: "event.record" },
    ],
  },
  {
    label: "PR review",
    nodes: ["fetch", "analyze", "flag"],
    rows: [
      { hash: "a14d8", action: "agent.build" },
      { hash: "6b2c0", action: "node.fetch_pr" },
      { hash: "f90e3", action: "node.analyze" },
      { hash: "3c7a1", action: "node.flag_risk" },
      { hash: "88b4e", action: "event.record" },
    ],
  },
  {
    label: "incident triage",
    nodes: ["alert", "correlate", "diagnose"],
    rows: [
      { hash: "d52f9", action: "agent.build" },
      { hash: "11ace", action: "node.read_alert" },
      { hash: "7e0b6", action: "node.correlate" },
      { hash: "c44d2", action: "node.diagnose" },
      { hash: "9a18f", action: "event.record" },
    ],
  },
  {
    // The human-approval wedge: a risky step PAUSES for you before it acts.
    label: "outreach · pauses for you",
    nodes: ["draft", "approve", "send"],
    gateNode: 1,
    rows: [
      { hash: "5c1a7", action: "agent.build" },
      { hash: "b803e", action: "node.draft" },
      { hash: "f27d4", action: "await.approval", gate: true },
      { hash: "a6e9b", action: "node.send" },
      { hash: "30cf2", action: "event.record" },
    ],
  },
];

// Inline teal SVG glyphs for UI chrome — NO emoji / unicode symbols anywhere.
// Both use currentColor so the surrounding CSS `color` (teal / amber gate) still drives them.
function CheckMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SparkMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d="M8 2.5l1.4 4.1L13.5 8l-4.1 1.4L8 13.5l-1.4-4.1L2.5 8l4.1-1.4L8 2.5z"
        stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HeroAnimation() {
  const [scene, setScene] = useState(0);
  useEffect(() => {
    // each scene plays its full ~6s cycle, then we rotate.
    const t = setInterval(() => setScene(s => (s + 1) % HERO_SCENES.length), 6000);
    return () => clearInterval(t);
  }, []);
  const s = HERO_SCENES[scene]!;
  return (
    <div className="dark-device heroanim" aria-label="An agent running, each step recorded in order" role="img">
      <div className="heroanim__eyebrow">
        <span className="heroanim__live"><span className="heroanim__live-dot" />LIVE</span>
        <span className="micro">{s.label}</span>
      </div>

      {/* graph: 3 nodes, edges flow, nodes light in sequence. key on scene to replay. */}
      <div className="heroanim__graph" key={scene}>
        <svg viewBox="0 0 320 72" width="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs>
            <marker id="ha-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="var(--dark-line)" />
            </marker>
          </defs>
          <path className="heroanim__edge heroanim__edge--1" d="M86 36 C112 36, 112 36, 132 36" fill="none" stroke="var(--dark-line)" strokeWidth="2" markerEnd="url(#ha-arrow)" />
          <path className="heroanim__edge heroanim__edge--2" d="M226 36 C252 36, 252 36, 272 36" fill="none" stroke="var(--dark-line)" strokeWidth="2" markerEnd="url(#ha-arrow)" />
          {[
            { x: 16,  label: s.nodes[0], cls: "1", i: 0 },
            { x: 132, label: s.nodes[1], cls: "2", i: 1 },
            { x: 248, label: s.nodes[2], cls: "3", i: 2 },
          ].map(n => {
            const gated = s.gateNode === n.i;
            const accent = gated ? "var(--live)" : "var(--dark-brand-bright)";
            return (
            <g key={n.cls} className={`heroanim__node heroanim__node--${n.cls}${gated ? " heroanim__node--gate" : ""}`} transform={`translate(${n.x},16)`}>
              <rect width="72" height="40" rx="9" fill="var(--dark-node-fill)" stroke={gated ? accent : "var(--dark-line)"} strokeWidth="1.4" />
              <rect className="heroanim__node-bar" width="72" height="3" rx="1.5" fill={accent} />
              <circle className="heroanim__node-dot" cx="36" cy="18" r="4.5" fill={accent} />
              <text x="36" y="32" textAnchor="middle" fontSize="8" fontFamily="var(--font-mono)" fill="var(--dark-ink-soft)">{n.label}</text>
            </g>
            );
          })}
        </svg>
      </div>

      {/* run record — rows write in as the graph executes */}
      <div className="heroanim__ledger" key={`l${scene}`}>
        {s.rows.map((r, i) => (
          <div key={r.hash} className={`heroanim__row heroanim__row--${i}${r.gate ? " heroanim__row--gate" : ""}`}>
            <span className="heroanim__check" aria-hidden="true">
              {r.gate
                ? <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><rect x="1" y="1" width="2.2" height="6" rx="0.6"/><rect x="4.8" y="1" width="2.2" height="6" rx="0.6"/></svg>
                : <CheckMark size={10} />}
            </span>
            <span className="heroanim__hash">{r.hash}</span>
            <span className="heroanim__sep">::</span>
            <span className="heroanim__action">{r.action}</span>
            <span className={r.gate ? "heroanim__gate-tag" : "heroanim__cost"}>{r.gate ? "waiting on you" : "recorded"}</span>
          </div>
        ))}
      </div>

      {/* the payoff seal */}
      <div className="heroanim__seal" key={`s${scene}`}>
        <span className="heroanim__seal-mark" aria-hidden="true"><CheckMark size={11} /></span>
        <span className="heroanim__seal-text">VERIFIED</span>
        <span className="heroanim__seal-sub">run complete · replayable</span>
      </div>
    </div>
  );
}

export function HeroArtifact({ run }: { run: RunRecord | null }) {
  if (run) {
    return (
      <a
        href={`/runs/${run.runId}`}
        className="dark-device"
        style={{ display: "block", padding: "var(--s5)", textDecoration: "none" }}
        aria-label={`Open the run record for ${run.manifestName}`}
      >
        <div className="micro" style={{ marginBottom: "var(--s3)" }}>A real run · {timeAgo(run.createdAt)}</div>
        <div className="dark-surface-2" style={{ borderRadius: "var(--r)", padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          <div className="dark-ink" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em" }}>{run.manifestName}</div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
            <span className="dark-verify-seal__mark" aria-hidden="true"><CheckMark size={12} /></span>
            <span className="dark-teal mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".02em" }}>recorded</span>
            <span className="dark-ink-muted" aria-hidden="true">·</span>
            <span className="dark-ink-soft mono" style={{ fontSize: 13 }}>{run.status === "completed" ? "finished" : run.status}</span>
          </div>
          <div className="dark-ink-muted small">Every step is recorded and can be replayed.</div>
        </div>
        <div className="dark-teal mono" style={{ marginTop: "var(--s4)", fontSize: 12, fontWeight: 600 }}>Open this record →</div>
      </a>
    );
  }
  return (
    <div className="dark-device" style={{ padding: "var(--s5)" }}>
      <div className="micro" style={{ marginBottom: "var(--s3)" }}>Live example · research digest</div>
      <div className="dark-surface-2" style={{ borderRadius: "var(--r)", padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
        <div style={{ background: "var(--dark-node-fill)", borderRadius: "var(--r)", padding: "var(--s5)", border: "1px solid var(--dark-line)" }}>
          <MiniGraph nodes={EXAMPLE_NODES} edges={EXAMPLE_EDGES} entry="entry" variant="dark" maxHeight={120} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
          <span className="dark-verify-seal__mark" aria-hidden="true"><CheckMark size={12} /></span>
          <span className="dark-teal mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".02em" }}>recorded</span>
          <span className="dark-ink-muted" aria-hidden="true">·</span>
          <span className="dark-ink-soft mono" style={{ fontSize: 13 }}>3 steps</span>
        </div>
        <div className="dark-ink-muted small">Build your own below — your real runs show up here.</div>
      </div>
    </div>
  );
}
