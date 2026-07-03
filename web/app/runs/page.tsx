"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listRuns, autoSummarizeRuns, timeAgo, getCached, type RunRecord } from "../../lib/api";

type Filter = "all" | "running" | "halted" | "completed" | "failed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "halted", label: "Awaiting approval" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

const STATUS_BADGE_CLASS: Partial<Record<RunRecord["status"], string>> = {
  completed: "badge-done",
  running: "badge-running",
  failed: "badge-failed",
  halted: "badge-paused",
};

const STATUS_DOT_CLASS: Record<RunRecord["status"], string> = {
  completed: "done",
  running: "running",
  failed: "failed",
  halted: "paused",
  pending: "paused",
};

const STATUS_LABEL: Record<RunRecord["status"], string> = {
  completed: "completed",
  running: "running",
  failed: "failed",
  halted: "awaiting approval",
  pending: "pending",
};

// Teal geometric glyph for empty states — a "signed record / stacked ledger"
// mark in the homepage CapGlyph style. Replaces the ✦ emoji.
function LedgerGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <rect x="6" y="4" width="20" height="24" rx="2.5" stroke="var(--brand)" strokeWidth="1.6" />
      <path d="M10.5 11h11M10.5 16h11M10.5 21h7" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <circle cx="24" cy="24" r="6" fill="var(--surface)" stroke="var(--brand)" strokeWidth="1.6" />
      <path d="M21.4 24l1.8 1.8 3.4-3.6" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// Right-pointing chevron — row affordance. Replaces the › glyph.
function RowChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


// Copyable run id — first 16 chars, "Copied!" feedback on success.
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
      title={`Copy run id · ${runId}`}
      className="btn btn-ghost btn-sm mono"
      style={{
        height: 26, padding: "0 var(--s2)",
        color: copied ? "var(--ok)" : "var(--ink-muted)",
        fontSize: 11.5,
      }}
    >
      {copied ? "Copied!" : runId.slice(0, 16)}
    </button>
  );
}

export default function RunsPage() {
  const router = useRouter();
  // Seed from the session cache so a revisit paints instantly (no spinner flash);
  // the effect still refetches in the background to stay fresh.
  const cachedRuns = getCached<RunRecord[]>("runs");
  const [runs, setRuns] = useState<RunRecord[]>(cachedRuns ?? []);
  const [loading, setLoading] = useState(!cachedRuns);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // runId → first-line summary (null = fetching, absent = not started)
  const [summaries, setSummaries] = useState<Record<string, string | null>>({});
  const fetchingRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setRuns(await listRuns());
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  // Background one-line summaries — BOUNDED (most recent few, low concurrency) so a long run
  // list doesn't fire one LLM call per row and flood the single-process API.
  useEffect(() => {
    const pending = runs
      .filter(r => r.status === "completed" && summaries[r.runId] === undefined && !fetchingRef.current.has(r.runId))
      .map(r => r.runId);
    if (pending.length === 0) return;
    pending.forEach(id => fetchingRef.current.add(id));
    return autoSummarizeRuns(pending, (runId, summary) => {
      setSummaries(prev => ({ ...prev, [runId]: summary === null ? null : summary.slice(0, 160) }));
    });
  }, [runs, summaries]);

  const filtered = filter === "all" ? runs : runs.filter(r => r.status === filter);

  const counts: Record<Filter, number> = {
    all: runs.length,
    running: runs.filter(r => r.status === "running").length,
    halted: runs.filter(r => r.status === "halted").length,
    completed: runs.filter(r => r.status === "completed").length,
    failed: runs.filter(r => r.status === "failed").length,
  };

  const runningNow = counts.running;

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
      {/* ── page header: title · description · primary action ── */}
      <div
        style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: "var(--s5)", flexWrap: "wrap", marginBottom: "var(--s6)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p className="micro" style={{ marginBottom: "var(--s2)" }}>Audit trail</p>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Runs</h1>
          <p className="soft body-lg" style={{ margin: 0, maxWidth: "56ch" }}>
            Every run is a signed, replayable record of exactly what your agent did —
            each step and decision, in order.
          </p>
        </div>
        {/* no header CTA — the global nav already has "Build agent"; the empty state carries the hero action */}
      </div>

      {/* ── summary strip: only when runs exist ── */}
      {runs.length > 0 && (
        <div className="stat-strip" style={{ marginBottom: "var(--s6)" }}>
          {[
            { label: "total runs", value: String(runs.length), live: false },
            { label: "running now", value: String(runningNow), live: runningNow > 0 },
            { label: "completed", value: String(counts.completed), live: false },
            { label: "failed", value: String(counts.failed ?? 0), live: false },
          ].map(s => (
            <div key={s.label} className={`stat-cell${s.live ? " is-live" : ""}`}>
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── filter: segmented control ── */}
      {runs.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap", marginBottom: "var(--s5)" }}>
          <div className="segmented" role="group" aria-label="Filter runs by status">
            {FILTERS.map(f => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  className={active ? "is-active" : ""}
                  aria-pressed={active}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  {counts[f.key] > 0 && (
                    <span className="mono" style={{ color: active ? "var(--brand)" : "var(--ink-muted)", fontSize: 11 }}>
                      {counts[f.key]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <span className="small muted">
            Showing <span className="mono">{filtered.length}</span> of <span className="mono">{runs.length}</span>
          </span>
        </div>
      )}

      {/* ── error state ── */}
      {error && (
        <div role="alert" className="state-error" style={{ marginBottom: "var(--s5)", justifyContent: "space-between" }}>
          <span>{error} Retrying automatically…</span>
          <button
            onClick={() => void load()}
            className="btn btn-sm"
            style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger-ring)", flexShrink: 0 }}
          >
            Retry now
          </button>
        </div>
      )}

      {/* ── loading state (first load only) ── */}
      {loading && runs.length === 0 && !error && (
        <div className="state-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading runs…</span>
        </div>
      )}

      {/* ── empty: no runs at all ── */}
      {!loading && !error && runs.length === 0 && (
        <div className="state-empty" style={{ padding: "var(--s9) var(--s6)" }}>
          <div style={{ marginBottom: "var(--s4)" }}><LedgerGlyph size={44} /></div>
          <h3 className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s2)" }}>No runs yet</h3>
          <p className="body-lg soft" style={{ maxWidth: "40ch", margin: "0 auto var(--s6)" }}>
            When you build and run an agent, its signed record shows up here — every step
            and decision, ready to open and replay.
          </p>
          <Link href="/" className="btn btn-primary">Build your first agent →</Link>
        </div>
      )}

      {/* ── empty: this filter has no runs (but others do) ── */}
      {!loading && !error && runs.length > 0 && filtered.length === 0 && (
        <div className="state-empty">
          <div style={{ marginBottom: "var(--s2)", opacity: 0.7 }}><LedgerGlyph size={32} /></div>
          <h3 className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s1)" }}>
            No {FILTERS.find(f => f.key === filter)?.label.toLowerCase()} runs
          </h3>
          <p className="small">Try a different filter, or build a new agent.</p>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s2)" }} onClick={() => setFilter("all")}>
            Show all runs
          </button>
        </div>
      )}

      {/* ── runs table ── */}
      {filtered.length > 0 && (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <div className="runs-table-scroll" style={{ overflowX: "auto" }}>
            <table className="table zebra runs-table">
              <thead>
                <tr>
                  <th style={{ width: 28, paddingRight: 0 }}><span className="sr-only">Status</span></th>
                  <th>Agent</th>
                  <th style={{ width: 120 }}>Status</th>
                  <th style={{ width: 130 }}>Proof</th>
                  <th className="col-runid" style={{ width: 150 }}>Run ID</th>
                  <th className="num" style={{ width: 110 }}>When</th>
                  <th className="col-chevron" style={{ width: 32 }} aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const badgeCls = STATUS_BADGE_CLASS[r.status] ?? "badge-neutral";
                  const summary = summaries[r.runId];
                  return (
                    <tr
                      key={r.runId}
                      className="is-clickable"
                      role="link"
                      tabIndex={0}
                      aria-label={`Open run ${r.manifestName}`}
                      onClick={() => router.push(`/runs/${r.runId}`)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); router.push(`/runs/${r.runId}`); } }}
                    >
                      <td style={{ paddingRight: 0 }}>
                        <span className={`status-dot ${STATUS_DOT_CLASS[r.status]}`} aria-hidden="true" />
                      </td>
                      <td>
                        <Link
                          href={`/runs/${r.runId}`}
                          onClick={e => e.stopPropagation()}
                          style={{ color: "var(--ink)", textDecoration: "none", display: "block", minWidth: 0 }}
                        >
                          <span className="h3" style={{ display: "block" }}>{r.manifestName}</span>
                          {/* show the summary when ready, or the failure reason; never an
                              indefinite "Summarizing…" spinner that can get stuck. */}
                          {summary ? (
                            <span className="small muted text-truncate" style={{ display: "block", marginTop: 2, maxWidth: "52ch" }}>
                              {summary}
                            </span>
                          ) : r.reason ? (
                            <span className="small muted text-truncate" style={{ display: "block", marginTop: 2, maxWidth: "52ch" }}>
                              {r.reason}
                            </span>
                          ) : null}
                        </Link>
                      </td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
                          <span className={`badge ${badgeCls}`}>
                            {r.status === "running" && <span className="dot" />}
                            {STATUS_LABEL[r.status]}
                          </span>
                          {/* A paused run needs a person — give a direct action from the list,
                              not just a status label you have to open the run to act on. */}
                          {r.status === "halted" && (
                            <Link href={`/runs/${r.runId}`} className="small" style={{ color: "var(--brand)", fontWeight: 600, whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                              Review →
                            </Link>
                          )}
                        </span>
                      </td>
                      <td>
                        {/* Every terminal run is signed into the ledger — the platform
                            guarantee. Surfaced per-row so the audit trail carries the proof. */}
                        {(r.status === "completed" || r.status === "failed" || r.status === "halted") ? (
                          <span className="runs-proof">
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            Signed
                          </span>
                        ) : (
                          <span className="small muted">—</span>
                        )}
                      </td>
                      <td className="col-runid"><RunIdCell runId={r.runId} /></td>
                      <td className="num">
                        <span className="muted" style={{ fontSize: 12 }}>{timeAgo(r.createdAt)}</span>
                      </td>
                      <td className="col-chevron" aria-hidden="true" style={{ color: "var(--ink-muted)" }}>
                        <span style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}>
                          <RowChevron />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
