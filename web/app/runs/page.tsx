"use client";
import { useState, useEffect, useCallback } from "react";
import { listRuns, timeAgo, type RunRecord } from "../../lib/api";

type Filter = "all" | "running" | "halted" | "completed" | "failed";

function CostCell({ run }: { run: RunRecord }) {
  if (run.status === "running") {
    return (
      <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
        <span className="status-dot running" style={{ width: 6, height: 6 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--live)" }}>live</span>
      </span>
    );
  }
  if (run.status === "failed" && (run.spentCents == null || run.spentCents === 0)) {
    return (
      <span
        className="mono"
        title="Run failed before incurring cost"
        style={{ fontSize: 13, textAlign: "right", color: "var(--ink-muted)", cursor: "help", display: "block" }}
      >
        —
      </span>
    );
  }
  return (
    <span className="mono" style={{ fontSize: 13, textAlign: "right", display: "block" }}>
      {run.spentCents != null ? `${run.spentCents}¢` : "0¢"}
    </span>
  );
}

function RunIdCell({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(runId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title={runId}
      style={{
        display: "block", width: "100%", textAlign: "right",
        background: "none", border: "none", cursor: "pointer", padding: 0,
        fontFamily: "var(--font-mono)", fontSize: 11,
        color: copied ? "var(--ok)" : "var(--ink-muted)",
        transition: "color 150ms",
      }}
    >
      {copied ? "Copied!" : runId.slice(0, 16)}
    </button>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      setRuns(await listRuns());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = filter === "all" ? runs : runs.filter(r => r.status === filter);

  const counts = {
    all: runs.length,
    running: runs.filter(r => r.status === "running").length,
    halted: runs.filter(r => r.status === "halted").length,
    completed: runs.filter(r => r.status === "completed").length,
    failed: runs.filter(r => r.status === "failed").length,
  };

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <div style={{ marginBottom: "var(--s5)" }}>
        <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Runs</h1>
        <p className="soft" style={{ fontSize: 14, margin: 0 }}>
          Every run is a signed, verifiable record of exactly what your agent did.
        </p>
      </div>

      {/* filter pills */}
      <div style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        {(["all", "running", "halted", "completed", "failed"] as Filter[]).map(f => {
          const active = filter === f;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="chip"
              style={{
                background: active ? "var(--brand-tint)" : undefined,
                color: active ? "var(--brand)" : undefined,
                borderColor: active ? "var(--brand)" : undefined,
              }}
            >
              {f}{counts[f] > 0 && f !== "all" ? ` · ${counts[f]}` : f === "all" ? ` · ${counts.all}` : ""}
            </button>
          );
        })}
      </div>

      {loading && <p className="soft small">Loading…</p>}

      {!loading && filtered.length === 0 && (
        <div style={{ padding: "var(--s7)", textAlign: "center", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)", color: "var(--ink-muted)" }}>
          <p style={{ fontSize: 14 }}>
            {runs.length === 0
              ? <>No runs yet. Build an agent on the <a href="/">home page</a> to get started.</>
              : `No ${filter} runs.`}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          {/* header */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 110px 80px 100px 120px 48px",
            gap: "var(--s4)", padding: "var(--s3) var(--s5)",
            background: "var(--surface-sunken)",
          }}>
            {["Workflow", "Status", "Cost ↓", "Run ID", "When", ""].map((h, i) => (
              <span key={i} className="micro" style={{ textAlign: i >= 2 && i <= 4 ? "right" : "left" }}>{h}</span>
            ))}
          </div>

          {filtered.map((r, i) => {
            const badgeCls = r.status === "completed" ? "badge-done"
              : r.status === "running" ? "badge-running"
              : r.status === "failed" ? "badge-failed"
              : r.status === "halted" ? "badge-paused"
              : "badge-neutral";
            return (
              <a
                key={r.runId}
                href={`/runs/${r.runId}`}
                style={{
                  display: "grid", gridTemplateColumns: "1fr 110px 80px 100px 120px 48px",
                  gap: "var(--s4)", alignItems: "center",
                  padding: "var(--s4) var(--s5)",
                  borderTop: i === 0 ? "none" : "1px solid var(--line)",
                  color: "var(--ink)", textDecoration: "none",
                  transition: "background 100ms",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-hover)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.manifestName}</div>
                  {r.reason && <div className="small muted" style={{ marginTop: 2 }}>{r.reason}</div>}
                </div>
                <span className={`badge ${badgeCls}`} style={{ width: "fit-content" }}>
                  {r.status === "running" && <span className="dot" />}
                  {r.status}
                </span>
                <CostCell run={r} />
                <RunIdCell runId={r.runId} />
                <span className="small muted" style={{ textAlign: "right" }}>{timeAgo(r.createdAt)}</span>
                <span style={{ color: "var(--brand)", textAlign: "right", fontSize: 16 }}>›</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
