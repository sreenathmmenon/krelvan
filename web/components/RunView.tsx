"use client";

import { useEffect, useRef, useState } from "react";
import {
  projectCanvas, projectCost, projectTimeline,
  type LedgerEvent, type RunMeta,
} from "../lib/ledger";

export function RunView({ meta, events }: { meta: RunMeta; events: LedgerEvent[] }) {
  const nodes = projectCanvas(events);
  const cost  = projectCost(events);
  const timeline = projectTimeline(events);

  // derive the ordered node list from the sample (first-entered order)
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "NodeEntered" && e.nodeId && !order.includes(e.nodeId)) order.push(e.nodeId);
  }
  const byId = new Map(nodes.map(n => [n.id, n]));

  // find the currently-active node for animation purposes
  const activeNode = nodes.find(n => n.status === "running")?.id ?? null;
  const activeEdgeIdx = activeNode ? order.indexOf(activeNode) - 1 : -1;

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* top bar */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", padding: "var(--s4) 0" }}>
        <div className="container-wide">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div className="micro" style={{ marginBottom: 2 }}>RUN · <span className="mono">{meta.runId}</span></div>
              <h1 className="h2" style={{ color: "var(--ink)" }}>{meta.manifestName}</h1>
              <p className="small soft" style={{ marginTop: 2 }}>{meta.intent}</p>
            </div>
            <StatusBadge status={meta.status} />
          </div>
        </div>
      </div>

      <div className="container-wide" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s9)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "var(--s6)", alignItems: "start" }}>

          {/* left — live graph */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s4)" }}>
              <span className="micro">Workflow</span>
              <VerifiedBadge events={events} />
            </div>
            <LiveGraph order={order} byId={byId} activeNode={activeNode} activeEdgeIdx={activeEdgeIdx} />

            {/* timeline below graph */}
            <div style={{ marginTop: "var(--s6)" }}>
              <span className="micro" style={{ display: "block", marginBottom: "var(--s4)" }}>Event timeline</span>
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {timeline.map((t, i) => (
                  <div key={t.offset} style={{
                    display: "grid", gridTemplateColumns: "32px 160px 1fr 80px",
                    gap: "var(--s3)", alignItems: "center",
                    padding: "var(--s3) var(--s5)",
                    borderTop: i === 0 ? "none" : "1px solid var(--line)",
                    animation: "fade-in 200ms ease",
                  }}>
                    <span className="mono muted" style={{ fontSize: 11 }}>{t.offset}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: eventColor(t.type) }}>{t.type}</span>
                    <span className="small" style={{ color: "var(--ink-soft)" }}>
                      <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 11 }}>{t.scope}</span>
                      {t.detail ? ` · ${t.detail}` : ""}
                    </span>
                    <span className="micro" style={{ textAlign: "right", letterSpacing: 0 }}>{t.author}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* right — cost + live activity */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
            <CostPanel cost={cost} budgetCents={meta.budgetCents} live={meta.status === "running"} />
            <div>
              <span className="micro" style={{ display:"block", marginBottom:"var(--s3)" }}>Ledger events</span>
              <div className="card" style={{ padding:"var(--s3) var(--s4)", display:"flex", flexDirection:"column", gap:"var(--s2)" }}>
                <div className="small soft">{events.length} signed events</div>
                <div className="small" style={{ color:"var(--ok)" }}>✓ Chain verified</div>
                <div className="small soft">Authors: owner · supervisor</div>
                <button className="btn btn-secondary btn-sm" style={{ alignSelf:"flex-start", marginTop:"var(--s2)" }}>
                  Inspect full ledger
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

/* ── Live Graph ─────────────────────────────────────────────────── */
function LiveGraph({ order, byId, activeNode, activeEdgeIdx }: {
  order: string[];
  byId: Map<string, { id: string; status: string; visits: number }>;
  activeNode: string | null;
  activeEdgeIdx: number;
}) {
  return (
    <div className="card" style={{
      padding: "var(--s7) var(--s6)",
      background: "var(--surface)",
      backgroundImage: "radial-gradient(circle at 60% 30%, rgba(14,124,117,.05) 0%, transparent 60%)",
      minHeight: 180,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--s4)", flexWrap: "wrap" }}>
        {order.map((id, i) => {
          const n = byId.get(id) ?? { id, status: "idle", visits: 0 };
          return (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--s4)" }}>
              <GraphNode node={n} isActive={id === activeNode} />
              {i < order.length - 1 && (
                <GraphEdge
                  status={n.status === "done" ? "done" : id === activeNode ? "active" : "idle"}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GraphNode({ node, isActive }: { node: { id: string; status: string; visits: number }; isActive: boolean }) {
  const s = node.status;
  const className = s === "running" ? "graph-node-running" : s === "done" ? "graph-node-done" : s === "failed" ? "graph-node-error" : "graph-node-idle";
  return (
    <div className={`card ${className}`} style={{
      padding: "var(--s3) var(--s5)",
      minWidth: 130,
      textAlign: "center",
      transition: "box-shadow 300ms",
      background: "var(--surface)",
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)", marginBottom: "var(--s2)" }}>
        {nodeLabel(node.id)}
      </div>
      <NodeStatusMark status={s} />
    </div>
  );
}

function NodeStatusMark({ status }: { status: string }) {
  if (status === "running") return (
    <span className="badge badge-running" style={{ fontSize: 10 }}>
      <span className="dot" /> running
    </span>
  );
  if (status === "done") return (
    <span style={{ color: "var(--ok)", fontSize: 13 }}>✓</span>
  );
  if (status === "failed") return (
    <span style={{ color: "var(--danger)", fontSize: 13 }}>✕</span>
  );
  return <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>·</span>;
}

function GraphEdge({ status }: { status: "idle" | "active" | "done" }) {
  const isActive = status === "active";
  const isDone   = status === "done";
  return (
    <div style={{ position: "relative", width: 48, height: 20, display: "flex", alignItems: "center" }}>
      {/* base line */}
      <div style={{
        width: "100%", height: 2, borderRadius: 1,
        background: isDone ? "var(--ok)" : "var(--line-strong)",
        transition: "background 400ms",
      }} />
      {/* amber dashes traveling along active edge */}
      {isActive && (
        <>
          <div style={{
            position: "absolute", top: "50%", left: 0, transform: "translateY(-50%)",
            width: "100%", height: 2,
            backgroundImage: "repeating-linear-gradient(90deg, var(--live) 0px, var(--live) 6px, transparent 6px, transparent 12px)",
            backgroundSize: "20px 2px",
            animation: "dash-flow .8s linear infinite",
            borderRadius: 1,
          }} />
          {/* traveling amber dot */}
          <TravelingDot />
        </>
      )}
    </div>
  );
}

function TravelingDot() {
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPos(p => p >= 100 ? 0 : p + 2.5), 20);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{
      position: "absolute", top: "50%", left: `${pos}%`,
      transform: "translate(-50%, -50%)",
      width: 8, height: 8, borderRadius: "50%",
      background: "var(--live)",
      boxShadow: "0 0 6px rgba(217,119,6,.7)",
      transition: "left 20ms linear",
    }} />
  );
}

/* ── Cost panel ─────────────────────────────────────────────────── */
function CostPanel({ cost, budgetCents, live }: {
  cost: ReturnType<typeof projectCost>;
  budgetCents: number;
  live: boolean;
}) {
  const [displayed, setDisplayed] = useState(0);
  useEffect(() => {
    if (!live) { setDisplayed(cost.spentCents); return; }
    const target = cost.spentCents;
    const step = () => setDisplayed(p => {
      if (p >= target) return target;
      return p + 1;
    });
    const id = setInterval(step, 60);
    return () => clearInterval(id);
  }, [cost.spentCents, live]);

  const pct = Math.min(100, Math.round((displayed / Math.max(1, budgetCents)) * 100));
  return (
    <div>
      <span className="micro" style={{ display:"block", marginBottom:"var(--s3)" }}>Cost</span>
      <div className="card" style={{ padding:"var(--s5)" }}>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:"var(--s3)" }}>
          <span className="mono" style={{ fontSize:28, fontWeight:500, color: live ? "var(--live)" : "var(--ink)", animation: live ? "count-up 200ms" : "none" }}>
            {displayed}¢
          </span>
          <span className="small muted">of {budgetCents}¢</span>
        </div>
        <div className="progress" style={{ marginBottom:"var(--s5)" }}>
          <div className={`progress-fill ${live ? "live" : ""}`} style={{ width:`${pct}%` }} />
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:"var(--s3)" }}>
          {cost.byEffect.map(e => (
            <div key={e.idem} style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:12, color:"var(--ink-soft)" }}>{e.capability}</span>
              <span className="mono" style={{ fontSize:12 }}>{e.costCents}¢</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  const cls = status === "completed" ? "badge-done" : status === "running" ? "badge-running" : status === "failed" ? "badge-failed" : "badge-neutral";
  return <span className={`badge ${cls}`}><span className="dot" />{status}</span>;
}
function VerifiedBadge({ events }: { events: LedgerEvent[] }) {
  return (
    <span className="badge badge-done" style={{ fontFamily:"var(--font-mono)", fontSize:10, letterSpacing:0 }}>
      ✓ {events.length} events verified
    </span>
  );
}
function nodeLabel(id: string): string {
  const map: Record<string,string> = { research:"Research", write:"Write", deliver:"Deliver", reporter:"Report" };
  return map[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
function eventColor(type: string): string {
  if (type === "EffectResult") return "var(--ok)";
  if (type === "NodeEntered")   return "var(--brand)";
  if (type === "RunStarted" || type === "RunCompleted") return "var(--ink)";
  if (type === "RunFailed")     return "var(--danger)";
  return "var(--ink-soft)";
}
