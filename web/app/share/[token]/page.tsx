"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getSharedArtifact, type SharedArtifact } from "../../../lib/api";
import { renderMarkdown } from "../../../lib/markdown";

// ── Public share page ──────────────────────────────────────────────────────────
// A read-only view of one agent output, reachable by anyone with the unguessable link.
// No nav, no admin controls, no internal ids — just the rendered output and a quiet
// "Made with Krelvan" footer. Excluded from the session middleware.

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [artifact, setArtifact] = useState<SharedArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let live = true;
    getSharedArtifact(token)
      .then((a) => { if (live) { setArtifact(a); setLoading(false); } })
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

  if (notFound || !artifact) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)", padding: "var(--s5)" }}>
        <div style={{ textAlign: "center", maxWidth: "40ch" }}>
          <p className="h3">This link isn&apos;t available</p>
          <p className="small soft">The share link may have been turned off, or it never existed. Ask the sender for a new one.</p>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--canvas)", padding: "var(--s7) var(--s4) var(--s8)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header style={{ marginBottom: "var(--s5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
            <span className="micro">{artifact.agentName}</span>
            <span className="small muted">·</span>
            <span className="small muted">{fmtDate(artifact.createdAt)}</span>
          </div>
          <h1 className="h1" style={{ margin: 0 }}>{artifact.title}</h1>
        </header>

        <article className="card" style={{ padding: "var(--s6)" }}>
          {artifact.format === "markdown"
            ? renderMarkdown(artifact.body)
            : <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7, color: "var(--ink-soft)" }}>{artifact.body}</p>}
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
