"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listRuns, getRun, startRun, timeAgo, getCached, type RunRecord } from "../../lib/api";

// ── The Agent Inbox ──────────────────────────────────────────────────────────
// The pull home base: every agent's OUTPUT shows up here, newest-first, so a
// customer opens ONE place to see what their agents produced — instead of hunting
// in the runs table. Works day-one with no external delivery key. Each card shows
// the run's headline result; expand for the full output; copy / open / re-run.

interface InboxItem {
  run: RunRecord;
  headline: string | null;    // one-line result (null = still loading)
  full: string | null;        // full output text (lazy, on expand)
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

  // Lazily fetch each completed run's output (headline) — only for the VISIBLE page, newest first.
  const visibleCount = showAll ? items.length : PAGE;
  useEffect(() => {
    const pending = items
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
        // "Loading result…" forever (the real bug). If it times out, we throw and retry next tick.
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
  }, [items, visibleCount]);

  function toggle(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  }
  async function rerun(agentId: string) {
    try { const r = await startRun(agentId); router.push(`/runs/${r.runId}`); } catch { /* surfaced by the run page */ }
  }

  const halted = items.filter(i => i.run.status === "halted");

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
      <div style={{ marginBottom: "var(--s6)" }}>
        <p className="micro" style={{ marginBottom: "var(--s2)" }}>Your agents&apos; output</p>
        <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Inbox</h1>
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
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {items.slice(0, visibleCount).map(({ run, headline, full }) => {
            const isOpen = expanded.has(run.runId);
            const isHalted = run.status === "halted";
            return (
              <article key={run.runId} className="card" style={{ padding: "var(--s5)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s4)", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s1)" }}>
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
                      <button className="btn btn-sm btn-ghost" onClick={() => copy(run.runId, full)}>{copied === run.runId ? "Copied" : "Copy"}</button>
                    )}
                    <Link href={`/runs/${run.runId}`} className="btn btn-sm btn-ghost">Open run</Link>
                    <button className="btn btn-sm btn-ghost" onClick={() => void rerun(run.agentId)}>Run again</button>
                  </div>
                )}
              </article>
            );
          })}
          {items.length > visibleCount && (
            <button className="btn btn-secondary" style={{ alignSelf: "center", marginTop: "var(--s2)" }} onClick={() => setShowAll(true)}>
              Show {items.length - visibleCount} older
            </button>
          )}
        </div>
      )}
    </div>
  );
}
