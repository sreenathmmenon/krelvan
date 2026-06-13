"use client";

import { useState, useEffect, use, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { getRun, getRunEvents, listApprovals, resolveApproval, explainRun, startRun, timeAgo, type RunDetail, type RunManifest, type LedgerEvent, type PendingApproval, type RunExplanation, API_BASE } from "../../../lib/api";
import { layoutGraph, graphBounds, edgePath } from "../../../lib/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManifestNode { id: string; role: string; capabilities: { name: string; sideEffect: string; budgetCents: number }[]; autonomy: string; }
import { type ManifestExpr } from "../../../lib/api";
import { type NodePos } from "../../../lib/layout";
interface ManifestEdge  { from: string; to: string; when?: ManifestExpr; }
type Manifest = RunManifest;


// ── Main page ─────────────────────────────────────────────────────────────────

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { id } = use(params);
  const [detail, setDetail]     = useState<RunDetail | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [events, setEvents]     = useState<LedgerEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState<"output" | "canvas" | "timeline" | "state" | "explain">("output");
  const [explanation, setExplanation] = useState<RunExplanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  // Initial load — fetch run + events once
  const load = useCallback(async () => {
    const [d, evs] = await Promise.all([getRun(id), getRunEvents(id)]);
    setDetail(d);
    setEvents(evs);
  }, [id]);

  // Load pending approvals for this run
  const loadApprovals = useCallback(async () => {
    try {
      const all = await listApprovals();
      setApprovals(all.filter(a => a.runId === id));
    } catch { /* ignore */ }
  }, [id]);

  // SSE subscription — real-time event streaming while run is live
  const connectSSE = useCallback(() => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    const es = new EventSource(`${API_BASE}/api/runs/${id}/stream`);
    sseRef.current = es;

    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as LedgerEvent;
        setEvents(prev => {
          if (prev.some(p => p.id === e.id)) return prev;
          return [...prev, e];
        });
      } catch { /* malformed */ }
    };

    es.addEventListener("status", (msg: MessageEvent) => {
      try {
        const { status, finishedAt } = JSON.parse(msg.data) as { status: string; finishedAt?: number };
        setDetail(prev => prev ? {
          ...prev,
          run: { ...prev.run, status: status as RunDetail["run"]["status"], finishedAt },
        } : prev);
        // When halted, check for pending approvals
        if (status === "halted") void loadApprovals();
      } catch { /* ignore */ }
    });

    es.addEventListener("done", () => {
      es.close();
      sseRef.current = null;
      // Final sync to pick up complete projection
      void getRun(id).then(d => setDetail(d));
    });

    es.onerror = () => {
      es.close();
      sseRef.current = null;
    };
  }, [id, loadApprovals]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
    void loadApprovals();
  }, [id, load, loadApprovals]);

  // Once we have detail, decide whether to open SSE
  useEffect(() => {
    if (!detail) return;
    if (detail.run.status === "running" || detail.run.status === "pending") {
      connectSSE();
    }
    return () => {
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, [detail?.run.status, connectSSE]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate explanation when run completes — no click required
  const autoExplainedRef = useRef(false);
  useEffect(() => {
    if (autoExplainedRef.current) return;
    if (!detail) return;
    if (detail.run.status !== "completed" && detail.run.status !== "failed") return;
    if (explanation) return;
    autoExplainedRef.current = true;
    setExplaining(true);
    setExplainError(null);
    void explainRun(id)
      .then(res => setExplanation(res))
      .catch(err => setExplainError((err as Error).message))
      .finally(() => setExplaining(false));
  }, [detail?.run.status, explanation, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleResolveApproval(correlationId: string, decision: "approve" | "deny") {
    setResolving(correlationId);
    try {
      await resolveApproval(correlationId, id, decision);
      setApprovals(prev => prev.filter(a => a.correlationId !== correlationId));
      if (decision === "approve") {
        // Status update triggers the useEffect which opens SSE — do not call connectSSE() directly
        setDetail(prev => prev ? { ...prev, run: { ...prev.run, status: "running" } } : prev);
      } else {
        setDetail(prev => prev ? { ...prev, run: { ...prev.run, status: "failed" } } : prev);
      }
    } finally {
      setResolving(null);
    }
  }

  async function handleRunAgain() {
    if (!detail || startingRun) return;
    setStartingRun(true);
    try {
      const newRun = await startRun(detail.run.agentId);
      router.push(`/runs/${newRun.runId}`);
    } catch { /* ignore */ } finally {
      setStartingRun(false);
    }
  }

  if (loading) return <div className="container" style={{ paddingTop: "var(--s7)" }}><p className="soft small">Loading…</p></div>;
  if (!detail)  return <div className="container" style={{ paddingTop: "var(--s7)" }}><p className="soft small">Run not found.</p></div>;

  const { run, manifest: apiManifest, projection } = detail;

  // Use the actual manifest from the API when available (agent still registered).
  // Fall back to reconstructing from ledger events only if the agent has been deleted.
  const syntheticManifest = apiManifest ?? buildSyntheticManifest(events, projection, run.manifestName);

  const statusColor = run.status === "completed" ? "var(--ok)"
    : run.status === "failed" ? "var(--danger)"
    : run.status === "running" ? "var(--live)"
    : run.status === "halted" ? "var(--live)"
    : "var(--paused)";

  const isLiveSSE = sseRef.current !== null;

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

      {/* HITL approval banner */}
      {approvals.length > 0 && (
        <div style={{
          marginBottom: "var(--s5)", padding: "var(--s4) var(--s5)",
          background: "var(--live-tint)", border: "1.5px solid var(--live)",
          borderRadius: "var(--r)", display: "flex", flexDirection: "column", gap: "var(--s3)",
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--live)", display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span>⏸</span> Run paused — waiting for your approval
          </div>
          {approvals.map(a => (
            <div key={a.correlationId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "var(--s3)", background: "var(--surface)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Node <strong>{a.nodeId}</strong> wants to call <strong>{a.capability}</strong>
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>Approve to proceed · deny to stop the run.</div>
              </div>
              <div style={{ display: "flex", gap: "var(--s2)" }}>
                <button
                  className="btn btn-sm"
                  style={{ background: "var(--danger-tint)", color: "var(--danger)", border: "none", opacity: resolving ? .6 : 1 }}
                  disabled={resolving !== null}
                  onClick={() => void handleResolveApproval(a.correlationId, "deny")}
                >
                  {resolving === a.correlationId ? "…" : "✗ Deny"}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ opacity: resolving ? .6 : 1 }}
                  disabled={resolving !== null}
                  onClick={() => void handleResolveApproval(a.correlationId, "approve")}
                >
                  {resolving === a.correlationId ? "…" : "✓ Approve"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* header */}
      <div style={{ marginBottom: "var(--s6)" }}>
        <div style={{ marginBottom: "var(--s2)" }}>
          <div style={{ display: "flex", gap: "var(--s4)", alignItems: "center" }}>
            <a href="/runs" style={{ fontSize: 12, color: "var(--ink-muted)", textDecoration: "none" }}>← All runs</a>
            <a href={`/canvas/${run.agentId}?run=${id}`} style={{ fontSize: 12, color: "var(--brand)", textDecoration: "none", fontWeight: 500 }}>Open in Canvas ↗</a>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s4)" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", marginBottom: "var(--s1)" }}>{run.manifestName}</h1>
            <div style={{ display: "flex", gap: "var(--s4)", flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{run.runId}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{timeAgo(run.createdAt)}</span>
              {isLiveSSE && (
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--live)", display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="status-dot running" style={{ width: 6, height: 6 }} />
                  live
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--s2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: statusColor, display: "flex", alignItems: "center", gap: 6 }}>
              {(run.status === "running" || run.status === "halted") && <span className="status-dot running" />}
              {run.status === "halted" ? "awaiting approval" : run.status}
            </div>
            {run.spentCents != null && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 600, color: "var(--ink)" }}>{run.spentCents}¢</div>
            )}
            {(run.status === "completed" || run.status === "failed") && (
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                <a href={`/canvas/${run.agentId}`} className="btn btn-secondary btn-sm">View agent →</a>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={startingRun}
                  onClick={() => void handleRunAgain()}
                  style={{ opacity: startingRun ? 0.6 : 1 }}
                >
                  {startingRun ? "Starting…" : "▶ Run again"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* budget bar */}
      <BudgetBar spent={projection.budget.runSpentCents} total={projection.budget.runReservedCents || run.spentCents || 200} status={run.status} />

      {/* auto-explanation banner — shown above tabs, no click required */}
      {(explaining || explanation || explainError) && (run.status === "completed" || run.status === "failed") && (
        <div style={{
          marginTop: "var(--s5)",
          padding: "var(--s4) var(--s5)",
          background: explanation ? "var(--surface)" : "var(--canvas)",
          border: `1px solid ${explanation ? "var(--line)" : "var(--line-strong)"}`,
          borderRadius: "var(--r)",
          boxShadow: explanation ? "var(--shadow-sm)" : "none",
        }}>
          {explaining && !explanation && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", color: "var(--ink-muted)", fontSize: 13 }}>
              <span style={{
                width: 14, height: 14, borderRadius: "50%",
                border: "2px solid var(--brand)", borderTopColor: "transparent",
                display: "inline-block", animation: "spin 0.8s linear infinite",
                flexShrink: 0,
              }} />
              Generating explanation…
            </div>
          )}
          {explanation && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s3)" }}>
                <span className="micro" style={{ color: "var(--brand)" }}>✦ Agent reasoning</span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s4)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)" }}>{timeAgo(explanation.generatedAt)}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ opacity: explaining ? .6 : 1 }}
                    disabled={explaining}
                    onClick={() => {
                      setExplaining(true);
                      setExplainError(null);
                      void explainRun(id).then(res => setExplanation(res)).catch(err => setExplainError((err as Error).message)).finally(() => setExplaining(false));
                    }}
                  >
                    {explaining ? "Generating…" : "Regenerate"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.75, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {explanation.explanation}
              </div>
            </div>
          )}
          {explainError && !explanation && (
            <div style={{ fontSize: 13, color: "var(--danger)", display: "flex", alignItems: "center", gap: "var(--s3)" }}>
              <span>⚠</span> {explainError}
              <button className="btn btn-secondary btn-sm" onClick={() => {
                setExplaining(true); setExplainError(null);
                void explainRun(id).then(res => setExplanation(res)).catch(err => setExplainError((err as Error).message)).finally(() => setExplaining(false));
              }}>Retry</button>
            </div>
          )}
        </div>
      )}

      {/* tabs */}
      <div role="tablist" aria-label="Run detail" style={{ display: "flex", gap: 0, marginBottom: "var(--s5)", borderBottom: "1px solid var(--line)", marginTop: "var(--s5)" }}>
        {(["output", "canvas", "timeline", "state", "explain"] as const).map(t => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            onClick={() => setTab(t)}
            style={{
              padding: "var(--s3) var(--s4)", border: "none", background: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 500,
              color: tab === t ? "var(--brand)" : "var(--ink-muted)",
              borderBottom: tab === t ? "2px solid var(--brand)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {t === "canvas" ? "Graph" : t === "explain" ? "Explain" : t === "output" ? "Output" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* output — primary result panel */}
      {tab === "output" && (
        <OutputPanel projection={projection} manifest={syntheticManifest} run={run} />
      )}

      {/* canvas / graph */}
      {tab === "canvas" && (
        <div role="tabpanel" id="panel-canvas" aria-labelledby="tab-canvas" style={{ display: "grid", gridTemplateColumns: selectedNode ? "1fr 300px" : "1fr", gap: "var(--s5)", alignItems: "start" }}>
          <GraphCanvas
            manifest={syntheticManifest}
            projection={projection}
            events={events}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
          {selectedNode && (
            <NodeDetail
              nodeId={selectedNode}
              projection={projection}
              events={events}
              budgetCents={syntheticManifest.nodes.find(n => n.id === selectedNode)?.capabilities.reduce((s, c) => s + c.budgetCents, 0) ?? 0}
              onClose={() => setSelectedNode(null)}
            />
          )}
        </div>
      )}

      {/* timeline */}
      {tab === "timeline" && (
        <div role="tabpanel" id="panel-timeline" aria-labelledby="tab-timeline" className="card" style={{ padding: 0, overflow: "hidden" }}>
          {events.length === 0 && <p style={{ padding: "var(--s4)", fontSize: 13, color: "var(--ink-muted)" }}>No events yet.</p>}
          {events.map((e, i) => (
            <div key={e.id} style={{
              display: "grid", gridTemplateColumns: "36px 170px 1fr 90px",
              gap: "var(--s3)", padding: "var(--s3) var(--s4)",
              borderTop: i === 0 ? "none" : "1px solid var(--line)",
              fontSize: 12, alignItems: "center",
              background: i % 2 === 0 ? "transparent" : "var(--canvas)",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)" }}>#{e.offset}</span>
              <span style={{ fontWeight: 600, color: eventColor(e.type), fontSize: 11 }}>{e.type}</span>
              <span style={{ color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.nodeId && <><span style={{ color: "var(--brand)", fontWeight: 500 }}>{e.nodeId}</span> · </>}
                {eventDetail(e)}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: 10, color: "var(--ink-muted)" }}>{e.author.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}

      {/* state */}
      {tab === "state" && (
        <div role="tabpanel" id="panel-state" aria-labelledby="tab-state">
          {Object.keys(projection.state).length === 0
            ? <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>No run state yet.</p>
            : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "var(--s3)" }}>
                {Object.entries(projection.state)
                  .filter(([k]) => !k.startsWith("_"))
                  .map(([k, v]) => (
                    <div key={k} className="card" style={{ padding: "var(--s4)" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--brand)", marginBottom: 4, wordBreak: "break-all" }}>{k}</div>
                      <div style={{ fontSize: 13, color: "var(--ink)", wordBreak: "break-word", maxHeight: 80, overflow: "hidden" }}>
                        {String(v).slice(0, 200)}
                      </div>
                    </div>
                  ))}
              </div>
            )}
        </div>
      )}

      {/* explain */}
      {tab === "explain" && (
        <div role="tabpanel" id="panel-explain" aria-labelledby="tab-explain">
        <ExplainPanel
          runId={id}
          status={run.status}
          explanation={explanation}
          loading={explaining}
          error={explainError}
          onGenerate={async () => {
            setExplaining(true);
            setExplainError(null);
            try {
              const result = await explainRun(id);
              setExplanation(result);
            } catch (err) {
              setExplainError((err as Error).message);
            } finally {
              setExplaining(false);
            }
          }}
        />
        </div>
      )}
    </div>
  );
}

// ── Output Panel ──────────────────────────────────────────────────────────────

function OutputPanel({ projection, manifest, run }: {
  projection: RunDetail["projection"];
  manifest: Manifest;
  run: RunDetail["run"];
}) {
  const [copied, setCopied] = useState(false);
  const state = projection.state;

  // Extract the "primary output" — ordered priority:
  // 1. compose.text (human-readable composed text)
  // 2. last node's .result  (think result from final node)
  // 3. any .result key from any node
  // 4. any .body key (http_get response)
  // 5. any long string value (> 100 chars)
  type OutputBlock = { label: string; nodeId: string; key: string; value: string; kind: "text" | "data" };
  const outputs: OutputBlock[] = [];

  // Collect all node results in node order
  const nodeOrder = manifest.nodes.map(n => n.id);

  // Pass 1: compose.text and think results (ordered by node)
  for (const nodeId of nodeOrder) {
    const textKey = `${nodeId}.text`;
    const resultKey = `${nodeId}.result`;
    if (typeof state[textKey] === "string" && String(state[textKey]).length > 20) {
      outputs.push({ label: "Composed text", nodeId, key: textKey, value: String(state[textKey]), kind: "text" });
    }
    if (typeof state[resultKey] === "string" && String(state[resultKey]).length > 20) {
      outputs.push({ label: "Result", nodeId, key: resultKey, value: String(state[resultKey]), kind: "text" });
    }
  }

  // Pass 2: .body keys (http_get / web.fetch responses)
  for (const nodeId of nodeOrder) {
    const bodyKey = `${nodeId}.body`;
    if (typeof state[bodyKey] === "string" && String(state[bodyKey]).length > 20) {
      outputs.push({ label: "Fetched data", nodeId, key: bodyKey, value: String(state[bodyKey]), kind: "data" });
    }
  }

  // Pass 3: web_search snippet
  for (const nodeId of nodeOrder) {
    const snippetKey = `${nodeId}.results`;
    if (state[snippetKey] !== undefined) {
      try {
        const arr = JSON.parse(String(state[snippetKey])) as { title?: string; snippet?: string }[];
        if (Array.isArray(arr) && arr.length > 0) {
          const text = arr.map((r, i) => `${i + 1}. **${r.title ?? ""}**\n${r.snippet ?? ""}`).join("\n\n");
          outputs.push({ label: "Search results", nodeId, key: snippetKey, value: text, kind: "text" });
        }
      } catch { /* not JSON */ }
    }
  }

  // Scalar summary: all non-internal non-long keys grouped by node
  const scalarsByNode: Record<string, { key: string; value: string }[]> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("_")) continue;
    const val = String(v);
    if (val.length > 300) continue; // long text already shown above
    if (k.endsWith(".thought") || k.endsWith(".next") || k.endsWith(".body")) continue;
    const dot = k.indexOf(".");
    const nodeId = dot >= 0 ? k.slice(0, dot) : k;
    const shortKey = dot >= 0 ? k.slice(dot + 1) : k;
    if (!scalarsByNode[nodeId]) scalarsByNode[nodeId] = [];
    scalarsByNode[nodeId].push({ key: shortKey, value: val });
  }

  const isRunning = run.status === "running";
  const isFailed = run.status === "failed";

  function copyAll() {
    const text = outputs.map(o => `## ${o.label} (${o.nodeId})\n\n${o.value}`).join("\n\n---\n\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (isRunning) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "var(--s9) 0", gap: "var(--s3)" }}>
        <span className="status-dot running" style={{ width: 10, height: 10 }} />
        <p style={{ fontSize: 14, color: "var(--ink-muted)" }}>Agent is running — output will appear here when complete.</p>
      </div>
    );
  }

  if (isFailed) {
    return (
      <div className="card" style={{ padding: "var(--s5)", borderColor: "var(--err)", background: "var(--err-tint, #fff5f5)" }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--err)", marginBottom: "var(--s2)" }}>Run failed</p>
        <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>{run.reason ?? "No error details available."}</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>

      {/* Primary outputs */}
      {outputs.length === 0 && (
        <div className="card" style={{ padding: "var(--s5)", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            No text output produced. Check the <strong>State</strong> tab for raw values.
          </p>
        </div>
      )}

      {outputs.map((o, idx) => (
        <div key={o.key} className="card" style={{ padding: 0, overflow: "hidden" }}>
          {/* header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "var(--s3) var(--s4)",
            borderBottom: "1px solid var(--line)",
            background: "var(--surface-sunken)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand)", textTransform: "uppercase", letterSpacing: ".06em" }}>{o.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)", background: "var(--line)", padding: "2px 6px", borderRadius: 4 }}>{o.nodeId}</span>
            </div>
            {idx === 0 && outputs.length > 0 && (
              <button onClick={copyAll} style={{
                fontSize: 11, color: "var(--ink-muted)", background: "none", border: "1px solid var(--line)",
                borderRadius: 6, padding: "3px 10px", cursor: "pointer",
              }}>
                {copied ? "Copied!" : "Copy all"}
              </button>
            )}
          </div>
          {/* body */}
          <div style={{ padding: "var(--s5)", fontSize: 14, color: "var(--ink)", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {o.value}
          </div>
        </div>
      ))}

      {/* Scalar decisions summary */}
      {Object.keys(scalarsByNode).length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line)", background: "var(--surface-sunken)" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Decisions &amp; values</span>
          </div>
          <div style={{ padding: "var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
            {nodeOrder.filter(nid => scalarsByNode[nid]?.length).map(nodeId => (
              <div key={nodeId}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", marginBottom: "var(--s2)", fontFamily: "var(--font-mono)" }}>{nodeId}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
                  {scalarsByNode[nodeId].map(({ key, value }) => (
                    <div key={key} style={{
                      display: "flex", gap: 6, alignItems: "baseline",
                      background: "var(--surface-sunken)", borderRadius: 6, padding: "4px 10px",
                      border: "1px solid var(--line)",
                    }}>
                      <span style={{ fontSize: 11, color: "var(--ink-muted)", fontFamily: "var(--font-mono)" }}>{key}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Explain Panel ─────────────────────────────────────────────────────────────

function ExplainPanel({ runId, status, explanation, loading, error, onGenerate }: {
  runId: string;
  status: string;
  explanation: RunExplanation | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => Promise<void>;
}) {
  const isTerminal = status === "completed" || status === "failed";

  return (
    <div style={{ maxWidth: 720 }}>
      {/* explanation output or empty state */}
      {explanation ? (
        <div className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
            <span className="micro">Explanation</span>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s4)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)" }}>
                {timeAgo(explanation.generatedAt)}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                style={{ opacity: loading ? .6 : 1 }}
                disabled={loading}
                onClick={() => void onGenerate()}
              >
                {loading ? "Generating…" : "Regenerate"}
              </button>
            </div>
          </div>
          {!isTerminal && (
            <div style={{ fontSize: 12, color: "var(--live)", marginBottom: "var(--s4)", fontWeight: 500, padding: "var(--s2) var(--s3)", background: "var(--live-tint)", borderRadius: "var(--r)" }}>
              Run is still {status} — regenerate once it finishes for a complete picture.
            </div>
          )}
          <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {explanation.explanation}
          </div>
        </div>
      ) : (
        <div style={{
          padding: "var(--s9) var(--s6)", textAlign: "center",
          background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)",
          backgroundImage: "radial-gradient(circle at 50% 40%, rgba(14,124,117,.03) 0%, transparent 60%)",
        }}>
          <div style={{ fontSize: 40, marginBottom: "var(--s5)" }}>✦</div>
          <p style={{ fontSize: 16, fontWeight: 600, marginBottom: "var(--s3)", color: "var(--ink)", letterSpacing: "-.01em" }}>
            Understand this run in plain English
          </p>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", maxWidth: "44ch", margin: "0 auto var(--s6)", lineHeight: 1.6 }}>
            Krelvan reads every event in this run and explains what each node did, why it succeeded or failed, and what was spent.
          </p>
          {!isTerminal && (
            <p style={{ fontSize: 12, color: "var(--live)", marginBottom: "var(--s5)", fontWeight: 500 }}>
              Run is still {status} — you can explain it now or wait until it finishes.
            </p>
          )}
          <button
            className="btn btn-primary btn-lg"
            style={{ opacity: loading ? .6 : 1 }}
            disabled={loading}
            onClick={() => void onGenerate()}
          >
            {loading ? "Generating…" : "Generate explanation"}
          </button>
          {error && (
            <div style={{ marginTop: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--danger-tint)", borderRadius: "var(--r)", fontSize: 13, color: "var(--danger)" }}>
              {error}
            </div>
          )}
        </div>
      )}

      {explanation && error && (
        <div style={{ padding: "var(--s3) var(--s4)", background: "var(--danger-tint)", borderRadius: "var(--r)", fontSize: 13, color: "var(--danger)", marginTop: "var(--s3)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── Graph Canvas ──────────────────────────────────────────────────────────────

function GraphCanvas({ manifest, projection, events, selectedNode, onSelectNode }: {
  manifest: Manifest;
  projection: RunDetail["projection"];
  events: LedgerEvent[];
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const positions = layoutGraph(manifest.nodes, manifest.edges, manifest.entry);
  const { w, h } = graphBounds(positions);
  const PAD = 32;

  // Which edge is currently active (the edge TO the running node)
  const runningNode = Object.entries(projection.nodes).find(([, ns]) => ns.entered && !ns.concluded)?.[0] ?? null;
  const activeEdge = runningNode
    ? manifest.edges.find(e => e.to === runningNode)
    : null;

  return (
    <div
      className="card"
      style={{
        background: "var(--surface)",
        backgroundImage: "radial-gradient(circle at 65% 35%, rgba(14,124,117,.04) 0%, transparent 55%)",
        overflow: "auto",
        position: "relative",
      }}
    >
      {/* verified badge */}
      <div style={{
        position: "absolute", top: 12, right: 12, zIndex: 10,
        fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
        color: "var(--ok)", background: "var(--ok-tint)",
        padding: "3px 8px", borderRadius: "var(--r-pill)",
        display: "flex", alignItems: "center", gap: 5,
        cursor: "help",
      }} title="Append-only ledger — each event is HMAC-signed and cannot be altered after writing">
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ok)", display: "inline-block" }} />
        {events.length} events · HMAC verified
      </div>

      <svg
        width={w + PAD * 2}
        height={h + PAD * 2}
        style={{ display: "block", minHeight: 180 }}
      >
        <defs>
          {/* arrowhead marker — teal */}
          <marker id="arrow-done" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--ok)" />
          </marker>
          <marker id="arrow-active" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--live)" />
          </marker>
          <marker id="arrow-idle" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--line-strong)" />
          </marker>

          {/* animated dash for active edges */}
          <style>{`
            .edge-active-dash {
              stroke-dasharray: 8 6;
              stroke-dashoffset: 0;
              animation: svg-dash-flow 0.7s linear infinite;
            }
            @keyframes svg-dash-flow {
              to { stroke-dashoffset: -28; }
            }
          `}</style>
        </defs>

        <g transform={`translate(${PAD}, ${PAD})`}>
          {/* Edges */}
          {manifest.edges.map((edge) => {
            const fp = positions.get(edge.from);
            const tp = positions.get(edge.to);
            if (!fp || !tp) return null;

            const isActive = activeEdge?.from === edge.from && activeEdge?.to === edge.to;
            const isDone   = (projection.nodes[edge.to]?.concluded ?? false) ||
                             (projection.nodes[edge.to]?.entered ?? false);
            const d = edgePath(fp, tp);
            const stroke = isActive ? "var(--live)" : isDone ? "var(--ok)" : "var(--line-strong)";
            const marker = isActive ? "url(#arrow-active)" : isDone ? "url(#arrow-done)" : "url(#arrow-idle)";

            return (
              <g key={`${edge.from}-${edge.to}`}>
                {/* base path */}
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={isActive ? 2.5 : isDone ? 2 : 1.5}
                  markerEnd={marker}
                  style={{ transition: "stroke 400ms, stroke-width 400ms" }}
                />
                {/* animated dashes on active edge */}
                {isActive && (
                  <path
                    d={d}
                    fill="none"
                    stroke="var(--live)"
                    strokeWidth={2.5}
                    className="edge-active-dash"
                    style={{ opacity: 0.7 }}
                  />
                )}
                {/* traveling dot on active edge */}
                {isActive && <TravelingDotSvg path={d} />}
              </g>
            );
          })}

          {/* Nodes */}
          {manifest.nodes.map(node => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const ns = projection.nodes[node.id];
            const status = ns?.concluded ? "done" : ns?.entered ? "running" : "idle";
            const isSelected = selectedNode === node.id;

            return (
              <GraphNodeSvg
                key={node.id}
                node={node}
                pos={pos}
                status={status}
                visits={ns?.visits ?? 0}
                isSelected={isSelected}
                projection={projection}
                onClick={() => onSelectNode(isSelected ? null : node.id)}
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ── SVG Graph Node ────────────────────────────────────────────────────────────

function GraphNodeSvg({ node, pos, status, visits, isSelected, projection, onClick }: {
  node: ManifestNode;
  pos: NodePos;
  status: "running" | "done" | "idle";
  visits: number;
  isSelected: boolean;
  projection: RunDetail["projection"];
  onClick: () => void;
}) {
  const { x, y, w, h } = pos;
  const r = 10;

  const bg = status === "running" ? "#FEF3E0" : status === "done" ? "#DCFCE7" : "#FFFFFF";
  const borderColor = status === "running" ? "#D97706" : status === "done" ? "#16794C" : isSelected ? "#0E7C75" : "#E7E3DC";
  const borderWidth = status !== "idle" || isSelected ? 2 : 1;

  // Per-cap cost from projection
  const capCosts = node.capabilities.map(c => {
    const key = `${node.id}:${c.name}`;
    return { name: c.name, cents: projection.budget.perCapSpentCents[key] ?? 0 };
  });
  const totalCost = capCosts.reduce((s, c) => s + c.cents, 0);

  const iconMap: Record<string, string> = {
    think: "🧠", recall: "📚", remember: "💾", llm_route: "🔀",
    web_search: "🔍", compose: "✍️", notify_webhook: "📡",
    telegram_send: "✈️", email_send: "📧", http_get: "↓", http_post: "↑",
  };

  const capIcon = node.capabilities.length > 0
    ? (iconMap[node.capabilities[0]!.name] ?? "⚡")
    : "○";

  return (
    <g
      onClick={onClick}
      style={{ cursor: "pointer" }}
      role="button"
      aria-label={node.id}
    >
      {/* selection ring */}
      {isSelected && (
        <rect
          x={x - 4} y={y - 4}
          width={w + 8} height={h + 8}
          rx={r + 3}
          fill="none"
          stroke="var(--brand)"
          strokeWidth={2}
          opacity={0.35}
        />
      )}

      {/* running glow */}
      {status === "running" && (
        <rect
          x={x - 6} y={y - 6}
          width={w + 12} height={h + 12}
          rx={r + 4}
          fill="none"
          stroke="var(--live)"
          strokeWidth={3}
          opacity={0.25}
        >
          <animate attributeName="opacity" values="0.15;0.4;0.15" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="stroke-width" values="2;5;2" dur="1.6s" repeatCount="indefinite" />
        </rect>
      )}

      {/* node box */}
      <rect
        x={x} y={y}
        width={w} height={h}
        rx={r}
        fill={bg}
        stroke={borderColor}
        strokeWidth={borderWidth}
        style={{ transition: "fill 300ms, stroke 300ms" }}
      />

      {/* capability icon + name */}
      <text x={x + 12} y={y + 22} fontSize={18} dominantBaseline="middle">{capIcon}</text>
      <text
        x={x + 36} y={y + 21}
        fontSize={12} fontWeight={600}
        fill={status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink)"}
        dominantBaseline="middle"
      >
        {node.id.length > 18 ? node.id.slice(0, 16) + "…" : node.id}
      </text>

      {/* role */}
      <text x={x + 36} y={y + 38} fontSize={10} fill="#8A938F" dominantBaseline="middle">
        {node.role.length > 22 ? node.role.slice(0, 20) + "…" : node.role}
      </text>

      {/* status + cost row */}
      <g>
        {status === "running" && (
          <>
            <circle cx={x + 12} cy={y + 56} r={3} fill="var(--live)">
              <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
            </circle>
            <text x={x + 20} y={y + 56} fontSize={10} fill="var(--live)" fontWeight={600} dominantBaseline="middle">
              running
            </text>
          </>
        )}
        {status === "done" && (
          <>
            <text x={x + 10} y={y + 56} fontSize={11} fill="var(--ok)" dominantBaseline="middle">✓</text>
            <text x={x + 22} y={y + 56} fontSize={10} fill="var(--ok)" fontWeight={600} dominantBaseline="middle">
              done{visits > 1 ? ` ×${visits}` : ""}
            </text>
          </>
        )}
        {status === "idle" && (
          <text x={x + 10} y={y + 56} fontSize={10} fill="var(--ink-muted)" dominantBaseline="middle">
            waiting
          </text>
        )}
        {totalCost > 0 && (
          <text
            x={x + w - 8} y={y + 56}
            fontSize={10} fill="var(--brand)"
            fontFamily="var(--font-mono)"
            textAnchor="end"
            dominantBaseline="middle"
          >
            {totalCost}¢
          </text>
        )}
      </g>
    </g>
  );
}

// ── Traveling dot along an SVG path ──────────────────────────────────────────

function TravelingDotSvg({ path }: { path: string }) {
  return (
    <circle r={5} fill="var(--live)" style={{ filter: "drop-shadow(0 0 4px #D97706)" }}>
      <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
    </circle>
  );
}

// ── Node detail panel ─────────────────────────────────────────────────────────

function NodeDetail({ nodeId, projection, events, budgetCents, onClose }: {
  nodeId: string;
  projection: RunDetail["projection"];
  events: LedgerEvent[];
  budgetCents: number;
  onClose: () => void;
}) {
  const ns = projection.nodes[nodeId];
  const status = ns?.concluded ? "done" : ns?.entered ? "running" : "idle";

  // Collect events for this node
  const nodeEvents = events.filter(e => e.nodeId === nodeId);

  // Collect state keys from this node (namespaced as "nodeId.key")
  const nodeState = Object.entries(projection.state)
    .filter(([k]) => k.startsWith(`${nodeId}.`))
    .map(([k, v]) => ({ key: k.slice(nodeId.length + 1), value: v }));

  // Extract reasoning text from EffectResult output.thought
  const thoughtText = (() => {
    for (const e of nodeEvents) {
      if (e.type === "EffectResult") {
        const output = (e.payload as Record<string, unknown>)["output"] as Record<string, unknown> | undefined;
        const t = output?.["thought"];
        if (typeof t === "string" && t.length > 0) return t;
      }
    }
    return null;
  })();

  // Collect per-cap costs
  const perCapCosts = Object.entries(projection.budget.perCapSpentCents)
    .filter(([k]) => k.startsWith(`${nodeId}:`))
    .map(([k, v]) => ({ cap: k.slice(nodeId.length + 1), cents: v }));

  const totalCost = perCapCosts.reduce((s, c) => s + c.cents, 0);

  return (
    <div className="card" style={{ padding: "var(--s5)", position: "sticky", top: 72 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{nodeId}</div>
          <div style={{
            fontSize: 11, fontWeight: 600, marginTop: 2,
            color: status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink-muted)",
          }}>
            {status} {ns?.visits ? `· ${ns.visits} visit${ns.visits > 1 ? "s" : ""}` : ""}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--ink-muted)", padding: "8px", borderRadius: "var(--r)", transition: "background 120ms" }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-sunken)")}
          onMouseLeave={e => (e.currentTarget.style.background = "none")}
        >
          ×
        </button>
      </div>

      {/* outputs */}
      {nodeState.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s2)" }}>Outputs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            {nodeState.map(({ key, value }) => (
              <div key={key} style={{ background: "var(--surface-sunken)", padding: "var(--s2) var(--s3)", borderRadius: "var(--r)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--brand)", marginBottom: 2 }}>{key}</div>
                <div style={{ fontSize: 12, wordBreak: "break-word", maxHeight: 60, overflow: "hidden" }}>
                  {String(value).slice(0, 300)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* reasoning */}
      {thoughtText && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s2)" }}>Reasoning</div>
          <ReasoningBlock text={thoughtText} />
        </div>
      )}

      {/* cost */}
      {perCapCosts.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s2)" }}>Cost</div>
          {perCapCosts.map(({ cap, cents }) => (
            <div key={cap} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
              <span style={{ color: "var(--ink-soft)" }}>{cap}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--brand)" }}>{cents}¢</span>
            </div>
          ))}
          {perCapCosts.length > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--line)", marginTop: 4 }}>
              <span style={{ color: "var(--ink)", fontWeight: 600 }}>Total</span>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--ink)" }}>{totalCost}¢</span>
            </div>
          )}
        </div>
      )}

      {/* events for this node */}
      {nodeEvents.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "var(--s2)" }}>
            Events ({nodeEvents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {nodeEvents.map(e => (
              <div key={e.id} style={{ display: "flex", gap: "var(--s2)", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-muted)", minWidth: 20 }}>#{e.offset}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: eventColor(e.type) }}>{e.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {nodeState.length === 0 && perCapCosts.length === 0 && nodeEvents.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>Node has not run yet.</p>
      )}
    </div>
  );
}

// ── Reasoning block ───────────────────────────────────────────────────────────

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const SHORT = 280;
  const isLong = text.length > SHORT;
  const shown = expanded || !isLong ? text : text.slice(0, SHORT) + "…";
  return (
    <div style={{
      background: "var(--surface-sunken)", borderRadius: "var(--r)",
      padding: "var(--s3) var(--s4)",
      borderLeft: "2px solid var(--brand)",
    }}>
      <p style={{ fontSize: 12, lineHeight: 1.65, color: "var(--ink-soft)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {shown}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ marginTop: "var(--s2)", fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── Budget bar ────────────────────────────────────────────────────────────────

function BudgetBar({ spent, total, status }: { spent: number; total: number; status: string }) {
  const pct = Math.min(100, total > 0 ? Math.round((spent / total) * 100) : 0);
  const isLive = status === "running";
  return (
    <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--s2)", fontSize: 12 }}>
        <span style={{ color: "var(--ink-muted)" }}>Budget used</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>
          <span style={{ color: isLive ? "var(--live)" : "var(--ink)", fontWeight: 600 }}>{spent}¢</span>
          <span style={{ color: "var(--ink-muted)" }}> / {total}¢</span>
        </span>
      </div>
      <div style={{ height: 6, background: "var(--surface-sunken)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 999,
          background: status === "failed" ? "var(--danger)" : isLive ? "var(--live)" : "var(--brand)",
          width: `${pct}%`,
          transition: "width 400ms ease, background 300ms",
        }} />
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSyntheticManifest(events: LedgerEvent[], projection: RunDetail["projection"], name: string): Manifest {
  // Reconstruct node order and edges from ledger events
  const nodeOrder: string[] = [];
  for (const e of events) {
    if (e.type === "NodeEntered" && e.nodeId && !nodeOrder.includes(e.nodeId)) {
      nodeOrder.push(e.nodeId);
    }
  }

  // Build edges: consecutive NodeEntered events form an edge (first-order approximation)
  const edges: ManifestEdge[] = [];
  for (let i = 0; i < nodeOrder.length - 1; i++) {
    const from = nodeOrder[i]!, to = nodeOrder[i + 1]!;
    if (!edges.some(e => e.from === from && e.to === to)) {
      edges.push({ from, to });
    }
  }

  // Derive capability info from EffectRequested events
  const capsByNode = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type === "EffectRequested" && e.nodeId) {
      if (!capsByNode.has(e.nodeId)) capsByNode.set(e.nodeId, new Set());
      capsByNode.get(e.nodeId)!.add(String(e.payload["capability"] ?? "unknown"));
    }
  }

  const nodes: ManifestNode[] = nodeOrder.map(id => ({
    id,
    role: id,
    autonomy: "full",
    capabilities: [...(capsByNode.get(id) ?? [])].map(cap => ({
      name: cap,
      sideEffect: "read",
      budgetCents: projection.budget.perCapSpentCents[`${id}:${cap}`] ?? 0,
    })),
  }));

  // Include nodes from projection that weren't in NodeEntered events yet
  for (const nodeId of Object.keys(projection.nodes)) {
    if (!nodeOrder.includes(nodeId)) {
      nodes.push({ id: nodeId, role: nodeId, autonomy: "full", capabilities: [] });
    }
  }

  return {
    version: 1,
    name,
    intent: "",
    runBudgetCents: 0,
    maxNodeVisits: 1,
    entry: nodeOrder[0] ?? Object.keys(projection.nodes)[0] ?? "main",
    nodes,
    edges,
  };
}

function eventColor(type: string): string {
  if (type === "RunCompleted") return "var(--ok)";
  if (type === "RunFailed")    return "var(--danger)";
  if (type === "EffectResult") return "var(--brand)";
  if (type.startsWith("Node")) return "var(--live)";
  if (type === "AdmissionDecision") return "var(--ink-soft)";
  if (type === "AwaitRequested") return "var(--live)";
  if (type === "AwaitResolved")  return "var(--ok)";
  return "var(--ink-muted)";
}

function eventDetail(e: LedgerEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "RunStarted": return `manifest: ${String(p["manifest"] ?? "")}`;
    case "AdmissionDecision": return p["admitted"]
      ? `admitted · ${String(p["reservedCents"] ?? 0)}¢ reserved`
      : `DENIED: ${String(p["reason"] ?? "")}`;
    case "EffectRequested": return String(p["capability"] ?? "");
    case "EffectResult": return `${String(p["costCents"] ?? 0)}¢ · ${JSON.stringify(p["output"]).slice(0, 60)}`;
    case "NodeConcluded": return p["state"] ? JSON.stringify(p["state"]).slice(0, 60) : "concluded";
    case "SubRunRequested": return `sub-run: ${String(p["subRunId"] ?? "").slice(0, 16)}`;
    case "SubRunCompleted": return `completed · ${String(p["actualCostCents"] ?? 0)}¢`;
    case "SubRunFailed":    return `FAILED: ${String(p["reason"] ?? "")}`;
    case "AwaitRequested": {
      const cap = String((p["call"] as Record<string,unknown>)?.["capability"] ?? "");
      return `⏸ Waiting for approval to run ${cap}`;
    }
    case "AwaitResolved": {
      const decision = String(p["decision"] ?? "");
      return decision === "approve" ? "✓ Approved — run resumed" : "✗ Denied — run stopped";
    }
    default: return "";
  }
}
