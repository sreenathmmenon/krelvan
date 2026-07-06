"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listRuns, getRun, startRun, timeAgo, getCached, type RunRecord } from "../../lib/api";

// ── The Agent Inbox ──────────────────────────────────────────────────────────
// The pull home base: every agent's OUTPUT shows up here, newest-first, so a
// customer opens ONE place to see what their agents produced — instead of hunting
// in the runs table. Works day-one with no external delivery key. Each card shows
// the run's headline result; expand for the full output; copy / open / re-run.
// As output piles up, the customer can search, filter by agent, and archive what
// they've handled so the feed stays a live worklist, not an ever-growing dump.

interface InboxItem {
  run: RunRecord;
  headline: string | null;    // one-line result (null = still loading)
  full: string | null;        // full output text (lazy, on expand)
}

// Read/archive state lives client-side (localStorage) — there is no per-run read flag on the
// backend, and a run's read-ness is a per-viewer concern anyway. Keyed by runId.
const READ_KEY = "krelvan_inbox_read";
const ARCHIVED_KEY = "krelvan_inbox_archived";
function loadSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]); } catch { return new Set(); }
}
function persistSet(key: string, s: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* storage full / disabled — non-fatal */ }
}

/** Pull the human-facing output text out of a run's projection state. */
function extractOutput(state: Record<string, unknown>): { headline: string; full: string } | null {
  const entries = Object.entries(state);
  // Prefer, in order: a *.result, a composed *.body/*.reply/*.answer/*.summary, else nothing.
  const pick = (suffixes: string[]): string | null => {
    for (const suf of suffixes) {
      const hit = entries.find(([k]) => k.endsWith(suf) && typeof state[k] === "string" && (state[k] as string).trim().length > 0);
      if (hit) return String(hit[1]);
    }
    return null;
  };
  const primary = pick([".result", ".briefing", ".body", ".reply", ".answer", ".digest", ".summary", ".message", ".note", ".text", ".output"]);
  if (primary) {
    const full = primary.trim();
    const headline = full.length > 180 ? full.slice(0, 178).trimEnd() + "…" : full;
    return { headline, full };
  }
  // Still nothing under a known key — a non-standard agent may put its answer under an unusual
  // key. Fall back to the LONGEST substantial string value in the state (real prose output) so a
  // genuine result never shows "No text output".
  const longest = entries
    .filter(([k, v]) => typeof v === "string" && !k.startsWith("_") && !/^seed\./.test(k))
    .map(([, v]) => (v as string).trim())
    .filter(s => s.length >= 40)
    .sort((a, b) => b.length - a.length)[0];
  if (longest) {
    const headline = longest.length > 180 ? longest.slice(0, 178).trimEnd() + "…" : longest;
    return { headline, full: longest };
  }
  // No prose output — summarise the run's notable result values so the card still says
  // something ("price: $19.99 · ok: true") instead of looking empty.
  const notable = entries
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      && !k.startsWith("_") && String(v).length > 0 && String(v).length < 120)
    .filter(([k]) => !/(url|email|_id|target|seed|message)$/i.test(k))
    .slice(0, 4)
    .map(([k, v]) => `${k.includes(".") ? k.split(".").pop() : k}: ${v}`);
  if (notable.length === 0) return null;
  const line = notable.join(" · ");
  return { headline: line.length > 180 ? line.slice(0, 178) + "…" : line, full: line };
}

export default function InboxPage() {
  const router = useRouter();
  const cached = getCached<RunRecord[]>("runs");
  const [items, setItems] = useState<InboxItem[]>(() =>
    (cached ?? []).filter(r => r.status === "completed" || r.status === "halted").map(r => ({ run: r, headline: null, full: null })));
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fetching = useRef<Set<string>>(new Set());
  // Persistent cache of already-fetched outputs, keyed by runId. The 4s list refresh must NEVER
  // reset a headline we've already loaded — it rehydrates from here instead of showing null again.
  const outputs = useRef<Map<string, { headline: string; full: string | null }>>(new Map());

  // Worklist state: search query, agent filter, read/archived tracking, and whether to show archived.
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [read, setRead] = useState<Set<string>>(new Set());
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  // Hydrate read/archived from localStorage once on mount (client-only).
  useEffect(() => { setRead(loadSet(READ_KEY)); setArchived(loadSet(ARCHIVED_KEY)); }, []);

  // Keep the inbox glanceable: show the most recent PAGE by default, reveal the rest on demand.
  const PAGE = 12;

  const load = useCallback(async () => {
    try {
      const runs = await listRuns();
      // Inbox = things that PRODUCED something: completed runs (+ halted, which are awaiting you).
      const relevant = runs.filter(r => r.status === "completed" || r.status === "halted");
      setItems(prev => {
        const byId = new Map(prev.map(i => [i.run.runId, i]));
        return relevant.map(r => {
          const existing = byId.get(r.runId);
          if (existing && existing.headline !== null) return { ...existing, run: r };
          // Rehydrate from the persistent output cache so a loaded result is never reset to null.
          const cachedOut = outputs.current.get(r.runId);
          if (cachedOut) return { run: r, headline: cachedOut.headline, full: cachedOut.full };
          return existing ?? { run: r, headline: null, full: null };
        });
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  // The agents present in the inbox, for the filter dropdown.
  const agentNames = useMemo(
    () => [...new Set(items.map(i => i.run.manifestName))].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  // Apply archive visibility, agent filter, and text search. Halted (awaiting) always show.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(({ run, headline, full }) => {
      const isArchived = archived.has(run.runId);
      if (isArchived !== showArchived && run.status !== "halted") return false;
      if (agentFilter !== "all" && run.manifestName !== agentFilter) return false;
      if (q) {
        const hay = `${run.manifestName} ${headline ?? ""} ${full ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, query, agentFilter, archived, showArchived]);

  const visibleCount = showAll ? filtered.length : PAGE;

  // Lazily fetch each completed run's output (headline) — only for the VISIBLE, filtered page.
  useEffect(() => {
    const pending = filtered
      .slice(0, visibleCount)
      .filter(i => i.run.status === "completed" && i.headline === null && !fetching.current.has(i.run.runId))
      .slice(0, 12);
    if (pending.length === 0) return;
    pending.forEach(i => fetching.current.add(i.run.runId));
    let cancelled = false;
    // Fetch each visible run's output. On failure, RELEASE the fetching lock so the next tick
    // retries instead of leaving the card stuck on "Loading result…" forever (the real bug a
    // user hit — most cards never resolved because a slow/failed fetch was never retried).
    Promise.all(pending.map(async (it) => {
      try {
        // Race the fetch against a timeout — a hung request must NOT leave the card stuck on
        // "Loading result…" forever. If it times out, we throw and retry next tick.
        const detail = await Promise.race([
          getRun(it.run.runId),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
        ]);
        if (cancelled) return;
        const out = extractOutput((detail.projection?.state ?? {}) as Record<string, unknown>);
        const headline = out?.headline ?? "No text output — open the run for the full record.";
        const full = out?.full ?? null;
        // Persist so the periodic list refresh rehydrates instead of resetting to "Loading…".
        outputs.current.set(it.run.runId, { headline, full });
        setItems(prev => prev.map(x => x.run.runId === it.run.runId ? { ...x, headline, full } : x));
      } catch {
        if (cancelled) return;
        // Release the lock so the next tick retries the fetch instead of hanging forever.
        fetching.current.delete(it.run.runId);
      }
    })).catch(() => {});
    // On cleanup (the 4s list refresh re-runs this effect), release the locks for any run that
    // did NOT get a headline yet. Otherwise a fetch cancelled mid-flight stays locked forever and
    // its card is stuck on "Loading result…" — the exact bug a user hit. Releasing lets it retry.
    return () => {
      cancelled = true;
      pending.forEach(i => {
        if (!outputs.current.has(i.run.runId)) fetching.current.delete(i.run.runId);
      });
    };
  }, [filtered, visibleCount]);

  function toggle(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    markRead(id);
  }
  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  }
  async function rerun(agentId: string) {
    try { const r = await startRun(agentId); router.push(`/runs/${r.runId}`); } catch { /* surfaced by the run page */ }
  }
  function markRead(id: string) {
    setRead(prev => { if (prev.has(id)) return prev; const n = new Set(prev); n.add(id); persistSet(READ_KEY, n); return n; });
  }
  function toggleArchive(id: string) {
    setArchived(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); persistSet(ARCHIVED_KEY, n); return n; });
  }
  function markAllRead() {
    setRead(prev => {
      const n = new Set(prev);
      for (const i of items) if (i.run.status === "completed") n.add(i.run.runId);
      persistSet(READ_KEY, n); return n;
    });
  }

  const halted = items.filter(i => i.run.status === "halted");
  const unreadCount = items.filter(i => i.run.status === "completed" && !read.has(i.run.runId) && !archived.has(i.run.runId)).length;
  const activeCount = items.filter(i => i.run.status === "completed" && !archived.has(i.run.runId)).length;

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
      <div style={{ marginBottom: "var(--s6)" }}>
        <p className="micro" style={{ marginBottom: "var(--s2)" }}>Your agents&apos; output</p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
          <h1 className="h1" style={{ margin: 0 }}>Inbox</h1>
          {unreadCount > 0 && <span className="badge badge-info" aria-label={`${unreadCount} unread`}>{unreadCount} new</span>}
        </div>
        <p className="soft body-lg" style={{ margin: 0, maxWidth: "58ch" }}>
          Everything your agents produced, newest first — read it here, copy it, or send it on.
          The one place to glance at what your agents did while you were away.
        </p>
      </div>

      {halted.length > 0 && (
        <div style={{ marginBottom: "var(--s5)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)", background: "var(--surface-sunken)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
          <span className="badge badge-paused">{halted.length} awaiting you</span>
          <span className="small soft">{halted.length === 1 ? "A run is" : `${halted.length} runs are`} paused for your approval before they can finish.</span>
          <Link href="/approvals" className="small" style={{ color: "var(--brand)", fontWeight: 600, marginLeft: "auto" }}>Review →</Link>
        </div>
      )}

      {/* Worklist controls — only show once there's enough output to be worth filtering. */}
      {items.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s4)" }}>
          <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
            <input
              className="input"
              type="search"
              placeholder="Search output…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search inbox output"
              style={{ width: "100%" }}
            />
          </div>
          {agentNames.length > 1 && (
            <select className="input" value={agentFilter} onChange={e => setAgentFilter(e.target.value)} aria-label="Filter by agent" style={{ flex: "0 0 auto", maxWidth: 220 }}>
              <option value="all">All agents</option>
              {agentNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <button
            className={`btn btn-sm ${showArchived ? "btn-secondary" : "btn-ghost"}`}
            onClick={() => { setShowArchived(v => !v); setShowAll(false); }}
            aria-pressed={showArchived}
          >
            {showArchived ? "← Back to inbox" : "Archived"}
          </button>
          {!showArchived && unreadCount > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={markAllRead}>Mark all read</button>
          )}
        </div>
      )}

      {error && items.length === 0 ? (
        <div className="state-error" role="alert">
          <p>{error}</p>
          <button className="btn btn-sm btn-secondary" onClick={() => void load()}>Retry</button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="state-loading"><span className="spinner" aria-hidden="true" /> Loading your inbox…</div>
      ) : items.length === 0 ? (
        <div className="state-empty">
          <p className="h3">No output yet</p>
          <p className="small soft" style={{ maxWidth: "44ch", margin: "0 auto var(--s4)", lineHeight: 1.6 }}>
            When an agent finishes, its result lands here. Build one and run it to see your first output.
          </p>
          <Link href="/dashboard" className="btn btn-primary">Build an agent →</Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="state-empty">
          <p className="h3">{showArchived ? "Nothing archived" : "Nothing matches"}</p>
          <p className="small soft" style={{ maxWidth: "44ch", margin: "0 auto", lineHeight: 1.6 }}>
            {showArchived
              ? "Output you archive will collect here — out of your way, but never gone."
              : "No output matches your search or filter. Clear them to see everything."}
          </p>
          {!showArchived && (query || agentFilter !== "all") && (
            <button className="btn btn-sm btn-secondary" style={{ marginTop: "var(--s4)" }} onClick={() => { setQuery(""); setAgentFilter("all"); }}>Clear filters</button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {filtered.slice(0, visibleCount).map(({ run, headline, full }) => {
            const isOpen = expanded.has(run.runId);
            const isHalted = run.status === "halted";
            const isArchived = archived.has(run.runId);
            const isUnread = !isHalted && !read.has(run.runId) && !isArchived;
            return (
              <article
                key={run.runId}
                className="card"
                style={{ padding: "var(--s5)", borderLeft: isUnread ? "3px solid var(--brand)" : "3px solid transparent", opacity: isArchived ? 0.72 : 1 }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s4)", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s1)" }}>
                      {isUnread && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--brand)", flex: "0 0 auto" }} />}
                      <span className="h3" style={{ margin: 0 }}>{run.manifestName}</span>
                      {isHalted
                        ? <span className="badge badge-paused">Awaiting approval</span>
                        : <span className="badge badge-done">Completed</span>}
                      <span className="small muted">{timeAgo(run.createdAt)}</span>
                    </div>
                    {isHalted ? (
                      <p className="small soft" style={{ margin: "var(--s2) 0 0" }}>
                        Paused before an action it needs you to approve.{" "}
                        <Link href={`/runs/${run.runId}`} style={{ color: "var(--brand)", fontWeight: 600 }}>Review &amp; approve →</Link>
                      </p>
                    ) : (
                      <p className="body" style={{ margin: "var(--s2) 0 0", color: "var(--ink-soft)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                        {headline === null
                          ? <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}><span className="spinner" aria-hidden="true" style={{ width: 12, height: 12 }} /> Loading result…</span>
                          : (isOpen && full ? full : headline)}
                      </p>
                    )}
                  </div>
                </div>
                {!isHalted && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginTop: "var(--s4)", flexWrap: "wrap" }}>
                    {full && full.length > 180 && (
                      <button className="btn btn-sm btn-ghost" onClick={() => toggle(run.runId)}>{isOpen ? "Show less" : "Show full output"}</button>
                    )}
                    {full && (
                      <button className="btn btn-sm btn-ghost" onClick={() => { copy(run.runId, full); markRead(run.runId); }}>{copied === run.runId ? "Copied" : "Copy"}</button>
                    )}
                    <Link href={`/runs/${run.runId}`} className="btn btn-sm btn-ghost" onClick={() => markRead(run.runId)}>Open run</Link>
                    <button className="btn btn-sm btn-ghost" onClick={() => void rerun(run.agentId)}>Run again</button>
                    <button className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }} onClick={() => toggleArchive(run.runId)}>
                      {isArchived ? "Unarchive" : "Archive"}
                    </button>
                    {isUnread && (
                      <button className="btn btn-sm btn-ghost" onClick={() => markRead(run.runId)}>Mark read</button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {filtered.length > visibleCount && (
            <button className="btn btn-secondary" style={{ alignSelf: "center", marginTop: "var(--s2)" }} onClick={() => setShowAll(true)}>
              Show {filtered.length - visibleCount} older
            </button>
          )}
          {!showArchived && (
            <p className="small muted" style={{ textAlign: "center", marginTop: "var(--s2)" }}>
              {activeCount} in your inbox{archived.size > 0 ? ` · ${archived.size} archived` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
