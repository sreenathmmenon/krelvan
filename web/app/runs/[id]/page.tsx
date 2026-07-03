"use client";

import { useState, useEffect, use, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getRun, getRunEvents, verifyRun, listApprovals, resolveApproval, explainRun, diagnoseRun, retryRunWithFix, startRun, timeAgo, type RunDetail, type RunManifest, type LedgerEvent, type RunVerification, type PendingApproval, type RunExplanation, type RunDiagnosis, API_BASE } from "../../../lib/api";
import { layoutGraph, graphBounds, edgePath } from "../../../lib/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManifestNode { id: string; role: string; capabilities: { name: string; sideEffect: string; budgetCents: number }[]; autonomy: string; }
import { type ManifestExpr } from "../../../lib/api";
import { type NodePos } from "../../../lib/layout";
interface ManifestEdge  { from: string; to: string; when?: ManifestExpr; }
type Manifest = RunManifest;

// Single source of truth: run/node status → badge variant class.
const STATUS_BADGE_CLASS: Record<string, string> = {
  // run statuses
  completed: "badge-done",
  failed:    "badge-failed",
  running:   "badge-running",
  halted:    "badge-running",
  pending:   "badge-neutral",
  paused:    "badge-paused",
  // node statuses
  done:      "badge-done",
  idle:      "badge-neutral",
};


// The model sometimes returns its explanation wrapped in JSON (e.g.
// {"agent":"…","explanation":"…"}) or fenced in ```json. Unwrap it to the prose
// so the flagship "Agent reasoning" surface never shows raw JSON or a dangling brace.
function cleanExplanation(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  // strip a leading ```json / ``` fence if present
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const o = JSON.parse(s);
      const text = typeof o === "string" ? o
        : (o.explanation ?? o.summary ?? o.text ?? o.reasoning ?? o.result);
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch { /* not valid JSON — fall through and show as-is */ }
  }
  return s;
}

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
  const [diagnosis, setDiagnosis] = useState<RunDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [verification, setVerification] = useState<RunVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  async function runVerify() {
    setVerifying(true);
    try { setVerification(await verifyRun(id)); }
    catch (err) { setVerification({ ok: false, error: "request_failed", detail: (err as Error).message }); }
    finally { setVerifying(false); }
  }

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
      // Final sync to pick up complete projection, then show output
      void getRun(id).then(d => {
        setDetail(d);
        setTab("output");
      });
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

  // Auto-verify the signed ledger once the run has finished — the tamper-proof seal is the #1
  // wedge, so it should be visible on load (a green seal above the tabs), not 2 clicks deep.
  useEffect(() => {
    if (!detail || verification != null) return;
    const s = detail.run.status;
    if (s === "completed" || s === "failed" || s === "halted") void runVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.run.status]);

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

  // Polling fallback — if run is active and SSE hasn't delivered a done event,
  // poll every 4s so the UI never stays blank waiting for a result
  useEffect(() => {
    if (!detail) return;
    if (detail.run.status !== "running" && detail.run.status !== "pending") return;
    const t = setInterval(async () => {
      try {
        const d = await getRun(id);
        setDetail(d);
        if (d.run.status !== "running" && d.run.status !== "pending") {
          clearInterval(t);
          setTab("output");
        }
      } catch { /* ignore */ }
    }, 4000);
    return () => clearInterval(t);
  }, [detail?.run.status, id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Auto-diagnose failed / halted runs — failure-reasoning grounded in the ledger.
  useEffect(() => {
    if (!detail) return;
    if (detail.run.status !== "failed" && detail.run.status !== "halted") return;
    if (diagnosis || diagnosing) return;
    setDiagnosing(true);
    setDiagnoseError(null);
    void diagnoseRun(id)
      .then(res => setDiagnosis(res))
      .catch(err => setDiagnoseError((err as Error).message))
      .finally(() => setDiagnosing(false));
  }, [detail?.run.status, diagnosis, diagnosing, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRetryWithFix() {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await retryRunWithFix(id, diagnosis?.diagnosis.fixStrategy);
      router.push(`/runs/${res.run.runId}`);
    } catch (e) {
      setDiagnoseError((e as Error).message);
      setRetrying(false);
    }
  }

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

  if (loading) return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <div style={{ marginBottom: "var(--s6)" }}>
        <div className="skeleton skeleton-line" style={{ height: 28, width: 280, marginBottom: "var(--s3)" }} />
        <div className="skeleton skeleton-line" style={{ height: 12, width: 180 }} />
      </div>
      <div className="state-loading" style={{ flexDirection: "column", gap: "var(--s3)" }}>
        <span className="spinner" aria-hidden="true" />
        <span>Loading run…</span>
      </div>
    </div>
  );
  if (!detail) return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <div style={{ marginBottom: "var(--s6)" }}>
        <Link href="/runs" className="small" style={{ color: "var(--ink-muted)" }}>← All runs</Link>
      </div>
      <div className="state-empty">
        <div style={{ marginBottom: "var(--s3)", color: "var(--ink-muted)" }}><Glyph kind="search" size={32} /></div>
        <p className="h3" style={{ color: "var(--ink)" }}>This run could not be found</p>
        <p className="small soft" style={{ maxWidth: "40ch", margin: "0 auto", lineHeight: 1.6 }}>
          It may have been deleted, or the link is incorrect. Browse your runs to find what you&apos;re looking for.
        </p>
        <Link href="/runs" className="btn btn-primary" style={{ marginTop: "var(--s2)" }}>Back to all runs →</Link>
      </div>
    </div>
  );

  const { run, manifest: apiManifest, projection } = detail;

  // Use the actual manifest from the API when available (agent still registered).
  // Fall back to reconstructing from ledger events only if the agent has been deleted.
  const syntheticManifest = apiManifest ?? buildSyntheticManifest(events, projection, run.manifestName);

  const isLiveSSE = sseRef.current !== null;
  const isTerminalStatus = run.status === "completed" || run.status === "failed";

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

      {/* HITL approval banner */}
      {approvals.length > 0 && (
        <div style={{
          marginBottom: "var(--s5)", padding: "var(--s4) var(--s5)",
          background: "var(--live-tint)", border: "1px solid var(--live)",
          borderRadius: "var(--r)", display: "flex", flexDirection: "column", gap: "var(--s3)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span className="badge badge-running"><span className="dot" />paused</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--live)" }}>Run paused — waiting for your approval</span>
          </div>
          {approvals.map(a => (
            <div key={a.correlationId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "var(--s3)", background: "var(--surface)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Node <strong>{a.nodeId}</strong> wants to call <strong>{a.capability}</strong>
                </div>
                <div className="micro" style={{ marginTop: "var(--s1)", textTransform: "none", letterSpacing: 0 }}>Approve to proceed · deny to stop the run.</div>
              </div>
              <div style={{ display: "flex", gap: "var(--s2)" }}>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={resolving !== null}
                  onClick={() => void handleResolveApproval(a.correlationId, "deny")}
                >
                  {resolving === a.correlationId ? "…" : <><Glyph kind="cross" size={14} /> Deny</>}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={resolving !== null}
                  onClick={() => void handleResolveApproval(a.correlationId, "approve")}
                >
                  {resolving === a.correlationId ? "…" : <><Glyph kind="check" size={14} /> Approve</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* header */}
      <div style={{ marginBottom: "var(--s6)" }}>
        <nav aria-label="Breadcrumb" style={{ marginBottom: "var(--s4)", display: "flex", gap: "var(--s4)", alignItems: "center", flexWrap: "wrap" }}>
          <Link href="/runs" className="small" style={{ color: "var(--ink-muted)" }}>← All runs</Link>
          <span className="small" aria-hidden="true" style={{ color: "var(--line-strong)" }}>·</span>
          <Link href={`/canvas/${run.agentId}?run=${id}`} className="small" style={{ color: "var(--brand)", fontWeight: 500 }}>Open in Canvas ↗</Link>
        </nav>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s5)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
              <h1 className="h1" style={{ margin: 0 }}>{run.manifestName}</h1>
              {isLiveSSE && (
                <span className="badge badge-running"><span className="dot" />live</span>
              )}
            </div>
            <div style={{ display: "flex", gap: "var(--s4)", flexWrap: "wrap", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>{run.runId}</span>
              <span className="small" style={{ color: "var(--ink-muted)" }}>{timeAgo(run.createdAt)}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--s3)" }}>
            <span className={`badge ${STATUS_BADGE_CLASS[run.status] ?? "badge-neutral"}`}>
              {(run.status === "running" || run.status === "halted") && <span className="dot" />}
              {run.status === "halted" ? "awaiting approval" : run.status}
            </span>
            {isTerminalStatus && (
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                <Link href={`/canvas/${run.agentId}`} className="btn btn-secondary btn-sm">View agent →</Link>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={startingRun}
                  onClick={() => void handleRunAgain()}
                >
                  {startingRun ? "Starting…" : <><Glyph kind="play" size={13} /> Run again</>}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>


      {/* failure diagnosis — failure-reasoning over the signed ledger (failed/halted only) */}
      {(diagnosing || diagnosis || diagnoseError) && (run.status === "failed" || run.status === "halted") && (
        <div style={{
          marginTop: "var(--s5)",
          border: "1px solid var(--danger-ring)", borderLeft: "3px solid var(--danger)",
          borderRadius: "var(--r-lg)", background: "var(--surface)", boxShadow: "var(--shadow-sm)",
          overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", padding: "var(--s4) var(--s5)", background: "var(--danger-tint)", borderBottom: "1px solid var(--danger-ring)" }}>
            <span aria-hidden="true" style={{ color: "var(--danger)", display: "inline-flex" }}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M8 1.5l6.5 11.5H1.5L8 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M8 6.2v3.1M8 11.3h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            </span>
            <span className="micro" style={{ color: "var(--danger)", letterSpacing: ".06em" }}>Diagnosis</span>
            <span className="small muted">reasoned from the signed record</span>
          </div>
          <div style={{ padding: "var(--s5)" }}>
            {diagnosing && !diagnosis && (
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", color: "var(--ink-soft)", fontSize: 13 }}>
                <span className="spinner" aria-hidden="true" />
                Reasoning over every recorded step to find what went wrong…
              </div>
            )}
            {diagnoseError && !diagnosis && (
              <div className="small" style={{ color: "var(--ink-muted)" }}>Couldn&apos;t generate a diagnosis: {diagnoseError}</div>
            )}
            {diagnosis && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
                <div>
                  <div className="micro" style={{ marginBottom: "var(--s1)" }}>Root cause</div>
                  <p className="body-lg" style={{ margin: 0, lineHeight: 1.6, color: "var(--ink)" }}>{diagnosis.diagnosis.rootCause}</p>
                </div>
                <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap", alignItems: "center" }}>
                  <span className="micro" style={{ color: "var(--ink-muted)" }}>Failing step</span>
                  <span className="badge badge-failed mono">{diagnosis.diagnosis.failingStep}</span>
                </div>
                {diagnosis.diagnosis.contributingFactors.length > 0 && (
                  <div>
                    <div className="micro" style={{ marginBottom: "var(--s2)" }}>Contributing factors</div>
                    <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--s2)", padding: 0 }}>
                      {diagnosis.diagnosis.contributingFactors.map((f, i) => (
                        <li key={i} className="small" style={{ display: "flex", gap: "var(--s2)", color: "var(--ink-soft)", lineHeight: 1.55 }}>
                          <span aria-hidden="true" style={{ color: "var(--ink-muted)", flexShrink: 0 }}>·</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div style={{ background: "var(--brand-tint)", borderRadius: "var(--r)", padding: "var(--s4)" }}>
                  <div className="micro" style={{ marginBottom: "var(--s1)", color: "var(--brand)" }}>Suggested fix</div>
                  <p className="small" style={{ margin: 0, lineHeight: 1.6, color: "var(--ink)" }}>{diagnosis.diagnosis.fixStrategy}</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap", paddingTop: "var(--s2)", borderTop: "1px solid var(--line)" }}>
                  <span className={`badge ${diagnosis.diagnosis.retryWorthwhile ? "badge-done" : "badge-neutral"}`}>
                    {diagnosis.diagnosis.retryWorthwhile ? "Retry worthwhile" : "Retry unlikely to help"}
                  </span>
                  <span className="small muted" style={{ flex: 1, minWidth: "20ch" }}>{diagnosis.diagnosis.retryNote}</span>
                  {diagnosis.diagnosis.retryWorthwhile && (
                    <button className="btn btn-primary btn-sm" disabled={retrying} onClick={handleRetryWithFix}>
                      {retrying ? "Rebuilding & running…" : "Retry with fix →"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* The plain-English explanation auto-generates and lives in the Explain tab —
          it no longer renders as a second banner here, so the proof seal above is the
          page's single, undisputed top anchor (council: collapse the redundant strip). */}

      {/* ── tamper-proof seal — the #1 wedge: the LOUDEST element on the page.
             Auto-verified on load, facts broken into stat-chips, verify animation. ── */}
      {verification?.ok && (
        <div className="run-seal run-seal--anchor">
          <div className="run-seal__head">
            <span className="run-seal__shield" aria-hidden="true">
              <Glyph kind="seal" size={18} color="#fff" />
            </span>
            <div className="run-seal__headtext">
              {/* HONESTY: this seal is about the RECORD's integrity (the signed ledger verifies),
                  NOT the run's outcome — a halted or failed run still has a fully verifiable
                  record. HMAC (default) is tamper-EVIDENT but repudiable; only Ed25519 is
                  non-repudiable. */}
              <span className="run-seal__title">{verification.nonRepudiable ? "Ledger verified · tamper-proof" : "Ledger verified · tamper-evident"}</span>
              <span className="run-seal__sub">{verification.nonRepudiable ? "Ed25519 — anyone can verify this record offline from the public key" : "HMAC-SHA256 — this record is verifiable on this instance"}</span>
            </div>
            <span className="run-seal__verified" aria-live="polite"><Glyph kind="check" size={13} color="currentColor" /> Verified</span>
          </div>
          <div className="run-seal__chips">
            <span className="run-seal__chip"><span className="mono">{verification.signedEvents}/{verification.runEvents}</span> events signed</span>
            <span className="run-seal__chip"><span className="mono">{verification.ledgerEvents}-link</span> hash chain intact</span>
            <span className="run-seal__chip mono">{verification.algorithm}</span>
          </div>
          <div className="run-seal__actions">
            <a
              href={`/proxy/api/runs/${id}/export`}
              download
              className="run-seal__cta run-seal__cta--primary"
              title={verification.nonRepudiable
                ? "Download a signed record anyone can verify offline with `npx krelvan verify`"
                : "Download the signed record (HMAC is verifiable on this instance)"}
            >
              Download signed record ↓
            </a>
            <a href="#tab-timeline" onClick={() => setTab("timeline")} className="run-seal__cta">View the chain →</a>
          </div>
        </div>
      )}
      {verification && !verification.ok && (
        <div className="run-seal run-seal--fail">
          <Glyph kind="cross" size={15} color="var(--danger)" />
          <span className="run-seal__title" style={{ color: "var(--danger)" }}>Verification failed</span>
          <span className="run-seal__detail">{verification.error} — {verification.detail}</span>
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
            {t === "canvas" ? "Graph" : t === "explain" ? "Explain" : t === "output" ? "Output" : t === "timeline" ? "Ledger" : t.charAt(0).toUpperCase() + t.slice(1)}
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
          <Link
            href={`/canvas/${run.agentId}?run=${id}`}
            className="replay-cta"
            style={{ gridColumn: "1 / -1" }}
          >
            <span className="replay-cta__play" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2.2v7.6a.5.5 0 0 0 .77.42l5.7-3.8a.5.5 0 0 0 0-.84l-5.7-3.8A.5.5 0 0 0 3 2.2z" /></svg>
            </span>
            <span className="replay-cta__body">
              <strong>Watch the full replay</strong>
              <span className="small dim">Step through every event on the live canvas — scrub the ledger node by node, see exactly what ran.</span>
            </span>
            <span className="replay-cta__arrow" aria-hidden="true">↗</span>
          </Link>
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
          {events.length === 0 && (
            <div className="state-empty" style={{ border: "none" }}>
              <div style={{ color: "var(--ink-muted)" }}><Glyph kind="ledger" size={28} /></div>
              <p className="h3" style={{ color: "var(--ink)" }}>No events recorded yet</p>
              <p className="small soft" style={{ maxWidth: "42ch", lineHeight: 1.6 }}>
                Once this run starts, every step the agent takes is signed and appended here in order.
              </p>
            </div>
          )}
          {events.length > 0 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap",
              gap: "var(--s3)", padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line)",
              background: verification?.ok ? "color-mix(in srgb, var(--ok) 8%, var(--surface))" : "var(--surface-sunken)",
            }}>
              <div className="small" style={{ color: "var(--ink-soft)", lineHeight: 1.5 }}>
                Every step is appended to a signed, hash-chained ledger.{" "}
                {verification == null && <span className="soft">Click verify to re-check the cryptographic chain.</span>}
                {verification?.ok && (
                  <span style={{ color: "var(--ok)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Glyph kind="check" size={14} color="var(--ok)" /> Verified — {verification.signedEvents}/{verification.runEvents} agent events signed, {verification.ledgerEvents}-link hash chain intact end-to-end ({verification.algorithm}).
                  </span>
                )}
                {verification && !verification.ok && (
                  <span style={{ color: "var(--danger)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Glyph kind="cross" size={14} color="var(--danger)" /> Verification FAILED: {verification.error} — {verification.detail}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", flexShrink: 0 }}>
                <a
                  href={`/proxy/api/runs/${id}/export`}
                  download
                  className="btn btn-sm btn-secondary"
                  style={{ textDecoration: "none" }}
                  title="Download a portable proof bundle — verify it offline with `npx krelvan verify <file>`, no Krelvan install or trust required"
                >
                  Download proof ↓
                </a>
                <button className="btn btn-sm" disabled={verifying} onClick={runVerify}>
                  {verifying ? "Verifying…" : verification ? "Re-verify" : "Verify signatures"}
                </button>
              </div>
            </div>
          )}
          {/* horizontal-scroll wrapper so the 4-col ledger never clips on narrow/mobile widths */}
          {events.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 520 }}>
            <div style={{
              display: "grid", gridTemplateColumns: "40px 170px 1fr 110px",
              gap: "var(--s3)", padding: "var(--s2) var(--s4)",
              background: "var(--surface-sunken)", borderBottom: "1px solid var(--line)",
            }}>
              <span className="micro" style={{ textAlign: "right" }}>#</span>
              <span className="micro">event</span>
              <span className="micro">detail</span>
              <span className="micro" style={{ textAlign: "right" }}>signature</span>
            </div>
            {events.map((e, i) => (
            <div key={e.id} style={{
              display: "grid", gridTemplateColumns: "40px 170px 1fr 110px",
              gap: "var(--s3)", padding: "var(--s3) var(--s4)",
              borderTop: "1px solid var(--line)",
              fontSize: 12, alignItems: "center",
              background: i % 2 === 0 ? "transparent" : "var(--surface-hover)",
            }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", textAlign: "right" }}>#{e.offset}</span>
              <span style={{ fontWeight: 600, color: eventColor(e.type), fontSize: 11 }}>{e.type}</span>
              <span style={{ color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.nodeId && <><span style={{ color: "var(--brand)", fontWeight: 500 }}>{e.nodeId}</span> · </>}
                {eventDetail(e)}
              </span>
              {e.sig
                ? <span className="mono" title={`signed by ${e.sig.keyId} (epoch ${e.sig.epoch}) — fingerprint ${e.sig.fingerprint}`}
                    style={{ textAlign: "right", fontSize: 10.5, color: "var(--ok)", display: "inline-flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                    <Glyph kind="seal" size={11} color="var(--ok)" /> {e.sig.fingerprint.slice(0, 8)}
                  </span>
                : <span className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--ink-muted)" }}>{e.author.slice(0, 8)}</span>}
            </div>
            ))}
            </div>
          </div>
          )}
        </div>
      )}

      {/* state */}
      {tab === "state" && (
        <div role="tabpanel" id="panel-state" aria-labelledby="tab-state">
          {Object.keys(projection.state).length === 0
            ? (
              <div className="state-empty">
                <div style={{ color: "var(--ink-muted)" }}><Glyph kind="state" size={28} /></div>
                <p className="h3" style={{ color: "var(--ink)" }}>No state values yet</p>
                <p className="small soft" style={{ maxWidth: "42ch", lineHeight: 1.6 }}>
                  As nodes run, the values they read and write appear here — the working memory of the run.
                </p>
              </div>
            )
            : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "var(--s3)" }}>
                {Object.entries(projection.state)
                  .filter(([k]) => !k.startsWith("_"))
                  .map(([k, v]) => (
                    <div key={k} className="card" style={{ padding: "var(--s4)" }}>
                      <div className="mono" style={{ fontSize: 11, color: "var(--brand)", marginBottom: "var(--s1)", wordBreak: "break-all" }}>{k}</div>
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

  // Dedupe primary outputs by VALUE — a node often writes the same string to both .text and
  // .result (e.g. a summarizer), which would otherwise render the same answer two/three times.
  const seenValues = new Set<string>();
  const dedupedOutputs: OutputBlock[] = [];
  for (const o of outputs) {
    const norm = o.value.trim();
    if (seenValues.has(norm)) continue;
    seenValues.add(norm);
    dedupedOutputs.push(o);
  }
  outputs.length = 0;
  outputs.push(...dedupedOutputs);

  // Scalar summary: all non-internal non-long keys grouped by node
  const scalarsByNode: Record<string, { key: string; value: string }[]> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("_")) continue;
    const val = String(v);
    if (val.length > 300) continue; // long text already shown above
    if (seenValues.has(val.trim())) continue; // already shown as a primary output above
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
      <div className="state-empty" style={{ borderColor: "var(--live)", background: "var(--live-tint)" }}>
        <span className="spinner live" aria-hidden="true" />
        <p className="h3" style={{ color: "var(--live)" }}>Agent is working…</p>
        <p className="small soft" style={{ maxWidth: "42ch", lineHeight: 1.6 }}>
          The result will appear here the moment it finishes. Watch it think live on the <strong>Graph</strong> tab,
          or follow each step on the <strong>Ledger</strong>.
        </p>
      </div>
    );
  }

  if (isFailed) {
    // A missing-secret failure is actionable: point the customer straight to Secrets.
    const missingSecret = (run.reason ?? "").match(/secret '([^']+)' is not registered/)?.[1];
    if (missingSecret) {
      return (
        <div className="card ledger-artifact" style={{ padding: "var(--s5)", borderColor: "var(--brand-ring)", background: "var(--brand-tint)" }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--brand)", marginBottom: "var(--s2)" }}>
            Needs a secret to continue
          </p>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: "var(--s4)" }}>
            This run uses a capability that needs your <code className="mono">{missingSecret}</code> — for example
            a deploy hook or API key for your own account. Add it once and re-run.
          </p>
          <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center" }}>
            <Link href={`/secrets`} className="btn btn-sm btn-primary">Add {missingSecret} →</Link>
            <span className="small muted">Stored encrypted on your instance.</span>
          </div>
        </div>
      );
    }
    return (
      <div className="card" style={{ padding: "var(--s5)", borderColor: "var(--danger-ring)", background: "var(--danger-tint)" }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)", marginBottom: "var(--s2)" }}>Run failed</p>
        <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>{run.reason ?? "No error details available."}</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>

      {/* Primary outputs */}
      {outputs.length === 0 && (
        <div className="state-empty">
          <div style={{ color: "var(--ink-muted)" }}><Glyph kind="output" size={28} /></div>
          <p className="h3" style={{ color: "var(--ink)" }}>No text output produced</p>
          <p className="small soft" style={{ maxWidth: "44ch", lineHeight: 1.6 }}>
            This run didn&apos;t compose a human-readable result. Open the <strong>State</strong> tab to see the
            raw values it produced, or the <strong>Ledger</strong> for every recorded step.
          </p>
        </div>
      )}

      {outputs.map((o, idx) => (
        <OutputBlockCard
          key={o.key}
          block={o}
          showCopy={idx === 0 && outputs.length > 0}
          copied={copied}
          onCopy={copyAll}
        />
      ))}

      {/* Scalar decisions summary */}
      {Object.keys(scalarsByNode).length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line)", background: "var(--surface-sunken)" }}>
            <span className="micro">Decisions &amp; values</span>
          </div>
          <div style={{ padding: "var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
            {nodeOrder.filter(nid => scalarsByNode[nid]?.length).map(nodeId => (
              <div key={nodeId}>
                <div className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", marginBottom: "var(--s2)" }}>{nodeId}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
                  {scalarsByNode[nodeId].map(({ key, value }) => (
                    <div key={key} style={{
                      display: "flex", gap: "var(--s2)", alignItems: "baseline",
                      background: "var(--surface-sunken)", borderRadius: "var(--r-sm)", padding: "var(--s1) var(--s3)",
                      border: "1px solid var(--line)",
                    }}>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>{key}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{value}</span>
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

// ── Output block card ─────────────────────────────────────────────────────────
// Composed/result text shows expanded (it's the answer). Raw "Fetched data"
// (an http_get body) is intermediate — collapsed by default, pretty-printed and
// truncated on expand — so the human-readable result stays the headline.
function OutputBlockCard({ block, showCopy, copied, onCopy }: {
  block: { label: string; nodeId: string; key: string; value: string; kind: "text" | "data" };
  showCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const isData = block.kind === "data";
  const [open, setOpen] = useState(!isData);

  // Pretty-print JSON bodies; cap at a sane length so a big payload can't flood the page.
  const MAX = 4000;
  let display = block.value;
  if (isData) {
    try { display = JSON.stringify(JSON.parse(block.value), null, 2); } catch { /* not JSON — leave as-is */ }
  }
  const truncated = display.length > MAX;
  if (truncated) display = display.slice(0, MAX) + `\n… (${block.value.length.toLocaleString()} chars total — see the Ledger for the full record)`;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "var(--s3) var(--s4)",
          borderBottom: open ? "1px solid var(--line)" : "none",
          background: "var(--surface-sunken)",
          cursor: isData ? "pointer" : "default",
        }}
        onClick={isData ? () => setOpen(o => !o) : undefined}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          {isData && (
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", width: 10, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
          )}
          <span className="micro" style={{ color: "var(--brand)", letterSpacing: ".06em" }}>{block.label}</span>
          <span className="mono badge badge-neutral" style={{ fontSize: 11 }}>{block.nodeId}</span>
          {isData && !open && <span className="small muted">click to inspect the raw fetched payload</span>}
        </div>
        {showCopy && (
          <button onClick={(e) => { e.stopPropagation(); onCopy(); }} className="btn btn-secondary btn-sm">
            {copied ? "Copied!" : "Copy all"}
          </button>
        )}
      </div>
      {open && (
        <div style={{
          padding: "var(--s5)",
          fontSize: isData ? 12 : 14,
          fontFamily: isData ? "var(--font-mono, monospace)" : undefined,
          color: "var(--ink)", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: isData ? 360 : undefined, overflow: isData ? "auto" : undefined,
        }}>
          {display}
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
              <span className="mono micro" style={{ color: "var(--ink-muted)" }}>
                {timeAgo(explanation.generatedAt)}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={loading}
                onClick={() => void onGenerate()}
              >
                {loading ? "Generating…" : "Regenerate"}
              </button>
            </div>
          </div>
          {!isTerminal && (
            <div style={{ fontSize: 12, color: "var(--info)", marginBottom: "var(--s4)", fontWeight: 500, padding: "var(--s2) var(--s3)", background: "var(--info-tint)", borderRadius: "var(--r)" }}>
              Run is still {status} — regenerate once it finishes for a complete picture.
            </div>
          )}
          <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {cleanExplanation(explanation.explanation)}
          </div>
        </div>
      ) : (
        <div className="state-empty">
          <div style={{ color: "var(--brand)" }}><Glyph kind="spark" size={28} color="var(--brand)" /></div>
          <p className="h3" style={{ color: "var(--ink)" }}>
            Understand this run in plain English
          </p>
          <p className="small soft" style={{ maxWidth: "44ch", margin: "0 auto", lineHeight: 1.6 }}>
            Krelvan reads every event in this run and explains what each node did, and why it succeeded or failed.
          </p>
          {!isTerminal && (
            <p style={{ fontSize: 12, color: "var(--info)", fontWeight: 500 }}>
              Run is still {status} — you can explain it now or wait until it finishes.
            </p>
          )}
          <button
            className="btn btn-primary btn-lg"
            disabled={loading}
            onClick={() => void onGenerate()}
            style={{ marginTop: "var(--s2)" }}
          >
            {loading ? "Generating…" : "Generate explanation"}
          </button>
          {error && (
            <div className="state-error" style={{ marginTop: "var(--s4)", textAlign: "left" }}>
              {error}
            </div>
          )}
        </div>
      )}

      {explanation && error && (
        <div className="state-error" style={{ marginTop: "var(--s3)" }}>
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
        background: "var(--graph-bg)",
        overflow: "auto",
        position: "relative",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: 220,
        padding: "var(--s5)",
      }}
    >
      {/* verified badge */}
      <div
        className="badge badge-done mono"
        style={{ position: "absolute", top: "var(--s3)", right: "var(--s3)", zIndex: 10, cursor: "help" }}
        title="Append-only ledger — each event is SHA-256 content-addressed, hash-chained, and signed; tampering is detectable on verify."
      >
        <span className="dot" />
        <span className="mono">{events.length}</span> events · signed
      </div>

      <svg
        width={w + PAD * 2}
        height={h + PAD * 2}
        style={{ display: "block", minHeight: 180 }}
        role="img"
        aria-label={`Run execution graph with ${manifest.nodes.length} nodes`}
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

          {/* animated dash for active edges — all CSS-class driven so the
              global prefers-reduced-motion guard in globals.css applies */}
          <style>{`
            .edge-active-dash {
              stroke-dasharray: 8 6;
              stroke-dashoffset: 0;
              animation: svg-dash-flow 0.7s linear infinite;
            }
            @keyframes svg-dash-flow {
              to { stroke-dashoffset: -28; }
            }
            .graph-node-glow {
              animation: pulse 1.4s ease-in-out infinite;
              transform-box: fill-box;
              transform-origin: center;
            }
            .graph-node-dot {
              animation: pulse 1.4s ease-in-out infinite;
              transform-box: fill-box;
              transform-origin: center;
            }
            .graph-travel-dot {
              animation: dot-travel 1.2s linear infinite;
              offset-rotate: 0deg;
            }
            @media (prefers-reduced-motion: reduce) {
              .edge-active-dash, .graph-node-glow, .graph-node-dot, .graph-travel-dot { animation: none !important; }
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
  const r = 8;

  const bg = status === "running" ? "var(--live-tint)" : status === "done" ? "var(--ok-tint)" : "var(--surface)";
  const borderColor = status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : isSelected ? "var(--brand)" : "var(--line)";
  const borderWidth = status !== "idle" || isSelected ? 2 : 1;

  const capName = node.capabilities.length > 0 ? node.capabilities[0]!.name : null;

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
          rx={r + 4}
          fill="none"
          stroke="var(--brand)"
          strokeWidth={2}
          opacity={0.35}
        />
      )}

      {/* running glow — CSS-class animation respects prefers-reduced-motion */}
      {status === "running" && (
        <rect
          className="graph-node-glow"
          x={x - 4} y={y - 4}
          width={w + 8} height={h + 8}
          rx={r + 4}
          fill="none"
          stroke="var(--live)"
          strokeWidth={3}
          opacity={0.25}
        />
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

      {/* capability glyph (teal geometric SVG — no emoji) + name */}
      <g transform={`translate(${x + 12}, ${y + 14})`}>
        {capName ? capGlyphPaths(capName) : (
          <circle cx="8" cy="8" r="3" stroke="var(--ink-muted)" strokeWidth="1.2" fill="none" />
        )}
      </g>
      <text
        x={x + 36} y={y + 21}
        fontSize={12} fontWeight={600}
        fill={status === "running" ? "var(--live)" : status === "done" ? "var(--ok)" : "var(--ink)"}
        dominantBaseline="middle"
      >
        {node.id.length > 18 ? node.id.slice(0, 16) + "…" : node.id}
      </text>

      {/* role */}
      <text x={x + 36} y={y + 38} fontSize={11} fill="var(--ink-muted)" dominantBaseline="middle">
        {node.role.length > 22 ? node.role.slice(0, 20) + "…" : node.role}
      </text>

      {/* status + cost row */}
      <g>
        {status === "running" && (
          <>
            <circle className="graph-node-dot" cx={x + 12} cy={y + 56} r={3} fill="var(--live)" />
            <text x={x + 20} y={y + 56} fontSize={11} fill="var(--live)" fontWeight={600} dominantBaseline="middle">
              running
            </text>
          </>
        )}
        {status === "done" && (
          <>
            <path
              d={`M${x + 8} ${y + 56}l2.2 2.2 3.6-4.4`}
              stroke="var(--ok)" strokeWidth={1.6} fill="none"
              strokeLinecap="round" strokeLinejoin="round" aria-label="done"
            />
            <text x={x + 18} y={y + 56} fontSize={11} fill="var(--ok)" fontWeight={600} dominantBaseline="middle">
              done{visits > 1 ? ` ×${visits}` : ""}
            </text>
          </>
        )}
        {status === "idle" && (
          <text x={x + 10} y={y + 56} fontSize={11} fill="var(--ink-muted)" dominantBaseline="middle">
            waiting
          </text>
        )}
      </g>
    </g>
  );
}

// ── Traveling dot along an SVG path ──────────────────────────────────────────

function TravelingDotSvg({ path }: { path: string }) {
  // CSS offset-path so the global prefers-reduced-motion guard applies
  // (inline SMIL <animateMotion> would bypass it).
  return (
    <circle
      className="graph-travel-dot"
      r={5}
      cx={0}
      cy={0}
      fill="var(--live)"
      style={{
        offsetPath: `path('${path}')`,
        filter: "drop-shadow(0 0 4px var(--live))",
      }}
    />
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

  // Which capabilities this node used (names only — no cost is ever shown).
  const nodeCaps = Object.keys(projection.budget.perCapSpentCents)
    .filter((k) => k.startsWith(`${nodeId}:`))
    .map((k) => ({ cap: k.slice(nodeId.length + 1) }));

  return (
    <div className="card" style={{ padding: "var(--s5)", position: "sticky", top: 72 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <div>
          <div className="h3">{nodeId}</div>
          <div style={{ marginTop: "var(--s1)" }}>
            <span className={`badge ${STATUS_BADGE_CLASS[status] ?? "badge-neutral"}`}>
              {status === "running" && <span className="dot" />}
              {status}{ns?.visits ? ` · ${ns.visits} visit${ns.visits > 1 ? "s" : ""}` : ""}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="btn btn-ghost btn-sm"
          style={{ padding: "0 var(--s2)" }}
        >
          ×
        </button>
      </div>

      {/* outputs */}
      {nodeState.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Outputs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            {nodeState.map(({ key, value }) => (
              <div key={key} style={{ background: "var(--surface-sunken)", padding: "var(--s2) var(--s3)", borderRadius: "var(--r)" }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--brand)", marginBottom: "var(--s1)" }}>{key}</div>
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
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Reasoning</div>
          <ReasoningBlock text={thoughtText} />
        </div>
      )}

      {/* capabilities used by this node */}
      {nodeCaps.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Capabilities used</div>
          {nodeCaps.map(({ cap }) => (
            <div key={cap} style={{ display: "flex", alignItems: "center", gap: "var(--s2)", fontSize: 12, padding: "var(--s1) 0" }}>
              <span className="status-dot done" aria-hidden="true" style={{ width: 6, height: 6 }} />
              <span className="mono" style={{ color: "var(--ink-soft)" }}>{cap}</span>
            </div>
          ))}
        </div>
      )}

      {/* events for this node */}
      {nodeEvents.length > 0 && (
        <div>
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>
            Events ({nodeEvents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)" }}>
            {nodeEvents.map(e => (
              <div key={e.id} style={{ display: "flex", gap: "var(--s2)", alignItems: "baseline" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", minWidth: 24 }}>#{e.offset}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: eventColor(e.type) }}>{e.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {nodeState.length === 0 && nodeCaps.length === 0 && nodeEvents.length === 0 && (
        <p className="small muted">Node has not run yet.</p>
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
          className="btn btn-ghost btn-sm"
          style={{ marginTop: "var(--s2)", height: "auto", padding: "var(--s1) var(--s2)" }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── Capability glyphs (teal geometric SVG — no emoji; matches _builder.tsx
// CapGlyph + the homepage glyph language). Authored on a 16×16 grid, drawn via a
// translate at the call site. Stroke uses --brand; neutral square for unknowns. ─
function capGlyphPaths(name: string): React.ReactNode {
  switch (name) {
    case "think":
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <circle cx="8" cy="8" r="1.7" fill="var(--brand)" />
        </>
      );
    case "recall":
      return (
        <>
          <path d="M2.5 3.2h4.2c.7 0 1.3.6 1.3 1.3v8.3c0-.7-.6-1.3-1.3-1.3H2.5V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M13.5 3.2H9.3c-.7 0-1.3.6-1.3 1.3v8.3c0-.7.6-1.3 1.3-1.3h4.2V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "remember":
      return (
        <>
          <path d="M3 3h7.5L13 5.5V13H3V3z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <rect x="5.5" y="3" width="5" height="3" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
          <rect x="5" y="8.5" width="6" height="3.5" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "llm_route":
      return (
        <>
          <path d="M3 8h3.5M9.5 4.5L12.5 4.5M9.5 11.5L12.5 11.5M6.5 8c1.2 0 1.6-3.5 3-3.5M6.5 8c1.2 0 1.6 3.5 3 3.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M11 3l1.8 1.5L11 6M11 10l1.8 1.5L11 13" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "web_search":
      return (
        <>
          <circle cx="7" cy="7" r="4" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <path d="M10 10l3.2 3.2" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "compose":
      return (
        <>
          <path d="M3 13l1-3 6.5-6.5 2 2L6 12l-3 1z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M10 4.5l1.5-1.5 2 2L12 6.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "http_get":
    case "http_post":
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M2.8 8h10.4M8 2.8c1.6 1.4 2.4 3.3 2.4 5.2S9.6 12.8 8 13.2C6.4 12.8 5.6 10.9 5.6 8S6.4 4.2 8 2.8z" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "telegram_send":
    case "email_send":
      return (
        <>
          <rect x="2.5" y="4" width="11" height="8" rx="1" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M3 4.8l5 4 5-4" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "slack_send":
      return (
        <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3v-6z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      );
    case "notify_webhook":
      return (
        <>
          <path d="M8 2.6c2 0 3.3 1.5 3.3 3.4v2.4l1.2 1.8H3.5l1.2-1.8V6c0-1.9 1.3-3.4 3.3-3.4z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M6.6 12.2c.2.8.8 1.2 1.4 1.2s1.2-.4 1.4-1.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    default:
      return (
        <>
          <rect x="3.5" y="3.5" width="9" height="9" rx="2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="1.6" fill="var(--brand)" />
        </>
      );
  }
}

// ── Inline glyphs for empty/labels (currentColor, 14×14 viewBox) ───────────────
function Glyph({ kind, size = 28, color }: { kind: "spark" | "ledger" | "state" | "output" | "search" | "warn" | "check" | "cross" | "pause" | "play" | "seal"; size?: number; color?: string }) {
  const stroke = color ?? "currentColor";
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true as const };
  switch (kind) {
    case "seal":
      // a signed-seal / lock mark for ledger signatures (replaces the lock emoji)
      return (
        <svg {...common}>
          <path d="M12 2.5l7.5 2.7v5.1c0 4.8-3.2 8.1-7.5 9.2-4.3-1.1-7.5-4.4-7.5-9.2V5.2L12 2.5z" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 12l2 2 4-4.5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" opacity={0.9} />
          <circle cx="12" cy="12" r="2.4" fill={stroke} />
        </svg>
      );
    case "ledger":
      return (
        <svg {...common}>
          <rect x="4" y="3.5" width="16" height="17" rx="2" stroke={stroke} strokeWidth="1.5" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "state":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke={stroke} strokeWidth="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke={stroke} strokeWidth="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke={stroke} strokeWidth="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke={stroke} strokeWidth="1.5" />
        </svg>
      );
    case "output":
      return (
        <svg {...common}>
          <path d="M4 11l4-7 6.5-1L20 8l-1 6.5L12 21l-7-4-1-6z" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 12l2 2 4-5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6" stroke={stroke} strokeWidth="1.6" />
          <path d="M15 15l4.5 4.5" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "warn":
      return (
        <svg {...common}>
          <path d="M12 3.5l9 16H3l9-16z" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 9.5v4.5M12 17h.01" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cross":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <rect x="6" y="5" width="4" height="14" rx="1" fill={stroke} />
          <rect x="14" y="5" width="4" height="14" rx="1" fill={stroke} />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M7 5l12 7-12 7V5z" fill={stroke} />
        </svg>
      );
  }
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
  // Static log-entry colors only — amber (--live) is reserved for live/animating
  // UI, never a static descriptor, so node/await entries use brand/info/paused.
  if (type === "RunCompleted") return "var(--ok)";
  if (type === "RunFailed")    return "var(--danger)";
  if (type === "EffectResult") return "var(--brand)";
  if (type.startsWith("Node")) return "var(--brand)";
  if (type === "AdmissionDecision") return "var(--ink-soft)";
  if (type === "AwaitRequested") return "var(--paused)";
  if (type === "AwaitResolved")  return "var(--ok)";
  return "var(--ink-muted)";
}

function eventDetail(e: LedgerEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "RunStarted": return `manifest: ${String(p["manifest"] ?? "")}`;
    case "AdmissionDecision": return p["admitted"]
      ? `admitted`
      : `DENIED: ${String(p["reason"] ?? "")}`;
    case "EffectRequested": return String(p["capability"] ?? "");
    case "EffectResult": return `${JSON.stringify(p["output"]).slice(0, 70)}`;
    case "NodeConcluded": return p["state"] ? JSON.stringify(p["state"]).slice(0, 60) : "concluded";
    case "SubRunRequested": return `sub-run: ${String(p["subRunId"] ?? "").slice(0, 16)}`;
    case "SubRunCompleted": return `completed`;
    case "SubRunFailed":    return `FAILED: ${String(p["reason"] ?? "")}`;
    case "AwaitRequested": {
      const cap = String((p["call"] as Record<string,unknown>)?.["capability"] ?? "");
      return `Waiting for approval to run ${cap}`;
    }
    case "AwaitResolved": {
      const decision = String(p["decision"] ?? "");
      return decision === "approve" ? "Approved — run resumed" : "Denied — run stopped";
    }
    default: return "";
  }
}
