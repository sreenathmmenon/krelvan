"use client";

import { useState, useEffect, useCallback } from "react";
import { listApprovals, resolveApproval, timeAgo, type PendingApproval } from "../../lib/api";

const CAP_ICON: Record<string, string> = {
  think: "🧠", recall: "📚", remember: "💾", llm_route: "🔀",
  web_search: "🔍", compose: "✍️", telegram_send: "📨", email_send: "📧",
  slack_send: "💬", http_post: "📤", http_get: "🌐", text_transform: "🔤",
  notify_webhook: "🔔",
};

const CAP_RISK: Record<string, { level: "low" | "medium" | "high"; label: string }> = {
  think:          { level: "low",    label: "Read only — LLM reasoning" },
  recall:         { level: "low",    label: "Read only — memory lookup" },
  remember:       { level: "low",    label: "Writes to local memory file" },
  llm_route:      { level: "low",    label: "Read only — routing decision" },
  web_search:     { level: "low",    label: "Read only — search query" },
  compose:        { level: "low",    label: "Read only — text generation" },
  telegram_send:  { level: "medium", label: "Sends a message to Telegram" },
  email_send:     { level: "medium", label: "Sends an email" },
  slack_send:     { level: "medium", label: "Posts to Slack" },
  http_post:      { level: "medium", label: "External HTTP write" },
  notify_webhook: { level: "medium", label: "Sends webhook notification" },
  http_get:       { level: "low",    label: "External HTTP read" },
};

function RiskBadge({ capability }: { capability: string }) {
  const risk = CAP_RISK[capability] ?? { level: "medium", label: "External action" };
  const colors = {
    low:    { bg: "var(--ok-tint)",      fg: "var(--ok)" },
    medium: { bg: "var(--live-tint)",    fg: "var(--live)" },
    high:   { bg: "var(--danger-tint)",  fg: "var(--danger)" },
  }[risk.level];
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: "var(--r-pill)", fontWeight: 600, background: colors.bg, color: colors.fg }}>
      {risk.level.toUpperCase()} RISK
    </span>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (correlationId: string, runId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  const [resolving, setResolving] = useState<"approve" | "deny" | null>(null);
  const icon = CAP_ICON[approval.capability] ?? "⚙️";
  const risk = CAP_RISK[approval.capability] ?? { level: "medium", label: "External action" };
  const isHigh = risk.level === "high";

  async function handle(decision: "approve" | "deny") {
    setResolving(decision);
    try {
      await onResolve(approval.correlationId, approval.runId, decision);
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="card" style={{
      padding: "var(--s5)",
      borderLeft: `3px solid ${isHigh ? "var(--danger)" : "var(--live)"}`,
      animation: "fade-in 200ms ease forwards",
    }}>
      {/* header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s4)", gap: "var(--s4)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--s3)", minWidth: 0 }}>
          <span style={{ fontSize: 28, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s1)" }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{approval.capability}</span>
              <RiskBadge capability={approval.capability} />
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              <span style={{ fontWeight: 500, color: "var(--brand)" }}>{approval.agentName}</span>
              <span style={{ color: "var(--ink-muted)" }}> › </span>
              <span>node: <strong>{approval.nodeId}</strong></span>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>{risk.label}</div>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div className="small muted">{timeAgo(approval.requestedAt)}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{approval.runId.slice(0, 24)}</div>
        </div>
      </div>

      {/* correlation ID row */}
      <div style={{ background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s2) var(--s3)", marginBottom: "var(--s4)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="micro">Correlation ID</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-soft)" }}>{approval.correlationId}</span>
      </div>

      {/* action buttons */}
      <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end" }}>
        <a href={`/runs/${approval.runId}`} className="btn btn-secondary btn-sm" style={{ fontSize: 12 }}>
          View run →
        </a>
        <button
          className="btn btn-sm"
          style={{ background: "var(--danger-tint)", color: "var(--danger)", border: "none", fontWeight: 600, opacity: resolving ? .6 : 1 }}
          disabled={resolving !== null}
          onClick={() => void handle("deny")}
        >
          {resolving === "deny" ? "Denying…" : "✗ Deny"}
        </button>
        <button
          className="btn btn-primary btn-sm"
          style={{ fontWeight: 600, opacity: resolving ? .6 : 1 }}
          disabled={resolving !== null}
          onClick={() => void handle("approve")}
        >
          {resolving === "approve" ? "Approving…" : "✓ Approve"}
        </button>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await listApprovals();
      setApprovals(a);
    } catch { /* API unreachable */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleResolve(correlationId: string, runId: string, decision: "approve" | "deny") {
    try {
      await resolveApproval(correlationId, runId, decision);
      setResolvedIds(s => new Set([...s, correlationId]));
      setToast({ msg: decision === "approve" ? "Approved — run resuming" : "Denied — run stopped", ok: decision === "approve" });
      await load();
    } catch (err) {
      setToast({ msg: (err as Error).message, ok: false });
    }
  }

  const visible = approvals.filter(a => !resolvedIds.has(a.correlationId));

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* toast */}
      {toast && (
        <div style={{
          position: "fixed", top: "var(--s6)", right: "var(--s6)", zIndex: 2000,
          padding: "var(--s3) var(--s5)", borderRadius: "var(--r)",
          background: toast.ok ? "var(--ok)" : "var(--danger)", color: "white",
          fontSize: 13, fontWeight: 600, boxShadow: "var(--shadow-md)",
          animation: "fade-in 150ms ease forwards",
        }}>
          {toast.msg}
        </div>
      )}

      {/* header */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", padding: "var(--s6) 0" }}>
        <div className="container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", marginBottom: "var(--s1)" }}>
                Approvals
                {visible.length > 0 && (
                  <span style={{ marginLeft: "var(--s3)", fontSize: 13, fontWeight: 600, padding: "2px 10px", borderRadius: "var(--r-pill)", background: "var(--live-tint)", color: "var(--live)" }}>
                    {visible.length} pending
                  </span>
                )}
              </h1>
              <p className="soft" style={{ fontSize: 14 }}>
                Agents with <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>act-with-veto</code> or <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>suggest</code> autonomy pause here before acting.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* content */}
      <div className="container" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s9)" }}>

        {loading && <p className="soft small">Loading…</p>}

        {!loading && visible.length === 0 && (
          <div style={{
            padding: "var(--s9)", textAlign: "center",
            border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)",
            color: "var(--ink-muted)",
          }}>
            <div style={{ fontSize: 40, marginBottom: "var(--s4)" }}>✓</div>
            <p style={{ fontSize: 15, fontWeight: 600, marginBottom: "var(--s2)", color: "var(--ok)" }}>No pending approvals</p>
            <p className="small muted">
              When an agent reaches a node with <strong>act-with-veto</strong> or <strong>suggest</strong> autonomy,<br />
              it will pause here and wait for your decision before continuing.
            </p>
          </div>
        )}

        {visible.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)", maxWidth: 720 }}>
            {visible.map(a => (
              <ApprovalCard
                key={a.correlationId}
                approval={a}
                onResolve={handleResolve}
              />
            ))}
          </div>
        )}

        {/* Explanation panel */}
        {!loading && (
          <div className="card" style={{ padding: "var(--s5)", marginTop: "var(--s7)", maxWidth: 720, background: "var(--brand-tint)", border: "1px solid rgba(14,124,117,.15)" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: "var(--s3)", color: "var(--brand)" }}>How HITL autonomy works</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
              {[
                { autonomy: "full", desc: "Agent acts immediately — no gate. Use for read-only or low-risk nodes." },
                { autonomy: "act-with-veto", desc: "Agent proposes the action, pauses here. You can approve or deny before it executes." },
                { autonomy: "suggest", desc: "Like act-with-veto but framed as a recommendation. Agent always pauses for human review." },
              ].map(row => (
                <div key={row.autonomy} style={{ display: "flex", gap: "var(--s3)", alignItems: "baseline" }}>
                  <code style={{ fontSize: 11, padding: "2px 7px", background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 4, flexShrink: 0, fontFamily: "var(--font-mono)", color: "var(--brand)" }}>{row.autonomy}</code>
                  <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{row.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
