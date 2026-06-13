"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  listAgents, listRuns, buildAgent, startRun, deleteAgent, explainRun, explainBuild, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult, type ManifestNode, type ManifestEdge,
} from "../lib/api";

const EXAMPLES: { text: string; label: string; hero?: boolean }[] = [
  {
    text: "Investigate why our API error rate spiked in the last hour — correlate with recent deploys, trace the top failing endpoints, and draft an incident summary",
    label: "Incident triage",
    hero: true,
  },
  {
    text: "Monitor our deploy pipeline — if error rate exceeds 5% in the first 10 minutes, roll back and page the on-call engineer",
    label: "Deploy watchdog",
  },
  {
    text: "Review the last 3 failed customer onboarding sessions and identify where each dropped off",
    label: "Onboarding analysis",
  },
  {
    text: "Investigate why checkout conversion dropped this week — compare funnel metrics against last week",
    label: "Conversion drop",
  },
];

const BUILD_STAGES = ["Proposing graph…", "Validating…", "Finalising agent…"];

// ── Mini graph preview ────────────────────────────────────────────────────────

interface MiniNodePos { x: number; y: number; }

const MNW = 56;
const MNH = 30;
const MHG = 32;
const MVG = 20;

function miniLayout(nodes: ManifestNode[], edges: ManifestEdge[], entry: string): Map<string, MiniNodePos> {
  const layer = new Map<string, number>();
  const visited = new Set<string>();

  function visit(id: string, depth: number) {
    if (!visited.has(id) || (layer.get(id) ?? 0) < depth) {
      layer.set(id, depth);
      visited.add(id);
      for (const e of edges) if (e.from === id) visit(e.to, depth + 1);
    }
  }
  visit(entry, 0);
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

function MiniGraph({ nodes, edges, entry }: { nodes: ManifestNode[]; edges: ManifestEdge[]; entry: string }) {
  if (nodes.length === 0) return null;
  const positions = miniLayout(nodes, edges, entry);

  let maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + MNW);
    maxY = Math.max(maxY, p.y + MNH);
  }
  const vw = maxX + MHG;
  const vh = Math.max(maxY + MVG, 50);

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${vw} ${vh}`}
        width="100%"
        style={{ display: "block", maxHeight: 70, overflow: "visible" }}
        aria-hidden
      >
        <defs>
          <marker id="mg-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2" orient="auto">
            <path d="M0,0 L0,4 L5,2 z" fill="var(--line-strong)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const fp = positions.get(e.from);
          const tp = positions.get(e.to);
          if (!fp || !tp) return null;
          const x1 = fp.x + MNW, y1 = fp.y + MNH / 2;
          const x2 = tp.x, y2 = tp.y + MNH / 2;
          const cx = (x1 + x2) / 2;
          return (
            <path key={i} d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
              fill="none" stroke="var(--line-strong)" strokeWidth={1.2}
              markerEnd="url(#mg-arrow)" />
          );
        })}
        {nodes.map(n => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isEntry = n.id === entry;
          const caps = n.capabilities;
          const dotColor = caps.some(c => c.name === "think") ? "var(--brand)"
            : caps.some(c => c.name === "remember" || c.name === "recall") ? "var(--ok)"
            : "var(--ink-muted)";
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <rect width={MNW} height={MNH} rx={5}
                fill="var(--surface)"
                stroke={isEntry ? "var(--brand)" : "var(--line-strong)"}
                strokeWidth={isEntry ? 1.8 : 1.2}
              />
              <circle cx={MNW / 2} cy={MNH / 2} r={4} fill={dotColor} opacity={0.7} />
            </g>
          );
        })}
      </svg>
      {/* node count overlay */}
      <div style={{
        position: "absolute", bottom: 2, right: 4,
        fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--ink-muted)",
        background: "rgba(248,247,244,.8)", padding: "1px 4px", borderRadius: 3,
      }}>
        {nodes.length} node{nodes.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

// ── Build preview modal ───────────────────────────────────────────────────────

const MFN_W = 140;
const MFN_H = 64;
const MFH_G = 64;
const MFV_G = 44;

function FullMiniGraph({ nodes, edges, entry }: { nodes: ManifestNode[]; edges: ManifestEdge[]; entry: string }) {
  const positions = miniLayout(nodes.map(n => ({ ...n })), edges, entry);

  let maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x * (MFN_W / MNW) + MFN_W);
    maxY = Math.max(maxY, p.y * (MFN_H / MNH) + MFN_H);
  }

  const scaledPositions = new Map<string, MiniNodePos>();
  for (const [id, p] of positions.entries()) {
    scaledPositions.set(id, {
      x: p.x * (MFN_W + MFH_G) / (MNW + MHG),
      y: p.y * (MFN_H + MFV_G) / (MNH + MVG),
    });
  }

  const vw = maxX + MFH_G;
  const vh = Math.max(maxY + MFV_G, 100);

  const CAP_ICON: Record<string, string> = {
    think: "🧠", recall: "📚", remember: "💾", llm_route: "🔀",
    web_search: "🔍", compose: "✍️", telegram_send: "📨", http_get: "🌐",
    email_send: "📧", slack_send: "💬", http_post: "📤", notify_webhook: "🔔",
  };

  return (
    <svg viewBox={`0 0 ${vw} ${vh}`} width="100%" style={{ display: "block", maxHeight: 220 }} aria-hidden>
      <defs>
        <marker id="fp-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="var(--ink-muted)" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const fp = scaledPositions.get(e.from);
        const tp = scaledPositions.get(e.to);
        if (!fp || !tp) return null;
        const x1 = fp.x + MFN_W, y1 = fp.y + MFN_H / 2;
        const x2 = tp.x, y2 = tp.y + MFN_H / 2;
        const cx = (x1 + x2) / 2;
        return (
          <path key={i} d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
            fill="none" stroke="var(--line-strong)" strokeWidth={1.5}
            markerEnd="url(#fp-arrow)" />
        );
      })}
      {nodes.map(n => {
        const p = scaledPositions.get(n.id);
        if (!p) return null;
        const isEntry = n.id === entry;
        const icons = n.capabilities.slice(0, 2).map(c => CAP_ICON[c.name] ?? "⚙️").join(" ");
        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`}>
            <rect width={MFN_W} height={MFN_H} rx={7}
              fill="var(--surface)"
              stroke={isEntry ? "var(--brand)" : "var(--line-strong)"}
              strokeWidth={isEntry ? 2 : 1.5}
            />
            {isEntry && <rect width={MFN_W} height={3} rx={1.5} fill="var(--brand)" />}
            <text x={MFN_W / 2} y={22} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink)" fontFamily="var(--font-sans)">
              {n.id.length > 14 ? n.id.slice(0, 13) + "…" : n.id}
            </text>
            <text x={MFN_W / 2} y={38} textAnchor="middle" fontSize={12} fill="var(--ink-muted)">
              {icons || "○"}
            </text>
            <text x={MFN_W / 2} y={54} textAnchor="middle" fontSize={8.5} fill="var(--brand)" fontFamily="var(--font-mono)">
              {n.capabilities.map(c => c.name).join(" · ")}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function BuildPreviewModal({ result, onRun, onDiscard }: { result: BuildResult; onRun: () => void; onDiscard: () => void }) {
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
            <h2 id="build-preview-title" style={{ fontSize: 18, fontWeight: 700, marginBottom: "var(--s1)" }}>
              Agent compiled — review before running
            </h2>
            <p className="soft small">
              {agent.signed.manifest.name} · {graph.nodes.length} node{graph.nodes.length !== 1 ? "s" : ""} · {graph.edges.length} edge{graph.edges.length !== 1 ? "s" : ""} · {agent.signed.manifest.runBudgetCents}¢ budget
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onDiscard}
            aria-label="Close"
            style={{
              border: "none", background: "none", cursor: "pointer",
              color: "var(--ink-muted)", fontSize: 20, lineHeight: 1,
              padding: "8px", borderRadius: "var(--r)", flexShrink: 0,
              transition: "background 120ms",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-sunken)")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}
          >
            ×
          </button>
        </div>

        {attempts > 1 && (
          <div style={{ marginBottom: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--live-tint)", borderRadius: "var(--r)", fontSize: 12, color: "var(--live)" }}>
            Self-corrected: succeeded on attempt {attempts} of 3
          </div>
        )}

        {warnings.map((w, i) => (
          <div key={i} style={{ marginBottom: "var(--s3)", padding: "var(--s3) var(--s4)", background: "var(--brand-tint)", borderRadius: "var(--r)", fontSize: 12, color: "var(--brand)" }}>
            {w}
          </div>
        ))}

        <div style={{ background: "var(--graph-bg)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "var(--s4)", marginBottom: "var(--s4)", overflow: "auto" }}>
          <FullMiniGraph nodes={graph.nodes} edges={graph.edges} entry={graph.entry} />
        </div>

        {/* architect's rationale — why this graph */}
        <div style={{
          marginBottom: "var(--s5)", padding: "var(--s4)",
          background: "var(--brand-tint)", borderRadius: "var(--r)",
          border: "1px solid rgba(14,124,117,.15)",
          minHeight: 52, display: "flex", alignItems: "flex-start", gap: "var(--s3)",
        }}>
          <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>✦</span>
          {rationaleLoading ? (
            <span style={{ fontSize: 13, color: "var(--brand)", fontStyle: "italic" }}>Understanding the design…</span>
          ) : rationale ? (
            <p style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.65, margin: 0 }}>{rationale}</p>
          ) : null}
        </div>

        <div style={{ marginBottom: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          {graph.nodes.map(n => (
            <div key={n.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--s2) var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 12, color: "var(--ink)", flexShrink: 0 }}>{n.id}</span>
                {n.id === graph.entry && <span style={{ fontSize: 10, padding: "2px 6px", background: "var(--brand-tint)", color: "var(--brand)", borderRadius: "var(--r-pill)", fontWeight: 600, flexShrink: 0 }}>entry</span>}
                <span style={{ fontSize: 11, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.role.slice(0, 60)}{n.role.length > 60 ? "…" : ""}</span>
              </div>
              <div style={{ display: "flex", gap: "var(--s1)", flexWrap: "wrap", flexShrink: 0, marginLeft: "var(--s3)" }}>
                {n.capabilities.map(c => (
                  <span key={c.name} style={{ fontSize: 10, padding: "2px 6px", background: "var(--brand-tint)", color: "var(--brand)", borderRadius: "var(--r-pill)" }}>{c.name}</span>
                ))}
              </div>
            </div>
          ))}
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

function AgentCard({ agent, agentRuns, onRun, onDelete, summary }: {
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
        className="card"
        style={{ padding: "var(--s5)", minHeight: 200, display: "flex", flexDirection: "column", gap: "var(--s4)", cursor: "pointer", transition: "box-shadow 140ms ease, transform 140ms ease" }}
        onMouseEnter={e => { e.currentTarget.style.boxShadow = "var(--shadow-md)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
        onMouseLeave={e => { e.currentTarget.style.boxShadow = "var(--shadow-sm)"; e.currentTarget.style.transform = "translateY(0)"; }}
      >
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {agent.signed.manifest.name}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexShrink: 0 }}>
            <a
              href={`/canvas/${agent.id}`}
              onClick={e => e.stopPropagation()}
              title="Open canvas"
              style={{ fontSize: 11, color: "var(--brand)", fontWeight: 600, padding: "2px 7px", background: "var(--brand-tint)", borderRadius: "var(--r-pill)", textDecoration: "none", lineHeight: 1.6 }}
            >
              Canvas ↗
            </a>
            <span className={`badge badge-${status === "completed" ? "done" : status === "running" ? "running" : "neutral"}`}>
              {status === "running" && <span className="dot" />}{status}
            </span>
          </div>
        </div>

        {/* mini graph */}
        {nodes.length > 0 && (
          <div style={{
            background: "var(--graph-bg)", borderRadius: 6,
            border: "1px solid var(--line)", padding: "var(--s3)",
            overflow: "hidden", maxHeight: 90,
          }}>
            <MiniGraph nodes={nodes} edges={edges} entry={agent.signed.manifest.entry} />
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
                style={{ fontSize: 11, color: "var(--brand)", fontWeight: 500, display: "inline-block", marginTop: 4 }}
              >
                View reasoning trace →
              </a>
            )}
          </div>
        ) : (
          <p className="small soft" style={{ lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", flex: 1 }}>
            {summary === null ? (
              <span style={{ color: "var(--ink-muted)", fontStyle: "italic" }}>Generating summary…</span>
            ) : agent.signed.provenance.intent}
          </p>
        )}

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {lastRun && <div className="small muted">{timeAgo(lastRun.createdAt)}</div>}
            {lastRun?.spentCents != null && <div className="mono" style={{ fontSize: 11, color: "var(--brand)" }}>{lastRun.spentCents}¢ last run</div>}
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            <button
              onClick={handleDeleteClick}
              disabled={deleting || status === "running"}
              className="btn btn-sm"
              style={{
                fontSize: 11,
                background: confirmDelete ? "var(--danger-tint)" : "transparent",
                color: confirmDelete ? "var(--danger)" : "var(--ink-muted)",
                border: confirmDelete ? "1px solid var(--danger)" : "1px solid var(--line)",
                transition: "background 150ms, color 150ms, border-color 150ms",
                minWidth: 60,
                opacity: (deleting || status === "running") ? 0.4 : 1,
              }}
            >
              {deleting ? "…" : confirmDelete ? "Sure?" : "Delete"}
            </button>
            <button
              onClick={handleRunClick}
              className="btn btn-sm"
              style={{
                fontSize: 11,
                background: confirmRun ? "var(--live-tint)" : "var(--brand)",
                color: confirmRun ? "var(--live)" : "white",
                border: confirmRun ? "1px solid var(--live)" : "none",
                transition: "background 150ms, color 150ms",
                minWidth: 72,
              }}
            >
              {confirmRun ? "Confirm?" : "Run now"}
            </button>
          </div>
        </div>
      </div>
    </a>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeFocused, setComposeFocused] = useState(false);
  // runId → summary text (null = generating, string = done, key absent = not started)
  const [summaries, setSummaries] = useState<Record<string, string | null>>({});
  const fetchingSummaries = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([listAgents(), listRuns()]);
      setAgents(a);
      setRuns(r);
    } catch { /* API not yet reachable */ }
    finally { setLoading(false); }
  }, []);

  // Auto-fetch summaries for completed runs whose agents still exist
  useEffect(() => {
    for (const run of runs) {
      if (run.status !== "completed") continue;
      if (fetchingSummaries.current.has(run.runId)) continue;
      if (summaries[run.runId] !== undefined) continue;
      fetchingSummaries.current.add(run.runId);
      setSummaries(prev => ({ ...prev, [run.runId]: null }));
      void explainRun(run.runId)
        .then(res => {
          const firstLine = res.explanation.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 220);
          setSummaries(prev => ({ ...prev, [run.runId]: firstLine }));
        })
        .catch(() => {
          setSummaries(prev => { const n = { ...prev }; delete n[run.runId]; return n; });
          fetchingSummaries.current.delete(run.runId);
        });
    }
  }, [runs, summaries]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  // Cycle build stage messages while building
  useEffect(() => {
    if (!building) { setBuildStage(0); return; }
    const t = setInterval(() => setBuildStage(s => (s + 1) % BUILD_STAGES.length), 3500);
    return () => clearInterval(t);
  }, [building]);

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (!intent.trim() || building) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await buildAgent(intent.trim());
      setBuildResult(result);
      setIntent("");
      await reload();
    } catch (err) {
      setBuildError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  async function handleRunBuilt() {
    if (!buildResult) return;
    const agentId = buildResult.agent.id;
    const savedResult = buildResult;
    setBuildResult(null);
    try {
      const run = await startRun(agentId);
      await reload();
      // Go to canvas — the home of the visual graph — with the live run pre-selected
      router.push(`/canvas/${agentId}?run=${run.runId}`);
    } catch (err) {
      setBuildError((err as Error).message);
      setBuildResult(savedResult);
    }
  }

  const running = runs.filter(r => r.status === "running").length;
  const totalSpent = runs.reduce((s, r) => s + (r.spentCents ?? 0), 0);
  const recentRuns = runs.slice(0, 6);

  return (
    <div style={{ minHeight: "100vh" }}>

      {buildResult && (
        <BuildPreviewModal
          result={buildResult}
          onRun={handleRunBuilt}
          onDiscard={() => setBuildResult(null)}
        />
      )}

      {/* ── composer hero ── */}
      <section style={{ background: "var(--canvas)", paddingTop: "var(--s9)", paddingBottom: "var(--s8)" }}>
        <div className="container" style={{ maxWidth: 680, textAlign: "center" }}>
          <p className="micro" style={{ marginBottom: "var(--s4)" }}>Your AI agent workspace</p>
          <h1 style={{ fontSize: 36, fontWeight: 600, letterSpacing: "-.02em", lineHeight: 1.2, marginBottom: "var(--s4)", color: "var(--ink)" }}>
            Agents that reason, decide,<br />and show their work
          </h1>
          <p className="soft" style={{ fontSize: 16, maxWidth: "48ch", margin: "0 auto var(--s7)", lineHeight: 1.7 }}>
            Describe an outcome in plain English. Krelvan builds a signed, tamper-evident agent that investigates, branches, and acts.
          </p>

          <form
            onSubmit={(e) => void handleBuild(e)}
            style={{
              background: "var(--surface)",
              border: `1.5px solid ${composeFocused ? "var(--brand)" : "var(--line-strong)"}`,
              borderRadius: 16, padding: "var(--s5)",
              boxShadow: composeFocused ? `var(--shadow-md), 0 0 0 4px var(--brand-ring)` : "var(--shadow-sm)",
              textAlign: "left",
              transition: "border-color 150ms, box-shadow 150ms",
            }}
          >
            <textarea
              value={intent}
              onChange={e => { setIntent(e.target.value); if (buildError) setBuildError(null); }}
              onFocus={() => setComposeFocused(true)}
              onBlur={() => setComposeFocused(false)}
              placeholder="e.g. Review this contract and tell me what we should negotiate before signing"
              rows={4}
              style={{
                width: "100%", resize: "none", border: "none", outline: "none",
                fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--ink)",
                background: "transparent", lineHeight: 1.65, marginBottom: "var(--s4)",
              }}
            />

            {/* suggestion tiles */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--s2)", marginBottom: "var(--s4)" }}>
              {/* hero tile — full width */}
              <button
                type="button"
                onClick={() => setIntent(EXAMPLES[0].text)}
                style={{
                  gridColumn: "1 / -1", textAlign: "left", cursor: "pointer",
                  background: "var(--brand-tint)", border: "1px solid rgba(14,124,117,.2)",
                  borderRadius: "var(--r)", padding: "var(--s3) var(--s4)",
                  display: "flex", flexDirection: "column", gap: 4,
                  transition: "background 120ms, border-color 120ms",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(14,124,117,.1)"; e.currentTarget.style.borderColor = "var(--brand)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "var(--brand-tint)"; e.currentTarget.style.borderColor = "rgba(14,124,117,.2)"; }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--brand)", textTransform: "uppercase", letterSpacing: ".07em" }}>{EXAMPLES[0].label}</span>
                <span style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.55 }}>{EXAMPLES[0].text}</span>
              </button>
              {/* 3 regular tiles */}
              {EXAMPLES.slice(1).map(ex => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setIntent(ex.text)}
                  style={{
                    textAlign: "left", cursor: "pointer",
                    background: "var(--surface-sunken)", border: "1px solid var(--line)",
                    borderRadius: "var(--r)", padding: "var(--s3) var(--s3)",
                    display: "flex", flexDirection: "column", gap: 3,
                    transition: "background 120ms, border-color 120ms, box-shadow 120ms",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--surface)"; e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.boxShadow = "var(--shadow-sm)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--surface-sunken)"; e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.boxShadow = "none"; }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: ".07em" }}>{ex.label}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 }}>{ex.text}</span>
                </button>
              ))}
            </div>

            {buildError && (
              <div
                role="alert"
                style={{ marginBottom: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--danger-tint)", borderRadius: "var(--r)", fontSize: 13, color: "var(--danger)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}
              >
                <span>{buildError}</span>
                <button
                  onClick={() => setBuildError(null)}
                  aria-label="Dismiss error"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", fontSize: 16, lineHeight: 1, flexShrink: 0, padding: "0 2px" }}
                >×</button>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "var(--s4)", borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12, color: "var(--ink-muted)", minHeight: 18 }}>
                {building && (
                  <span style={{ animation: "fade-in 300ms ease forwards" }}>
                    {BUILD_STAGES[buildStage]}
                  </span>
                )}
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={!intent.trim() || building}
                style={{ minWidth: 140 }}
              >
                {building ? "Building…" : "Build agent →"}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* ── stat strip ── */}
      <div style={{ borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <div className="container">
          <div style={{ display: "flex", gap: "var(--s8)", padding: "var(--s4) 0", flexWrap: "wrap", alignItems: "center" }}>
            {[
              { label: "agents",       value: String(agents.length), live: false },
              { label: "running now",  value: String(running),       live: running > 0 },
              { label: "total runs",   value: String(runs.length),   live: false },
              { label: "total spent",  value: `${totalSpent}¢`,      live: false },
            ].map(s => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                {s.live && <span className="status-dot running" />}
                <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: s.live ? "var(--live)" : "var(--ink)" }}>{s.value}</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── agents + activity ── */}
      <section className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "var(--s7)", alignItems: "start" }}>

          {/* agent cards */}
          <div>
            <h2 style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", marginBottom: "var(--s5)", letterSpacing: ".06em", textTransform: "uppercase" }}>Your agents</h2>

            {loading && <p className="soft small">Loading…</p>}

            {!loading && agents.length === 0 && (
              <div style={{ padding: "var(--s9)", textAlign: "center", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r-lg)", background: "var(--surface)" }}>
                <div style={{ fontSize: 32, marginBottom: "var(--s5)", opacity: 0.5 }}>✦</div>
                <p style={{ fontSize: 16, fontWeight: 600, marginBottom: "var(--s3)", color: "var(--ink)" }}>Build your first agent</p>
                <p className="soft" style={{ fontSize: 14, maxWidth: "34ch", margin: "0 auto var(--s6)", lineHeight: 1.65 }}>Describe a goal above. Your first agent compiles in ~30 seconds and is ready to run immediately.</p>
                <button
                  className="btn btn-primary"
                  onClick={() => { const ta = document.querySelector<HTMLTextAreaElement>("textarea"); ta?.focus(); ta?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                >
                  Describe a goal →
                </button>
              </div>
            )}

            {agents.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s5)" }}>
                {agents.map(a => {
                  const agentRuns = runs.filter(r => r.agentId === a.id);
                  const lastCompletedRun = agentRuns.find(r => r.status === "completed");
                  const cardSummary = lastCompletedRun ? (summaries[lastCompletedRun.runId] ?? null) : undefined;
                  return (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    agentRuns={agentRuns}
                    summary={cardSummary}
                    onRun={() => { void startRun(a.id).then(r => { void reload(); router.push(`/canvas/${a.id}?run=${r.runId}`); }); }}
                    onDelete={() => { void reload(); }}
                  />
                  );
                })}
                <a
                  href="#"
                  onClick={e => { e.preventDefault(); const ta = document.querySelector<HTMLTextAreaElement>("textarea"); ta?.focus(); ta?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    minHeight: 200, border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)",
                    color: "var(--ink-muted)", fontSize: 13, fontWeight: 500, gap: "var(--s2)",
                    textDecoration: "none", transition: "border-color 120ms, color 120ms",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--brand)"; e.currentTarget.style.color = "var(--brand)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.color = "var(--ink-muted)"; }}
                >
                  <span style={{ fontSize: 20, lineHeight: 1 }}>+</span> New agent
                </a>
              </div>
            )}
          </div>

          {/* recent runs */}
          <div>
            <h2 style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", marginBottom: "var(--s5)", letterSpacing: ".06em", textTransform: "uppercase" }}>Recent runs</h2>
            {recentRuns.length === 0 && <p className="soft small">No runs yet.</p>}
            {recentRuns.length > 0 && (
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {recentRuns.map((r, i) => (
                  <a
                    key={r.runId}
                    href={`/runs/${r.runId}`}
                    style={{
                      display: "flex", gap: "var(--s3)", padding: "var(--s3) var(--s4)",
                      borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      textDecoration: "none", color: "var(--ink)",
                      transition: "background 100ms",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span className={`status-dot ${r.status === "completed" ? "done" : r.status === "failed" ? "failed" : r.status === "running" ? "running" : "paused"}`} style={{ marginTop: 5, flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.manifestName}</div>
                      <div style={{ display: "flex", gap: "var(--s3)", marginTop: 1 }}>
                        <span className="small muted">{timeAgo(r.createdAt)}</span>
                        {r.spentCents != null && r.spentCents > 0 && (
                          <span className="mono" style={{ fontSize: 11, color: "var(--brand)" }}>{r.spentCents}¢</span>
                        )}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
            <div style={{ marginTop: "var(--s3)" }}>
              <a href="/runs" className="small" style={{ color: "var(--brand)" }}>All runs →</a>
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
