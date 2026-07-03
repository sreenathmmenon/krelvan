"use client";

import { useState, useEffect, useCallback } from "react";
import { listApprovals, resolveApproval, timeAgo, type PendingApproval } from "../../lib/api";

// ── Teal geometric capability glyphs ────────────────────────────────────────
// Authored on a 16×16 grid, stroked in --brand, matching the homepage / _builder
// CapGlyph house style. No emoji anywhere in the UI — every capability gets a
// calm vector mark with a graceful neutral fallback for unknown ids.
function capGlyphPaths(name: string): React.ReactNode {
  switch (name) {
    case "think": // concentric ring + core — reasoning
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <circle cx="8" cy="8" r="1.7" fill="var(--brand)" />
        </>
      );
    case "recall": // open book
      return (
        <>
          <path d="M2.5 3.2h4.2c.7 0 1.3.6 1.3 1.3v8.3c0-.7-.6-1.3-1.3-1.3H2.5V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M13.5 3.2H9.3c-.7 0-1.3.6-1.3 1.3v8.3c0-.7.6-1.3 1.3-1.3h4.2V3.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "remember": // disk / save
      return (
        <>
          <path d="M3 3h7.5L13 5.5V13H3V3z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <rect x="5.5" y="3" width="5" height="3" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
          <rect x="5" y="8.5" width="6" height="3.5" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "llm_route": // branch / route
      return (
        <>
          <path d="M3 8h3.5M9.5 4.5L12.5 4.5M9.5 11.5L12.5 11.5M6.5 8c1.2 0 1.6-3.5 3-3.5M6.5 8c1.2 0 1.6 3.5 3 3.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M11 3l1.8 1.5L11 6M11 10l1.8 1.5L11 13" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "web_search": // magnifying glass
      return (
        <>
          <circle cx="7" cy="7" r="4" stroke="var(--brand)" strokeWidth="1.3" fill="none" />
          <path d="M10 10l3.2 3.2" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "compose":
    case "text_transform": // pen / write
      return (
        <>
          <path d="M3 13l1-3 6.5-6.5 2 2L6 12l-3 1z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M10 4.5l1.5-1.5 2 2L12 6.5" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "http_get":
    case "http_post": // globe
      return (
        <>
          <circle cx="8" cy="8" r="5.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M2.8 8h10.4M8 2.8c1.6 1.4 2.4 3.3 2.4 5.2S9.6 12.8 8 13.2C6.4 12.8 5.6 10.9 5.6 8S6.4 4.2 8 2.8z" stroke="var(--brand)" strokeWidth="1.1" fill="none" />
        </>
      );
    case "telegram_send":
    case "email_send": // envelope / send
      return (
        <>
          <rect x="2.5" y="4" width="11" height="8" rx="1" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M3 4.8l5 4 5-4" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "slack_send": // chat bubble
      return (
        <>
          <path d="M3 4.5h10v6H7l-3 2.5v-2.5H3v-6z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        </>
      );
    case "notify_webhook": // bell
      return (
        <>
          <path d="M8 2.6c2 0 3.3 1.5 3.3 3.4v2.4l1.2 1.8H3.5l1.2-1.8V6c0-1.9 1.3-3.4 3.3-3.4z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M6.6 12.2c.2.8.8 1.2 1.4 1.2s1.2-.4 1.4-1.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      );
    default: // unknown capability — neutral rounded square + core
      return (
        <>
          <rect x="3.5" y="3.5" width="9" height="9" rx="2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="1.6" fill="var(--brand)" />
        </>
      );
  }
}

// Boxed capability glyph for an approval card header — a teal-tinted tile that
// reads as a quiet system mark, never decorative.
function CapGlyph({ name }: { name: string }) {
  return (
    <span className="cap-glyph" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="18" height="18" fill="none">
        {capGlyphPaths(name)}
      </svg>
    </span>
  );
}

// Human-readable capability label so the card header reads in plain language
// rather than the raw internal id (telegram_send → "Send a Telegram message").
const CAP_LABEL: Record<string, string> = {
  think: "Reason over context",
  recall: "Recall from memory",
  remember: "Write to memory",
  llm_route: "Route a decision",
  web_search: "Search the web",
  compose: "Compose text",
  telegram_send: "Send a Telegram message",
  email_send: "Send an email",
  slack_send: "Post to Slack",
  http_post: "Send an HTTP request",
  http_get: "Fetch over HTTP",
  text_transform: "Transform text",
  notify_webhook: "Send a webhook",
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

// Risk level → badge variant. Amber (--live) is reserved for live/energy only,
// so a static risk descriptor never uses it: low=done(ok), medium=info, high=failed(danger).
const RISK_BADGE_CLASS: Record<"low" | "medium" | "high", string> = {
  low:    "badge badge-done",
  medium: "badge badge-info",
  high:   "badge badge-failed",
};

// Left accent + accent ink per risk level — gives each card a calm, legible
// severity read at a glance without ever borrowing amber (live-only).
const RISK_ACCENT: Record<"low" | "medium" | "high", string> = {
  low:    "var(--ok)",
  medium: "var(--info)",
  high:   "var(--danger)",
};

function riskFor(capability: string): { level: "low" | "medium" | "high"; label: string } {
  return CAP_RISK[capability] ?? { level: "medium", label: "External action" };
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (correlationId: string, runId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  const [resolving, setResolving] = useState<"approve" | "deny" | null>(null);
  const label = CAP_LABEL[approval.capability] ?? approval.capability;
  const risk = riskFor(approval.capability);
  const accent = RISK_ACCENT[risk.level];

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
      borderLeft: `3px solid ${accent}`,
      animation: "fade-in 200ms var(--ease) forwards",
    }}>
      {/* header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s4)", gap: "var(--s4)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--s3)", minWidth: 0 }}>
          <CapGlyph name={approval.capability} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s1)" }}>
              <span className="h3" style={{ color: "var(--ink)" }}>{label}</span>
              <span className={RISK_BADGE_CLASS[risk.level]}>
                <span className="dot" aria-hidden="true" />
                {risk.level.toUpperCase()} RISK
              </span>
            </div>
            <div className="small soft">
              <span style={{ fontWeight: 500, color: "var(--brand)" }}>{approval.agentName}</span>
              <span style={{ color: "var(--ink-muted)" }}> · </span>
              <span className="mono">{approval.nodeId}</span>
            </div>
            <div className="small" style={{ marginTop: "var(--s1)", color: "var(--ink-soft)" }}>{risk.label}</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--s1)", flexShrink: 0 }}>
          <span className="approval-waiting" title="This run is paused, waiting on your decision">
            <span className="approval-waiting__dot" aria-hidden="true" />
            waiting
          </span>
          <div className="small muted">{timeAgo(approval.requestedAt)}</div>
          <div className="mono micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--ink-muted)" }}>{approval.capability}</div>
        </div>
      </div>

      {/* ── THE PROPOSED ACTION — what you're actually approving (the centerpiece) ── */}
      {approval.preview && approval.preview.length > 0 ? (
        <div className="approval-preview">
          <div className="micro" style={{ color: "var(--ink-muted)", marginBottom: "var(--s3)" }}>The agent wants to do this — review before you approve</div>
          {approval.preview.map((p, i) => (
            <div key={i} className="approval-preview__row">
              <span className="approval-preview__label">{p.label}</span>
              <span className="approval-preview__value">{p.value}</span>
            </div>
          ))}
        </div>
      ) : approval.nodeRole ? (
        <div className="approval-preview">
          <div className="micro" style={{ color: "var(--ink-muted)", marginBottom: "var(--s2)" }}>What this step does</div>
          <p className="small" style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.55 }}>{approval.nodeRole}</p>
        </div>
      ) : null}

      {/* correlation ID row — the stable handle that links this gate to its run */}
      <div style={{ background: "var(--surface-sunken)", borderRadius: "var(--r)", padding: "var(--s2) var(--s3)", marginBottom: "var(--s4)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s3)" }}>
        <span className="micro" style={{ flexShrink: 0 }}>Correlation ID</span>
        <span className="mono small text-truncate" style={{ color: "var(--ink-soft)", minWidth: 0 }}>{approval.correlationId}</span>
      </div>

      {/* action buttons */}
      <div className="approval-actions" style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end", alignItems: "center" }}>
        <a href={`/runs/${approval.runId}`} className="btn btn-ghost btn-sm approval-view" style={{ marginRight: "auto" }}>
          View run →
        </a>
        <button
          className="btn btn-sm btn-ghost approval-resolve"
          title="Stop the run here — nothing is sent"
          disabled={resolving !== null}
          onClick={() => void handle("deny")}
        >
          {resolving === "deny" ? "Denying…" : (
            <>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Deny
            </>
          )}
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={resolving !== null}
          onClick={() => void handle("approve")}
        >
          {resolving === "approve" ? "Approving…" : (
            <>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Approve
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await listApprovals();
      setApprovals(a);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Could not reach the Krelvan API.");
    }
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
  const highCount = visible.filter(a => riskFor(a.capability).level === "high").length;

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* toast */}
      {toast && (
        <div role="status" className={`toast small${toast.ok ? "" : " toast-error"}`}>
          {toast.msg}
        </div>
      )}

      {/* header */}
      <div style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)", padding: "var(--s7) 0" }}>
        <div className="container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s5)", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <p className="micro" style={{ marginBottom: "var(--s3)" }}>Human-in-the-loop</p>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
                <h1 className="h1" style={{ margin: 0 }}>Approvals</h1>
                {visible.length > 0 && (
                  <span className="badge badge-running" title="Runs are paused, waiting on your decision">
                    <span className="dot" aria-hidden="true" />
                    <span className="mono">{visible.length}</span> waiting on you
                  </span>
                )}
                {highCount > 0 && (
                  <span className="badge badge-failed">
                    <span className="dot" aria-hidden="true" />
                    <span className="mono">{highCount}</span> high risk
                  </span>
                )}
              </div>
              <p className="soft body-lg" style={{ margin: 0, maxWidth: "60ch" }}>
                Some agents pause and ask before they act. Review what each one
                wants to do, then approve to let it continue or deny to stop it.
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
              ↻ Refresh
            </button>
          </div>
        </div>
      </div>

      {/* content */}
      <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

        {loading && (
          <div className="state-loading">
            <span className="spinner" aria-hidden="true" />
            <span>Loading approvals…</span>
          </div>
        )}

        {/* error — API unreachable; keep it actionable, never a blank screen */}
        {!loading && error && visible.length === 0 && (
          <div role="alert" className="state-error" style={{ justifyContent: "space-between", maxWidth: 720 }}>
            <span>{error}</span>
            <button className="btn btn-danger btn-sm" onClick={() => void load()} style={{ flexShrink: 0 }}>
              Retry
            </button>
          </div>
        )}

        {/* empty — resolved & settled; trustworthy, never broken-looking */}
        {!loading && !error && visible.length === 0 && (
          <div className="state-empty" style={{ padding: "var(--s9) var(--s6)", maxWidth: 720, margin: "0 auto" }}>
            <div aria-hidden="true" style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 48, height: 48, borderRadius: "var(--r-pill)",
              background: "var(--ok-tint)", color: "var(--ok)",
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="h3" style={{ color: "var(--ink)" }}>All approvals have been resolved</p>
            <p className="body-lg soft" style={{ maxWidth: "44ch", margin: 0 }}>
              Nothing is waiting on you. When an agent reaches a step that needs
              a human go-ahead, it pauses here and waits for your decision before
              continuing.
            </p>
          </div>
        )}

        {/* pending approval cards */}
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

        {/* explanation panel — how the human-in-the-loop gate works */}
        {!loading && (
          <div className="card" style={{ padding: "var(--s5)", marginTop: "var(--s7)", maxWidth: 720, margin: "var(--s7) auto 0", background: "var(--brand-tint)", border: "1px solid var(--brand-ring)" }}>
            <div className="h3" style={{ marginBottom: "var(--s4)", color: "var(--brand)" }}>How an agent decides whether to pause</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              {[
                { autonomy: "suggest", desc: "Pauses for your approval before every side-effect — any write, message, spend, or identity change. Reads still run freely. The safest setting." },
                { autonomy: "act-with-veto", desc: "Pauses only before irreversible writes, spending, and identity changes. Reversible writes and messages (email, Slack, Telegram) proceed without a gate." },
                { autonomy: "full", desc: "Acts on every step with no human gate — including irreversible writes and spend. Use only for agents you fully trust." },
              ].map(row => (
                <div key={row.autonomy} style={{ display: "flex", gap: "var(--s3)", alignItems: "baseline" }}>
                  <code className="mono small" style={{ padding: "var(--s1) var(--s2)", background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "var(--r-sm)", flexShrink: 0, color: "var(--brand)" }}>{row.autonomy}</code>
                  <span className="small soft">{row.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
