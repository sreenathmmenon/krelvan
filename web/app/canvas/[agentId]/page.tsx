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

// ── Capability glyphs (teal geometric SVG — no emoji; matches the homepage glyph
// style on page.tsx / _builder.tsx CapGlyph). Each glyph is authored on a 16×16
// grid. capGlyphPaths returns the raw vector paths; render at any scale by wrapping
// in an SVG sized 16×16 (HTML) or a translated <g> (inside the canvas SVG). ──────

function capGlyphPaths(name: string, color = "var(--brand)"): React.ReactNode {
  const s = { stroke: color };
  switch (name) {
    case "think":
      return (<>
        <circle cx="8" cy="8" r="5.2" strokeWidth="1.3" fill="none" {...s} />
        <circle cx="8" cy="8" r="1.7" fill={color} />
      </>);
    case "recall":
      return (<>
        <path d="M2.5 3.2h4.2c.7 0 1.3.6 1.3 1.3v8.3c0-.7-.6-1.3-1.3-1.3H2.5V3.2z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
        <path d="M13.5 3.2H9.3c-.7 0-1.3.6-1.3 1.3v8.3c0-.7.6-1.3 1.3-1.3h4.2V3.2z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
      </>);
    case "remember":
      return (<>
        <path d="M3 3h7.5L13 5.5V13H3V3z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
        <rect x="5.5" y="3" width="5" height="3" strokeWidth="1.1" fill="none" {...s} />
        <rect x="5" y="8.5" width="6" height="3.5" strokeWidth="1.1" fill="none" {...s} />
      </>);
    case "llm_route":
      return (<>
        <path d="M3 8h3.5M9.5 4.5L12.5 4.5M9.5 11.5L12.5 11.5M6.5 8c1.2 0 1.6-3.5 3-3.5M6.5 8c1.2 0 1.6 3.5 3 3.5" strokeWidth="1.2" fill="none" strokeLinecap="round" {...s} />
        <path d="M11 3l1.8 1.5L11 6M11 10l1.8 1.5L11 13" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" {...s} />
      </>);
    case "web_search":
      return (<>
        <circle cx="7" cy="7" r="4" strokeWidth="1.3" fill="none" {...s} />
        <path d="M10 10l3.2 3.2" strokeWidth="1.4" strokeLinecap="round" {...s} />
      </>);
    case "compose":
      return (<>
        <path d="M3 13l1-3 6.5-6.5 2 2L6 12l-3 1z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
        <path d="M10 4.5l1.5-1.5 2 2L12 6.5" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
      </>);
    case "http_get":
    case "http_post":
      return (<>
        <circle cx="8" cy="8" r="5.2" strokeWidth="1.2" fill="none" {...s} />
        <path d="M2.8 8h10.4M8 2.8c1.6 1.4 2.4 3.3 2.4 5.2S9.6 12.8 8 13.2C6.4 12.8 5.6 10.9 5.6 8S6.4 4.2 8 2.8z" strokeWidth="1.1" fill="none" {...s} />
      </>);
    case "telegram_send":
    case "email_send":
      return (<>
        <rect x="2.5" y="4" width="11" height="8" rx="1" strokeWidth="1.2" fill="none" {...s} />
        <path d="M3 4.8l5 4 5-4" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" {...s} />
      </>);
    case "slack_send":
      return (
        <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3v-6z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
      );
    case "notify_webhook":
      return (<>
        <path d="M8 2.6c2 0 3.3 1.5 3.3 3.4v2.4l1.2 1.8H3.5l1.2-1.8V6c0-1.9 1.3-3.4 3.3-3.4z" strokeWidth="1.2" fill="none" strokeLinejoin="round" {...s} />
        <path d="M6.6 12.2c.2.8.8 1.2 1.4 1.2s1.2-.4 1.4-1.2" strokeWidth="1.2" fill="none" strokeLinecap="round" {...s} />
      </>);
    case "text_transform":
      return (<>
        <path d="M3.5 4h9M8 4v8.5M5.5 12.5h5" strokeWidth="1.2" fill="none" strokeLinecap="round" {...s} />
      </>);
    case "identify":
      return (<>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" strokeWidth="1.2" fill="none" {...s} />
        <circle cx="6" cy="7" r="1.5" strokeWidth="1.1" fill="none" {...s} />
        <path d="M3.8 11c.3-1.3 1.2-2 2.2-2s1.9.7 2.2 2M10 6.5h2.3M10 9h2.3" strokeWidth="1.1" fill="none" strokeLinecap="round" {...s} />
      </>);
    default:
      return (<>
        <rect x="3.5" y="3.5" width="9" height="9" rx="2" strokeWidth="1.2" fill="none" {...s} />
        <circle cx="8" cy="8" r="1.6" fill={color} />
      </>);
  }
}

// HTML-context glyph (detail drawer, dropdowns): a fixed 16×16 inline SVG.
function CapGlyphInline({ name, size = 14, color = "var(--brand)" }: { name: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      {capGlyphPaths(name, color)}
    </svg>
  );
}

// SVG-context glyph (inside the canvas <svg>): translate to top-left of a 16×16 box.
function CapGlyphSvg({ name, x, y, size = 13, color = "var(--brand)" }: { name: string; x: number; y: number; size?: number; color?: string }) {
  const k = size / 16;
  return (
    <g transform={`translate(${x},${y}) scale(${k})`}>
      {capGlyphPaths(name, color)}
    </g>
  );
}

// ── Small UI glyphs (HTML context) — replace emoji/dingbats with crisp SVG ─────

function ChevronDown({ size = 11, color = "var(--ink-muted)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke={color} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck({ size = 12, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path d="M2.5 6.3l2.3 2.4L9.5 3.6" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPlay({ size = 12, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path d="M3 2.2l6.5 3.8L3 9.8z" fill={color} />
    </svg>
  );
}

function IconClose({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// "Nothing here" frame glyph — a node/graph mark, teal, in the homepage style.
function GlyphGraphEmpty({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ display: "block" }}>
      <rect x="4" y="6" width="11" height="8" rx="2" stroke="var(--brand)" strokeWidth="1.5" fill="none" opacity={0.85} />
      <rect x="17" y="18" width="11" height="8" rx="2" stroke="var(--brand)" strokeWidth="1.5" fill="none" opacity={0.85} />
      <path d="M15 10h3a4 4 0 0 1 4 4v4" stroke="var(--brand)" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity={0.55} />
    </svg>
  );
}

// ── Replay projection: fold events 0..cursor into node state ──────────────────

interface NodeSnapshot {
  entered: boolean;
  concluded: boolean;
  visits: number;
}

interface ReplayState {
  nodes: Record<string, NodeSnapshot>;
  // Activity = how many effects ran at each node (drives the activity heat-map).
  perNodeActivity: Record<string, number>;
  // Per-capability effect counts, keyed `${nodeId}:${capabilityName}`.
  perCapActivity: Record<string, number>;
}

function replayUpTo(events: LedgerEvent[], cursor: number): ReplayState {
  const nodes: Record<string, NodeSnapshot> = {};
  const perNodeActivity: Record<string, number> = {};
  const perCapActivity: Record<string, number> = {};

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
      perNodeActivity[nodeId] = (perNodeActivity[nodeId] ?? 0) + 1;
      if (capKey) {
        const k = `${nodeId}:${capKey}`;
        perCapActivity[k] = (perCapActivity[k] ?? 0) + 1;
      }
    }
  }
  return { nodes, perNodeActivity, perCapActivity };
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

// ── Shared status → badge variant map ─────────────────────────────────────────

const STATUS_BADGE_CLASS: Record<string, string> = {
  running:   "badge badge-running",
  pending:   "badge badge-running",
  completed: "badge badge-done",
  failed:    "badge badge-failed",
  paused:    "badge badge-paused",
};

function statusBadgeClass(status: string): string {
  return STATUS_BADGE_CLASS[status] ?? "badge badge-neutral";
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
  const statusDotClass = (s: string) =>
    s === "running" ? "status-dot running" : s === "completed" ? "status-dot done" : s === "failed" ? "status-dot failed" : "status-dot paused";

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(o => !o)}
        style={{ minWidth: 180, maxWidth: 240, justifyContent: "flex-start" }}
      >
        {selected ? (
          <>
            <span className={statusDotClass(selected.status)} aria-hidden="true" />
            <span className="text-truncate" style={{ flex: 1, textAlign: "left" }}>{selected.manifestName}</span>
            <span className="micro" style={{ flexShrink: 0, textTransform: "none", letterSpacing: 0 }}>{timeAgo(selected.createdAt)}</span>
          </>
        ) : (
          <span style={{ color: "var(--ink-soft)", flex: 1, textAlign: "left" }}>Blueprint (no run)</span>
        )}
        <ChevronDown />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 260, zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)",
          boxShadow: "var(--shadow-md)", overflow: "hidden",
        }}>
          <style>{`
            .canvas-run-option { transition: background var(--t-fast) var(--ease); }
            .canvas-run-option[data-selected="false"]:hover { background: var(--surface-hover) !important; }
          `}</style>
          <div
            className="canvas-run-option small"
            data-selected={!selectedRunId}
            onClick={() => { onSelect(null); setOpen(false); }}
            style={{
              padding: "var(--s2) var(--s3)", cursor: "pointer",
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
              className="canvas-run-option small"
              data-selected={r.runId === selectedRunId}
              onClick={() => { onSelect(r.runId); setOpen(false); }}
              style={{
                padding: "var(--s2) var(--s3)", cursor: "pointer",
                display: "flex", alignItems: "center", gap: "var(--s2)",
                borderBottom: "1px solid var(--line)",
                background: r.runId === selectedRunId ? "var(--brand-tint)" : "transparent",
              }}
            >
              <span className={statusDotClass(r.status)} aria-hidden="true" />
              <span className="text-truncate" style={{ flex: 1, fontWeight: r.runId === selectedRunId ? 600 : 400 }}>{r.manifestName}</span>
              <span className="micro" style={{ flexShrink: 0, textTransform: "none", letterSpacing: 0 }}>{timeAgo(r.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CanvasPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ run?: string }> }) {
  const { agentId: rawAgentId } = use(params);
  // Next may hand back the param still percent-encoded (the id contains "sha256:").
  // Decode defensively so getAgent()'s own encodeURIComponent doesn't double-encode.
  const agentId = (() => { try { return decodeURIComponent(rawAgentId); } catch { return rawAgentId; } })();
  const { run: runFromUrl } = use(searchParams);

  const [agent, setAgent]       = useState<AgentRecord | null>(null);
  const [runs, setRuns]         = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail]     = useState<RunDetail | null>(null);
  const [events, setEvents]     = useState<LedgerEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [mode, setMode]         = useState<"blueprint" | "live">("blueprint");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showHeat, setShowHeat] = useState(false);
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
    const el = containerRef.current;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        dispatchPan({ type: "reset", containerW: width, containerH: height, graphW, graphH });
      }
    };
    fit();
    // Re-fit once the container has its real size (mobile/late layout) and on resize,
    // so the graph always centers/scales to the viewport instead of sitting tiny in a corner.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [manifest?.name, graphW, graphH]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Projection: normalize live projection to ReplayState shape ───────────

  const liveProjection = detail?.projection ?? null;

  // Activity counts (effects per node / per capability) are derived from the
  // ledger events — they drive the activity heat-map, not the live budget.
  const liveActivity = useMemo(() => {
    const perNodeActivity: Record<string, number> = {};
    const perCapActivity: Record<string, number> = {};
    for (const e of events) {
      if (e.type !== "EffectResult" || !e.nodeId) continue;
      perNodeActivity[e.nodeId] = (perNodeActivity[e.nodeId] ?? 0) + 1;
      const capKey = String((e.payload as Record<string, unknown>)["capabilityName"] ?? "");
      if (capKey) {
        const k = `${e.nodeId}:${capKey}`;
        perCapActivity[k] = (perCapActivity[k] ?? 0) + 1;
      }
    }
    return { perNodeActivity, perCapActivity };
  }, [events]);

  const normalizedLive: ReplayState | null = liveProjection ? {
    nodes: Object.fromEntries(
      Object.entries(liveProjection.nodes).map(([id, ns]) => [id, {
        entered: ns.entered,
        concluded: ns.concluded,
        visits: ns.visits,
      }])
    ),
    perNodeActivity: liveActivity.perNodeActivity,
    perCapActivity: liveActivity.perCapActivity,
  } : null;

  // Memoized — avoids O(n) full-replay scan on every render during scrubbing
  const scrubbedProjection: ReplayState | null = useMemo(
    () => isScrubbing && scrubCursor !== null ? replayUpTo(events, scrubCursor) : null,
    [events, scrubCursor, isScrubbing],
  );

  const activeProjection: ReplayState | null =
    scrubbedProjection ?? (mode === "live" ? normalizedLive : null);

  // Peak per-node activity — normalizes the activity heat-map (hottest node = 1.0)
  const maxNodeActivity = activeProjection
    ? Object.values(activeProjection.perNodeActivity).reduce((m, v) => Math.max(m, v), 0)
    : 0;

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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--s4)", background: "var(--graph-bg)" }}>
      <span className="spinner" aria-hidden="true" style={{ width: 22, height: 22 }} />
      <span className="small soft">Loading canvas…</span>
    </div>
  );

  if (!agent) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--graph-bg)", padding: "var(--s6)" }}>
      <div className="state-empty" style={{ maxWidth: 380, boxShadow: "var(--shadow-md)" }}>
        <div style={{ marginBottom: "var(--s2)" }}><GlyphGraphEmpty /></div>
        <p className="h3" style={{ color: "var(--ink)" }}>Agent not found</p>
        <p className="small muted" style={{ maxWidth: "34ch", lineHeight: 1.6 }}>
          This agent may have been deleted, or the link is incorrect.
        </p>
        <a href="/agents" className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s2)" }}>← Back to agents</a>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--canvas)", opacity: mounted ? 1 : 0, transition: "opacity 200ms ease" }}>
      {/* Mobile: the interactive canvas is a desktop-class tool. On phones we show a
          clean notice + quick actions instead of a cramped, unusable graph. */}
      <div className="canvas-mobile-note">
        <div className="canvas-mobile-note__card">
          <div className="empty-invite__glyph" aria-hidden="true" style={{ marginBottom: "var(--s3)" }}>
            <svg viewBox="0 0 16 16" width="22" height="22" fill="none"><rect x="1.5" y="3" width="13" height="8.5" rx="1.5" stroke="var(--brand)" strokeWidth="1.3"/><path d="M5.5 14h5M8 11.5V14" stroke="var(--brand)" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </div>
          <p className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s2)" }}>The canvas is best on a larger screen</p>
          <p className="small soft" style={{ maxWidth: "34ch", margin: "0 auto var(--s5)" }}>
            The interactive graph — pan, zoom, replay each step — needs more room than a phone.
            Open this agent on a desktop to explore it. You can still jump to its run or details below.
          </p>
          <div style={{ display: "flex", gap: "var(--s2)", justifyContent: "center", flexWrap: "wrap" }}>
            {selectedRunId && <a href={`/runs/${selectedRunId}`} className="btn btn-primary btn-sm">View the run →</a>}
            <a href={`/agents/${agentId}`} className="btn btn-secondary btn-sm">Agent details</a>
          </div>
        </div>
      </div>
      <style>{`
        .canvas-mobile-note {
          display: none; position: fixed; inset: 56px 0 0 0; z-index: 60;
          align-items: center; justify-content: center; padding: var(--s5);
          background: var(--canvas);
        }
        .canvas-mobile-note__card {
          text-align: center; max-width: 420px;
          border: 1px solid var(--line); border-radius: var(--r-lg);
          background: radial-gradient(120% 80% at 50% 0%, var(--brand-tint) 0%, rgba(230,244,242,0) 55%), var(--surface);
          box-shadow: var(--shadow-sm); padding: var(--s8) var(--s6);
        }
        @media (max-width: 640px) {
          .canvas-mobile-note { display: flex !important; }
        }
        .canvas-ledger-badge { transition: background var(--t-fast) var(--ease); }
        .canvas-ledger-badge:hover { background: var(--ok); color: #fff; }
        .canvas-scrubber {
          flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
          background: var(--surface-sunken); border-radius: var(--r-pill);
          accent-color: var(--brand); cursor: pointer; outline: none;
        }
        .canvas-scrubber::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--brand); border: 2px solid var(--surface);
          box-shadow: var(--shadow-sm); cursor: pointer;
        }
        .canvas-scrubber::-moz-range-thumb {
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--brand); border: 2px solid var(--surface);
          box-shadow: var(--shadow-sm); cursor: pointer;
        }
        .canvas-scrubber:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; }
      `}</style>

      {/* ── Toolbar (scrolls horizontally if it can't fit, e.g. on phones) ──── */}
      <div className="canvas-toolbar" style={{
        height: 52, flexShrink: 0,
        borderBottom: "1px solid var(--line)",
        background: "rgba(248,247,244,.96)", backdropFilter: "blur(10px)",
        display: "flex", alignItems: "center", gap: "var(--s4)", padding: "0 var(--s5)",
        zIndex: 20, overflowX: "auto", overflowY: "hidden",
      }}>
        {/* back */}
        <a href={`/agents/${agentId}`} className="small" style={{ color: "var(--ink-muted)", flexShrink: 0 }}>← Agent</a>

        <div style={{ width: 1, height: 20, background: "var(--line)" }} />

        {/* agent name + intent */}
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--s1)", maxWidth: 220 }}>
          <span className="h3 text-truncate" style={{ color: "var(--ink)" }}>
            {agent.signed.manifest.name}
          </span>
          {agent.signed.provenance.intent && (
            <span className="micro text-truncate" style={{ textTransform: "none", letterSpacing: 0 }}>
              {agent.signed.provenance.intent.length > 60 ? agent.signed.provenance.intent.slice(0, 57) + "…" : agent.signed.provenance.intent}
            </span>
          )}
        </div>

        {/* tamper-evident ledger badge */}
        <a
          href={selectedRunId ? `/runs/${selectedRunId}#timeline` : `/agents/${agentId}`}
          title="Every event is HMAC-chained — the ledger cannot be altered without detection"
          className="badge badge-done canvas-ledger-badge"
          style={{ flexShrink: 0, textDecoration: "none" }}
        >
          <IconCheck />
          <span className="sr-only">Verified:</span>
          Signed
        </a>

        {/* run selector */}
        <RunSelectorDropdown
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={(id) => { setSelectedRunId(id); setMode(id ? "live" : "blueprint"); }}
        />

        {/* blueprint / live toggle */}
        {selectedRunId && (
          <div className="segmented" style={{ flexShrink: 0 }}>
            {(["blueprint", "live"] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}>
                {m === "blueprint" ? "Blueprint" : "Live"}
              </button>
            ))}
          </div>
        )}


        {/* live indicator */}
        {detail?.run.status === "running" && mode === "live" && (
          <div className="micro" style={{ display: "flex", alignItems: "center", gap: "var(--s1)", color: "var(--live)", fontWeight: 600, flexShrink: 0 }}>
            <span className="status-dot running" style={{ width: 6, height: 6 }} aria-hidden="true" />
            live
          </div>
        )}

        {/* activity heat-map toggle — colors nodes by how active they were (more
            effects = hotter). No cost is ever shown. */}
        {mode === "live" && (
          <label
            className="micro"
            title="Shade nodes by activity — the more effects a node ran, the warmer it glows."
            style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexShrink: 0, cursor: "pointer", textTransform: "none", letterSpacing: 0 }}
          >
            <input
              type="checkbox"
              checked={showHeat}
              onChange={e => setShowHeat(e.target.checked)}
              style={{ accentColor: "var(--brand)", cursor: "pointer" }}
            />
            Activity heat
          </label>
        )}

        {/* run again */}
        <button
          className="btn btn-primary btn-sm"
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
          style={{ flexShrink: 0 }}
        >
          {startingRun ? <><span className="spinner" aria-hidden="true" style={{ width: 13, height: 13, borderTopColor: "var(--brand-ink)", borderColor: "rgba(255,255,255,.4)" }} /> Starting…</> : <><IconPlay /> Run again</>}
        </button>

        <div style={{ flex: 1 }} />

        {/* run stats */}
        {detail && mode === "live" && (
          <div className="small" style={{ display: "flex", alignItems: "center", gap: "var(--s4)", flexShrink: 0 }}>
            <span className="muted">
              <span className="mono">{Object.values(detail.projection.nodes).filter(n => n.concluded).length}</span>
              {" / "}
              <span className="mono">{manifest?.nodes.length ?? 0}</span>
              {" nodes"}
            </span>
            <span className={statusBadgeClass(detail.run.status)}>
              {detail.run.status === "running" && <span className="dot" aria-hidden="true" />}
              {detail.run.status}
            </span>
          </div>
        )}

        {/* zoom + fit controls */}
        <div style={{ display: "flex", gap: "var(--s1)", alignItems: "center", flexShrink: 0 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { const c = containerRef.current; if (!c) return; dispatchPan({ type: "zoom_step", factor: 1 / 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 }); }}
            title="Zoom out (−)" aria-label="Zoom out"
            style={{ width: 30, padding: 0 }}
          >−</button>
          <span className="mono micro" style={{ color: "var(--ink-muted)", minWidth: 36, textAlign: "center", textTransform: "none", letterSpacing: 0 }}>
            {Math.round(pan.scale * 100)}%
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { const c = containerRef.current; if (!c) return; dispatchPan({ type: "zoom_step", factor: 1.2, cx: c.clientWidth / 2, cy: c.clientHeight / 2 }); }}
            title="Zoom in (+)" aria-label="Zoom in"
            style={{ width: 30, padding: 0 }}
          >+</button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (!containerRef.current) return;
              const { width, height } = containerRef.current.getBoundingClientRect();
              dispatchPan({ type: "reset", containerW: width, containerH: height, graphW, graphH });
            }}
            title="Fit graph to viewport (0)" aria-label="Fit graph to viewport"
            style={{ width: 30, padding: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 5V3a1 1 0 0 1 1-1h2M12 5V3a1 1 0 0 0-1-1H9M2 9v2a1 1 0 0 0 1 1h2M12 9v2a1 1 0 0 1-1 1H9" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <span className="micro" style={{ flexShrink: 0, display: "flex", gap: "var(--s2)", textTransform: "none", letterSpacing: 0 }}>
          {[["0","fit"],["+/−","zoom"],["Tab","mode"],["Esc","desel"]].map(([k, l]) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: "var(--s1)" }}>
              <kbd>{k}</kbd>
              {l}
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
            background: "var(--graph-bg)",
            backgroundImage: "radial-gradient(var(--graph-dot) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            backgroundPosition: "center",
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {!manifest ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--s6)" }}>
              <div className="state-empty" style={{ maxWidth: 380, boxShadow: "var(--shadow-md)" }}>
                <div style={{ marginBottom: "var(--s2)" }}><GlyphGraphEmpty /></div>
                <p className="h3" style={{ color: "var(--ink)" }}>Nothing to render yet</p>
                <p className="small muted" style={{ maxWidth: "34ch", lineHeight: 1.6 }}>
                  This agent has no plan to draw on the canvas.
                </p>
                <a href={`/agents/${agentId}`} className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s2)" }}>← Back to agent</a>
              </div>
            </div>
          ) : (
            <svg
              width={graphW + 120}
              height={graphH + 120}
              role="img"
              aria-label={`Agent graph: ${manifest.nodes.length} nodes, ${manifest.edges.length} edges`}
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
                          <circle r={5} fill="var(--live)" style={{ filter: "drop-shadow(0 0 4px var(--live))" }}>
                            <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
                          </circle>
                        </>
                      )}
                      {condText && (
                        <g style={{ pointerEvents: "none" }}>
                          <rect x={midX - pillW / 2} y={midY - 10} width={pillW} height={20} rx={4}
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

                  // Activity heat — logarithmic scale so small differences still show.
                  // Driven by how many effects ran at this node (more activity = hotter).
                  const nodeActivity = activeProjection?.perNodeActivity[node.id] ?? 0;
                  const heatFraction = showHeat && maxNodeActivity > 0
                    ? Math.log(nodeActivity + 1) / Math.log(maxNodeActivity + 1)
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
                      showHeat={showHeat}
                      nodeActivity={nodeActivity}
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
              background: "var(--surface)", border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-lg)", padding: "var(--s7) var(--s7) var(--s6)",
              boxShadow: "var(--shadow-lg)", maxWidth: 340,
              animation: "fade-in 400ms var(--ease) forwards",
            }}>
              <div style={{
                width: 44, height: 44, margin: "0 auto var(--s4)",
                borderRadius: "var(--r-pill)", background: "var(--brand-tint)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--brand)",
              }} aria-hidden="true"><IconPlay size={17} color="var(--brand)" /></div>
              <span className="micro" style={{ color: "var(--brand)" }}>Blueprint</span>
              <p className="h3" style={{ margin: "var(--s2) 0", color: "var(--ink)" }}>This is the plan, before anything runs</p>
              <p className="small soft" style={{ lineHeight: 1.65, marginBottom: "var(--s5)", maxWidth: "32ch", marginInline: "auto" }}>
                Run it to watch the agent act live — every decision and step recorded to a record you can replay.
              </p>
              <button
                className="btn btn-primary"
                disabled={startingRun}
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
                {startingRun ? <><span className="spinner" aria-hidden="true" style={{ width: 14, height: 14, borderTopColor: "var(--brand-ink)", borderColor: "rgba(255,255,255,.4)" }} /> Starting…</> : <><IconPlay /> Run now</>}
              </button>
            </div>
          )}

          {/* ── Ledger badge ───────────────────────────────────────────── */}
          {events.length > 0 && (
            <div className="small" style={{
              position: "absolute", bottom: isScrubbing ? 72 : "var(--s4)", right: "var(--s4)", zIndex: 5,
              color: "var(--ok)", background: "var(--surface)",
              padding: "var(--s1) var(--s3)", borderRadius: "var(--r-pill)",
              display: "flex", alignItems: "center", gap: "var(--s2)",
              border: "1px solid var(--ok)", boxShadow: "var(--shadow-sm)",
              fontWeight: 600,
              transition: "bottom var(--t-standard)",
              cursor: "help",
            }} title="Append-only ledger — each event is SHA-256 content-addressed, hash-chained, and HMAC-signed. No event can be altered after it is written.">
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)", display: "inline-block", flexShrink: 0 }} aria-hidden="true" />
              <span><span className="mono">{events.length}</span> events</span>
              <span style={{ color: "var(--ink-muted)" }} aria-hidden="true">·</span>
              <span>Signed ledger</span>
            </div>
          )}
        </div>

        {/* ── Timeline scrubber ──────────────────────────────────────────── */}
        {mode === "live" && events.length >= 1 && (
          <div style={{
            flexShrink: 0, borderTop: "1px solid var(--line)",
            background: "var(--surface)", padding: "var(--s3) var(--s5)",
            display: "flex", alignItems: "center", gap: "var(--s4)", zIndex: 10,
          }}>
            <span className="micro" style={{ flexShrink: 0, fontWeight: 600, minWidth: 100, textTransform: "none", letterSpacing: 0 }}>
              {isScrubbing && scrubCursor !== null
                ? <><span className="mono">{scrubCursor + 1}</span> / <span className="mono">{events.length}</span></>
                : <><span className="mono">{events.length}</span> events</>}
            </span>
            <input
              type="range"
              className="canvas-scrubber"
              aria-label="Timeline scrubber"
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
            />
            {isScrubbing && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { setIsScrubbing(false); setScrubCursor(null); }}
                style={{ flexShrink: 0, color: "var(--brand)" }}
              >
                Live ▶
              </button>
            )}
            {/* event label at cursor */}
            {isScrubbing && scrubCursor !== null && events[scrubCursor] && (
              <span className="mono small text-truncate" style={{ color: "var(--ink-soft)", flexShrink: 0, maxWidth: 220 }}>
                {events[scrubCursor]!.type}{events[scrubCursor]!.nodeId ? ` · ${events[scrubCursor]!.nodeId}` : ""}
              </span>
            )}
            <span className="micro" style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "var(--s1)", textTransform: "none", letterSpacing: 0 }}>
              <kbd>←</kbd>
              {" / "}
              <kbd>→</kbd>
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

function CanvasNode({ node, pos, status, visits, isSelected, heatFraction, showHeat, nodeActivity, isEntry, onClick }: {
  node: ManifestNode;
  pos: NodePos;
  status: "running" | "done" | "idle";
  visits: number;
  isSelected: boolean;
  heatFraction: number;
  showHeat: boolean;
  nodeActivity: number;
  isEntry: boolean;
  onClick: () => void;
}) {
  const { x, y, w, h } = pos;
  const r = 12;

  const baseBg    = status === "running" ? "var(--live-tint)" : status === "done" ? "var(--ok-tint)" : "var(--surface)";
  const heatRgba  = heatFraction > 0 ? `rgba(217,119,6,${Math.min(0.78, heatFraction * 0.85)})` : "transparent";
  const border    = status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : (isSelected || isEntry) ? "var(--brand)" : "var(--line)";
  const bw        = status !== "idle" || isSelected || isEntry ? 2 : 1;

  // Capability pills — up to 3, then "+N". Each pill: teal SVG glyph + label.
  const caps = node.capabilities.slice(0, 3);
  const extra = node.capabilities.length - caps.length;
  const PILL_H = 18;
  const PILL_PAD_X = 6;
  const GLYPH = 11;
  const PILL_START_Y = y + 62;

  let pillX = x + 10;
  const pills: Array<{ name: string | null; text: string; px: number; pw: number }> = [];
  for (const c of caps) {
    const label = c.name.length > 8 ? c.name.slice(0, 7) + "…" : c.name;
    const pw = Math.min(78, label.length * 6.5 + GLYPH + PILL_PAD_X * 2 + 3);
    pills.push({ name: c.name, text: label, px: pillX, pw });
    pillX += pw + 5;
  }
  if (extra > 0) pills.push({ name: null, text: `+${extra}`, px: pillX, pw: 26 });

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
      <text x={x + 14} y={y + 20} fontSize={13} fontWeight={600}
        fill={status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink)"}
        dominantBaseline="middle">
        {node.role.length > 22 ? node.role.slice(0, 20) + "…" : node.role}
      </text>

      {/* node id — secondary, muted mono */}
      <text x={x + 14} y={y + 38} fontSize={11} fill="var(--ink-muted)" dominantBaseline="middle" fontFamily="var(--font-mono)">
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

      {/* activity badge — when the activity heat-map is on, show how many effects
          ran at this node (no cost, ever). Top-right corner. */}
      {showHeat && nodeActivity > 0 && (
        <g>
          <rect x={x + w - 52} y={y + 8} width={44} height={16} rx={8}
            fill="rgba(217,119,6,0.14)" stroke="rgba(217,119,6,0.55)" strokeWidth={1} />
          <text x={x + w - 30} y={y + 16} fontSize={10} fontWeight={600}
            fill="rgb(180,83,9)" textAnchor="middle" dominantBaseline="middle">
            {nodeActivity === 1 ? "1 step" : `${nodeActivity} steps`}
          </text>
        </g>
      )}

      {/* status row */}
      <g>
        {status === "running" && (
          <>
            <circle cx={x + 12} cy={y + h - 14} r={3} fill="var(--live)" aria-label="running">
              <animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite" />
            </circle>
            <text x={x + 20} y={y + h - 14} fontSize={11} fill="var(--live)" fontWeight={600} dominantBaseline="middle">running</text>
          </>
        )}
        {status === "done" && (
          <>
            <text x={x + 10} y={y + h - 14} fontSize={11} fill="var(--ok)" dominantBaseline="middle" aria-label="done">✓</text>
            <text x={x + 22} y={y + h - 14} fontSize={11} fill="var(--ok)" fontWeight={600} dominantBaseline="middle">
              done{visits > 1 ? ` ×${visits}` : ""}
            </text>
          </>
        )}
        {status === "idle" && (
          <text x={x + 12} y={y + h - 14} fontSize={11} fill="var(--ink-muted)" dominantBaseline="middle">waiting</text>
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
      className="btn btn-secondary btn-sm"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{ height: 24, padding: "0 var(--s2)", fontSize: 11, color: copied ? "var(--ok)" : "var(--ink-muted)" }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── Node detail drawer (right side) ──────────────────────────────────────────

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-label="Close"
      className="btn btn-ghost"
      style={{
        width: 28, height: 28, padding: 0, borderRadius: "var(--r)",
        color: "var(--ink-muted)", fontSize: 16, flexShrink: 0,
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

  // Per-capability activity — how many effects each capability ran at this node.
  const perCapActivity = Object.entries(projection?.perCapActivity ?? {})
    .filter(([k]) => k.startsWith(`${node.id}:`))
    .map(([k, v]) => ({ cap: k.slice(node.id.length + 1), count: v as number }));

  // Node events from ledger
  const nodeEvents = events.filter(e => e.nodeId === node.id);

  // EffectResult outputs for deep inspection
  const effectOutputs = nodeEvents
    .filter(e => e.type === "EffectResult")
    .map(e => {
      const p = e.payload as Record<string, unknown>;
      return { cap: String(p["capabilityName"] ?? ""), output: p["output"] };
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
          <div className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s1)", wordBreak: "break-word" }}>{node.role}</div>
          {/* id is secondary */}
          <div className="mono micro" style={{ color: "var(--ink-muted)", marginBottom: "var(--s2)", wordBreak: "break-all", textTransform: "none", letterSpacing: 0 }}>{node.id}</div>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
            <span className={status === "running" ? "badge badge-running" : status === "done" ? "badge badge-done" : "badge badge-neutral"}>
              {status === "running" && <span className="dot" aria-hidden="true" />}
              {status}{ns?.visits ? ` · ${ns.visits}×` : ""}
            </span>
            <span className="badge badge-neutral">
              {node.autonomy}
            </span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div style={{ padding: "var(--s4) var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s5)", flex: 1 }}>

        {/* Capabilities */}
        <section>
          <div className="micro" style={{ marginBottom: "var(--s3)" }}>Capabilities</div>
          {node.capabilities.length === 0
            ? <span className="small muted">No capabilities</span>
            : node.capabilities.map(c => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)", padding: "var(--s2) 0", borderBottom: "1px solid var(--line)" }}>
                <span className="small" style={{ display: "flex", alignItems: "center", gap: "var(--s2)", minWidth: 0 }}>
                  <CapGlyphInline name={c.name} />
                  <span className="mono text-truncate" style={{ color: "var(--brand)" }}>{c.name}</span>
                </span>
                <span className="micro" style={{ flexShrink: 0, textTransform: "none", letterSpacing: 0 }}>{c.sideEffect}</span>
              </div>
            ))
          }
        </section>

        {/* Outputs from run state */}
        {nodeState.length > 0 && (
          <section>
            <div className="micro" style={{ marginBottom: "var(--s3)" }}>Outputs</div>
            {nodeState.map(({ key, value }) => {
              const text = (() => { const s = String(value); try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } })();
              return (
                <div key={key} style={{ marginBottom: "var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s3)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s2)" }}>
                    <span className="mono micro text-truncate" style={{ color: "var(--brand)", textTransform: "none", letterSpacing: 0 }}>{key}</span>
                    <CopyButton text={text} />
                  </div>
                  <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontSize: 11, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", lineHeight: 1.5 }}>
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
            <div className="micro" style={{ marginBottom: "var(--s3)" }}>Effect Results</div>
            {effectOutputs.map((ef, i) => {
              const text = (() => { const s = typeof ef.output === "string" ? ef.output : JSON.stringify(ef.output, null, 2); try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } })();
              return (
                <div key={i} style={{ marginBottom: "var(--s3)", background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s3)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s2)" }}>
                    <span className="mono micro text-truncate" style={{ color: "var(--brand)", textTransform: "none", letterSpacing: 0 }}>{ef.cap}</span>
                    <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexShrink: 0 }}>
                      <CopyButton text={text} />
                    </div>
                  </div>
                  <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontSize: 11, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", lineHeight: 1.5 }}>
                    {text}
                  </pre>
                </div>
              );
            })}
          </section>
        )}

        {/* Capabilities used by this node — with per-capability activity counts */}
        {perCapActivity.length > 0 && (
          <section>
            <div className="micro" style={{ marginBottom: "var(--s3)" }}>Capabilities used</div>
            {perCapActivity.map(({ cap, count }) => (
              <div key={cap} className="small" style={{ display: "flex", alignItems: "center", gap: "var(--s2)", padding: "var(--s1) 0" }}>
                <span className="status-dot done" aria-hidden="true" style={{ width: 6, height: 6 }} />
                <span className="mono soft text-truncate" style={{ flex: 1 }}>{cap}</span>
                <span className="micro" style={{ flexShrink: 0, textTransform: "none", letterSpacing: 0 }}>
                  {count === 1 ? "1 step" : `${count} steps`}
                </span>
              </div>
            ))}
          </section>
        )}

        {/* Ledger events */}
        {nodeEvents.length > 0 && (
          <section>
            <div className="micro" style={{ marginBottom: "var(--s3)" }}>Events ({nodeEvents.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)" }}>
              {nodeEvents.map(e => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "var(--s3)", padding: "var(--s1) 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="mono micro" style={{ color: "var(--ink-muted)", width: 28, flexShrink: 0, textTransform: "none", letterSpacing: 0 }}>#{e.offset}</span>
                  <span className="micro" style={{
                    fontWeight: 600, flexShrink: 0, textTransform: "none", letterSpacing: 0,
                    color: e.type === "NodeConcluded" ? "var(--ok)" : e.type.includes("Failed") ? "var(--danger)" : e.type === "NodeEntered" ? "var(--brand)" : "var(--ink-soft)",
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
              className="micro"
              onClick={() => setShowGlobal(s => !s)}
              aria-expanded={showGlobal}
              style={{
                width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                marginBottom: showGlobal ? "var(--s3)" : 0,
              }}
            >
              Full run state ({globalState.length} keys)
              <span aria-hidden="true">{showGlobal ? "▴" : "▾"}</span>
            </button>
            {showGlobal && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {globalState.map(({ key, value }) => (
                  <div key={key} style={{ background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s2) var(--s3)" }}>
                    <div className="mono micro" style={{ color: "var(--ink-muted)", marginBottom: "var(--s1)", textTransform: "none", letterSpacing: 0 }}>{key}</div>
                    <div className="small soft" style={{ wordBreak: "break-word", maxHeight: 60, overflow: "hidden" }}>
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
