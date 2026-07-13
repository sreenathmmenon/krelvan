"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listArtifacts, patchArtifact, listRuns, startRun, timeAgo, getCached,
  type ArtifactRecord, type RunRecord,
} from "../../lib/api";

// ── The Agent Inbox ──────────────────────────────────────────────────────────
// The pull home base: every agent's OUTPUT shows up here as a first-class Artifact,
// newest-first, so a customer opens ONE place to see what their agents produced. Each
// card shows the output's title + a preview; open it for the full rendered page; copy,
// archive, or re-run. Read/archive state is server-side now (a PATCH), so it follows the
// customer across devices — not stranded in one browser's localStorage.

// Legacy localStorage keys — migrated once to the server, then cleared.
const READ_KEY = "krelvan_inbox_read";
const ARCHIVED_KEY = "krelvan_inbox_archived";

// A clean one-line preview: take the first paragraph and strip the common inline markdown
// markers so a card reads as prose ("BLUF: …") rather than showing raw syntax ("**BLUF:**").
function preview(body: string): string {
  const firstPara = body.split("\n\n")[0]?.trim() || body.trim();
  const plain = firstPara
    .replace(/^#{1,6}\s+/gm, "")          // heading markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")    // bold
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1") // italic
    .replace(/`([^`]+)`/g, "$1")          // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 220 ? plain.slice(0, 218).trimEnd() + "…" : plain;
}

export default function InboxPage() {
  const router = useRouter();
  const cached = getCached<ArtifactRecord[]>("artifacts");
  const [items, setItems] = useState<ArtifactRecord[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [haltedCount, setHaltedCount] = useState(0);

  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);

  const PAGE = 12;

  const load = useCallback(async () => {
    try {
      // Show both active and archived so filtering is instant; the server is the source of truth.
      const arts = await listArtifacts();
      setItems(arts);
      setError(null);
      // The "awaiting approval" banner still comes from runs (halted runs aren't artifacts).
      try { setHaltedCount((await listRuns()).filter(r => r.status === "halted").length); } catch { /* non-fatal */ }
    } catch (e) {
      setError((e as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  // One-time migration: if the old localStorage read/archive sets exist, push them to the
  // server (best-effort) and clear them, so a returning user keeps their worklist state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const migrate = async () => {
      let migrated = false;
      for (const [key, field] of [[READ_KEY, "read"], [ARCHIVED_KEY, "archived"]] as const) {
        let ids: string[] = [];
        try { ids = JSON.parse(localStorage.getItem(key) ?? "[]") as string[]; } catch { ids = []; }
        if (!Array.isArray(ids) || ids.length === 0) continue;
        // Old sets were keyed by runId; map to artifacts by runId. Best-effort, silent on miss.
        try {
          const arts = await listArtifacts();
          const byRun = new Map(arts.map(a => [a.runId, a.id]));
          await Promise.all(ids.map(runId => {
            const artId = byRun.get(runId);
            return artId ? patchArtifact(artId, { [field]: true }).catch(() => {}) : Promise.resolve();
          }));
          migrated = true;
        } catch { /* leave the localStorage key so a later load can retry */ continue; }
        localStorage.removeItem(key);
      }
      if (migrated) void load();
    };
    void migrate();
  }, [load]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const agentNames = useMemo(
    () => [...new Set(items.map(i => i.agentName || "Untitled agent"))].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((a) => {
      if (a.archived !== showArchived) return false;
      if (agentFilter !== "all" && a.agentName !== agentFilter) return false;
      if (q && !`${a.agentName} ${a.title} ${a.body}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, query, agentFilter, showArchived]);

  const visibleCount = showAll ? filtered.length : PAGE;

  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  }
  async function rerun(agentId: string) {
    try { const r = await startRun(agentId); router.push(`/runs/${r.runId}`); } catch { /* surfaced by the run page */ }
  }
  async function toggleArchive(a: ArtifactRecord) {
    // Optimistic — reflect immediately, reconcile on next load.
    setItems(prev => prev.map(x => x.id === a.id ? { ...x, archived: !x.archived } : x));
    try { await patchArtifact(a.id, { archived: !a.archived }); } catch { void load(); }
  }
  async function markRead(a: ArtifactRecord) {
    if (a.readAt !== undefined) return;
    setItems(prev => prev.map(x => x.id === a.id ? { ...x, readAt: Date.now() } : x));
    try { await patchArtifact(a.id, { read: true }); } catch { /* non-fatal */ }
  }

  const activeCount = items.filter(i => !i.archived).length;
  const archivedCount = items.filter(i => i.archived).length;
  const unreadCount = items.filter(i => !i.archived && i.readAt === undefined).length;

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

      {haltedCount > 0 && (
        <div style={{ marginBottom: "var(--s5)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)", background: "var(--surface-sunken)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
          <span className="badge badge-paused">{haltedCount} awaiting you</span>
          <span className="small soft">{haltedCount === 1 ? "A run is" : `${haltedCount} runs are`} paused for your approval before they can finish.</span>
          <Link href="/approvals" className="small" style={{ color: "var(--brand)", fontWeight: 600, marginLeft: "auto" }}>Review →</Link>
        </div>
      )}

      {items.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s4)" }}>
          <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
            <input className="input" type="search" placeholder="Search output…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search inbox output" style={{ width: "100%" }} />
          </div>
          {agentNames.length > 1 && (
            <select className="input" value={agentFilter} onChange={e => setAgentFilter(e.target.value)} aria-label="Filter by agent" style={{ flex: "0 0 auto", maxWidth: 220 }}>
              <option value="all">All agents</option>
              {agentNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <button className={`btn btn-sm ${showArchived ? "btn-secondary" : "btn-ghost"}`} onClick={() => { setShowArchived(v => !v); setShowAll(false); }} aria-pressed={showArchived}>
            {showArchived ? "← Back to inbox" : "Archived"}
          </button>
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
          {filtered.slice(0, visibleCount).map((a) => {
            const isUnread = !a.archived && a.readAt === undefined;
            return (
              <article
                key={a.id}
                className="card"
                style={{ padding: "var(--s5)", borderLeft: isUnread ? "3px solid var(--brand)" : "3px solid transparent", opacity: a.archived ? 0.72 : 1 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s1)" }}>
                    {isUnread && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--brand)", flex: "0 0 auto" }} />}
                    <span className="small muted">{a.agentName || "Untitled agent"}</span>
                    <span className="small muted">·</span>
                    <span className="small muted">{timeAgo(a.createdAt)}</span>
                  </div>
                  <Link href={`/outputs/${a.id}`} className="h3" style={{ margin: 0, display: "block", color: "var(--ink)" }} onClick={() => void markRead(a)}>
                    {a.title}
                  </Link>
                  <p className="body" style={{ margin: "var(--s2) 0 0", color: "var(--ink-soft)", lineHeight: 1.6 }}>
                    {preview(a.body)}
                  </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginTop: "var(--s4)", flexWrap: "wrap" }}>
                  <Link href={`/outputs/${a.id}`} className="btn btn-sm btn-secondary" onClick={() => void markRead(a)}>Open</Link>
                  <button className="btn btn-sm btn-ghost" onClick={() => { copy(a.id, a.body); void markRead(a); }}>{copied === a.id ? "Copied" : "Copy"}</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void rerun(a.agentId)}>Run again</button>
                  <button className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }} onClick={() => void toggleArchive(a)}>
                    {a.archived ? "Unarchive" : "Archive"}
                  </button>
                </div>
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
              {activeCount} in your inbox{archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
