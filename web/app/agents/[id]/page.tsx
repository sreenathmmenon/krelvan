"use client";

import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import {
  getAgent, getAgentRuns, startRun, deleteAgent, listSchedules, createSchedule, toggleSchedule, deleteSchedule,
  getTrigger, mintTrigger, revokeTrigger, listApprovals,
  timeAgo,
  type AgentRecord, type RunRecord, type ScheduleRecord, type ManifestNode, type ManifestEdge, type PendingApproval,
} from "../../../lib/api";
import MemoryTab from "./MemoryTab";
import { edgeGeometry, edgeConditionLabel, type Box } from "../../../lib/graph-edges";
import { glyphFor } from "../../../lib/glyphs";

// ── Layout (shared with run detail — same Sugiyama-lite algorithm) ────────────

interface NodePos { x: number; y: number; w: number; h: number; }

const NODE_W = 160;
const NODE_H = 72;
const H_GAP  = 72;
const V_GAP  = 48;
// How far a back-edge (retry loop) lane arcs beyond the node rows.
const LOOP_CLEARANCE = 30;

function layoutNodes(
  nodes: ManifestNode[],
  edges: ManifestEdge[],
  entry: string,
): Map<string, NodePos> {
  const ids = nodes.map(n => n.id);
  const layer = new Map<string, number>();

  // CYCLE-SAFE longest-path layering. Evaluator-optimizer manifests have back-edges
  // (judge -> answer -> judge); the naive "deeper path => revisit" walk recurses forever on a
  // cycle ("Maximum call stack size exceeded") and crashes this agent page. Guard with a per-path
  // set (do not descend through a node already on the current path) + a hard depth cap.
  const maxDepth = ids.length;
  function visit(id: string, depth: number, inPath: Set<string>) {
    if (depth > maxDepth) return;
    // Cycle re-entry must not deepen the node: check the path BEFORE updating the layer,
    // or a retry loop (judge -> answer) inflates the target past its judge and the loop
    // renders backwards (the forward flow becomes the arc).
    if (inPath.has(id)) return;
    const prev = layer.get(id);
    if (prev === undefined || prev < depth) layer.set(id, depth);
    inPath.add(id);
    for (const e of edges) {
      if (e.from === id) visit(e.to, depth + 1, inPath);
    }
    inPath.delete(id);
  }
  visit(entry, 0, new Set<string>());
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0);

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }

  const maxLayer = Math.max(0, ...[...layer.values()]);
  const positions = new Map<string, NodePos>();
  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) ?? [];
    col.forEach((id, rowIdx) => {
      positions.set(id, {
        x: l * (NODE_W + H_GAP),
        y: rowIdx * (NODE_H + V_GAP),
        w: NODE_W,
        h: NODE_H,
      });
    });
  }
  return positions;
}

function canvasBounds(positions: Map<string, NodePos>) {
  let maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  return { w: maxX + H_GAP, h: maxY + V_GAP };
}

// ── Capability glyphs — teal geometric SVG, authored on a 16×16 grid, matching
// the homepage / _builder.tsx CapGlyph vocabulary. No emoji anywhere in the UI.
// `inheritColor` lets a glyph adopt the surrounding text color (e.g. inside the
// graph node) instead of always painting --brand. ─────────────────────────────
function capGlyphPaths(name: string): React.ReactNode {
  switch (name) {
    case "think":
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <circle cx="8" cy="8" r="1.7" fill="currentColor" />
        </>
      );
    case "recall":
      return (
        <>
          <path d="M2.5 3.2h4.2c.7 0 1.3.6 1.3 1.3v8.3c0-.7-.6-1.3-1.3-1.3H2.5V3.2z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M13.5 3.2H9.3c-.7 0-1.3.6-1.3 1.3v8.3c0-.7.6-1.3 1.3-1.3h4.2V3.2z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "remember":
      return (
        <>
          <path d="M3 3h7.5L13 5.5V13H3V3z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <rect x="5.5" y="3" width="5" height="3" stroke="currentColor" strokeWidth="1.1" fill="none" />
          <rect x="5" y="8.5" width="6" height="3.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
        </>
      );
    case "llm_route":
      return (
        <>
          <path d="M3 8h3.5M6.5 8c1.2 0 1.6-3.5 3-3.5M6.5 8c1.2 0 1.6 3.5 3 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M11 3l1.8 1.5L11 6M11 10l1.8 1.5L11 13" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "web_search":
      return (
        <>
          <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M10 10l3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "compose":
      return (
        <>
          <path d="M3 13l1-3 6.5-6.5 2 2L6 12l-3 1z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M10 4.5l1.5-1.5 2 2L12 6.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "text_transform":
      return (
        <>
          <path d="M3 4.5h6M6 4.5V12" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M9.5 8.5h4M11.5 8.5V12" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    case "http_get":
    case "http_post":
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M2.8 8h10.4M8 2.8c1.6 1.4 2.4 3.3 2.4 5.2S9.6 12.8 8 13.2C6.4 12.8 5.6 10.9 5.6 8S6.4 4.2 8 2.8z" stroke="currentColor" strokeWidth="1.1" fill="none" />
        </>
      );
    case "telegram_send":
    case "email_send":
      return (
        <>
          <rect x="2.5" y="4" width="11" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M3 4.8l5 4 5-4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "slack_send":
      return <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3v-6z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />;
    case "notify_webhook":
      return (
        <>
          <path d="M8 2.6c2 0 3.3 1.5 3.3 3.4v2.4l1.2 1.8H3.5l1.2-1.8V6c0-1.9 1.3-3.4 3.3-3.4z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M6.6 12.2c.2.8.8 1.2 1.4 1.2s1.2-.4 1.4-1.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    default:
      return (
        <>
          <rect x="3.5" y="3.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        </>
      );
  }
}

// Capability names covered by the hand-drawn vocabulary above. Anything else
// (rag.search, delegate, identify, …) falls back to the marketplace glyph set
// (lib/glyphs.ts) so no capability ever renders as an anonymous square.
const KNOWN_CAP_GLYPHS = new Set([
  "think", "recall", "remember", "llm_route", "web_search", "compose", "text_transform",
  "http_get", "http_post", "telegram_send", "email_send", "slack_send", "notify_webhook",
]);

function capNodeGlyph(name: string): React.ReactNode {
  if (KNOWN_CAP_GLYPHS.has(name)) return capGlyphPaths(name);
  return (
    <path
      d={glyphFor(name)}
      stroke="currentColor"
      strokeWidth={1.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

// Inline capability glyph for HTML contexts (sidebar list, etc.)
function CapIcon({ name, size = 14, color = "var(--brand)" }: { name: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, color }}>
      {capNodeGlyph(name)}
    </svg>
  );
}

// ── Generic UI glyphs (chevrons, close, back, empty-state marks) — teal SVG. ────
function Glyph({ name, size = 16, color = "currentColor", strokeWidth = 1.5 }: { name: string; size?: number; color?: string; strokeWidth?: number }) {
  const common = { stroke: color, strokeWidth, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  let body: React.ReactNode;
  switch (name) {
    case "back":         body = <path d="M9.5 3.5L5 8l4.5 4.5M5 8h7" {...common} />; break;
    case "chevron":      body = <path d="M6 3.5L10.5 8 6 12.5" {...common} />; break;
    case "close":        body = <path d="M4 4l8 8M12 4l-8 8" {...common} />; break;
    case "play":         body = <path d="M5 3.5v9l7-4.5-7-4.5z" stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinejoin="round" />; break;
    case "clock":        body = <><circle cx="8" cy="8" r="5.5" {...common} /><path d="M8 5v3l2 1.5" {...common} /></>; break;
    case "flag":         body = <><path d="M4 2.5v11" {...common} /><path d="M4 3h7l-1.5 2.2L11 7.4H4z" {...common} /></>; break;
    case "spark":        body = <path d="M8 2.5l1.4 4.1L13.5 8l-4.1 1.4L8 13.5l-1.4-4.1L2.5 8l4.1-1.4L8 2.5z" {...common} />; break;
    default:             body = <circle cx="8" cy="8" r="5.5" {...common} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      {body}
    </svg>
  );
}

// ── Graph canvas ──────────────────────────────────────────────────────────────

function AgentGraphCanvas({
  nodes, edges, entry, selectedNode, onSelectNode,
}: {
  nodes: ManifestNode[];
  edges: ManifestEdge[];
  entry: string;
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const positions = layoutNodes(nodes, edges, entry);
  const { w, h } = canvasBounds(positions);
  const allBoxes: Box[] = [...positions.values()];

  // Pre-compute edge geometry: back-edges (retry loops) arc through a lane above
  // or below the rows, so the canvas needs extra headroom on that side.
  const geoms = edges.map(e => {
    const fp = positions.get(e.from);
    const tp = positions.get(e.to);
    if (!fp || !tp) return null;
    return { edge: e, g: edgeGeometry(fp, tp, allBoxes, LOOP_CLEARANCE) };
  });
  const hasLoop = geoms.some(x => x?.g.back);
  const hasCond = edges.some(e => e.when);
  const PAD_X = 24;
  const PAD_TOP = geoms.some(x => x?.g.side === "above") ? 60 : 24;
  const PAD_BOTTOM = geoms.some(x => x?.g.side === "below") ? 60 : 24;

  return (
    <div
      className="card"
      style={{
        background: "var(--graph-bg)",
        overflow: "hidden",
        position: "relative",
        display: "flex",
        alignItems: "center",
        // The SVG now scales to fit (viewBox + max-width), so center it — no scroll needed.
        justifyContent: "center",
        minHeight: nodes.length <= 2 ? 200 : 280,
        padding: "var(--s5)",
      }}
    >
      {/* dot-grid background */}
      <svg
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.15 }}
        width="100%" height="100%"
      >
        <defs>
          <pattern id="ag-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--graph-dot)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ag-dots)" />
      </svg>

      {/* A viewBox + max-width:100% makes the graph SCALE TO FIT the card width, so all
          nodes are visible on load (a wide 12-node graph used to overflow-scroll, showing
          only the first few). It never upscales past its natural size on a small graph. */}
      <svg
        role="img"
        aria-label={`Agent graph with ${nodes.length} nodes and ${edges.length} edges`}
        viewBox={`0 0 ${w + PAD_X * 2} ${Math.max(h + PAD_TOP + PAD_BOTTOM, 200)}`}
        width={w + PAD_X * 2}
        height={Math.max(h + PAD_TOP + PAD_BOTTOM, 200)}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block", margin: "auto", maxWidth: "100%", height: "auto" }}
      >
        <defs>
          <marker id="ag-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="var(--ink-muted)" />
          </marker>
          <marker id="ag-arrow-loop" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="var(--brand)" fillOpacity={0.75} />
          </marker>
        </defs>
        <g transform={`translate(${PAD_X},${PAD_TOP})`}>
          {/* edges — back-edges (loops) arc through a clear lane, dashed teal;
              conditional edges carry a small decision dot at their source. */}
          {geoms.map((it, i) => {
            if (!it) return null;
            const { edge: e, g } = it;
            const cond = e.when ? edgeConditionLabel(e.when) : null;
            return (
              <g key={i}>
                <title>
                  {e.from} → {e.to}
                  {g.back ? " (loops back)" : ""}
                  {cond ? ` · when ${cond}` : ""}
                </title>
                {/* generous invisible hit area so the tooltip is easy to reach */}
                <path d={g.d} fill="none" stroke="transparent" strokeWidth={10} />
                <path
                  d={g.d}
                  fill="none"
                  stroke={g.back ? "var(--brand)" : "var(--line-strong)"}
                  strokeOpacity={g.back ? 0.6 : 1}
                  strokeWidth={1.5}
                  strokeDasharray={g.back ? "6 5" : undefined}
                  markerEnd={g.back ? "url(#ag-arrow-loop)" : "url(#ag-arrow)"}
                />
                {cond && (
                  <circle
                    cx={g.sx}
                    cy={g.sy}
                    r={3}
                    fill="var(--surface)"
                    stroke={g.back ? "var(--brand)" : "var(--ink-muted)"}
                    strokeWidth={1.4}
                  />
                )}
                {/* a quiet condition hint on loop arcs only — the lane is empty there */}
                {g.back && cond && g.laneY !== null && (
                  <text
                    x={g.midX}
                    y={g.side === "above" ? g.midY - 6 : g.midY + 12}
                    textAnchor="middle"
                    fontSize={9.5}
                    fontFamily="var(--font-mono)"
                    fill="var(--brand)"
                    letterSpacing={0.2}
                  >
                    {cond.length > 28 ? cond.slice(0, 27) + "…" : cond}
                  </text>
                )}
              </g>
            );
          })}
          {/* nodes */}
          {nodes.map(n => {
            const p = positions.get(n.id);
            if (!p) return null;
            const isEntry = n.id === entry;
            const isSelected = n.id === selectedNode;
            const glyphCaps = n.capabilities.slice(0, 3);
            const glyphGap = 22;
            const glyphStart = p.w / 2 - ((glyphCaps.length - 1) * glyphGap) / 2;
            const capLine = n.capabilities.map(c => c.name).join(" · ");
            const capShort = capLine.length > 22 ? capLine.slice(0, 21) + "…" : capLine;
            return (
              <g
                key={n.id}
                className="graph-node"
                transform={`translate(${p.x},${p.y})`}
                onClick={() => onSelectNode(isSelected ? null : n.id)}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`Step ${n.id}${isEntry ? " (entry)" : ""}: ${n.role}`}
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectNode(isSelected ? null : n.id);
                  }
                }}
              >
                <title>{n.id} — {n.role}</title>
                <rect
                  className="graph-node__box"
                  width={p.w}
                  height={p.h}
                  rx={8}
                  fill="var(--surface)"
                  stroke={isSelected ? "var(--brand)" : isEntry ? "var(--brand)" : "var(--line-strong)"}
                  strokeWidth={isSelected ? 2.5 : isEntry ? 2 : 1.5}
                  style={isSelected ? { filter: "drop-shadow(0 4px 12px rgba(14,124,117,0.18))" } : undefined}
                />
                {isEntry && (
                  <rect width={p.w} height={4} rx={2} fill="var(--brand)" />
                )}
                <text
                  x={p.w / 2}
                  y={26}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--ink)"
                  fontFamily="var(--font-sans)"
                >
                  {n.id.length > 18 ? n.id.slice(0, 17) + "…" : n.id}
                </text>
                {glyphCaps.length > 0 ? (
                  <g color="var(--brand)" opacity={0.9}>
                    {glyphCaps.map((c, gi) => (
                      <g key={c.name} transform={`translate(${glyphStart + gi * glyphGap - 7},${33})`}>
                        {capNodeGlyph(c.name)}
                      </g>
                    ))}
                  </g>
                ) : (
                  <circle cx={p.w / 2} cy={40} r={2.5} fill="none" stroke="var(--ink-muted)" strokeWidth={1.2} />
                )}
                <text
                  x={p.w / 2}
                  y={60}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--brand)"
                  fontFamily="var(--font-mono)"
                  letterSpacing={0.3}
                >
                  {capShort || "no capabilities"}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* legend — make the entry marker + interaction legible */}
      <div
        style={{
          position: "absolute", bottom: "var(--s3)", left: "var(--s4)",
          display: "flex", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap",
          padding: "var(--s1) var(--s3)", borderRadius: "var(--r-pill)",
          background: "var(--surface)", border: "1px solid var(--line)",
          boxShadow: "var(--shadow-sm)", pointerEvents: "none",
        }}
      >
        <span className="micro" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", letterSpacing: ".02em" }}>
          <span aria-hidden="true" style={{ width: 10, height: 3, borderRadius: 2, background: "var(--brand)" }} />
          entry step
        </span>
        {hasLoop && (
          <span className="micro" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", letterSpacing: ".02em" }}>
            <svg aria-hidden="true" width={18} height={6} style={{ flexShrink: 0 }}>
              <path d="M0 3h18" stroke="var(--brand)" strokeWidth={1.5} strokeDasharray="4 3" strokeOpacity={0.7} />
            </svg>
            loops back
          </span>
        )}
        {hasCond && (
          <span className="micro" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", letterSpacing: ".02em" }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", border: "1.5px solid var(--ink-muted)", background: "var(--surface)", flexShrink: 0 }} />
            conditional
          </span>
        )}
        <span className="micro" style={{ letterSpacing: ".02em" }}>click a step for details</span>
      </div>
    </div>
  );
}

// ── Node detail sidebar ───────────────────────────────────────────────────────

function NodeDetailPanel({ node, onClose }: { node: ManifestNode; onClose: () => void }) {
  return (
    <div className="card node-detail" style={{ padding: "var(--s5)", position: "sticky", top: "var(--s8)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s4)" }}>
        <span className="h3 text-truncate">{node.id}</span>
        <button onClick={onClose} aria-label="Close" className="btn btn-ghost btn-sm" style={{ padding: 0, width: 30, flexShrink: 0 }}>
          <Glyph name="close" size={14} color="currentColor" />
        </button>
      </div>
      <div style={{ marginBottom: "var(--s4)" }}>
        <div className="micro" style={{ marginBottom: "var(--s2)" }}>Role</div>
        <p className="small soft" style={{ lineHeight: 1.6 }}>{node.role}</p>
      </div>
      <div style={{ marginBottom: "var(--s4)" }}>
        <div className="micro" style={{ marginBottom: "var(--s2)" }}>Autonomy</div>
        <span className={`badge ${node.autonomy === "full" ? "badge-done" : "badge-info"}`}>
          {node.autonomy === "full" ? "runs on its own" : node.autonomy}
        </span>
      </div>
      {node.capabilities.length > 0 && (
        <div>
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Capabilities</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            {node.capabilities.map(c => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)", padding: "var(--s2) var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", fontSize: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", fontWeight: 500, color: "var(--ink)", minWidth: 0 }}>
                  <CapIcon name={c.name} />
                  <span className="text-truncate">{c.name}</span>
                </span>
                <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 11, whiteSpace: "nowrap" }}>{c.sideEffect}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Schedule panel ────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: "Every 15 min", spec: "*/15 * * * *", kind: "cron" as const },
  { label: "Every hour",   spec: "0 * * * *",    kind: "cron" as const },
  { label: "Daily 8am",    spec: "0 8 * * *",    kind: "cron" as const },
  { label: "Weekly Mon",   spec: "0 9 * * 1",    kind: "cron" as const },
  { label: "Every 5 min",  spec: "300000",        kind: "interval" as const },
  { label: "Every 30 min", spec: "1800000",       kind: "interval" as const },
];

function formatSpec(kind: string, spec: string): string {
  if (kind === "interval") {
    const ms = parseInt(spec, 10);
    if (!isNaN(ms)) {
      if (ms < 60_000) return `every ${ms / 1000}s`;
      if (ms < 3_600_000) return `every ${ms / 60_000}m`;
      return `every ${ms / 3_600_000}h`;
    }
    return spec;
  }
  return spec;
}

function SchedulePanel({ agentId, schedules, onRefresh }: { agentId: string; schedules: ScheduleRecord[]; onRefresh: () => void }) {
  const [kind, setKind] = useState<"cron" | "interval">("cron");
  const [spec, setSpec] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const agentSchedules = schedules.filter(s => s.agentId === agentId);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!spec.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      await createSchedule({ agentId, kind, spec: spec.trim(), label: label.trim() || undefined });
      setSpec(""); setLabel(""); setShowForm(false);
      onRefresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s4)", marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="h2" style={{ marginBottom: "var(--s1)" }}>Schedules</h2>
          <p className="small muted" style={{ margin: 0, maxWidth: "60ch" }}>
            Run this agent automatically on a clock or a fixed interval. Every scheduled run is recorded like any other.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" aria-expanded={showForm} onClick={() => setShowForm(!showForm)} style={{ flexShrink: 0 }}>
          {showForm ? "Cancel" : "+ New schedule"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
          <div style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s3)", flexWrap: "wrap" }}>
            {CRON_PRESETS.map(p => (
              <button key={p.spec} type="button" className="chip"
                onClick={() => { setSpec(p.spec); setKind(p.kind); }}
                style={{ background: spec === p.spec ? "var(--brand-tint)" : undefined, color: spec === p.spec ? "var(--brand)" : undefined }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s3)" }}>
            <div style={{ display: "flex", gap: "var(--s2)" }}>
              {(["cron", "interval"] as const).map(k => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={`btn btn-sm ${kind === k ? "btn-primary" : "btn-secondary"}`}>
                  {k}
                </button>
              ))}
            </div>
            <input
              className="input input-mono"
              value={spec}
              onChange={e => setSpec(e.target.value)}
              placeholder={kind === "cron" ? "0 8 * * *" : "3600000 (ms)"}
              style={{ flex: 1, minWidth: 140 }}
            />
            <input
              className="input"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Label (optional)"
              style={{ flex: 1, minWidth: 120 }}
            />
          </div>
          {err && <div className="state-error" style={{ marginBottom: "var(--s3)" }}>{err}</div>}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!spec.trim() || creating}>
            {creating ? "Creating…" : "Create schedule"}
          </button>
        </form>
      )}

      {agentSchedules.length === 0 && !showForm && (
        <div className="state-empty">
          <span className="state-glyph" aria-hidden="true"><Glyph name="clock" size={26} color="var(--brand)" /></span>
          <p className="h3" style={{ color: "var(--ink-soft)", margin: 0 }}>No schedules yet</p>
          <p className="small" style={{ maxWidth: "44ch", margin: 0 }}>
            Add a schedule to run this agent automatically — every 15 minutes, hourly, or daily.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)} style={{ marginTop: "var(--s2)" }}>
            + New schedule
          </button>
        </div>
      )}

      {agentSchedules.map(s => {
        const armed = s.armed && s.enabled;
        return (
        <div key={s.id} className={`card schedule-row${armed ? " is-armed" : ""}`} style={{ padding: "var(--s3) var(--s4)", marginBottom: "var(--s3)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div className="h3 text-truncate" style={{ marginBottom: "var(--s1)" }}>{s.label || formatSpec(s.kind, s.spec)}</div>
            <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>{s.spec}</span>
              <span className={`badge badge-${s.enabled ? (s.armed ? "running" : "done") : "paused"}`}>
                {armed && <span className="dot" />}
                {s.enabled ? (s.armed ? "armed" : "enabled") : "paused"}
              </span>
              {s.lastRunAt && <span className="small muted mono">last {timeAgo(s.lastRunAt)}</span>}
              {s.nextRunAt && <span className="small mono" style={{ color: armed ? "var(--live)" : "var(--ink-muted)" }}>next {timeAgo(s.nextRunAt)}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexWrap: "wrap" }}>
            {confirmDeleteId !== s.id ? (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => { await toggleSchedule(s.id, !s.enabled); onRefresh(); }}
                >
                  {s.enabled ? "Pause" : "Enable"}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => setConfirmDeleteId(s.id)}
                >
                  Delete
                </button>
              </>
            ) : (
              <>
                <span className="micro" style={{ color: "var(--danger)", whiteSpace: "nowrap" }}>Delete?</span>
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                <button
                  className="btn btn-danger btn-sm"
                  disabled={deleting}
                  onClick={async () => {
                    setDeleting(true);
                    await deleteSchedule(s.id);
                    setConfirmDeleteId(null);
                    setDeleting(false);
                    onRefresh();
                  }}
                >
                  {deleting ? "…" : "Yes"}
                </button>
              </>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

const TABS = ["graph", "runs", "schedules", "trigger", "memory"] as const;

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  // The agent id contains "sha256:" — Next may hand it back still percent-encoded,
  // and getAgent() re-encodes, causing a double-encode 404. Decode defensively.
  const id = (() => { try { return decodeURIComponent(rawId); } catch { return rawId; } })();

  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [intentOpen, setIntentOpen] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // Transient load failure (network / 5xx) vs. a real 404. On the former we show
  // error+retry, NOT the "agent isn't here" state.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Toast for a failed primary action (run now) so the click isn't silently lost.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "runs" | "schedules" | "trigger" | "memory">("graph");
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function flashErr(msg: string) { setActionErr(msg); setTimeout(() => setActionErr(null), 4000); }

  const load = useCallback(async () => {
    try {
      const [a, r, s, ap] = await Promise.all([
        getAgent(id),
        getAgentRuns(id),
        listSchedules(),
        listApprovals().catch(() => [] as PendingApproval[]),
      ]);
      setAgent(a);
      setRuns(r);
      setSchedules(s);
      setApprovals(ap.filter(x => x.agentId === id));
      setLoadErr(null);
    } catch (e) {
      const msg = (e as Error).message || "";
      // A 404 is a genuine "not here" (falls through to agent === null); any other
      // failure is transient → error+retry.
      if (/\b404\b|not found/i.test(msg)) setLoadErr(null);
      else setLoadErr(msg || "could not reach Krelvan");
    }
  }, [id]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
    // Poll for live updates. A single failed tick is tolerated (skip it, keep polling)
    // — one transient error must not freeze live updates until the page is reloaded.
    const t = setInterval(async () => {
      try {
        const [a, r, ap] = await Promise.all([getAgent(id), getAgentRuns(id), listApprovals().catch(() => [] as PendingApproval[])]);
        setAgent(a);
        setRuns(r);
        setApprovals(ap.filter(x => x.agentId === id));
      } catch { /* transient — skip this tick, keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [id, load]);

  async function handleRunNow() {
    if (!agent || running) return;
    setRunning(true);
    try {
      await startRun(agent.id);
      await load();
    } catch (e) {
      flashErr(`Couldn't start the run — ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!agent) return;
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
      window.location.href = "/";
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) return (
    <div className="container" style={{ paddingTop: "var(--s7)" }}>
      <div className="state-loading">
        <span className="spinner" aria-hidden="true" />
        Loading agent…
      </div>
    </div>
  );
  if (!agent && loadErr) return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <nav aria-label="Breadcrumb" style={{ marginBottom: "var(--s5)" }}>
        <Link href="/dashboard" className="small" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s1)", color: "var(--ink-muted)", textDecoration: "none" }}>
          <Glyph name="back" size={13} color="currentColor" /> Agents
        </Link>
      </nav>
      <div className="state-error" style={{ textAlign: "center", padding: "var(--s7)", justifyContent: "center" }}>
        <div>
          <p style={{ margin: "0 0 var(--s3)" }}>Couldn&apos;t load this agent — {loadErr}</p>
          <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); void load().finally(() => setLoading(false)); }}>Retry</button>
        </div>
      </div>
    </div>
  );
  if (!agent) return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <nav aria-label="Breadcrumb" style={{ marginBottom: "var(--s5)" }}>
        <Link href="/dashboard" className="small" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s1)", color: "var(--ink-muted)", textDecoration: "none" }}>
          <Glyph name="back" size={13} color="currentColor" /> Agents
        </Link>
      </nav>
      <div className="state-empty" style={{ padding: "var(--s9) var(--s6)" }}>
        <span className="state-glyph" aria-hidden="true"><Glyph name="flag" size={30} color="var(--brand)" /></span>
        <p className="h2" style={{ color: "var(--ink)", margin: 0 }}>This agent isn&apos;t here</p>
        <p className="body-lg soft" style={{ maxWidth: "44ch", margin: 0 }}>
          It may have been deleted, or the link is wrong. Head back to your agents to pick another one.
        </p>
        <Link href="/dashboard" className="btn btn-primary btn-sm" style={{ marginTop: "var(--s2)", textDecoration: "none" }}>
          Back to agents
        </Link>
      </div>
    </div>
  );

  const manifest = agent.signed.manifest;
  const nodes = manifest.nodes ?? [];
  const edges = manifest.edges ?? [];
  const selectedNodeObj = selectedNode ? nodes.find(n => n.id === selectedNode) ?? null : null;

  const lastRun = runs[0];
  const liveRunCount = runs.filter(r => r.status === "running").length;
  // If the last run is awaiting approval, find its pending gate so we can name the step
  // it's paused at and link straight to the decision.
  const haltedApproval = lastRun?.status === "halted"
    ? approvals.find(a => a.runId === lastRun.runId) ?? null
    : null;

  const statusBadge = liveRunCount > 0 ? "running"
    : lastRun?.status === "completed" ? "done"
    : lastRun?.status === "failed" ? "failed"
    : "neutral";

  const scheduleCount = schedules.filter(s => s.agentId === id).length;

  return (
    <div style={{ minHeight: "100vh" }}>

      {actionErr && <div role="alert" className="toast toast-error">{actionErr}</div>}

      {/* ── header bar ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", paddingTop: "var(--s5)", paddingBottom: "var(--s6)" }}>
        <div className="container">
          <nav aria-label="Breadcrumb" style={{ marginBottom: "var(--s4)" }}>
            <Link href="/dashboard" className="small" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s1)", color: "var(--ink-muted)", textDecoration: "none" }}>
              <Glyph name="back" size={13} color="currentColor" /> Agents
            </Link>
          </nav>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s5)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s3)", flexWrap: "wrap" }}>
                <h1 className="h1" style={{ margin: 0 }}>
                  {manifest.name}
                </h1>
                <span className={`badge badge-${statusBadge}`}>
                  {liveRunCount > 0 && <span className="dot" />}
                  {liveRunCount > 0
                    ? `${liveRunCount} running`
                    : lastRun?.status === "completed" ? "last run finished"
                    : lastRun?.status === "failed" ? "last run failed"
                    : lastRun?.status === "halted"
                      ? (haltedApproval?.nodeId ? `Awaiting approval at ${haltedApproval.nodeId}` : "Awaiting approval")
                    : lastRun ? lastRun.status
                    : "never run"}
                </span>
                {/* A "paused" agent is not stuck — its last run is awaiting a person's decision.
                    Say so and link straight to the approval, so there's an obvious next step. */}
                {lastRun?.status === "halted" && (
                  <Link href={`/runs/${lastRun.runId}`} className="small" style={{ color: "var(--brand)", fontWeight: 600 }}>
                    Review &amp; resume →
                  </Link>
                )}
              </div>
              {/* Clamp the long intent to 2 lines so it doesn't dominate the hero as a wall of
                  text; the full text is one click away and always in the manifest below. */}
              <p className="soft body-lg" title={agent.signed.provenance.intent} style={{
                maxWidth: "62ch", margin: 0,
                display: "-webkit-box", WebkitLineClamp: intentOpen ? "unset" : 2,
                WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>
                {agent.signed.provenance.intent}
              </p>
              {agent.signed.provenance.intent.length > 130 && (
                <button type="button" onClick={() => setIntentOpen(o => !o)} className="small" style={{ marginTop: "var(--s1)", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 500 }}>
                  {intentOpen ? "Show less" : "Show more"}
                </button>
              )}
              <div style={{ display: "flex", gap: "var(--s4)", alignItems: "center", flexWrap: "wrap", marginTop: "var(--s3)" }}>
                <span className="small muted" style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--s2)" }}>
                  total runs
                  <span className="mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{runs.length}</span>
                </span>
                <span aria-hidden="true" className="muted">·</span>
                <span className="small muted" style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--s2)" }}>
                  nodes
                  <span className="mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{manifest.nodes.length}</span>
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", flexWrap: "wrap" }}>
              <Link
                href={`/canvas/${id}`}
                className="btn btn-secondary"
                style={{ textDecoration: "none" }}
              >
                Canvas
              </Link>
              <button
                className={confirmDelete ? "btn btn-danger" : "btn btn-secondary"}
                onClick={() => void handleDelete()}
                disabled={deleting || liveRunCount > 0}
                title={liveRunCount > 0 ? "Cannot delete while a run is live" : undefined}
              >
                {deleting ? "Deleting…" : confirmDelete ? "Sure? Click again" : "Delete agent"}
              </button>
              {lastRun?.status === "halted" ? (
                <Link
                  href={`/runs/${lastRun.runId}`}
                  className="btn btn-primary"
                  style={{ textDecoration: "none" }}
                  title={haltedApproval?.nodeId ? `This run is awaiting approval at ${haltedApproval.nodeId}` : "This run is awaiting your approval"}
                >
                  Review &amp; resume run →
                </Link>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={handleRunNow}
                  disabled={running}
                >
                  {running ? "Starting…" : "Run now"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── stat strip ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--canvas)" }}>
        <div className="container" style={{ paddingTop: "var(--s5)", paddingBottom: "var(--s5)" }}>
          <div className="stat-strip">
            {[
              { label: "steps",         value: String(nodes.length),                live: false                 },
              { label: "connections",   value: String(edges.length),                live: false                 },
              { label: "total runs",    value: String(runs.length),                 live: false                 },
              { label: "running now",   value: String(liveRunCount),                live: liveRunCount > 0      },
              { label: "built",         value: timeAgo(agent.createdAt),            live: false                 },
            ].map(s => (
              <div key={s.label} className={`stat-cell${s.live ? " is-live" : ""}`}>
                <span className="stat-value">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── tabs ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", position: "sticky", top: 0, zIndex: 10, boxShadow: "var(--shadow-sm)" }}>
        <div className="container">
          <div role="tablist" aria-label="Agent sections" style={{ display: "flex", gap: "var(--s5)" }}>
            {TABS.map((t, i) => {
              const active = tab === t;
              const label = t === "graph" ? "Graph" : t === "runs" ? `Runs (${runs.length})` : t === "schedules" ? `Schedules${scheduleCount > 0 ? ` (${scheduleCount})` : ""}` : t === "trigger" ? "Trigger" : "Memory";
              return (
                <button
                  key={t}
                  role="tab"
                  id={`tab-${t}`}
                  aria-selected={active}
                  aria-controls={`panel-${t}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTab(t)}
                  onKeyDown={e => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const dir = e.key === "ArrowRight" ? 1 : -1;
                      const next = TABS[(i + dir + TABS.length) % TABS.length]!;
                      setTab(next);
                      document.getElementById(`tab-${next}`)?.focus();
                    }
                  }}
                  style={{
                    padding: "var(--s4) 0", border: "none", background: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: active ? 600 : 500,
                    color: active ? "var(--brand)" : "var(--ink-muted)",
                    borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
                    marginBottom: -1,
                    transition: "color var(--t-fast) var(--ease)",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── content ── */}
      <div className="container" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s9)" }}>

        {/* Graph tab */}
        {tab === "graph" && (
          <div role="tabpanel" id="panel-graph" aria-labelledby="tab-graph">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s4)", marginBottom: "var(--s5)", flexWrap: "wrap" }}>
              <div>
                <h2 className="h2" style={{ marginBottom: "var(--s1)" }}>How this agent runs</h2>
                <p className="small muted" style={{ margin: 0 }}>
                  {nodes.length} {nodes.length === 1 ? "step" : "steps"} flowing left to right. Select any step to see its role, autonomy, and capabilities.
                </p>
              </div>
              {nodes.length > 0 && (
                <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexShrink: 0 }}>
                  <span className="badge badge-neutral mono">{nodes.length} {nodes.length === 1 ? "step" : "steps"}</span>
                  <span className="badge badge-neutral mono">{edges.length} {edges.length === 1 ? "connection" : "connections"}</span>
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: selectedNodeObj ? "1fr 300px" : "1fr", gap: "var(--s5)", alignItems: "start" }}>
              {nodes.length === 0 ? (
                <div className="state-error" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--s2)" }} role="alert">
                  <p className="h3" style={{ color: "var(--danger)", margin: 0 }}>This agent has no steps</p>
                  <p className="small" style={{ color: "var(--danger)", margin: 0 }}>Its plan is incomplete and it cannot run. Delete it and build a new one from a clear goal.</p>
                </div>
              ) : (
                <AgentGraphCanvas
                  nodes={nodes}
                  edges={edges}
                  entry={manifest.entry}
                  selectedNode={selectedNode}
                  onSelectNode={setSelectedNode}
                />
              )}
              {selectedNodeObj && (
                <NodeDetailPanel node={selectedNodeObj} onClose={() => setSelectedNode(null)} />
              )}
            </div>
          </div>
        )}

        {/* Runs tab */}
        {tab === "runs" && (
          <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s4)", marginBottom: "var(--s5)", flexWrap: "wrap" }}>
              <div>
                <h2 className="h2" style={{ marginBottom: "var(--s1)" }}>Run history</h2>
                <p className="small muted" style={{ margin: 0 }}>
                  Every execution is recorded to a signed, replayable record. Select a run to open it.
                </p>
              </div>
              {runs.length > 0 && (
                <button className="btn btn-primary btn-sm" onClick={handleRunNow} disabled={running} style={{ flexShrink: 0 }}>
                  {running ? "Starting…" : "Run now"}
                </button>
              )}
            </div>
            {runs.length === 0 ? (
              <div className="state-empty">
                <span className="state-glyph" aria-hidden="true"><Glyph name="play" size={24} color="var(--brand)" /></span>
                <p className="h3" style={{ color: "var(--ink-soft)", margin: 0 }}>No runs yet</p>
                <p className="small" style={{ maxWidth: "44ch", margin: 0 }}>
                  Run this agent and every step it takes — what it decided and what it did — is recorded here as a record you can open and replay.
                </p>
                <button className="btn btn-primary btn-sm" onClick={handleRunNow} disabled={running} style={{ marginTop: "var(--s2)" }}>
                  {running ? "Starting…" : "Run now"}
                </button>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {/* column header */}
                <div style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto 16px",
                  gap: "var(--s4)", padding: "var(--s2) var(--s4)", alignItems: "center",
                  background: "var(--surface-sunken)", borderBottom: "1px solid var(--line)",
                }}>
                  <span className="micro" style={{ width: 8 }} aria-hidden="true" />
                  <span className="micro">Run</span>
                  <span className="micro" style={{ textAlign: "right" }}>Status</span>
                  <span aria-hidden="true" />
                </div>
                {runs.map((r, i) => {
                  const runColor = r.status === "completed" ? "var(--ok)" : r.status === "failed" ? "var(--danger)" : r.status === "running" ? "var(--live)" : "var(--paused)";
                  const isLive = r.status === "running";
                  return (
                    <Link key={r.runId} href={`/runs/${r.runId}`} className="table-row-link" style={{
                      display: "grid", gridTemplateColumns: "auto 1fr auto 16px",
                      gap: "var(--s4)", padding: "var(--s4)",
                      borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      textDecoration: "none", color: "var(--ink)", alignItems: "center",
                      background: isLive ? "var(--live-tint)" : undefined,
                    }}>
                      <span className={`status-dot ${r.status === "completed" ? "done" : r.status}`} aria-label={r.status} role="img" />
                      <div style={{ minWidth: 0 }}>
                        <div className="text-truncate" style={{ fontSize: 13, fontWeight: 500, marginBottom: "var(--s1)" }}>{r.manifestName}</div>
                        <div className="mono text-truncate" style={{ fontSize: 11, color: "var(--ink-muted)" }}>{r.runId}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: runColor, textTransform: "capitalize" }}>
                          {r.status === "completed" ? "finished" : r.status}
                        </div>
                        <div className="small muted">{timeAgo(r.createdAt)}</div>
                      </div>
                      <span aria-hidden="true" style={{ color: "var(--ink-muted)", fontSize: 14, lineHeight: 1 }}>›</span>
                    </Link>
                  );
                })}
              </div>
            )}
            {runs.length > 0 && (
              <div style={{ marginTop: "var(--s4)", display: "flex", justifyContent: "flex-end" }}>
                <Link href="/runs" className="small" style={{ color: "var(--brand)" }}>See all runs →</Link>
              </div>
            )}
          </div>
        )}

        {/* Schedules tab */}
        {tab === "schedules" && (
          <SchedulePanel agentId={id} schedules={schedules} onRefresh={load} />
        )}

        {/* Trigger tab — inbound webhook */}
        {tab === "trigger" && (
          <TriggerPanel agentId={id} />
        )}

        {/* Memory tab */}
        {tab === "memory" && (
          <MemoryTab
            agentId={id}
            agentIsRunning={runs.some(r => r.status === "running")}
          />
        )}

      </div>
    </div>
  );
}

// ── Trigger panel: mint/show/revoke the inbound webhook + a copy-paste curl example ──
function TriggerPanel({ agentId }: { agentId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string>("");
  const [token, setToken] = useState<string | null>(null); // shown once after mint
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void getTrigger(agentId).then(s => { setEnabled(s.enabled); setUrl(s.url); }).catch(() => setEnabled(false));
  }, [agentId]);
  useEffect(() => { refresh(); }, [refresh]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const fullUrl = url ? `${origin}/proxy${url}` : "";
  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); });
  };

  async function mint() {
    setBusy(true);
    try { const r = await mintTrigger(agentId); setToken(r.token); setEnabled(true); setUrl(r.url); }
    finally { setBusy(false); }
  }
  async function revoke() {
    setBusy(true);
    try { await revokeTrigger(agentId); setToken(null); setEnabled(false); }
    finally { setBusy(false); }
  }

  const curl = token
    ? `curl -X POST ${origin}${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input":"your value"}'`
    : "";

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 className="h3" style={{ marginBottom: "var(--s2)" }}>Webhook trigger</h2>
      <p className="small soft" style={{ marginBottom: "var(--s5)", lineHeight: 1.6, maxWidth: "60ch" }}>
        Let an external system — a form, a Slack or GitHub webhook, an automation, or a cron on
        another machine — start this agent by POSTing to a URL. The JSON body becomes the run&apos;s
        input. Authenticated by a per-agent token, scoped to this one agent.
      </p>

      {enabled === null ? (
        <div className="skeleton skeleton-line" style={{ height: 40, width: 280 }} />
      ) : !enabled ? (
        <div className="card" style={{ padding: "var(--s6)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s3)" }}>
          <p className="small soft" style={{ maxWidth: "44ch", lineHeight: 1.6 }}>
            No webhook yet. Enable one to get a URL + token you can call from anywhere.
          </p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void mint()}>
            {busy ? "Enabling…" : "Enable webhook trigger"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {token && (
            <div className="card" style={{ padding: "var(--s5)", borderLeft: "3px solid var(--brand)" }}>
              <p className="micro" style={{ color: "var(--brand)", marginBottom: "var(--s2)" }}>Your token — shown once</p>
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexWrap: "wrap" }}>
                <code className="mono" style={{ fontSize: 13, wordBreak: "break-all", background: "var(--surface-sunken)", padding: "var(--s2) var(--s3)", borderRadius: "var(--r-sm)", flex: 1, minWidth: 0 }}>{token}</code>
                <button className="btn btn-sm btn-secondary" onClick={() => copy(token, "token")}>{copied === "token" ? "Copied" : "Copy"}</button>
              </div>
              <p className="small muted" style={{ marginTop: "var(--s2)" }}>Save it now — for security it can&apos;t be shown again. Lost it? Rotate below for a new one.</p>
            </div>
          )}

          <div className="card" style={{ padding: "var(--s5)" }}>
            <p className="micro" style={{ marginBottom: "var(--s2)" }}>Webhook URL</p>
            <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexWrap: "wrap" }}>
              <code className="mono" style={{ fontSize: 13, wordBreak: "break-all", flex: 1, minWidth: 0 }}>{fullUrl}</code>
              <button className="btn btn-sm btn-secondary" onClick={() => copy(fullUrl, "url")}>{copied === "url" ? "Copied" : "Copy"}</button>
            </div>
          </div>

          {token && (
            <div className="card" style={{ padding: "var(--s5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s2)" }}>
                <p className="micro" style={{ margin: 0 }}>Try it</p>
                <button className="btn btn-sm btn-secondary" onClick={() => copy(curl, "curl")}>{copied === "curl" ? "Copied" : "Copy"}</button>
              </div>
              <pre className="mono" style={{ fontSize: 12.5, lineHeight: 1.6, overflowX: "auto", margin: 0, color: "var(--ink-soft)" }}>{curl}</pre>
            </div>
          )}

          <div style={{ display: "flex", gap: "var(--s3)", marginTop: "var(--s2)" }}>
            <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void mint()}>{busy ? "…" : "Rotate token"}</button>
            <button className="btn btn-sm agent-card__delete" disabled={busy} onClick={() => void revoke()}>{busy ? "…" : "Disable webhook"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
