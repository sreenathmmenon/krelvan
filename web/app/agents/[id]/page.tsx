"use client";

import { useState, useEffect, use, useCallback } from "react";
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

const CAP_ICON: Record<string, string> = {
  think: "🧠", recall: "📚", remember: "💾", llm_route: "🔀",
  web_search: "🔍", compose: "✍️", telegram_send: "📨", http_get: "🌐",
  http_post: "📤", email_send: "📧", text_transform: "🔤",
};

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
        backgroundImage: "radial-gradient(circle at 65% 35%, rgba(14,124,117,.04) 0%, transparent 55%)",
        overflow: "auto",
        position: "relative",
      }}
    >
      {/* dot-grid background */}
      <svg
        style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5 }}
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
            const icons = n.capabilities.slice(0, 3).map(c => CAP_ICON[c.name] ?? "⚙️").join(" ");
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectNode(isSelected ? null : n.id)}
              >
                <rect
                  width={p.w}
                  height={p.h}
                  rx={8}
                  fill="var(--surface)"
                  stroke={isSelected ? "var(--brand)" : isEntry ? "var(--brand)" : "var(--line-strong)"}
                  strokeWidth={isSelected ? 2.5 : isEntry ? 2 : 1.5}
                  filter={isSelected ? "drop-shadow(0 2px 8px rgba(14,124,117,.18))" : undefined}
                />
                {isEntry && (
                  <rect width={p.w} height={3} rx={1.5} fill="var(--brand)" />
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
                <text
                  x={p.w / 2}
                  y={44}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--ink-muted)"
                  fontFamily="var(--font-sans)"
                >
                  {icons || "○"}
                </text>
                <text
                  x={p.w / 2}
                  y={60}
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--brand)"
                  fontFamily="var(--font-mono)"
                  letterSpacing={0.3}
                >
                  {n.capabilities.map(c => c.name).join(" · ")}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ── Node detail sidebar ───────────────────────────────────────────────────────

function NodeDetailPanel({ node, onClose }: { node: ManifestNode; onClose: () => void }) {
  return (
    <div className="card" style={{ padding: "var(--s5)", position: "sticky", top: "var(--s5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{node.id}</span>
        <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", fontSize: 18, lineHeight: 1, padding: "8px", borderRadius: "var(--r)", transition: "background 120ms" }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-sunken)")}
          onMouseLeave={e => (e.currentTarget.style.background = "none")}
        >×</button>
      </div>
      <div style={{ marginBottom: "var(--s4)" }}>
        <div className="micro" style={{ marginBottom: "var(--s2)" }}>Role</div>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>{node.role}</p>
      </div>
      <div style={{ marginBottom: "var(--s4)" }}>
        <div className="micro" style={{ marginBottom: "var(--s2)" }}>Autonomy</div>
        <span style={{
          fontSize: 11, padding: "3px 8px",
          background: node.autonomy === "full" ? "var(--ok-tint)" : node.autonomy === "suggest" ? "var(--live-tint)" : "var(--brand-tint)",
          color: node.autonomy === "full" ? "var(--ok)" : node.autonomy === "suggest" ? "var(--live)" : "var(--brand)",
          borderRadius: "var(--r-pill)", fontWeight: 600,
        }}>
          {node.autonomy}
        </span>
      </div>
      {node.capabilities.length > 0 && (
        <div>
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Capabilities</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            {node.capabilities.map(c => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--s2) var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", fontSize: 12 }}>
                <span style={{ fontWeight: 500, color: "var(--ink)" }}>{CAP_ICON[c.name] ?? "⚙️"} {c.name}</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-muted)", fontSize: 11 }}>{c.sideEffect} · {c.budgetCents}¢</span>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <h3 className="h3" style={{ fontWeight: 500, color: "var(--ink-soft)" }}>Schedules</h3>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowForm(!showForm)}>
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
                <button key={k} type="button" onClick={() => setKind(k)} style={{
                  padding: "4px 10px", borderRadius: "var(--r)", border: "1px solid var(--line-strong)",
                  background: kind === k ? "var(--brand)" : "transparent",
                  color: kind === k ? "white" : "var(--ink-soft)", fontSize: 12, cursor: "pointer",
                }}>
                  {k}
                </button>
              ))}
            </div>
            <input
              value={spec}
              onChange={e => setSpec(e.target.value)}
              placeholder={kind === "cron" ? "0 8 * * *" : "3600000 (ms)"}
              style={{ flex: 1, minWidth: 140, padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: "var(--r)", fontSize: 13, fontFamily: "var(--font-mono)" }}
            />
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Label (optional)"
              style={{ flex: 1, minWidth: 120, padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: "var(--r)", fontSize: 13 }}
            />
          </div>
          {err && <p style={{ fontSize: 12, color: "var(--danger)", marginBottom: "var(--s3)" }}>{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!spec.trim() || creating}>
            {creating ? "Creating…" : "Create schedule"}
          </button>
        </form>
      )}

      {agentSchedules.length === 0 && !showForm && (
        <p className="small muted">No schedules yet. Create one to run this agent automatically.</p>
      )}

      {agentSchedules.map(s => (
        <div key={s.id} className="card" style={{ padding: "var(--s3) var(--s4)", marginBottom: "var(--s3)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{s.label || formatSpec(s.kind, s.spec)}</div>
            <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{s.spec}</span>
              <span className={`badge badge-${s.enabled ? (s.armed ? "running" : "done") : "paused"}`} style={{ fontSize: 10, height: 18 }}>
                {s.enabled ? (s.armed ? "armed" : "enabled") : "paused"}
              </span>
              {s.lastRunAt && <span className="small muted">last {timeAgo(s.lastRunAt)}</span>}
              {s.nextRunAt && <span className="small muted">next {timeAgo(s.nextRunAt)}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            {confirmDeleteId !== s.id ? (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => { await toggleSchedule(s.id, !s.enabled); onRefresh(); }}
                >
                  {s.enabled ? "Pause" : "Enable"}
                </button>
                <button
                  className="btn btn-sm"
                  style={{ background: "var(--danger-tint)", color: "var(--danger)", border: "none" }}
                  onClick={() => setConfirmDeleteId(s.id)}
                >
                  Delete
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 500, whiteSpace: "nowrap" }}>Delete?</span>
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                <button
                  className="btn btn-sm"
                  style={{ background: "var(--danger)", color: "white", border: "none", opacity: deleting ? .6 : 1 }}
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
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

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
      <p className="soft small">Loading agent…</p>
    </div>
  );
  if (!agent) return (
    <div className="container" style={{ paddingTop: "var(--s7)" }}>
      <p style={{ color: "var(--danger)", fontSize: 14 }}>Agent not found.</p>
    </div>
  );

  const manifest = agent.signed.manifest;
  const nodes = manifest.nodes ?? [];
  const edges = manifest.edges ?? [];
  const selectedNodeObj = selectedNode ? nodes.find(n => n.id === selectedNode) ?? null : null;

  const lastRun = runs[0];
  const liveRunCount = runs.filter(r => r.status === "running").length;
  const totalSpent = runs.reduce((s, r) => s + (r.spentCents ?? 0), 0);

  const statusBadge = liveRunCount > 0 ? "running"
    : lastRun?.status === "completed" ? "done"
    : lastRun?.status === "failed" ? "failed"
    : "neutral";

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* ── header bar ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", padding: "var(--s5) 0" }}>
        <div className="container">
          <div style={{ marginBottom: "var(--s2)" }}>
            <a href="/" style={{ fontSize: 12, color: "var(--ink-muted)", textDecoration: "none" }}>← Agents</a>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s4)" }}>
            <div>
              <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>
                {manifest.name}
              </h1>
              <p className="soft" style={{ fontSize: 14, maxWidth: "56ch", lineHeight: 1.55 }}>
                {agent.signed.provenance.intent}
              </p>
            </div>
            <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", flexWrap: "wrap" }}>
              <span className={`badge badge-${statusBadge}`}>
                {liveRunCount > 0 && <span className="dot" />}
                {liveRunCount > 0 ? `${liveRunCount} running` : lastRun?.status ?? "idle"}
              </span>
              <a
                href={`/canvas/${id}`}
                className="btn btn-secondary"
                style={{ textDecoration: "none" }}
              >
                Canvas
              </a>
              <button
                className="btn btn-secondary"
                onClick={() => void handleDelete()}
                disabled={deleting || liveRunCount > 0}
                style={{
                  opacity: (deleting || liveRunCount > 0) ? 0.4 : 1,
                  color: confirmDelete ? "var(--danger)" : undefined,
                  borderColor: confirmDelete ? "var(--danger)" : undefined,
                }}
              >
                {deleting ? "Deleting…" : confirmDelete ? "Sure? Click again" : "Delete agent"}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleRunNow}
                disabled={running}
                style={{ opacity: running ? .6 : 1 }}
              >
                {running ? "Starting…" : "Run now"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── stat strip ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--canvas)" }}>
        <div className="container">
          <div style={{ display: "flex", gap: "var(--s7)", padding: "var(--s3) 0", flexWrap: "wrap" }}>
            {[
              { label: "nodes",       value: String(nodes.length)                          },
              { label: "edges",       value: String(edges.length)                          },
              { label: "total runs",  value: String(runs.length)                           },
              { label: "total spent", value: `${totalSpent}¢`                             },
              { label: "budget",      value: `${manifest.runBudgetCents}¢ / run`          },
              { label: "built",       value: timeAgo(agent.createdAt)                     },
            ].map(s => (
              <div key={s.label} style={{ display: "flex", gap: "var(--s2)", alignItems: "baseline" }}>
                <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{s.value}</span>
                <span className="small muted">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── tabs ── */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <div className="container">
          <div style={{ display: "flex", gap: 0 }}>
            {(["graph", "runs", "schedules", "memory"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: "var(--s3) var(--s4)", border: "none", background: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 500,
                color: tab === t ? "var(--brand)" : "var(--ink-muted)",
                borderBottom: tab === t ? "2px solid var(--brand)" : "2px solid transparent",
                marginBottom: -1,
              }}>
                {t === "graph" ? "Graph" : t === "runs" ? `Runs (${runs.length})` : t === "schedules" ? "Schedules" : "Memory"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── content ── */}
      <div className="container" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s9)" }}>

        {/* Graph tab */}
        {tab === "graph" && (
          <div style={{ display: "grid", gridTemplateColumns: selectedNodeObj ? "1fr 300px" : "1fr", gap: "var(--s5)", alignItems: "start" }}>
            {nodes.length === 0 ? (
              <div className="card" style={{ padding: "var(--s7)", textAlign: "center", background: "var(--danger-tint)", border: "1px solid rgba(185,28,28,.2)" }}>
                <p style={{ fontSize: 14, color: "var(--danger)", fontWeight: 600, marginBottom: "var(--s2)" }}>No nodes in this manifest</p>
                <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>This agent&apos;s manifest is incomplete. Delete it and build a new one.</p>
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
        )}

        {/* Runs tab */}
        {tab === "runs" && (
          <div>
            {runs.length === 0 ? (
              <div style={{ padding: "var(--s7)", textAlign: "center", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)", color: "var(--ink-muted)" }}>
                <p style={{ marginBottom: "var(--s2)" }}>No runs yet.</p>
                <p className="small muted">Click "Run now" to start the first execution.</p>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {runs.map((r, i) => {
                  const runColor = r.status === "completed" ? "var(--ok)" : r.status === "failed" ? "var(--danger)" : r.status === "running" ? "var(--live)" : "var(--paused)";
                  return (
                    <a key={r.runId} href={`/runs/${r.runId}`} style={{
                      display: "grid", gridTemplateColumns: "auto 1fr auto auto",
                      gap: "var(--s4)", padding: "var(--s4)",
                      borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      textDecoration: "none", color: "var(--ink)", alignItems: "center",
                    }}>
                      <span className={`status-dot ${r.status === "completed" ? "done" : r.status}`} style={{ width: 8, height: 8 }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{r.manifestName}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{r.runId}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: runColor }}>{r.status}</div>
                        <div className="small muted">{timeAgo(r.createdAt)}</div>
                      </div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: r.spentCents != null ? "var(--ink)" : "var(--ink-muted)", textAlign: "right", minWidth: 44 }}>
                        {r.spentCents != null ? `${r.spentCents}¢` : "—"}
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
            {runs.length > 0 && (
              <div style={{ marginTop: "var(--s4)", display: "flex", justifyContent: "flex-end" }}>
                <a href="/runs" className="small" style={{ color: "var(--brand)" }}>See all runs →</a>
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
