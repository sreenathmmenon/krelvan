"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getSharedRun, type SharedRun } from "../../../lib/api";
import { renderMarkdown } from "../../../lib/markdown";

// ── Public run one-pager ────────────────────────────────────────────────────────
// A read-only, plain-English explanation of one agent run, reachable by anyone with the
// unguessable link. No nav, no admin controls, no internal ids — just the story of what the
// agent did, and a quiet "Made with Krelvan" footer. Excluded from the session middleware.

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}

function statusLabel(s: string): { text: string; cls: string } {
  if (s === "completed") return { text: "Completed", cls: "badge-done" };
  if (s === "failed") return { text: "Didn't finish", cls: "badge-failed" };
  if (s === "halted") return { text: "Waiting on a person", cls: "badge-neutral" };
  return { text: s, cls: "badge-neutral" };
}

export default function RunSharePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [run, setRun] = useState<SharedRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let live = true;
    getSharedRun(token)
      .then((r) => { if (live) { setRun(r); setLoading(false); } })
      .catch(() => { if (live) { setNotFound(true); setLoading(false); } });
    return () => { live = false; };
  }, [token]);

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)" }}>
        <div className="state-loading"><span className="spinner" aria-hidden="true" /> Loading…</div>
      </main>
    );
  }

  if (notFound || !run) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)", padding: "var(--s5)" }}>
        <div style={{ textAlign: "center", maxWidth: "40ch" }}>
          <p className="h3">This link isn&apos;t available</p>
          <p className="small soft">The share link may have been turned off, or it never existed. Ask the sender for a new one.</p>
        </div>
      </main>
    );
  }

  const st = statusLabel(run.status);

  return (
    <main style={{ minHeight: "100vh", background: "var(--canvas)", padding: "var(--s7) var(--s4) var(--s8)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header style={{ marginBottom: "var(--s5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
            <span className="micro">{run.agentName}</span>
            <span className="small muted">·</span>
            <span className="small muted">{fmtDate(run.createdAt)}</span>
            <span className={`badge ${st.cls}`} style={{ marginLeft: "var(--s1)" }}>{st.text}</span>
          </div>
          <h1 className="h1" style={{ margin: 0 }}>What this agent did</h1>
        </header>

        <article className="card" style={{ padding: "var(--s6)" }}>
          {renderMarkdown(run.explanation)}
        </article>

        <footer style={{ marginTop: "var(--s6)", textAlign: "center" }}>
          <a href="/" style={{ color: "var(--ink-muted)", fontSize: "0.8rem", textDecoration: "none" }}>
            Made with Krelvan
          </a>
        </footer>
      </div>
    </main>
  );
}
