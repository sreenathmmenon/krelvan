"use client";

import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import {
  getAgent, getAgentRuns, startRun, deleteAgent, listSchedules, createSchedule, toggleSchedule, deleteSchedule,
  timeAgo,
  type AgentRecord, type RunRecord, type ScheduleRecord, type ManifestNode, type ManifestEdge,
} from "../../../lib/api";
import MemoryTab from "./MemoryTab";

// ── Layout (shared with run detail — same Sugiyama-lite algorithm) ────────────

interface NodePos { x: number; y: number; w: number; h: number; }

const NODE_W = 160;
const NODE_H = 72;
const H_GAP  = 80;
const V_GAP  = 56;

function layoutNodes(
  nodes: ManifestNode[],
  edges: ManifestEdge[],
  entry: string,
): Map<string, NodePos> {
  const ids = nodes.map(n => n.id);
  const layer = new Map<string, number>();
  const visited = new Set<string>();

  function visit(id: string, depth: number) {
    if (!visited.has(id) || (layer.get(id) ?? 0) < depth) {
      layer.set(id, depth);
      visited.add(id);
      for (const e of edges) {
        if (e.from === id) visit(e.to, depth + 1);
      }
    }
  }
  visit(entry, 0);
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

function edgePath(from: NodePos, to: NodePos): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
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

// Inline capability glyph for HTML contexts (sidebar list, etc.)
function CapIcon({ name, size = 14, color = "var(--brand)" }: { name: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, color }}>
      {capGlyphPaths(name)}
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
  const PAD = 24;

  return (
    <div
      className="card"
      style={{
        background: "var(--graph-bg)",
        overflow: "auto",
        position: "relative",
        display: "flex",
        alignItems: "center",
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

      <svg
        role="img"
        aria-label={`Agent graph with ${nodes.length} nodes and ${edges.length} edges`}
        width={w + PAD * 2}
        height={Math.max(h + PAD * 2, 200)}
        style={{ display: "block", margin: "0 auto" }}
      >
        <defs>
          <marker id="ag-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="var(--ink-muted)" />
          </marker>
        </defs>
        <g transform={`translate(${PAD},${PAD})`}>
          {/* edges */}
          {edges.map((e, i) => {
            const fp = positions.get(e.from);
            const tp = positions.get(e.to);
            if (!fp || !tp) return null;
            return (
              <path
                key={i}
                d={edgePath(fp, tp)}
                fill="none"
                stroke="var(--line-strong)"
                strokeWidth={1.5}
                markerEnd="url(#ag-arrow)"
              />
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
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: "pointer" }}
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
                  width={p.w}
                  height={p.h}
                  rx={8}
                  fill="var(--surface)"
                  stroke={isSelected ? "var(--brand)" : isEntry ? "var(--brand)" : "var(--line-strong)"}
                  strokeWidth={isSelected ? 2.5 : isEntry ? 2 : 1.5}
                  style={{ filter: isSelected ? "drop-shadow(0 4px 12px rgba(14,124,117,0.18))" : "none", transition: "stroke 120ms" }}
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
                  {n.id.length > 16 ? n.id.slice(0, 15) + "…" : n.id}
                </text>
                {glyphCaps.length > 0 ? (
                  <g color="var(--brand)" opacity={0.9}>
                    {glyphCaps.map((c, gi) => (
                      <g key={c.name} transform={`translate(${glyphStart + gi * glyphGap - 7},${33})`}>
                        {capGlyphPaths(c.name)}
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

const TABS = ["graph", "runs", "schedules", "memory"] as const;

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  // The agent id contains "sha256:" — Next may hand it back still percent-encoded,
  // and getAgent() re-encodes, causing a double-encode 404. Decode defensively.
  const id = (() => { try { return decodeURIComponent(rawId); } catch { return rawId; } })();

  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "runs" | "schedules" | "memory">("graph");
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const [a, r, s] = await Promise.all([
      getAgent(id),
      getAgentRuns(id),
      listSchedules(),
    ]);
    setAgent(a);
    setRuns(r);
    setSchedules(s);
  }, [id]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
    // Poll if any runs are live
    const t = setInterval(async () => {
      try {
        const [a, r] = await Promise.all([getAgent(id), getAgentRuns(id)]);
        setAgent(a);
        setRuns(r);
      } catch { clearInterval(t); }
    }, 3000);
    return () => clearInterval(t);
  }, [id, load]);

  async function handleRunNow() {
    if (!agent || running) return;
    setRunning(true);
    try {
      await startRun(agent.id);
      await load();
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

  const statusBadge = liveRunCount > 0 ? "running"
    : lastRun?.status === "completed" ? "done"
    : lastRun?.status === "failed" ? "failed"
    : "neutral";

  const scheduleCount = schedules.filter(s => s.agentId === id).length;

  return (
    <div style={{ minHeight: "100vh" }}>

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
                    : lastRun ? lastRun.status
                    : "never run"}
                </span>
              </div>
              <p className="soft body-lg" style={{ maxWidth: "60ch", margin: 0 }}>
                {agent.signed.provenance.intent}
              </p>
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
              <button
                className="btn btn-primary"
                onClick={handleRunNow}
                disabled={running}
              >
                {running ? "Starting…" : "Run now"}
              </button>
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
              const label = t === "graph" ? "Graph" : t === "runs" ? `Runs (${runs.length})` : t === "schedules" ? `Schedules${scheduleCount > 0 ? ` (${scheduleCount})` : ""}` : "Memory";
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
