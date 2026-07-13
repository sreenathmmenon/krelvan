"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getArtifact, patchArtifact, shareArtifact, unshareArtifact,
  timeAgo, type ArtifactRecord,
} from "../../../lib/api";
import { renderMarkdown } from "../../../lib/markdown";

// ── The rendered artifact page ─────────────────────────────────────────────────
// The product's face: an agent's finished output as a clean, readable object. Copy it,
// archive it, share it (a one-time public link), or step back to "how this was made" —
// the signed run record that produced it.

export default function ArtifactPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [shared, setShared] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { artifact: a, shared: s } = await getArtifact(id);
      setArtifact(a);
      setShared(s);
      setError(null);
      // Mark read once loaded (best-effort — never blocks the view).
      if (a.readAt === undefined) void patchArtifact(id, { read: true }).catch(() => {});
    } catch (e) {
      setError((e as Error).message || "Could not load this output.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  function copy() {
    if (!artifact) return;
    void navigator.clipboard?.writeText(artifact.body)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }

  async function toggleArchive() {
    if (!artifact) return;
    setBusy(true);
    try { const updated = await patchArtifact(id, { archived: !artifact.archived }); setArtifact(updated); }
    catch { /* surfaced by reload */ } finally { setBusy(false); }
  }

  async function toggleShare() {
    if (!artifact) return;
    setBusy(true);
    try {
      if (shared) {
        await unshareArtifact(id);
        setShared(false);
        setShareLink(null);
      } else {
        const { url } = await shareArtifact(id);
        setShared(true);
        setShareLink(`${window.location.origin}${url}`);
      }
    } catch { /* non-fatal */ } finally { setBusy(false); }
  }

  function copyShareLink() {
    if (!shareLink) return;
    void navigator.clipboard?.writeText(shareLink).catch(() => {});
  }

  if (loading) {
    return <div className="container" style={{ paddingTop: "var(--s8)" }}><div className="state-loading"><span className="spinner" aria-hidden="true" /> Loading output…</div></div>;
  }
  if (error || !artifact) {
    return (
      <div className="container" style={{ paddingTop: "var(--s8)" }}>
        <div className="state-error" role="alert">
          <p>{error ?? "Output not found."}</p>
          <Link href="/inbox" className="btn btn-sm btn-secondary">Back to Inbox</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)", maxWidth: 760 }}>
      <Link href="/inbox" className="small" style={{ color: "var(--ink-muted)", display: "inline-block", marginBottom: "var(--s4)" }}>← Inbox</Link>

      <header style={{ marginBottom: "var(--s5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
          <span className="micro">{artifact.agentName}</span>
          <span className="small muted">·</span>
          <span className="small muted">{timeAgo(artifact.createdAt)}</span>
          {artifact.archived && <span className="badge">Archived</span>}
        </div>
        <h1 className="h1" style={{ margin: 0 }}>{artifact.title}</h1>
      </header>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s5)" }}>
        <button className="btn btn-sm btn-secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button className="btn btn-sm btn-ghost" onClick={() => void toggleArchive()} disabled={busy}>
          {artifact.archived ? "Unarchive" : "Archive"}
        </button>
        <button className={`btn btn-sm ${shared ? "btn-secondary" : "btn-ghost"}`} onClick={() => void toggleShare()} disabled={busy} aria-pressed={shared}>
          {shared ? "Sharing · turn off" : "Share"}
        </button>
        <Link href={`/runs/${artifact.runId}`} className="small" style={{ color: "var(--ink-muted)", marginLeft: "auto" }}>
          How this was made →
        </Link>
      </div>

      {/* One-time share link surface */}
      {shared && shareLink && (
        <div style={{ marginBottom: "var(--s5)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)", background: "var(--brand-tint)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span className="small" style={{ fontWeight: 600 }}>Public link</span>
          <code className="mono small" style={{ flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shareLink}</code>
          <button className="btn btn-sm btn-ghost" onClick={copyShareLink}>Copy link</button>
        </div>
      )}
      {shared && !shareLink && (
        <p className="small soft" style={{ marginBottom: "var(--s5)" }}>
          This output has a public share link. Turn sharing off to revoke it, or rotate it by turning it off and on again.
        </p>
      )}

      {/* The output body */}
      <article className="card" style={{ padding: "var(--s6)" }}>
        {artifact.format === "markdown"
          ? renderMarkdown(artifact.body)
          : <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7, color: "var(--ink-soft)" }}>{artifact.body}</p>}
      </article>
    </div>
  );
}
