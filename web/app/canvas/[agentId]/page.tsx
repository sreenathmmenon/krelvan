"use client";

import { useState, useEffect, use, useRef, useReducer, useMemo } from "react";
import {
  getAgent, getAgentRuns, getRun, getRunEvents, startRun, timeAgo,
  type AgentRecord, type RunRecord, type RunDetail, type LedgerEvent,
  type ManifestNode, type ManifestEdge, type ManifestExpr, API_BASE,
} from "../../../lib/api";
import { layoutGraph, graphBounds, edgePath, type NodePos } from "../../../lib/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ViewXform { tx: number; ty: number; scale: number; }

// ── Edge condition label renderer ─────────────────────────────────────────────

function exprLabel(expr: ManifestExpr, depth = 0): string {
  if (depth > 3) return "…";
  switch (expr.op) {
    case "const": return expr.value === null ? "null" : String(expr.value);
    case "var":   return expr.key;
    case "eq":    return `${exprLabel(expr.left, depth+1)} = ${exprLabel(expr.right, depth+1)}`;
    case "ne":    return `${exprLabel(expr.left, depth+1)} ≠ ${exprLabel(expr.right, depth+1)}`;
    case "lt":    return `${exprLabel(expr.left, depth+1)} < ${exprLabel(expr.right, depth+1)}`;
    case "lte":   return `${exprLabel(expr.left, depth+1)} ≤ ${exprLabel(expr.right, depth+1)}`;
    case "gt":    return `${exprLabel(expr.left, depth+1)} > ${exprLabel(expr.right, depth+1)}`;
    case "gte":   return `${exprLabel(expr.left, depth+1)} ≥ ${exprLabel(expr.right, depth+1)}`;
    case "and":   return expr.clauses.map(c => exprLabel(c, depth+1)).join(" & ");
    case "or":    return expr.clauses.map(c => exprLabel(c, depth+1)).join(" | ");
    case "not":   return `!${exprLabel(expr.clause, depth+1)}`;
  }
}

// ── Capability icon map ────────────────────────────────────────────────────────

const CAP_ICON: Record<string, string> = {
  think: "🧠", recall: "📚", remember: "💾", llm_route: "🔀",
  web_search: "🔍", compose: "✍️", telegram_send: "✈️", http_get: "↓",
  http_post: "↑", email_send: "📧", text_transform: "🔤",
  identify: "🪪", slack_send: "💬", notify_webhook: "📡",
};

function capIcon(name: string): string {
  return CAP_ICON[name] ?? "⚡";
}

// ── Replay projection: fold events 0..cursor into node state ──────────────────

interface NodeSnapshot {
  entered: boolean;
  concluded: boolean;
  visits: number;
}

interface ReplayState {
  nodes: Record<string, NodeSnapshot>;
  perCapSpentCents: Record<string, number>;
  runSpentCents: number;
}

function replayUpTo(events: LedgerEvent[], cursor: number): ReplayState {
  const nodes: Record<string, NodeSnapshot> = {};
  const perCapSpentCents: Record<string, number> = {};
  let runSpentCents = 0;

  for (let i = 0; i <= cursor && i < events.length; i++) {
    const e = events[i]!;
    const nodeId = e.nodeId;

    if (e.type === "NodeEntered" && nodeId) {
      if (!nodes[nodeId]) nodes[nodeId] = { entered: false, concluded: false, visits: 0 };
      nodes[nodeId]!.entered = true;
    }
    if (e.type === "NodeConcluded" && nodeId) {
      if (!nodes[nodeId]) nodes[nodeId] = { entered: false, concluded: false, visits: 0 };
      nodes[nodeId]!.concluded = true;
      nodes[nodeId]!.visits = (nodes[nodeId]!.visits ?? 0) + 1;
    }
    if (e.type === "EffectResult" && nodeId) {
      const capKey = String((e.payload as Record<string, unknown>)["capabilityName"] ?? "");
      const costCents = Number((e.payload as Record<string, unknown>)["claimedCostCents"] ?? 0);
      if (capKey) {
        const k = `${nodeId}:${capKey}`;
        perCapSpentCents[k] = (perCapSpentCents[k] ?? 0) + costCents;
        runSpentCents += costCents;
      }
    }
  }
  return { nodes, perCapSpentCents, runSpentCents };
}

// ── Pan + zoom reducer ────────────────────────────────────────────────────────

type PanAction =
  | { type: "wheel"; dz: number; cx: number; cy: number }
  | { type: "pan_start"; x: number; y: number }
  | { type: "pan_move"; x: number; y: number }
  | { type: "pan_end" }
  | { type: "zoom_step"; factor: number; cx: number; cy: number }
  | { type: "reset"; containerW: number; containerH: number; graphW: number; graphH: number };

interface PanState extends ViewXform { dragging: boolean; lastX: number; lastY: number; }

function panReducer(state: PanState, action: PanAction): PanState {
  switch (action.type) {
    case "wheel": {
      // Clamp delta to avoid jumpy trackpad behaviour (trackpads send pixels, mice send lines)
      const normalized = Math.max(-40, Math.min(40, action.dz));
      const factor = 1 - normalized * 0.008;
      const newScale = Math.max(0.15, Math.min(4, state.scale * factor));
      const sr = newScale / state.scale;
      return {
        ...state,
        scale: newScale,
        tx: action.cx - sr * (action.cx - state.tx),
        ty: action.cy - sr * (action.cy - state.ty),
      };
    }
    case "zoom_step": {
      const newScale = Math.max(0.15, Math.min(4, state.scale * action.factor));
      const sr = newScale / state.scale;
      return {
        ...state,
        scale: newScale,
        tx: action.cx - sr * (action.cx - state.tx),
        ty: action.cy - sr * (action.cy - state.ty),
      };
    }
    case "pan_start":
      return { ...state, dragging: true, lastX: action.x, lastY: action.y };
    case "pan_move":
      if (!state.dragging) return state;
      return { ...state, tx: state.tx + action.x - state.lastX, ty: state.ty + action.y - state.lastY, lastX: action.x, lastY: action.y };
    case "pan_end":
      return { ...state, dragging: false };
    case "reset": {
      const s = Math.min(1, (action.containerW - 64) / (action.graphW || 1), (action.containerH - 120) / (action.graphH || 1));
      return { ...state, scale: s, tx: (action.containerW - action.graphW * s) / 2, ty: (action.containerH - action.graphH * s) / 2 - 40, dragging: false, lastX: 0, lastY: 0 };
    }
  }
}

// ── Run selector dropdown ──────────────────────────────────────────────────────

function RunSelectorDropdown({ runs, selectedRunId, onSelect }: {
  runs: RunRecord[];
  selectedRunId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const selected = runs.find(r => r.runId === selectedRunId);
  const statusColor = (s: string) =>
    s === "running" ? "var(--live)" : s === "completed" ? "var(--ok)" : s === "failed" ? "var(--danger)" : "var(--ink-muted)";
  const statusDot = (s: string) =>
    s === "running" ? "⬤" : s === "completed" ? "✓" : s === "failed" ? "✗" : "○";

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: 12, padding: "5px 10px", borderRadius: "var(--r)",
          border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 6, minWidth: 180, maxWidth: 240,
        }}
      >
        {selected ? (
          <>
            <span style={{ color: statusColor(selected.status), fontSize: 10, flexShrink: 0 }}>{statusDot(selected.status)}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{selected.manifestName}</span>
            <span style={{ color: "var(--ink-muted)", flexShrink: 0, fontSize: 11 }}>{timeAgo(selected.createdAt)}</span>
          </>
        ) : (
          <span style={{ color: "var(--ink-soft)", flex: 1, textAlign: "left" }}>Blueprint (no run)</span>
        )}
        <span style={{ color: "var(--ink-muted)", fontSize: 9, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 260, zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)",
          boxShadow: "var(--shadow-md)", overflow: "hidden",
        }}>
          <div
            onClick={() => { onSelect(null); setOpen(false); }}
            style={{
              padding: "8px 12px", fontSize: 12, cursor: "pointer",
              borderBottom: "1px solid var(--line)",
              background: !selectedRunId ? "var(--brand-tint)" : "transparent",
              color: !selectedRunId ? "var(--brand)" : "var(--ink-soft)",
            }}
          >
            Blueprint only
          </div>
          {runs.map(r => (
            <div
              key={r.runId}
              onClick={() => { onSelect(r.runId); setOpen(false); }}
              style={{
                padding: "8px 12px", fontSize: 12, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
                borderBottom: "1px solid var(--line)",
                background: r.runId === selectedRunId ? "var(--brand-tint)" : "transparent",
              }}
              onMouseEnter={e => { if (r.runId !== selectedRunId) (e.currentTarget as HTMLDivElement).style.background = "var(--surface-hover)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = r.runId === selectedRunId ? "var(--brand-tint)" : "transparent"; }}
            >
              <span style={{ color: statusColor(r.status), fontSize: 11, flexShrink: 0 }}>{statusDot(r.status)}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: r.runId === selectedRunId ? 600 : 400 }}>{r.manifestName}</span>
              <span style={{ color: "var(--ink-muted)", fontSize: 11, flexShrink: 0 }}>{timeAgo(r.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CanvasPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ run?: string }> }) {
  const { agentId } = use(params);
  const { run: runFromUrl } = use(searchParams);

  const [agent, setAgent]       = useState<AgentRecord | null>(null);
  const [runs, setRuns]         = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail]     = useState<RunDetail | null>(null);
  const [events, setEvents]     = useState<LedgerEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [mode, setMode]         = useState<"blueprint" | "live">("blueprint");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showCost, setShowCost] = useState(false);
  const [scrubCursor, setScrubCursor] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [pan, dispatchPan] = useReducer(panReducer, {
    tx: 80, ty: 80, scale: 1, dragging: false, lastX: 0, lastY: 0,
  });

  // Canvas mount fade-in
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  // ── Load agent + runs ──────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      try {
        const [a, r] = await Promise.all([getAgent(agentId), getAgentRuns(agentId)]);
        setAgent(a);
        setRuns(r);
        // Pre-select run from URL param, else default to most recent
        const initial = runFromUrl ?? (r.length > 0 ? r[0]!.runId : null);
        setSelectedRunId(initial);
      } catch { /* agent not found */ }
      setLoading(false);
    }
    void load();
  }, [agentId]);

  // ── Load run detail + events when run selected ────────────────────────────

  useEffect(() => {
    if (!selectedRunId) { setDetail(null); setEvents([]); return; }
    async function loadRun() {
      const [d, evs] = await Promise.all([getRun(selectedRunId!), getRunEvents(selectedRunId!)]);
      setDetail(d);
      setEvents(evs);
      setScrubCursor(null);
      if (d.run.status === "running" || d.run.status === "pending") {
        setMode("live");
      }
    }
    void loadRun();
    setScrubCursor(null);
    setIsScrubbing(false);
  }, [selectedRunId]);

  // ── SSE for live runs ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedRunId || !detail) return;
    if (detail.run.status !== "running" && detail.run.status !== "pending") return;

    sseRef.current?.close();
    const es = new EventSource(`${API_BASE}/api/runs/${selectedRunId}/stream`);
    sseRef.current = es;

    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as LedgerEvent;
        setEvents(prev => prev.some(p => p.id === e.id) ? prev : [...prev, e]);
      } catch { /* ignore */ }
    };

    es.addEventListener("status", (msg: MessageEvent) => {
      try {
        const { status, finishedAt } = JSON.parse(msg.data) as { status: string; finishedAt?: number };
        setDetail(prev => prev ? { ...prev, run: { ...prev.run, status: status as RunRecord["status"], finishedAt } } : prev);
      } catch { /* ignore */ }
    });

    es.addEventListener("done", () => {
      es.close(); sseRef.current = null;
      void getRun(selectedRunId!).then(d => setDetail(d));
    });
    es.onerror = () => { es.close(); sseRef.current = null; };
    return () => { es.close(); sseRef.current = null; };
  }, [selectedRunId, detail?.run.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fit graph to viewport on first load ───────────────────────────────────

  const manifest = detail?.manifest ?? agent?.signed.manifest ?? null;
  const positions = useMemo(
    () => manifest ? layoutGraph(manifest.nodes, manifest.edges, manifest.entry) : new Map<string, NodePos>(),
    [manifest],
  );
  const { w: graphW, h: graphH } = graphBounds(positions);

  useEffect(() => {
    if (!containerRef.current || !manifest) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    dispatchPan({ type: "reset", containerW: width, containerH: height, graphW, graphH });
  }, [manifest?.name, graphW, graphH]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Projection: normalize live projection to ReplayState shape ───────────

  const liveProjection = detail?.projection ?? null;

  const normalizedLive: ReplayState | null = liveProjection ? {
    nodes: Object.fromEntries(
      Object.entries(liveProjection.nodes).map(([id, ns]) => [id, {
        entered: ns.entered,
        concluded: ns.concluded,
        visits: ns.visits,
      }])
    ),
    perCapSpentCents: liveProjection.budget.perCapSpentCents,
    runSpentCents: liveProjection.budget.runSpentCents,
  } : null;

  // Memoized — avoids O(n) full-replay scan on every render during scrubbing
  const scrubbedProjection: ReplayState | null = useMemo(
    () => isScrubbing && scrubCursor !== null ? replayUpTo(events, scrubCursor) : null,
    [events, scrubCursor, isScrubbing],
  );

  const activeProjection: ReplayState | null =
    scrubbedProjection ?? (mode === "live" ? normalizedLive : null);

  // Total run cost for heat calculation
  const totalRunCost = activeProjection?.runSpentCents ?? 0;

  // Which node is currently running (for active edge detection)
  const runningNode = activeProjection
    ? Object.entries(activeProjection.nodes).find(([, ns]) => ns.entered && !ns.concluded)?.[0] ?? null
    : null;

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") { setSelectedNode(null); setIsScrubbing(false); setScrubCursor(null); }
      if (e.key === "0" && !e.metaKey && !e.ctrlKey) {
        const c = containerRef.current;
        if (!c || !manifest) return;
        dispatchPan({ type: "reset", containerW: c.clientWidth, containerH: c.clientHeight, graphW, graphH });
      }
      if ((e.key === "=" || e.key === "+") && !e.metaKey) {
        const c = containerRef.current;
        if (!c) return;
        dispatchPan({ type: "zoom_step", factor: 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 });
      }
      if (e.key === "-" && !e.metaKey) {
        const c = containerRef.current;
        if (!c) return;
        dispatchPan({ type: "zoom_step", factor: 1 / 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 });
      }
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey) {
        if (selectedRunId) { e.preventDefault(); setMode(m => m === "blueprint" ? "live" : "blueprint"); }
      }
      // Arrow keys step through timeline when live or scrubbing
      if (mode === "live" || isScrubbing) {
        if (e.key === "ArrowRight") {
          setScrubCursor(prev => {
            const next = Math.min(events.length - 1, (prev ?? events.length - 1) + 1);
            setIsScrubbing(next < events.length - 1);
            return next;
          });
        }
        if (e.key === "ArrowLeft") {
          setScrubCursor(prev => {
            const next = Math.max(0, (prev ?? events.length - 1) - 1);
            setIsScrubbing(true);
            return next;
          });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRunId, manifest, graphW, graphH, mode, isScrubbing, events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pointer handlers for pan ──────────────────────────────────────────────

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dispatchPan({ type: "wheel", dz: e.deltaY, cx: e.clientX - rect.left, cy: e.clientY - rect.top });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dispatchPan({ type: "pan_start", x: e.clientX, y: e.clientY });
  }

  function onPointerMove(e: React.PointerEvent) {
    dispatchPan({ type: "pan_move", x: e.clientX, y: e.clientY });
  }

  function onPointerUp() {
    dispatchPan({ type: "pan_end" });
  }

  if (loading) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>Loading…</p>
    </div>
  );

  if (!agent) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>Agent not found.</p>
    </div>
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--canvas)", opacity: mounted ? 1 : 0, transition: "opacity 200ms ease" }}>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{
        height: 52, flexShrink: 0,
        borderBottom: "1px solid var(--line)",
        background: "rgba(248,247,244,.96)", backdropFilter: "blur(10px)",
        display: "flex", alignItems: "center", gap: "var(--s4)", padding: "0 var(--s5)",
        zIndex: 20,
      }}>
        {/* back */}
        <a href={`/agents/${agentId}`} style={{ fontSize: 12, color: "var(--ink-muted)", textDecoration: "none", flexShrink: 0 }}>← Agent</a>

        <div style={{ width: 1, height: 20, background: "var(--line)" }} />

        {/* agent name + intent */}
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 1, maxWidth: 220 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", letterSpacing: "-.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {agent.signed.manifest.name}
          </span>
          {agent.signed.provenance.intent && (
            <span style={{ fontSize: 11, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {agent.signed.provenance.intent.length > 60 ? agent.signed.provenance.intent.slice(0, 57) + "…" : agent.signed.provenance.intent}
            </span>
          )}
        </div>

        {/* tamper-evident ledger badge */}
        <a
          href={selectedRunId ? `/runs/${selectedRunId}#timeline` : `/agents/${agentId}`}
          title="Every event is HMAC-chained — the ledger cannot be altered without detection"
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "3px 9px", borderRadius: "var(--r-pill)",
            background: "var(--ok-tint)", border: "1px solid rgba(22,121,76,.2)",
            fontSize: 11, fontWeight: 600, color: "var(--ok)",
            textDecoration: "none", flexShrink: 0,
            transition: "background 120ms",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "#bbf7d0")}
          onMouseLeave={e => (e.currentTarget.style.background = "var(--ok-tint)")}
        >
          ✓ Signed
        </a>

        {/* run selector */}
        <RunSelectorDropdown
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={(id) => { setSelectedRunId(id); setMode(id ? "live" : "blueprint"); }}
        />

        {/* blueprint / live toggle */}
        {selectedRunId && (
          <div style={{ display: "flex", borderRadius: "var(--r)", border: "1px solid var(--line)", overflow: "hidden", flexShrink: 0 }}>
            {(["blueprint", "live"] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
                background: mode === m ? (m === "live" ? "var(--live)" : "var(--brand)") : "var(--surface)",
                color: mode === m ? "#fff" : "var(--ink-soft)",
                transition: "background 150ms, color 150ms",
              }}>
                {m === "blueprint" ? "Blueprint" : "Live ▶"}
              </button>
            ))}
          </div>
        )}

        {/* cost heat toggle */}
        {selectedRunId && mode === "live" && (
          <button onClick={() => setShowCost(c => !c)} style={{
            padding: "4px 12px", fontSize: 12, fontWeight: 500, borderRadius: "var(--r)",
            border: "1px solid var(--line)", cursor: "pointer",
            background: showCost ? "rgba(217,119,6,.12)" : "var(--surface)",
            color: showCost ? "#D97706" : "var(--ink-soft)",
            transition: "background 150ms, color 150ms",
          }}>
            {showCost ? "◉" : "○"} Cost heat
          </button>
        )}

        {/* live indicator */}
        {detail?.run.status === "running" && mode === "live" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--live)", fontWeight: 600, flexShrink: 0 }}>
            <span className="status-dot running" style={{ width: 6, height: 6 }} />
            live
          </div>
        )}

        {/* run again */}
        <button
          onClick={() => {
            if (startingRun) return;
            setStartingRun(true);
            startRun(agentId)
              .then(async r => {
                const [updatedRuns] = await Promise.all([getAgentRuns(agentId)]);
                setRuns(updatedRuns);
                setSelectedRunId(r.runId);
                setMode("live");
              })
              .finally(() => setStartingRun(false));
          }}
          disabled={startingRun || detail?.run.status === "running"}
          style={{
            padding: "5px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--r)",
            border: "none", cursor: startingRun ? "default" : "pointer",
            background: "var(--brand)", color: "#fff",
            opacity: (startingRun || detail?.run.status === "running") ? 0.55 : 1,
            transition: "opacity 150ms",
            flexShrink: 0,
          }}
        >
          {startingRun ? "Starting…" : "▶ Run again"}
        </button>

        <div style={{ flex: 1 }} />

        {/* run stats */}
        {detail && mode === "live" && (
          <div style={{ display: "flex", gap: "var(--s5)", fontSize: 12, flexShrink: 0 }}>
            <span style={{ color: "var(--ink-muted)" }}>
              {Object.values(detail.projection.nodes).filter(n => n.concluded).length} / {manifest?.nodes.length ?? 0} nodes
            </span>
            {detail.run.spentCents != null && (
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--brand)" }}>
                {detail.run.spentCents}¢
              </span>
            )}
            <span style={{
              fontWeight: 600, fontSize: 12, padding: "2px 8px", borderRadius: "var(--r-pill)",
              background: detail.run.status === "completed" ? "var(--ok-tint)" : detail.run.status === "failed" ? "var(--danger-tint)" : detail.run.status === "running" ? "var(--live-tint)" : "var(--surface-sunken)",
              color: detail.run.status === "completed" ? "var(--ok)" : detail.run.status === "failed" ? "var(--danger)" : detail.run.status === "running" ? "var(--live)" : "var(--ink-muted)",
            }}>
              {detail.run.status}
            </span>
          </div>
        )}

        {/* zoom + fit controls */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
          <button
            onClick={() => { const c = containerRef.current; if (!c) return; dispatchPan({ type: "zoom_step", factor: 1 / 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 }); }}
            title="Zoom out (−)"
            style={{ padding: "3px 8px", fontSize: 14, borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", color: "var(--ink-soft)", lineHeight: 1 }}
          >−</button>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-muted)", minWidth: 36, textAlign: "center" }}>
            {Math.round(pan.scale * 100)}%
          </span>
          <button
            onClick={() => { const c = containerRef.current; if (!c) return; dispatchPan({ type: "zoom_step", factor: 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 }); }}
            title="Zoom in (+)"
            style={{ padding: "3px 8px", fontSize: 14, borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", color: "var(--ink-soft)", lineHeight: 1 }}
          >+</button>
          <button onClick={() => {
            if (!containerRef.current) return;
            const { width, height } = containerRef.current.getBoundingClientRect();
            dispatchPan({ type: "reset", containerW: width, containerH: height, graphW, graphH });
          }} title="Fit graph to viewport (0)" style={{
            padding: "3px 10px", fontSize: 12, borderRadius: "var(--r)",
            border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", color: "var(--ink-soft)",
          }}>⊡</button>
        </div>

        <span style={{ fontSize: 10, color: "var(--ink-muted)", flexShrink: 0, display: "flex", gap: 6 }}>
          {[["0","fit"],["+/−","zoom"],["Tab","mode"],["Esc","desel"]].map(([k, l]) => (
            <span key={k}>
              <kbd style={{ fontFamily: "var(--font-mono)", background: "var(--surface-sunken)", border: "1px solid var(--line)", borderRadius: 3, padding: "1px 4px" }}>{k}</kbd>
              {" "}{l}
            </span>
          ))}
        </span>
      </div>

      {/* ── Canvas area ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
        <div
          ref={containerRef}
          style={{
            flex: 1, overflow: "hidden", cursor: !manifest ? "default" : pan.dragging ? "grabbing" : "grab",
            position: "relative",
            backgroundImage: "radial-gradient(circle, var(--line) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {!manifest ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>No manifest found for this agent.</p>
            </div>
          ) : (
            <svg
              width={graphW + 120}
              height={graphH + 120}
              style={{
                display: "block",
                transform: `translate(${pan.tx}px, ${pan.ty}px) scale(${pan.scale})`,
                transformOrigin: "0 0",
                willChange: "transform",
                userSelect: "none",
              }}
              onClick={e => { if (e.target === e.currentTarget) setSelectedNode(null); }}
            >
              <defs>
                <marker id="c-arrow-done" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--ok)" />
                </marker>
                <marker id="c-arrow-active" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--live)" />
                </marker>
                <marker id="c-arrow-idle" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--line-strong)" />
                </marker>
                <style>{`
                  .c-edge-active { stroke-dasharray: 8 6; animation: c-dash 0.7s linear infinite; }
                  @keyframes c-dash { to { stroke-dashoffset: -28; } }
                `}</style>
              </defs>

              <g transform="translate(60,60)">

                {/* ── Edges ──────────────────────────────────────────────── */}
                {manifest.edges.map(edge => {
                  const fp = positions.get(edge.from);
                  const tp = positions.get(edge.to);
                  if (!fp || !tp) return null;

                  const nodeStatus = (id: string) => {
                    const ns = activeProjection?.nodes[id];
                    if (!ns) return "idle";
                    return ns.concluded ? "done" : ns.entered ? "running" : "idle";
                  };

                  const fromStatus = nodeStatus(edge.from);
                  const toStatus   = nodeStatus(edge.to);
                  const isActive   = fromStatus === "running" || toStatus === "running";
                  const isDone     = fromStatus === "done" && toStatus !== "idle";
                  const d          = edgePath(fp, tp);
                  const stroke     = mode === "blueprint" ? "var(--line-strong)"
                    : isActive ? "var(--live)" : isDone ? "var(--ok)" : "var(--line-strong)";
                  const marker     = mode === "blueprint" ? "url(#c-arrow-idle)"
                    : isActive ? "url(#c-arrow-active)" : isDone ? "url(#c-arrow-done)" : "url(#c-arrow-idle)";

                  // Conditional edge label — show full on hover, truncate otherwise
                  const edgeKey = `${edge.from}-${edge.to}`;
                  const when = edge.when;
                  const condLabel = when ? exprLabel(when) : null;
                  const isHovered = hoveredEdge === edgeKey;
                  const condText = condLabel
                    ? (isHovered || condLabel.length <= 22 ? condLabel : condLabel.slice(0, 20) + "…")
                    : null;

                  // Midpoint for label
                  const midX = (fp.x + fp.w + tp.x) / 2;
                  const midY = (fp.y + fp.h / 2 + tp.y + tp.h / 2) / 2 - 12;

                  // Pill width scales with label length
                  const pillW = condText ? Math.max(52, condText.length * 7 + 18) : 0;

                  return (
                    <g key={edgeKey}
                      onMouseEnter={() => setHoveredEdge(edgeKey)}
                      onMouseLeave={() => setHoveredEdge(null)}
                    >
                      {/* wider invisible hit area for hover */}
                      <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: "pointer" }} />
                      <path d={d} fill="none" stroke={isHovered ? (isActive ? "var(--live)" : isDone ? "var(--ok)" : "var(--brand)") : stroke}
                        strokeWidth={isHovered ? 2.5 : isActive ? 2.5 : isDone ? 2 : 1.5}
                        markerEnd={marker} style={{ transition: "stroke 200ms, stroke-width 150ms" }} />
                      {mode === "live" && isActive && (
                        <>
                          <path d={d} fill="none" stroke="var(--live)" strokeWidth={2.5} className="c-edge-active" opacity={0.6} />
                          <circle r={5} fill="var(--live)" style={{ filter: "drop-shadow(0 0 4px #D97706)" }}>
                            <animateMotion dur="1.2s" repeatCount="indefinite" path={d} />
                          </circle>
                        </>
                      )}
                      {condText && (
                        <g style={{ pointerEvents: "none" }}>
                          <rect x={midX - pillW / 2} y={midY - 10} width={pillW} height={20} rx={5}
                            fill={isHovered ? "var(--brand)" : "var(--surface)"}
                            stroke={isHovered ? "var(--brand)" : "var(--line-strong)"} strokeWidth={1}
                            style={{ filter: isHovered ? "drop-shadow(0 1px 3px rgba(0,0,0,.15))" : "none", transition: "fill 150ms, stroke 150ms" }} />
                          <text x={midX} y={midY} textAnchor="middle" dominantBaseline="middle" fontSize={11}
                            fill={isHovered ? "white" : "var(--brand)"}
                            fontFamily="var(--font-mono)" fontWeight={600}
                            style={{ transition: "fill 150ms" }}>{condText}</text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {/* ── Nodes ──────────────────────────────────────────────── */}
                {manifest.nodes.map(node => {
                  const pos = positions.get(node.id);
                  if (!pos) return null;

                  const ns = activeProjection?.nodes[node.id];
                  const status: "running" | "done" | "idle" =
                    mode === "blueprint" ? "idle"
                    : ns?.concluded ? "done"
                    : ns?.entered ? "running"
                    : "idle";

                  // Cost heat — logarithmic scale so small differences still show
                  const nodeCost = Object.entries(activeProjection?.perCapSpentCents ?? {})
                    .filter(([k]) => k.startsWith(`${node.id}:`))
                    .reduce((s, [, v]) => s + (v as number), 0);
                  const heatFraction = showCost && totalRunCost > 0
                    ? Math.log(nodeCost + 1) / Math.log(totalRunCost + 1)
                    : 0;

                  return (
                    <CanvasNode
                      key={node.id}
                      node={node}
                      pos={pos}
                      status={status}
                      visits={ns?.visits ?? 0}
                      isSelected={selectedNode === node.id}
                      heatFraction={heatFraction}
                      showCost={showCost}
                      nodeCost={nodeCost}
                      isEntry={node.id === manifest.entry}
                      onClick={() => setSelectedNode(selectedNode === node.id ? null : node.id)}
                    />
                  );
                })}

              </g>
            </svg>
          )}

          {/* ── No runs onboarding ─────────────────────────────────────── */}
          {runs.length === 0 && !loading && mode === "blueprint" && (
            <div style={{
              position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              zIndex: 10, pointerEvents: "auto", textAlign: "center",
              background: "rgba(248,247,244,.96)", border: "1px solid var(--line-strong)",
              borderRadius: "var(--r)", padding: "var(--s6) var(--s7)",
              boxShadow: "var(--shadow-md)", maxWidth: 320,
            }}>
              <div style={{ fontSize: 28, marginBottom: "var(--s3)" }}>▶</div>
              <p style={{ fontWeight: 700, fontSize: 15, marginBottom: "var(--s2)", letterSpacing: "-.01em" }}>This is the blueprint</p>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6, marginBottom: "var(--s5)" }}>
                Run the agent to see it execute live — every decision, cost, and transition recorded to a tamper-evident ledger.
              </p>
              <button
                className="btn btn-primary"
                disabled={startingRun}
                style={{ opacity: startingRun ? 0.6 : 1 }}
                onClick={() => {
                  if (startingRun) return;
                  setStartingRun(true);
                  startRun(agentId)
                    .then(async r => {
                      const updatedRuns = await getAgentRuns(agentId);
                      setRuns(updatedRuns);
                      setSelectedRunId(r.runId);
                      setMode("live");
                    })
                    .finally(() => setStartingRun(false));
                }}
              >
                {startingRun ? "Starting…" : "▶ Run now"}
              </button>
            </div>
          )}

          {/* ── Ledger badge ───────────────────────────────────────────── */}
          {events.length > 0 && (
            <div style={{
              position: "absolute", bottom: isScrubbing ? 72 : 16, right: 16, zIndex: 5,
              fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
              color: "var(--ok)", background: "rgba(248,247,244,.9)",
              padding: "4px 10px", borderRadius: "var(--r-pill)",
              display: "flex", alignItems: "center", gap: 5,
              border: "1px solid var(--ok)",
              transition: "bottom 200ms",
              cursor: "help",
            }} title="Append-only ledger — each event is SHA-256 content-addressed, hash-chained, and HMAC-signed. No event can be altered after it is written.">
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)", display: "inline-block" }} />
              {events.length} events · Tamper-evident ledger
            </div>
          )}

          {/* ── Cost heat legend ───────────────────────────────────────── */}
          {showCost && totalRunCost > 0 && (
            <div style={{
              position: "absolute", top: 12, left: 12, zIndex: 5,
              background: "rgba(248,247,244,.92)", border: "1px solid var(--line)",
              borderRadius: "var(--r)", padding: "var(--s3) var(--s4)", fontSize: 11,
            }}>
              <div style={{ fontWeight: 600, color: "var(--ink-muted)", marginBottom: "var(--s2)", textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10 }}>Cost heat</div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
                <span style={{ color: "var(--ink-muted)" }}>0¢</span>
                <div style={{ width: 80, height: 8, borderRadius: 4, background: "linear-gradient(to right, #fff 0%, rgba(217,119,6,0.5) 100%)", border: "1px solid var(--line)" }} />
                <span style={{ color: "#D97706", fontWeight: 600 }}>{totalRunCost}¢</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Timeline scrubber ──────────────────────────────────────────── */}
        {mode === "live" && events.length >= 1 && (
          <div style={{
            flexShrink: 0, borderTop: "1px solid var(--line)",
            background: "rgba(248,247,244,.96)", padding: "10px var(--s5)",
            display: "flex", alignItems: "center", gap: "var(--s4)", zIndex: 10,
          }}>
            <span style={{ fontSize: 11, color: "var(--ink-muted)", flexShrink: 0, fontWeight: 600, minWidth: 100 }}>
              {isScrubbing && scrubCursor !== null
                ? `${scrubCursor + 1} / ${events.length}`
                : `${events.length} events`}
            </span>
            <input
              type="range"
              min={0}
              max={events.length - 1}
              value={scrubCursor ?? events.length - 1}
              onChange={e => {
                const v = Number(e.target.value);
                setScrubCursor(v);
                setIsScrubbing(v < events.length - 1);
              }}
              onMouseUp={() => {
                if (scrubCursor === events.length - 1) setIsScrubbing(false);
              }}
              style={{ flex: 1, accentColor: "var(--brand)" }}
            />
            {isScrubbing && (
              <button onClick={() => { setIsScrubbing(false); setScrubCursor(null); }} style={{
                fontSize: 11, padding: "3px 10px", borderRadius: "var(--r)",
                border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", color: "var(--brand)", fontWeight: 600, flexShrink: 0,
              }}>
                Live ▶
              </button>
            )}
            {/* event label at cursor */}
            {isScrubbing && scrubCursor !== null && events[scrubCursor] && (
              <span style={{ fontSize: 11, color: "var(--ink-soft)", fontFamily: "var(--font-mono)", flexShrink: 0, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {events[scrubCursor]!.type}{events[scrubCursor]!.nodeId ? ` · ${events[scrubCursor]!.nodeId}` : ""}
              </span>
            )}
            <span style={{ fontSize: 10, color: "var(--ink-muted)", flexShrink: 0 }}>
              <kbd style={{ fontFamily: "var(--font-mono)", background: "var(--surface-sunken)", border: "1px solid var(--line)", borderRadius: 3, padding: "1px 4px" }}>←</kbd>
              {" / "}
              <kbd style={{ fontFamily: "var(--font-mono)", background: "var(--surface-sunken)", border: "1px solid var(--line)", borderRadius: 3, padding: "1px 4px" }}>→</kbd>
              {" step"}
            </span>
          </div>
        )}
      </div>

      {/* ── Node detail drawer ───────────────────────────────────────────────── */}
      {selectedNode && manifest && (
        <CanvasNodeDetail
          node={manifest.nodes.find(n => n.id === selectedNode)!}
          projection={activeProjection}
          liveProjection={liveProjection}
          events={events}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

// ── Canvas Node (SVG) ─────────────────────────────────────────────────────────

function CanvasNode({ node, pos, status, visits, isSelected, heatFraction, showCost, nodeCost, isEntry, onClick }: {
  node: ManifestNode;
  pos: NodePos;
  status: "running" | "done" | "idle";
  visits: number;
  isSelected: boolean;
  heatFraction: number;
  showCost: boolean;
  nodeCost: number;
  isEntry: boolean;
  onClick: () => void;
}) {
  const { x, y, w, h } = pos;
  const r = 12;

  const baseBg    = status === "running" ? "#FEF3E0" : status === "done" ? "#DCFCE7" : "#FFFFFF";
  const heatRgba  = heatFraction > 0 ? `rgba(217,119,6,${Math.min(0.78, heatFraction * 0.85)})` : "transparent";
  const border    = status === "running" ? "#D97706" : status === "done" ? "#16794C" : (isSelected || isEntry) ? "#0E7C75" : "#E7E3DC";
  const bw        = status !== "idle" || isSelected || isEntry ? 2 : 1;

  // Capability pills — up to 3, then "+N"
  const caps = node.capabilities.slice(0, 3);
  const extra = node.capabilities.length - caps.length;
  const PILL_H = 18;
  const PILL_PAD_X = 6;
  const PILL_START_Y = y + 62;

  let pillX = x + 10;
  const pills: Array<{ text: string; px: number; pw: number }> = [];
  for (const c of caps) {
    const text = `${capIcon(c.name)} ${c.name.length > 8 ? c.name.slice(0, 7) + "…" : c.name}`;
    const pw = Math.min(72, text.length * 6.5 + PILL_PAD_X * 2);
    pills.push({ text, px: pillX, pw });
    pillX += pw + 5;
  }
  if (extra > 0) pills.push({ text: `+${extra}`, px: pillX, pw: 26 });

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }} role="button" aria-label={`Node ${node.id}`}>
      {/* selection ring */}
      {isSelected && (
        <rect x={x - 5} y={y - 5} width={w + 10} height={h + 10} rx={r + 4}
          fill="none" stroke="var(--brand)" strokeWidth={2} strokeDasharray="5 3" opacity={0.75} />
      )}

      {/* running pulse */}
      {status === "running" && (
        <rect x={x - 8} y={y - 8} width={w + 16} height={h + 16} rx={r + 6}
          fill="none" stroke="var(--live)" strokeWidth={2.5} opacity={0.4}>
          <animate attributeName="opacity" values="0.25;0.65;0.25" dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="stroke-width" values="2;4.5;2" dur="1.4s" repeatCount="indefinite" />
        </rect>
      )}

      {/* heat overlay */}
      {heatFraction > 0 && (
        <rect x={x} y={y} width={w} height={h} rx={r} fill={heatRgba} />
      )}

      {/* node box */}
      <rect x={x} y={y} width={w} height={h} rx={r}
        fill={baseBg} stroke={border} strokeWidth={bw}
        style={{ transition: "fill 350ms, stroke 350ms" }}
      />

      {/* entry marker — small teal triangle above top-left corner */}
      {isEntry && (
        <polygon
          points={`${x+10},${y} ${x+22},${y} ${x+16},${y-8}`}
          fill="var(--brand)" opacity={0.75}
        />
      )}

      {/* role — primary label, bold */}
      <text x={x + 14} y={y + 20} fontSize={13} fontWeight={700}
        fill={status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink)"}
        dominantBaseline="middle">
        {node.role.length > 22 ? node.role.slice(0, 20) + "…" : node.role}
      </text>

      {/* node id — secondary, muted mono */}
      <text x={x + 14} y={y + 38} fontSize={10} fill="var(--ink-muted)" dominantBaseline="middle" fontFamily="var(--font-mono)">
        {node.id.length > 26 ? node.id.slice(0, 24) + "…" : node.id}
      </text>

      {/* capability pills — clipped to node width */}
      <defs>
        <clipPath id={`clip-pills-${node.id}`}>
          <rect x={x + 8} y={PILL_START_Y - 2} width={w - 16} height={PILL_H + 4} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-pills-${node.id})`}>
        {pills.map(({ text, px, pw }, i) => (
          <g key={i}>
            <rect x={px} y={PILL_START_Y} width={pw} height={PILL_H} rx={5}
              fill="var(--canvas)" stroke="var(--line)" strokeWidth={1} />
            <text x={px + PILL_PAD_X} y={PILL_START_Y + PILL_H / 2} fontSize={11}
              fill="var(--ink-soft)" dominantBaseline="middle">{text}</text>
          </g>
        ))}
      </g>

      {/* status row */}
      <g>
        {status === "running" && (
          <>
            <circle cx={x + 12} cy={y + h - 14} r={3} fill="var(--live)">
              <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
            </circle>
            <text x={x + 20} y={y + h - 14} fontSize={10} fill="var(--live)" fontWeight={600} dominantBaseline="middle">running</text>
          </>
        )}
        {status === "done" && (
          <>
            <text x={x + 10} y={y + h - 14} fontSize={11} fill="var(--ok)" dominantBaseline="middle">✓</text>
            <text x={x + 22} y={y + h - 14} fontSize={10} fill="var(--ok)" fontWeight={600} dominantBaseline="middle">
              done{visits > 1 ? ` ×${visits}` : ""}
            </text>
          </>
        )}
        {status === "idle" && (
          <text x={x + 12} y={y + h - 14} fontSize={10} fill="var(--ink-muted)" dominantBaseline="middle">waiting</text>
        )}
        {showCost && nodeCost > 0 && (
          <text x={x + w - 10} y={y + h - 14} fontSize={10} fill="#D97706"
            fontFamily="var(--font-mono)" fontWeight={600} textAnchor="end" dominantBaseline="middle">
            {nodeCost}¢
          </text>
        )}
      </g>
    </g>
  );
}

// ── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{ fontSize: 10, padding: "2px 7px", borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface)", color: copied ? "var(--ok)" : "var(--ink-muted)", cursor: "pointer", transition: "color 150ms" }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── Node detail drawer (right side) ──────────────────────────────────────────

function CloseButton({ onClose }: { onClose: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClose}
      aria-label="Close"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? "var(--surface-sunken)" : "none",
        border: "none", cursor: "pointer",
        width: 28, height: 28, borderRadius: "var(--r)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--ink-muted)", fontSize: 16, transition: "background 120ms",
        flexShrink: 0,
      }}
    >✕</button>
  );
}

function CanvasNodeDetail({ node, projection, liveProjection, events, onClose }: {
  node: ManifestNode;
  projection: ReplayState | null;
  liveProjection: RunDetail["projection"] | null;
  events: LedgerEvent[];
  onClose: () => void;
}) {
  const ns = projection?.nodes[node.id];
  const status = ns?.concluded ? "done" : ns?.entered ? "running" : "idle";
  const [showGlobal, setShowGlobal] = useState(false);

  // Outputs from run state
  const nodeState = Object.entries(liveProjection?.state ?? {})
    .filter(([k]) => k.startsWith(`${node.id}.`))
    .map(([k, v]) => ({ key: k.slice(node.id.length + 1), value: v }));

  // Full run state (global keys, non-private)
  const globalState = Object.entries(liveProjection?.state ?? {})
    .filter(([k]) => !k.startsWith(`${node.id}.`) && !k.startsWith("_"))
    .map(([k, v]) => ({ key: k, value: v }));

  // Per-cap costs
  const perCapCosts = Object.entries(projection?.perCapSpentCents ?? liveProjection?.budget.perCapSpentCents ?? {})
    .filter(([k]) => k.startsWith(`${node.id}:`))
    .map(([k, v]) => ({ cap: k.slice(node.id.length + 1), cents: v as number }));
  const totalCost = perCapCosts.reduce((s, c) => s + c.cents, 0);

  // Node events from ledger
  const nodeEvents = events.filter(e => e.nodeId === node.id);

  // EffectResult outputs for deep inspection
  const effectOutputs = nodeEvents
    .filter(e => e.type === "EffectResult")
    .map(e => {
      const p = e.payload as Record<string, unknown>;
      return { cap: String(p["capabilityName"] ?? ""), output: p["output"], cost: Number(p["claimedCostCents"] ?? 0) };
    });

  return (
    <div style={{
      position: "fixed", right: 0, top: 52, bottom: 0, width: 340,
      background: "var(--surface)", borderLeft: "1px solid var(--line)",
      overflowY: "auto", zIndex: 30,
      display: "flex", flexDirection: "column",
    }}>
      {/* header */}
      <div style={{ padding: "var(--s4) var(--s5)", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div style={{ minWidth: 0, flex: 1, marginRight: "var(--s3)" }}>
          {/* role is primary */}
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)", marginBottom: 2, wordBreak: "break-word" }}>{node.role}</div>
          {/* id is secondary */}
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)", marginBottom: "var(--s2)", wordBreak: "break-all" }}>{node.id}</div>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)",
              background: status === "running" ? "var(--live-tint)" : status === "done" ? "var(--ok-tint)" : "var(--surface-sunken)",
              color: status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink-muted)",
            }}>
              {status}{ns?.visits ? ` · ${ns.visits}×` : ""}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)",
              background: "var(--canvas)", color: "var(--ink-muted)",
            }}>
              {node.autonomy}
            </span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div style={{ padding: "var(--s4) var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s5)", flex: 1 }}>

        {/* Capabilities */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>Capabilities</div>
          {node.capabilities.length === 0
            ? <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>No capabilities</span>
            : node.capabilities.map(c => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--s2) 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                  <span>{capIcon(c.name)}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--brand)" }}>{c.name}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{c.sideEffect} · {c.budgetCents}¢</span>
              </div>
            ))
          }
        </section>

        {/* Outputs from run state */}
        {nodeState.length > 0 && (
          <section>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>Outputs</div>
            {nodeState.map(({ key, value }) => {
              const text = (() => { const s = String(value); try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } })();
              return (
                <div key={key} style={{ marginBottom: "var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s3)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s2)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--brand)" }}>{key}</span>
                    <CopyButton text={text} />
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", lineHeight: 1.5 }}>
                    {text}
                  </pre>
                </div>
              );
            })}
          </section>
        )}

        {/* Effect results */}
        {effectOutputs.length > 0 && (
          <section>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>Effect Results</div>
            {effectOutputs.map((ef, i) => {
              const text = (() => { const s = typeof ef.output === "string" ? ef.output : JSON.stringify(ef.output, null, 2); try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } })();
              return (
                <div key={i} style={{ marginBottom: "var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s3)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s2)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--brand)" }}>{ef.cap}</span>
                    <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                      {ef.cost > 0 && <span style={{ fontSize: 10, color: "var(--live)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{ef.cost}¢</span>}
                      <CopyButton text={text} />
                    </div>
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", lineHeight: 1.5 }}>
                    {text}
                  </pre>
                </div>
              );
            })}
          </section>
        )}

        {/* Cost breakdown */}
        {perCapCosts.length > 0 && (
          <section>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>Cost</div>
            {perCapCosts.map(({ cap, cents }) => (
              <div key={cap} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                <span style={{ color: "var(--ink-soft)" }}>{cap}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--brand)" }}>{cents}¢</span>
              </div>
            ))}
            {perCapCosts.length > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderTop: "1px solid var(--line)", marginTop: 4 }}>
                <span style={{ fontWeight: 600 }}>Total</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--ink)" }}>{totalCost}¢</span>
              </div>
            )}
          </section>
        )}

        {/* Ledger events */}
        {nodeEvents.length > 0 && (
          <section>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>Events ({nodeEvents.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {nodeEvents.map(e => (
                <div key={e.id} style={{ display: "flex", gap: "var(--s3)", fontSize: 11, padding: "3px 0", borderBottom: "1px solid var(--line)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-muted)", width: 24, flexShrink: 0 }}>#{e.offset}</span>
                  <span style={{
                    fontWeight: 600, fontSize: 10, flexShrink: 0,
                    color: e.type === "NodeEntered" ? "var(--live)" : e.type === "NodeConcluded" ? "var(--ok)" : e.type.includes("Failed") ? "var(--danger)" : "var(--ink-soft)",
                  }}>{e.type}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Global state inspector */}
        {globalState.length > 0 && (
          <section>
            <button
              onClick={() => setShowGlobal(s => !s)}
              style={{
                width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-muted)",
                marginBottom: showGlobal ? "var(--s3)" : 0,
              }}
            >
              Full run state ({globalState.length} keys)
              <span style={{ fontSize: 10 }}>{showGlobal ? "▴" : "▾"}</span>
            </button>
            {showGlobal && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {globalState.map(({ key, value }) => (
                  <div key={key} style={{ background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s2) var(--s3)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)", marginBottom: 2 }}>{key}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-soft)", wordBreak: "break-word", maxHeight: 60, overflow: "hidden" }}>
                      {String(value).slice(0, 300)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
